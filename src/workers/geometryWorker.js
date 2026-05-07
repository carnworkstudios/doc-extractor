// geometryWorker.js
// Local fallback extraction worker: PDF.js operator list → CTM baking
// → axis-aligned line detection → LatticeReconstructor → merged-cell HTML tables.
//
// Does not require any backend. Runs entirely in the browser.
// Handles table grids only — text paragraphs and headings are not extracted.
//
// Message in:  { type: 'process', bytes: Uint8Array }
// Messages out:
//   { type: 'progress', page: number, total: number, status: string }
//   { type: 'complete', html: string, pageCount: number, tableCount: number }
//   { type: 'error',    error: string }

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { extractPaths } from '../extraction/vector/ctmAdapter.js';
import { LatticeReconstructor } from '../extraction/vector/latticeReconstructor.js';
import { buildTable } from '../extraction/vector/tableBuilder.js';

// pdfjs-dist v4 — point to the ESM worker bundle.
// Nested workers are supported in all modern browsers.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const { OPS } = pdfjsLib;

self.onmessage = async (e) => {
    if (e.data.type !== 'process') return;
    const { bytes } = e.data;

    try {
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        const numPages = pdf.numPages;
        const pageSections = [];

        for (let p = 1; p <= numPages; p++) {
            self.postMessage({ type: 'progress', page: p, total: numPages, status: 'Extracting vector paths…' });

            const page = await pdf.getPage(p);
            const viewport = page.getViewport({ scale: 1.5 });

            const [opList, textContent] = await Promise.all([
                page.getOperatorList(),
                page.getTextContent(),
            ]);

            const segments = extractPaths(opList, viewport, OPS);
            const lattice = new LatticeReconstructor(segments).reconstruct();

            if (!lattice) continue;

            const tableHtml = buildTable(lattice, textContent.items, viewport);
            if (!tableHtml) continue;

            pageSections.push({ page: p, html: tableHtml });
        }

        const tableCount = pageSections.length;
        const html = tableCount > 0
            ? pageSections.map(s =>
                `<section class="pdf-page-tables" data-page="${s.page}">\n` +
                `<h4 class="page-label">Page ${s.page}</h4>\n${s.html}\n</section>`,
              ).join('\n')
            : '<p class="no-tables-msg">No table structures detected. This PDF may use text-only layout.</p>';

        self.postMessage({ type: 'complete', html, pageCount: numPages, tableCount });
    } catch (err) {
        self.postMessage({ type: 'error', error: err.message || String(err) });
    }
};
