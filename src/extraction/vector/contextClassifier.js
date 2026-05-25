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
import { readStructTree } from './structTreeReader.js';

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
    const rawStructTree = opts.structTree  ?? null;
    const OPS           = opts.OPS         ?? null;
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

    // Natural-unit scale: S = mode body font in viewport-px.
    // All thresholds derive from S — no hardcoded px values below.
    const scale = new PageScale(textMeta, viewport);
    if (opts.headingScale !== undefined) scale.HEADING_SCALE = opts.headingScale;
    const tablePad = opts.tablePad ?? scale.tablePadPx;

    // ── Tier 1: Structure tree (highest fidelity) ─────────────────────────────
    // If the PDF has a populated struct tree with Table/TR/TD nodes, extract
    // those regions directly and record which text items they claimed.
    // Struct regions bypass all Tier 2/3 heuristics for the table zones they cover.
    // columnHint (optional X) is passed down as a seed for the Tier 2 vSeg search.
    let structTableIndices = new Set(); // items claimed by Tier 1 — excluded from Tier 3
    let columnHintX = null;

    if (rawStructTree && OPS) {
        try {
            const { structRegions, hasTable, columnHint } = readStructTree(
                rawStructTree, opts._opList ?? null, textMeta, OPS
            );
            if (hasTable && structRegions.length > 0) {
                for (const sr of structRegions) {
                    // Mark all text items claimed by struct table regions
                    for (const idx of sr.textItemIndices) structTableIndices.add(idx);
                }
                // Struct regions will be merged into the final regions array below,
                // after the geometry pipeline runs on the unclaimed content.
                opts._structRegions = structRegions;
            }
            columnHintX = columnHint ?? null;
        } catch (_) {}
    }

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
    // Filter: skip tiny decorative elements (icons, glyphs, bullets < 20×20px).
    // Merge: overlapping/adjacent images from the same visual cluster collapse
    // into one representative region so a diagram isn't 300 separate tiles.
    const MIN_IMG_DIM = 20; // viewport pixels
    const MERGE_GAP   = 8;  // px gap within which adjacent images are merged

    const significantImages = imageMeta.filter(img =>
        img.bbox.w >= MIN_IMG_DIM && img.bbox.h >= MIN_IMG_DIM
    );

    // Sort by top-left reading order for stable merging
    significantImages.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);

    const mergedImages = [];
    for (const img of significantImages) {
        const { x, y, w, h } = img.bbox;
        const right  = x + w;
        const bottom = y + h;
        // Find an existing merged cluster this image overlaps or touches
        const cluster = mergedImages.find(c =>
            x <= c.right  + MERGE_GAP &&
            right  >= c.x - MERGE_GAP &&
            y <= c.bottom + MERGE_GAP &&
            bottom >= c.y - MERGE_GAP
        );
        if (cluster) {
            cluster.x      = Math.min(cluster.x,      x);
            cluster.y      = Math.min(cluster.y,      y);
            cluster.right  = Math.max(cluster.right,  right);
            cluster.bottom = Math.max(cluster.bottom, bottom);
        } else {
            mergedImages.push({ id: img.id, x, y, right, bottom });
        }
    }

    for (const c of mergedImages) {
        const bbox = { x: c.x, y: c.y, w: c.right - c.x, h: c.bottom - c.y };
        regions.push({
            type: RegionType.IMAGE,
            id: c.id,
            bbox,
            textItemIndices: [],
            yCenter: bbox.y + bbox.h / 2,
            columnIndex: -1
        });
    }

    // ── 3. Detect lattice table regions ──────────────────────────────────────
    const reconstructor = new LatticeReconstructor(tableSegs, { eps: 5, scale, textMeta, pageHeight: viewport.height });
    const lattices = reconstructor.reconstructAll();


    // Pre-seed assignedTextIndices with items claimed by Tier 1 struct regions,
    // so Tier 3 doesn't emit duplicate paragraph/heading regions over table cells.
    const assignedTextIndices = new Set(structTableIndices);

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
    // ── Tier 2: Vertical rule column detection ───────────────────────────────
    // A vSeg spanning ≥60% of content height at a plausible column X is a
    // geometric fact — authoritative evidence of a column boundary. When present,
    // use it directly and skip the bipartite inference entirely.
    //
    // Content height: from the top of the topmost text item to the bottom of the
    // bottommost, clamped within the page margins. vSegs that hug the page edges
    // (x < 10% or x > 90% of viewport width) are decorative borders, not gutters.
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
        // Tier 2 path: convert each column rule to a split object and compute
        // left/right fractions for CSS grid proportions.
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
        // fullWidthIndices: items that straddle a column rule
        for (const tm of remainingMeta) {
            const itemEnd = tm.vx + (tm.vWidth || 0);
            const bridgesAny = rawSplits.some(sp => tm.vx < sp.x && itemEnd > sp.x);
            if (bridgesAny) fullWidthIndices.add(tm.idx);
        }
    } else if (columnHintX !== null) {
        // Tier 1 column hint: struct tree reading order detected a column boundary.
        // No full-height vSeg confirmed it geometrically, but the struct tree is
        // a direct encoding of the author's intent. Use the hint X as a split.
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
        // Tier 3 path: bipartite text-gap inference
        const bipartite = _detectPageColumns(remainingMeta, viewport, scale);
        rawSplits = bipartite.splits;
        fullWidthIndices = bipartite.fullWidthIndices;
    }

    // ── Fallback: BOX / TABLE regions can claim all right-column text items, leaving
    // only left-column items for gutter detection → no split found.  If unclaimed items
    // alone showed no gutter, retry with the FULL textMeta pool (including claimed items).
    // This recovers the real column split without changing which items belong to which region.
    // Only applies to the Tier 3 path — Tier 2 column rules are definitive.
    if (rawSplits.length === 0 && columnRules.length === 0) {
        const allNonEmpty = textMeta.filter(tm => tm.str.trim());
        if (allNonEmpty.length > remainingMeta.length + 4) { // claimed items exist
            const { splits: fallbackSplits } = _detectPageColumns(allNonEmpty, viewport, scale);
            rawSplits.push(...fallbackSplits);
        }
    }

    const columnSplits = rawSplits.map(s => s.x);

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

    // ── 8. Merge Tier 1 struct regions ───────────────────────────────────────
    // Struct table regions are inserted now, after Tier 2/3 has processed all
    // unclaimed content. Any geometry-derived region whose center falls inside
    // a struct table bbox is dropped (the struct tree is authoritative there).
    if (opts._structRegions?.length) {
        for (const sr of opts._structRegions) {
            // Drop Tier 3 regions that are fully contained within this struct region
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

    // ── 9. Sort all regions top→bottom ───────────────────────────────────────
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
 * Returns { splits: [{x, leftFraction, rightFraction}][], fullWidthIndices: Set<number> }
 *
 * Bipartite band partition (v3): item-level interval merge to find candidates,
 * three structural gates to validate each candidate.
 *
 * Candidate generation operates on individual items, not bands. A band
 * aggregating items from both columns (same Y-line) has a combined span that
 * bridges the gutter even though no single item does. Item-level intervals
 * preserve per-item width and avoid this false bridge. Three item classes are
 * excluded before the merge:
 *   - Wide items (vWidth > 55% of page): full-page headings/footers/notices
 *   - Noise glyphs (vWidth < 0.5 × S): sub-character artifacts
 *   - Running page numbers (/^\d{1,3}$/ AND vWidth < 2 × S): digits that sit
 *     in the physical gutter zone of 2-column documents
 *
 * Gate evaluation uses all bands (not just narrow) with per-item predicates:
 *   Gate 1 — ≥3 bands entirely left AND ≥3 entirely right
 *   Gate 2 — ≥40% commitment within the coexistence Y-span (intersection, not union)
 *   Gate 3 — both populations not both confined to top 20% of content height
 */
const _PAGE_NUM_RE = /^\d{1,3}$/;

function _detectPageColumns(textMeta, viewport, scale, { dropGate3 = false } = {}) {
    if (!textMeta.length || !viewport?.width) {
        return { splits: [], fullWidthIndices: new Set() };
    }

    const vpWidth = viewport.width;

    // ── Y-band grouping (for gate evaluation and fullWidthIndices) ────────────
    const sorted = [...textMeta].sort((a, b) => a.vy - b.vy);
    const bands = [];
    for (const tm of sorted) {
        let placed = false;
        for (const band of bands) {
            if (Math.abs(band.y - tm.vy) <= scale.yBandTolPx) {
                band.y = (band.y * band.items.length + tm.vy) / (band.items.length + 1);
                band.items.push(tm);
                placed = true;
                break;
            }
        }
        if (!placed) bands.push({ y: tm.vy, items: [tm] });
    }

    // ── fullWidthIndices: bands whose item X-span exceeds WIDE_BAND_FRAC ─────
    const WIDE_BAND_FRAC   = 0.55;
    const fullWidthIndices = new Set();
    for (const band of bands) {
        const minX = Math.min(...band.items.map(i => i.vx));
        const maxX = Math.max(...band.items.map(i => i.vx + (i.vWidth || 0)));
        if (maxX - minX > vpWidth * WIDE_BAND_FRAC) {
            for (const tm of band.items) fullWidthIndices.add(tm.idx);
        }
    }

    // ── Candidate generation: item-level interval merge ───────────────────────
    // WIDE_ITEM (55% vp) is the band-level threshold for fullWidthIndices.
    // MERGE_ITEM (40% vp) is stricter: excludes cross-column titles and display-math
    // spans that would absorb the real gutter in the interval merge. Normal column
    // body text is ≈20-35% of viewport width on a 2-column page so 40% is safe.
    const WIDE_ITEM   = vpWidth * WIDE_BAND_FRAC;
    const MERGE_ITEM  = vpWidth * 0.40;
    const NOISE_FLOOR = scale.S * 0.5;
    const tol         = Math.max(4, scale.colGapMinPx * 0.5);

    const structItems = textMeta.filter(i => {
        const w = i.vWidth || 0;
        if (w <= NOISE_FLOOR) return false;
        if (w > MERGE_ITEM)   return false;
        if (_PAGE_NUM_RE.test(i.str.trim()) && w < scale.S * 2) return false;
        return true;
    });

    const sortedItems = [...structItems].sort((a, b) => a.vx - b.vx);
    const spans = [];
    for (const tm of sortedItems) {
        const lo = tm.vx, hi = tm.vx + (tm.vWidth || 0);
        if (spans.length && lo <= spans.at(-1).hi + 2) {
            spans.at(-1).hi = Math.max(spans.at(-1).hi, hi);
        } else {
            spans.push({ lo, hi });
        }
    }

    const rawCandidates = [];
    for (let i = 0; i + 1 < spans.length; i++) {
        const gap    = spans[i + 1].lo - spans[i].hi;
        const center = (spans[i].hi + spans[i + 1].lo) / 2;
        if (gap >= scale.colGapMinPx && center >= vpWidth * 0.10 && center <= vpWidth * 0.90) {
            rawCandidates.push(center);
        }
    }

    // ── Left-edge cluster gap: width-agnostic column boundary detection ────────
    // Some pages have centered cross-column items (author lines, section headings)
    // whose wide extent absorbs the gutter in the span merge above. Looking only at
    // where items START (vx) reveals the column boundary as a gap in start positions.
    // This is independent of item width and immune to cross-column spanning items.
    // Guard: the candidate gap must be at least 3× the median inter-item gap and
    // ≥ colGapMinPx, and it must be the dominant gap (≥ 2× second-largest gap) to
    // avoid false splits from natural intra-column spacing variation.
    if (!rawCandidates.length && structItems.length >= 10) {
        // Bin vx into 2px buckets to collapse sub-pixel jitter, then find gaps
        const binned = [...new Set(sortedItems.map(i => Math.round(i.vx / 2) * 2))].sort((a,b)=>a-b);
        const gaps = [];
        for (let i = 1; i < binned.length; i++) gaps.push({ g: binned[i]-binned[i-1], x: (binned[i-1]+binned[i])/2 });
        gaps.sort((a,b) => b.g - a.g);
        if (gaps.length >= 2) {
            const best = gaps[0], second = gaps[1];
            if (best.g >= scale.colGapMinPx * 1.5   // at least 1.5× min column gap
                && best.g >= second.g * 2.0          // dominant gap (2× runner-up)
                && best.x >= vpWidth * 0.15 && best.x <= vpWidth * 0.85) {
                rawCandidates.push(best.x);
            }
        }
    }

    // ── Fallback: minimum-crossing scan with left/right endpoint snapping ────
    // If the interval merge found no clean gap, some items straddle the column
    // gutter (cross-column captions, table titles, figure labels). Scan for the
    // X with fewest crossing struct items. If that minimum is ≤ 6% of items,
    // a real gutter exists. Snap the candidate to the midpoint between the
    // rightmost left-column endpoint and leftmost right-column start in the
    // neighborhood of the scan minimum.
    if (!rawCandidates.length && structItems.length >= 6) {
        // structItems already excludes items wider than 40% of viewport (MERGE_ITEM).
        // Scan range: from first item's vx + colGapMinPx to last item's vx - colGapMinPx,
        // clipped to 15%-85% of viewport. This prevents bestX landing at the page edge
        // where crossing count is trivially 0 but no left-side items exist.
        const itemVxMin = Math.min(...structItems.map(i => i.vx));
        const itemVxMax = Math.max(...structItems.map(i => i.vx));
        const scanLo = Math.max(vpWidth * 0.15, itemVxMin + scale.colGapMinPx);
        const scanHi = Math.min(vpWidth * 0.85, itemVxMax - scale.colGapMinPx);

        if (scanLo < scanHi) {
            const scanStep = Math.max(4, scale.colGapMinPx / 4);
            let minCross = Infinity, bestX = -1;
            for (let X = scanLo; X <= scanHi; X += scanStep) {
                const left  = structItems.filter(i => i.vx < X - tol).length;
                const right = structItems.filter(i => i.vx >= X + tol).length;
                if (left < 3 || right < 3) continue; // need items on both sides
                const crossing = structItems.filter(i => {
                    const lo = i.vx, hi = i.vx + (i.vWidth || 0);
                    return lo < X - tol && hi > X + tol;
                }).length;
                if (crossing < minCross) { minCross = crossing; bestX = X; }
            }
            if (bestX > 0) {
                const scanCross = structItems.filter(i => {
                    const lo = i.vx, hi = i.vx + (i.vWidth || 0);
                    return lo < bestX - tol && hi > bestX + tol;
                }).length;
                const MAX_CROSS = Math.max(1, Math.ceil(structItems.length * 0.06));
                if (scanCross <= MAX_CROSS) {
                    const leftEnd = structItems
                        .filter(i => (i.vx + (i.vWidth || 0)) <= bestX + tol)
                        .reduce((m, i) => Math.max(m, i.vx + (i.vWidth || 0)), -Infinity);
                    const rightStart = structItems
                        .filter(i => i.vx > bestX)
                        .reduce((m, i) => Math.min(m, i.vx), Infinity);

                    let candidate = bestX;
                    if (leftEnd > -Infinity && rightStart < Infinity && rightStart > leftEnd) {
                        candidate = (leftEnd + rightStart) / 2;
                    }
                    if (candidate >= vpWidth * 0.15 && candidate <= vpWidth * 0.85) {
                        rawCandidates.push(candidate);
                    }
                }
            }
        }
    }

    if (!rawCandidates.length) return { splits: [], fullWidthIndices };

    // ── Gate 3 pre-compute: content span from all bands ───────────────────────
    const PERSIST_FRAC  = 0.20;
    const contentTop    = Math.min(...bands.map(b => b.y));
    const contentBottom = Math.max(...bands.map(b => b.y));
    const persistThresh = contentTop + (contentBottom - contentTop || 1) * PERSIST_FRAC;

    // ── Evaluate each candidate ───────────────────────────────────────────────
    const MIN_SIDE       = 3;
    const MIN_COMMITMENT = 0.40;
    const validSplits    = [];

    for (const X of rawCandidates) {
        // Band is "entirely left" only if ALL its items end before X - tol
        const leftOnly  = bands.filter(b => b.items.every(i => (i.vx + (i.vWidth || 0)) <= X - tol));
        const rightOnly = bands.filter(b => b.items.every(i => i.vx >= X + tol));

        // Gate 1 — population on both sides
        if (leftOnly.length < MIN_SIDE || rightOnly.length < MIN_SIDE) continue;

        // Gate 2 — coexistence Y-span commitment (intersection, not union)
        const coexistTop    = Math.max(Math.min(...leftOnly.map(b => b.y)), Math.min(...rightOnly.map(b => b.y)));
        const coexistBottom = Math.min(Math.max(...leftOnly.map(b => b.y)), Math.max(...rightOnly.map(b => b.y)));
        if (coexistBottom < coexistTop) continue;
        const localBands = bands.filter(b => b.y >= coexistTop && b.y <= coexistBottom);
        if (!localBands.length || (leftOnly.length + rightOnly.length) / localBands.length < MIN_COMMITMENT) continue;

        // Gate 3 — vertical persistence relative to content span.
        // Skipped for zone-scoped calls: the zone boundary is the persistence window.
        if (!dropGate3 &&
            leftOnly.every(b => b.y <= persistThresh) &&
            rightOnly.every(b => b.y <= persistThresh)) continue;

        // Gate 4 — left column must include at least one band anchored near the
        // page's left text margin. The leftmost left-only band must start within
        // 2 × colGapMinPx of the global minimum vx. Prevents false splits where
        // the "left column" is a cluster of items adrift in the page body.
        const leftMarginX    = Math.min(...bands.flatMap(b => b.items.map(i => i.vx)));
        const leftAnchorTol  = scale.colGapMinPx * 2;
        const leftMinStart   = Math.min(...leftOnly.flatMap(b => b.items.map(i => i.vx)));
        if (leftMinStart > leftMarginX + leftAnchorTol) continue;

        validSplits.push(X);
    }

    // ── Deduplicate adjacent splits (same physical gutter detected twice) ─────
    function _commitRatio(X, allBands, tolerance) {
        const left  = allBands.filter(b => b.items.every(i => (i.vx + (i.vWidth || 0)) <= X - tolerance));
        const right = allBands.filter(b => b.items.every(i => i.vx >= X + tolerance));
        if (!left.length || !right.length) return 0;
        const cTop = Math.max(Math.min(...left.map(b => b.y)),  Math.min(...right.map(b => b.y)));
        const cBot = Math.min(Math.max(...left.map(b => b.y)),  Math.max(...right.map(b => b.y)));
        if (cBot < cTop) return 0;
        const local = allBands.filter(b => b.y >= cTop && b.y <= cBot);
        return local.length ? (left.length + right.length) / local.length : 0;
    }

    const deduplicated = [];
    for (const X of validSplits) {
        const prev = deduplicated.at(-1);
        if (prev !== undefined && X - prev < scale.colGapMinPx) {
            if (_commitRatio(X, bands, tol) > _commitRatio(prev, bands, tol)) {
                deduplicated[deduplicated.length - 1] = X;
            }
        } else {
            deduplicated.push(X);
        }
    }

    return {
        splits: deduplicated.map(sx => ({
            x: sx,
            leftFraction:  sx / vpWidth,
            rightFraction: 1 - (sx / vpWidth),
        })),
        fullWidthIndices,
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

/**
 * Zone-scoped column detection: runs _detectPageColumns with Gate 3 dropped.
 *
 * Called by pageAssembler for each zone that the page-level pass returned as
 * single-column.  Gate 3 (vertical persistence) is irrelevant inside a bounded
 * zone — the zone boundary is already the persistence window.
 *
 * Guard: the zone must span at least MIN_ZONE_LINES body-text lines before Gate 3
 * is dropped.  Short zones (caption blocks, label clusters) keep Gate 3 active so
 * a 37-item caption band cannot produce a false split.
 *
 * @param {TextMetaItem[]} zoneTextMeta - text items whose vy falls inside the zone
 * @param {object}         viewport
 * @param {PageScale}      scale
 * @returns {{ splits: SplitResult[] }}
 */
export function detectZoneColumns(zoneTextMeta, viewport, scale) {
    if (!zoneTextMeta.length) return { splits: [] };

    const ys = zoneTextMeta.map(tm => tm.vy);
    const zoneHeight = Math.max(...ys) - Math.min(...ys);
    // Require zone to span at least 10 body-text lines before dropping Gate 3.
    // scale.S is body font size in viewport-px; line height ≈ 1.4 × S.
    const MIN_ZONE_HEIGHT = scale.S * 1.4 * 10;
    const dropGate3 = zoneHeight >= MIN_ZONE_HEIGHT;

    return _detectPageColumns(zoneTextMeta, viewport, scale, { dropGate3 });
}
