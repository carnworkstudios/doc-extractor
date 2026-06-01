// geometryWorker.js
// Local fallback extraction worker: PDF.js operator list → CTM baking
// → context classification → region-scoped extraction → page assembly.
//
// Does not require any backend. Runs entirely in the browser.
// Handles tables, paragraphs, headings, lists, and image regions.
//
// Message in:  { type: 'process', bytes: Uint8Array }
// Messages out:
//   { type: 'progress', page: number, total: number, status: string }
//   { type: 'page',     page: number, html: string, text: string, tables: number }
//   { type: 'complete', pageCount: number, tableCount: number }
//   { type: 'error',    error: string }
//
// DESIGN NOTE: Results are streamed per-page via 'page' messages instead of
// accumulated into one massive 'complete' message. This prevents structured
// clone stack overflow on large PDFs (e.g. 76-page technical manuals).

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { extractSubpaths } from '../extraction/vector/ctmAdapter.js';
import { reconcile } from '../extraction/vector/pathReconciler.js';
import { classifyPage } from '../extraction/vector/contextClassifier.js';
import { assemblePage, createFontRegistry, generateDocumentStyles } from '../extraction/vector/pageAssembler.js';
import { readStructTree } from '../extraction/vector/structTreeReader.js';

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

self.onmessage = async (e) => {
    if (e.data.type !== 'process') return;
    const { bytes, pdfWorkerSrc } = e.data;

    if (pdfWorkerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
    }

    try {
        const canvasFactoryOpt = typeof OffscreenCanvas !== 'undefined'
            ? { CanvasFactory: OffscreenCanvasFactory }
            : {};
        const pdf = await pdfjsLib.getDocument({ data: bytes, ...canvasFactoryOpt }).promise;
        const numPages = pdf.numPages;
        let totalTables = 0;
        const fontRegistry = createFontRegistry();

        for (let p = 1; p <= numPages; p++) {
            self.postMessage({ type: 'progress', page: p, total: numPages, status: 'Extracting…' });

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

            // ── Phase 1.5: Image extraction via high-res canvas render + crop ───
            // Geometry pipeline uses scale 2.0; images get their own 4× render so
            // crops aren't blurry when CSS-stretched to fill their container.
            // upRatio converts 2.0-scale bbox coords into 4×-canvas pixel coords.
            const IMG_SCALE = 4.0;
            const upRatio   = IMG_SCALE / 2.0;
            const extractedImages = {};
            if (imageMeta.length > 0 && typeof OffscreenCanvas !== 'undefined') {
                try {
                    const imgViewport = page.getViewport({ scale: IMG_SCALE });
                    const cw = Math.round(imgViewport.width);
                    const ch = Math.round(imgViewport.height);
                    const pageCanvas = new OffscreenCanvas(cw, ch);
                    await page.render({
                        canvasContext: pageCanvas.getContext('2d'),
                        viewport: imgViewport,
                    }).promise;

                    const seen = new Set();
                    for (const meta of imageMeta) {
                        if (seen.has(meta.id)) continue;
                        seen.add(meta.id);
                        const { x, y, w, h } = meta.bbox;
                        const sx = Math.max(0, Math.round(x * upRatio));
                        const sy = Math.max(0, Math.round(y * upRatio));
                        const sw = Math.min(Math.round(w * upRatio), cw - sx);
                        const sh = Math.min(Math.round(h * upRatio), ch - sy);
                        if (sw < 4 || sh < 4) continue;
                        try {
                            const crop = new OffscreenCanvas(sw, sh);
                            crop.getContext('2d').drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
                            const blob = await crop.convertToBlob({ type: 'image/png' });
                            const arr = new Uint8Array(await blob.arrayBuffer());
                            let binary = '';
                            for (let b = 0; b < arr.length; b += 8192) {
                                binary += String.fromCharCode(...arr.subarray(b, b + 8192));
                            }
                            extractedImages[meta.id] = {
                                dataUrl: 'data:image/png;base64,' + btoa(binary),
                                pw: sw,  // pixel width of the crop at IMG_SCALE
                                ph: sh,  // pixel height of the crop at IMG_SCALE
                            };
                        } catch (_) { /* skip uncroppable region */ }
                    }
                } catch (_) { /* render failed — no images for this page */ }
            }

            // ── Phase 1.7: Font style map from commonObjs ────────────────────
            // page.commonObjs is populated after render. Each font object exposes
            // .italic (bool) and .name (string) reliably — far more accurate than
            // parsing the internal fontName strings from text items.
            const fontStyleMap = {};
            try {
                const uniqueFontNames = [...new Set(textContent.items.map(i => i.fontName).filter(Boolean))];
                for (const fn of uniqueFontNames) {
                    const obj = page.commonObjs.get(fn);
                    if (!obj) continue;
                    const rawName = obj.name || fn;
                    const cleaned = rawName.replace(/^[A-Z]{6}\+/, '');
                    fontStyleMap[fn] = {
                        bold:   !!obj.bold || /bold|heavy|black/i.test(cleaned),
                        italic: !!obj.italic || /italic|oblique|slanted/i.test(cleaned),
                    };
                }
            } catch (_) {}

            // ── Phase 2: Region classification ───────────────────────────────
            const { regions, textMeta, columnSplits, rawSplits, scale } = classifyPage(
                segments,
                textContent.items,
                viewport,
                pageWidthPt,
                imageMeta,
                { filledRects, fontStyleMap, structTree: rawStructTree, OPS, _opList: opList }
            );

            // ── Phase 3+4: Scoped extraction + assembly ─────────────────────
            const result = assemblePage(
                regions,
                textMeta,
                textContent.items,
                viewport,
                pageWidthPt,
                p,
                fontRegistry,
                columnSplits,
                extractedImages
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
                })),
                extractedImages,
                pageScale: scale.toJSON(),
            });

            // Release page resources
            page.cleanup();
        }

        self.postMessage({
            type: 'complete',
            pageCount: numPages,
            tableCount: totalTables,
            styles: generateDocumentStyles(fontRegistry),
        });
    } catch (err) {
        self.postMessage({ type: 'error', error: err.message || String(err) });
    }
};

