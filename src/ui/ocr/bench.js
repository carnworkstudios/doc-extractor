// bench.js — three-condition OCR benchmark: render@2 vs render@4 vs native.
//
// Phase 1's exit criterion from architecture/ocr-native-pipeline.md: native
// must match or beat render@4 on confidence at a fraction of the surface cost.
// If it does not, native extraction is not worth the rotation bookkeeping and
// the render path stays.
//
// Conditions differ ONLY in how the surface is produced. Everything downstream
// — detection, cropping, recognition — is the shipping code path, unmodified.

import { extractPageImage } from '../../extraction/nativeImage.js';

const ENGINES = ['ppocr-v5-mobile', 'tesseract-lstm'];

export async function runBench(bytes, pageNums, opts = {}) {
    const pdfjsLib = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;

    const ocr = await import('./index.js');
    const rows = [];

    for (const pageNum of pageNums) {
        const page = await doc.getPage(pageNum);
        const surfaces = {};

        // Time surface construction separately. "Native is cheaper" is a claim
        // about THIS number, not about recognition time, so measuring only the
        // OCR call would leave the central claim untested.
        let t = performance.now();
        surfaces.render2 = { canvas: await render(page, 2), meta: { resampled: true },
                             surfaceMs: Math.round(performance.now() - t) };
        t = performance.now();
        surfaces.render4 = { canvas: await render(page, 4), meta: { resampled: true },
                             surfaceMs: Math.round(performance.now() - t) };
        t = performance.now();
        const nat = await extractPageImage(page, pdfjsLib);
        const natMs = Math.round(performance.now() - t);
        if (nat) surfaces.native = { canvas: nat.canvas, meta: nat, surfaceMs: natMs };

        for (const [cond, surf] of Object.entries(surfaces)) {
            for (const engine of ENGINES) {
                // Dispose between engines so one engine's session cannot warm
                // the next one's timing.
                try { await ocr.disposeOcr(); } catch { /* first run */ }
                ocr.setPreferredEngine(engine);
                const t0 = performance.now();
                let res = null, err = null;
                try {
                    await ocr.ensureOcr();
                    res = await ocr.recognizePage(surf.canvas);
                } catch (e) { err = String(e && e.message || e); }
                const ms = Math.round(performance.now() - t0);
                const report = ocr.getOcrReport();

                rows.push({
                    page: pageNum, condition: cond, engine,
                    ok: !!res && !err, error: err,
                    // A fallback silently answering for the requested engine
                    // would corrupt the comparison, so record what actually ran.
                    actualEngine: report.engine, degraded: !!report.degraded,
                    w: surf.canvas.width, h: surf.canvas.height,
                    mpx: +((surf.canvas.width * surf.canvas.height) / 1e6).toFixed(2),
                    surfaceMs: surf.surfaceMs, ms, totalMs: ms + surf.surfaceMs,
                    words: res ? res.words.length : 0,
                    lines: res ? res.lines.length : 0,
                    conf: res ? +mean(res.lines.map((l) => l.confidence)).toFixed(1) : 0,
                    chars: res ? res.text.replace(/\s+/g, '').length : 0,
                    text: res ? res.text : '',
                    meta: surf.meta && {
                        dpi: surf.meta.dpi, rotate: surf.meta.rotate,
                        polarity: surf.meta.polarity, resampled: surf.meta.resampled,
                        source: surf.meta.source,
                    },
                });
                if (opts.onRow) opts.onRow(rows[rows.length - 1]);
            }
        }
    }
    return rows;
}

async function render(page, scale) {
    const vp = page.getViewport({ scale });
    const c = Object.assign(document.createElement('canvas'),
        { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
