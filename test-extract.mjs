// test-extract.mjs — Node.js pipeline smoke test
// Usage: node test-extract.mjs
// Outputs: test-out/59MN7C.html  test-out/sparktoro.html  test-out/diag.json

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

import { extractPaths }                                          from './src/extraction/vector/ctmAdapter.js';
import { classifyPage }                                          from './src/extraction/vector/contextClassifier.js';
import { assemblePage, createFontRegistry, generateDocumentStyles } from './src/extraction/vector/pageAssembler.js';
import { PageScale }                                             from './src/extraction/vector/pageScale.js';
import { detectStreamTables }                                    from './src/extraction/vector/streamDetector.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
pdfjsLib.GlobalWorkerOptions.workerSrc =
    path.join(__dir, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');

const DL     = '/Users/bonzai-carn/Downloads/';
const OUTDIR = path.join(__dir, 'test-out');
mkdirSync(OUTDIR, { recursive: true });

const PDFS = [
    { file: DL + '59MN7C-03SI.pdf',       slug: '59MN7C',    label: 'Multi-column engineering spec' },
    { file: DL + 'sparktoro-overview.pdf', slug: 'sparktoro', label: 'Borderless table overview'     },
];

const { OPS } = pdfjsLib;

// ── Build textMeta in viewport space (same logic as contextClassifier) ────────
function buildTextMeta(textItems, viewport) {
    const vpT   = viewport.transform;
    const scaleX = Math.hypot(vpT[0], vpT[1]) || 1;
    const scaleY = Math.hypot(vpT[2], vpT[3]) || 1;
    return textItems.map((item, idx) => {
        const vx = vpT[0]*item.transform[4] + vpT[2]*item.transform[5] + vpT[4];
        const vy = vpT[1]*item.transform[4] + vpT[3]*item.transform[5] + vpT[5];
        const fsPt = Math.abs(item.transform?.[3] || 12);
        const wPt  = item.width || (fsPt * 0.5 * (item.str?.length || 1));
        return { idx, vx, vy, vWidth: wPt*scaleX, vFont: fsPt*scaleY, fontSize: fsPt,
                 fontName: item.fontName||'', str: item.str||'', underlined: false };
    });
}

// ── Group items into Y-bands (mirrors streamDetector's _groupByYBand) ─────────
function yBands(items, yTol) {
    const sorted = [...items].filter(i => i.str.trim()).sort((a,b) => a.vy - b.vy);
    const bands = [];
    for (const tm of sorted) {
        let placed = false;
        for (const b of bands) {
            if (Math.abs(b.y - tm.vy) <= yTol) {
                const n = b.items.length;
                b.y = (b.y*n + tm.vy) / (n+1);
                b.items.push(tm);
                placed = true; break;
            }
        }
        if (!placed) bands.push({ y: tm.vy, items: [tm] });
    }
    return bands.sort((a,b) => a.y - b.y);
}

async function processPDF(filePath, slug, label) {
    const bytes = new Uint8Array(readFileSync(filePath));
    const pdf   = await pdfjsLib.getDocument({ data: bytes, disableWorker: true }).promise;

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${label}  (${pdf.numPages} pages)`);
    console.log(`${'─'.repeat(60)}`);

    const fontRegistry = createFontRegistry();
    const htmlParts    = [];
    const diag         = [];

    for (let p = 1; p <= Math.min(pdf.numPages, 6); p++) {
        const page        = await pdf.getPage(p);
        const viewport    = page.getViewport({ scale: 1.5 });
        const pageWidthPt = page.view[2] - page.view[0];

        const [opList, textContent] = await Promise.all([
            page.getOperatorList(),
            page.getTextContent(),
        ]);

        const segments  = extractPaths(opList, viewport, OPS);
        const { regions, textMeta } = classifyPage(segments, textContent.items, viewport, pageWidthPt);

        const hSegs    = segments.filter(s => Math.abs(s.y2-s.y1) <= 4 && Math.abs(s.x2-s.x1) > 4);
        const vSegs    = segments.filter(s => Math.abs(s.x2-s.x1) <= 4 && Math.abs(s.y2-s.y1) > 4);
        const diagSegs = segments.filter(s => Math.abs(s.x2-s.x1) > 4 && Math.abs(s.y2-s.y1) > 4);

        const regionSummary = regions.map(r => {
            const b = { type: r.type, items: r.textItemIndices?.length ?? 0 };
            if (r.type === 'TABLE') {
                b.rows   = r.lattice?.rows?.length ?? 0;
                b.cols   = r.lattice?.cols?.length ?? 0;
                b.method = r.lattice?.detectionMethod ?? 'lattice';
                b.border = r.lattice?.border ?? true;
                b.conf   = r.lattice?.confidence?.toFixed(2) ?? '—';
            }
            return b;
        });

        const tables = regionSummary.filter(r => r.type === 'TABLE');
        const nonTbl = regionSummary.filter(r => r.type !== 'TABLE');
        console.log(`\nPage ${p}: ${segments.length} segs (H:${hSegs.length} V:${vSegs.length} D:${diagSegs.length})  ${textContent.items.length} textItems`);
        tables.forEach(t => console.log(`  TABLE(${t.method},${t.rows}r×${t.cols}c,${t.items}items${t.border===false?',borderless':''}${t.conf!=='—'?',conf='+t.conf:''})`));
        if (nonTbl.length) console.log(`  non-table: ${nonTbl.map(r=>`${r.type}(${r.items})`).join(' ')}`);

        diag.push({ pdf: slug, page: p,
            segs: { total: segments.length, h: hSegs.length, v: vSegs.length, diag: diagSegs.length },
            textItems: textContent.items.length, regions: regionSummary });

        // ── Stream internals trace for sparktoro page 2 ───────────────────────
        if (slug === 'sparktoro' && p === 2) {
            const tm   = buildTextMeta(textContent.items, viewport);
            const sc   = new PageScale(tm, viewport);
            const bds  = yBands(tm, sc.yBandTolPx);
            const gaps = bds.slice(1).map((b,i) => ({
                from: Math.round(bds[i].y), to: Math.round(b.y),
                gap: Math.round(b.y - bds[i].y),
                overThreshold: (b.y - bds[i].y) > sc.streamGapPx
            }));
            const overCount = gaps.filter(g => g.overThreshold).length;

            console.log(`\n  [stream-internals] S=${sc.S.toFixed(1)} yBandTol=${sc.yBandTolPx.toFixed(1)} streamGap=${sc.streamGapPx.toFixed(1)} colTol=${sc.colTolPx.toFixed(1)}`);
            console.log(`  [stream-internals] ${bds.length} bands, ${overCount}/${gaps.length} inter-band gaps > streamGap`);
            bds.forEach((b,i) => {
                const gInfo = i < gaps.length ? `  gap→next=${gaps[i].gap}px${gaps[i].overThreshold?' ⚠':''}` : '';
                console.log(`    band[${i}] y=${Math.round(b.y).toString().padStart(4)}  n=${b.items.length}  xs=[${b.items.map(i=>Math.round(i.vx)).join(',')}]${gInfo}`);
            });

            // Direct call to detectStreamTables with all items
            const streamAll = detectStreamTables(tm, sc, []);
            console.log(`  [stream-internals] detectStreamTables(all ${tm.filter(i=>i.str.trim()).length} items): ${streamAll.length} candidates`);
            streamAll.forEach(c => console.log(`    → conf=${c.confidence?.toFixed(2)} rows=${c.rows?.length} cols=${c.cols?.length}`));
        }

        // ── Assemble HTML ─────────────────────────────────────────────────────
        const result = assemblePage(regions, textMeta, textContent.items, viewport, pageWidthPt, p, fontRegistry);
        if (result.html) htmlParts.push(result.html);

        page.cleanup();
    }

    const styles   = generateDocumentStyles(fontRegistry);
    const fullHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${label}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-size: 14px; line-height: 1.5; padding: 24px; max-width: 960px; margin: 0 auto; }
.pdf-page-content { border: 1px solid #ddd; padding: 16px; margin-bottom: 24px; border-radius: 4px; }
.page-label { font-size: 11px; color: #888; margin-bottom: 10px; }
.tablecoil { border-collapse: collapse; width: 100%; margin: 8px 0; }
.tablecoil th, .tablecoil td { border: 1px solid #bbb; padding: 4px 8px; font-size: 12px; vertical-align: top; }
.tablecoil th { background: #f4f4f4; font-weight: bold; }
h3, h4 { margin: 10px 0 4px; }
div + p, p + p { margin-top: 4px; }
ul, ol { margin: 4px 0 4px 20px; }
figure.pdf-image-region { background: #f8f8f8; display:flex; align-items:center; justify-content:center;
  border: 1px dashed #ccc; color:#999; font-size:11px; margin:8px 0; }
/* generated font + layout classes */
${styles}
</style>
</head>
<body>
${htmlParts.join('\n')}
</body>
</html>`;

    return { fullHtml, diag };
}

// ── Run ───────────────────────────────────────────────────────────────────────
const allDiag = [];

for (const { file, slug, label } of PDFS) {
    try {
        const { fullHtml, diag } = await processPDF(file, slug, label);
        const out = path.join(OUTDIR, `${slug}.html`);
        writeFileSync(out, fullHtml, 'utf8');
        console.log(`\n✓ wrote ${out}`);
        allDiag.push(...diag);
    } catch (err) {
        console.error(`\n✗ ${label}: ${err.message}`);
        console.error(err.stack);
    }
}

writeFileSync(path.join(OUTDIR, 'diag.json'), JSON.stringify(allDiag, null, 2), 'utf8');
console.log(`✓ wrote test-out/diag.json\n`);
