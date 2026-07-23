// pdfAnalyzer.js
// Lightweight PDF structure analyzer — runs on the main thread before extraction.
// Produces metadata + per-page geometry breakdown:
//   - PDF metadata (version, author, creator, dimensions, etc.)
//   - Path segments classified by orientation (H / V / diagonal)
//   - Text item positions
//   - Image op count + approximate bounding boxes
//   - Closed-rect candidates (potential table frames)
//
// Worker strategy:
//   - For small PDFs (≤ 30 pages): disableWorker=true to avoid nested worker
//     network issues with Vite's HMR ping system
//   - For large PDFs (> 30 pages): use a proper worker to avoid blocking the UI

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { extractSubpaths } from './ctmAdapter.js';
import { reconcile } from './pathReconciler.js';

const { OPS } = pdfjsLib;

// Set workerSrc globally — pdfjs-dist v4 requires this even when disableWorker is used.
// For small files the analyzer uses disableWorker=true to avoid Vite HMR nested worker issues.
// For large files it uses the real worker for performance.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ── Helpers ───────────────────────────────────────────────────────────────────

function readPDFVersion(bytes) {
    const header = new TextDecoder('ascii', { fatal: false }).decode(bytes.slice(0, 20));
    const m = header.match(/%PDF-(\d+\.\d+)/);
    return m ? m[1] : 'unknown';
}

function formatDate(pdfDateStr) {
    if (!pdfDateStr) return '';
    // PDF date format: D:YYYYMMDDHHmmSSOHH'mm'
    const m = pdfDateStr.match(/D:(\d{4})(\d{2})(\d{2})/);
    if (!m) return pdfDateStr;
    return `${m[1]}-${m[2]}-${m[3]}`;
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(2)} MB`;
}

// Classify segments by orientation
function classifySegments(segments, eps = 4) {
    const hSegs = [], vSegs = [], diagSegs = [];
    for (const s of segments) {
        const dx = Math.abs(s.x2 - s.x1);
        const dy = Math.abs(s.y2 - s.y1);
        if (dy <= eps && dx > eps) hSegs.push(s);
        else if (dx <= eps && dy > eps) vSegs.push(s);
        else if (dx > 2 && dy > 2) diagSegs.push(s);
    }
    return { hSegs, vSegs, diagSegs };
}

// Detect closed rectangles from 4 edge segments sharing corners
// Returns an array of { x, y, w, h } bboxes (in viewport coords)
function detectClosedRects(hSegs, vSegs, eps = 6) {
    const rects = [];

    // Use a simplified approach: collect unique Y-values from hSegs,
    // then for each pair of Y-values at similar X-spans, check for connecting verticals
    const hByY = new Map();
    for (const h of hSegs) {
        const key = Math.round(h.y1 * 10) / 10; // round to 0.1px
        if (!hByY.has(key)) hByY.set(key, []);
        hByY.get(key).push(h);
    }

    for (const h1 of hSegs) {
        for (const h2 of hSegs) {
            if (h2 === h1) continue;
            // h1 and h2 must have similar x-spans
            if (Math.abs(h1.x1 - h2.x1) > eps || Math.abs(h1.x2 - h2.x2) > eps) continue;

            const yTop = Math.min(h1.y1, h2.y1);
            const yBot = Math.max(h1.y1, h2.y1);
            if (yBot - yTop < 4) continue;

            // Need a left vertical and a right vertical connecting the two horizontals
            const hasLeft = vSegs.some(v =>
                Math.abs(v.x1 - h1.x1) <= eps &&
                Math.min(v.y1, v.y2) <= yTop + eps &&
                Math.max(v.y1, v.y2) >= yBot - eps,
            );
            const hasRight = vSegs.some(v =>
                Math.abs(v.x1 - h1.x2) <= eps &&
                Math.min(v.y1, v.y2) <= yTop + eps &&
                Math.max(v.y1, v.y2) >= yBot - eps,
            );

            if (hasLeft && hasRight) {
                rects.push({
                    x: h1.x1, y: yTop,
                    w: h1.x2 - h1.x1,
                    h: yBot - yTop,
                });
            }
        }
    }
    return rects;
}

// Collect image XObject bounding boxes by tracking CTM at paintXObject time
function collectImageRegions(opList, viewport) {
    const { fnArray, argsArray } = opList;
    const vpTransform = viewport.transform;

    const identity = [1, 0, 0, 1, 0, 0];
    const ctmStack = [identity.slice()];
    let ctm = identity.slice();

    function mul(a, b) {
        return [
            a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
            a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
            a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5],
        ];
    }
    function pt(ctmM, x, y) {
        // Apply CTM then viewport transform
        const [cx, cy] = [ctmM[0]*x+ctmM[2]*y+ctmM[4], ctmM[1]*x+ctmM[3]*y+ctmM[5]];
        return [
            vpTransform[0]*cx + vpTransform[2]*cy + vpTransform[4],
            vpTransform[1]*cx + vpTransform[3]*cy + vpTransform[5],
        ];
    }

    const regions = [];

    for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i];
        if (fn === OPS.save)          { ctmStack.push(ctm.slice()); }
        else if (fn === OPS.restore)  { ctm = ctmStack.pop() || identity.slice(); }
        else if (fn === OPS.transform){ ctm = mul(ctm, argsArray[i]); }
        else if (
            fn === OPS.paintXObject ||
            fn === OPS.paintImageXObject ||
            fn === OPS.paintInlineImageXObject
        ) {
            // Image occupies the unit square [0,1]×[0,1] transformed by CTM
            const corners = [[0,0],[1,0],[1,1],[0,1]].map(([x,y]) => pt(ctm, x, y));
            const xs = corners.map(c => c[0]);
            const ys = corners.map(c => c[1]);
            const x = Math.min(...xs), y = Math.min(...ys);
            const w = Math.max(...xs) - x;
            const h = Math.max(...ys) - y;
            if (w > 8 && h > 8) regions.push({ x, y, w, h });
        }
    }
    return regions;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyze a PDF file.
 *
 * @param {Uint8Array} bytes — raw PDF bytes
 * @param {function} [onPageDone] — callback(pageNum, total) for progress
 * @returns {Promise<AnalysisResult>}
 */
export async function analyzePDF(bytes, onPageDone) {
    const version = readPDFVersion(bytes);
    // Always use disableWorker for the analyzer — it processes one page at a time
    // and doesn't benefit much from a worker. This avoids Vite HMR nested worker issues.
    const pdf = await pdfjsLib.getDocument({ data: bytes, disableWorker: true }).promise;

    const rawMeta = await pdf.getMetadata();
    const info = rawMeta.info || {};

    const metadata = {
        pdfVersion:  version,
        fileSize:    formatBytes(bytes.length),
        fileSizeRaw: bytes.length,
        numPages:    pdf.numPages,
        title:       info.Title       || '',
        author:      info.Author      || '',
        subject:     info.Subject     || '',
        creator:     info.Creator     || '',
        producer:    info.Producer    || '',
        created:     formatDate(info.CreationDate),
        modified:    formatDate(info.ModDate),
        encrypted:   info.IsAcroFormPresent || false,
    };

    const pages = [];

    for (let p = 1; p <= pdf.numPages; p++) {
        const page   = await pdf.getPage(p);
        const vp     = page.getViewport({ scale: 1.5 });
        const [opList, tc] = await Promise.all([
            page.getOperatorList(),
            page.getTextContent(),
        ]);

        const { subpaths, filledRects: rawFilledRects } = extractSubpaths(opList, vp, OPS);
        const { segments } = reconcile(subpaths, rawFilledRects, vp);
        const { hSegs, vSegs, diagSegs } = classifySegments(segments);
        const closedRects   = detectClosedRects(hSegs, vSegs);
        const imageRegions  = collectImageRegions(opList, vp);

        // Point size dimensions (72 pt/inch)
        const ptW = page.view[2] - page.view[0];
        const ptH = page.view[3] - page.view[1];

        // Scanned-page detection: near-zero extractable text plus image
        // coverage over most of the page means the vector pipeline has nothing
        // to work with — this page needs an OCR tier (out of scope for the
        // vector architecture, pdf-extraction-v2.md §09) and must be flagged,
        // not silently extracted as empty.
        const realTextCount = tc.items.filter(i => i.str?.trim()).length;
        const pageArea = vp.width * vp.height;
        const imageArea = imageRegions.reduce((sum, r) => sum + r.w * r.h, 0);
        const scanBackdrop = segments.length < 20 && imageArea >= pageArea * 0.5;
        const scanned  = scanBackdrop && realTextCount < 5;
        // Scan with an OCR text layer: the text IS readable — it stays in the
        // local pipeline (with OCR-relaxed word-gap gates), unlike `scanned`
        // pages which have nothing for the vector engine to read.
        const ocrLayer = scanBackdrop && realTextCount >= 5;

        pages.push({
            scanned,
            ocrLayer,
            pageNum:       p,
            widthPx:       vp.width,
            heightPx:      vp.height,
            widthPt:       ptW,
            heightPt:      ptH,
            widthIn:       (ptW / 72).toFixed(2),
            heightIn:      (ptH / 72).toFixed(2),
            textItemCount: tc.items.length,
            hSegCount:     hSegs.length,
            vSegCount:     vSegs.length,
            diagSegCount:  diagSegs.length,
            totalSegCount: segments.length,
            imageCount:    imageRegions.length,
            closedRectCount: closedRects.length,
            hSegs, vSegs, diagSegs,
            closedRects,
            imageRegions,
            textItems:     tc.items,
            viewport:      vp,
        });

        onPageDone?.(p, pdf.numPages);
    }

    return { metadata, pages };
}
