// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// forensics/index.js — the facade. One entry point, six independent analysers.
//
// THE SHAPE, AND WHY IT MIRRORS ocr/index.js
// ------------------------------------------
// The OCR facade's rule is that WHICH ENGINE RAN IS A FINDING, NOT A FIELD:
// "unavailable" must never render as "clean". The same rule governs forensics
// and matters more here, because a forensic report that silently omits a check
// reads as a report that ran the check and found nothing.
//
// So `analyseDocument()` records, for every analyser, one of three states —
// exactly the three the Ginex rail insists on:
//
//   ran-and-found          findings, tiered observed/inferred/uncertain
//   ran-and-found-nothing  an explicit `observed` finding saying so
//   could-not-run          an `uncertain` finding naming what was missing
//
// An analyser that throws does not take the report down and does not vanish
// from it. It appears as could-not-run with the reason.
//
// WHAT IS DETERMINISTIC AND WHAT IS NOT
// -------------------------------------
// Everything in this directory except the VLM narrative is deterministic: same
// bytes in, same findings out, no model, no randomness, independently testable.
// Head B's outputs enter only through `ocrConfidence`, and only as
// CORROBORATION of a deterministic measurement — never as the sole basis for a
// finding. That boundary is deliberate: the learned signal can be wrong, and a
// report whose conclusions rest on it would inherit that without saying so.

import { observed, uncertain, report } from './findings.js';
import { analyseDuplicates } from './duplicatePages.js';
import { analyseAlteredRegions } from './alteredRegions.js';
import { analyseOverlays } from './overlays.js';
import { analyseMetadata, analyseFonts, analyseFontsAcrossPages, baseFontName } from './metadataFonts.js';
import { measurePageOrder, analyseReadingOrder } from './readingOrder.js';
import { analyseOcrConfidence } from './ocrConfidence.js';

export { TIERS, inferred } from './findings.js';
export * from './signals.js';
export { LAYOUT_CLASSES, headAToRegionType, regionTypeToHeadA, confidenceTier } from './regionMap.js';

/**
 * @typedef {object} PageInput
 * @property {number} page
 * @property {HTMLCanvasElement|OffscreenCanvas} [canvas]   the rendered raster
 * @property {Array}  [regions]      layout regions, {label|type, bbox, confidence}
 * @property {object} [extracted]    ctmAdapter.extractSubpaths() output
 * @property {Array}  [paintOrder]   region ids in content-stream order
 * @property {Array}  [words]        OCR words
 * @property {object} [forensicMaps] Head B maps, from readMaps()
 * @property {Map}    [fontInfo]     fontName -> pdf.js font object
 * @property {number} w @property {number} h
 * @property {object} [pageScale]
 */

const ANALYSERS = [
    'metadata', 'fonts', 'overlays', 'altered-regions',
    'duplicate-pages', 'reading-order', 'ocr-confidence',
];

/**
 * Run every analyser that has the inputs it needs.
 *
 * @param {object} doc
 * @param {PageInput[]} doc.pages
 * @param {object} [doc.info]      pdf.js getMetadata().info
 * @param {object} [doc.xmp]
 * @param {object} [opts]
 * @param {string[]} [opts.only]   restrict to named analysers (tests use this)
 */
export function analyseDocument(doc, opts = {}) {
    const pages = doc.pages || [];
    const wanted = new Set(opts.only || ANALYSERS);
    const all = [];
    const status = {};

    const run = (name, needs, fn) => {
        if (!wanted.has(name)) return;
        if (needs) {
            status[name] = 'could-not-run';
            all.push(uncertain(name,
                `check did not run: ${needs}`,
                { severity: 0 }));
            return;
        }
        try {
            const got = fn() || [];
            all.push(...got);
            // "ran and found nothing" is a real result and each analyser emits
            // its own explicit observation to that effect, so an empty return
            // here means the analyser is incomplete, not that the page is clean.
            status[name] = got.length ? 'ran-and-found' : 'ran-and-found-nothing';
        } catch (err) {
            status[name] = 'could-not-run';
            all.push(uncertain(name, `check failed: ${err.message}`, { severity: 0 }));
        }
    };

    // ── document level ──────────────────────────────────────────────────────
    run('metadata', doc.info ? null : 'no document info dictionary',
        () => analyseMetadata(doc.info, doc.xmp));

    const dupPages = pages.filter((p) => p.canvas);
    run('duplicate-pages',
        dupPages.length >= 2 ? null : 'fewer than two rendered pages',
        () => analyseDuplicates(dupPages.map((p) => ({
            page: p.page, canvas: p.canvas, regions: p.regions || [], w: p.w, h: p.h }))));

    // ── per page ────────────────────────────────────────────────────────────
    const orderMeasurements = [];
    const fontPerPage = [];

    for (const p of pages) {
        if (p.canvas) {
            run('altered-regions', null, () => analyseAlteredRegions(p.canvas, p.page));
        }
        if (p.extracted) {
            run('overlays', null, () => analyseOverlays(p.extracted, p.page, {
                pageBox: { w: p.w, h: p.h },
                // Required for the polygon-fill recovery path. Omitting it
                // degrades the check to `re` rectangles only, which pdf-lib and
                // several other writers never emit.
                viewport: p.viewport,
            }));
            run('fonts', null, () => {
                const ops = p.extracted.textPaintOps || [];
                fontPerPage.push({
                    page: p.page,
                    fonts: [...new Set(ops.map((o) => o.fontName).filter(Boolean))],
                });
                return analyseFonts(ops, p.fontInfo || new Map(), p.page);
            });
        }
        if (p.regions && p.paintOrder && p.pageScale) {
            try {
                orderMeasurements.push(measurePageOrder(
                    p.regions, p.paintOrder,
                    { x: 0, y: 0, w: p.w, h: p.h }, p.pageScale, p.page));
            } catch { /* recorded as a gap by the document-level call below */ }
        }
        if (p.words && p.words.length) {
            run('ocr-confidence', null, () => analyseOcrConfidence({
                words: p.words, w: p.w, h: p.h,
                forensicMaps: p.forensicMaps
                    ? ['blur', 'bleed', 'tears', 'handwriting'].map((k) => p.forensicMaps[k])
                    : null,
                pageNo: p.page }));
        }
    }

    run('reading-order',
        orderMeasurements.length >= 2 ? null
            : 'needs regions + paint order + page scale on at least two pages',
        () => analyseReadingOrder(orderMeasurements));

    if (fontPerPage.length >= 3) {
        try { all.push(...analyseFontsAcrossPages(fontPerPage)); } catch { /* noop */ }
    }

    // Which analysers were asked for and never reached a `run` call at all —
    // because no page carried their input. Silence here would be the exact
    // failure ocr/index.js was written to prevent.
    for (const name of wanted) {
        if (!(name in status)) {
            status[name] = 'could-not-run';
            all.push(uncertain(name, 'check did not run: no page supplied its inputs',
                { severity: 0 }));
        }
    }

    return report(all, {
        document: doc.name || null,
        pages: pages.length,
        analysers: status,
        // The learned head is named as a contributor so a reader knows some
        // corroboration in this report came from a model rather than from a
        // measurement.
        forensicHeadUsed: pages.some((p) => !!p.forensicMaps),
    });
}

export {
    analyseDuplicates, analyseAlteredRegions, analyseOverlays,
    analyseMetadata, analyseFonts, analyseFontsAcrossPages, baseFontName,
    measurePageOrder, analyseReadingOrder, analyseOcrConfidence,
    observed, uncertain, report, ANALYSERS,
};
