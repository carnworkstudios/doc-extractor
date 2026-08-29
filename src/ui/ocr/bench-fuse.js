// bench-fuse.js — YOLO + PP-OCR fusion benchmark.
//
// Measures the thing the OCR-only bench could not: table STRUCTURE. Text
// accuracy was already at parity with Docling; the gap was that Docling emits
// a grid and we emitted 88 loose lines.

import { extractPageImage } from '../../extraction/nativeImage.js';
import { detectLayout, disposeLayout } from './layout.js';
import { fuse } from './fuse.js';

export async function runFuseBench(bytes, pageNums, opts = {}) {
    const pdfjsLib = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;

    const ocr = await import('./index.js');
    ocr.setPreferredEngine('ppocr-v5-mobile');
    await ocr.ensureOcr();

    const results = [];
    for (const pageNum of pageNums) {
        const page = await doc.getPage(pageNum);
        const cond = opts.condition || 'render2';
        let canvas;
        if (cond === 'native') {
            const n = await extractPageImage(page, pdfjsLib);
            canvas = n && n.canvas;
        } else {
            canvas = await render(page, cond === 'render4' ? 4 : 2);
        }
        if (!canvas) continue;

        let t = performance.now();
        // A two-page spread is out of distribution for DocLayNet, which is
        // trained on single pages. `split` cuts the surface into N vertical
        // strips, detects each, and offsets the boxes back — so the model sees
        // something page-shaped. Boxes return in the ORIGINAL surface space.
        const split = opts.split || 1;
        let regions;
        if (split > 1) {
            regions = [];
            const stripW = Math.floor(canvas.width / split);
            for (let i = 0; i < split; i++) {
                const sc = document.createElement('canvas');
                sc.width = stripW; sc.height = canvas.height;
                sc.getContext('2d').drawImage(canvas, i * stripW, 0, stripW, canvas.height,
                                              0, 0, stripW, canvas.height);
                const rs = await detectLayout(sc);
                for (const r of rs) { r.bbox.x += i * stripW; regions.push(r); }
            }
        } else {
            regions = await detectLayout(canvas);
        }
        const layoutMs = Math.round(performance.now() - t);

        t = performance.now();
        const ocrRes = await ocr.recognizePage(canvas);
        const ocrMs = Math.round(performance.now() - t);

        const fused = fuse(regions, ocrRes.lines);
        const tables = fused.regions.filter((r) => r.label === 'table' && r.grid);

        results.push({
            page: pageNum, condition: cond, split: opts.split || 1,
            w: canvas.width, h: canvas.height, layoutMs, ocrMs,
            regionCount: regions.length,
            regions: regions.map((r)=>({label:r.label,c:+r.confidence.toFixed(2),b:[Math.round(r.bbox.x),Math.round(r.bbox.y),Math.round(r.bbox.w),Math.round(r.bbox.h)]})),
            labels: countBy(regions.map((r) => r.label)),
            lines: ocrRes.lines.length,
            orphans: fused.orphans.length,
            tables: tables.map((t2) => ({
                rows: t2.grid.rows, cols: t2.grid.cols,
                conf: +t2.confidence.toFixed(2), cells: t2.grid.cells,
            })),
        });
        if (opts.onRow) opts.onRow(results[results.length - 1]);
    }
    disposeLayout();
    return results;
}

async function render(page, scale) {
    const vp = page.getViewport({ scale });
    const c = Object.assign(document.createElement('canvas'),
        { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c;
}

function countBy(a) {
    const m = {};
    for (const x of a) m[x] = (m[x] || 0) + 1;
    return m;
}
