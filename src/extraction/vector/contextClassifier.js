// contextClassifier.js
// Region-classification engine for context-aware PDF extraction.
//
// Takes the raw page inventory (segments, text items, images) and produces
// a sorted list of typed, spatially-bounded regions. Each region knows
// what it is (TABLE, PARAGRAPH, HEADING, LIST, IMAGE) and carries only the
// segments and text items that belong to it.
//
// Key algorithms:
//   1. Underline detection    — proximity between H-segments and text baselines
//   2. Table region detection — lattice bboxes scope segments + text items
//   3. Stream table detection — column-anchor + gutter clustering (borderless)
//   4. Heading detection      — font size > 1.25× body average
//   5. List detection         — lines starting with bullet/number patterns
//   6. Column detection       — page-level left/right split via coverage gaps
//   7. Paragraph detection    — remaining text grouped by Y-band
//
// Returns { regions, textMeta } so pageAssembler has access to viewport-space
// font info for styling without re-deriving coordinates.
//
// Safe to run inside a Web Worker.

import { LatticeReconstructor } from './latticeReconstructor.js';
import { detectStreamTables } from './streamDetector.js';
import { PageScale } from './pageScale.js';

// ── Region types ─────────────────────────────────────────────────────────────

export const RegionType = {
    TABLE:     'TABLE',
    PARAGRAPH: 'PARAGRAPH',
    HEADING:   'HEADING',
    LIST:      'LIST',
    IMAGE:     'IMAGE',
};

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

// Bullet / numbered-list patterns
const BULLET_RE = /^[•‣◦▪▫–—―•–—·○◦◉▪▫-]\s/;
const ORDERED_RE = /^(?:\d{1,3}[.)]\s|[a-zA-Z][.)]\s|[ivxIVX]+[.)]\s)/;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify a single page into typed regions.
 *
 * @param {PathSegment[]}  segments    — from ctmAdapter
 * @param {TextItem[]}     textItems   — from page.getTextContent().items
 * @param {object}         viewport    — { width, height, transform }
 * @param {number}         pageWidthPt — page width in PDF points
 * @param {object}         [opts]      — classification options
 * @returns {{ regions: PageRegion[], textMeta: TextMetaItem[] }}
 */
export function classifyPage(segments, textItems, viewport, pageWidthPt, opts = {}) {
    const vpT = viewport.transform;
    const scaleX = Math.hypot(vpT[0], vpT[1]) || 1;
    const scaleY = Math.hypot(vpT[2], vpT[3]) || 1;

    // ── 1. Convert all text items to viewport coordinates ────────────────────
    // fontName is included so pageAssembler can build the CSS font registry
    // without re-reading textItems (which are in PDF user-space).
    const textMeta = textItems.map((item, idx) => {
        const [vx, vy] = toViewport(vpT, item.transform[4], item.transform[5]);
        const fontSizePt = Math.abs(item.transform?.[3] || 12);
        const widthPt    = item.width || (fontSizePt * 0.5 * (item.str?.length || 1));
        return {
            idx,
            vx, vy,
            vWidth:    widthPt * scaleX,
            vFont:     fontSizePt * scaleY,
            fontSize:  fontSizePt,
            fontName:  item.fontName || '',
            str:       item.str || '',
            underlined: false,
        };
    });

    // Natural-unit scale: S = median body font in viewport-px.
    // All thresholds derive from S — no hardcoded px values below.
    const scale = new PageScale(textMeta, viewport);
    if (opts.headingScale !== undefined) scale.HEADING_SCALE = opts.headingScale;
    const tablePad = opts.tablePad ?? scale.tablePadPx;

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

    for (const h of hSegs) {
        const hY    = (h.y1 + h.y2) / 2;
        const hXMin = Math.min(h.x1, h.x2);
        const hXMax = Math.max(h.x1, h.x2);
        const hLen  = hXMax - hXMin;

        for (const tm of textMeta) {
            if (!tm.str.trim()) continue;
            const textBottom = tm.vy;
            const textXEnd   = tm.vx + tm.vWidth;
            const yDist      = hY - textBottom;

            // Underline: line sits 0→(35% of cap height) below text baseline,
            // overlapping the text X span, and no wider than 1.2× the text width.
            const itemUnderlineTol = opts.underlineTol ?? (tm.vFont * scale.R_UNDERLINE);
            if (yDist >= -1 && yDist <= itemUnderlineTol &&
                tm.vx <= hXMax + 2 && textXEnd >= hXMin - 2 &&
                hLen < tm.vWidth * 1.2) {
                underlineSegIds.add(h.id);
                tm.underlined = true;
                break;
            }
        }
    }

    const tableSegs = segments.filter(s => !underlineSegIds.has(s.id));

    // ── 3. Detect lattice table regions ──────────────────────────────────────
    const reconstructor = new LatticeReconstructor(tableSegs, { eps: 5 });
    const lattices = reconstructor.reconstructAll();

    const regions = [];
    const assignedTextIndices = new Set();

    for (const lattice of lattices) {
        if (!lattice?.bbox) continue;

        // Skip single-column lattices (cols.length == 2 → numCols == 1).
        // A bordered single-column structure is a formatted list or label column,
        // not a table. Skipping it keeps items available for stream detection and
        // paragraph extraction, preventing the lattice from stealing items that
        // belong to a multi-column borderless table (e.g. sparktoro domain names).
        if ((lattice.cols?.length ?? 0) <= 2) continue;

        const bbox = lattice.bbox;
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

    // ── 4. Detect image regions ───────────────────────────────────────────────
    const imageRegions = opts.imageRegions || [];
    for (const img of imageRegions) {
        regions.push({
            type: RegionType.IMAGE,
            bbox: img,
            yCenter: img.y + img.h / 2,
            textItemIndices: [],
        });
    }

    // ── 5. Stream table detection (borderless tables) ────────────────────────
    const unclaimedMeta = textMeta.filter(
        tm => !assignedTextIndices.has(tm.idx) && tm.str.trim(),
    );
    const streamTables = detectStreamTables(unclaimedMeta, scale, regions);
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
            type: RegionType.TABLE,
            bbox,
            yCenter: bbox.y + bbox.h / 2,
            lattice,
            textItemIndices: tableTextIndices,
        });
    }

    // ── 6. Page-level column detection ───────────────────────────────────────
    const remainingMeta = textMeta.filter(
        tm => !assignedTextIndices.has(tm.idx) && tm.str.trim(),
    );
    const columnSplits = _detectPageColumns(remainingMeta, viewport, scale);
    const columnBuckets = _splitByColumns(remainingMeta, columnSplits);

    // ── 7. Classify remaining text by column, then by type ───────────────────
    const bodyFontSizePt = scale.S / scaleY; // back to PDF points for ratio comparisons

    for (const bucket of columnBuckets) {
        const lines = _groupByYBand(bucket, scale.yBandTolPx);

        let currentBlock = [];
        let currentType  = null;

        for (let li = 0; li < lines.length; li++) {
            const line    = lines[li];
            const lineStr = line.items.map(tm => tm.str.trim()).join(' ').trim();
            if (!lineStr) continue;

            const lineFontSize = line.items.reduce((s, tm) => s + tm.fontSize, 0) / line.items.length;

            let lineType;
            if (lineFontSize > bodyFontSizePt * scale.HEADING_SCALE && line.items.length <= 3) {
                lineType = RegionType.HEADING;
            } else if (BULLET_RE.test(lineStr) || ORDERED_RE.test(lineStr)) {
                lineType = RegionType.LIST;
            } else {
                lineType = RegionType.PARAGRAPH;
            }

            const hasGap = li > 0 && Math.abs(line.y - lines[li - 1].y) > scale.paraGapPx;

            if (currentType !== null && (lineType !== currentType || hasGap)) {
                _flushBlock(regions, currentBlock, currentType);
                currentBlock = [];
            }

            currentType = lineType;
            currentBlock.push(line);
        }

        if (currentBlock.length) {
            _flushBlock(regions, currentBlock, currentType);
        }
    }

    // ── 8. Sort all regions top→bottom ───────────────────────────────────────
    regions.sort((a, b) => a.yCenter - b.yCenter);

    return { regions, textMeta };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _flushBlock(regions, lines, type) {
    if (!lines.length) return;

    const allIndices = lines.flatMap(l => l.items.map(tm => tm.idx));
    const allItems   = lines.flatMap(l => l.items);

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
        fontSize: avgFontSize,
        listOrdered: type === RegionType.LIST
            ? ORDERED_RE.test(lines[0].items.map(tm => tm.str.trim()).join(' '))
            : undefined,
    });
}

function _groupByYBand(items, yTol) {
    const sorted = [...items].sort((a, b) => a.vy - b.vy);
    const lines  = [];

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

function _detectPageColumns(textMeta, viewport, scale) {
    if (!textMeta.length || !viewport?.width) return [];

    const vpWidth  = viewport.width;
    const w        = Math.ceil(vpWidth);
    const coverage = new Float32Array(w);

    for (const tm of textMeta) {
        const x1 = Math.max(0, Math.floor(tm.vx));
        const x2 = Math.min(w - 1, Math.ceil(tm.vx + tm.vWidth));
        for (let x = x1; x <= x2; x++) coverage[x]++;
    }

    const minGap   = Math.max(20, scale.colGapMinPx);
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

    return candidates.filter(sx =>
        sx > vpWidth * scale.MARGIN_FLOOR && sx < vpWidth * (1 - scale.MARGIN_FLOOR),
    );
}

function _splitByColumns(textMeta, splits) {
    if (!splits.length) return [textMeta];

    const boundaries = [-Infinity, ...splits, Infinity];
    const buckets    = boundaries.slice(0, -1).map(() => []);

    for (const tm of textMeta) {
        for (let ci = 0; ci < buckets.length; ci++) {
            if (tm.vx >= boundaries[ci] && tm.vx < boundaries[ci + 1]) {
                buckets[ci].push(tm);
                break;
            }
        }
    }

    return buckets.filter(b => b.length > 0);
}
