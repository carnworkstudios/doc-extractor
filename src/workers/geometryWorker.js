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
            const segments = extractPaths(opList, viewport, OPS);

            // ── Phase 2: Region classification ───────────────────────────────
            const { regions, textMeta, columnSplits } = classifyPage(
                segments,
                textContent.items,
                viewport,
                pageWidthPt,
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
            );

            totalTables += result.tableCount;

            // Stream per-page result — avoids accumulating huge payloads
            self.postMessage({
                type: 'page',
                page: p,
                html: result.html,
                text: result.text.trim(),
                tables: result.tableCount,
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

