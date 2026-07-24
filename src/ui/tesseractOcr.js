// tesseractOcr.js
//
// Browser-native OCR via tesseract.js — replaces the TrOCR path for scanned PDFs.
//
// Why Tesseract over TrOCR here:
//   • Whole-page recognition — does its OWN line/word segmentation, so we no
//     longer need the projection-profile line splitter.
//   • Returns words with REAL bbox + confidence — feeds synthetic PDF.js text
//     items at true positions (not synthesized from region geometry) and gives
//     the provenance spine a native per-word confidence.
//   • Classifier, not generator — cannot hallucinate words the way a VLM/TrOCR
//     decoder can.
//
// LOCAL-FIRST: every asset (worker script, core WASM, traineddata) is
// self-hosted under the Vite base — NO CDN. The CSP blocks external hosts, and
// tesseract.js defaults to a CDN, so all three paths are set explicitly.

import { createWorker } from 'tesseract.js';

// Base-aware self-hosted asset roots. In production dist/ is copied to
// dist/tools/pdf-processor/, so assets live UNDER the base, not at site root.
const BASE = (import.meta.env && import.meta.env.BASE_URL) || '/';
const WORKER_PATH = `${BASE}tesseract/worker.min.js`;
const CORE_PATH   = `${BASE}tesseract/`;            // dir holding tesseract-core-*-lstm.{js,wasm}
const LANG_PATH   = `${BASE}tessdata`;              // holds eng.traineddata (uncompressed)

let _worker = null;
let _initPromise = null;

/**
 * Lazily create + initialize the Tesseract worker (loads core WASM + eng model).
 * Idempotent: concurrent callers share one init.
 * @param {(m:any)=>void} [onProgress]
 */
export function ensureTesseract(onProgress) {
    if (_worker) return Promise.resolve(_worker);
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        const worker = await createWorker('eng', 1 /* OEM.LSTM_ONLY */, {
            workerPath: WORKER_PATH,
            corePath: CORE_PATH,
            langPath: LANG_PATH,
            gzip: false, // we ship uncompressed eng.traineddata
            logger: (m) => { if (onProgress) onProgress(m); },
            // Cache the compiled worker/lang in IndexedDB across runs.
            cacheMethod: 'write',
        });
        _worker = worker;
        return worker;
    })();
    return _initPromise;
}

/**
 * OCR a full page image. Returns words with page-pixel bboxes + confidence.
 * @param {ImageBitmap|OffscreenCanvas|HTMLCanvasElement} image
 * @returns {Promise<{ words: Array<{text,bbox:{x0,y0,x1,y1},confidence}>, text: string }>}
 */
export async function recognizePage(image) {
    const worker = await ensureTesseract();
    const { data } = await worker.recognize(image, {}, { blocks: true, text: true });

    // Flatten to a word list with {text, bbox, confidence}. tesseract.js v7
    // exposes words under data.blocks[].paragraphs[].lines[].words[].
    const words = [];
    const blocks = data.blocks || [];
    for (const block of blocks) {
        for (const para of (block.paragraphs || [])) {
            for (const line of (para.lines || [])) {
                for (const w of (line.words || [])) {
                    const t = (w.text || '').trim();
                    if (!t) continue;
                    words.push({
                        text: t,
                        bbox: w.bbox,               // { x0, y0, x1, y1 } in image pixels (top-left origin)
                        confidence: w.confidence,   // 0..100
                    });
                }
            }
        }
    }
    return { words, text: data.text || '' };
}

export async function disposeTesseract() {
    if (_worker) {
        try { await _worker.terminate(); } catch { /* ignore */ }
        _worker = null;
        _initPromise = null;
    }
}
