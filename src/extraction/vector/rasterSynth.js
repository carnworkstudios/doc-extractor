// rasterSynth.js
//
// Bridges the raster (scanned) world into the vector geometry pipeline.
//
// A scanned page has no operator list — nothing for ctmAdapter/classifyPage to
// read. This module takes what the raster path CAN produce:
//   • layout regions from layoutWorker (YOLOv8/DocLayNet): [{label, confidence, bbox}]
//   • per-region text from the OCR worker (TrOCR)
// and synthesizes the SAME record shapes the vector pipeline consumes:
//   • textItems   — PDF.js-shaped text items (str/transform/width/fontName), so
//                   classifyPage() + assemblePage() run unchanged
//   • filledRects — synthetic table-border rects for table-labelled regions, so
//                   the lattice/stream table detectors can reconstruct grids
//
// COORDINATE CONTRACT — the caller normalizes YOLOv8's 640×640 boxes into
// FRACTIONAL page coordinates in [0,1] before calling here. bbox = {x,y,w,h}
// with (0,0) = page TOP-LEFT, all values fractions of page width/height. This
// decouples synthesis from render scale and from the model's square-resize.
//
// classifyPage.toViewport (contextClassifier ~L58) reads:
//   text item transform = [_, _, _, fontSizePt, xPdf, yPdf]   (transform[3],[4],[5])
//   where (xPdf, yPdf) is the anchor in PDF space (origin BOTTOM-left), and
//   classifyPage applies viewport.transform itself. So we emit PDF-space points.

// DocLayNet labels treated as table grids (get synthetic borders).
const TABLE_LABELS = new Set(['table']);
// Labels dropped entirely — no transcribable body text.
const SKIP_LABELS = new Set(['picture', 'page-header', 'page-footer']);
// Labels that read as headings (bump font size so headingDetector fires).
const HEADING_LABELS = new Set(['title', 'section-heading']);

// Labels that become image regions in the analysis (rendered as image zones in
// analyzePanel, croppable). Tables ALSO get an image region so the original grid
// is viewable alongside the reconstructed one.
const IMAGE_LABELS = new Set(['picture', 'table']);

/** Center of a Tesseract word bbox {x0,y0,x1,y1} in render-pixel space. */
function wordCenter(b) {
    return { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 };
}

/**
 * Which YOLO label region (fractional bbox) contains a word center. Returns the
 * label string or 'text' if none. labelRegions bboxes are FRACTIONAL [0,1].
 */
function labelForWord(center, labelRegions, renderW, renderH) {
    const fx = center.cx / renderW;
    const fy = center.cy / renderH;
    for (const r of labelRegions) {
        const b = r.bbox;
        if (fx >= b.x && fx <= b.x + b.w && fy >= b.y && fy <= b.y + b.h) return r.label;
    }
    return 'text';
}

/**
 * Build synthetic PDF.js text items from Tesseract WORDS with real bboxes.
 * Each word → one text item at its true position (no line-splitting, no
 * synthesized geometry). This is the core win over TrOCR: Tesseract already
 * gives word-level position + confidence.
 *
 * Coordinate contract: word.bbox is render-PIXEL space, top-left origin.
 * classifyPage.toViewport reads transform[3]=fontSize, [4]=xPdf, [5]=yPdf in
 * PDF (bottom-left) space and applies viewport.transform itself.
 *
 * @param {Array<{text,bbox:{x0,y0,x1,y1},confidence}>} words — render-pixel bboxes
 * @param {Array<{label,bbox:{x,y,w,h}}>} labelRegions — YOLO, FRACTIONAL bbox
 * @param {object} geom — {
 *          pageWidthPt, pageHeightPt,      // PDF points
 *          renderWidth, renderHeight,      // px dims Tesseract saw
 *          viewportWidth, viewportHeight,  // classifyPage viewport px
 *        }
 * @returns {{ textItems, filledRects, hSegs, vSegs, imageRegions, imageMeta }}
 */
export function synthesizeFromWords(words, labelRegions, geom) {
    const { pageWidthPt, pageHeightPt, renderWidth, renderHeight, viewportWidth, viewportHeight } = geom;
    const sx = pageWidthPt / renderWidth;    // px → PDF pt
    const sy = pageHeightPt / renderHeight;

    const textItems = [];
    for (const w of words) {
        const str = (w.text || '').trim();
        if (!str) continue;
        const b = w.bbox;
        const label = labelForWord(wordCenter(b), labelRegions, renderWidth, renderHeight);
        const isHeading = HEADING_LABELS.has(label);

        const wPt = (b.x1 - b.x0) * sx;
        const hPt = (b.y1 - b.y0) * sy;
        const xPt = b.x0 * sx;
        // Word bottom in PDF space = pageHeight − (bottom pixel × sy). Baseline
        // sits ~near the bottom of the glyph box.
        const yBottomPt = pageHeightPt - (b.y1 * sy);
        const fontSizePt = Math.max(5, Math.min(60, hPt * 0.9));
        textItems.push({
            // Trailing space: Tesseract emits discrete WORDS, but the assembler
            // concatenates same-line text-item strings directly. Vector PDF.js
            // items carry their own inter-word space; mirror that so words don't
            // collapse (ExploringChemistry → Exploring Chemistry). Flow-joins
            // strip trailing whitespace, so this never double-spaces.
            str: str + ' ',
            transform: [fontSizePt, 0, 0, fontSizePt, xPt, yBottomPt + hPt * 0.1],
            width: wPt,
            height: fontSizePt,
            fontName: isHeading ? 'ocr-heading' : 'ocr-body',
            confidence: w.confidence,      // carried for the provenance/verifier spine
            dir: 'ltr',
        });
    }

    // Table borders + image regions come from YOLO labels (Tesseract has no
    // semantic 'this box is a table' notion).
    const filledRects = [];
    const imageRegions = [];
    for (const r of labelRegions) {
        if (TABLE_LABELS.has(r.label)) filledRects.push(...tableBorders(r.bbox, viewportWidth, viewportHeight));
        if (IMAGE_LABELS.has(r.label)) imageRegions.push(fracRect(r.bbox, viewportWidth, viewportHeight));
    }

    // Reading order: top-to-bottom (higher f first), then left-to-right.
    textItems.sort((a, b) => (b.transform[5] - a.transform[5]) || (a.transform[4] - b.transform[4]));

    // h/v segments from synthetic table borders (analyzePanel layers + lattice).
    const hSegs = [];
    const vSegs = [];
    for (const r of filledRects) {
        if (r.w >= r.h) hSegs.push({ x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y });
        else            vSegs.push({ x1: r.x, y1: r.y, x2: r.x, y2: r.y + r.h });
    }

    // classifyPage imageMeta wants {id,bbox:{...}}; analyzePanel wants flat.
    const imageMeta = imageRegions.map((r, i) => ({ id: `ocr-img-${i}`, bbox: r, inline: false }));

    return { textItems, filledRects, hSegs, vSegs, imageRegions, imageMeta };
}

/** Fractional (top-left) bbox → viewport-pixel rect {x,y,w,h}. */
function fracRect(bbox, vw, vh) {
    return { x: bbox.x * vw, y: bbox.y * vh, w: bbox.w * vw, h: bbox.h * vh };
}

/** Synthetic border rects for a table region (viewport px). */
function tableBorders(bbox, vw, vh) {
    const x = bbox.x * vw, y = bbox.y * vh, w = bbox.w * vw, h = bbox.h * vh;
    const T = 1.5;
    return [
        { x,         y,         w, h: T }, // top
        { x,         y: y+h-T,  w, h: T }, // bottom
        { x,         y,         w: T, h }, // left
        { x: x+w-T,  y,         w: T, h }, // right
    ];
}

/**
 * A minimal PDF.js-shaped viewport for classifyPage/assemblePage. Needs
 * .transform (PDF→viewport), .width, .height. Standard PDF.js rotation-0
 * transform flips Y: [scale, 0, 0, -scale, 0, height].
 */
export function makeSyntheticViewport(pageWidthPt, pageHeightPt, scale = 2.0) {
    const width = pageWidthPt * scale;
    const height = pageHeightPt * scale;
    return {
        transform: [scale, 0, 0, -scale, 0, height],
        width,
        height,
        scale,
    };
}
