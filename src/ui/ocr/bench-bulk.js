// bench-bulk.js — corpus smoke test: our client stack vs Docling.
//
// Runs the full pipeline over a set of scanned PDFs, emits the lineage events
// from provenance.js at each block boundary, and renders a labelled overlay so
// the regions and the reconstructed grids can be seen rather than trusted.

import { extractPageImage } from '../../extraction/nativeImage.js';
import { detectLayout, disposeLayout } from './layout.js';
import { fuse } from './fuse.js';
import { createLineage, hashCanvas } from './provenance.js';

const COLORS = {
    table: '#e6194b', picture: '#3cb44b', text: '#4363d8',
    'section-heading': '#f58231', title: '#911eb4', 'list-item': '#42d4f4',
    'page-header': '#808000', 'page-footer': '#9a6324', caption: '#f032e6',
    footnote: '#469990', formula: '#bfef45',
};

export async function runBulk(files, opts = {}) {
    const pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default;
    const ocr = await import('./index.js');
    if (opts.detMaxSide) {
        const eng = await import('./engines/ppocr.js');
        eng.setDetMaxSide(opts.detMaxSide);
    }
    ocr.setPreferredEngine('ppocr-v5-mobile');
    await ocr.ensureOcr();

    const out = [];
    for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
        const lineage = createLineage(`ses_${file.name.replace(/\W+/g, '_')}`);
        const pageResults = [];

        const nPages = Math.min(doc.numPages, opts.maxPages || 2);
        for (let pn = 1; pn <= nPages; pn++) {
            const page = await doc.getPage(pn);

            // ── block 1: surface ────────────────────────────────────────────
            let t = performance.now();
            // Native extraction is diagnostic here, not the surface — a
            // failure must not take the page down with it.
            let nat = null;
            try { nat = await extractPageImage(page, pdfjsLib); }
            catch (e) { nat = null; }
            const vp = page.getViewport({ scale: 2 });
            const canvas = Object.assign(document.createElement('canvas'),
                { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
            await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
            const surfaceMs = Math.round(performance.now() - t);
            const surfHash = await hashCanvas(canvas);
            const evExtract = await lineage.emit(
                { op: 'extract_image',
                  dpi: nat ? Math.round(nat.dpi.x) : null,
                  rotate: nat ? nat.rotate : page.rotate,
                  polarity: nat ? nat.polarity : null,
                  native: nat ? [nat.width, nat.height] : null,
                  surface: [canvas.width, canvas.height], surface_mode: 'render@2' },
                { subject: { pointer: { file: file.name, page: pn }, sha256: surfHash } });

            // ── block 2: layout (spread-split) ──────────────────────────────
            t = performance.now();
            const split = canvas.width > canvas.height * 1.35 ? 2 : 1;
            let regions = [];
            if (split > 1) {
                const sw = Math.floor(canvas.width / split);
                for (let i = 0; i < split; i++) {
                    const sc = Object.assign(document.createElement('canvas'),
                        { width: sw, height: canvas.height });
                    sc.getContext('2d').drawImage(canvas, i * sw, 0, sw, canvas.height,
                                                  0, 0, sw, canvas.height);
                    for (const r of await detectLayout(sc)) { r.bbox.x += i * sw; regions.push(r); }
                }
            } else regions = await detectLayout(canvas);
            const layoutMs = Math.round(performance.now() - t);
            const evLayout = await lineage.emit(
                { op: 'detect_layout', model: 'yolov8n-doclaynet', split,
                  regions: regions.length, labels: countBy(regions.map((r) => r.label)) },
                { parents: [evExtract.id],
                  score: regions.length ? +mean(regions.map((r) => r.confidence)).toFixed(3) : null });

            // ── block 3: recognition ────────────────────────────────────────
            t = performance.now();
            const res = await ocr.recognizePage(canvas);
            const ocrMs = Math.round(performance.now() - t);
            const conf = mean(res.lines.map((l) => l.confidence));
            let scaleRep = null;
            try { scaleRep = (await import('./engines/ppocr.js')).getScaleReport(); } catch { /* other engine */ }
            const evOcr = await lineage.emit(
                { op: 'recognize', engine: ocr.getOcrReport().engine,
                  lines: res.lines.length, words: res.words.length,
                  conf: +conf.toFixed(1),
                  // The adaptive-scale decision belongs in the record: it is the
                  // difference between "this page has little text" and "the
                  // detector could not resolve it".
                  det_cap: scaleRep && scaleRep.cap, body_px: scaleRep && scaleRep.S,
                  starved: scaleRep && scaleRep.starved },
                { parents: [evExtract.id], score: +(conf / 100).toFixed(3) });

            // ── block 4: fusion ─────────────────────────────────────────────
            const fused = fuse(regions, res.lines);
            const tables = fused.regions.filter((r) => r.label === 'table' && r.grid);
            const evFuse = await lineage.emit(
                { op: 'fuse_regions', tables: tables.length,
                  grids: tables.map((x) => [x.grid.rows, x.grid.cols]),
                  orphan_lines: fused.orphans.length },
                { parents: [evLayout.id, evOcr.id] });   // <- the DAG join

            pageResults.push({
                page: pn, surfaceMs, layoutMs, ocrMs,
                w: canvas.width, h: canvas.height, split,
                native: nat ? { w: nat.width, h: nat.height, dpi: Math.round(nat.dpi.x),
                                rotate: nat.rotate, polarity: nat.polarity } : null,
                regions: regions.length, labels: countBy(regions.map((r) => r.label)),
                lines: res.lines.length, words: res.words.length,
                scale: scaleRep, conf: +conf.toFixed(1), chars: res.text.replace(/\s+/g, '').length,
                tables: tables.map((x) => ({ rows: x.grid.rows, cols: x.grid.cols,
                                             conf: +x.confidence.toFixed(2), cells: x.grid.cells })),
                orphans: fused.orphans.length,
                overlay: overlay(canvas, regions, res.lines),
                evidence: [evExtract.id, evLayout.id, evOcr.id, evFuse.id],
            });
        }
        out.push({ file: file.name, pages: pageResults,
                   lineage: lineage.events, chainOk: (await lineage.verify()) === -1 });
        if (opts.onFile) opts.onFile(out[out.length - 1]);
    }
    disposeLayout();
    return out;
}

/** Region boxes + OCR line boxes drawn over a downscaled page. */
function overlay(canvas, regions, lines) {
    const S = Math.min(1, 1100 / canvas.width);
    const c = Object.assign(document.createElement('canvas'),
        { width: Math.round(canvas.width * S), height: Math.round(canvas.height * S) });
    const ctx = c.getContext('2d');
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(0, 0, c.width, c.height);

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,90,200,0.55)';
    for (const l of lines) {
        ctx.strokeRect(l.bbox.x0 * S, l.bbox.y0 * S,
                       (l.bbox.x1 - l.bbox.x0) * S, (l.bbox.y1 - l.bbox.y0) * S);
    }
    ctx.lineWidth = 2.5;
    ctx.font = '600 11px system-ui, sans-serif';
    for (const r of regions) {
        const col = COLORS[r.label] || '#000';
        ctx.strokeStyle = col;
        ctx.strokeRect(r.bbox.x * S, r.bbox.y * S, r.bbox.w * S, r.bbox.h * S);
        const label = `${r.label} ${r.confidence.toFixed(2)}`;
        const tw = ctx.measureText(label).width + 6;
        ctx.fillStyle = col;
        ctx.fillRect(r.bbox.x * S, Math.max(0, r.bbox.y * S - 13), tw, 13);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, r.bbox.x * S + 3, Math.max(10, r.bbox.y * S - 3));
    }
    return c.toDataURL('image/jpeg', 0.72);
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function countBy(a) { const m = {}; for (const x of a) m[x] = (m[x] || 0) + 1; return m; }
