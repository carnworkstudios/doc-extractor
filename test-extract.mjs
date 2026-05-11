// test-extract.mjs — Node.js pipeline smoke test
// Usage: node test-extract.mjs
// Outputs: test-out/59MN7C.html  test-out/sparktoro.html  test-out/diag.json

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

import { extractPaths }                                          from './src/extraction/vector/ctmAdapter.js';
import { classifyPage }                                          from './src/extraction/vector/contextClassifier.js';
import { assemblePage, createFontRegistry, generateDocumentStyles } from './src/extraction/vector/pageAssembler.js';
import { PageScale }                                             from './src/extraction/vector/pageScale.js';
import { detectStreamTables }                                    from './src/extraction/vector/streamDetector.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
pdfjsLib.GlobalWorkerOptions.workerSrc =
    path.join(__dir, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');

const DL     = path.join(os.homedir(), 'Downloads/');
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

        const { segments, imageMeta }  = extractPaths(opList, viewport, OPS);
        const { regions, textMeta, columnSplits } = classifyPage(segments, textContent.items, viewport, pageWidthPt, imageMeta);

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

        // ── Column layout trace for 59MN7C pages 1, 4, 6 ────────────────────
        if (slug === '59MN7C' && (p === 1 || p === 4 || p === 6)) {
            const vpT2 = viewport.transform;
            const sc2X = Math.hypot(vpT2[0], vpT2[1]) || 1;
            const sc2Y = Math.hypot(vpT2[2], vpT2[3]) || 1;

            // Use UNCLAIMED items only (those not inside any region bbox)
            // Table items span the full page horizontally and hide the column gutter.
            const claimedIdx = new Set(regions.flatMap(r => r.textItemIndices || []));
            const unclaimedItems = textContent.items
                .map((item, idx) => {
                    if (!item.str?.trim() || claimedIdx.has(idx)) return null;
                    const vx = vpT2[0]*item.transform[4] + vpT2[2]*item.transform[5] + vpT2[4];
                    const vy = vpT2[1]*item.transform[4] + vpT2[3]*item.transform[5] + vpT2[5];
                    const fsPt = Math.abs(item.transform?.[3] || 12);
                    const vw2 = (item.width || fsPt * 0.5 * (item.str?.length || 1)) * sc2X;
                    return { vx, vy, vw: vw2, str: item.str.trim() };
                })
                .filter(Boolean);

            // Group into Y-bands and count per-band X gap presence.
            // A column gutter is an X range that appears in > 40% of bands.
            const vFont0 = 12 * sc2Y; // fallback band tolerance
            const sortedByY = [...unclaimedItems].sort((a,b) => a.vy - b.vy);
            const bands2 = [];
            for (const it of sortedByY) {
                let b = bands2.find(b => Math.abs(b.y - it.vy) <= vFont0 * 0.45);
                if (b) { b.items.push(it); b.y = (b.y*(b.items.length-1)+it.vy)/b.items.length; }
                else bands2.push({ y: it.vy, items: [it] });
            }

            const w = Math.ceil(viewport.width);
            const bandCount2 = new Float32Array(w);  // bands covering each pixel
            for (const band of bands2) {
                const seen = new Uint8Array(w);
                for (const it of band.items) {
                    const x1 = Math.max(0, Math.floor(it.vx));
                    const x2 = Math.min(w-1, Math.ceil(it.vx + it.vw));
                    for (let x = x1; x <= x2; x++) seen[x] = 1;
                }
                for (let x = 0; x < w; x++) bandCount2[x] += seen[x];
            }

            // Find X ranges where < 40% of bands have coverage (the gutter)
            const threshold = bands2.length * 0.40;
            const gutters2 = [];
            let gs2 = null;
            for (let x = Math.floor(w*0.1); x < w*0.9; x++) {
                if (bandCount2[x] < threshold) { if (gs2===null) gs2=x; }
                else if (gs2 !== null) { if (x-gs2 >= 10) gutters2.push({ x: gs2, w: x-gs2, mid: (gs2+x)/2 }); gs2=null; }
            }
            gutters2.sort((a,b) => b.w - a.w);

            // Since all non-empty items ARE in regions, use REGION BBOXES instead.
            // Project non-table region bboxes to find the column gutter.
            const textRegions = regions.filter(r => r.type !== 'TABLE' && r.type !== 'IMAGE' && r.bbox);
            const w2 = Math.ceil(viewport.width);
            const regBandCount = new Float32Array(w2);

            // For per-band gutter detection on regions: treat each region as a "band"
            for (const r of textRegions) {
                const seen = new Uint8Array(w2);
                const x1 = Math.max(0, Math.floor(r.bbox.x));
                const x2 = Math.min(w2-1, Math.ceil(r.bbox.x + r.bbox.w));
                for (let x = x1; x <= x2; x++) seen[x] = 1;
                for (let x = 0; x < w2; x++) regBandCount[x] += seen[x];
            }

            const regThreshold = textRegions.length * 0.40;
            const regGutters = [];
            let rgs = null;
            for (let x = Math.floor(w2*0.1); x < w2*0.9; x++) {
                if (regBandCount[x] < regThreshold) { if (rgs===null) rgs=x; }
                else if (rgs !== null) { if (x-rgs >= 15) regGutters.push({ x: rgs, w: x-rgs, mid: (rgs+x)/2 }); rgs=null; }
            }
            regGutters.sort((a,b) => b.w - a.w);

            console.log(`  [col-trace p${p}] vp.width=${w2}  textRegions=${textRegions.length}  gutters≥15px from region bboxes: ${regGutters.length}`);
            regGutters.slice(0,3).forEach(g =>
                console.log(`    gutter x=${Math.round(g.x)}–${Math.round(g.x+g.w)} (${Math.round(g.w)}px, mid=${Math.round(g.mid)})`));

            // Directly invoke _detectPageColumns logic to print narrow band info
        {
            const vpT2 = viewport.transform;
            const sc2X = Math.hypot(vpT2[0],vpT2[1])||1;
            const sc2Y = Math.hypot(vpT2[2],vpT2[3])||1;
            const sc = new PageScale(textMeta.filter(i=>i.str?.trim()), viewport);
            const remaining = textMeta.filter(i=>i.str?.trim());
            const sorted2 = [...remaining].sort((a,b)=>a.vy-b.vy);
            const bands2=[];
            for(const tm of sorted2){
                let placed=false;
                for(const b of bands2){if(Math.abs(b.y-tm.vy)<=sc.yBandTolPx){const n=b.items.length;b.y=(b.y*n+tm.vy)/(n+1);b.items.push(tm);placed=true;break;}}
                if(!placed)bands2.push({y:tm.vy,items:[tm]});
            }
            const vw2=viewport.width;
            let wideBands=0,narrowBands=0;
            const cov=new Float32Array(Math.ceil(vw2));
            for(const band of bands2){
                let minX=Infinity,maxX=-Infinity;
                for(const tm of band.items){if(tm.vx<minX)minX=tm.vx;const re=tm.vx+(tm.vWidth||0);if(re>maxX)maxX=re;}
                if(maxX-minX>vw2*0.55){wideBands++;continue;}
                narrowBands++;
                for(const tm of band.items){
                    const x1=Math.max(0,Math.floor(tm.vx));
                    const x2=Math.min(Math.ceil(vw2)-1,Math.ceil(tm.vx+(tm.vWidth||0)));
                    for(let x=x1;x<=x2;x++)cov[x]++;
                }
            }
            // Per-band count: bandCov[x] = how many narrow bands cover pixel x
            // (each band counted once per pixel, not per item)
            const bandCov = new Float32Array(Math.ceil(vw2));
            let narrowBandList=[];
            for(const band of bands2){
                let minX=Infinity,maxX=-Infinity;
                for(const tm of band.items){if(tm.vx<minX)minX=tm.vx;const re=tm.vx+(tm.vWidth||0);if(re>maxX)maxX=re;}
                if(maxX-minX>vw2*0.55)continue;
                narrowBandList.push(band);
                const seen=new Uint8Array(Math.ceil(vw2));
                for(const tm of band.items){
                    const x1=Math.max(0,Math.floor(tm.vx));
                    const x2=Math.min(Math.ceil(vw2)-1,Math.ceil(tm.vx+(tm.vWidth||0)));
                    for(let x=x1;x<=x2;x++)seen[x]=1;
                }
                for(let x=0;x<Math.ceil(vw2);x++)bandCov[x]+=seen[x];
            }
            // Find local minimum (gutter): X ranges where bandCov < 20% of narrow bands
            const nThresh = narrowBandList.length * 0.20;
            const gaps3=[]; let gs3=null;
            for(let x=Math.floor(vw2*0.10);x<vw2*0.90;x++){
                if(bandCov[x]<nThresh){if(gs3===null)gs3=x;}
                else if(gs3!==null){if(x-gs3>=10)gaps3.push({x:gs3,w:x-gs3,mid:(gs3+x)/2});gs3=null;}
            }
            console.log(`  [split-debug p${p}] ${bands2.length} bands: ${narrowBandList.length} narrow, ${wideBands} wide  threshold=${nThresh.toFixed(1)}`);
            console.log(`  bandCov sample: x=200→${bandCov[200].toFixed(0)} x=400→${bandCov[400].toFixed(0)} x=440→${bandCov[440].toFixed(0)} x=460→${bandCov[460].toFixed(0)} x=473→${bandCov[473].toFixed(0)} x=600→${bandCov[600].toFixed(0)}`);
            gaps3.sort((a,b)=>b.w-a.w).slice(0,3).forEach(g=>
                console.log(`  band-gap x=${Math.round(g.x)}–${Math.round(g.x+g.w)} (${Math.round(g.w)}px, bandCov<${nThresh.toFixed(0)}, mid=${Math.round(g.mid)})`));
        }

        // Dump all regions sorted by yCenter showing columnIndex
            const sortedAll = [...regions].filter(r=>r.bbox).sort((a,b) => a.yCenter - b.yCenter);
            console.log(`  [col-trace p${p}] all regions by Y (ci=columnIndex):`);
            sortedAll.forEach(r => {
                const ci = r.columnIndex ?? '?';
                console.log(`    ci=${ci.toString().padStart(2)}  ${r.type.padEnd(9)} x=${Math.round(r.bbox.x).toString().padStart(4)}  w=${Math.round(r.bbox.w).toString().padStart(4)}  items=${r.textItemIndices?.length ?? 0}`);
            });
        }

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
        const extractedImages = {}; // No OffscreenCanvas in Node.js, emit empty bitmaps
        const result = assemblePage(regions, textMeta, textContent.items, viewport, pageWidthPt, p, fontRegistry, columnSplits, extractedImages);
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
