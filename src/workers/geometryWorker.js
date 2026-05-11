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
import { extractPaths } from '../extraction/vector/ctmAdapter.js';
import { classifyPage } from '../extraction/vector/contextClassifier.js';
import { assemblePage, createFontRegistry, generateDocumentStyles } from '../extraction/vector/pageAssembler.js';

// pdfjs-dist v4 — point to the ESM worker bundle.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const { OPS } = pdfjsLib;

self.onmessage = async (e) => {
    if (e.data.type !== 'process') return;
    const { bytes } = e.data;

    try {
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        const numPages = pdf.numPages;
        let totalTables = 0;
        const fontRegistry = createFontRegistry();

        for (let p = 1; p <= numPages; p++) {
            self.postMessage({ type: 'progress', page: p, total: numPages, status: 'Extracting…' });

            const page = await pdf.getPage(p);
            const viewport = page.getViewport({ scale: 1.5 });
            const pageWidthPt = page.view[2] - page.view[0];

            const [opList, textContent] = await Promise.all([
                page.getOperatorList(),
                page.getTextContent(),
            ]);

            // ── Phase 1: Page inventory (ctmAdapter) ─────────────────────────
            const { segments, imageMeta } = extractPaths(opList, viewport, OPS);

            // ── Phase 1.5: Image Bitmap Extraction ───────────────────────────
            // PDF.js only pushes pixel data into page.objs when the page is
            // rendered — there is no other trigger. We render to a throwaway
            // OffscreenCanvas solely to populate page.objs, then read each
            // image XObject directly from page.objs at native resolution.
            // This gives clean, isolated pixels with no content bleed and
            // preserves the native image dimensions regardless of viewport scale.
            const extractedImages = {};
            if (imageMeta.length > 0 && typeof OffscreenCanvas !== 'undefined') {
                try {
                    const pageCanvas = new OffscreenCanvas(Math.round(viewport.width), Math.round(viewport.height));
                    await page.render({ canvasContext: pageCanvas.getContext('2d'), viewport }).promise;

                    for (const meta of imageMeta) {
                        try {
                            const obj = page.objs.get(meta.id); // safe now — render populated objs
                            if (!obj || !obj.data || !obj.width || !obj.height) continue;

                            const { width: w, height: h, data } = obj;
                            const rgba = new Uint8ClampedArray(w * h * 4);
                            if (data.length === w * h * 4) {
                                rgba.set(data);
                            } else if (data.length === w * h * 3) {
                                for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
                                    rgba[j] = data[i]; rgba[j+1] = data[i+1]; rgba[j+2] = data[i+2]; rgba[j+3] = 255;
                                }
                            } else if (data.length === w * h) {
                                for (let i = 0, j = 0; i < data.length; i++, j += 4) {
                                    rgba[j] = rgba[j+1] = rgba[j+2] = data[i]; rgba[j+3] = 255;
                                }
                            } else continue;

                            const imgCanvas = new OffscreenCanvas(w, h);
                            imgCanvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
                            extractedImages[meta.id] = await imgCanvas.convertToBlob({ type: 'image/png' });
                        } catch (_) {}
                    }
                } catch (e) {
                    console.warn('[geometryWorker] image extraction failed:', e.message);
                }
            }

            // ── Phase 2: Region classification ───────────────────────────────
            const { regions, textMeta, columnSplits } = classifyPage(
                segments,
                textContent.items,
                viewport,
                pageWidthPt,
                imageMeta
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
                images: extractedImages,
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

