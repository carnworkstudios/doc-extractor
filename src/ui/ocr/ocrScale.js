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

// ── FORENSIC EVIDENCE IN THE CAP DECISION ───────────────────────────────────
//
// `capForCoverage` above asks one question — is there ink the detector did not
// claim? — and it is the right question, but it cannot answer a second one that
// matters just as much: WHY.
//
// A page can fail the coverage test for two completely different reasons:
//
//   * the detector was starved of resolution. More detector budget fixes it,
//     and that is exactly what the cap increase buys.
//   * the page is blurred, warped or skewed past what any resolution recovers.
//     More budget buys nothing here. Detection is quadratic in side length, so
//     the pipeline pays 4x the time to get the same starved result, on the
//     pages that are already the slowest in the corpus.
//
// The forensic head measures precisely the difference. It is direct evidence
// about the second case and it is available for free — it comes out of the same
// inference pass as the layout regions.
//
// THE DOCTRINE IS UNCHANGED. Everything below is a dimensionless multiple of a
// measured quantity:
//   * `blur` is a Gaussian sigma in detector pixels, so `blur / S` is "how many
//     body-text heights wide is the point spread". That ratio is the same
//     number on a 300 dpi scan and a 1200 dpi one, which a px threshold is not.
//   * `skew` is in degrees, which is already scale-free.
//   * `warp` is already a fraction of the page side.
// No new pixel constant is introduced anywhere in this block.

/**
 * Blur, as a fraction of body-text height.
 *
 * This is the number that decides whether more resolution can help. A point
 * spread narrower than a small fraction of a glyph leaves the strokes separable
 * and the detector simply needs more pixels; a point spread comparable to the
 * glyph has already merged the strokes and no amount of upsampling puts them
 * back.
 */
export function blurInS(blurSigma, S) {
    if (!(S > 0) || !(blurSigma > 0)) return 0;
    return blurSigma / S;
}

/**
 * Above this blur-to-S ratio, raising the detector cap is judged not to help.
 *
 * Set at one quarter of a body-text height. At S = 10 px — the S_TARGET_PX this
 * module already targets — that is a sigma of 2.5 px, which is wide enough for
 * a Gaussian to bridge the counters of 10 px type. Below it the strokes are
 * still distinguishable and resolution is the binding constraint; above it they
 * are not, and it is not.
 */
export const BLUR_S_CEILING = 0.25;

/** Beyond this skew, in degrees, axis-aligned detection is degrading. */
export const SKEW_DEG_CEILING = 4.0;

/** Beyond this corner displacement (fraction of page side), likewise. */
export const WARP_CEILING = 0.05;

/**
 * The cap decision, with forensic evidence folded in.
 *
 * Supersedes `capForCoverage` for callers that have a forensic reading, and
 * DELEGATES to it when they do not — the two must not diverge, and a second
 * copy of the coverage arithmetic is how they would.
 *
 * The forensic signals never RAISE the cap on their own. Low coverage remains
 * the only thing that asks for more budget; the signals can only decline the
 * request, and they must say why. That asymmetry is deliberate: a wrong
 * forensic reading can then cost a missed upscale (recoverable, visible in the
 * coverage number) but never a 4x slowdown on every page of a document.
 *
 * @param {number} currentCap
 * @param {number} coverage   from inkCoverage()
 * @param {number|null} S     measured body height in detector px, or null
 * @param {object|null} forensic  physical values from
 *        extraction/forensics/signals.js readSignals(); null when the loaded
 *        layout model has no forensic head. NULL IS NOT "CLEAN" — it is
 *        "unknown", and the function falls back to coverage alone.
 * @returns {{cap, coverage, starved, blocked, reason, evidence}}
 */
export function capForEvidence(currentCap, coverage, S, forensic) {
    const base = capForCoverage(currentCap, coverage);
    if (!base.starved) {
        return { ...base, blocked: false, reason: null, evidence: null };
    }
    if (!forensic) {
        // No forensic head on this model. Behave exactly as before rather than
        // inventing a reading — the whole point of the flag is that the
        // incumbent path is unchanged.
        return { ...base, blocked: false, reason: null, evidence: null };
    }

    const bS = blurInS(forensic.blur, S);
    const skew = Math.abs(forensic.skew || 0);
    const warp = forensic.warp || 0;
    const evidence = {
        blurInS: +bS.toFixed(3), skewDeg: +skew.toFixed(2), warp: +warp.toFixed(4),
        S, coverage: +coverage.toFixed(3),
    };

    const reasons = [];
    if (bS > BLUR_S_CEILING) {
        reasons.push(`point spread is ${bS.toFixed(2)} body heights wide `
            + `(ceiling ${BLUR_S_CEILING})`);
    }
    if (skew > SKEW_DEG_CEILING) reasons.push(`page is skewed ${skew.toFixed(1)}deg`);
    if (warp > WARP_CEILING) reasons.push(`page is warped by ${(warp * 100).toFixed(1)}% of its side`);

    if (!reasons.length) {
        // Starved AND physically fine: this is the case the cap increase was
        // written for, and the forensic head has just confirmed it.
        return { ...base, blocked: false,
                 reason: 'coverage is low and the page is physically sound: '
                     + 'resolution is the binding constraint',
                 evidence };
    }

    // Blocked. The cap stays where it is and the caller is TOLD why, so a page
    // that comes back with poor text is not mistaken for a page with little
    // text — the same distinction inkCoverage() was written to preserve.
    return {
        cap: currentCap, coverage, starved: true, blocked: true,
        reason: `detection is starved but more resolution will not recover it: ${reasons.join('; ')}`,
        evidence,
    };
}
