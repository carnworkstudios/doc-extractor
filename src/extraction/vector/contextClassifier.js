// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// contextClassifier.js — orchestrator
//
// Builds the shared spatial context (PageGraph), then calls each classifier
// sub-module in tier order, merges results, and returns the region manifest.
//
// Previously a 1,150-line monolith. Now each detection algorithm lives in
// its own file under classifiers/ and receives PageGraph for spatial queries.
//
// Safe to run inside a Web Worker.

import { PageScale } from './pageScale.js';
import { readStructTree } from './structTreeReader.js';
import { PageGraph } from './spatialGraph.js';
import { detectPageColumns, splitByColumns } from './classifiers/columnSplitDetector.js';
import { detectUnderlines } from './classifiers/underlineDetector.js';
import { detectPictureRegions, filterTableSegs } from './classifiers/imageRegionDetector.js';
import { detectLatticeTables } from './classifiers/latticeDetector.js';
import { detectStreamTableRegions } from './classifiers/streamTableDetector.js';
import { detectStreamTables } from './streamDetector.js';
import { detectBoxRegions } from './classifiers/boxDetector.js';
import { analyzeBlock } from './classifiers/proseGate.js';
import { detectDividers } from './classifiers/dividerDetector.js';
import { detectHeadersFooters } from './classifiers/headerFooterDetector.js';
import { detectReferences } from './classifiers/referenceDetector.js';
import { mergeMathRegions } from './classifiers/mathRegionMerger.js';
import { classifyHeading } from './classifiers/headingDetector.js';
import { classifyList, BULLET_RE as _BULLET_RE, ORDERED_RE as _ORDERED_RE } from './classifiers/listDetector.js';
import { RegionType } from './classifiers/regionTypes.js';
import { LatticeReconstructor } from './latticeReconstructor.js';

export { detectPageColumns, splitByColumns } from './classifiers/columnSplitDetector.js';
export { RegionType } from './classifiers/regionTypes.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toViewport(vpTransform, pdfX, pdfY) {
    return [
        vpTransform[0] * pdfX + vpTransform[2] * pdfY + vpTransform[4],
        vpTransform[1] * pdfX + vpTransform[3] * pdfY + vpTransform[5],
    ];
}

/** Compose two 2D affine matrices in PDF's [a b c d e f] order: apply b, then a. */
function mulMatrix(a, b) {
    return [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ];
}

function insideBBox(px, py, bbox, pad = 0) {
    return px >= bbox.x - pad && px <= bbox.x + bbox.w + pad &&
        py >= bbox.y - pad && py <= bbox.y + bbox.h + pad;
}

// ── Custom-region helpers ─────────────────────────────────────────────────────

const _TABLE_TYPES = new Set(['LATTICE_TABLE', 'TABLE', 'STREAM_TABLE']);

// Types whose yCenter the pipeline measures off the TEXT (see _flushBlock).
// Everything else (IMAGE, BOX, DIVIDER) uses the bbox midpoint, so measuring
// their label text instead would move them relative to the natural result.
const _TEXT_FLOW_TYPES = new Set(['PARAGRAPH', 'HEADING', 'LIST', 'MATH', 'REFERENCE', 'HEADER', 'FOOTER']);

/**
 * Assign text items to custom (user-overridden) regions, exclusively.
 *
 * Two rules, both learned the hard way:
 *
 * 1. Containment is unpadded and uses the item's CENTRE for prose. The old
 *    test padded every region by the TABLE cell padding and matched on the
 *    item's left edge / baseline, so a one-line region reached into the line
 *    below it and claimed it too. Table types keep the pad: cell text hugs
 *    the rules and genuinely sits on the boundary.
 *
 * 2. An item belongs to exactly ONE region. Regions were previously matched
 *    in isolation, so an item inside two boxes was rendered by both and the
 *    text came out duplicated. Contested items go to the SMALLEST region,
 *    which is the more specific override; ties break on array order so the
 *    result is deterministic.
 *
 * Returns Map<customRegion, { textIndices, matchedItems }>.
 */
function _claimCustomText(customRegions, textMeta, scale, claimBboxes) {
    const tablePad = scale.tablePadPx ?? 5;
    const out = new Map();
    const targets = [];
    for (const cr of customRegions) {
        out.set(cr, { textIndices: [], matchedItems: [] });
        if (!cr.bbox || cr.skip) continue;
        // A ruled table claims against its reconstructed grid, which is
        // usually wider than the box drawn around it. See _gridBounds.
        const bbox = claimBboxes?.get(cr) || cr.bbox;
        targets.push({
            cr,
            bbox,
            area: Math.max(bbox.w * bbox.h, 0),
            pad: _TABLE_TYPES.has(cr.type) ? tablePad : 0,
            isTable: _TABLE_TYPES.has(cr.type),
            ruled: cr.type === 'LATTICE_TABLE' || cr.type === 'TABLE',
        });
    }
    if (!targets.length) return out;

    const assign = (t, tm) => {
        const slot = out.get(t.cr);
        slot.textIndices.push(tm.idx);
        slot.matchedItems.push(tm);
    };
    const pick = (tm, relaxed) => {
        // Prose matches on the glyph-run centre; a table cell matches on its
        // anchor, because a wide cell value can start left of its column rule.
        const cx = tm.vx + (tm.vWidth || 0) / 2;
        let best = null;
        for (const t of targets) {
            const px = (t.isTable || relaxed) ? tm.vx : cx;
            const pad = relaxed ? tablePad : t.pad;
            if (!insideBBox(px, tm.vy, t.bbox, pad)) continue;
            if (!best) { best = t; continue; }
            // Ruled tables outrank stream tables for the same cell, mirroring
            // the pipeline's own detector order (lattice claims first, stream
            // takes what is left). Without this a stream table nested inside a
            // ruled one stole its cells, because it is the smaller box.
            // Table-vs-table only: a PARAGRAPH drawn inside a table is a
            // deliberate override and must still win on size.
            if (t.isTable && best.isTable && t.ruled !== best.ruled) {
                if (t.ruled) best = t;
                continue;
            }
            if (t.area < best.area) best = t;
        }
        return best;
    };

    // Pass 1 — strict containment. Everything that unambiguously belongs to a
    // region is settled here, so pass 2 can never take a line off a region
    // that already owns it.
    const leftover = [];
    for (const tm of textMeta) {
        if (!tm.str.trim()) continue;
        const best = pick(tm, false);
        if (best) assign(best, tm);
        else leftover.push(tm);
    }

    // Pass 2 — relaxed containment for what pass 1 left homeless. Strict
    // matching is tighter than the classifier's own region bounds, so an item
    // sitting on a boundary could end up claimed by nobody while the natural
    // region that would have held it was filtered out for overlapping a
    // custom region: the item then vanished from the page entirely (a figure
    // label went missing this way). Still exclusive — an item lands in one
    // region or none.
    for (const tm of leftover) {
        const best = pick(tm, true);
        if (best) assign(best, tm);
    }
    return out;
}

/** Midpoint of the claimed text's vertical extent — how _flushBlock measures it. */
function _textYCenter(items) {
    if (!items?.length) return null;
    let yMin = Infinity, yMax = -Infinity;
    for (const tm of items) {
        if (tm.vy < yMin) yMin = tm.vy;
        if (tm.vy > yMax) yMax = tm.vy;
    }
    return (yMin + yMax) / 2;
}

/** A lattice with only one cell is a flattened region, not a table. */
function _isUsableLattice(l) {
    if (!l || !Array.isArray(l.rows) || !Array.isArray(l.cols)) return false;
    return (l.rows.length - 1) * (l.cols.length - 1) >= 2;
}

/**
 * The reconstructed grid that best fills the region, not merely the first one.
 *
 * `reconstructAll()` returns every grid it can find in the segments it was
 * given, in no useful order. A ruled table's segments routinely reconstruct
 * into several candidates — the whole grid plus, say, the header strip on its
 * own. Taking [0] handed back the header strip: a 10x6 architecture table
 * re-extracted as a single 2x4 band. Pick the candidate that covers the most
 * of the region instead.
 */
function _pickLattice(lattices, bbox) {
    let best = null, bestScore = -1;
    for (const l of lattices || []) {
        if (!l?.bbox) continue;
        const ix = Math.min(bbox.x + bbox.w, l.bbox.x + l.bbox.w) - Math.max(bbox.x, l.bbox.x);
        const iy = Math.min(bbox.y + bbox.h, l.bbox.y + l.bbox.h) - Math.max(bbox.y, l.bbox.y);
        const score = (ix > 0 && iy > 0) ? ix * iy : 0;
        if (score > bestScore) { bestScore = score; best = l; }
    }
    return best;
}

/**
 * The box a reconstructed table actually occupies: its own bbox unioned with
 * the grid the rules produced.
 *
 * A region bbox is measured off the ink the detector clustered, but
 * tableBuilder fills cells from the grid, and the grid routinely runs wider.
 * The ResNet architecture table's LATTICE_TABLE bbox is ~200px narrower than
 * its own rules, so claiming text by the bbox starved it: nine rows and
 * thirty cells came back as one header row with no cells at all. Claim
 * against what the table will render from, not what was drawn around it.
 */
function _gridBounds(bbox, lattice) {
    const xs = lattice.cols, ys = lattice.rows;
    if (!xs?.length || !ys?.length) return bbox;
    const x = Math.min(bbox.x, ...xs);
    const y = Math.min(bbox.y, ...ys);
    return {
        x, y,
        w: Math.max(bbox.x + bbox.w, ...xs) - x,
        h: Math.max(bbox.y + bbox.h, ...ys) - y,
    };
}

/**
 * A borderless table's grid, built by the page's own stream detector.
 *
 * _bandLattice below is a standalone reading of the text and it does not
 * agree with detectStreamTables: on the ResNet architecture page's right-hand
 * column it split eight rows into sixteen, because the real detector groups
 * bands by an adaptive gap while the standalone one bands on y alone. An
 * override has to reproduce the pipeline's answer, so ask the pipeline.
 * _bandLattice stays as the fallback for when the detector's gates reject the
 * items — a hand-drawn box is allowed to be a table even when the detector
 * would not have found one there.
 */
function _streamLattice(bbox, matchedItems, scale, segments) {
    if (matchedItems.length >= 6) {
        const found = _pickLattice(detectStreamTables(matchedItems, scale, [], segments, []), bbox);
        if (_isUsableLattice(found)) return found;
    }
    return _bandLattice(bbox, matchedItems, scale);
}

/**
 * Grid read off the text: rows from y-bands, columns from x-clusters snapped
 * to real coverage gaps. This is what a STREAM_TABLE override gets, and what
 * a LATTICE override falls back to when the ink reconstructs to nothing.
 *
 * hLines/vLines are always present. Omitting them on the old lattice fallback
 * crashed tableBuilder (`Cannot read properties of undefined (reading
 * 'length')`) and failed the entire page re-extract.
 */
function _bandLattice(bbox, matchedItems, scale) {
    // detectionMethod 'user-drawn': this grid came from a region the user
    // drew, not from streamDetector's scored candidate search. The 1.0 is
    // "the human said so", NOT a measurement — tableBuilder only publishes a
    // data-confidence for genuinely measured sources.
    const base = {
        hLines: [], vLines: [], bbox, border: false,
        detectionMethod: 'user-drawn', confidence: 1.0,
    };
    const bands = _groupByYBand(matchedItems, scale.yBandTolPx);
    if (!bands.length) {
        return { ...base, rows: [bbox.y, bbox.y + bbox.h], cols: [bbox.x, bbox.x + bbox.w] };
    }

    const tagged = [];
    for (let bi = 0; bi < bands.length; bi++) {
        for (const item of bands[bi].items) {
            tagged.push({
                vx: item.vx, vy: item.vy, vWidth: item.vWidth || 0,
                str: item.str || '', _band: bi,
            });
        }
    }
    const colAnchors = _clusterByX(tagged, scale.colTolPx)
        .map(cluster => ({ x: _mean(cluster.map(i => i.vx)), items: cluster }))
        .sort((a, b) => a.x - b.x);

    let cols;
    if (colAnchors.length === 0) {
        cols = [bbox.x, bbox.x + bbox.w];
    } else {
        const gutters = _detectGutters(bands, 0.6, scale.S * 0.15) || [];
        cols = [bbox.x];
        for (let i = 1; i < colAnchors.length; i++) {
            const lo = colAnchors[i - 1].x;
            const hi = colAnchors[i].x;
            const gutter = gutters.find(x => x > lo && x < hi);
            cols.push(gutter ?? (lo + hi) / 2);
        }
        cols.push(bbox.x + bbox.w);
    }

    const rows = [bbox.y];
    for (let i = 1; i < bands.length; i++) rows.push((bands[i - 1].y + bands[i].y) / 2);
    rows.push(bbox.y + bbox.h);

    return { ...base, rows, cols };
}

/**
 * Place regions into a column from their bbox centre. Mirrors the pass the
 * naturally-classified regions get; custom-injected regions are appended
 * after that pass runs, so they need their own call or they stay at -1
 * (= full width) and render across a two-column page.
 */
function _assignColumnIndex(regions, columnSplits, viewport) {
    const epsC = 5;
    for (const r of regions) {
        const needs = r._needsColumn;
        delete r._needsColumn;
        if (!needs || !columnSplits?.length) continue;
        if (r.columnIndex !== -1 || !r.bbox) continue;
        const crossesSplit = columnSplits.some(sx =>
            r.bbox.x < sx - epsC && (r.bbox.x + r.bbox.w) > sx + epsC);
        if (r.bbox.w >= viewport.width * 0.65 || crossesSplit) continue;
        const cx = r.bbox.x + r.bbox.w / 2;
        for (let ci = 0; ci <= columnSplits.length; ci++) {
            const lo = ci === 0 ? -Infinity : columnSplits[ci - 1];
            const hi = ci === columnSplits.length ? Infinity : columnSplits[ci];
            if (cx >= lo && cx < hi) { r.columnIndex = ci; break; }
        }
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Guarantee every region has an id before it leaves classification.
 *
 * A region id is HALF of the address cross-tool artifacts use to find their way
 * home (page + regionId — see `origin` in assets/os/tables.js). Most detectors
 * assign one: `vecfig_0`, `picture_0`, `struct_table_0`. Two paths did not —
 * STREAM_TABLE (the common deterministic table) and the opts-supplied IMAGE
 * regions — so those reached the UI with `id: undefined`. They could still be
 * listed and selected as tags, but never resolved back to their content, and
 * the HTML emitter wrote `data-region-id="undefined"` for them.
 *
 * Ids are page-local and type-scoped, matching the convention the other
 * detectors already use, and are assigned LAST so a detector's own id always
 * wins. Collisions with an existing id are stepped over rather than
 * overwritten: two regions sharing an id is the same failure as having none.
 */
function _ensureRegionIds(regions) {
    // Children are regions too. A box's contents are addressable — you can
    // send a table nested in a callout to TAFNE, jump to it, or cite it — and
    // an id is what makes that possible, so both passes below walk the whole
    // tree flat, even though what is RETURNED stays the top-level list.
    const all = [];
    const queue = [...regions];
    while (queue.length) {
        const r = queue.shift();
        if (!r) continue;
        all.push(r);
        queue.push(...(r.children || []));
        for (const children of Object.values(r.cellChildren || {})) {
            queue.push(...(children || []));
        }
    }
    const seen = new Set();
    // Pass 1: keep every id that arrives, but make sure no two regions carry the
    // same one. A picture region that is exactly one raster XObject takes that
    // XObject's id — and the SAME XObject painted twice on a page (a repeated
    // warning icon, a logo on every panel) therefore produces several regions
    // with one id between them. That is the same failure as having no id: the
    // address stops identifying a region, so every lookup — the artifacts panel,
    // back-annotation, `getRegionHtml`, and the picture crop keyed by region id
    // — silently resolves all of them to whichever one came first, and the
    // repeats render the first placement's crop instead of their own.
    for (const r of all) {
        if (!r || r.id == null) continue;
        let id = String(r.id);
        if (seen.has(id)) {
            let n = 2;
            while (seen.has(`${id}__${n}`)) n++;
            id = `${id}__${n}`;
            r.id = id;
        }
        seen.add(id);
    }
    const counters = Object.create(null);
    for (const r of all) {
        if (!r || r.id != null) continue;
        const base = String(r.type || 'region').toLowerCase();
        let n = counters[base] || 0;
        let id;
        do { id = `${base}_${n++}`; } while (seen.has(id));
        counters[base] = n;
        seen.add(id);
        r.id = id;
    }
    return regions;
}

/**
 * Last-resort content invariant: every non-empty source run must have a region.
 *
 * Detectors are allowed to be wrong about structure, but they are not allowed
 * to delete evidence. This catches items pre-claimed by an optimistic detector
 * whose region is later rejected or replaced (for example, a tagged-structure
 * table candidate that loses overlap arbitration). The recovered runs re-enter
 * the ordinary prose/heading/list classifier and are marked for diagnostics.
 */
function _recoverUnownedText(regions, textMeta, scale, scaleY, columnSplits, skip, excluded = new Set()) {
    const owned = new Set();
    const visit = region => {
        for (const idx of region?.textItemIndices || []) owned.add(idx);
        for (const child of region?.children || []) visit(child);
        for (const children of Object.values(region?.cellChildren || {})) {
            for (const child of children) visit(child);
        }
    };
    for (const region of regions) visit(region);

    const missing = textMeta.filter(tm => tm.str.trim() && !owned.has(tm.idx) && !excluded.has(tm.idx));
    if (!missing.length || skip.has('PARAGRAPH')) return;

    const splits = [...(columnSplits || [])].sort((a, b) => a - b);
    const buckets = Array.from({ length: splits.length + 1 }, () => []);
    const fullWidth = [];
    for (const tm of missing) {
        const end = tm.vx + (tm.vWidth || 0);
        if (splits.some(x => tm.vx < x && end > x)) {
            fullWidth.push(tm);
            continue;
        }
        let ci = 0;
        while (ci < splits.length && tm.vx >= splits[ci]) ci++;
        buckets[ci].push(tm);
    }

    const added = [];
    const bodyFontSizePt = scale.S / scaleY;
    for (let ci = 0; ci < buckets.length; ci++) {
        if (!buckets[ci].length) continue;
        _classifyBucket(added, _groupByYBand(buckets[ci], scale.yBandTolPx), bodyFontSizePt, scale, ci, skip);
    }
    if (fullWidth.length) {
        _classifyBucket(added, _groupByYBand(fullWidth, scale.yBandTolPx), bodyFontSizePt, scale, -1, skip);
    }
    for (const region of added) {
        region.algorithm = 'lossless-recovery';
        regions.push(region);
    }
}

export function classifyPage(segments, textItems, viewport, pageWidthPt, imageMeta = [], opts = {}) {
    const filledRects  = opts.filledRects  ?? [];
    const fontStyleMap = opts.fontStyleMap ?? {};
    const rawStructTree = opts.structTree  ?? null;
    const OPS           = opts.OPS         ?? null;
    const vpT = viewport.transform;
    const scaleX = Math.hypot(vpT[0], vpT[1]) || 1;
    const scaleY = Math.hypot(vpT[2], vpT[3]) || 1;

    // ── 1. Convert all text items to viewport coordinates ────────────────────
    const textMeta = textItems.map((item, idx) => {
        const t = item.transform;
        const [vx, vy] = toViewport(vpT, t[4], t[5]);
        // Baseline direction in VIEWPORT space, from the item's own advance
        // vector rather than from sign reasoning about the flip: map the origin
        // and origin+advance, and take the angle between them. Unrotated text
        // yields 0 because the viewport transform flips y only.
        const [ax, ay] = toViewport(vpT, t[4] + t[0], t[5] + t[1]);
        const rot = Math.atan2(ay - vy, ax - vx);
        const rotated = Math.abs(rot) > 0.0087;   // ~0.5°
        // Em height is the LENGTH of the matrix's y basis vector, not |d|.
        // For a 90°-rotated run d is 0, so |d| fell through to the 12pt default
        // and every rotated label was sized wrong; hypot(c, d) reduces to |d|
        // exactly when the run is upright, so nothing else moves.
        const fontSizePt = Math.hypot(t[2], t[3]) || 12;
        const widthPt = item.width || (fontSizePt * 0.5 * (item.str?.length || 1));
        const fn = item.fontName || '';
        const fStyle = fontStyleMap[fn];
        // A shear reads as italic only on an upright run — on a rotated one the
        // c term is the ROTATION, and every vertical axis label was being
        // reported italic because of it.
        const syntheticItalic = !rotated && Math.abs(t[2]) > 0.05;
        return {
            idx,
            vx, vy,
            // The item's own text matrix composed with the viewport transform.
            // Everything above it — vx/vy, rot, vFont — is a SCALAR read off
            // this matrix, and each reduction loses something: a sheared run
            // keeps no shear, a non-uniformly scaled run keeps one scale.
            // Placing a label back on the page needs the matrix whole, so the
            // SVG overlay in pageAssembler uses this and not the scalars.
            vm: mulMatrix(vpT, t),
            vWidth: widthPt * scaleX,
            vFont: fontSizePt * scaleY,
            fontSize: fontSizePt,
            fontName: fn,
            str: item.str || '',
            ...(item.paintOpId ? { paintOpId: item.paintOpId, paintOperatorIndex: item.paintOperatorIndex } : {}),
            underlined: false,
            ...(rotated ? { rot } : {}),
            bold:   fStyle?.bold   ?? false,
            italic: fStyle?.italic ?? syntheticItalic,
        };
    });

    const scale = new PageScale(textMeta, viewport, opts.docScale);
    if (opts.headingScale !== undefined) scale.HEADING_SCALE = opts.headingScale;

    // Apply per-page threshold overrides from the Analysis panel sliders.
    // Only the four exposed ratios can be overridden; all other PageScale
    // values (S, vScale, computed getters) remain calibrated to this page.
    const so = opts.pipeline?.scaleOverrides;
    if (so) {
        if (so.R_Y_BAND          !== undefined) scale.R_Y_BAND          = so.R_Y_BAND;
        if (so.R_PARA_GAP        !== undefined) scale.R_PARA_GAP        = so.R_PARA_GAP;
        if (so.R_COL_GAP_MIN     !== undefined) scale.R_COL_GAP_MIN     = so.R_COL_GAP_MIN;
        if (so.STREAM_CONFIDENCE !== undefined) scale.STREAM_CONFIDENCE = so.STREAM_CONFIDENCE;
    }

    const tablePad = opts.tablePad ?? scale.tablePadPx;
    const skip = opts.pipeline?.skip ?? new Set();

    // ── Tier 1: Structure tree (highest fidelity) ─────────────────────────────
    let structTableIndices = new Set();
    let columnHintX = null;

    if (rawStructTree && OPS) {
        try {
            const { structRegions, hasTable, columnHint } = readStructTree(
                rawStructTree, opts._opList ?? null, textMeta, OPS
            );
            if (hasTable && structRegions.length > 0) {
                for (const sr of structRegions) {
                    for (const idx of sr.textItemIndices) structTableIndices.add(idx);
                }
                opts._structRegions = structRegions;
            }
            columnHintX = columnHint ?? null;
        } catch (_) {}
    }

    // ── 2. Classify H-segments: underline vs. table border ───────────────────
    const eps = 4;
    const hSegs = [], vSegs = [];

    for (const s of segments) {
        const dx = Math.abs(s.x2 - s.x1);
        const dy = Math.abs(s.y2 - s.y1);
        if (dy <= eps && dx > eps) hSegs.push(s);
        else if (dx <= eps && dy > eps) vSegs.push(s);
    }

    const underlineSegIds = detectUnderlines(hSegs, textMeta, scale, opts);

    // ── 3. Picture regions ──────────────────────────────────────────────────
    // One detector over ALL ink, raster and vector. A figure is routinely both:
    // masks for its cells and labels, strokes for its frame and arrows. Detected
    // BEFORE lattice so a wiring diagram's runs can't be reconstructed into a
    // bogus table grid; its segments leave the table pool and its labels are
    // claimed for the picture rather than scattered into the paragraph flow.
    const imageBBoxes = imageMeta.map(img => img.bbox);
    const isInsideImage = (x, y) => imageBBoxes.some(b =>
        x >= b.x - 5 && x <= b.x + b.w + 5 &&
        y >= b.y - 5 && y <= b.y + b.h + 5
    );

    const keptImageRegions = (!skip.has('IMAGE'))
        ? detectPictureRegions(imageMeta, segments, textMeta, viewport, scale)
        : [];

    const insideFigure = (x, y) => keptImageRegions.some(f =>
        x >= f.bbox.x - 2 && x <= f.bbox.x + f.bbox.w + 2 &&
        y >= f.bbox.y - 2 && y <= f.bbox.y + f.bbox.h + 2
    );
    const isInsideImageOrFigure = (x, y) => isInsideImage(x, y) || insideFigure(x, y);

    const tableSegs = filterTableSegs(segments, underlineSegIds, isInsideImageOrFigure, viewport);
    const regions = [...keptImageRegions];

    // ── 4. Build PageGraph (shared spatial context) ─────────────────────────
    const pageGraph = PageGraph.build(segments, textMeta, viewport, imageBBoxes, underlineSegIds);

    // ── Custom Override Regions ──────────────────────────────────────────────
    const customRegions = opts.pipeline?.customRegions || [];
    const customInjectedRegions = [];
    const customClaimedTextIndices = new Set();
    const deliberatelyDeletedTextIndices = new Set();

    // ── Deleted region exclusion ──────────────────────────────────────────────
    // skip:true means the user deleted this specific region. Pre-claim its text
    // items so no classifier can pick them up, AND remove its segments from
    // tableSegs so the lattice/stream detectors can't reconstruct a region there.
    // The text items remain in textMeta (unclaimed), so they fall through to
    // _classifyBucket and get re-classified naturally.
    const deleted = customRegions.filter(cr => cr.skip && cr.bbox);
    const deletedBboxes = deleted.map(cr => cr.bbox);
    if (deleted.length) {
        // Same containment rule as _claimCustomText: unpadded, on the glyph-run
        // centre for prose. Padding a deleted line-height box reached into the
        // line below and silently deleted that line too.
        const tablePad = scale.tablePadPx ?? 5;
        for (const tm of textMeta) {
            if (!tm.str.trim()) continue;
            const cx = tm.vx + (tm.vWidth || 0) / 2;
            const hit = deleted.some(cr => _TABLE_TYPES.has(cr.type)
                ? insideBBox(tm.vx, tm.vy, cr.bbox, tablePad)
                : insideBBox(cx, tm.vy, cr.bbox, 0));
            if (hit) {
                customClaimedTextIndices.add(tm.idx);
                deliberatelyDeletedTextIndices.add(tm.idx);
            }
        }
        // Remove segments inside deleted bboxes from tableSegs so lattice/stream
        // detectors can't reconstruct a region over the deleted area.
        const eps2 = 2;
        const filteredTableSegs = tableSegs.filter(s =>
            !deletedBboxes.some(b =>
                insideBBox(s.x1, s.y1, b, eps2) && insideBBox(s.x2, s.y2, b, eps2)
            )
        );
        // Reassign tableSegs for all downstream classifier steps
        tableSegs.length = 0;
        for (const s of filteredTableSegs) tableSegs.push(s);
    }

    // Text claiming is resolved for ALL custom regions up front, not per
    // region in isolation, because two things went wrong when it was not.
    // The padded anchor test let a one-line region reach the next line's
    // baseline, and nothing stopped two regions claiming the same item, so
    // every body line was emitted twice (verified on a two-column paper:
    // each region rendered its own line plus the following one). See
    // _claimCustomText for the containment and tie-break rules.
    // Reconstruct ruled tables BEFORE claiming text: the grid decides how far
    // the table reaches, and text claiming has to agree with it.
    //
    // Reconstruction runs over the WHOLE page's segments, exactly as
    // detectLatticeTables does, and the region then picks the grid it
    // overlaps most. Handing the reconstructor only the segments near the
    // region looks tighter and is wrong: its row/column clustering thresholds
    // are derived from the extent of the segments it is given
    // (scale.clusterYGap(yRange)), so a subset clusters differently from the
    // page. Measured on the ResNet architecture table: the same 24 segments
    // reconstructed to 10 rows x 6 cols inside the full page set and to 2
    // rows x 4 cols on their own — the header strip, and nothing else.
    const customLattices = new Map();
    const customClaimBboxes = new Map();
    const ruledCustoms = customRegions.filter(cr => cr.bbox && !cr.skip &&
        (cr.type === RegionType.LATTICE_TABLE || cr.type === RegionType.TABLE));
    if (ruledCustoms.length) {
        const pageLattices = new LatticeReconstructor(tableSegs, {
            eps: 5, scale, textMeta, pageHeight: viewport.height,
        }).reconstructAll();
        for (const cr of ruledCustoms) {
            const l = _pickLattice(pageLattices, cr.bbox);
            if (!_isUsableLattice(l)) continue;
            customLattices.set(cr, l);
            customClaimBboxes.set(cr, _gridBounds(cr.bbox, l));
        }
    }

    const customTextByRegion = _claimCustomText(customRegions, textMeta, scale, customClaimBboxes);

    for (const cr of customRegions) {
        if (!cr.bbox) continue;
        if (cr.skip) continue;  // already handled above — nothing to inject

        const bbox = cr.bbox;
        const type = cr.type;

        const claimed = customTextByRegion.get(cr) || { textIndices: [], matchedItems: [] };
        const textIndices = claimed.textIndices;
        const matchedItems = claimed.matchedItems;
        for (const idx of textIndices) customClaimedTextIndices.add(idx);

        // Build specific structural properties for tables
        let lattice = null;
        if (type === RegionType.LATTICE_TABLE || type === RegionType.TABLE) {
            lattice = customLattices.get(cr) || null;
            // A reconstruction that yields a single cell is not a table, it is
            // the whole region flattened into one box. That used to be the
            // fallback and it silently destroyed real tables: a 9-row, 30-cell
            // architecture table came back as one row with no cells. Ruled
            // tables whose outer rules the box clips reconstruct to nothing;
            // fall through to the same band/column grid a stream table gets,
            // which reads structure off the text instead of the ink.
            if (!_isUsableLattice(lattice)) {
                lattice = _streamLattice(bbox, matchedItems, scale, tableSegs);
            }
        } else if (type === RegionType.STREAM_TABLE) {
            lattice = _streamLattice(bbox, matchedItems, scale, tableSegs);
        }

        // fontSize / proximityPx / bannerText / captionRegion are read by
        // pageAssembler and were not carried, so an overridden region lost
        // them: every heading fell to <h3> because the h1/h2/h3 choice reads
        // region.fontSize, table cells fell back to the default proximity,
        // and box banners and figure captions disappeared. Measure fontSize
        // off the claimed items when the incoming region has none (a
        // hand-drawn box never does).
        const avgFontSize = cr.fontSize ?? (matchedItems.length
            ? matchedItems.reduce((s, tm) => s + (tm.fontSize || 0), 0) / matchedItems.length
            : undefined);

        customInjectedRegions.push({
            id: cr.id,
            type,
            bbox,
            // yCenter drives reading order and the rendered data-ry. The
            // natural pipeline measures it off the TEXT extent, which sits
            // half a font-height above the bbox midpoint because the bbox is
            // padded by one line's height. Measuring it the same way keeps an
            // overridden region at exactly the position it had; the bbox
            // midpoint shifted every region on the page down a few pixels.
            yCenter: (_TEXT_FLOW_TYPES.has(type) ? _textYCenter(matchedItems) : null)
                ?? cr.yCenter ?? (bbox.y + bbox.h / 2),
            textItemIndices: textIndices,
            // -1 means "full width", and the pipeline reaches it two ways: a
            // bbox that spans columns, or a line-level full-width verdict from
            // _refineFullWidthByLine. An incoming -1 is a real decision and is
            // preserved. Only a region with NO columnIndex at all (drawn by
            // hand, merged, duplicated) gets placed from its bbox below —
            // without that it rendered across a two-column page.
            columnIndex: cr.columnIndex ?? -1,
            _needsColumn: cr.columnIndex == null,
            lattice,
            fontSize: avgFontSize,
            proximityPx: cr.proximityPx,
            bannerText: cr.bannerText ?? null,
            captionRegion: cr.captionRegion ?? null,
            boxRole: cr.boxRole ?? 'generic',
            fillColor: cr.fillColor ?? null,
            listOrdered: cr.listOrdered ?? false,
            algorithm: 'custom-override'
        });
    }

    // Pre-seed assignedTextIndices with items claimed by Tier 1 struct regions and custom regions
    const assignedTextIndices = new Set(structTableIndices);
    for (const idx of customClaimedTextIndices) {
        assignedTextIndices.add(idx);
    }

    // Claim diagram label text: items whose center sits inside a region that
    // contains drawn ink belong to that picture's crop, not to the paragraph
    // flow. Pure raster regions are handled separately below — a scanned page
    // or a full-bleed background is a picture with real body text over it, and
    // must not swallow the page.
    for (const ir of keptImageRegions) {
        if (!ir.vectorFigure) continue;
        for (const tm of textMeta) {
            if (!tm.str.trim() || assignedTextIndices.has(tm.idx)) continue;
            const cx = tm.vx + (tm.vWidth || 0) / 2;
            if (cx >= ir.bbox.x && cx <= ir.bbox.x + ir.bbox.w &&
                tm.vy >= ir.bbox.y && tm.vy <= ir.bbox.y + ir.bbox.h) {
                ir.textItemIndices.push(tm.idx);
                assignedTextIndices.add(tm.idx);
            }
        }
    }

    // Claim text inside INSET raster images the same way. The 4x page-render
    // crop bakes overlapping text into the image pixels, so extracting it
    // again as paragraphs duplicates content at positions where nothing
    // belongs in the flow (chart axis labels, annotated screenshots).
    //
    // Background rasters must NOT claim: design PDFs draw real body text over
    // full-page images, and claiming it would delete the page's content. Two
    // guards, both required:
    //   - geometry: the image is an inset (≤ 35% of page area, not a
    //     near-full-width band)
    //   - content: the image swallows < 40% of the page's unclaimed text
    if (!skip.has('IMAGE') && keptImageRegions.length) {
        const pageArea = viewport.width * viewport.height;
        const totalUnclaimed = textMeta.filter(
            tm => tm.str.trim() && !assignedTextIndices.has(tm.idx)).length;
        // Poster page: text-sparse page dominated by imagery (covers, hero
        // slides). The whole page is one designed unit; its text belongs in
        // the crop. Article pages (real body text over a decorative
        // background) have hundreds of items and must keep their text.
        const POSTER_MAX_ITEMS = 60;
        for (const ir of keptImageRegions) {
            if (ir.vectorFigure) continue;   // already claimed as a diagram above
            const b = ir.bbox;
            const isInset = (b.w * b.h) / pageArea <= 0.35 &&
                !(b.w >= viewport.width * 0.85 && b.h >= viewport.height * 0.5);
            const inside = [];
            for (const tm of textMeta) {
                if (!tm.str.trim() || assignedTextIndices.has(tm.idx)) continue;
                const cx = tm.vx + (tm.vWidth || 0) / 2;
                if (cx >= b.x && cx <= b.x + b.w && tm.vy >= b.y && tm.vy <= b.y + b.h) {
                    inside.push(tm.idx);
                }
            }
            if (!inside.length) continue;
            const posterMode = !isInset &&
                totalUnclaimed <= POSTER_MAX_ITEMS &&
                inside.length >= totalUnclaimed * 0.9;
            if (isInset) {
                // Inset figure: claim its labels unless it would swallow a
                // large share of the page's text (mis-sized bbox safety).
                if (totalUnclaimed > 0 && inside.length / totalUnclaimed >= 0.40) continue;
            } else if (!posterMode) {
                continue;
            }
            for (const idx of inside) {
                ir.textItemIndices.push(idx);
                assignedTextIndices.add(idx);
            }
        }
    }

    // ── 4.5. Container boxes (notices, warnings, callout panels) ─────────────
    // Runs BEFORE the table detectors. A bordered admonition and a bordered
    // table are drawn with the same four segments, so whichever detector went
    // first used to win the page on ordering alone. Containers are one level
    // above tabular structure: they carve the page into areas, and a table is
    // something found INSIDE an area. Resolve the container first, then let the
    // lattice pass reclaim any real grid nested within it.
    let boxRegions = [];
    if (!skip.has('BOX')) {
        boxRegions = detectBoxRegions(hSegs, vSegs, underlineSegIds, textMeta, scale, viewport, regions, filledRects, assignedTextIndices);
        for (const r of boxRegions) regions.push(r);
    }

    // ── 5. Lattice table regions ─────────────────────────────────────────────
    if (!skip.has('LATTICE_TABLE')) {
        const latticeRegions = detectLatticeTables(tableSegs, textMeta, scale, viewport, filledRects, assignedTextIndices, opts, boxRegions, keptImageRegions);
        for (const r of latticeRegions) regions.push(r);
    }

    // ── 6. Additional image regions from opts ───────────────────────────────
    const extraImageRegions = opts.imageRegions || [];
    for (const img of extraImageRegions) {
        regions.push({
            type: RegionType.IMAGE,
            bbox: img,
            yCenter: img.y + img.h / 2,
            textItemIndices: [],
            columnIndex: -1,
        });
    }

    // ── 7. Stream table detection ───────────────────────────────────────────
    const unclaimedMeta = textMeta.filter(
        tm => !assignedTextIndices.has(tm.idx) && tm.str.trim(),
    );
    if (!skip.has('STREAM_TABLE')) {
        // Pre-detect column zones from unclaimed text so the stream detector
        // can run per column zone rather than mixing items from separate columns.
        // This fast pre-pass uses the same detector as step 10 but on unclaimedMeta only.
        let streamColXs = [];
        if (unclaimedMeta.length > 10) {
            const { splits: preSplits } = detectPageColumns(unclaimedMeta, viewport, scale);
            streamColXs = preSplits.map(s => s.x ?? s).filter(x => x > viewport.width * 0.1 && x < viewport.width * 0.9);
        }
        const streamTables = detectStreamTableRegions(unclaimedMeta, scale, regions, tableSegs, pageGraph, streamColXs);
        // A stream (borderless) table's bbox already carries its own row/column
        // slack (rows.js pads a half row-height above/below, cols pads a right
        // extent) built directly from the text that IS the table. tablePad
        // (~0.8x body font size) exists for LATTICE tables, where a drawn
        // border can sit a few px from the text it encloses. Reusing that same
        // generous pad here let a prose line sitting just outside a stream
        // table's tight text-derived bbox still fall inside bbox+tablePad and
        // get claimed as the table's own content — then buildTable's
        // nearest-cell fallback glued it onto whichever edge row was closest.
        // A stream table needs only rounding slack, not border clearance.
        const streamTablePad = Math.min(tablePad, 4);
        for (const lattice of streamTables) {
            if (!lattice?.bbox) continue;
            const bbox = lattice.bbox;
            const tableTextIndices = [];
            for (const tm of unclaimedMeta) {
                if (assignedTextIndices.has(tm.idx)) continue;
                if (insideBBox(tm.vx, tm.vy, bbox, streamTablePad)) {
                    tableTextIndices.push(tm.idx);
                }
            }

            // Content gate before claiming. A numbered procedure or a
            // hanging-indent bullet list has the exact geometric signature the
            // stream detector looks for: a stable marker x, a stable text x,
            // repeated over many row bands. Alignment alone cannot tell that
            // apart from a two-column table, so ask what the text reads like.
            // Only a confident prose verdict demotes; inconclusive blocks keep
            // the table path.
            if (analyzeBlock(tableTextIndices, textMeta, bbox, scale).prose) continue;

            // A single-band candidate is one line of text with wide gaps in it,
            // not a table. Nothing downstream can render a 1-row grid usefully.
            if ((lattice.rows?.length ?? 0) < 3) continue;

            for (const idx of tableTextIndices) assignedTextIndices.add(idx);
            regions.push({
                type: RegionType.STREAM_TABLE,
                bbox,
                yCenter: bbox.y + bbox.h / 2,
                lattice,
                textItemIndices: tableTextIndices,
                columnIndex: -1,
                proximityPx: scale.proximityPx,
            });
        }
    }

    // ── 8. Table interiors ───────────────────────────────────────────────────
    // A grid owns placement, not meaning. Classify every cell as a small
    // document fragment and adopt structural regions (currently boxes) that
    // the earlier container pass found inside it. The assembler can then send
    // headings, paragraphs, lists, boxes and nested tables through the same
    // renderer used at page level instead of flattening a cell to inline text.
    const allTables = regions.filter(r => r &&
        (r.type === RegionType.LATTICE_TABLE || r.type === RegionType.STREAM_TABLE));
    if (allTables.length) {
        _classifyTableInteriors(allTables, regions, textMeta, scale, scaleY, skip);
    }

    // ── 8.5. Box interiors ───────────────────────────────────────────────────
    // A container's contents are a document fragment, not a string. Runs after
    // the table detectors so a grid nested in a panel has already reclaimed its
    // own text; whatever is left gets the same heading/list/paragraph pass the
    // page body gets, and the results become the box's CHILDREN.
    //
    // Read off `regions`, not off `boxRegions`: the lattice detector emits BOX
    // regions too, for a bordered rectangle whose interior ruling turned out
    // not to be a grid. Those are containers by exactly the same argument, and
    // scoping this to the box detector's own output would leave every one of
    // them flat.
    const allBoxes = regions.filter(r => r && r.type === RegionType.BOX);
    for (const table of allTables) {
        for (const children of Object.values(table.cellChildren || {})) {
            for (const child of children) {
                if (child?.type === RegionType.BOX) allBoxes.push(child);
            }
        }
    }
    if (allBoxes.length) {
        _classifyBoxInteriors(allBoxes, regions, textMeta, scale, scaleY, skip);
    }

    // ── 10. Page-level column detection ──────────────────────────────────────
    const remainingMeta = textMeta.filter(
        tm => !assignedTextIndices.has(tm.idx) && tm.str.trim(),
    );

    // Manual splits from the Analysis col-split tool bypass all detection gates.
    // They are injected directly into rawSplits and take priority over everything.
    const manualSplitDefs = opts.pipeline?.manualSplits;
    const vpW0 = viewport.width;
    let rawSplits = (manualSplitDefs?.length)
        ? manualSplitDefs
            .filter(s => s.x > vpW0 * 0.05 && s.x < vpW0 * 0.95)
            .sort((a, b) => a.x - b.x)
            .map(s => ({ x: s.x, leftFraction: s.x / vpW0, rightFraction: 1 - s.x / vpW0 }))
        : [];
    let fullWidthIndices = new Set();

    // If manual splits exist, skip all automatic detection — user's word is final
    if (rawSplits.length) {
        for (const tm of remainingMeta) {
            const itemEnd = tm.vx + (tm.vWidth || 0);
            if (rawSplits.some(sp => tm.vx < sp.x && itemEnd > sp.x)) {
                fullWidthIndices.add(tm.idx);
            }
        }
        // Jump directly to column bucketing — skip geometry + bipartite detection
        const columnSplitsEarly = rawSplits.map(s => s.x);
        _refineFullWidthByLine(remainingMeta, fullWidthIndices, columnSplitsEarly, scale);
        const narrowMeta0 = remainingMeta.filter(tm => !fullWidthIndices.has(tm.idx));
        const fullWidthMeta0 = remainingMeta.filter(tm => fullWidthIndices.has(tm.idx));
        const columnBuckets0 = splitByColumns(narrowMeta0, columnSplitsEarly);
        if (columnSplitsEarly.length > 0) {
            const epsC = 5;
            for (const r of regions) {
                if (r.columnIndex !== -1 || !r.bbox) continue;
                const crossesSplit = columnSplitsEarly.some(sx =>
                    r.bbox.x < sx - epsC && (r.bbox.x + r.bbox.w) > sx + epsC);
                if (r.bbox.w >= viewport.width * 0.65 || crossesSplit) continue;
                const cx = r.bbox.x + r.bbox.w / 2;
                for (let ci = 0; ci <= columnSplitsEarly.length; ci++) {
                    const lo = ci === 0 ? -Infinity : columnSplitsEarly[ci - 1];
                    const hi = ci === columnSplitsEarly.length ? Infinity : columnSplitsEarly[ci];
                    if (cx >= lo && cx < hi) { r.columnIndex = ci; break; }
                }
            }
        }
        const bodyFontSizePt0 = scale.S / scaleY;
        for (let ci = 0; ci < columnBuckets0.length; ci++) {
            const lines = _groupByYBand(columnBuckets0[ci], scale.yBandTolPx);
            _classifyBucket(regions, lines, bodyFontSizePt0, scale, ci, skip);
        }
        if (fullWidthMeta0.length > 0) {
            const lines = _groupByYBand(fullWidthMeta0, scale.yBandTolPx);
            _classifyBucket(regions, lines, bodyFontSizePt0, scale, -1, skip);
        }
        // Divider detection — same post-classification pass as the automatic path
        if (!skip.has('DIVIDER')) {
            // Custom regions are merged in later, so the divider detector cannot
            // see them yet — and a ruled table it cannot see leaves its own row
            // rules looking like standalone dividers. Pass them alongside.
            const dividerRegions0 = detectDividers(hSegs, underlineSegIds, textMeta, scale, viewport, [...regions, ...customInjectedRegions]);
            for (const r of dividerRegions0) regions.push(r);
        }
        // Skip to header/footer detection and return
        if (opts._structRegions?.length) {
            for (const sr of opts._structRegions) {
                for (let i = regions.length - 1; i >= 0; i--) {
                    const r = regions[i];
                    if (!r.bbox || r.fromStructTree) continue;
                    if (r.yCenter >= sr.bbox.y && r.yCenter <= sr.bbox.y + sr.bbox.h &&
                        r.bbox.x >= sr.bbox.x - 10 && (r.bbox.x + r.bbox.w) <= sr.bbox.x + sr.bbox.w + 10) {
                        regions.splice(i, 1);
                    }
                }
                regions.push(sr);
            }
        }
        regions.sort((a, b) => a.yCenter - b.yCenter);
        detectHeadersFooters(regions, textMeta, viewport, scale, filledRects, opts.chromeSigs);
        let finalRegions2 = regions;
        const customRegions2 = opts.pipeline?.customRegions || [];
        if (customRegions2.length > 0) {
            finalRegions2 = regions.filter(r => {
                if (!r.bbox || r.algorithm === 'custom-override') return true;
                return !customRegions2.some(cr => {
                    const cb = cr.bbox;
                    if (!cb) return false;
                    const iw = Math.min(r.bbox.x + r.bbox.w, cb.x + cb.w) - Math.max(r.bbox.x, cb.x);
                    const ih = Math.min(r.bbox.y + r.bbox.h, cb.y + cb.h) - Math.max(r.bbox.y, cb.y);
                    if (iw > 0 && ih > 0) {
                        const area = r.bbox.w * r.bbox.h;
                        return area > 0 && (iw * ih) / area > 0.40;
                    }
                    return false;
                });
            });
            _assignColumnIndex(customInjectedRegions, columnSplitsEarly, viewport);
            for (const cr of customInjectedRegions) finalRegions2.push(cr);
        }
        _recoverUnownedText(finalRegions2, textMeta, scale, scaleY, columnSplitsEarly, skip, deliberatelyDeletedTextIndices);
        finalRegions2.sort((a, b) => a.yCenter - b.yCenter);
        return { regions: _ensureRegionIds(finalRegions2), textMeta, columnSplits: columnSplitsEarly, rawSplits, scale };
    }

    // No manual splits — fall through to automatic detection below

    const nonEmptyMeta = textMeta.filter(tm => tm.str.trim());
    let columnRules = [];
    if (nonEmptyMeta.length > 0 && vSegs.length > 0) {
        const contentTop    = Math.min(...nonEmptyMeta.map(tm => tm.vy - tm.vFont));
        const contentBottom = Math.max(...nonEmptyMeta.map(tm => tm.vy));
        const contentHeight = contentBottom - contentTop;
        const vpW = viewport.width;

        if (contentHeight > 0) {
            columnRules = vSegs.filter(s => {
                const segLen  = Math.abs(s.y2 - s.y1);
                const midX    = (s.x1 + s.x2) / 2;
                return segLen >= contentHeight * 0.60
                    && midX >= vpW * 0.10
                    && midX <= vpW * 0.90;
            });
        }
    }

    if (columnRules.length > 0) {
        const vpW = viewport.width;
        columnRules.sort((a, b) => a.x1 - b.x1);
        for (const s of columnRules) {
            const midX = (s.x1 + s.x2) / 2;
            rawSplits.push({
                x: midX,
                leftFraction:  midX / vpW,
                rightFraction: (vpW - midX) / vpW,
            });
        }
        for (const tm of remainingMeta) {
            const itemEnd = tm.vx + (tm.vWidth || 0);
            const bridgesAny = rawSplits.some(sp => tm.vx < sp.x && itemEnd > sp.x);
            if (bridgesAny) fullWidthIndices.add(tm.idx);
        }
    } else if (columnHintX !== null) {
        const vpW = viewport.width;
        rawSplits = [{
            x: columnHintX,
            leftFraction:  columnHintX / vpW,
            rightFraction: (vpW - columnHintX) / vpW,
        }];
        fullWidthIndices = new Set();
        for (const tm of remainingMeta) {
            const itemEnd = tm.vx + (tm.vWidth || 0);
            if (tm.vx < columnHintX && itemEnd > columnHintX) fullWidthIndices.add(tm.idx);
        }
    } else {
        const bipartite = detectPageColumns(remainingMeta, viewport, scale);
        rawSplits = bipartite.splits;
        fullWidthIndices = bipartite.fullWidthIndices;
    }

    if (rawSplits.length === 0 && columnRules.length === 0) {
        const allNonEmpty = textMeta.filter(tm => tm.str.trim());
        if (allNonEmpty.length > remainingMeta.length + 4) {
            const { splits: fallbackSplits } = detectPageColumns(allNonEmpty, viewport, scale);
            rawSplits.push(...fallbackSplits);
        }
    }

    // Snap each detected split to the center of the actual coverage gap
    // (the gutter) near it. Detection can land the split coordinate inside a
    // column's ragged-right zone, which makes ordinary body lines "straddle"
    // the split and fall out of their column (N19 p1: split 566 vs true
    // gutter center 598 — every left-column line ending at 581 went
    // full-width). Snapping is bounded to ±3S so it can only correct
    // locally, never invent a different layout.
    for (const sp of rawSplits) {
        const snapped = _snapSplitToGutter(sp.x, remainingMeta, viewport, scale);
        if (snapped !== sp.x) {
            sp.x = snapped;
            sp.leftFraction = snapped / viewport.width;
            sp.rightFraction = 1 - sp.leftFraction;
        }
    }
    const columnSplits = rawSplits.map(s => s.x);

    _refineFullWidthByLine(remainingMeta, fullWidthIndices, columnSplits, scale);

    const narrowMeta = remainingMeta.filter(tm => !fullWidthIndices.has(tm.idx));
    const fullWidthMeta = remainingMeta.filter(tm => fullWidthIndices.has(tm.idx));

    const columnBuckets = splitByColumns(narrowMeta, columnSplits);

    if (columnSplits.length > 0) {
        const vw = viewport.width;
        const epsC = 5;
        for (const r of regions) {
            if (r.columnIndex !== -1 || !r.bbox) continue;
            const crossesSplit = columnSplits.some(sx => r.bbox.x < sx - epsC && (r.bbox.x + r.bbox.w) > sx + epsC);
            if (r.bbox.w >= vw * 0.65 || crossesSplit) continue;
            const cx = r.bbox.x + r.bbox.w / 2;
            for (let ci = 0; ci <= columnSplits.length; ci++) {
                const lo = ci === 0 ? -Infinity : columnSplits[ci - 1];
                const hi = ci === columnSplits.length ? Infinity : columnSplits[ci];
                if (cx >= lo && cx < hi) { r.columnIndex = ci; break; }
            }
        }
    }

    // ── 11. Classify remaining text by column ────────────────────────────────
    const bodyFontSizePt = scale.S / scaleY;

    for (let ci = 0; ci < columnBuckets.length; ci++) {
        const lines = _groupByYBand(columnBuckets[ci], scale.yBandTolPx);
        _classifyBucket(regions, lines, bodyFontSizePt, scale, ci, skip);
    }

    if (fullWidthMeta.length > 0) {
        const lines = _groupByYBand(fullWidthMeta, scale.yBandTolPx);
        _classifyBucket(regions, lines, bodyFontSizePt, scale, -1, skip);
    }

    // ── 11.5. Divider detection — runs AFTER text classification so paragraph/
    //         heading/list regions are present and the bbox-containment guard works.
    if (!skip.has('DIVIDER')) {
        // Custom regions are merged in later, so the divider detector cannot
        // see them yet — and a ruled table it cannot see leaves its own row
        // rules looking like standalone dividers. Pass them alongside.
        const dividerRegions = detectDividers(hSegs, underlineSegIds, textMeta, scale, viewport, [...regions, ...customInjectedRegions]);
        for (const r of dividerRegions) regions.push(r);
    }

    // ── 12. Merge Tier 1 struct regions ─────────────────────────────────────
    if (opts._structRegions?.length) {
        for (const sr of opts._structRegions) {
            for (let i = regions.length - 1; i >= 0; i--) {
                const r = regions[i];
                if (!r.bbox || r.fromStructTree) continue;
                if (r.yCenter >= sr.bbox.y && r.yCenter <= sr.bbox.y + sr.bbox.h &&
                    r.bbox.x >= sr.bbox.x - 10 && (r.bbox.x + r.bbox.w) <= sr.bbox.x + sr.bbox.w + 10) {
                    regions.splice(i, 1);
                }
            }
            regions.push(sr);
        }
    }

    // ── 12.5. Overlap filtering and Custom Region Injection ─────────────────
    let finalRegions = regions;
    if (customRegions.length > 0) {
        finalRegions = regions.filter(r => {
            if (!r.bbox || r.algorithm === 'custom-override') return true;
            return !customRegions.some(cr => {
                const cb = cr.bbox;
                if (!cb) return false;
                const iw = Math.min(r.bbox.x + r.bbox.w, cb.x + cb.w) - Math.max(r.bbox.x, cb.x);
                const ih = Math.min(r.bbox.y + r.bbox.h, cb.y + cb.h) - Math.max(r.bbox.y, cb.y);
                if (iw > 0 && ih > 0) {
                    const area = r.bbox.w * r.bbox.h;
                    return area > 0 && (iw * ih) / area > 0.40; // 40% overlap threshold
                }
                return false;
            });
        });
        // Injected regions are not in `regions` when the column pass above
        // runs, so they never got placed and stayed at -1 (= full width).
        _assignColumnIndex(customInjectedRegions, columnSplits, viewport);
        for (const cr of customInjectedRegions) {
            finalRegions.push(cr);
        }
    }

    // ── 12.8. Lossless ownership recovery ──────────────────────────────────
    _recoverUnownedText(finalRegions, textMeta, scale, scaleY, columnSplits, skip, deliberatelyDeletedTextIndices);

    // ── 13. Sort all regions top→bottom ─────────────────────────────────────
    finalRegions.sort((a, b) => a.yCenter - b.yCenter);

    // ── 14. Header / Footer detection ───────────────────────────────────────
    detectHeadersFooters(finalRegions, textMeta, viewport, scale, filledRects, opts.chromeSigs);

    // ── 14.2. Rejoin split display equations ────────────────────────────────
    // After the sort, so adjacency is reading order, and before the reference
    // pass, so a rejoined equation is never a bibliography candidate.
    if (!skip.has('MATH')) {
        finalRegions = mergeMathRegions(finalRegions, textItems, textMeta, scale);
    }

    // ── 14.5. Bibliography detection ────────────────────────────────────────
    // Runs last, on typed regions: a reference block is a PARAGRAPH to every
    // geometric test, so the only thing left to read is its text.
    if (!skip.has('REFERENCE')) detectReferences(finalRegions, textMeta);

    // columnSplits returned as plain X array (what pageAssembler expects).
    // rawSplits carries the full {x, leftFraction, rightFraction} objects for
    // callers that need the fractions (geometryWorker postMessage, zone layout).
    return { regions: _ensureRegionIds(finalRegions), textMeta, columnSplits: rawSplits.map(s => s.x), rawSplits, scale };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// Snap a column split X to the center of the widest uncovered interval
// (the real gutter) within ±3S of the candidate. Items wider than 40% of
// the viewport (titles, full-width lines) are excluded from coverage — they
// legitimately span the gutter and would otherwise mask it. Returns the
// original x when no plausible gap (≥ 0.75S wide) exists in the window.
function _snapSplitToGutter(splitX, meta, viewport, scale) {
    const win = scale.S * 3;
    const lo = splitX - win, hi = splitX + win;
    const wideCap = viewport.width * 0.40;
    const iv = [];
    for (const tm of meta) {
        const w = tm.vWidth || 0;
        if (w > wideCap) continue;
        const s = tm.vx, e = tm.vx + w;
        if (e <= lo || s >= hi) continue;
        iv.push([Math.max(s, lo), Math.min(e, hi)]);
    }
    if (!iv.length) return splitX;
    // Minimum-crossings scan. A pure empty-gap search fails whenever a
    // header/footer/title line runs through the page center, so instead
    // count how many items cover each x; full-window spanners add a
    // constant everywhere and cancel out of the argmin. The widest run of
    // minimal coverage is the gutter.
    const STEP = 2;
    const n = Math.floor((hi - lo) / STEP) + 1;
    const counts = new Array(n).fill(0);
    for (const [s, e] of iv) {
        const i0 = Math.max(0, Math.ceil((s - lo) / STEP));
        const i1 = Math.min(n - 1, Math.floor((e - lo) / STEP));
        for (let i = i0; i <= i1; i++) counts[i]++;
    }
    const minC = Math.min(...counts);
    // The gutter is a valley, not necessarily an empty channel — a title or
    // footer line crossing the page center adds 1 everywhere near minC. Take
    // the widest run within a small slack of the minimum; heavy flanks
    // (column body text) sit far above it and bound the run.
    const thr = minC + Math.max(2, Math.ceil(minC * 0.5));
    let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
    for (let i = 0; i <= n; i++) {
        if (i < n && counts[i] <= thr) {
            if (curStart === -1) curStart = i;
            curLen++;
        } else {
            if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
            curStart = -1; curLen = 0;
        }
    }
    // The run must be a real channel (≥ 0.75S wide) and interior to the
    // window — a run touching the edge is unbounded evidence.
    if (bestLen * STEP < scale.S * 0.75) return splitX;
    if (bestStart === 0 || bestStart + bestLen >= n) return splitX;
    return lo + (bestStart + bestLen / 2) * STEP;
}

// Refine which items stay full-width once column splits are known.
//
// Two rules layered on the raw full-width set (wide bands / straddlers):
//  (a) Heading-scale items straddling a split are full-width — centered
//      titles cross the gutter but must never be bucketed into a column.
//      Body-size straddlers are left alone: gutter-bridging equation items
//      belong to their column's flow (raiko-aistats lesson).
//  (b) The fits-in-one-column removal works line-wise, not item-wise: an
//      item that fits a column but is x-contiguous with a kept full-width
//      item on the same baseline is the same visual line ({email}@domain,
//      centered author rows) and stays full-width with it. Clean column
//      bands have no kept anchor, so every item is removed exactly as before.
function _refineFullWidthByLine(remainingMeta, fullWidthIndices, columnSplits, scale) {
    if (!columnSplits.length) return;
    const tol = scale.proximityPx ?? 5;
    const boundaries = [-Infinity, ...columnSplits, Infinity];

    const headingFloor = scale.S * scale.HEADING_SCALE;
    for (const tm of remainingMeta) {
        if (fullWidthIndices.has(tm.idx)) continue;
        const itemEnd = tm.vx + (tm.vWidth || 0);
        if ((tm.vFont || 0) >= headingFloor &&
            columnSplits.some(sx => tm.vx < sx - tol && itemEnd > sx + tol)) {
            fullWidthIndices.add(tm.idx);
        }
    }

    const fits = tm => {
        const itemEnd = tm.vx + (tm.vWidth || 0);
        return boundaries.slice(0, -1).some((lo, ci) =>
            tm.vx >= lo - tol && itemEnd <= boundaries[ci + 1] + tol);
    };

    const fwMeta = remainingMeta.filter(tm => fullWidthIndices.has(tm.idx));
    const bands = [];
    for (const tm of [...fwMeta].sort((a, b) => a.vy - b.vy)) {
        let band = bands.find(b => Math.abs(b.y - tm.vy) <= scale.yBandTolPx);
        if (!band) { band = { y: tm.vy, items: [] }; bands.push(band); }
        band.y = (band.y * band.items.length + tm.vy) / (band.items.length + 1);
        band.items.push(tm);
    }

    const joinGap = scale.S * 2;
    for (const band of bands) {
        const items = band.items.sort((a, b) => a.vx - b.vx);
        const keep = items.map(tm => !fits(tm));
        for (let i = 1; i < items.length; i++) {
            if (keep[i] || !keep[i - 1]) continue;
            const gap = items[i].vx - (items[i - 1].vx + (items[i - 1].vWidth || 0));
            if (gap <= joinGap) keep[i] = true;
        }
        for (let i = items.length - 2; i >= 0; i--) {
            if (keep[i] || !keep[i + 1]) continue;
            const gap = items[i + 1].vx - (items[i].vx + (items[i].vWidth || 0));
            if (gap <= joinGap) keep[i] = true;
        }
        for (let i = 0; i < items.length; i++) {
            if (!keep[i]) fullWidthIndices.delete(items[i].idx);
        }
    }
}

/**
 * Give every BOX region a structured interior.
 *
 * The bug this exists to fix: a box claimed all the text inside it in one flat
 * `textItemIndices`, and every later pass skips claimed items — so the headings,
 * bullets and paragraph breaks inside a callout were never classified at all.
 * The renderer had nothing but a bag of runs to work with and emitted the panel
 * as one undifferentiated block, however the source had set it.
 *
 * The rule is: extract what is in the box exactly as if the box were not there,
 * THEN wrap the box around the result. The border decides where the container
 * is, never what the contents are.
 *
 * Two kinds of child are collected:
 *
 *   - Tables the lattice/stream detectors already built inside this bbox. They
 *     were pushed as page-level siblings, which renders a nested table BESIDE
 *     the panel that contains it; adopting them puts them back inside.
 *   - Everything else, through the same `_classifyBucket` the page body uses.
 *
 * The banner label ("! WARNING") is lifted out first. It is a header, not a
 * line of the body, and leaving it in would make it the box's first heading.
 */
function _classifyBoxInteriors(boxRegions, regions, textMeta, scale, scaleY, skip) {
    const bodyFontSizePt = scale.S / scaleY;
    const pad = scale.proximityPx ?? 4;

    for (const box of boxRegions) {
        if (!box.bbox) continue;
        const children = [];
        const adoptedText = new Set();

        for (let i = regions.length - 1; i >= 0; i--) {
            const r = regions[i];
            if (r === box || !r.bbox) continue;
            if (r.type !== RegionType.LATTICE_TABLE && r.type !== RegionType.STREAM_TABLE &&
                r.type !== RegionType.BOX) continue;
            if (!_bboxWithin(r.bbox, box.bbox, pad)) continue;
            children.push(r);
            for (const idx of (r.textItemIndices || [])) adoptedText.add(idx);
            regions.splice(i, 1);
        }

        _liftBoxBanner(box, textMeta);

        const items = (box.textItemIndices || [])
            .filter(i => !adoptedText.has(i))
            .map(i => textMeta[i])
            .filter(tm => tm && tm.str.trim());
        if (items.length) {
            // columnIndex -1: a box is its own layout context, and its children
            // must never be handed to the page's column assignment — a
            // two-column page would otherwise scatter one panel's lines across
            // both of its columns.
            const lines = _groupByYBand(items, scale.yBandTolPx);
            _classifyBucket(children, lines, bodyFontSizePt, scale, -1, skip);
        }

        if (!children.length) continue;
        children.sort((a, b) => (a.bbox?.y ?? 0) - (b.bbox?.y ?? 0) ||
                                (a.bbox?.x ?? 0) - (b.bbox?.x ?? 0));
        box.children = children;
    }
}

/**
 * Treat each table cell as its own layout context.
 *
 * `embeddedRegions` are structures detected before the table (most commonly a
 * prose BOX that is actually a richly formatted cell). They are removed from
 * the page-level region list and placed in the cell that contains their centre.
 * Remaining text is classified with the normal heading/list/paragraph bucket.
 */
function _classifyTableInteriors(tableRegions, regions, textMeta, scale, scaleY, skip) {
    const bodyFontSizePt = scale.S / scaleY;

    for (const table of tableRegions) {
        const rows = table.lattice?.rows;
        const cols = table.lattice?.cols;
        if (!rows || rows.length < 2 || !cols || cols.length < 2) continue;

        const byCell = new Map();
        const embeddedText = new Set();
        const cellAt = (x, y) => {
            let ri = -1, ci = -1;
            for (let r = 0; r + 1 < rows.length; r++) {
                if (y >= rows[r] && y <= rows[r + 1]) { ri = r; break; }
            }
            for (let c = 0; c + 1 < cols.length; c++) {
                if (x >= cols[c] && x <= cols[c + 1]) { ci = c; break; }
            }
            return ri >= 0 && ci >= 0 ? `${ri}:${ci}` : null;
        };
        const push = (key, child) => {
            if (!key) return;
            if (!byCell.has(key)) byCell.set(key, []);
            byCell.get(key).push(child);
        };

        for (const child of (table.embeddedRegions || [])) {
            if (!child?.bbox) continue;
            const key = cellAt(child.bbox.x + child.bbox.w / 2,
                child.bbox.y + child.bbox.h / 2);
            if (!key) continue;
            push(key, child);
            for (const idx of (child.textItemIndices || [])) embeddedText.add(idx);
            const at = regions.indexOf(child);
            if (at >= 0) regions.splice(at, 1);
        }

        const textByCell = new Map();
        for (const idx of (table.textItemIndices || [])) {
            if (embeddedText.has(idx)) continue;
            const tm = textMeta[idx];
            if (!tm?.str?.trim()) continue;
            const key = cellAt(tm.vx, tm.vy);
            if (!key) continue;
            if (!textByCell.has(key)) textByCell.set(key, []);
            textByCell.get(key).push(tm);
        }

        for (const [key, items] of textByCell) {
            const children = byCell.get(key) || [];
            const lines = _groupByYBand(items, scale.yBandTolPx);
            _classifyBucket(children, lines, bodyFontSizePt, scale, -1, skip);
            byCell.set(key, children);
        }

        if (byCell.size) {
            table.cellChildren = Object.fromEntries([...byCell].map(([key, children]) => {
                children.sort((a, b) => (a.bbox?.y ?? 0) - (b.bbox?.y ?? 0) ||
                                        (a.bbox?.x ?? 0) - (b.bbox?.x ?? 0));
                return [key, children];
            }));
        }
        delete table.embeddedRegions;
    }
}

/** True when `inner` sits inside `outer`, allowing `pad` of slop on each side. */
function _bboxWithin(inner, outer, pad) {
    return inner.x >= outer.x - pad &&
        inner.y >= outer.y - pad &&
        inner.x + inner.w <= outer.x + outer.w + pad &&
        inner.y + inner.h <= outer.y + outer.h + pad;
}

/**
 * Split an in-box banner label off the body text and record it on the region.
 *
 * When the styled "! WARNING" bar shares one bordered rectangle with the body
 * (the right-column admonition layout), the label lives in the box's topmost
 * items at a much larger font. Left in the flow it renders as oversized inline
 * text — and now that the interior is classified, it would also be promoted to
 * a heading, which is worse: a header would become part of the content.
 *
 * A region that already carries `bannerText` came from the banner/body merge in
 * boxDetector and has nothing to lift.
 *
 * The size threshold is the box's OWN median font, never the page's: on a
 * figure-heavy page the mode font IS the callout labels, and comparing against
 * it rejects every banner on the page.
 */
function _liftBoxBanner(box, textMeta) {
    if (box.bannerText) return;
    if (!box.boxRole || box.boxRole === 'generic') return;
    const idxs = box.textItemIndices || [];
    if (!idxs.length) return;

    const meta = idxs.map(i => textMeta[i]).filter(Boolean);
    if (!meta.length) return;
    const fonts = meta.map(m => m.vFont || 0).filter(Boolean).sort((a, b) => a - b);
    const medFont = fonts[Math.floor(fonts.length / 2)] || 0;
    if (!medFont) return;
    const topY = Math.min(...meta.map(m => m.vy));

    const bannerIdx = new Set();
    const labelParts = [];
    for (const m of meta) {
        if (m.vy > topY + medFont * 0.8) continue;
        if ((m.vFont || 0) < medFont * 1.5) continue;
        bannerIdx.add(m.idx);
        if (/[A-Za-z]/.test(m.str)) labelParts.push(m.str.trim());
    }
    const label = labelParts.join(' ').toUpperCase();
    if (!bannerIdx.size) return;
    if (!/\b(WARNING|CAUTION|DANGER|NOTICE|NOTE|IMPORTANT)\b/.test(label)) return;

    box.bannerText = label;
    box.textItemIndices = idxs.filter(i => !bannerIdx.has(i));
}

function _classifyBucket(regions, lines, bodyFontSizePt, scale, columnIndex, skip = new Set()) {
    let currentBlock = [];
    let currentType = null;
    let lastMarkerX = null; // left edge of the most recent list-marker line

    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const lineStr = line.items.map(tm => tm.str.trim()).join(' ').trim();
        if (!lineStr) continue;

        let lineType;
        const headingType = classifyHeading(line, bodyFontSizePt, scale);
        const listResult  = classifyList(line, bodyFontSizePt, scale);

        // When a type is skipped, demote it to PARAGRAPH so items stay in the
        // text flow instead of disappearing (they just won't be classified)
        if (headingType && !skip.has('HEADING')) {
            lineType = headingType;
        } else if (listResult && !skip.has('LIST')) {
            lineType = listResult.type;
            lastMarkerX = Math.min(...line.items.map(t => t.vx));
        } else {
            if (skip.has('PARAGRAPH')) continue; // skip means omit from output
            lineType = RegionType.PARAGRAPH;

            // Wrapped list-item continuation: an unmarked line directly under a
            // LIST block, indented past the marker column, belongs to the same
            // list item — keep it in the LIST block instead of splitting a new
            // paragraph region between every marker line. Compared against the
            // marker line's X (not the previous line's) so multi-line wraps hold.
            if (currentType === RegionType.LIST && !skip.has('LIST') &&
                currentBlock.length && lastMarkerX !== null) {
                const thisX = Math.min(...line.items.map(t => t.vx));
                const closeGap = li > 0 && Math.abs(line.y - lines[li - 1].y) <= scale.paraGapPx;
                if (closeGap && thisX > lastMarkerX + scale.S * 0.4) {
                    lineType = RegionType.LIST;
                }
            }
        }

        const hasGap = li > 0 && Math.abs(line.y - lines[li - 1].y) > scale.paraGapPx;

        if (currentType !== null && (lineType !== currentType || hasGap)) {
            _flushBlock(regions, currentBlock, currentType, columnIndex);
            currentBlock = [];
        }

        currentType = lineType;
        currentBlock.push(line);
    }

    if (currentBlock.length) {
        _flushBlock(regions, currentBlock, currentType, columnIndex);
    }
}

function _flushBlock(regions, lines, type, columnIndex = -1) {
    if (!lines.length) return;

    const allIndices = lines.flatMap(l => l.items.map(tm => tm.idx));
    const allItems = lines.flatMap(l => l.items);

    let yMin = Infinity, yMax = -Infinity, xMin = Infinity, xMax = -Infinity;
    for (const tm of allItems) {
        if (tm.vy < yMin) yMin = tm.vy;
        if (tm.vy > yMax) yMax = tm.vy;
        if (tm.vx < xMin) xMin = tm.vx;
        if (tm.vx + tm.vWidth > xMax) xMax = tm.vx + tm.vWidth;
    }

    const avgFontSize = allItems.reduce((s, tm) => s + tm.fontSize, 0) / allItems.length;
    const avgFontVp = allItems.reduce((s, tm) => s + tm.vFont, 0) / allItems.length;

    regions.push({
        type,
        bbox: { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin + avgFontVp },
        yCenter: (yMin + yMax) / 2,
        textItemIndices: allIndices,
        fontSize: avgFontSize,
        columnIndex,
        listOrdered: type === RegionType.LIST
            ? _ORDERED_RE.test(lines[0].items.map(tm => tm.str.trim()).join(' '))
            : undefined,
    });
}

function _groupByYBand(items, yTol) {
    const sorted = [...items].sort((a, b) => a.vy - b.vy);
    const lines = [];

    for (const tm of sorted) {
        let band = null;
        for (const l of lines) {
            if (Math.abs(l.y - tm.vy) <= yTol) { band = l; break; }
        }
        if (band) {
            const n = band.items.length;
            band.y = (band.y * n + tm.vy) / (n + 1);
            band.items.push(tm);
        } else {
            lines.push({ y: tm.vy, items: [tm] });
        }
    }

    for (const l of lines) l.items.sort((a, b) => a.vx - b.vx);
    lines.sort((a, b) => a.y - b.y);
    return lines;
}

export function detectZoneColumns(zoneTextMeta, viewport, scale) {
    if (!zoneTextMeta.length) return { splits: [] };

    const ys = zoneTextMeta.map(tm => tm.vy);
    const zoneHeight = Math.max(...ys) - Math.min(...ys);
    const MIN_ZONE_HEIGHT = scale.S * 1.4 * 10;
    const dropGate3 = zoneHeight >= MIN_ZONE_HEIGHT;

    return detectPageColumns(zoneTextMeta, viewport, scale, { dropGate3 });
}

function _mean(arr) {
    return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

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
