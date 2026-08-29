// engines/tesseract.js
//
// tesseract.js v7 (LSTM), the incumbent engine. Moved from src/ui/tesseractOcr.js
// unchanged apart from conforming to the engine interface in ../index.js.
//
// Its strengths are real and worth keeping as a fallback: it does its own
// line/word segmentation and returns MEASURED per-word boxes and confidences,
// which the PP-OCR path can only estimate. Its weakness is that whole-page LSTM
// on a single WASM thread is slow, and accuracy degrades on anything that is
// not clean, high-DPI, upright, single-column text.
//
// LOCAL-FIRST: every asset (worker script, core WASM, traineddata) is
// self-hosted under the Vite base — NO CDN. The CSP blocks external hosts, and
// tesseract.js defaults to a CDN, so all three paths are set explicitly.

import { createWorker } from 'tesseract.js';

const BASE = (import.meta.env && import.meta.env.BASE_URL) || '/';
const WORKER_PATH = `${BASE}tesseract/worker.min.js`;
const CORE_PATH = `${BASE}tesseract/`;          // dir holding tesseract-core-*-lstm.{js,wasm}
const LANG_PATH = `${BASE}tessdata`;            // holds eng.traineddata (uncompressed)

let _worker = null;
let _initPromise = null;
let _unavailableReason = null;

export const name = 'tesseract-lstm';
/** Tesseract measures each word's box; nothing here is apportioned. */
export const wordBoxes = 'exact';

export function getUnavailableReason() {
    return _unavailableReason;
}

export function ensure(onProgress) {
    if (_worker) return Promise.resolve(_worker);
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        try {
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
            _unavailableReason = null;
            return worker;
        } catch (err) {
            _unavailableReason = `tesseract.js could not start: ${err.message}`;
            _initPromise = null;
            throw err;
        }
    })();
    return _initPromise;
}

/**
 * OCR a full page image.
 *
 * `lines` is derived from the same block tree rather than recomputed, so the
 * two engines return the same shape and the A/B harness compares like with
 * like.
 *
 * @param {ImageBitmap|OffscreenCanvas|HTMLCanvasElement} image
 * @returns {Promise<{ words: Array, lines: Array, text: string }>}
 */
export async function recognizePage(image) {
    const worker = await ensure();
    const { data } = await worker.recognize(image, {}, { blocks: true, text: true });

    // Flatten to a word list with {text, bbox, confidence}. tesseract.js v7
    // exposes words under data.blocks[].paragraphs[].lines[].words[].
    const words = [];
    const lines = [];
    const blocks = data.blocks || [];
    for (const block of blocks) {
        for (const para of (block.paragraphs || [])) {
            for (const line of (para.lines || [])) {
                const lineWords = [];
                for (const w of (line.words || [])) {
                    const t = (w.text || '').trim();
                    if (!t) continue;
                    const word = {
                        text: t,
                        bbox: w.bbox,               // { x0, y0, x1, y1 } image px, top-left origin
                        confidence: w.confidence,   // 0..100
                        approx: false,
                    };
                    lineWords.push(word);
                    words.push(word);
                }
                if (!lineWords.length) continue;
                lines.push({
                    text: lineWords.map((w) => w.text).join(' '),
                    bbox: line.bbox,
                    quad: null,                     // Tesseract lines are axis-aligned
                    confidence: line.confidence,
                    detScore: null,                 // no separate detector stage
                });
            }
        }
    }
    return { words, lines, text: data.text || '' };
}

export async function dispose() {
    if (_worker) {
        try { await _worker.terminate(); } catch { /* ignore */ }
        _worker = null;
        _initPromise = null;
    }
}
