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
 * A "section break" between two consecutive bands is a gap significantly
 * larger than the typical inter-row spacing for this page. We derive the
 * threshold from the band-to-band gap distribution itself (2.5× the median
 * inter-band gap) rather than a fixed multiple of body font size.
 *
 * Why this works:
 *   - sparktoro rows are 43 px apart; median band gap ≈ 43 px
 *     → threshold = 107 px; the 182 px section break splits correctly ✓
 *   - Dense engineering tables with 13 px rows; median ≈ 13 px
 *     → threshold = 32 px; large inter-section gaps split correctly ✓
 *   - A minimum of 20 px prevents a threshold so small that every row is
 *     treated as its own section.
 */
function _groupBandsByAdaptiveGap(bands) {
    if (bands.length < 2) return [bands];

    const gaps = [];
    for (let i = 1; i < bands.length; i++) {
        gaps.push(bands[i].y - bands[i - 1].y);
    }

    const sorted   = [...gaps].sort((a, b) => a - b);
    const median   = sorted[Math.floor(sorted.length / 2)];
    const splitAt  = Math.max(median * 2.5, 20);

    const groups = [[bands[0]]];
    for (let i = 1; i < bands.length; i++) {
        if (gaps[i - 1] > splitAt) groups.push([]);
        groups[groups.length - 1].push(bands[i]);
    }
    return groups;
}

// Greedy X-clustering with running-mean centroid update.
function _clusterByX(items, tol) {
    const sorted   = [...items].sort((a, b) => a.vx - b.vx);
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
 * Find X ranges where fewer than minFrac of bands have text coverage.
 * Returns gutter center X positions — used as column boundary candidates.
 */
function _detectGutters(bands, minFrac = 0.6) {
    if (!bands.length) return [];
    const allItems = bands.flatMap(b => b.items);
    if (!allItems.length) return [];

    const maxX = allItems.reduce((m, i) => Math.max(m, i.vx + (i.vWidth || 0)), 0);
    const w    = Math.ceil(maxX) + 1;
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
    const gutters   = [];
    let gStart = null;

    for (let x = 0; x < w; x++) {
        if (bandCount[x] < threshold) {
            if (gStart === null) gStart = x;
        } else if (gStart !== null) {
            if (x - gStart >= 4) gutters.push((gStart + x) / 2);
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

function _buildCandidate(bands, scale) {
    const colTol = scale.colTolPx;

    const tagged = [];
    for (let bi = 0; bi < bands.length; bi++) {
        for (const item of bands[bi].items) {
            tagged.push({ vx: item.vx, vy: item.vy, vWidth: item.vWidth || 0,
                          str: item.str || '', _band: bi });
        }
    }

    // Column anchor = X cluster present in ≥ 2 distinct bands
    const xClusters  = _clusterByX(tagged, colTol);
    const colAnchors = [];
    for (const cluster of xClusters) {
        const bandSet = new Set(cluster.map(i => i._band));
        if (bandSet.size >= 2) {
            colAnchors.push({ x: _mean(cluster.map(i => i.vx)), items: cluster });
        }
    }
    if (colAnchors.length < scale.STREAM_MIN_COLS) return null;
    colAnchors.sort((a, b) => a.x - b.x);

    // ── Score 1: column alignment consistency ────────────────────────────────
    const colAlignScore = Math.max(0,
        1 - _mean(colAnchors.map(a => _stdDev(a.items.map(i => i.vx)))) / colTol,
    );

    // ── Score 2: row spacing regularity (participating bands only) ───────────
    // Only measure bands that have items aligning to a detected column anchor.
    // Title/footer/section-label bands that don't share the column pattern
    // have erratic Y spacing and would destroy the score if included.
    const anchorXs    = colAnchors.map(a => a.x);
    const participating = bands.filter(band =>
        band.items.some(item => anchorXs.some(ax => Math.abs(item.vx - ax) <= colTol)),
    );

    // ── Structural context gates ──────────────────────────────────────────────
    // Three discriminants that separate borderless data tables from
    // column-aligned flowing text (TOC pages, multi-column prose).
    //
    // Gate 1 — fill rate: real tables have most cells populated.
    //   TOC/text layout: 0.24–0.34   |   data table: 0.55–1.0
    const fillRate = tagged.length / (participating.length * colAnchors.length);
    if (fillRate < scale.STREAM_MIN_FILL) return null;

    // Gate 2 — average text item length: table cells are short values (numbers,
    //   codes, labels). Prose items are longer phrases or sentence fragments.
    //   TOC items avg ~20–40 chars   |   sparktoro items avg ~4–8 chars
    const avgLen = tagged.reduce((s, i) => s + i.str.trim().length, 0) / (tagged.length || 1);
    if (avgLen > scale.STREAM_MAX_AVG_LEN) return null;

    // Gate 3 — avg items per band: dense lines (>8 items) are prose rows, not
    //   table rows. A table row with N columns has ≈ N items per band.
    const avgItemsPerBand = tagged.length / (participating.length || 1);
    if (avgItemsPerBand > scale.STREAM_MAX_ITEMS_BAND) return null;

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

    // ── Build column boundaries ───────────────────────────────────────────────
    const gutters     = _detectGutters(participating, 0.6);
    const pad         = scale.S * 0.3;
    const rightExtent = tagged.reduce((m, i) => Math.max(m, i.vx + i.vWidth), -Infinity) + pad;

    const cols = [colAnchors[0].x - colTol * 0.5];
    for (let i = 1; i < colAnchors.length; i++) {
        const lo = colAnchors[i - 1].x;
        const hi = colAnchors[i].x;
        const g  = gutters.find(x => x > lo && x < hi);
        cols.push(g ?? (lo + hi) / 2);
    }
    cols.push(Math.max(colAnchors[colAnchors.length - 1].x + colTol * 0.5, rightExtent));

    // ── Build row boundaries from participating bands ────────────────────────
    const halfRowH = scale.S * 0.6;
    const rows     = [participating[0].y - halfRowH];
    for (let i = 1; i < participating.length; i++) {
        rows.push((participating[i - 1].y + participating[i].y) / 2);
    }
    rows.push(participating[participating.length - 1].y + halfRowH);

    const bbox = {
        x: cols[0],
        y: rows[0],
        w: cols[cols.length - 1] - cols[0],
        h: rows[rows.length - 1] - rows[0],
    };

    return { rows, cols, hLines: [], vLines: [], bbox, border: false,
             detectionMethod: 'stream', confidence };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect borderless tables in a set of unclaimed text items.
 *
 * @param {Array<{vx,vy,vWidth,vFont,str,idx}>} textMeta      — unclaimed items
 * @param {PageScale}                           scale          — natural-unit scale
 * @param {Array<{bbox}>}                       latticeRegions — for overlap exclusion
 * @returns {Array}  synthetic lattice objects (LatticeReconstructor output shape)
 */
export function detectStreamTables(textMeta, scale, latticeRegions = []) {
    const items = textMeta.filter(tm => tm.str.trim());
    if (items.length < 6) return [];

    // Step 1: Group items into individual row-bands using fixed yTol.
    const bands = _groupByYBand(items, scale.yBandTolPx);
    if (bands.length < scale.STREAM_MIN_BANDS) return [];

    // Step 2: Group bands into table-candidate sections using adaptive gap detection.
    // A section break is a gap > 2.5× the median inter-band gap (the "gutter" between
    // table sections vs the normal row spacing).
    const tableGroups = _groupBandsByAdaptiveGap(bands);
    const validGroups = tableGroups.filter(g => g.length >= scale.STREAM_MIN_BANDS);

    // Step 3: Fallback — if every gap-split group was still too small, try all bands
    // as one group. The confidence check rejects non-tabular content.
    if (validGroups.length === 0 && bands.length >= scale.STREAM_MIN_BANDS) {
        validGroups.push(bands);
    }

    const results = [];
    for (const group of validGroups) {
        const candidate = _buildCandidate(group, scale);
        if (!candidate) continue;
        if (_overlapsLattice(candidate.bbox, latticeRegions)) continue;
        results.push(candidate);
    }

    return results;
}
