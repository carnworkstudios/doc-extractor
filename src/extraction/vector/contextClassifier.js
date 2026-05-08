// contextClassifier.js
// Region-classification engine for context-aware PDF extraction.
//
// Takes the raw page inventory (segments, text items, images) and produces
// a sorted list of typed, spatially-bounded regions. Each region knows
// what it is (TABLE, PARAGRAPH, HEADING, LIST, IMAGE) and carries only the
// segments and text items that belong to it.
//
// Key algorithms:
//   1. Underline detection    — KD-tree proximity between H-segments and text baselines
//   2. Table region detection — lattice bboxes scope segments + text items
//   3. Heading detection      — font size > 1.25× body average
//   4. List detection         — lines starting with bullet/number patterns
//   5. Column detection       — page-level left/right split via coverage gaps
//   6. Paragraph detection    — remaining text grouped by Y-band
//
// Safe to run inside a Web Worker.

import { LatticeReconstructor } from './latticeReconstructor.js';

// ── Region types ─────────────────────────────────────────────────────────────

export const RegionType = {
    TABLE:     'TABLE',
    PARAGRAPH: 'PARAGRAPH',
    HEADING:   'HEADING',
    LIST:      'LIST',
    IMAGE:     'IMAGE',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Transform a PDF user-space point to viewport space.
 */
function toViewport(vpTransform, pdfX, pdfY) {
    return [
        vpTransform[0] * pdfX + vpTransform[2] * pdfY + vpTransform[4],
        vpTransform[1] * pdfX + vpTransform[3] * pdfY + vpTransform[5],
    ];
}

/**
 * Check if a point (px, py) is inside a bbox with optional padding.
 */
function insideBBox(px, py, bbox, pad = 0) {
    return px >= bbox.x - pad && px <= bbox.x + bbox.w + pad &&
           py >= bbox.y - pad && py <= bbox.y + bbox.h + pad;
}

/**
 * Compute the average "body" font size from text items.
 * Uses the median to be robust against headings / footnotes.
 */
function computeBodyFontSize(items) {
    const sizes = items
        .filter(i => i.str?.trim())
        .map(i => Math.abs(i.transform?.[3] || i.height || 12));
    if (!sizes.length) return 12;
    sizes.sort((a, b) => a - b);
    return sizes[Math.floor(sizes.length / 2)]; // median
}

// Bullet / numbered-list patterns
const BULLET_RE = /^[\u2022\u2023\u25E6\u25AA\u25AB\u2013\u2014\u2015•–—·○◦◉▪▫-]\s/;
const ORDERED_RE = /^(?:\d{1,3}[.)]\s|[a-zA-Z][.)]\s|[ivxIVX]+[.)]\s)/;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify a single page into typed regions.
 *
 * @param {PathSegment[]}  segments    — from ctmAdapter
 * @param {TextItem[]}     textItems   — from page.getTextContent().items
 * @param {object}         viewport    — { width, height, transform }
 * @param {number}         pageWidthPt — page width in PDF points
 * @param {object}         [opts]      — classification options
 * @returns {PageRegion[]}  sorted top→bottom
 */
export function classifyPage(segments, textItems, viewport, pageWidthPt, opts = {}) {
    const vpT = viewport.transform;
    // Viewport scale: vpT = [scaleX, 0, 0, -scaleY, ox, oy] for an unrotated viewport.
    // Text widths and font sizes from PDF.js are in PDF user-space; positions
    // (tm.vx, tm.vy) we compute below are in viewport space. We must scale
    // widths/fonts by the viewport scale before comparing against viewport coords,
    // otherwise X-spans, Y-bands, and column-coverage all undershoot by 1/scale.
    const scaleX = Math.hypot(vpT[0], vpT[1]) || 1;
    const scaleY = Math.hypot(vpT[2], vpT[3]) || 1;
    const bodyFontSize = computeBodyFontSize(textItems);   // PDF-points
    const bodyFontVp   = bodyFontSize * scaleY;            // viewport pixels
    const headingScale = opts.headingScale ?? 1.25;
    const underlineTol = opts.underlineTol ?? 5;   // px: max distance text baseline → H-line
    const tablePad     = opts.tablePad ?? 4;        // px: padding around table bbox for text capture

    // ── 1. Convert all text items to viewport coordinates ────────────────────
    const textMeta = textItems.map((item, idx) => {
        const [vx, vy] = toViewport(vpT, item.transform[4], item.transform[5]);
        const fontSizePt = Math.abs(item.transform?.[3] || 12);   // PDF-points
        const widthPt    = item.width || (fontSizePt * 0.5 * (item.str?.length || 1));
        return {
            idx,
            vx, vy,
            vWidth: widthPt * scaleX,    // viewport pixels — for vx-relative checks
            vFont:  fontSizePt * scaleY, // viewport pixels — for vy-relative checks
            fontSize: fontSizePt,        // PDF-points — for ratio comparisons
            str: item.str || '',
        };
    });

    // ── 2. Classify H-segments: underline vs. table border ───────────────────
    const eps = 4;
    const hSegs = [], vSegs = [];
    const underlineSegIds = new Set();

    for (const s of segments) {
        const dx = Math.abs(s.x2 - s.x1);
        const dy = Math.abs(s.y2 - s.y1);
        if (dy <= eps && dx > eps)       hSegs.push(s);
        else if (dx <= eps && dy > eps)  vSegs.push(s);
    }

    // KD-tree proximity: for each H-segment, check if there's text just above it
    for (const h of hSegs) {
        const hY = (h.y1 + h.y2) / 2;
        const hXMin = Math.min(h.x1, h.x2);
        const hXMax = Math.max(h.x1, h.x2);
        const hLen = hXMax - hXMin;

        for (const tm of textMeta) {
            if (!tm.str.trim()) continue;
            const textBottom = tm.vy;
            const textXEnd = tm.vx + tm.vWidth;
            const yDist = hY - textBottom; // positive = line is below text

            // Underline: line is 0–5px below the text baseline, overlapping X span
            if (yDist >= -1 && yDist <= underlineTol &&
                tm.vx <= hXMax + 2 && textXEnd >= hXMin - 2 &&
                hLen < tm.vWidth * 2.5) { // underline shouldn't be wildly wider than text
                underlineSegIds.add(h.id);
                break; // one match is enough to tag this segment
            }
        }
    }

    // Segments that are NOT underlines are available for table detection
    const tableSegs = segments.filter(s => !underlineSegIds.has(s.id));

    // ── 3. Detect table regions (lattice grids) ──────────────────────────────
    const reconstructor = new LatticeReconstructor(tableSegs, { eps: 5 });
    const lattices = reconstructor.reconstructAll();

    const regions = [];
    const assignedTextIndices = new Set();

    for (const lattice of lattices) {
        if (!lattice?.bbox) continue;
        const bbox = lattice.bbox;

        // Collect text items inside this table's bbox
        const tableTextIndices = [];
        for (const tm of textMeta) {
            if (!tm.str.trim()) continue;
            if (assignedTextIndices.has(tm.idx)) continue;
            if (insideBBox(tm.vx, tm.vy, bbox, tablePad)) {
                tableTextIndices.push(tm.idx);
                assignedTextIndices.add(tm.idx);
            }
        }

        regions.push({
            type: RegionType.TABLE,
            bbox,
            yCenter: bbox.y + bbox.h / 2,
            lattice,
            textItemIndices: tableTextIndices,
        });
    }

    // ── 4. Detect image regions ──────────────────────────────────────────────
    // (Passed in from pdfAnalyzer or detected separately; here we accept them as opts)
    const imageRegions = opts.imageRegions || [];
    for (const img of imageRegions) {
        regions.push({
            type: RegionType.IMAGE,
            bbox: img,
            yCenter: img.y + img.h / 2,
            textItemIndices: [],
        });
    }

    // ── 5. Page-level column detection ───────────────────────────────────────
    // Find large vertical gaps in X-coverage to split into left/right columns.
    const remainingMeta = textMeta.filter(tm => !assignedTextIndices.has(tm.idx) && tm.str.trim());
    const columnSplits = _detectPageColumns(remainingMeta, viewport);

    // ── 6. Classify remaining text by column, then by type ───────────────────
    const columnBuckets = _splitByColumns(remainingMeta, columnSplits);

    for (const bucket of columnBuckets) {
        // Group by Y-band (visual lines) — tolerance in viewport pixels
        const lines = _groupByYBand(bucket, bodyFontVp * 0.45);

        let currentBlock = [];
        let currentType = null;

        for (let li = 0; li < lines.length; li++) {
            const line = lines[li];
            const lineStr = line.items.map(tm => tm.str.trim()).join(' ').trim();
            if (!lineStr) continue;

            const lineFontSize = line.items.reduce((s, tm) => s + tm.fontSize, 0) / line.items.length;

            // Determine line type
            let lineType;
            if (lineFontSize > bodyFontSize * headingScale && line.items.length <= 3) {
                lineType = RegionType.HEADING;
            } else if (BULLET_RE.test(lineStr) || ORDERED_RE.test(lineStr)) {
                lineType = RegionType.LIST;
            } else {
                lineType = RegionType.PARAGRAPH;
            }

            // If type changed or there's a large Y gap, flush current block (gap in viewport px)
            const hasGap = li > 0 && Math.abs(line.y - lines[li - 1].y) > bodyFontVp * 1.8;

            if (currentType !== null && (lineType !== currentType || hasGap)) {
                _flushBlock(regions, currentBlock, currentType, bodyFontSize);
                currentBlock = [];
            }

            currentType = lineType;
            currentBlock.push(line);
        }

        // Flush last block
        if (currentBlock.length) {
            _flushBlock(regions, currentBlock, currentType, bodyFontSize);
        }
    }

    // ── 7. Sort all regions top→bottom (by yCenter) ──────────────────────────
    regions.sort((a, b) => a.yCenter - b.yCenter);

    return regions;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function _flushBlock(regions, lines, type, bodyFontSize) {
    if (!lines.length) return;

    const allIndices = lines.flatMap(l => l.items.map(tm => tm.idx));
    const allItems = lines.flatMap(l => l.items);

    // bbox in viewport space — must use vWidth/vFont, not raw PDF widths/font sizes
    let yMin = Infinity, yMax = -Infinity, xMin = Infinity, xMax = -Infinity;
    for (const tm of allItems) {
        if (tm.vy < yMin) yMin = tm.vy;
        if (tm.vy > yMax) yMax = tm.vy;
        if (tm.vx < xMin) xMin = tm.vx;
        if (tm.vx + tm.vWidth > xMax) xMax = tm.vx + tm.vWidth;
    }

    const avgFontSize = allItems.reduce((s, tm) => s + tm.fontSize, 0) / allItems.length;
    const avgFontVp   = allItems.reduce((s, tm) => s + tm.vFont, 0) / allItems.length;

    regions.push({
        type,
        bbox: { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin + avgFontVp },
        yCenter: (yMin + yMax) / 2,
        textItemIndices: allIndices,
        fontSize: avgFontSize, // PDF-points, kept for downstream heading-tag selection
        listOrdered: type === RegionType.LIST
            ? ORDERED_RE.test(lines[0].items.map(tm => tm.str.trim()).join(' '))
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

    // Sort items within each band left-to-right
    for (const l of lines) {
        l.items.sort((a, b) => a.vx - b.vx);
    }

    // Sort bands top-to-bottom
    lines.sort((a, b) => a.y - b.y);
    return lines;
}

/**
 * Detect page-level column boundaries from text item X-positions.
 * Returns an array of X split points (in viewport space).
 */
function _detectPageColumns(textMeta, viewport) {
    if (!textMeta.length || !viewport?.width) return [];

    const vpWidth = viewport.width;
    const w = Math.ceil(vpWidth);
    const coverage = new Float32Array(w);

    for (const tm of textMeta) {
        const x1 = Math.max(0, Math.floor(tm.vx));
        const x2 = Math.min(w - 1, Math.ceil(tm.vx + tm.vWidth));
        for (let x = x1; x <= x2; x++) coverage[x]++;
    }

    // Find zero-coverage gaps of minimum width (20px in viewport space)
    const minGap = 20;
    const candidates = [];
    let gStart = null;

    for (let x = 0; x < w; x++) {
        if (coverage[x] === 0) {
            if (gStart === null) gStart = x;
        } else if (gStart !== null) {
            if (x - gStart >= minGap) candidates.push((gStart + x) / 2);
            gStart = null;
        }
    }

    // Only keep splits that bisect a meaningful region (not page margins)
    // The split must be between 15% and 85% of the page width
    return candidates.filter(sx =>
        sx > vpWidth * 0.15 && sx < vpWidth * 0.85,
    );
}

/**
 * Split text items into column buckets based on X split points.
 */
function _splitByColumns(textMeta, splits) {
    if (!splits.length) return [textMeta];

    const boundaries = [-Infinity, ...splits, Infinity];
    const buckets = boundaries.slice(0, -1).map(() => []);

    for (const tm of textMeta) {
        for (let ci = 0; ci < buckets.length; ci++) {
            if (tm.vx >= boundaries[ci] && tm.vx < boundaries[ci + 1]) {
                buckets[ci].push(tm);
                break;
            }
        }
    }

    // Process columns left-to-right (each column is independent)
    return buckets.filter(b => b.length > 0);
}
