// ocrScale.js — natural-unit scale for the OCR path.
//
// Sibling of extraction/vector/pageScale.js, and the same doctrine: S is the
// body text height in pixels, and every threshold is a dimensionless multiple
// of S so the pipeline adapts to any DPI or surface size instead of carrying
// hardcoded px magic numbers.
//
// It cannot BE PageScale. PageScale derives S from `textMeta` — the PDF text
// layer — and a scanned page has none; that is the whole reason it is in the
// OCR path at all. So S is measured from a detection probe instead of from
// text items. Same unit, different instrument.
//
// The constant this replaces is PP-OCR's `DET_MAX_SIDE = 960`, applied
// regardless of surface size. On a 3429x5447 scan that is a 5.7x downsample,
// which puts body text under the detector's resolvable stroke width — the
// boxes are never proposed, so it presents as a recognition failure one stage
// after the stage that actually failed.

// Detector-space body height below which detection starts dropping lines.
// Expressed as the target for S, not as a page dimension.
export const S_TARGET_PX = 10;

// Detection is quadratic in side length, so the probe is allowed to raise the
// cap but never without bound.
export const DET_MIN_SIDE = 960;
export const DET_MAX_SIDE_CEILING = 1920;

/**
 * S for a detection result, in DETECTOR pixels.
 *
 * Median, not mode: a probe pass returns few boxes and mode needs a populated
 * histogram to be stable. Median over line heights is robust to the handful of
 * headings and rules that come back with them.
 *
 * @param {Array<{rect:{h:number}}>} boxes  detection boxes, in SOURCE coords
 * @param {number} ratio  source -> detector scale used for the probe
 * @returns {number|null} null when there is nothing to measure from
 */
export function measureS(boxes, ratio) {
    const heights = boxes
        .map((b) => (b.rect ? b.rect.h : 0) * ratio)
        .filter((h) => h > 1)
        .sort((a, b) => a - b);
    if (!heights.length) return null;
    return heights[Math.floor(heights.length / 2)];
}

/**
 * The detector cap this surface actually needs.
 *
 * Returns the current cap unchanged when S is already at target — the common
 * case, so an ordinary page pays for the probe and nothing else.
 *
 * @param {number} currentCap  cap used for the probe
 * @param {number|null} S      measured body height in detector px
 * @returns {{cap:number, S:number|null, starved:boolean}}
 */
export function requiredCap(currentCap, S) {
    if (!S || S >= S_TARGET_PX) return { cap: currentCap, S, starved: false };
    const wanted = currentCap * (S_TARGET_PX / S);
    const cap = Math.round(Math.min(DET_MAX_SIDE_CEILING, Math.max(DET_MIN_SIDE, wanted)));
    return { cap, S, starved: cap > currentCap };
}

/**
 * Fraction of the page's ink that falls inside a detected box.
 *
 * This is the starvation test, and it replaces measuring S from the detection
 * output — which is circular. When the detector is starved it does not return
 * small boxes, it returns NO boxes for the small text, so the surviving boxes
 * are the large ones and the median height they imply is biased upward by
 * exactly the lines that went missing. Measured that way a starved page looks
 * healthy: report1925 reported S = 10.5 while dropping two thirds of its words.
 *
 * Ink coverage asks the question directly — is there dark pixel mass the
 * detector did not claim? — and is independent of what detection returned.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas  the OCR surface
 * @param {Array<{rect:{cx,cy,w,h,angle}}>} boxes     detection boxes, source coords
 * @returns {{coverage:number, ink:number}}  coverage 0..1; ink = dark fraction
 */
export function inkCoverage(canvas, boxes) {
    const W = 320;
    const H = Math.max(1, Math.round((canvas.height / canvas.width) * W));
    const c = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(W, H)
        : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;

    // Mark box interiors on a parallel mask at the same scale. Axis-aligned
    // bounds of the rotated rect are enough — this is a coverage estimate, and
    // over-claiming slightly makes the test conservative (fewer false alarms).
    const sx = W / canvas.width, sy = H / canvas.height;
    const mask = new Uint8Array(W * H);
    for (const b of boxes) {
        const r = b.rect || b;
        const halfW = (r.w || 0) / 2, halfH = (r.h || 0) / 2;
        const x0 = Math.max(0, Math.floor((r.cx - halfW) * sx));
        const x1 = Math.min(W - 1, Math.ceil((r.cx + halfW) * sx));
        const y0 = Math.max(0, Math.floor((r.cy - halfH) * sy));
        const y1 = Math.min(H - 1, Math.ceil((r.cy + halfH) * sy));
        for (let y = y0; y <= y1; y++) mask.fill(1, y * W + x0, y * W + x1 + 1);
    }

    let ink = 0, covered = 0;
    for (let i = 0, p = 0; i < px.length; i += 4, p++) {
        // Luma; the surfaces here are grey or bilevel so the green channel
        // alone would do, but this costs nothing and is right for colour scans.
        const v = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114);
        if (v < 160) { ink++; if (mask[p]) covered++; }
    }
    return { coverage: ink ? covered / ink : 1, ink: ink / (W * H) };
}

/** Below this share of ink claimed, detection is judged starved. */
export const COVERAGE_TARGET = 0.62;

/**
 * @param {number} currentCap
 * @param {number} coverage  from inkCoverage()
 */
export function capForCoverage(currentCap, coverage) {
    if (coverage >= COVERAGE_TARGET) return { cap: currentCap, coverage, starved: false };
    // Scale the cap by the shortfall, bounded. A page claiming half its ink
    // gets roughly double the detector budget.
    const wanted = currentCap * Math.min(2, COVERAGE_TARGET / Math.max(coverage, 0.15));
    const cap = Math.round(Math.min(DET_MAX_SIDE_CEILING, Math.max(DET_MIN_SIDE, wanted)));
    return { cap, coverage, starved: cap > currentCap };
}
