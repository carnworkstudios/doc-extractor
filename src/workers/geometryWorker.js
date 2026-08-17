// geometryWorker.js
// Local fallback extraction worker: PDF.js operator list → CTM baking
// → context classification → region-scoped extraction → page assembly.
//
// Does not require any backend. Runs entirely in the browser.
// Handles tables, paragraphs, headings, lists, and image regions.
//
// Message in:
//   { type: 'process',   bytes: Uint8Array }           — full extraction
//   { type: 'reprocess', page: number, pipeline: {}, carryImages?: {} }
//        — single page re-extract. `carryImages` is the crops the page is
//        ALREADY showing ({ regionId: { key, w, h, crop:[x,y,w,h] } }, from
//        `getPageImageCrops`). Re-extraction re-classifies the page; it does not
//        repaint it, so a picture whose box comes back unchanged keeps those
//        pixels and nothing is rendered. Omit it and every picture is re-cropped
//        off a fresh 4× page render — correct, just needlessly expensive.
//   { type: 'score-external', requestId, space, pages } — grade a FOREIGN
//        extractor's regions against this document's own text (externalScorer.js)
// Messages out:
//   { type: 'progress', page, total, status }
//   { type: 'page',     page, html, text, tables, regions, pageScale, reprocess? }
//   { type: 'complete', pageCount, tableCount, styles }
//   { type: 'score-external-result', requestId, ok, pages, summary }
//   { type: 'error',    error }
//
// DESIGN NOTE: Results are streamed per-page via 'page' messages instead of
// accumulated into one massive 'complete' message. This prevents structured
// clone stack overflow on large PDFs (e.g. 76-page technical manuals).

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { extractSubpaths } from '../extraction/vector/ctmAdapter.js';
import { reconcile } from '../extraction/vector/pathReconciler.js';
import { makeSyntheticViewport } from '../extraction/vector/rasterSynth.js';
import { classifyPage } from '../extraction/vector/contextClassifier.js';
import { assemblePage, createFontRegistry, generateDocumentStyles } from '../extraction/vector/pageAssembler.js';
import { readStructTree } from '../extraction/vector/structTreeReader.js';
import { DocScale } from '../extraction/vector/docScale.js';
import { scoreExtraction } from '../extraction/vector/extractionScorer.js';
import { ChromeDetector } from '../extraction/vector/chromeDetector.js';
import { pageTextMeta, bboxToViewport, scoreExternalPage, REGION_SPACES }
    from '../extraction/vector/externalScorer.js';
import { scoreFlow, geometricOrder } from '../extraction/vector/flowScorer.js';
import { readStructOrder } from '../extraction/vector/structTreeReader.js';
// IndexedDB is available in workers, so the crop never has to cross the wire as
// a string. The worker writes the blob and sends only its key.
import { saveImages, cropKey, deleteDoc } from '../utils/imageStore.js';

// pdfjs-dist v4 — point to the ESM worker bundle.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const { OPS } = pdfjsLib;

// OffscreenCanvas-based factory class so PDF.js never calls document.createElement
// inside a Web Worker. PDF.js expects a constructor (capital CanvasFactory),
// not an instance — it calls `new CanvasFactory({ ownerDocument, enableHWA })`.
class OffscreenCanvasFactory {
    create(width, height) {
        const canvas = new OffscreenCanvas(width, height);
        return { canvas, context: canvas.getContext('2d') };
    }
    reset(canvasAndCtx, width, height) {
        canvasAndCtx.canvas.width  = width;
        canvasAndCtx.canvas.height = height;
    }
    destroy(canvasAndCtx) {
        canvasAndCtx.canvas.width  = 0;
        canvasAndCtx.canvas.height = 0;
        canvasAndCtx.canvas  = null;
        canvasAndCtx.context = null;
    }
}

// Cached PDF bytes, font registry, and docScale — kept after initial 'process'
// so 'reprocess' can re-run a single page without re-parsing the whole document.
let _docId             = null;   // document namespace for stored crops
let _cachedBytes       = null;
let _cachedFontRegistry = null;
let _cachedDocScale    = null;
let _cachedChromeSigs  = null;   // cross-page running header/footer signatures
// Scanned pages have no operator list to re-parse. The bridge caches each
// scanned page's synthetic inputs here so 'reprocess' re-runs classify/assemble
// on the SAME text items (honoring slider/split pipeline) instead of the PDF.
const _scannedPages = new Map(); // pageNum -> { textItems, filledRects, imageRegions, pageWidthPt, viewportScale }

// Render the page once at 4× and crop every picture region the classifier
// found (keyed by region.id), whether it was painted as a raster XObject,
// as vector line art, as a swarm of image masks, or as a mix of all three.
// Geometry pipeline uses scale 2.0; upRatio converts those bbox coords into
// 4×-canvas pixel coords. Returns {} when OffscreenCanvas is unavailable.
// Resolve one decoded image from PDF.js and encode it as a PNG data URL.
//
// NOT FOR OCR. This is the raw image with nothing drawn on top of it: vector
// callout labels, leader lines and annotations painted OVER a diagram exist in
// a page-render crop and are absent here. OCR must always read rendered pixels
// (see fileUpload.js, which renders its own canvas for Tesseract) — reusing
// this fast path to feed a recogniser would silently drop overlaid text.
//
// Returns null when the object never resolves OR when it carries fewer pixels
// than the page render would, so the caller can fall back.
async function _cropFromDecodedImage(page, id, minWidth) {
    const obj = await new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
        // Image objects are only populated as the operator list is consumed, so
        // an object may not be there yet — or ever, if it was never painted.
        setTimeout(() => finish(null), 3000);
        try {
            if (page.objs.has(id)) { finish(page.objs.get(id)); return; }
            page.objs.get(id, finish);
        } catch { finish(null); }
    });
    if (!obj) return null;

    try {
        const w = obj.width, h = obj.height;
        if (!w || !h) return null;
        // Take the decoded image only when it actually carries more detail than
        // the render would. Measured across the corpus, these PDFs place images
        // at roughly 1:1 with the page, so a 4× render normally OUT-resolves
        // the source (a 1198px screenshot renders at 3892px) and substituting
        // the original would be a downgrade. The decoded path is for the
        // opposite case — a high-resolution photo scaled down into a small
        // frame — where the render throws most of the pixels away.
        if (minWidth && w < minWidth) return null;
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        // Composite on white: the page shows these pixels over the sheet, and a
        // bare alpha channel would render as black in some PNG consumers.
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);

        if (obj.bitmap) {
            ctx.drawImage(obj.bitmap, 0, 0);
        } else if (obj.data) {
            const src = obj.data;
            const img = ctx.createImageData(w, h);
            const dst = img.data;
            if (src.length === w * h * 4) {
                dst.set(src);
            } else if (src.length === w * h * 3) {
                for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
                    dst[j] = src[i]; dst[j + 1] = src[i + 1];
                    dst[j + 2] = src[i + 2]; dst[j + 3] = 255;
                }
            } else {
                return null;   // 1bpp stencils and friends — let the render win
            }
            const tmp = new OffscreenCanvas(w, h);
            tmp.getContext('2d').putImageData(img, 0, 0);
            ctx.drawImage(tmp, 0, 0);
        } else {
            return null;
        }

        const blob = await canvas.convertToBlob({ type: 'image/png' });
        return { blob, pw: w, ph: h };
    } catch {
        return null;
    }
}

/**
 * Crop every picture region on a page and put the pixels in the blob store.
 *
 * Returns store REFERENCES — `{ key, pw, ph, scale }` — not pixels. The crops
 * are written to IndexedDB here rather than serialised into the reply because
 * the reply becomes the document string: base64 in the HTML meant the same
 * megabytes lived in the message, the string, the Monaco model and the DOM at
 * once, and an image line too long for the editor to render.
 *
 * @param {number} srcScale — viewport scale the region bboxes were measured in.
 *   The geometry pipeline runs at 2.0; the scanned bridge synthesises its own
 *   viewport and may not. Passing it explicitly keeps the crop rectangle honest
 *   instead of assuming one caller's scale for all of them.
 * @param {number} pageNum — 1-based page, half of the store key. Region ids are
 *   page-local, so a key without it would collide across pages.
 */
async function _extractPageImages(page, regions, srcScale = 2.0, pageNum = page?.pageNumber) {
    const extractedImages = {};
    // { storeKey: Blob } — written once at the end, in one transaction.
    const blobs = {};
    const _keep = (id, entry) => {
        const key = cropKey(_docId, pageNum, id);
        blobs[key] = entry.blob;
        extractedImages[id] = { key, pw: entry.pw, ph: entry.ph, scale: entry.scale };
    };
    // Crop the PICTURE REGIONS, not the raw image operators. One figure can be
    // painted as hundreds of tiny masks (a service-manual diagram runs to 458
    // fragments of 1×9 px); cropping per operator produced hundreds of useless
    // slivers instead of the drawing. The classifier has already assembled each
    // picture into one region, and a region that is exactly one untouched
    // XObject keeps that XObject's id, so lookups by image id still resolve.
    const pictureRegions = (regions || []).filter(r => r.type === 'IMAGE' && r.bbox && r.id);
    if (pictureRegions.length === 0 || typeof OffscreenCanvas === 'undefined') {
        return extractedImages;
    }

    const IMG_SCALE = 4.0;
    const upRatio   = IMG_SCALE / (srcScale || 2.0);

    // Split the work. A region that is exactly ONE un-composited, axis-aligned
    // XObject can be taken straight from PDF.js's decoded image: native
    // resolution instead of 4× the PLACED size (a 3000px screenshot dropped in
    // a 200pt box only survives as ~800px through the render crop), and no
    // neighbouring ink baked into the edges. Everything else — composites,
    // masks, vector art, rotated placements — must come off the page render,
    // which is the only thing that shows the picture as the page shows it.
    const direct = [], viaRender = [];
    const seen = new Set();
    for (const pic of pictureRegions) {
        if (seen.has(pic.id)) continue;
        seen.add(pic.id);
        const ids = pic.sourceImageIds || [];
        const canUseDecoded = ids.length === 1 && ids[0] === pic.id &&
            !pic.composite && !pic.vectorFigure &&
            pic.axisAligned !== false && /^img_/.test(pic.id);
        (canUseDecoded ? direct : viaRender).push(pic);
    }

    for (const pic of direct) {
        const entry = await _cropFromDecodedImage(page, pic.id, pic.bbox.w * upRatio);
        // The decoded image is native-resolution and was fetched at ~4× the
        // placed size, so it sizes like the render crop: scale stays 4.
        if (entry) _keep(pic.id, { ...entry, scale: 4 });
        else viaRender.push(pic);   // unresolved, unsupported, or lower-res
    }

    if (!viaRender.length) {
        await _saveCrops(blobs);
        return extractedImages;
    }

    try {
        const imgViewport = page.getViewport({ scale: IMG_SCALE });
        const cw = Math.round(imgViewport.width);
        const ch = Math.round(imgViewport.height);
        const pageCanvas = new OffscreenCanvas(cw, ch);
        await page.render({
            canvasContext: pageCanvas.getContext('2d'),
            viewport: imgViewport,
        }).promise;

        const crops = viaRender.map(pic => ({ id: pic.id, bbox: pic.bbox }));

        for (const { id, bbox } of crops) {
            const { x, y, w, h } = bbox;
            const sx = Math.max(0, Math.round(x * upRatio));
            const sy = Math.max(0, Math.round(y * upRatio));
            const sw = Math.min(Math.round(w * upRatio), cw - sx);
            const sh = Math.min(Math.round(h * upRatio), ch - sy);
            if (sw < 4 || sh < 4) continue;
            try {
                const crop = new OffscreenCanvas(sw, sh);
                crop.getContext('2d').drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
                const blob = await crop.convertToBlob({ type: 'image/png' });
                _keep(id, {
                    blob,
                    pw: sw,  // pixel width of the crop at IMG_SCALE
                    ph: sh,  // pixel height of the crop at IMG_SCALE
                    scale: IMG_SCALE,   // so the assembler can size it in CSS px
                });
            } catch (_) { /* skip uncroppable region */ }
        }
    } catch (_) { /* render failed — no images for this page */ }

    await _saveCrops(blobs);
    return extractedImages;
}

/**
 * Persist a page's crops. A failed write is not a failed extraction: the page
 * still assembles, the images simply do not hydrate, which is the same visible
 * result as a crop that could not be taken. Throwing here would lose the
 * page's text and layout over a picture.
 */
async function _saveCrops(blobs) {
    if (!blobs || !Object.keys(blobs).length) return;
    try {
        await saveImages(blobs);
    } catch (err) {
        console.warn('[geometryWorker] crop store write failed:', err?.message || err);
    }
}

/**
 * Split a re-extracted page's pictures into the ones that can KEEP the crop the
 * page is already showing and the ones that actually need new pixels.
 *
 * Re-extraction re-classifies a page; it does not repaint it. A picture region
 * that comes back with the same id and the same box is the same pixels, and the
 * caller is holding them already (`carryImages`, harvested from the live page).
 * Reusing them is not an optimisation detail — a 4× page render is the single
 * most expensive thing a re-extract does, and on the common re-extract (a
 * threshold nudged, the figures untouched) it buys nothing at all.
 *
 * The box is compared, not just the id, because a re-extract is precisely when
 * regions merge, split and grow. A carried crop whose box no longer matches
 * would be the RIGHT id over the WRONG pixels — worse than re-cropping.
 */
function _splitCarriedCrops(regions, carryImages) {
    const carried = {};
    const missing = [];
    const pics = (regions || []).filter(r => r.type === 'IMAGE' && r.bbox && r.id);
    const same = (a, b) => Math.abs(a - b) <= 1;
    for (const r of pics) {
        const c = carryImages?.[r.id];
        if (c?.key && Array.isArray(c.crop) &&
            same(c.crop[0], r.bbox.x) && same(c.crop[1], r.bbox.y) &&
            same(c.crop[2], r.bbox.w) && same(c.crop[3], r.bbox.h)) {
            // Nothing but the key travels: the pixels never left the store, so
            // carrying a crop forward now costs one string instead of a
            // megabyte. `w`/`h` are already CSS px (the assembler divided by
            // the producing scale), so scale 1 reproduces identical markup.
            carried[r.id] = { key: c.key, pw: c.w, ph: c.h, scale: 1 };
        } else {
            missing.push(r);
        }
    }
    return { carried, missing };
}

/**
 * Crops for a SCANNED page's picture regions that could not be carried forward.
 *
 * The scanned bridge re-classifies cached synthetic text items, so there is no
 * operator list — but the crops never came from the operator list. They come
 * from the page render, and an image-only page renders like any other. This
 * runs ONLY for regions whose box changed, so a re-extract that leaves the
 * figures alone opens nothing and renders nothing.
 *
 * Returns {} when the document's bytes were never cached (a standalone fork, or
 * a document mounted without them) — the caller then renders placeholders,
 * which is the old behaviour and still better than failing the re-extract.
 */
async function _extractScannedPageImages(pageNum, regions) {
    if (!_cachedBytes || !regions.length) return {};
    const srcScale = _scannedPages.get(pageNum)?.viewportScale ?? 2.0;
    try {
        const canvasFactoryOpt = typeof OffscreenCanvas !== 'undefined'
            ? { CanvasFactory: OffscreenCanvasFactory }
            : {};
        const pdf = await pdfjsLib.getDocument({ data: _cachedBytes.slice(), ...canvasFactoryOpt }).promise;
        const page = await pdf.getPage(pageNum);
        const images = await _extractPageImages(page, regions, srcScale, pageNum);
        page.cleanup();
        return images;
    } catch (err) {
        console.warn(`[geometryWorker] scanned page ${pageNum}: image crops unavailable —`, err?.message || err);
        return {};
    }
}

/**
 * Grade a FOREIGN extractor's regions against the source PDF.
 *
 * The only thing this needs from the document is its real text items, so it
 * reopens the cached bytes and reads `getTextContent()` per requested page —
 * no operator list, no classification, no rendering. That is the same cheap
 * pass the DocScale pre-scan makes, and it is why scoring somebody else's
 * output costs a fraction of producing our own.
 *
 * in:  { type: 'score-external', requestId, space, pages: [{page, regions}] }
 * out: { type: 'score-external-result', requestId, ok, pages, summary }
 */
async function _handleScoreExternal(data) {
    const requestId = data.requestId;
    const reply = (payload) =>
        self.postMessage({ type: 'score-external-result', requestId, ...payload });

    const space = data.space || 'fraction';
    if (!REGION_SPACES.includes(space)) {
        return reply({
            ok: false,
            reason: 'unknown-space',
            detail: `space must be one of ${REGION_SPACES.join(', ')}; got "${space}".`,
        });
    }
    if (!_cachedBytes) {
        return reply({
            ok: false,
            reason: 'no-document',
            detail: 'No PDF is cached in this worker. Send the document bytes before scoring.',
        });
    }
    if (!Array.isArray(data.pages) || !data.pages.length) {
        return reply({
            ok: false,
            reason: 'no-regions',
            detail: 'pages must be a non-empty array of { page, regions } and/or { page, text }.',
        });
    }

    try {
        const canvasFactoryOpt = typeof OffscreenCanvas !== 'undefined'
            ? { CanvasFactory: OffscreenCanvasFactory }
            : {};
        // slice(): getDocument transfers/detaches the buffer it is handed, and
        // this is the cached copy every later re-extract depends on.
        const pdf = await pdfjsLib.getDocument({
            data: _cachedBytes.slice(), ...canvasFactoryOpt,
        }).promise;

        const results = [];
        const skipped = [];
        for (const entry of data.pages) {
            const pageNum = Number(entry?.page);
            if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > pdf.numPages) {
                skipped.push({ page: entry?.page ?? null, reason: 'page-out-of-range' });
                continue;
            }
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: 2.0 });
            const textMeta = await pageTextMeta(page, viewport);

            const geom = {
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
                pageWidthPt: page.view[2] - page.view[0],
                pageHeightPt: page.view[3] - page.view[1],
                vpTransform: viewport.transform,
            };

            let dropped = 0;
            const regions = [];
            for (const r of entry.regions || []) {
                const bbox = bboxToViewport(r?.bbox, space, geom);
                // A region whose bbox will not parse is DROPPED and COUNTED, not
                // coerced to zeros. A zero-area box at the origin covers no text
                // and would show up as the foreign extractor missing content it
                // actually found.
                if (!bbox) { dropped++; continue; }
                regions.push({
                    type: typeof r.type === 'string' ? r.type : 'PARAGRAPH',
                    bbox,
                    confidence: typeof r.confidence === 'number' ? r.confidence : undefined,
                });
            }

            const scored = {
                page: pageNum,
                textItemCount: textMeta.length,
                regionCount: regions.length,
                unparseableRegions: dropped,
                ...scoreExternalPage(regions, textMeta, viewport, space),
            };

            // ── Reading order, when the caller supplied their output text ─────
            // A separate axis from structure, and separately requested: an
            // extractor can cover every character (structural 1.000) and still
            // emit a two-column page line-by-line across the gutter.
            if (typeof entry.text === 'string' && entry.text.trim()) {
                const outputText = entry.text;
                // Prefer the author's declared order. `readStructOrder` returns
                // null rather than guessing when the document is untagged or the
                // tree covers too little of the page, so this cannot silently
                // present an inference as the author's word.
                let refOrder = null;
                let refSource = 'geometric';
                try {
                    const [opList, structTree] = await Promise.all([
                        page.getOperatorList(),
                        page.getStructTree().catch(() => null),
                    ]);
                    refOrder = readStructOrder(structTree, opList, textMeta, OPS);
                    if (refOrder) refSource = 'struct-tree';
                } catch (_) { /* fall through to geometry */ }

                if (!refOrder) refOrder = geometricOrder(textMeta, viewport.width);

                const outputLines = String(outputText)
                    .split('\n').map(l => l.trim()).filter(Boolean);
                scored.flow = scoreFlow(
                    outputLines, textMeta, refOrder, refSource, viewport.width,
                    { includeChunks: !!data.includeChunks },
                );
            }

            results.push(scored);
            page.cleanup();
        }

        // Page-count-weighted means. A document rollup that averaged per-page
        // scores equally would let a title page with four text items outvote a
        // dense table page.
        const totalText = results.reduce((s, r) => s + r.textItemCount, 0);
        const weighted = (key) => {
            if (!results.length) return null;
            if (!totalText) {
                return Math.round(
                    (results.reduce((s, r) => s + r[key], 0) / results.length) * 1000
                ) / 1000;
            }
            return Math.round(
                (results.reduce((s, r) => s + r[key] * r.textItemCount, 0) / totalText) * 1000
            ) / 1000;
        };

        // Flow rolls up over DISCRIMINATING pages only. A single-column page
        // scores 1.0 for everyone because there is nothing to interleave, and a
        // page where four lines matched can only produce 0, 0.5 or 1. Averaging
        // those in would drag every document toward whatever the trivial pages
        // said — the metric would look stable and mean nothing.
        const flowPages = results.filter(r => r.flow?.discriminating);
        const flowMean = (key) => {
            const vals = flowPages.map(r => r.flow[key]).filter(v => typeof v === 'number');
            if (!vals.length) return null;
            return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 1000) / 1000;
        };
        const askedForFlow = results.some(r => r.flow);
        const refSources = [...new Set(flowPages.map(r => r.flow.referenceSource))];

        reply({
            ok: true,
            pages: results,
            summary: {
                pagesScored: results.length,
                pagesSkipped: skipped,
                structuralScore: weighted('structuralScore'),
                textCoverage: weighted('textCoverage'),
                uncoveredTextCount: results.reduce((s, r) => s + r.uncoveredTextCount, 0),
                totalTextItems: totalText,
                documentPageCount: pdf.numPages,
                space,
                ...(askedForFlow ? {
                    flow: {
                        pagesMeasured: flowPages.length,
                        pagesNotDiscriminating: results.filter(r => r.flow && !r.flow.discriminating).length,
                        referenceSources: refSources,
                        flowScore: flowMean('flowScore'),
                        columnFlow: flowMean('columnFlow'),
                        sequenceFlow: flowMean('sequenceFlow'),
                        contiguity: flowMean('contiguity'),
                    },
                } : {}),
            },
        });
    } catch (err) {
        reply({
            ok: false,
            reason: 'score-external-failed',
            detail: String(err?.message || err),
        });
    }
}

self.onmessage = async (e) => {
    // Which document this worker is extracting. It namespaces every crop this
    // worker stores. A batch runs several of these workers CONCURRENTLY into
    // one store, so without it the pictures of whichever document finished last
    // would be served to all of them.
    if (e.data.docId != null) _docId = e.data.docId;
    if (e.data.type === 'cache-bytes') {
        _cachedBytes = e.data.bytes ? e.data.bytes.slice() : null;
        return;
    }
    if (e.data.type === 'cache-scanned-page') {
        _scannedPages.set(e.data.page, {
            textItems: e.data.synth.textItems,
            filledRects: e.data.synth.filledRects,
            imageMeta: e.data.synth.imageMeta,
            pageWidthPt: e.data.pageWidthPt,
            pageHeightPt: e.data.pageHeightPt,
            viewportScale: e.data.viewportScale ?? 2.0,
        });
        return;
    }
    if (e.data.type === 'score-external') {
        await _handleScoreExternal(e.data);
        return;
    }
    if (e.data.type === 'reprocess') {
        // Scanned page? Re-run on cached synthetic inputs, not the PDF.
        if (_scannedPages.has(e.data.page)) {
            await _handleScannedReprocess(e.data);
        } else {
            await _handleReprocess(e.data);
        }
        return;
    }
    if (e.data.type !== 'process') return;
    const { bytes, pdfWorkerSrc } = e.data;

    if (pdfWorkerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
    }

    // A full extraction replaces this document's pictures wholesale — a retry,
    // a re-add, or the same slot loaded again. Dropping the old crops first
    // keeps the store's byte accounting honest (it charges what it holds) and
    // stops an abandoned run's pixels from lingering under live keys.
    if (_docId != null) {
        await deleteDoc(_docId).catch(err =>
            console.warn('[geometryWorker] could not retire previous crops:', err?.message || err));
    }

    // Cache bytes for single-page re-extraction
    _cachedBytes        = bytes ? bytes.slice() : null;
    _cachedFontRegistry = null;  // reset; will be rebuilt during this run
    _cachedDocScale     = null;  // reset; set after DocScale calibration

    try {
        const canvasFactoryOpt = typeof OffscreenCanvas !== 'undefined'
            ? { CanvasFactory: OffscreenCanvasFactory }
            : {};
        const pdf = await pdfjsLib.getDocument({ data: bytes, ...canvasFactoryOpt }).promise;
        const numPages = pdf.numPages;

        // ── DocScale pre-scan: collect textMeta from all pages for document-level
        // tolerance calibration. This pass only reads textContent (no operator
        // list, no classification) so it is fast even on large documents.
        const docScale = new DocScale();
        const chrome = new ChromeDetector();
        for (let p = 1; p <= numPages; p++) {
            const page = await pdf.getPage(p);
            const viewport = page.getViewport({ scale: 2.0 });
            const textContent = await page.getTextContent();
            const textMeta = textContent.items
                .filter(i => i.str?.trim())
                .map((item, idx) => {
                    const tm = item.transform;
                    const vpT = viewport.transform;
                    const scaleX = Math.hypot(vpT[0], vpT[1]) || 1;
                    const scaleY = Math.hypot(vpT[2], vpT[3]) || 1;
                    // pdf.js text items carry no fontSize field — derive it
                    // from the text matrix like contextClassifier (transform[3]).
                    const fontSizePt = Math.abs(tm?.[3] || 12);
                    return {
                        idx,
                        str: item.str,
                        vx: tm[4] * scaleX,
                        vy: tm[5] * scaleY,
                        vWidth: item.width * scaleX,
                        vFont: fontSizePt * scaleY,
                        fontSize: fontSizePt,
                        fontName: item.fontName || '',
                    };
                });
            docScale.accumulate(textMeta);
            chrome.accumulatePage(textMeta, viewport.height);
            page.cleanup();
        }
        docScale.calibrate(12);
        _cachedDocScale = docScale;
        _cachedChromeSigs = chrome.repeatedSigs();

        let totalTables = 0;
        const failedPages = [];
        const fontRegistry = createFontRegistry();
        _cachedFontRegistry = fontRegistry;

        for (let p = 1; p <= numPages; p++) {
            self.postMessage({ type: 'progress', page: p, total: numPages, status: 'Extracting…' });

            try {
            const page = await pdf.getPage(p);
            const viewport = page.getViewport({ scale: 2.0 });
            const pageWidthPt = page.view[2] - page.view[0];

            const [opList, textContent, rawStructTree] = await Promise.all([
                page.getOperatorList(),
                page.getTextContent(),
                page.getStructTree().catch(() => null),
            ]);

            // ── Phase 1: Page inventory (ctmAdapter) ─────────────────────────
            const { subpaths, imageMeta, filledRects: rawFilledRects } = extractSubpaths(opList, viewport, OPS);
            const { segments, filledRects } = reconcile(subpaths, rawFilledRects, viewport);

            // ── Phase 1.7: Font style map from commonObjs ────────────────────
            // getOperatorList() resolves fonts into page.commonObjs. Each font
            // object exposes .italic/.bold and .name — far more accurate than
            // parsing the internal fontName strings from text items.
            // Per-font try/catch: one unresolved font must not wipe the whole map.
            const fontStyleMap = {};
            const uniqueFontNames = [...new Set(textContent.items.map(i => i.fontName).filter(Boolean))];
            for (const fn of uniqueFontNames) {
                try {
                    const obj = page.commonObjs.get(fn);
                    if (!obj) continue;
                    const cleaned = (obj.name || fn).replace(/^[A-Z]{6}\+/, '');
                    fontStyleMap[fn] = {
                        bold:   !!obj.bold || /bold|heavy|black/i.test(cleaned),
                        italic: !!obj.italic || /italic|oblique|slanted/i.test(cleaned),
                    };
                } catch (_) { /* font not resolved — fall back to name parsing downstream */ }
            }

            // ── Phase 2: Region classification ───────────────────────────────
            const { regions, textMeta, columnSplits, rawSplits, scale } = classifyPage(
                segments,
                textContent.items,
                viewport,
                pageWidthPt,
                imageMeta,
                { filledRects, fontStyleMap, structTree: rawStructTree, OPS, _opList: opList, docScale, chromeSigs: _cachedChromeSigs }
            );

            // ── Phase 2.5: Image + vector-figure extraction via 4× render ────
            // Runs AFTER classification so vector line-art figures (diagrams the
            // classifier detected from path segments) get cropped too, not just
            // raster XObjects.
            const extractedImages = await _extractPageImages(page, regions, 2.0, p);

            // ── Phase 3+4: Scoped extraction + assembly ─────────────────────
            const result = assemblePage(
                regions,
                textMeta,
                textContent.items,
                viewport,
                pageWidthPt,
                p,
                fontRegistry,
                rawSplits ?? columnSplits,
                extractedImages,
                docScale
            );

            totalTables += result.tableCount;

            // Stream per-page result — avoids accumulating huge payloads
            self.postMessage({
                type: 'page',
                page: p,
                html: result.html,
                text: result.text.trim(),
                tables: result.tableCount,
                regions: regions.map((r, i) => ({
                    id: r.id || `p${p}-r${i}`,
                    type: r.type,
                    bbox: r.bbox,
                    algorithm: r.algorithm ?? 'geometric',
                    confidence: r.confidence ?? 1.0,
                    columnIndex: r.columnIndex ?? -1,
                    imageId: r.imageId ?? null,
                    flowId: r.flowId ?? null,
                    flowNext: r.flowNext ?? null,
                    flowJoin: r.flowJoin ?? null,
                })),
                pageScale: scale.toJSON(),
                docScale: docScale.toJSON(),
                layoutTree: result.layoutTree ?? null,
                fidelityScore: result.fidelityScore ?? 0,
                layoutMethod: result.layoutMethod ?? 'flat-zones',
                verification: scoreExtraction(regions, textMeta, viewport),
            });

            // Release page resources
            page.cleanup();
            } catch (pageErr) {
                // One page must not take down the document.
                //
                // Every page was inside a single try/catch wrapping the whole
                // loop, so a throw on page 615 of 1236 discarded the 614 pages
                // already extracted and surfaced as "the PDF cannot be
                // extracted". A per-page boundary degrades instead: the bad
                // page is reported and skipped, the rest of the document still
                // arrives. `failedPages` rides along on 'complete' so the
                // caller can tell a partial extraction from a clean one.
                failedPages.push({ page: p, error: pageErr?.message || String(pageErr) });
                console.warn(`[geometryWorker] page ${p} failed:`, pageErr);
                self.postMessage({
                    type: 'page', page: p, html: '', text: '', tables: 0,
                    regions: [], pageScale: null, failed: true,
                });
            }
        }

        self.postMessage({
            type: 'complete',
            failedPages,
            pageCount: numPages,
            tableCount: totalTables,
            styles: generateDocumentStyles(fontRegistry),
        });
    } catch (err) {
        self.postMessage({ type: 'error', error: err.message || String(err) });
    }
};

// ── Single-page re-extraction ─────────────────────────────────────────────────
async function _handleReprocess({ page: pageNum, pipeline = {}, carryImages = {} }) {
    if (!_cachedBytes) {
        self.postMessage({
            type: 'error',
            reprocess: true,
            page: pageNum,
            error: 'No PDF loaded. Run a full extraction first.'
        });
        return;
    }

    const { skip = [], scaleOverrides = {}, customRegions = [], manualSplits = [] } = pipeline;
    const skipSet = new Set(skip);

    try {
        const canvasFactoryOpt = typeof OffscreenCanvas !== 'undefined'
            ? { CanvasFactory: OffscreenCanvasFactory }
            : {};
        // Use a slice of the cached bytes to prevent detaching the original cached buffer
        const pdf = await pdfjsLib.getDocument({ data: _cachedBytes.slice(), ...canvasFactoryOpt }).promise;
        const page = await pdf.getPage(pageNum);
        const viewport    = page.getViewport({ scale: 2.0 });
        const pageWidthPt = page.view[2] - page.view[0];

        const [opList, textContent, rawStructTree] = await Promise.all([
            page.getOperatorList(),
            page.getTextContent(),
            page.getStructTree().catch(() => null),
        ]);

        const { subpaths, imageMeta, filledRects: rawFilledRects } = extractSubpaths(opList, viewport, OPS);
        const { segments, filledRects } = reconcile(subpaths, rawFilledRects, viewport);

        // Font style map — per-font try/catch, same as the process path
        const fontStyleMap = {};
        const uniqueFontNames = [...new Set(textContent.items.map(i => i.fontName).filter(Boolean))];
        for (const fn of uniqueFontNames) {
            try {
                const obj = page.commonObjs.get(fn);
                if (!obj) continue;
                const cleaned = (obj.name || fn).replace(/^[A-Z]{6}\+/, '');
                fontStyleMap[fn] = {
                    bold:   !!obj.bold   || /bold|heavy|black/i.test(cleaned),
                    italic: !!obj.italic || /italic|oblique|slanted/i.test(cleaned),
                };
            } catch (_) {}
        }

        // Classify — pass skip set and scale overrides through opts
        const { regions, textMeta, columnSplits, rawSplits, scale } = classifyPage(
            segments,
            textContent.items,
            viewport,
            pageWidthPt,
            imageMeta,
            {
                filledRects,
                fontStyleMap,
                structTree: rawStructTree,
                OPS,
                _opList: opList,
                pipeline: { skip: skipSet, scaleOverrides, customRegions, manualSplits },
                docScale: _cachedDocScale,
                chromeSigs: _cachedChromeSigs,
            },
        );

        // Image + vector-figure crops (after classification, same as process
        // path) — but only for pictures whose box actually changed. Everything
        // still sitting where it was keeps the pixels the page already has, so
        // the usual re-extract (a threshold nudged, the figures untouched)
        // renders nothing at all.
        const { carried, missing } = _splitCarriedCrops(regions, carryImages);
        const extractedImages = missing.length
            ? { ...carried, ...(await _extractPageImages(page, missing, 2.0, pageNum)) }
            : carried;

        const fontRegistry = _cachedFontRegistry ?? createFontRegistry();
        const result = assemblePage(
            regions,
            textMeta,
            textContent.items,
            viewport,
            pageWidthPt,
            pageNum,
            fontRegistry,
            rawSplits ?? columnSplits,
            extractedImages,
            _cachedDocScale,
        );

        page.cleanup();

        self.postMessage({
            type: 'page',
            reprocess: true,   // flag so fileUpload routes this to analyzePanel
            page: pageNum,
            html: result.html,
            text: result.text.trim(),
            tables: result.tableCount,
            regions: regions.map((r, i) => ({
                id: r.id || `p${pageNum}-r${i}`,
                type: r.type,
                bbox: r.bbox,
                algorithm: r.algorithm ?? 'geometric',
                confidence: r.confidence ?? 1.0,
                columnIndex: r.columnIndex ?? -1,
                imageId: r.imageId ?? null,
                flowId: r.flowId ?? null,
                flowNext: r.flowNext ?? null,
                flowJoin: r.flowJoin ?? null,
            })),
            pageScale: scale.toJSON(),
            docScale: _cachedDocScale ? _cachedDocScale.toJSON() : null,
            layoutTree: result.layoutTree ?? null,
            fidelityScore: result.fidelityScore ?? 0,
            layoutMethod: result.layoutMethod ?? 'flat-zones',
            verification: scoreExtraction(regions, textMeta, viewport),
        });
    } catch (err) {
        self.postMessage({
            type: 'error',
            reprocess: true,
            page: pageNum,
            error: `Reprocess page ${pageNum}: ${err.message || err}`
        });
    }
}

// ── Single-page re-extraction for a SCANNED page ───────────────────────────────
// Sources from the cached synthetic text items (no PDF re-parse — the page has
// no operator list). Honors the same slider/split pipeline as the vector path.
async function _handleScannedReprocess({ page: pageNum, pipeline = {}, carryImages = {} }) {
    const cached = _scannedPages.get(pageNum);
    if (!cached) {
        self.postMessage({ type: 'error', reprocess: true, page: pageNum,
            error: `No cached scanned page ${pageNum}.` });
        return;
    }
    const { skip = [], scaleOverrides = {}, customRegions = [], manualSplits = [] } = pipeline;
    const skipSet = new Set(skip);

    try {
        const { textItems, filledRects, imageMeta, pageWidthPt, pageHeightPt, viewportScale } = cached;
        const viewport = makeSyntheticViewport(pageWidthPt, pageHeightPt ?? pageWidthPt * 1.4142, viewportScale);

        const { regions, textMeta, columnSplits, rawSplits, scale } = classifyPage(
            [], textItems, viewport, pageWidthPt, imageMeta || [],
            {
                filledRects: filledRects || [],
                pipeline: { skip: skipSet, scaleOverrides, customRegions, manualSplits },
                docScale: _cachedDocScale,
            },
        );

        // Picture crops. Passing {} here (what this did before) rebuilt every
        // IMAGE region as an empty dashed placeholder, so re-extracting a
        // scanned page silently deleted every picture on it while the region,
        // its bbox and its tag all survived — the artifacts panel still listed
        // an image the document no longer showed. The pixels the page already
        // has are reused; only a region whose box actually changed is re-cropped
        // off a render.
        const { carried, missing } = _splitCarriedCrops(regions, carryImages);
        const extractedImages = missing.length
            ? { ...carried, ...(await _extractScannedPageImages(pageNum, missing)) }
            : carried;

        const fontRegistry = _cachedFontRegistry ?? createFontRegistry();
        const result = assemblePage(
            regions, textMeta, textItems, viewport, pageWidthPt, pageNum,
            fontRegistry, rawSplits ?? columnSplits, extractedImages, null,
        );

        self.postMessage({
            type: 'page',
            reprocess: true,
            page: pageNum,
            html: result.html,
            text: result.text.trim(),
            tables: result.tableCount,
            regions: regions.map((r, i) => ({
                id: r.id || `p${pageNum}-r${i}`,
                type: r.type,
                bbox: r.bbox,
                algorithm: r.algorithm ?? 'ocr-synth',
                confidence: r.confidence ?? 1.0,
                columnIndex: r.columnIndex ?? -1,
                imageId: r.imageId ?? null,
                flowId: r.flowId ?? null,
                flowNext: r.flowNext ?? null,
                flowJoin: r.flowJoin ?? null,
            })),
            pageScale: scale.toJSON(),
            docScale: _cachedDocScale ? _cachedDocScale.toJSON() : null,
            layoutTree: result.layoutTree ?? null,
            fidelityScore: result.fidelityScore ?? 0,
            layoutMethod: result.layoutMethod ?? 'flat-zones',
            verification: scoreExtraction(regions, textMeta, viewport),
        });
    } catch (err) {
        self.postMessage({ type: 'error', reprocess: true, page: pageNum,
            error: `Scanned reprocess page ${pageNum}: ${err.message || err}` });
    }
}

