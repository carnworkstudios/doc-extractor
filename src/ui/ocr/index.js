// ocr/index.js — the OCR facade.
//
// One entry point, several engines. Callers ask for text; they do not pick an
// engine, and they cannot end up on a different one without being told.
//
// ── WHY A FACADE ────────────────────────────────────────────────────────────
// The previous shape hard-wired tesseract.js into fileUpload.js. Swapping it
// meant editing the call sites, and comparing two engines on real documents was
// not possible at all. Worse, the backend's ocr_extract skill has the failure
// this exists to prevent: `paddle if available else tesseract if available` —
// an engine downgrade that reaches the caller as nothing but slightly worse
// text, at a confidence number that still looks fine.
//
// ── THE RULE THIS ENFORCES ──────────────────────────────────────────────────
// Which engine ran is a FINDING, not a field. `getOcrReport()` returns the
// engine, whether its word boxes are measured or estimated, and — when an
// engine could not start — the reason. The three states are the ones the Ginex
// rail already insists on: ran-and-found, ran-and-found-nothing, could-not-run.
// "Unavailable" must never render as "clean".
//
// ── ENGINE INTERFACE ────────────────────────────────────────────────────────
//   name: string
//   wordBoxes: 'exact' | 'estimated'
//   ensure(onProgress?): Promise<*>
//   recognizePage(image): Promise<{ words, lines, text }>
//   dispose(): Promise<void>
//   getUnavailableReason(): string | null
//
// A word is { text, bbox:{x0,y0,x1,y1}, confidence: 0..100, approx: boolean }.
// `approx` is per-word and authoritative; `wordBoxes` is the engine-level
// summary of the same fact.

import * as tesseractEngine from './engines/tesseract.js';
import * as ppocrEngine from './engines/ppocr.js';

const ENGINES = {
    [tesseractEngine.name]: tesseractEngine,
    [ppocrEngine.name]: ppocrEngine,
};

/**
 * PP-OCRv5 is the measured default for scanned pages. On the corpus it reads
 * all 24 values in Exploring Chemistry's energy table (Tesseract reads 3),
 * scores higher on every tested surface, and its corrected ink-measured word
 * boxes preserve the column anchors needed by table reconstruction.
 *
 * Tesseract remains an explicit fallback when the PP-OCR models cannot start.
 * Override for diagnosis with `?ocr=tesseract-lstm` or the `gx.ocrEngine`
 * localStorage key; the facade reports a fallback instead of hiding it.
 */
const DEFAULT_ENGINE = ppocrEngine.name;
const FALLBACK_ORDER = [ppocrEngine.name, tesseractEngine.name];

/** URL param wins over localStorage wins over the default. */
function _initialEngine() {
    try {
        const q = new URLSearchParams(location.search).get('ocr');
        if (q) return q;
        const ls = localStorage.getItem('gx.ocrEngine');
        if (ls) return ls;
    } catch { /* no DOM / storage blocked */ }
    return DEFAULT_ENGINE;
}

let _preferred = _initialEngine();
let _active = null;
/** @type {{engine:string, requested:string, degraded:boolean, reason:string|null, wordBoxes:string|null}} */
let _report = {
    engine: null,
    requested: DEFAULT_ENGINE,
    degraded: false,
    reason: null,
    wordBoxes: null,
};

export function listEngines() {
    return Object.keys(ENGINES);
}

/**
 * Choose the engine for subsequent calls. Disposes the current one if it
 * differs, so two model sets are never resident at once.
 */
export async function setPreferredEngine(engineName) {
    if (!ENGINES[engineName]) throw new Error(`Unknown OCR engine: ${engineName}`);
    if (engineName === _preferred) return;
    if (_active && _active.name !== engineName) await _active.dispose();
    _preferred = engineName;
    _active = null;
    _report = { engine: null, requested: engineName, degraded: false, reason: null, wordBoxes: null };
}

/**
 * What actually happened. Callers render this; they must not infer engine
 * health from the presence or absence of words.
 */
export function getOcrReport() {
    return { ..._report };
}

/**
 * Start the preferred engine, falling back only if it cannot start — and
 * recording that it fell back. Idempotent; concurrent callers share one init.
 */
export async function ensureOcr(onProgress) {
    if (_active) return _active;

    const order = [_preferred, ...FALLBACK_ORDER.filter((n) => n !== _preferred)];
    const failures = [];

    for (const engineName of order) {
        const engine = ENGINES[engineName];
        try {
            await engine.ensure(onProgress);
            _active = engine;
            _report = {
                engine: engine.name,
                requested: _preferred,
                degraded: engine.name !== _preferred,
                // A degraded run states WHY the preferred engine was skipped —
                // that reason is the whole point of noticing.
                reason: engine.name === _preferred ? null : failures.join('; '),
                wordBoxes: engine.wordBoxes,
            };
            return engine;
        } catch (err) {
            failures.push(`${engineName}: ${engine.getUnavailableReason?.() || err.message}`);
        }
    }

    _report = {
        engine: null,
        requested: _preferred,
        degraded: true,
        reason: failures.join('; ') || 'no OCR engine could start',
        wordBoxes: null,
    };
    throw new Error(`No OCR engine available. ${_report.reason}`);
}

/**
 * OCR a full page image.
 *
 * @param {ImageBitmap|OffscreenCanvas|HTMLCanvasElement} image
 * @returns {Promise<{ words: Array, lines: Array, text: string, report: object }>}
 */
export async function recognizePage(image) {
    const engine = await ensureOcr();
    const result = await engine.recognizePage(image);
    return { ...result, report: getOcrReport() };
}

export async function disposeOcr() {
    if (_active) {
        await _active.dispose();
        _active = null;
    }
    _report = { engine: null, requested: _preferred, degraded: false, reason: null, wordBoxes: null };
}

// ── Back-compat aliases ─────────────────────────────────────────────────────
// fileUpload.js imported ensureTesseract/disposeTesseract by name. Keeping the
// aliases means the engine swap is not entangled with a call-site rename, and
// the diff that changes behaviour stays small enough to read.
export { ensureOcr as ensureTesseract, disposeOcr as disposeTesseract };
