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
import { detectImageRegions, filterTableSegs } from './classifiers/imageRegionDetector.js';
import { detectLatticeTables } from './classifiers/latticeDetector.js';
import { detectStreamTableRegions } from './classifiers/streamTableDetector.js';
import { detectBoxRegions } from './classifiers/boxDetector.js';
import { detectDividers } from './classifiers/dividerDetector.js';
import { detectHeadersFooters } from './classifiers/headerFooterDetector.js';
import { classifyHeading } from './classifiers/headingDetector.js';
import { classifyList, BULLET_RE as _BULLET_RE, ORDERED_RE as _ORDERED_RE } from './classifiers/listDetector.js';
import { RegionType } from './classifiers/regionTypes.js';

export { detectPageColumns, splitByColumns } from './classifiers/columnSplitDetector.js';
export { RegionType } from './classifiers/regionTypes.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toViewport(vpTransform, pdfX, pdfY) {
    return [
        vpTransform[0] * pdfX + vpTransform[2] * pdfY + vpTransform[4],
        vpTransform[1] * pdfX + vpTransform[3] * pdfY + vpTransform[5],
    ];
}

function insideBBox(px, py, bbox, pad = 0) {
    return px >= bbox.x - pad && px <= bbox.x + bbox.w + pad &&
        py >= bbox.y - pad && py <= bbox.y + bbox.h + pad;
}

// ── Public API ────────────────────────────────────────────────────────────────

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
        const [vx, vy] = toViewport(vpT, item.transform[4], item.transform[5]);
        const fontSizePt = Math.abs(item.transform?.[3] || 12);
        const widthPt = item.width || (fontSizePt * 0.5 * (item.str?.length || 1));
        const fn = item.fontName || '';
        const fStyle = fontStyleMap[fn];
        const syntheticItalic = Math.abs(item.transform[2]) > 0.05;
        return {
            idx,
            vx, vy,
            vWidth: widthPt * scaleX,
            vFont: fontSizePt * scaleY,
            fontSize: fontSizePt,
            fontName: fn,
            str: item.str || '',
            underlined: false,
            bold:   fStyle?.bold   ?? false,
            italic: fStyle?.italic ?? syntheticItalic,
        };
    });

    const scale = new PageScale(textMeta, viewport);
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

    // ── 3. Image regions + filtered segments ────────────────────────────────
    const { regions: imageRegions, imageBBoxes, isInsideImage } = detectImageRegions(imageMeta);
    const tableSegs = filterTableSegs(segments, underlineSegIds, isInsideImage);
    const regions = [...imageRegions];

    // ── 4. Build PageGraph (shared spatial context) ─────────────────────────
    const pageGraph = PageGraph.build(segments, textMeta, viewport, imageBBoxes, underlineSegIds);

    // Pre-seed assignedTextIndices with items claimed by Tier 1 struct regions
    const assignedTextIndices = new Set(structTableIndices);
    const skip = opts.pipeline?.skip ?? new Set();

    // ── 5. Lattice table regions ─────────────────────────────────────────────
    if (!skip.has('LATTICE_TABLE')) {
        const latticeRegions = detectLatticeTables(tableSegs, textMeta, scale, viewport, filledRects, assignedTextIndices, opts);
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
        const streamTables = detectStreamTableRegions(unclaimedMeta, scale, regions, tableSegs, pageGraph);
        for (const lattice of streamTables) {
            if (!lattice?.bbox) continue;
            const bbox = lattice.bbox;
            const tableTextIndices = [];
            for (const tm of unclaimedMeta) {
                if (assignedTextIndices.has(tm.idx)) continue;
                if (insideBBox(tm.vx, tm.vy, bbox, tablePad)) {
                    tableTextIndices.push(tm.idx);
                    assignedTextIndices.add(tm.idx);
                }
            }
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

    // ── 8. Isolated-rectangle box detection ─────────────────────────────────
    if (!skip.has('BOX')) {
        const boxRegions = detectBoxRegions(hSegs, vSegs, underlineSegIds, textMeta, scale, viewport, regions, filledRects, assignedTextIndices);
        for (const r of boxRegions) regions.push(r);
    }

    // ── 10. Page-level column detection ──────────────────────────────────────
    const remainingMeta = textMeta.filter(
        tm => !assignedTextIndices.has(tm.idx) && tm.str.trim(),
    );

    let rawSplits = [];
    let fullWidthIndices = new Set();

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

    const columnSplits = rawSplits.map(s => s.x);

    if (columnSplits.length > 0) {
        const tol = scale.proximityPx ?? 5;
        const boundaries = [-Infinity, ...columnSplits, Infinity];
        for (const idx of [...fullWidthIndices]) {
            const tm = textMeta[idx];
            if (!tm) continue;
            const itemEnd = tm.vx + (tm.vWidth || 0);

            const fitsInOneColumn = boundaries.slice(0, -1).some((lo, ci) => {
                const hi = boundaries[ci + 1];
                return tm.vx >= lo - tol && itemEnd <= hi + tol;
            });

            if (fitsInOneColumn) fullWidthIndices.delete(idx);
        }
    }

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
        const dividerRegions = detectDividers(hSegs, underlineSegIds, textMeta, scale, viewport, regions);
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

    // ── 13. Sort all regions top→bottom ─────────────────────────────────────
    regions.sort((a, b) => a.yCenter - b.yCenter);

    // ── 14. Header / Footer detection ───────────────────────────────────────
    detectHeadersFooters(regions, textMeta, viewport, scale, filledRects);

    // columnSplits returned as plain X array (what pageAssembler expects).
    // rawSplits carries the full {x, leftFraction, rightFraction} objects for
    // callers that need the fractions (geometryWorker postMessage, zone layout).
    return { regions, textMeta, columnSplits: rawSplits.map(s => s.x), rawSplits, scale };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _classifyBucket(regions, lines, bodyFontSizePt, scale, columnIndex, skip = new Set()) {
    let currentBlock = [];
    let currentType = null;

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
        } else {
            if (skip.has('PARAGRAPH')) continue; // skip means omit from output
            lineType = RegionType.PARAGRAPH;
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
