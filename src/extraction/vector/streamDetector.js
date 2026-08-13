// streamDetector.js
// Detects borderless tables from text-item alignment patterns.
// Called by contextClassifier after the lattice pass, on unclaimed text items.
//
// Algorithm:
//   1. Group items into Y-bands using a fixed yTol (fraction of body font).
//      This correctly handles items that are a few px apart within the same
//      visual row (e.g. a subscript offset of 4 px).
//   2. Group bands into table-candidate sections using ADAPTIVE gap detection
//      on the band-to-band Y distances. A section break is a gap significantly
//      larger than the typical inter-row spacing — derived from the band gap
//      distribution itself rather than a hardcoded px multiple. This is the
//      "gutter reference": the actual empty space between content sections
//      compared to the within-table row spacing.
//   3. For each section: cluster item X positions to find column anchors
//      (anchors present in ≥ 2 bands).
//   4. Detect X gutters: ranges with near-zero text coverage across ≥ 60% of
//      bands. Gutter midpoints become column boundaries (more robust than
//      anchor midpoints when a cell value is unusually wide).
//   5. Score: column alignment variance + row spacing regularity computed ONLY
//      on PARTICIPATING bands (bands that have items aligning to detected column
//      anchors). Title, footer, and section-label bands are excluded from the
//      spacing score so they cannot corrupt confidence.
//   6. Passing candidates (confidence ≥ STREAM_CONFIDENCE) emit synthetic lattice
//      objects with hLines/vLines = [] for downstream tableBuilder.
//
// Output shape matches LatticeReconstructor so tableBuilder/pageAssembler need
// no changes. border:false + detectionMethod:'stream' annotate the result.

// ── Helpers ───────────────────────────────────────────────────────────────────

// A band that opens with a caption marker ("Table 3", "Figure 1", "Fig. 2")
// belongs to the caption below/above a table, not to the table body. Splitting
// the band group here keeps the caption prose out of the reconstructed grid.
const CAPTION_RE = /^(?:table|figure|fig\.?|chart|exhibit)\s*\.?\s*\d/i;

function _bandStartsCaption(band) {
    if (!band?.items?.length) return false;
    // Leftmost item's text — captions are left-anchored.
    let lead = band.items[0];
    for (const it of band.items) if (it.vx < lead.vx) lead = it;
    return CAPTION_RE.test((lead.str || '').trimStart());
}

function _mean(arr) {
    return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function _stdDev(arr) {
    if (arr.length < 2) return 0;
    const m = _mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

// Group items into Y-bands using a fixed tolerance.
// Items within yTol of each other's Y baseline are in the same visual row.
function _groupByYBand(items, yTol) {
    const sorted = [...items].sort((a, b) => a.vy - b.vy);
    const bands = [];
    for (const tm of sorted) {
        let placed = false;
        for (const band of bands) {
            if (Math.abs(band.y - tm.vy) <= yTol) {
                const n = band.items.length;
                band.y = (band.y * n + tm.vy) / (n + 1);
                band.items.push(tm);
                placed = true;
                break;
            }
        }
        if (!placed) bands.push({ y: tm.vy, items: [tm] });
    }
    bands.sort((a, b) => a.y - b.y);
    return bands;
}

/**
 * Split bands into table-candidate groups using adaptive gap detection.
 *
 * Primary split: a gap significantly larger than the global median inter-band
 * gap (2.5×). Secondary split: when a compact cluster of bands (tight row pitch,
 * short avg text) is followed by a gap that exceeds 1.5× that cluster's own
 * median pitch, split there even if the global threshold isn't met. This catches
 * tables immediately above body-text sections where the table-to-prose gap is
 * smaller than the global 2.5× threshold but still clearly separates structures.
 */
function _groupBandsByAdaptiveGap(bands, { enableSecondary = false } = {}) {
    if (bands.length < 2) return [bands];

    const gaps = [];
    for (let i = 1; i < bands.length; i++) {
        gaps.push(bands[i].y - bands[i - 1].y);
    }

    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const globalSplitAt = Math.max(median * 2.5, 20);

    // Precompute avg text length per band for the secondary split check
    const bandAvgLen = enableSecondary
        ? bands.map(b => b.items.length
            ? b.items.reduce((s, i) => s + i.str.trim().length, 0) / b.items.length
            : 0)
        : null;

    const groups = [[bands[0]]];
    for (let i = 1; i < bands.length; i++) {
        const gap = gaps[i - 1];
        let doSplit = gap > globalSplitAt;

        // Caption boundary: a band opening with "Table N" / "Figure N" starts a
        // new group so the caption prose below a table is not clustered into the
        // table body. The caption group is then too short / too prose-like to
        // pass the table gates and stays out of the grid.
        if (!doSplit && _bandStartsCaption(bands[i])) doSplit = true;

        // Secondary (zone mode only): compact short-text cluster (≥ 4 bands)
        // followed by a gap ≥ 2× its own median pitch. Catches tables whose
        // table-to-prose gap is smaller than the global 2.5× threshold.
        // Not enabled in full-page mode to avoid AMZN-style false positives.
        if (!doSplit && enableSecondary && gap > 20) {
            const cur = groups[groups.length - 1];
            if (cur.length >= 4) {
                const clusterGaps = cur.slice(1).map((b, j) => b.y - cur[j].y);
                const clusterMedian = [...clusterGaps].sort((a, b) => a - b)[Math.floor(clusterGaps.length / 2)];
                const clusterAvgLen = cur.reduce((s, b) => s + bandAvgLen[bands.indexOf(b)], 0) / cur.length;
                if (clusterMedian <= 30 && clusterAvgLen <= 15 && gap >= clusterMedian * 2) {
                    doSplit = true;
                }
            }
        }

        if (doSplit) groups.push([]);
        groups[groups.length - 1].push(bands[i]);
    }
    return groups;
}

// Greedy X-clustering with running-mean centroid update.
function _clusterByX(items, tol) {
    const sorted = [...items].sort((a, b) => a.vx - b.vx);
    const clusters = [];
    for (const item of sorted) {
        let placed = false;
        for (const cluster of clusters) {
            const meanX = cluster.reduce((s, i) => s + i.vx, 0) / cluster.length;
            if (Math.abs(item.vx - meanX) <= tol) {
                cluster.push(item);
                placed = true;
                break;
            }
        }
        if (!placed) clusters.push([item]);
    }
    return clusters;
}

/**
 * Fold a sparse column anchor into an adjacent, much denser neighbor.
 *
 * A currency symbol ("$"), unit prefix, or similar short token that only
 * appears on a handful of rows (e.g. the first/subtotal/last row of a
 * financial statement, where "$" prefixes the beginning/end-of-period and
 * supplemental-section totals but not the rows between them) clusters into
 * its own low-presence X-anchor immediately next to the real value column's
 * anchor. Left uncorrected, every such decoration counts as a full competing
 * "column" and dilutes the anchor-quality gate below threshold on tables
 * that are otherwise unambiguously columnar — this is exactly why a real
 * born-digital 10-Q cash-flow statement (4 numeric columns, "$" on 3 of 44
 * rows) produced zero detected tables before this fix.
 *
 * The asymmetry in presence (>=3x) is what distinguishes "a stray decoration
 * riding next to the real column" from "two genuinely separate columns that
 * happen to sit close together" — two real columns are expected to have
 * comparable row coverage, a decoration is not.
 */
function _mergeSparseAnchors(colAnchors, mergeTol) {
    if (colAnchors.length < 2) return colAnchors;
    const presence = a => new Set(a.items.map(i => i._band)).size;
    const merged = [];
    for (const anchor of colAnchors) {
        const prev = merged[merged.length - 1];
        if (prev && Math.abs(anchor.x - prev.x) <= mergeTol) {
            const pPresence = presence(prev);
            const aPresence = presence(anchor);
            if (pPresence >= aPresence * 3 || aPresence >= pPresence * 3) {
                // Union `items` so band-presence counts the merged pair as one
                // anchor (fixes the anchor-count/quality gates). But keep
                // `alignItems` scoped to the DOMINANT side's own items only —
                // colAlignScore must measure how tightly the real column
                // lines up, not be diluted by a decoration sitting ~20px away
                // from it (that would zero out the score for every merge).
                const dominant = pPresence >= aPresence ? prev : anchor;
                merged[merged.length - 1] = {
                    x: dominant.x,
                    items: prev.items.concat(anchor.items),
                    alignItems: dominant.alignItems ?? dominant.items,
                    alignXs: dominant.alignXs,
                };
                continue;
            }
        }
        merged.push({ x: anchor.x, items: anchor.items, alignItems: anchor.items, alignXs: anchor.alignXs });
    }
    return merged;
}

/**
 * Find X ranges where fewer than minFrac of bands have text coverage.
 * Returns gutter center X positions — used as column boundary candidates.
 */
function _detectGutters(bands, minFrac = 0.6, minGutterPx = 4) {
    if (!bands.length) return [];
    const allItems = bands.flatMap(b => b.items);
    if (!allItems.length) return [];

    const maxX = allItems.reduce((m, i) => Math.max(m, i.vx + (i.vWidth || 0)), 0);
    const w = Math.ceil(maxX) + 1;
    if (w < 8) return [];

    const bandCount = new Float32Array(w);
    for (const band of bands) {
        const seen = new Uint8Array(w);
        for (const item of band.items) {
            const x1 = Math.max(0, Math.floor(item.vx));
            const x2 = Math.min(w - 1, Math.ceil(item.vx + (item.vWidth || 0)));
            for (let x = x1; x <= x2; x++) seen[x] = 1;
        }
        for (let x = 0; x < w; x++) bandCount[x] += seen[x];
    }

    const threshold = bands.length * minFrac;
    const gutters = [];
    let gStart = null;

    for (let x = 0; x < w; x++) {
        if (bandCount[x] < threshold) {
            if (gStart === null) gStart = x;
        } else if (gStart !== null) {
            if (x - gStart >= minGutterPx) gutters.push((gStart + x) / 2);
            gStart = null;
        }
    }
    return gutters;
}

// True if candidate bbox is ≥ overlapFrac covered by any existing lattice region.
function _overlapsLattice(bbox, latticeRegions, overlapFrac = 0.8) {
    for (const region of latticeRegions) {
        const lb = region.bbox;
        if (!lb) continue;
        const iw = Math.min(bbox.x + bbox.w, lb.x + lb.w) - Math.max(bbox.x, lb.x);
        const ih = Math.min(bbox.y + bbox.h, lb.y + lb.h) - Math.max(bbox.y, lb.y);
        if (iw > 0 && ih > 0) {
            const cArea = bbox.w * bbox.h;
            if (cArea > 0 && (iw * ih) / cArea >= overlapFrac) return true;
        }
    }
    return false;
}

/**
 * If col anchors span a gap that is clearly a page-column boundary (not an
 * intra-table visual gap), split them into two sub-groups at that gap.
 *
 * A gap is considered a page-column boundary when:
 *   - it is the largest inter-anchor gap AND
 *   - it is ≥ 3× the median inter-anchor gap AND
 *   - it is ≥ absMinPx absolute (avoids firing on very dense tables)
 *
 * This prevents intra-table column groups (e.g. a "System" column separated
 * from score columns by 143px of whitespace) from being misread as page columns.
 */
function _splitAnchorsAtXGap(colAnchors, absMinPx) {
    if (colAnchors.length < 4) return [colAnchors]; // need at least 2 anchors per side
    const gaps = colAnchors.slice(1).map((a, i) => a.x - colAnchors[i].x);
    const sorted = [...gaps].sort((a, b) => a - b);
    const medianGap = sorted[Math.floor(sorted.length / 2)];
    const maxGap = Math.max(...gaps);
    const maxIdx = gaps.indexOf(maxGap);
    // Only split if: dominant gap, ≥3× median, ≥ absolute floor
    if (maxGap < medianGap * 3 || maxGap < absMinPx) return [colAnchors];
    // Both sides must have ≥ 2 anchors to be viable sub-groups
    if (maxIdx < 1 || maxIdx >= colAnchors.length - 2) return [colAnchors];
    return [colAnchors.slice(0, maxIdx + 1), colAnchors.slice(maxIdx + 1)];
}

// Build column anchors from a tagged item set, clustering on the given edge
// (left = vx, right = vx + vWidth), then fold sparse decorations into their
// denser neighbor. Returns { anchors, qualified } so the caller can compare
// the left-edge and right-edge clusterings and keep whichever is cleaner.
function _buildAnchors(tagged, colTol, edgeOf) {
    const edgeTagged = tagged.map(t => ({ ...t, vx: edgeOf(t) }));
    const xClusters = _clusterByX(edgeTagged, colTol);
    let anchors = [];
    for (const cluster of xClusters) {
        const bandSet = new Set(cluster.map(i => i._band));
        if (bandSet.size >= 2) {
            // Anchor POSITION still uses the original left-edge vx (that is
            // what the final column-boundary math expects — a midpoint
            // between two anchors works as a divider regardless of which
            // edge justified clustering them). But alignXs records the
            // values in the edge space that was ACTUALLY used to cluster —
            // colAlignScore must measure variance there, not on the left
            // edge, or a right-edge-justified column (a "45" and a
            // "(123,456)" that share a right edge but not a left one) would
            // score as badly-aligned by definition, undoing the whole reason
            // right-edge clustering was chosen for it.
            const origItems = cluster.map(i => i._orig);
            anchors.push({
                x: _mean(origItems.map(i => i.vx)),
                items: origItems,
                alignXs: cluster.map(i => i.vx), // edge-space value, not left-edge
            });
        }
    }
    anchors.sort((a, b) => a.x - b.x);
    // 4x (not 3x) colTol: measured on a real financial statement, a "$" anchor
    // sits up to ~19px from its number anchor (vs. ~5.6px colTol here) — 3x
    // colTol (16.8px) was consistently just short. Real inter-column gaps
    // start at ~26.7px on the same page, so 4x leaves comfortable headroom
    // without merging genuinely separate columns.
    anchors = _mergeSparseAnchors(anchors, colTol * 4);
    const bandCounts = anchors.map(a => new Set(a.items.map(i => i._band)).size);
    const minPresence = Math.max(2, Math.floor(_mean(bandCounts)));
    const qualified = bandCounts.filter(bc => bc >= minPresence).length;
    return { anchors, qualified };
}

function _buildCandidate(bands, scale, segments = [], { zoneMode = false } = {}) {
    const colTol = scale.colTolPx;
    const eps = 4;

    const tagged = [];
    for (let bi = 0; bi < bands.length; bi++) {
        for (const item of bands[bi].items) {
            tagged.push({
                vx: item.vx, vy: item.vy, vWidth: item.vWidth || 0,
                str: item.str || '', _band: bi, _orig: null,
            });
        }
    }
    for (const t of tagged) t._orig = t; // self-reference so _buildAnchors can recover the original after remapping vx

    // Column anchor = X cluster present in ≥ 2 distinct bands. Try both
    // left-edge (the historical default) and right-edge clustering, and keep
    // whichever produces the cleaner set of anchors. Right-aligned numeric
    // columns (extremely common in financial tables) line up on their RIGHT
    // edge, not their left — a column mixing "45" with "(123,456)" has left
    // edges far enough apart to split into two competing anchors even though
    // the values are visually one column. Measured on a synthetic table with
    // deliberately extreme width variance: left-edge clustering produced 7
    // anchors for 5 real columns and only 1 anchor qualified as high-presence
    // (anchor-quality gate failed outright); right-edge clustering on the
    // same data produced the correct 5 anchors, all qualified.
    const leftResult = _buildAnchors(tagged, colTol, t => t.vx);
    const rightResult = _buildAnchors(tagged, colTol, t => t.vx + t.vWidth);
    // Prefer more qualified (high-presence) anchors first — that is what the
    // anchor-quality gate actually checks next. Fewer total anchors is the
    // tiebreaker (a cleaner, more consolidated column set). Left-edge wins
    // ties, preserving existing behavior on every table where both edges
    // already agree (the overwhelming majority of real tables).
    const useRight = rightResult.qualified > leftResult.qualified ||
        (rightResult.qualified === leftResult.qualified && rightResult.anchors.length < leftResult.anchors.length);
    let colAnchors = useRight ? rightResult.anchors : leftResult.anchors;

    // If anchors span a large X gap (likely two separate page columns), signal
    // the caller to re-run per X zone by returning a special sentinel.
    // We do not attempt to pick one sub-group here: the items array contains
    // both zones interleaved and the bands are already mixed, so choosing
    // by centroid is unreliable. The caller splits bands by X zone first.
    const colGapMinPx = scale.colGapMinPx;
    const anchorSubGroups = _splitAnchorsAtXGap(colAnchors, colGapMinPx * 4);
    if (anchorSubGroups.length > 1) {
        // Return the split X so the caller can partition bands and retry
        const splitX = (anchorSubGroups[0][anchorSubGroups[0].length - 1].x +
                        anchorSubGroups[1][0].x) / 2;
        return { _xZoneSplit: splitX };
    }

    if (colAnchors.length < scale.STREAM_MIN_COLS) return null;

    // Anchor quality gate: at least half the anchors must appear in a meaningful
    // fraction of bands. This rejects two prose false-positive patterns:
    //   (a) "1 real left-margin anchor + N noise word-position anchors" where
    //       most anchors only appear in 2 bands by coincidence.
    //   (b) Very small groups (3 bands) where any 3 dense prose lines align well.
    // For small groups (≤ 5 bands) we require anchors to appear in all bands;
    // for larger groups we require ≥ 25% band presence.
    const minPresenceBands = bands.length <= 5
        ? bands.length          // all bands must contain anchor
        : Math.max(3, Math.floor(bands.length * 0.25));
    const anchorBandCounts = colAnchors.map(a => new Set(a.items.map(i => i._band)).size);
    const qualifiedAnchors = anchorBandCounts.filter(bc => bc >= minPresenceBands).length;
    if (qualifiedAnchors < Math.ceil(colAnchors.length / 2)) return null;

    // ── Score 1: column alignment consistency ────────────────────────────────
    // Use alignItems (the dominant sub-cluster only) rather than the full,
    // possibly-merged items set — see _mergeSparseAnchors.
    const colAlignScore = Math.max(0,
        1 - _mean(colAnchors.map(a => _stdDev(a.alignXs ?? (a.alignItems ?? a.items).map(i => i.vx)))) / colTol,
    );

    // ── Score 2: row spacing regularity (participating bands only) ───────────
    //
    // "Has one item near one anchor" alone is not enough of a filter: on a
    // dense, justified prose column, some word start coincidentally lands
    // within colTol of SOME anchor on almost every line (measured on a real
    // 2-column paper: prose lines matched 1-7 of 7 anchors essentially at
    // random, and one prose line matched all 7). Left unfiltered, ~14 prose
    // bands surrounding a real 7-row results table all qualified as
    // "participating" and were absorbed into the table region.
    //
    // Real table rows have a second, much sharper signature: a near-constant
    // item count per row (one item per cell). Prose bands scatter across many
    // different item counts (word-wrapped lines rarely share a token count).
    // Require BOTH the existing anchor-proximity check AND an item count
    // close to the group's own mode — the dominant, most common item count
    // among ANCHOR-ALIGNED bands only (so the mode isn't itself diluted by
    // the same prose bands we're trying to exclude).
    const anchorXs = colAnchors.map(a => a.x);
    const anchorAligned = bands.filter(band =>
        band.items.some(item => anchorXs.some(ax => Math.abs(item.vx - ax) <= colTol)),
    );
    const itemCounts = new Map();
    for (const band of anchorAligned) {
        const n = band.items.length;
        itemCounts.set(n, (itemCounts.get(n) || 0) + 1);
    }
    let modeCount = 0, modeFreq = 0;
    for (const [n, freq] of itemCounts) {
        if (freq > modeFreq) { modeCount = n; modeFreq = freq; }
    }
    // Exact match, not a tolerance band: measured on a real 2-column paper,
    // a +-2 tolerance still let 3 of 12 prose bands leak in (their item counts
    // landed close enough to the mode by coincidence) and that was enough to
    // corrupt rowSpacingScore (0.32 instead of the true row cadence). A row
    // occasionally carrying one extra decoration token (e.g. an unmerged "$")
    // is who this excludes too, but that is the same acceptable trade the
    // anchor-merge fix already makes elsewhere: losing a few decorated rows
    // from `participating` is far cheaper than losing the whole table to
    // prose contamination.
    const itemCountTol = 0;
    const participating = anchorAligned.filter(band =>
        Math.abs(band.items.length - modeCount) <= itemCountTol,
    );
    // Every gate below measures the CANDIDATE TABLE, not the whole band group
    // that was passed in. Before this, fillRate/avgLen/avgItemsPerBand and the
    // bbox extent were all computed from `tagged` — the full, possibly
    // prose-including group — so tightening `participating` above (excluding
    // real prose bands) actually made the items/band gate WORSE: the
    // denominator shrank while the numerator (tagged.length) still counted
    // every excluded prose item. Scoping to participatingItems is what makes
    // the two fixes coherent with each other.
    const participatingItems = participating.flatMap(b => b.items);

    // No participating band means there is no candidate table, and every
    // numeric gate below fails to say so: fillRate becomes 0/0 = NaN, and
    // `NaN < min` is false, so NaN passes a rejection test that any real
    // value would have failed. avgLen and avgItemsPerBand divide by a
    // `|| 1` guard and come out 0, which passes their caps too. The empty
    // candidate then reaches the row-boundary code and dereferences
    // participating[0].y.
    //
    // Reject explicitly, before arithmetic on an empty set can launder the
    // emptiness into a passing score. Needs 2 bands minimum: one row is not
    // a table, and the row-gap cadence below needs a pair to measure.
    if (participating.length < 2) return null;

    // ── Structural context gates ──────────────────────────────────────────────
    // Pre-detect gutters before the avgLen gate so gutter evidence can relax it.
    // Tables with clear X coverage gaps are structurally column-separated even
    // when some cells contain longer text (row labels, system names, etc.).
    const earlyGutters = _detectGutters(participating, 0.6, scale.S * 0.15);
    const hasGutterEvidence = earlyGutters.length >= 1;

    const fillRate = participatingItems.length / (participating.length * colAnchors.length);
    if (fillRate < scale.STREAM_MIN_FILL) return null;

    const avgLen = participatingItems.reduce((s, i) => s + i.str.trim().length, 0) / (participatingItems.length || 1);
    // Relax avgLen only in zone mode (items are pre-filtered to one page column)
    // so the relaxation cannot allow prose from mixed-content pages through.
    const avgLenCap = (zoneMode && hasGutterEvidence)
        ? Math.max(scale.STREAM_MAX_AVG_LEN, 40)
        : scale.STREAM_MAX_AVG_LEN;
    if (avgLen > avgLenCap) return null;

    // Items-per-band gate rejects prose, where a "row" is many words but few
    // align to columns. A wide table legitimately has one cell per column, so
    // items-per-band tracks the column count — a 10-column table has ~10 items
    // per band and must not be rejected by the fixed prose cap. Allow up to
    // 1.4× the detected anchor count (slack for the occasional two-token cell),
    // never below the base prose cap.
    const avgItemsPerBand = participatingItems.length / (participating.length || 1);
    const itemsPerBandCap = Math.max(scale.STREAM_MAX_ITEMS_BAND, colAnchors.length * 1.4);
    if (avgItemsPerBand > itemsPerBandCap) return null;

    let rowSpacingScore = 0.8;
    if (participating.length >= 2) {
        const rowGaps = [];
        for (let i = 1; i < participating.length; i++) {
            rowGaps.push(participating[i].y - participating[i - 1].y);
        }
        rowSpacingScore = rowGaps.length < 2
            ? 0.8
            : Math.max(0, 1 - _stdDev(rowGaps) / (_mean(rowGaps) || 1));
    }

    const confidence = (colAlignScore + rowSpacingScore) / 2;
    if (confidence < scale.STREAM_CONFIDENCE) return null;

    // ── 3. Extract axis-aligned slats from segments ──────────────────────────
    const b = {
        xMin: Math.min(...tagged.map(i => i.vx)),
        xMax: Math.max(...tagged.map(i => i.vx + i.vWidth)),
        yMin: Math.min(...tagged.map(i => i.vy)),
        yMax: Math.max(...tagged.map(i => i.vy)),
    };
    const hSlats = [], vSlats = [];
    if (segments.length) {
        for (const s of segments) {
            const dx = Math.abs(s.x2 - s.x1);
            const dy = Math.abs(s.y2 - s.y1);
            const midX = (s.x1 + s.x2) / 2;
            const midY = (s.y1 + s.y2) / 2;

            // Only consider slats that overlap the table's text-item bbox
            if (midX < b.xMin - 20 || midX > b.xMax + 20 || midY < b.yMin - 20 || midY > b.yMax + 20) continue;

            if (dy <= eps && dx > eps) hSlats.push(midY);
            else if (dx <= eps && dy > eps) vSlats.push(midX);
        }
    }

    // ── Build column boundaries ───────────────────────────────────────────────
    const gutters = earlyGutters;
    // Merge vertical slats into gutters (slats between columns)
    for (const sx of vSlats) {
        if (!gutters.some(gx => Math.abs(gx - sx) < colTol)) gutters.push(sx);
    }

    const pad = scale.S * 0.3;
    const rightExtent = b.xMax + pad;

    const cols = [colAnchors[0].x - colTol * 0.5];
    for (let i = 1; i < colAnchors.length; i++) {
        const lo = colAnchors[i - 1].x;
        const hi = colAnchors[i].x;
        // Priority: vertical slat > detected gutter > midpoint
        const slat = vSlats.find(x => x > lo && x < hi);
        const gutter = gutters.find(x => x > lo && x < hi);
        cols.push(slat ?? gutter ?? (lo + hi) / 2);
    }
    cols.push(Math.max(colAnchors[colAnchors.length - 1].x + colTol * 0.5, rightExtent));

    // ── Column-distribution gate ──────────────────────────────────────────────
    // A real table's column boundaries spread across its full width. Two-column
    // prose produces boundaries bunched at the left margin (line-start indent,
    // list markers, ragged word-starts) while one long line stretches the right
    // extent far out — so the interior boundaries span only a tiny fraction of
    // the region. Reject when the interior boundaries occupy < 25% of the total
    // boundary span. Measured on col boundaries (not raw anchors) because the
    // right extent, driven by content reach, is exactly the discriminator:
    // prose has content reaching far right of its last aligned column.
    // Prose false positives score ~0.12; real tables score >= 0.33.
    if (cols.length >= 4) {
        const totalSpan = cols[cols.length - 1] - cols[0];
        const interior = cols.slice(1, -1);
        const interiorSpan = interior[interior.length - 1] - interior[0];
        if (totalSpan > 0 && interiorSpan / totalSpan < 0.25) return null;
    }

    // ── Build row boundaries from participating bands ────────────────────────
    const halfRowH = scale.S * 0.6;
    const rows = [];
    const firstY = participating[0].y;
    const firstSlat = hSlats.find(y => y < firstY && y > firstY - halfRowH * 2);
    rows.push(firstSlat ?? (firstY - halfRowH));

    for (let i = 1; i < participating.length; i++) {
        const lo = participating[i - 1].y;
        const hi = participating[i].y;
        const slat = hSlats.find(y => y > lo && y < hi);
        rows.push(slat ?? (lo + hi) / 2);
    }

    const lastY = participating[participating.length - 1].y;
    const lastSlat = hSlats.find(y => y > lastY && y < lastY + halfRowH * 2);
    rows.push(lastSlat ?? (lastY + halfRowH));

    const bbox = {
        x: cols[0],
        y: rows[0],
        w: cols[cols.length - 1] - cols[0],
        h: rows[rows.length - 1] - rows[0],
    };

    return {
        rows, cols, hLines: [], vLines: [], bbox, border: false,
        detectionMethod: 'stream', confidence
    };
}

/**
 * Identify items belonging to a table that spans a page-column split.
 *
 * A spanning table's rows have aligned cells on both sides of the gutter. We
 * detect a contiguous run of Y-bands that each carry text on both sides of a
 * split X with a real channel at that X (a gutter, not just a word gap), and
 * where those bands share consistent column anchors across the full width.
 * Returns the flat item list for those bands (empty if no spanning table).
 *
 * Guard against grabbing ordinary two-column prose: prose lines also straddle
 * the gutter, but their left/right fragments are long running text, not a grid.
 * We require the spanning bands to have MANY short-token columns (>= 4 total
 * X-clusters present in >= 2 bands) so a real multi-column table is needed.
 */
function _extractSpanningTableItems(items, columnXs, scale) {
    const bands = _groupByYBand(items, scale.yBandTolPx);
    if (bands.length < scale.STREAM_MIN_BANDS) return [];

    const colTol = scale.colGapMinPx;
    // Mark bands that straddle any split X with a real channel on both sides.
    const straddles = bands.map(band => {
        for (const X of columnXs) {
            const left = band.items.filter(i => (i.vx + (i.vWidth || 0)) <= X - colTol);
            const right = band.items.filter(i => i.vx >= X + colTol);
            if (!left.length || !right.length) continue;
            // A grid row has SHORT cells either side; a prose line has one long
            // run. Require the nearest-to-gutter fragments to be short.
            const leftAvg = left.reduce((s, i) => s + (i.str || '').trim().length, 0) / left.length;
            const rightAvg = right.reduce((s, i) => s + (i.str || '').trim().length, 0) / right.length;
            if (leftAvg <= 24 && rightAvg <= 24) return true;
        }
        return false;
    });

    // Find the longest contiguous run of straddling bands.
    let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
    for (let i = 0; i < straddles.length; i++) {
        if (straddles[i]) {
            if (curStart === -1) curStart = i;
            curLen++;
            if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
        } else { curStart = -1; curLen = 0; }
    }
    if (bestLen < scale.STREAM_MIN_BANDS) return [];

    const runBands = bands.slice(bestStart, bestStart + bestLen);

    // Confirm multi-column structure across the full width: cluster all X
    // positions in the run and require >= 4 anchors present in >= 2 bands.
    const tagged = [];
    for (let bi = 0; bi < runBands.length; bi++) {
        for (const it of runBands[bi].items) tagged.push({ vx: it.vx, _band: bi });
    }
    const clusters = _clusterByX(tagged, scale.colTolPx);
    const anchors = clusters.filter(c => new Set(c.map(i => i._band)).size >= 2);
    if (anchors.length < 4) return [];

    return runBands.flatMap(b => b.items);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect borderless tables in a set of unclaimed text items.
 *
 * @param {Array<{vx,vy,vWidth,vFont,str,idx}>} textMeta      — unclaimed items
 * @param {PageScale}                           scale          — natural-unit scale
 * @param {Array<{bbox}>}                       latticeRegions — for overlap exclusion
 * @param {Array}                               segments       — optional path segments (slat hints)
 * @param {number[]}                            columnXs       — pre-detected page column X positions
 * @returns {Array}  synthetic lattice objects (LatticeReconstructor output shape)
 */
export function detectStreamTables(textMeta, scale, latticeRegions = [], segments = [], columnXs = []) {
    const items = textMeta.filter(tm => tm.str.trim());
    if (items.length < 6) return [];

    // If page column splits are known, run detection per column zone separately.
    // This prevents items from unrelated columns (same Y range, different X zone)
    // from contaminating each other's anchor clustering and gate metrics.
    if (columnXs.length > 0) {
        const results = [];

        // Pre-pass: spanning tables. A wide table (e.g. a GLUE results table
        // above a two-column body) straddles the page-column gutter — its rows
        // have aligned cells on BOTH sides of a split X. Running per-zone would
        // slice it in half and orphan the right columns. Detect those spanning
        // Y-bands first, run full-width detection on them, and claim their
        // items so the per-zone pass only sees genuinely single-column content.
        const spanItems = _extractSpanningTableItems(items, columnXs, scale);
        if (spanItems.length >= 6) {
            const spanResults = detectStreamTables(spanItems, scale, latticeRegions, segments, []);
            for (const r of spanResults) {
                if (!_overlapsLattice(r.bbox, results)) results.push(r);
            }
        }
        // Remaining items exclude anything already claimed by a spanning table.
        const claimed = new Set(spanItems);
        const rest = items.filter(i => !claimed.has(i));

        const boundaries = [-Infinity, ...columnXs, Infinity];
        for (let zi = 0; zi < boundaries.length - 1; zi++) {
            const lo = boundaries[zi], hi = boundaries[zi + 1];
            const zoneItems = rest.filter(i => i.vx >= lo && i.vx < hi);
            if (zoneItems.length < 6) continue;
            const zoneResults = detectStreamTables(zoneItems, scale, [...latticeRegions, ...results], segments, []);
            for (const r of zoneResults) {
                if (!_overlapsLattice(r.bbox, results)) results.push(r);
            }
        }
        return results;
    }

    const inZoneMode = columnXs.length > 0;

    // Step 1: Group items into individual row-bands using fixed yTol.
    const bands = _groupByYBand(items, scale.yBandTolPx);
    if (bands.length < scale.STREAM_MIN_BANDS) return [];

    // Step 2: Group bands into table-candidate sections using adaptive gap detection.
    // Secondary split (compact table cluster vs. prose) is only enabled in zone mode
    // where items are pre-filtered to one page column, reducing false-positive risk.
    const tableGroups = _groupBandsByAdaptiveGap(bands, { enableSecondary: inZoneMode });
    const validGroups = tableGroups.filter(g => g.length >= scale.STREAM_MIN_BANDS);

    // Step 3: Fallback — if every gap-split group was still too small, try all bands
    // as one group.
    if (validGroups.length === 0 && bands.length >= scale.STREAM_MIN_BANDS) {
        validGroups.push(bands);
    }
    const results = [];
    for (const group of validGroups) {
        const candidate = _buildCandidate(group, scale, segments, { zoneMode: inZoneMode });
        if (!candidate) continue;

        // _buildCandidate detected that bands span two page-column X zones.
        // Split the bands at the returned X and retry each zone independently.
        if (candidate._xZoneSplit !== undefined) {
            const splitX = candidate._xZoneSplit;
            const leftBands = group.map(b => ({
                y: b.y,
                items: b.items.filter(i => i.vx < splitX),
            })).filter(b => b.items.length > 0);
            const rightBands = group.map(b => ({
                y: b.y,
                items: b.items.filter(i => i.vx >= splitX),
            })).filter(b => b.items.length > 0);

            for (const zoneBands of [leftBands, rightBands]) {
                if (zoneBands.length < scale.STREAM_MIN_BANDS) continue;
                const zc = _buildCandidate(zoneBands, scale, segments, { zoneMode: true });
                if (!zc || zc._xZoneSplit !== undefined) continue;
                if (_overlapsLattice(zc.bbox, latticeRegions)) continue;
                if (_overlapsLattice(zc.bbox, results)) continue;
                results.push(zc);
            }
            continue;
        }

        if (_overlapsLattice(candidate.bbox, latticeRegions)) continue;
        if (_overlapsLattice(candidate.bbox, results)) continue;
        results.push(candidate);
    }

    return results;
}
