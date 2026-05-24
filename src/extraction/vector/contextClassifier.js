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
    LATTICE_TABLE: 'LATTICE_TABLE', // explicit cell grid — borders present (LatticeReconstructor)
    STREAM_TABLE:  'STREAM_TABLE',  // borderless column-aligned table (streamDetector)
    TABLE:         'TABLE',         // legacy alias — treated as LATTICE_TABLE by assembler
    PARAGRAPH:     'PARAGRAPH',
    HEADING:       'HEADING',
    LIST:          'LIST',
    IMAGE:         'IMAGE',
    BOX:           'BOX',           // closed-rectangle container (note/warning/caution/tip)
    DIVIDER:       'DIVIDER',       // standalone horizontal rule separating sections
    HEADER:        'HEADER',        // running page header
    FOOTER:        'FOOTER',        // running page footer
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
 * @param {Array}          imageMeta   — from ctmAdapter
 * @param {object}         [opts]      — classification options
 * @returns {{ regions: PageRegion[], textMeta: TextMetaItem[], columnSplits: number[] }}
 */
export function classifyPage(segments, textItems, viewport, pageWidthPt, imageMeta = [], opts = {}) {
    const filledRects  = opts.filledRects  ?? [];
    const fontStyleMap = opts.fontStyleMap ?? {};
    const vpT = viewport.transform;
    const scaleX = Math.hypot(vpT[0], vpT[1]) || 1;
    const scaleY = Math.hypot(vpT[2], vpT[3]) || 1;

    // ── 1. Convert all text items to viewport coordinates ────────────────────
    // Bold/italic come from fontStyleMap (built from page.commonObjs after render)
    // which is far more reliable than parsing the raw fontName string.
    // Fallback: detect synthetic italic from the shear component of the text matrix
    // (transform[2] ≠ 0 means the PDF applied oblique shear to simulate italic).
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
        if (dy <= eps && dx > eps) hSegs.push(s);
        else if (dx <= eps && dy > eps) vSegs.push(s);
    }

    for (const h of hSegs) {
        const hY = (h.y1 + h.y2) / 2;
        const hXMin = Math.min(h.x1, h.x2);
        const hXMax = Math.max(h.x1, h.x2);
        const hLen = hXMax - hXMin;

        for (const tm of textMeta) {
            if (!tm.str.trim()) continue;
            const textBottom = tm.vy;
            const textXEnd = tm.vx + tm.vWidth;
            const yDist = hY - textBottom;

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

    const imageBBoxes = imageMeta.map(img => img.bbox);
    const isInsideImage = (x, y) => imageBBoxes.some(b => x >= b.x - 5 && x <= b.x + b.w + 5 && y >= b.y - 5 && y <= b.y + b.h + 5);

    const tableSegs = segments.filter(s => {
        if (underlineSegIds.has(s.id)) return false;
        if (isInsideImage(s.x1, s.y1) && isInsideImage(s.x2, s.y2)) return false;
        return true;
    });
    const regions = [];

    // ── 2.5: Inject explicit image regions ───────────────────────────────────
    for (const img of imageMeta) {
        regions.push({
            type: RegionType.IMAGE,
            id: img.id,
            bbox: img.bbox,
            textItemIndices: [],
            yCenter: img.bbox.y + img.bbox.h / 2,
            columnIndex: -1 // Will be patched if narrow enough
        });
    }

    // ── 3. Detect lattice table regions ──────────────────────────────────────
    const reconstructor = new LatticeReconstructor(tableSegs, { eps: 5, scale, textMeta, pageHeight: viewport.height });
    const lattices = reconstructor.reconstructAll();


    const assignedTextIndices = new Set();

    for (const lattice of lattices) {
        if (!lattice?.bbox) continue;

        // Single-column lattice (cols.length == 2 → one data column): classify as BOX
        // if it contains flowing text (a semantic container like note/warning/caution),
        // otherwise skip so its text stays available for paragraph/stream extraction.
        if ((lattice.cols?.length ?? 0) <= 2) {
            const bbox = lattice.bbox;
            if (!bbox) continue;

            // Same page-frame guard as the isolated-rect detector below
            if (bbox.x < viewport.width * 0.04 && bbox.w > viewport.width * 0.65) continue;
            if (bbox.w > viewport.width * 0.88) continue;

            const boxTextIndices = [];
            let maxItemWidth = 0;
            for (const tm of textMeta) {
                if (!tm.str.trim() || assignedTextIndices.has(tm.idx)) continue;
                if (insideBBox(tm.vx, tm.vy, bbox, tablePad)) {
                    boxTextIndices.push(tm.idx);
                    if (tm.vWidth > maxItemWidth) maxItemWidth = tm.vWidth;
                }
            }

            // Qualify: must have content that spans at least 30% of the box width
            if (maxItemWidth < bbox.w * 0.30 || boxTextIndices.length === 0) continue;

            // Keyword match on first ~60 chars to assign a semantic role
            const sortedItems = boxTextIndices
                .map(i => textMeta[i])
                .sort((a, b) => a.vy - b.vy || a.vx - b.vx);
            const sampleText = sortedItems.slice(0, 8).map(tm => tm.str).join(' ').trim().slice(0, 60).toUpperCase();
            let boxRole = 'generic';
            if (/\bWARNING\b|\bDANGER\b|\bCRITICAL\b/.test(sampleText)) boxRole = 'warning';
            else if (/\bCAUTION\b|\bATTENTION\b/.test(sampleText)) boxRole = 'caution';
            else if (/\bNOTE\b|\bINFO\b|\bINFORMATION\b|\bIMPORTANT\b|\bNOTICE\b/.test(sampleText)) boxRole = 'note';
            else if (/\bTIP\b|\bHINT\b|\bEXAMPLE\b/.test(sampleText)) boxRole = 'tip';

            // Look for a filled background rect that overlaps this box
            let boxFillColor = null;
            for (const fr of filledRects) {
                const overlaps = fr.x < bbox.x + bbox.w && fr.x + fr.w > bbox.x &&
                                 fr.y < bbox.y + bbox.h && fr.y + fr.h > bbox.y;
                if (overlaps) { boxFillColor = fr.fillColor; break; }
            }

            for (const idx of boxTextIndices) assignedTextIndices.add(idx);
            regions.push({
                type: RegionType.BOX,
                bbox,
                yCenter: bbox.y + bbox.h / 2,
                textItemIndices: boxTextIndices,
                columnIndex: -1,
                boxRole,
                fillColor: boxFillColor,
            });
            continue;
        }

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
            type: RegionType.LATTICE_TABLE,
            bbox,
            yCenter: bbox.y + bbox.h / 2,
            lattice,
            textItemIndices: tableTextIndices,
            columnIndex: -1,
            proximityPx: scale.proximityPx,
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
            columnIndex: -1,
        });
    }

    // ── 5. Stream table detection (borderless tables) ────────────────────────
    const unclaimedMeta = textMeta.filter(
        tm => !assignedTextIndices.has(tm.idx) && tm.str.trim(),
    );
    const streamTables = detectStreamTables(unclaimedMeta, scale, regions, tableSegs);
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

    // ── 5.5: Isolated-rectangle box detection ─────────────────────────────────
    // The LatticeReconstructor requires ≥3 lines per direction, so simple 4-sided
    // boxes (top + bottom + left + right = 2H + 2V) are never found as lattices.
    // This pass pairs H-segments and V-segments directly, finding closed rectangles
    // that contain flowing text not already claimed by a table or image region.
    //
    // CRITICAL: Outer page-frame borders (common in engineering datasheets, manuals)
    // span ≥90% of the page width. Classifying them as BOX would consume ALL text
    // items and prevent column detection entirely. Real semantic boxes (notes/warnings)
    // are at most ~75% of page width. Filter at 80% to safely exclude page frames.
    {
        const eps6 = (scale.proximityPx ?? 6) * 1.5;
        const vpW  = viewport.width;

        // Page-frame guard: reject borders that are almost certainly outer page frames,
        // not semantic content boxes. Two independent signals (either is sufficient):
        //   a) Starts at the page edge (x < 4% vpW) AND spans > 65% → frame from edge
        //   b) Spans > 88% of page width regardless of origin → nearly full-page border
        //
        // A real semantic box (note/warning/caution) always starts within the text margin
        // (x ≥ ~30px in) and spans at most ~76% of page width (standard margin ~12% each
        // side). This guard has zero effect on such boxes and only fires for page frames.
        const _isPageFrame = (bx, bw) =>
            (bx < vpW * 0.04 && bw > vpW * 0.65) ||   // wide border starting at page edge
            bw > vpW * 0.88;                             // nearly full-width regardless

        const claimedByRegion = (cx, cy) =>
            regions.some(r => r.bbox && insideBBox(cx, cy, r.bbox, 2));

        // Only consider segments that aren't underlines and aren't image-internal
        const freeH = hSegs.filter(s => !underlineSegIds.has(s.id));
        const freeV = vSegs;

        for (let i = 0; i < freeH.length; i++) {
            const th = freeH[i];
            const tY  = (th.y1 + th.y2) / 2;
            const tX1 = Math.min(th.x1, th.x2);
            const tX2 = Math.max(th.x1, th.x2);

            for (let j = i + 1; j < freeH.length; j++) {
                const bh = freeH[j];
                const bY  = (bh.y1 + bh.y2) / 2;
                const bX1 = Math.min(bh.x1, bh.x2);
                const bX2 = Math.max(bh.x1, bh.x2);

                // Candidate top/bottom borders must have matching X extents
                if (Math.abs(tX1 - bX1) > eps6 || Math.abs(tX2 - bX2) > eps6) continue;
                const rectH = Math.abs(bY - tY);
                if (rectH < 20) continue; // too thin to contain content

                const x1 = (tX1 + bX1) / 2, x2 = (tX2 + bX2) / 2;
                const y1 = Math.min(tY, bY),  y2 = Math.max(tY, bY);
                const cx = (x1 + x2) / 2,     cy = (y1 + y2) / 2;

                // Skip if already inside a known TABLE/IMAGE region
                if (claimedByRegion(cx, cy)) continue;

                // Must have closing V-segments on both sides
                const lV = freeV.find(s =>
                    Math.abs((s.x1 + s.x2) / 2 - x1) <= eps6 &&
                    Math.min(s.y1, s.y2) <= y1 + eps6 &&
                    Math.max(s.y1, s.y2) >= y2 - eps6
                );
                const rV = freeV.find(s =>
                    Math.abs((s.x1 + s.x2) / 2 - x2) <= eps6 &&
                    Math.min(s.y1, s.y2) <= y1 + eps6 &&
                    Math.max(s.y1, s.y2) >= y2 - eps6
                );
                if (!lV || !rV) continue;

                const bbox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };

                // Reject outer page-frame borders — they are structural, not semantic
                if (_isPageFrame(x1, x2 - x1)) continue;

                // Collect text items inside; must have flowing content
                const boxTextIndices = [];
                let maxItemWidth = 0;
                for (const tm of textMeta) {
                    if (!tm.str.trim() || assignedTextIndices.has(tm.idx)) continue;
                    if (insideBBox(tm.vx, tm.vy, bbox, tablePad)) {
                        boxTextIndices.push(tm.idx);
                        if (tm.vWidth > maxItemWidth) maxItemWidth = tm.vWidth;
                    }
                }
                if (maxItemWidth < bbox.w * 0.25 || boxTextIndices.length === 0) continue;

                // Keyword-based semantic role
                const sampleText = boxTextIndices.slice(0, 8)
                    .map(i => textMeta[i].str).join(' ').toUpperCase().slice(0, 60);
                let boxRole = 'generic';
                if (/\bWARNING\b|\bDANGER\b|\bCRITICAL\b/.test(sampleText)) boxRole = 'warning';
                else if (/\bCAUTION\b|\bATTENTION\b/.test(sampleText)) boxRole = 'caution';
                else if (/\bNOTE\b|\bINFO\b|\bINFORMATION\b|\bIMPORTANT\b|\bNOTICE\b/.test(sampleText)) boxRole = 'note';
                else if (/\bTIP\b|\bHINT\b|\bEXAMPLE\b/.test(sampleText)) boxRole = 'tip';

                // Fill color from ctmAdapter filledRects
                let boxFillColor = null;
                for (const fr of filledRects) {
                    if (fr.x < x2 && fr.x + fr.w > x1 && fr.y < y2 && fr.y + fr.h > y1) {
                        boxFillColor = fr.fillColor; break;
                    }
                }

                for (const idx of boxTextIndices) assignedTextIndices.add(idx);
                regions.push({
                    type: RegionType.BOX,
                    bbox,
                    yCenter: cy,
                    textItemIndices: boxTextIndices,
                    columnIndex: -1,
                    boxRole,
                    fillColor: boxFillColor,
                });
                break; // Found the box for this top H-seg; move to next
            }
        }
    }

    // ── 5.7: Divider (horizontal rule) detection ──────────────────────────────
    // H-segments that survived the underline filter, are not inside any known
    // region's bbox, span ≥15% of the page, and have no text within ~1 line-height
    // above or below are standalone section separators → RegionType.DIVIDER.
    {
        const dividerMinLen = viewport.width * 0.15;
        for (const s of hSegs) {
            if (underlineSegIds.has(s.id)) continue;
            const segLen = Math.abs(s.x2 - s.x1);
            if (segLen < dividerMinLen) continue;
            const midX = (s.x1 + s.x2) / 2;
            const midY = (s.y1 + s.y2) / 2;
            if (regions.some(r => r.bbox && insideBBox(midX, midY, r.bbox, 5))) continue;
            const nearText = textMeta.some(tm =>
                Math.abs(tm.vy - midY) < scale.S * 0.8 &&
                tm.vx < Math.max(s.x1, s.x2) + 4 &&
                (tm.vx + tm.vWidth) > Math.min(s.x1, s.x2) - 4
            );
            if (nearText) continue;
            regions.push({
                type: RegionType.DIVIDER,
                bbox: { x: Math.min(s.x1, s.x2), y: midY - 1, w: segLen, h: 2 },
                yCenter: midY,
                textItemIndices: [],
                columnIndex: -1,
            });
        }
    }

    // ── 6. Page-level column detection ───────────────────────────────────────
    const remainingMeta = textMeta.filter(
        tm => !assignedTextIndices.has(tm.idx) && tm.str.trim(),
    );

    // _detectPageColumns classifies Y-bands as "wide" (X span > 55% page) to find the
    // column gutter. But in dense two-column layouts both columns are active at the
    // SAME Y positions — left item (x=54–434) + right item (x=489–864) in the same
    // Y-band spans 88% of page and is classified "wide", dumping both items into
    // fullWidthIndices even though each item individually belongs to one column.
    //
    // Post-correction: after the split is known, any item in fullWidthIndices whose
    // OWN X range sits entirely on one side of every split point is a false-positive
    // and belongs to that column, not to the full-width flow.
    const { splits: rawSplits, fullWidthIndices } = _detectPageColumns(remainingMeta, viewport, scale);
    const columnSplits = rawSplits.map(s => s.x);

    // ── Fallback: BOX / TABLE regions can claim all right-column text items, leaving
    // only left-column items for gutter detection → no split found.  If unclaimed items
    // alone showed no gutter, retry with the FULL textMeta pool (including claimed items).
    // This recovers the real column split without changing which items belong to which region.
    if (rawSplits.length === 0) {
        const allNonEmpty = textMeta.filter(tm => tm.str.trim());
        if (allNonEmpty.length > remainingMeta.length + 4) { // claimed items exist
            const { splits: fallbackSplits } = _detectPageColumns(allNonEmpty, viewport, scale);
            rawSplits.push(...fallbackSplits);
            columnSplits.push(...fallbackSplits.map(s => s.x));
        }
    }

    // Post-correction: items marked wide because BOTH columns were active at the same Y
    // are re-evaluated once the split is known. Items entirely on one side → column-specific.
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

    const columnBuckets = _splitByColumns(narrowMeta, columnSplits);

    // Patch TABLE/IMAGE regions: assign narrow ones to their correct column now
    // that the split point is known.
    if (columnSplits.length > 0) {
        const vw = viewport.width;
        const eps = 5;
        for (const r of regions) {
            if (r.columnIndex !== -1 || !r.bbox) continue;
            const crossesSplit = columnSplits.some(sx => r.bbox.x < sx - eps && (r.bbox.x + r.bbox.w) > sx + eps);
            if (r.bbox.w >= vw * 0.65 || crossesSplit) continue;
            const cx = r.bbox.x + r.bbox.w / 2;
            for (let ci = 0; ci <= columnSplits.length; ci++) {
                const lo = ci === 0 ? -Infinity : columnSplits[ci - 1];
                const hi = ci === columnSplits.length ? Infinity : columnSplits[ci];
                if (cx >= lo && cx < hi) { r.columnIndex = ci; break; }
            }
        }
    }

    // ── 7. Classify remaining text by column, then by type ───────────────────
    const bodyFontSizePt = scale.S / scaleY;

    for (let ci = 0; ci < columnBuckets.length; ci++) {
        const lines = _groupByYBand(columnBuckets[ci], scale.yBandTolPx);
        _classifyBucket(regions, lines, bodyFontSizePt, scale, ci);
    }

    // Full-width items (section headers, warning-box text, spanning notices)
    // become columnIndex: -1 regions — zone dividers for pageAssembler.
    if (fullWidthMeta.length > 0) {
        const lines = _groupByYBand(fullWidthMeta, scale.yBandTolPx);
        _classifyBucket(regions, lines, bodyFontSizePt, scale, -1);
    }

    // ── 8. Sort all regions top→bottom ───────────────────────────────────────
    regions.sort((a, b) => a.yCenter - b.yCenter);

    // ── 9. Header / Footer detection ─────────────────────────────────────────
    // Signals (any one is sufficient to reclassify):
    //   a) avg font < 85% of body median  AND  region in top/bottom 12% of page
    //   b) content matches common header/footer patterns (page numbers, copyright)
    //   c) a colored filled band from filledRects spans ≥80% page width in that zone
    //
    // TABLE, BOX, and IMAGE regions are never reclassified.
    const HDR_FOOTER_RE = /^\d+$|page\s*\d+|\bof\s+\d+\b|©|\bCopyright\b|\bConfidential\b|\bAll Rights Reserved\b/i;
    const topThreshold    = viewport.height * 0.12;
    const bottomThreshold = viewport.height * 0.88;

    // Detect full-width colored bands (header/footer background fills)
    const headerBands = filledRects.filter(fr =>
        fr.w >= viewport.width * 0.80 && fr.y < topThreshold
    );
    const footerBands = filledRects.filter(fr =>
        fr.w >= viewport.width * 0.80 && (fr.y + fr.h) > bottomThreshold
    );

    for (const r of regions) {
        if (r.type === RegionType.LATTICE_TABLE || r.type === RegionType.STREAM_TABLE ||
            r.type === RegionType.TABLE  || r.type === RegionType.BOX    ||
            r.type === RegionType.IMAGE  || r.type === RegionType.DIVIDER) continue;
        if (r.type === RegionType.HEADER || r.type === RegionType.FOOTER) continue;

        const inTop = r.yCenter < topThreshold;
        const inBot = r.yCenter > bottomThreshold;
        if (!inTop && !inBot) continue;

        const regionMeta = (r.textItemIndices || []).map(i => textMeta[i]).filter(Boolean);
        const avgFont = regionMeta.length
            ? regionMeta.reduce((s, tm) => s + tm.vFont, 0) / regionMeta.length
            : scale.S;
        const smallFont = avgFont < scale.S * 0.85;

        const regionText = regionMeta.map(tm => tm.str).join(' ');
        const patternMatch = HDR_FOOTER_RE.test(regionText);

        // Skip stray single glyphs (e.g. a lone "I" section marker in the top margin)
        // unless they match a header/footer pattern (like a lone page number "3").
        const nonSpaceLen = regionText.replace(/\s/g, '').length;
        if (nonSpaceLen < 2 && !patternMatch) continue;

        const inColoredBand = inTop
            ? headerBands.some(fr => r.bbox && r.bbox.y >= fr.y && r.bbox.y <= fr.y + fr.h)
            : footerBands.some(fr => r.bbox && (r.bbox.y + r.bbox.h) <= fr.y + fr.h && r.bbox.y >= fr.y);

        if (smallFont || patternMatch || inColoredBand) {
            r.type = inTop ? RegionType.HEADER : RegionType.FOOTER;
            // CRITICAL: headers and footers are always full-width — reset columnIndex.
            // The post-pass runs after column detection, so any ci=0/1 inherited from
            // the text classification step must be cleared, otherwise headers/footers
            // render inside column grid cells with an empty sibling column.
            r.columnIndex = -1;
        }
    }

    return { regions, textMeta, columnSplits: rawSplits };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Classify a bucket of Y-band lines into typed regions and append to regions[].
 * columnIndex: -1 = full-width / no column, 0 = leftmost column, 1 = next, etc.
 */
function _classifyBucket(regions, lines, bodyFontSizePt, scale, columnIndex) {
    let currentBlock = [];
    let currentType = null;

    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const lineStr = line.items.map(tm => tm.str.trim()).join(' ').trim();
        if (!lineStr) continue;

        const lineFontSize = line.items.reduce((s, tm) => s + tm.fontSize, 0) / line.items.length;

        let lineType;
        if (lineFontSize > bodyFontSizePt * scale.HEADING_SCALE) {
            lineType = RegionType.HEADING;
        } else if (BULLET_RE.test(lineStr) || ORDERED_RE.test(lineStr)) {
            lineType = RegionType.LIST;
        } else {
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

    for (const l of lines) l.items.sort((a, b) => a.vx - b.vx);
    lines.sort((a, b) => a.y - b.y);
    return lines;
}

/**
 * Detect page column split points using band-level full-width filtering.
 *
 * Returns { splits: number[], fullWidthIndices: Set<number> }
 *
 * The key insight: individual text items can be narrow while their visual
 * line collectively spans both columns (e.g. a WARNING paragraph with 37
 * items spread from x=57 to x=864). Filtering by individual vWidth misses
 * these. Instead, group items into Y-bands and exclude bands whose total
 * X span exceeds 65% of the page width — those are full-width rows.
 * Only narrow bands (clearly left-only or right-only content) are used
 * to find the column gutter.
 */
function _detectPageColumns(textMeta, viewport, scale) {
    if (!textMeta.length || !viewport?.width) {
        return { splits: [], fullWidthIndices: new Set() };
    }

    const vpWidth = viewport.width;

    // Group items into Y-bands
    const sorted = [...textMeta].sort((a, b) => a.vy - b.vy);
    const bands = [];
    for (const tm of sorted) {
        let placed = false;
        for (const band of bands) {
            if (Math.abs(band.y - tm.vy) <= scale.yBandTolPx) {
                const n = band.items.length;
                band.y = (band.y * n + tm.vy) / (n + 1);
                band.items.push(tm);
                placed = true;
                break;
            }
        }
        if (!placed) bands.push({ y: tm.vy, items: [tm] });
    }

    // Classify each band as narrow (column-specific) or wide (full-width).
    // Wide bands: total X span of their items exceeds 55% of page width.
    // Using 55% (not 65%) catches bands where one item spans from the left
    // column into the right column territory (e.g. a long paragraph sentence
    // starting at x=57 with rendered width=550px), which would erase the gutter.
    const WIDE_BAND_FRAC = 0.55;
    const fullWidthIndices = new Set();
    const narrowBands = [];

    for (const band of bands) {
        let minX = Infinity, maxX = -Infinity;
        for (const tm of band.items) {
            if (tm.vx < minX) minX = tm.vx;
            const re = tm.vx + (tm.vWidth || 0);
            if (re > maxX) maxX = re;
        }
        if (maxX - minX > vpWidth * WIDE_BAND_FRAC) {
            for (const tm of band.items) fullWidthIndices.add(tm.idx);
        } else {
            narrowBands.push(band);
        }
    }

    if (!narrowBands.length) return { splits: [], fullWidthIndices };

    // Per-band coverage: bandCount[x] = how many narrow bands cover pixel x.
    // Per-band counting (not per-item) prevents dense bands from swamping the
    // signal: a left-column band with 10 items still counts as 1 at x=200,
    // same as a right-column band with 1 item at x=473. This makes the gutter
    // visible even when left and right columns have very different item densities.
    const w = Math.ceil(vpWidth);
    const bandCount = new Float32Array(w);
    for (const band of narrowBands) {
        const seen = new Uint8Array(w);
        for (const tm of band.items) {
            const x1 = Math.max(0, Math.floor(tm.vx));
            const x2 = Math.min(w - 1, Math.ceil(tm.vx + (tm.vWidth || 0)));
            for (let x = x1; x <= x2; x++) seen[x] = 1;
        }
        for (let x = 0; x < w; x++) bandCount[x] += seen[x];
    }

    // Gutter = X range where fewer than 20% of narrow bands have any coverage.
    // 20% is robust to single-column (no such range), asymmetric 2-column, and
    // 3-column layouts.
    const threshold = narrowBands.length * 0.20;
    const minGap = Math.max(10, scale.colGapMinPx * 0.5);
    const candidates = [];
    let gStart = null;

    const xLo = Math.floor(vpWidth * scale.MARGIN_FLOOR);
    const xHi = Math.ceil(vpWidth * (1 - scale.MARGIN_FLOOR));
    for (let x = xLo; x < xHi; x++) {
        if (bandCount[x] < threshold) {
            if (gStart === null) gStart = x;
        } else if (gStart !== null) {
            if (x - gStart >= minGap) candidates.push((gStart + x) / 2);
            gStart = null;
        }
    }

    // Keep only splits that actually separate items across enough lines
    // We already checked this conceptually, but ensuring fractions is useful.
    const validSplits = candidates;

    return { 
        splits: validSplits.map(sx => ({
            x: sx,
            leftFraction: sx / vpWidth,
            rightFraction: 1 - (sx / vpWidth)
        })), 
        fullWidthIndices 
    };
}

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

    return buckets.filter(b => b.length > 0);
}
