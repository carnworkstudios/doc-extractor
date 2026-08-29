// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 carnworkstudios
// externalScorer.js — grade ANY extractor's regions against the source PDF.
//
// `extractionScorer.js` grades our own pipeline. Nothing in it is actually
// specific to our pipeline: it consumes `regions` (bboxes + types) and
// `textMeta` (the page's real text items, read straight from the PDF via
// pdf.js). The second input is ground truth that no extractor controls, which
// is what makes the comparison meaningful — it is not the pipeline marking its
// own homework.
//
// This module supplies the missing halves for a foreign extractor:
//   1. textMeta for a page, rebuilt from the source PDF;
//   2. a coordinate mapping from the caller's space into ours;
//   3. a composite that EXCLUDES the terms only our classifier can produce.
//
// ── On the composite ─────────────────────────────────────────────────────────
// scoreExtraction's `score` is 0.45·coverage + 0.20·(1−overlap) +
// 0.20·meanConfidence + 0.15·(1−fragmentation). Three of those four terms need
// nothing but boxes. `meanConfidence` needs OUR confidence semantics.
//
// Docling reports confidence too, and it would be trivial to average it in and
// return a single number that looks comparable to ours. It would not be
// comparable: two extractors' confidences are different quantities on
// differently-calibrated scales, and folding them into one composite produces a
// figure that ranks extractors by how optimistically they self-report.
//
// So `structuralScore` is built from the geometric terms only and is the number
// to compare across extractors. The extractor's own confidence is passed through
// untouched, under a name that says whose it is. See `scoreExternalPage` for why
// coverage gates the cleanliness terms rather than being averaged with them.

import { scoreExtraction } from './extractionScorer.js';

/** pdf.js viewport transform — PDF user space (bottom-left) → viewport (top-left). */
function toViewport(vpTransform, pdfX, pdfY) {
    return [
        vpTransform[0] * pdfX + vpTransform[2] * pdfY + vpTransform[4],
        vpTransform[1] * pdfX + vpTransform[3] * pdfY + vpTransform[5],
    ];
}

/**
 * Text items for one page, in the SAME space the classifier produces regions in.
 *
 * This deliberately mirrors contextClassifier's textMeta construction rather
 * than the cheaper scale-only approximation used by the DocScale pre-scan.
 * Those two are different spaces (the pre-scan keeps PDF's bottom-left origin),
 * and scoring foreign boxes against the wrong one would report a confident,
 * meaningless number — the exact failure this whole tool exists to prevent.
 *
 * @param {object} page — a pdf.js PDFPageProxy
 * @param {object} viewport — page.getViewport({ scale })
 */
export async function pageTextMeta(page, viewport) {
    const textContent = await page.getTextContent();
    const vpT = viewport.transform;
    const scaleX = Math.hypot(vpT[0], vpT[1]) || 1;
    const scaleY = Math.hypot(vpT[2], vpT[3]) || 1;

    return textContent.items
        .filter(i => i.str?.trim())
        .map((item, idx) => {
            const [vx, vy] = toViewport(vpT, item.transform[4], item.transform[5]);
            const fontSizePt = Math.abs(item.transform?.[3] || 12);
            const widthPt = item.width || (fontSizePt * 0.5 * (item.str?.length || 1));
            return {
                idx,
                str: item.str || '',
                vx, vy,
                vWidth: widthPt * scaleX,
                vFont: fontSizePt * scaleY,
                fontSize: fontSizePt,
                fontName: item.fontName || '',
            };
        });
}

/**
 * Supported input coordinate spaces for a foreign region's bbox.
 *
 * `fraction` is the recommended one and the default: {x, y, w, h} as fractions
 * of page width/height with a TOP-LEFT origin. It is unambiguous, needs no
 * knowledge of the producer's DPI, and survives a page-size change.
 *
 * `pdf-points` is Docling's native space: PDF user units, BOTTOM-LEFT origin,
 * y increasing upward. Named explicitly because the flip is the single most
 * likely thing to be wrong, and a silently-flipped page scores ~0 coverage,
 * which reads as "this extractor is terrible" rather than "you passed the
 * wrong space".
 */
export const REGION_SPACES = ['fraction', 'pdf-points', 'viewport'];

/**
 * Map one foreign bbox into viewport space.
 *
 * @param {object} bbox — {x, y, w, h} in `space`
 * @param {string} space — one of REGION_SPACES
 * @param {object} geom — {viewportWidth, viewportHeight, pageWidthPt, pageHeightPt, vpTransform}
 */
export function bboxToViewport(bbox, space, geom) {
    const x = Number(bbox?.x), y = Number(bbox?.y);
    const w = Number(bbox?.w), h = Number(bbox?.h);
    if (![x, y, w, h].every(Number.isFinite)) return null;

    if (space === 'viewport') return { x, y, w, h };

    if (space === 'fraction') {
        return {
            x: x * geom.viewportWidth,
            y: y * geom.viewportHeight,
            w: w * geom.viewportWidth,
            h: h * geom.viewportHeight,
        };
    }

    // pdf-points: two opposite corners through the real viewport transform, then
    // renormalised. Transforming the corners rather than scaling width/height
    // is what makes this correct for a rotated page — /Rotate 90 is common in
    // scanned documents and a scale-only mapping puts every box on its side.
    const [x1, y1] = toViewport(geom.vpTransform, x, y);
    const [x2, y2] = toViewport(geom.vpTransform, x + w, y + h);
    return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1),
        h: Math.abs(y2 - y1),
    };
}

/** Relative weight of the two cleanliness terms among themselves. */
const OVERLAP_W = 0.20;
const FRAGMENT_W = 0.15;
const CLEANLINESS_W = OVERLAP_W + FRAGMENT_W;

/**
 * Score one page of foreign regions against the source PDF's own text.
 *
 * @returns the full scoreExtraction report plus:
 *   structuralScore    — the comparable number (geometry only)
 *   reportedConfidence — the foreign extractor's mean confidence, or null
 *   space              — echoed, so a bad mapping is diagnosable from the output
 */
export function scoreExternalPage(regions, textMeta, viewport, space) {
    const report = scoreExtraction(regions, textMeta, viewport);

    // Coverage GATES cleanliness; it is not averaged with it.
    //
    // The obvious composite — renormalising scoreExtraction's three geometric
    // terms over their own weights — was measured on a deliberately useless
    // input: one 5%-of-the-page box on a full page of text. It covered nothing,
    // and scored 0.437, because a single tiny box overlaps nothing and
    // fragments nothing, collecting both cleanliness terms in full.
    //
    // That is backwards. Not overlapping is only a virtue if you claimed the
    // text in the first place. So cleanliness is a MULTIPLIER on coverage: an
    // extractor that finds everything and lays it out cleanly scores 1.0, one
    // that finds everything but double-claims half of it is discounted, and one
    // that finds nothing scores 0 no matter how tidily it did so.
    const cleanliness =
        (OVERLAP_W * (1 - report.overlapRatio) +
         FRAGMENT_W * (1 - report.fragmentation)) / CLEANLINESS_W;
    const structural = report.textCoverage * cleanliness;

    // Only average confidences the caller actually supplied. scoreExtraction
    // defaults a missing confidence to 1, which is right for its own purposes
    // (an unscored region is not evidence of a bad extraction) and wrong here —
    // it would report a foreign extractor that publishes no confidence as
    // perfectly confident.
    const declared = (regions || [])
        .map(r => r.confidence)
        .filter(c => typeof c === 'number' && Number.isFinite(c));
    const reportedConfidence = declared.length
        ? Math.round((declared.reduce((s, c) => s + c, 0) / declared.length) * 1000) / 1000
        : null;

    // `score` and `meanConfidence` are dropped, not passed through. Both fold in
    // the foreign extractor's confidence — and scoreExtraction substitutes 1 for
    // a region that declares none, so an extractor that publishes no confidence
    // at all would come back with our composite reading 0.20 higher than an
    // extractor that honestly reported low confidence. Shipping that field
    // under the same name our own runs use invites exactly the comparison it
    // cannot support.
    const { score: _ourComposite, meanConfidence: _ourMean, ...geometry } = report;

    return {
        ...geometry,
        structuralScore: Math.round(structural * 1000) / 1000,
        cleanliness: Math.round(cleanliness * 1000) / 1000,
        reportedConfidence,
        declaredConfidenceCount: declared.length,
        space,
    };
}
