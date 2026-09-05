// engines/ppocr.js
//
// PP-OCRv5 (mobile) through ONNX Runtime Web. Detection -> optional angle
// classification -> CTC recognition, all client-side.
//
// WHY THIS SHAPE
//   * WASM-only, single-threaded. Not a preference — layoutWorker.js already
//     pins ort.env.wasm.numThreads = 1 because COOP/COEP breaks the Monaco
//     workers and cross-origin fonts, and the JSEP/WebGPU build is excluded
//     because its .wasm exceeds Cloudflare Pages' 25 MiB per-file limit. This
//     engine inherits both decisions rather than reopening them.
//   * Mobile model variants only, for the same 25 MiB reason.
//   * Classifier, not generator. PP-OCR's recognition head is CTC — it cannot
//     hallucinate a word the way an autoregressive VLM decoder can. That is
//     the property tesseractOcr.js was chosen for and this preserves it.
//
// WORD BOXES ARE ESTIMATED, AND SAY SO
//   PP-OCR detects TEXT LINES and recognises each as one string. Tesseract
//   returns real per-word boxes. Downstream (fileUpload.js) feeds synthetic
//   PDF.js text items at these positions, so the difference is not cosmetic.
//   We split a line on whitespace and apportion its width by character count,
//   which is an ESTIMATE, and every word carries `approx: true` so nothing
//   downstream can mistake an apportioned box for a measured one. The exact
//   line boxes are returned alongside, untouched.

import * as ort from 'onnxruntime-web/wasm';
import { measureS, inkCoverage, capForCoverage, capForEvidence } from '../ocrScale.js';

const BASE = (import.meta.env && import.meta.env.BASE_URL) || '/';
const MODEL_DIR = `${BASE}models/ppocr/`;
const ORT_WASM_PATH = `${BASE}ort-wasm/`;
const CACHE_NAME = 'darla-models-v1';   // shared with layoutWorker

const DET_URL = `${MODEL_DIR}det.onnx`;
const REC_URL = `${MODEL_DIR}rec.onnx`;
const CLS_URL = `${MODEL_DIR}cls.onnx`;       // optional
const DICT_URL = `${MODEL_DIR}charset.txt`;

// Detection input is padded to a multiple of 32; the long side is capped so a
// 300-DPI A4 scan does not turn into a 3500px map on a single WASM thread.
const DET_STRIDE = 32;
const DET_MAX_SIDE = 960;
// Overridable: on a large surface the fixed 960 cap is the binding constraint.
// A 3429x5447 scan downsamples 5.7x before detection, which puts body text
// under the detector's resolvable stroke width — it is not a recognition
// failure, the boxes are never proposed at all.
let _detMaxSide = DET_MAX_SIDE;
export function setDetMaxSide(n) { _detMaxSide = Math.max(320, Math.round(n)); }
export function getDetMaxSide() { return _detMaxSide; }
const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];

// Recognition: fixed height, width follows the crop's aspect ratio.
// 48 is not a tuning choice — the rec graph declares input [N,3,48,W], so any
// other height fails the session outright.
const REC_HEIGHT = 48;
// Width is 48 * (w/h), capped by RATIO not by pixels. An earlier version
// clamped width to 320px, which squashed a long body-text line ~6x
// horizontally and turned it into mush while short table cells still read
// perfectly — the giveaway was numeric cells scoring well next to garbage
// prose. Upstream never clamps width; it groups crops of similar aspect ratio
// into a batch and pads to that batch's widest.
const REC_MAX_RATIO = 40;          // 40 * 48 = 1920px, the widest single line
const REC_BATCH = 8;
// PP-OCR's own cls_thresh. Below this the 180-degree call is not trusted.
const CLS_THRESH = 0.9;

let _det = null;
let _rec = null;
let _cls = null;
let _charset = null;
let _initPromise = null;
/** Populated on failure so the facade can report a reason, not just a boolean. */
let _unavailableReason = null;

export const name = 'ppocr-v5-mobile';
/** Word bboxes are apportioned from line boxes, not measured. */
// Measured from line-crop ink where possible; interpolated only where the
// measurement is refused (see measureWordBoxes). Per-word `approx` is
// authoritative for any single box.
export const wordBoxes = 'measured';

export function getUnavailableReason() {
    return _unavailableReason;
}

// ── Init ────────────────────────────────────────────────────────────────────

export function ensure(onProgress) {
    if (_det && _rec) return Promise.resolve(true);
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        ort.env.wasm.wasmPaths = {
            mjs: `${ORT_WASM_PATH}ort-wasm-simd-threaded.mjs`,
            wasm: `${ORT_WASM_PATH}ort-wasm-simd-threaded.wasm`,
        };
        ort.env.wasm.numThreads = 1;

        try {
            report(onProgress, 'Loading text detector…');
            const detBuf = await loadAsset(DET_URL);
            _det = await ort.InferenceSession.create(detBuf, { executionProviders: ['wasm'] });

            report(onProgress, 'Loading text recogniser…');
            const recBuf = await loadAsset(REC_URL);
            _rec = await ort.InferenceSession.create(recBuf, { executionProviders: ['wasm'] });

            report(onProgress, 'Loading character set…');
            _charset = await loadCharset();

            // The angle classifier is genuinely optional — without it, upside-down
            // lines come back as garbage, but everything else still works. A
            // missing optional model must not read as a broken engine.
            try {
                const clsBuf = await loadAsset(CLS_URL);
                _cls = await ort.InferenceSession.create(clsBuf, { executionProviders: ['wasm'] });
            } catch {
                _cls = null;
            }

            _unavailableReason = null;
            return true;
        } catch (err) {
            _unavailableReason =
                `PP-OCR models could not be loaded from ${MODEL_DIR} (${err.message}). ` +
                `Run \`node scripts/fetch-ppocr-models.mjs\` from the portfolio root.`;
            _det = _rec = _cls = _charset = null;
            _initPromise = null;
            throw new Error(_unavailableReason);
        }
    })();

    return _initPromise;
}

function report(onProgress, status) {
    if (onProgress) { try { onProgress({ status }); } catch { /* listener's problem */ } }
}

async function loadAsset(url) {
    try {
        const cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(url);
        if (hit) return new Uint8Array(await hit.arrayBuffer());
    } catch { /* Cache API unavailable — fall through to network */ }

    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(url, new Response(buf));
    } catch { /* best effort */ }
    return buf;
}

/**
 * PP-OCR's dict file is one character per line. The model's class 0 is the CTC
 * blank and the final class is a space, neither of which appear in the file —
 * matching upstream's `character = ['blank'] + dict + [' ']`.
 */
async function loadCharset() {
    const res = await fetch(DICT_URL);
    if (!res.ok) throw new Error(`${DICT_URL} -> HTTP ${res.status}`);
    const text = await res.text();
    const chars = text.split('\n').map((l) => l.replace(/\r$/, ''));
    if (chars.length && chars[chars.length - 1] === '') chars.pop();
    return [' ', ...chars, ' '];
}

export async function dispose() {
    for (const s of [_det, _rec, _cls]) {
        try { await s?.release(); } catch { /* ignore */ }
    }
    _det = _rec = _cls = _charset = null;
    _initPromise = null;
}

// ── Public: recognise a page ────────────────────────────────────────────────

/**
 * @param {ImageBitmap|OffscreenCanvas|HTMLCanvasElement} image
 * @returns {Promise<{words:Array, lines:Array, text:string}>}
 */
export async function recognizePage(image) {
    await ensure();

    const src = toCanvas(image);
    const boxes = await detect(src);

    orderForReading(boxes, src.width);

    const crops = boxes.map((b) => cropRect(src, b.rect));
    const recognised = await recognizeCrops(crops);

    const lines = [];
    const words = [];
    for (let i = 0; i < boxes.length; i++) {
        const r = recognised[i];
        if (!r || !r.text.trim()) continue;
        const corners = boxes[i].quad;
        let bbox = quadToAABB(corners);
        // Undo DB's unclip margin so the box describes glyphs, not the polygon
        // that safely encloses them. See inkExtent().
        const ext = inkExtent(crops[i]);
        if (ext && Math.abs(boxes[i].rect.angle) <= 0.05) {
            const h = bbox.y1 - bbox.y0;
            bbox = { ...bbox, y0: bbox.y0 + ext.t * h, y1: bbox.y0 + ext.b * h };
        }
        lines.push({
            text: r.text,
            bbox,
            quad: corners,
            confidence: r.confidence * 100,   // match tesseract.js's 0..100 scale
            detScore: boxes[i].score,
        });
        const measured = measureWordBoxes(crops[i], r.text, bbox, boxes[i].rect.angle);
        if (measured) {
            for (const m of measured) words.push({ ...m, confidence: r.confidence * 100 });
        } else {
            words.push(...splitLineIntoWords(r.text, bbox, r.confidence * 100));
        }
    }

    return { words, lines, text: lines.map((l) => l.text).join('\n') };
}

/**
 * Put detected boxes into reading order, column-aware.
 *
 * A plain top-to-bottom sort interleaves the columns of a two-column page (or a
 * two-page spread, which this tool sees often): line 1 of the left column, then
 * line 1 of the right, and the prose reads as alternating fragments. Tesseract
 * has the opposite failure on the same input — it MERGES the columns into one
 * line — so neither default is safe and the split has to be found explicitly.
 *
 * The split is found from the data, not assumed: project every box onto x, look
 * for a vertical band wide enough to be a gutter that no box crosses, and only
 * treat the page as multi-column when one exists. A single-column page finds no
 * gutter and falls through to the plain top-to-bottom sort.
 */
function orderForReading(boxes, pageWidth) {
    const byY = (a, b) => {
        const dy = a.rect.cy - b.rect.cy;
        const band = Math.max(a.rect.h, b.rect.h) * 0.5;
        if (Math.abs(dy) > band) return dy;
        return a.rect.cx - b.rect.cx;
    };

    if (boxes.length < 6) { boxes.sort(byY); return; }

    // Occupancy histogram over x, at 1% of page width per bin.
    const BINS = 100;
    const occupied = new Uint8Array(BINS);
    for (const b of boxes) {
        const corners = b.quad;
        const x0 = Math.min(...corners.map((p) => p.x));
        const x1 = Math.max(...corners.map((p) => p.x));
        const i0 = Math.max(0, Math.floor((x0 / pageWidth) * BINS));
        const i1 = Math.min(BINS - 1, Math.ceil((x1 / pageWidth) * BINS));
        for (let i = i0; i <= i1; i++) occupied[i] = 1;
    }

    // A gutter must be a run of empty bins away from the page edges, and wide
    // enough that it cannot be ordinary word spacing.
    const MIN_GUTTER_BINS = 3;
    const EDGE = 15;
    const gutters = [];
    let run = 0;
    for (let i = 0; i <= BINS; i++) {
        if (i < BINS && !occupied[i]) { run++; continue; }
        if (run >= MIN_GUTTER_BINS) {
            const start = i - run;
            const mid = start + run / 2;
            if (start > EDGE && i < BINS - EDGE) gutters.push((mid / BINS) * pageWidth);
        }
        run = 0;
    }

    if (!gutters.length) { boxes.sort(byY); return; }

    const columnOf = (b) => {
        const cx = b.rect.cx;
        let c = 0;
        for (const g of gutters) if (cx > g) c++;
        return c;
    };

    boxes.sort((a, b) => {
        const ca = columnOf(a);
        const cb = columnOf(b);
        if (ca !== cb) return ca - cb;
        return byY(a, b);
    });
}

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Forensic evidence about the CURRENT page, when a layout model with a forensic
 * head has run on it.
 *
 * Set by the caller (`ocr/index.js` / the bench) before `recognizePage`, and
 * CLEARED after every detect so it cannot leak from one page to the next — a
 * stale blur reading applied to the following page is worse than none, because
 * it is wrong in a way nothing downstream can see.
 *
 * `null` means UNKNOWN, not clean. `capForEvidence` treats it that way and falls
 * back to the coverage-only path.
 */
let _forensic = null;

/**
 * @param {object|null} physical  physical values from
 *        extraction/forensics/signals.js `readSignals()`, or null to clear.
 */
export function setPageForensics(physical) { _forensic = physical || null; }

/**
 * Detect, adapting the input cap to the page's own body-text size.
 *
 * A probe pass runs at the current cap, `ocrScale` measures S from it, and the
 * pass is repeated only when S came back under target. An ordinary page
 * measures at target and pays for the probe alone; a starved page pays for one
 * extra detection (~0.2-0.3s) against a ~10s recognition stage.
 *
 * WHAT THE FORENSIC HEAD ADDS
 * ---------------------------
 * Ink coverage answers "is there ink the detector did not claim". It cannot
 * answer "would more resolution help", and those are different questions with
 * different right answers:
 *
 *   starved + page physically sound  -> raise the cap. This is the case the
 *                                       adaptive path was written for.
 *   starved + page blurred/warped/skewed past recovery -> raising the cap buys
 *                                       nothing. Detection is quadratic in side
 *                                       length, so the pipeline would pay 4x on
 *                                       the pages that are already slowest, for
 *                                       the same starved result.
 *
 * The signals can only DECLINE the second pass, never request one. A wrong
 * forensic reading therefore costs a missed upscale — recoverable, and visible
 * in `coverage` — but can never cost a 4x slowdown on every page.
 */
async function detect(canvas) {
    const probe = await detectAt(canvas, _detMaxSide);
    const { coverage } = inkCoverage(canvas, probe.boxes);
    const S = measureS(probe.boxes, probe.ratio);
    const decision = capForEvidence(_detMaxSide, coverage, S, _forensic);
    const { cap, starved, blocked, reason, evidence } = decision;
    _lastScale = {
        S: S == null ? null : +S.toFixed(2), cap, starved,
        coverage: +coverage.toFixed(3),
        // Which instrument decided, and why. Without this a page that was
        // starved and deliberately not upscaled is indistinguishable in the
        // record from a page that was never starved.
        blocked: !!blocked, reason: reason || null, evidence: evidence || null,
        forensicHead: !!_forensic,
    };
    // The reading belongs to the page that has just been measured. Clearing it
    // here means a caller that forgets to set it for the next page gets the
    // coverage-only path rather than the previous page's condition.
    _forensic = null;
    if (!starved || blocked) return probe.boxes;
    const second = await detectAt(canvas, cap);
    _lastScale.coverage2 = +inkCoverage(canvas, second.boxes).coverage.toFixed(3);
    return second.boxes;
}

/** Last adaptive-scale decision, for the bench and the lineage record. */
let _lastScale = { S: null, cap: DET_MAX_SIDE, starved: false,
                   blocked: false, forensicHead: false };
export function getScaleReport() { return _lastScale; }

async function detectAt(canvas, cap) {
    const { data, w, h, scaleX, scaleY, ratio } = prepareDetInput(canvas, cap);
    const tensor = new ort.Tensor('float32', data, [1, 3, h, w]);
    const feeds = { [_det.inputNames[0]]: tensor };
    const out = await _det.run(feeds);
    const probTensor = out[_det.outputNames[0]];

    // [1,1,H,W] -> the map itself.
    const prob = probTensor.data;
    const dims = probTensor.dims;
    const mapH = dims[dims.length - 2];
    const mapW = dims[dims.length - 1];

    const { dbPostprocess } = await import('../db-postprocess.js');
    return { boxes: dbPostprocess(prob, mapW, mapH, { scaleX, scaleY }), ratio };
}

/**
 * Resize preserving aspect ratio (the post-processor rejects a non-uniform
 * scale, because it would shear a rotated box), then pad to a multiple of 32.
 */
function prepareDetInput(canvas, cap = _detMaxSide) {
    const sw = canvas.width;
    const sh = canvas.height;
    const ratio = Math.min(1, cap / Math.max(sw, sh));
    const rw = Math.max(DET_STRIDE, Math.round(sw * ratio));
    const rh = Math.max(DET_STRIDE, Math.round(sh * ratio));
    const w = Math.ceil(rw / DET_STRIDE) * DET_STRIDE;
    const h = Math.ceil(rh / DET_STRIDE) * DET_STRIDE;

    const tmp = makeCanvas(w, h);
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    // Pad with white, not black: a black margin reads as a strong edge to the
    // detector and grows spurious boxes along the page border.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0, sw, sh, 0, 0, rw, rh);

    const img = ctx.getImageData(0, 0, w, h).data;
    const data = new Float32Array(3 * w * h);
    const plane = w * h;
    for (let i = 0, p = 0; i < img.length; i += 4, p++) {
        data[p] = (img[i] / 255 - DET_MEAN[0]) / DET_STD[0];
        data[plane + p] = (img[i + 1] / 255 - DET_MEAN[1]) / DET_STD[1];
        data[2 * plane + p] = (img[i + 2] / 255 - DET_MEAN[2]) / DET_STD[2];
    }

    // The map is produced at the PADDED size but the content only occupies
    // rw x rh, so boxes map back through the CONTENT ratio, not the padded one.
    const scale = 1 / ratio;
    return { data, w, h, scaleX: scale, scaleY: scale, ratio };
}

// ── Recognition ─────────────────────────────────────────────────────────────

async function recognizeCrops(crops) {
    // Sort by aspect ratio before batching so a batch is padded to a width its
    // members actually need. Mixing a 3:1 cell with a 40:1 paragraph line in one
    // batch pads the cell to 13x its width, which costs time and adds a wide
    // blank margin the recogniser has to ignore.
    const order = crops
        .map((c, i) => ({ i, ratio: c.width / Math.max(1, c.height) }))
        .sort((a, b) => a.ratio - b.ratio);

    const out = new Array(crops.length);
    for (let i = 0; i < order.length; i += REC_BATCH) {
        const slice = order.slice(i, i + REC_BATCH);
        const batch = slice.map((s) => crops[s.i]);
        if (_cls) await applyAngleClassifier(batch);
        const res = await runRecBatch(batch);
        // Un-sort: results must line up with the caller's box order.
        slice.forEach((s, k) => { out[s.i] = res[k]; });
    }
    return out;
}

async function runRecBatch(crops) {
    // One width for the batch, from the widest member's aspect ratio.
    const ratios = crops.map((c) => Math.min(REC_MAX_RATIO, Math.max(1, c.width / Math.max(1, c.height))));
    const maxRatio = Math.max(...ratios);
    const W = Math.max(16, Math.ceil((REC_HEIGHT * maxRatio) / 8) * 8);

    const n = crops.length;
    const plane = REC_HEIGHT * W;
    // Zero-filled: the padding to the right of a narrower crop stays 0 AFTER
    // normalisation, which is what upstream feeds. Padding with white would
    // hand the recogniser a bright bar where it expects neutral.
    const data = new Float32Array(n * 3 * plane);

    for (let b = 0; b < n; b++) {
        const w = Math.max(1, Math.min(W, Math.round(REC_HEIGHT * ratios[b])));
        const tmp = makeCanvas(w, REC_HEIGHT);
        const ctx = tmp.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(crops[b], 0, 0, crops[b].width, crops[b].height, 0, 0, w, REC_HEIGHT);
        const img = ctx.getImageData(0, 0, w, REC_HEIGHT).data;
        const off = b * 3 * plane;
        for (let y = 0; y < REC_HEIGHT; y++) {
            for (let x = 0; x < w; x++) {
                const src = (y * w + x) * 4;
                const dst = y * W + x;
                // PP-OCR rec normalisation: (x/255 - 0.5) / 0.5
                data[off + dst] = (img[src] / 255 - 0.5) / 0.5;
                data[off + plane + dst] = (img[src + 1] / 255 - 0.5) / 0.5;
                data[off + 2 * plane + dst] = (img[src + 2] / 255 - 0.5) / 0.5;
            }
        }
    }

    const tensor = new ort.Tensor('float32', data, [n, 3, REC_HEIGHT, W]);
    const res = await _rec.run({ [_rec.inputNames[0]]: tensor });
    const logits = res[_rec.outputNames[0]];
    const bs = logits.dims[0];
    const steps = logits.dims[1];
    const classes = logits.dims[2];

    const out = [];
    for (let b = 0; b < bs; b++) {
        out.push(ctcGreedyDecode(logits.data, b, steps, classes, _charset));
    }
    return out;
}

/**
 * CTC greedy decode: argmax per timestep, collapse runs, drop blank (class 0).
 *
 * The rec graph's output is ALREADY softmaxed (verified: rows sum to 1.0), so
 * the max value is a probability and `confidence * 100` is a real percentage on
 * the same 0..100 scale tesseract.js reports. If a future export emits raw
 * logits instead, this silently starts reporting nonsense — check the row sum.
 * Confidence is the mean of the max probabilities over the timesteps that
 * actually emitted a character — averaging in the blanks would report a
 * confident-looking number for a mostly-empty crop.
 */
export function ctcGreedyDecode(data, batchIndex, steps, classes, charset) {
    let text = '';
    let sum = 0;
    let count = 0;
    let prev = -1;

    for (let t = 0; t < steps; t++) {
        const off = (batchIndex * steps + t) * classes;
        let best = 0;
        let bestVal = -Infinity;
        for (let c = 0; c < classes; c++) {
            const v = data[off + c];
            if (v > bestVal) { bestVal = v; best = c; }
        }
        if (best !== 0 && best !== prev) {
            text += charset[best] ?? '';
            sum += bestVal;
            count++;
        }
        prev = best;
    }

    return { text, confidence: count ? sum / count : 0 };
}

async function applyAngleClassifier(crops) {
    // 180-degree classifier: two classes, flip in place when class 1 wins.
    const n = crops.length;
    const H = 48, W = 192;
    const plane = H * W;
    const data = new Float32Array(n * 3 * plane);
    for (let b = 0; b < n; b++) {
        const tmp = makeCanvas(W, H);
        const ctx = tmp.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(crops[b], 0, 0, crops[b].width, crops[b].height, 0, 0, W, H);
        const img = ctx.getImageData(0, 0, W, H).data;
        const off = b * 3 * plane;
        for (let i = 0, p = 0; i < img.length; i += 4, p++) {
            data[off + p] = (img[i] / 255 - 0.5) / 0.5;
            data[off + plane + p] = (img[i + 1] / 255 - 0.5) / 0.5;
            data[off + 2 * plane + p] = (img[i + 2] / 255 - 0.5) / 0.5;
        }
    }
    const res = await _cls.run({ [_cls.inputNames[0]]: new ort.Tensor('float32', data, [n, 3, H, W]) });
    const probs = res[_cls.outputNames[0]];
    const bs = probs.dims[0];
    const nc = probs.dims[1];
    for (let b = 0; b < bs; b++) {
        if (nc < 2) continue;
        const p0 = probs.data[b * nc];
        const p1 = probs.data[b * nc + 1];
        // Upstream gates this on cls_thresh (0.9), not on argmax. A bare
        // argmax flips on 0.51, and a SHORT crop — a table cell like "MP3" or
        // "-2.96" — carries almost no orientation evidence, so it coin-flips.
        // That showed up as reversed cells ("967-" for "-2.96") in exactly the
        // narrow cells of a reconstructed table, while long prose lines, which
        // have plenty of evidence, were never affected.
        // Normalised so the threshold means the same thing whether or not the
        // graph already applied softmax.
        const sum = p0 + p1;
        if (sum > 0 && p1 / sum > CLS_THRESH) crops[b] = rotate180(crops[b]);
    }
}

// ── Geometry / canvas helpers ───────────────────────────────────────────────

function makeCanvas(w, h) {
    return typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
}

function toCanvas(image) {
    if (image && typeof image.getContext === 'function') return image;
    const c = makeCanvas(image.width, image.height);
    c.getContext('2d').drawImage(image, 0, 0);
    return c;
}

/**
 * Crop a rotated rect to an upright strip. A rotated RECTANGLE needs only an
 * affine transform, so canvas 2D is sufficient — no perspective warp and no
 * opencv.js.
 */
function cropRect(src, rect) {
    const w = Math.max(1, Math.round(rect.w));
    const h = Math.max(1, Math.round(rect.h));
    const out = makeCanvas(w, h);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-rect.angle);
    ctx.translate(-rect.cx, -rect.cy);
    ctx.drawImage(src, 0, 0);
    return out;
}

function rotate180(canvas) {
    const out = makeCanvas(canvas.width, canvas.height);
    const ctx = out.getContext('2d');
    ctx.translate(canvas.width, canvas.height);
    ctx.rotate(Math.PI);
    ctx.drawImage(canvas, 0, 0);
    return out;
}

function quadToAABB(quad) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of quad) {
        if (p.x < x0) x0 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.x > x1) x1 = p.x;
        if (p.y > y1) y1 = p.y;
    }
    return { x0, y0, x1, y1 };
}

/**
 * True ink extent of a line crop, as a fraction of the crop height.
 *
 * DB post-processing UNCLIPS every detected box — `unclipRect` grows w and h by
 * 2d so the polygon encloses the glyphs with margin. That margin is correct for
 * cropping and wrong as typography: fed to rasterSynth it produced a median
 * synthetic font size of 22.35pt on a page whose body text is ~9-10pt. Since
 * PageScale derives S (the natural unit) from those sizes, every dimensionless
 * threshold downstream inflated with it — column tolerance grew until it
 * absorbed the gaps between table columns, and assemblePage reconstructed no
 * tables at all on a document where Tesseract found 28.
 *
 * Measuring the ink back out costs one row-projection over a crop that is
 * already in hand.
 *
 * @returns {{t:number, b:number}|null} top/bottom as fractions of crop height
 */
function inkExtent(crop) {
    const w = crop.width, h = crop.height;
    if (w < 4 || h < 4) return null;
    const d = crop.getContext('2d', { willReadFrequently: true })
                  .getImageData(0, 0, w, h).data;
    let top = -1, bot = -1;
    for (let y = 0; y < h; y++) {
        let ink = 0;
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 160) { ink++; if (ink > 1) break; }
        }
        if (ink > 1) { if (top < 0) top = y; bot = y; }
    }
    if (top < 0 || bot <= top) return null;
    return { t: top / h, b: (bot + 1) / h };
}

/**
 * Measure word boxes from the line crop's ink, instead of apportioning the
 * line width by character count.
 *
 * `splitLineIntoWords` spreads words evenly across the line, which is fine for
 * display and wrong as geometry: in a table, evenly-spread words do not land on
 * the column x-positions they actually occupy, so the downstream column-anchor
 * clustering in assemblePage finds no columns and reconstructs no table. On
 * Exploring-Chemistry that was the difference between 28 tables and zero.
 *
 * The line crop is already upright (cropRect rotated it), so inter-word gaps
 * are runs of ink-free columns. Take the (wordCount - 1) widest internal gaps
 * and cut there.
 *
 * Returns null — caller falls back to interpolation — when the measurement
 * cannot be trusted: a rotated line, a single word, or fewer clean gaps than
 * the text needs. Guessing a cut position would be worse than an honest
 * approximation, because downstream treats these boxes as ground truth.
 *
 * @returns {Array|null} words with measured boxes in PAGE coords
 */
function measureWordBoxes(crop, text, bbox, angle) {
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return null;
    if (Math.abs(angle) > 0.05) return null;          // rotated: x is not separable

    const w = crop.width, h = crop.height;
    if (w < 8 || h < 4) return null;
    const data = crop.getContext('2d', { willReadFrequently: true })
                     .getImageData(0, 0, w, h).data;

    // Ink count per column. cropRect white-fills, so padding reads as blank.
    const col = new Uint16Array(w);
    for (let x = 0; x < w; x++) {
        let n = 0;
        for (let y = 0; y < h; y++) {
            const i = (y * w + x) * 4;
            if (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 < 160) n++;
        }
        col[x] = n;
    }

    // Internal runs of blank columns. Leading/trailing blanks are margin, not
    // word separators, so they are excluded by requiring ink on both sides.
    const gaps = [];
    let run = 0, seenInk = false;
    for (let x = 0; x < w; x++) {
        if (col[x] === 0) { if (seenInk) run++; continue; }
        if (run > 0) gaps.push({ start: x - run, len: run });
        run = 0; seenInk = true;
    }
    if (gaps.length < parts.length - 1) return null;

    const cuts = gaps
        .slice().sort((a, b) => b.len - a.len)
        .slice(0, parts.length - 1)
        .map((g) => g.start + g.len / 2)
        .sort((a, b) => a - b);

    const sx = (bbox.x1 - bbox.x0) / w;
    const out = [];
    let left = 0;
    for (let i = 0; i < parts.length; i++) {
        const right = i < cuts.length ? cuts[i] : w;
        out.push({
            text: parts[i],
            bbox: { x0: bbox.x0 + left * sx, y0: bbox.y0,
                    x1: bbox.x0 + right * sx, y1: bbox.y1 },
            approx: false,
        });
        left = right;
    }
    return out;
}

/**
 * Apportion a line's width across its words by character count.
 *
 * This is the one genuinely lossy step versus Tesseract, so every word it
 * produces is stamped `approx: true`. Downstream can then decide whether an
 * estimated position is good enough for what it is doing rather than
 * discovering the difference from a misaligned overlay.
 */
export function splitLineIntoWords(text, bbox, confidence) {
    const parts = text.split(/(\s+)/).filter((s) => s.length);
    const totalChars = parts.reduce((n, p) => n + p.length, 0);
    if (!totalChars) return [];

    const width = bbox.x1 - bbox.x0;
    const words = [];
    let charsSoFar = 0;

    for (const part of parts) {
        if (!/\S/.test(part)) { charsSoFar += part.length; continue; }
        const x0 = bbox.x0 + (charsSoFar / totalChars) * width;
        const x1 = bbox.x0 + ((charsSoFar + part.length) / totalChars) * width;
        words.push({
            text: part,
            bbox: { x0, y0: bbox.y0, x1, y1: bbox.y1 },
            confidence,
            approx: true,
        });
        charsSoFar += part.length;
    }
    return words;
}
