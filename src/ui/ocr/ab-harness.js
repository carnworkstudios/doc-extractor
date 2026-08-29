// ab-harness.js — run every OCR engine over the same page and diff them.
//
// The point is to make the engine decision on THIS corpus rather than on
// published benchmarks. A published number tells you how an engine does on
// someone else's scans; the documents in test-fixtures/ are the ones that have
// to work.
//
// Deterministic and read-only: renders a page, runs each engine over the exact
// same canvas, and reports. It never writes to the tool's state.

import { listEngines, setPreferredEngine, ensureOcr, recognizePage, getOcrReport, disposeOcr } from './index.js';

/**
 * Render one PDF page to a canvas at the same scale the scanned-geometry path
 * uses (RENDER_SCALE 2.0 in fileUpload.js), so the comparison reflects what the
 * tool actually feeds the engine.
 */
export async function renderPdfPage(bytes, pageNumber = 1, scale = 2.0) {
    const pdfjsLib = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

    const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return { canvas, pageCount: pdf.numPages };
}

export async function imageToCanvas(file) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return canvas;
}

/**
 * Run every engine over one canvas.
 *
 * Each engine is disposed before the next starts. Two model sets resident at
 * once on a single WASM thread would make the timings measure memory pressure
 * rather than the engines.
 *
 * @returns {Promise<Array<{engine, ok, ms, words, lines, text, meanConfidence, wordBoxes, error}>>}
 */
export async function runAll(canvas, onProgress) {
    const results = [];

    for (const engineName of listEngines()) {
        onProgress?.(`Running ${engineName}...`);
        await disposeOcr();
        await setPreferredEngine(engineName);

        const started = performance.now();
        try {
            await ensureOcr((m) => onProgress?.(`${engineName}: ${m.status || m.progress || ''}`));
            const report = getOcrReport();

            // A fallback means this engine did not run. Recording it as a
            // result for the engine we asked for would quietly compare an
            // engine against itself.
            if (report.degraded || report.engine !== engineName) {
                results.push({
                    engine: engineName, ok: false, ms: 0,
                    error: report.reason || `fell back to ${report.engine}`,
                });
                continue;
            }

            const out = await recognizePage(canvas);
            const ms = performance.now() - started;
            const confs = out.words.map((w) => w.confidence).filter((c) => typeof c === 'number');
            results.push({
                engine: engineName,
                ok: true,
                ms,
                words: out.words,
                lines: out.lines || [],
                text: out.text,
                meanConfidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
                wordBoxes: report.wordBoxes,
            });
        } catch (err) {
            results.push({ engine: engineName, ok: false, ms: performance.now() - started, error: err.message });
        }
    }

    await disposeOcr();
    return results;
}

// ── Comparison ──────────────────────────────────────────────────────────────

/** Normalise for comparison: case, punctuation spacing, and runs of whitespace. */
function normalise(text) {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function tokenise(text) {
    return normalise(text).split(' ').filter(Boolean);
}

/**
 * Word-level edit distance, normalised to a 0..1 similarity.
 *
 * Levenshtein over TOKENS rather than characters: a single misread character
 * inside a long word should cost one word, not one character, because the
 * downstream consumer is a word list.
 */
export function similarity(a, b) {
    const A = tokenise(a);
    const B = tokenise(b);
    if (!A.length && !B.length) return 1;
    if (!A.length || !B.length) return 0;

    let prev = new Array(B.length + 1);
    let cur = new Array(B.length + 1);
    for (let j = 0; j <= B.length; j++) prev[j] = j;

    for (let i = 1; i <= A.length; i++) {
        cur[0] = i;
        for (let j = 1; j <= B.length; j++) {
            const cost = A[i - 1] === B[j - 1] ? 0 : 1;
            cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        [prev, cur] = [cur, prev];
    }
    return 1 - prev[B.length] / Math.max(A.length, B.length);
}

/**
 * Tokens present in one engine's output and not the other's.
 *
 * A multiset difference, not a set one: an engine that reads "the" five times
 * where the other reads it twice has a real discrepancy, and deduping would
 * hide it.
 */
export function tokenDiff(a, b) {
    const count = (tokens) => {
        const m = new Map();
        for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
        return m;
    };
    const A = count(tokenise(a));
    const B = count(tokenise(b));
    const onlyA = [];
    const onlyB = [];
    for (const [t, n] of A) {
        const d = n - (B.get(t) || 0);
        for (let i = 0; i < d; i++) onlyA.push(t);
    }
    for (const [t, n] of B) {
        const d = n - (A.get(t) || 0);
        for (let i = 0; i < d; i++) onlyB.push(t);
    }
    return { onlyA, onlyB };
}

/** Draw an engine's word boxes over a copy of the page, for eyeballing drift. */
export function overlay(canvas, words, color = '#e11d48') {
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    ctx.lineWidth = 2;
    for (const w of words) {
        // Estimated boxes are drawn dashed. The visual difference between a
        // measured and an apportioned position is the single thing this
        // harness exists to make obvious.
        ctx.setLineDash(w.approx ? [4, 3] : []);
        ctx.strokeStyle = color;
        ctx.strokeRect(w.bbox.x0, w.bbox.y0, w.bbox.x1 - w.bbox.x0, w.bbox.y1 - w.bbox.y0);
    }
    return out;
}
