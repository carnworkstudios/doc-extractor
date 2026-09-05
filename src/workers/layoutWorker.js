/**
 * layoutWorker.js
 *
 * Web Worker that runs YOLOv8 document layout detection via ONNX Runtime Web.
 *
 * Messages:
 *   "init"   → Load the ONNX model (from Cache API or network). Posts { type: 'ready' }.
 *   "detect" → Receive ImageBitmap, run inference, return bounding boxes.
 *              Posts { type: 'result', regions: [{label, confidence, bbox}] }.
 *   "dispose" → Release model resources.
 *
 * The model expects 640x640 RGB input in NCHW float32 format, normalized [0,1].
 * Output is raw YOLOv8 detections that require NMS post-processing.
 */

// Import the WASM-ONLY entry point, not the bare 'onnxruntime-web' (which
// resolves to the full build: WebGPU/JSEP + asyncify backends we never use).
// That pulled two dead .wasm variants into the bundle — a 24.2 MB jsep build
// sitting at 97% of Cloudflare Pages' 25 MiB per-file limit, plus a 21.8 MB
// asyncify build. Neither is ever loaded: wasmPaths is pinned below and the
// session runs executionProviders:['wasm'].
import * as ort from 'onnxruntime-web/wasm';
// The model registry. Which model this worker loads, what its classes are, how
// its input is normalised and whether it carries a forensic head are all read
// from a manifest rather than inferred from the session — see layoutModels.js
// for why sniffing output shapes is the wrong instrument here.
import { MODELS, DEFAULT_MODEL_ID, manifestFor, assertSessionMatches } from './layoutModels.js';
// Base-aware asset paths. In production the whole dist/ is copied to
// dist/tools/pdf-processor/ (build.sh), so /models and /ort-wasm live UNDER the
// Vite base ('/tools/pdf-processor/'), not at the site root. import.meta.env
// .BASE_URL resolves to that base in the build and '/' in dev.
const BASE = (import.meta.env && import.meta.env.BASE_URL) || '/';
const ORT_WASM_PATH = `${BASE}ort-wasm/`;
const CACHE_NAME = 'darla-models-v1';
const IOU_THRESHOLD = 0.45;

// ── Active model ───────────────────────────────────────────────────────────
// Set by the `init` message. DocForensics is the production default; YOLO is
// retained in the registry only for explicit A/B benchmark requests.
let manifest = manifestFor(DEFAULT_MODEL_ID);
let MODEL_SIZE = manifest.inputSize;
let CONF_THRESHOLD = manifest.defaultConfidence;
let CLASS_LABELS = manifest.classes;

// ImageNet normalisation, for models whose backbone was pretrained on it.
// Feeding [0,1] to such a backbone shifts every filter's input by a full
// standard deviation from what it was trained on, which does not crash and does
// not look wrong — it just quietly costs several points of mAP.
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

// The class list is NOT written here any more. It lives in the model manifest
// (layoutModels.js) and is read from it at init.
//
// The reason is the bug this file used to carry: the array that stood here was
// a different permutation of DocLayNet's classes and got 10 of 11 names wrong.
// It was not obviously broken because the GEOMETRY was always right — only the
// names were shuffled, so every paragraph came back as `page-footer` (real
// class 9, Text) and every table as `page-header` (real class 8, Table). That
// is why `TABLE_LABELS` in rasterSynth.js never fired on a scanned page.
//
// A hardcoded array cannot be checked against anything. A manifest can, and
// `assertSessionMatches()` does check it: a session whose detection output has
// the wrong channel count for the declared class list makes the worker refuse
// to run rather than relabel every region on the page.
//
// Names stay in this repo's existing vocabulary rather than the upstream
// model's, because rasterSynth.js keys off these strings.

let session = null;


self.onmessage = async (e) => {
    const { type, data, requestId } = e.data;

    try {
        switch (type) {
            case 'init': {
                // The requested id, which is NOT necessarily the one that ends
                // up serving. `ready` reports what actually loaded, because a
                // silent fallback to the incumbent would make an A/B comparison
                // compare the incumbent with itself — the same failure
                // ocr/index.js's engine report exists to prevent.
                const requested = (data && data.modelId) || DEFAULT_MODEL_ID;
                self.postMessage({ type: 'progress', status: `Loading layout model ${requested}…` });
                const loaded = await initModel(requested);
                self.postMessage({
                    type: 'ready',
                    model: loaded.id,
                    requested,
                    fellBack: loaded.id !== requested,
                    reason: loaded.reason || null,
                    classes: loaded.classes,
                    forensics: !!loaded.forensics,
                    confidence: CONF_THRESHOLD,
                });
                break;
            }

            case 'detect': {
                if (!session) throw new Error('Model not initialized. Send "init" first.');
                const out = await detect(
                    data.imageBitmap, data.letterbox === true, data.evidence);
                // `forensics` is undefined for a model with no Head B, and the
                // caller must treat undefined as "this model cannot tell you"
                // rather than as "the page is clean".
                self.postMessage({
                    type: 'result', regions: out.regions, forensics: out.forensics,
                    model: manifest.id, requestId,
                });
                break;
            }

            case 'dispose':
                if (session) {
                    session.release();
                    session = null;
                }
                self.postMessage({ type: 'disposed' });
                break;

            default:
                self.postMessage({ type: 'error', error: `Unknown message type: ${type}`, requestId });
        }
    } catch (err) {
        self.postMessage({ type: 'error', error: err.message, requestId });
    }
};

// ── MODEL LOADING ──────────────────────────────────────────────────────────

async function initModel(modelId) {

    // Explicit file mapping (NOT a directory) so ORT loads the plain
    // simd-threaded WASM build. If we only set a directory, ORT 1.19 defaults
    // to the JSEP (WebGPU) loader — whose .wasm is ~25 MB and exceeds
    // Cloudflare Pages' 25 MiB per-file limit. We ship WASM-only, so pin the
    // non-jsep files by name.
    ort.env.wasm.wasmPaths = {
        mjs:  `${ORT_WASM_PATH}ort-wasm-simd-threaded.mjs`,
        wasm: `${ORT_WASM_PATH}ort-wasm-simd-threaded.wasm`,
    };

    // Disable multi-threading to avoid SharedArrayBuffer / COOP/COEP issues
    // that break Monaco editor workers and cross-origin font loading.
    ort.env.wasm.numThreads = 1;

    // WASM-only; JSEP (WebGPU) files are excluded from the build to stay
    // under Cloudflare Pages' 25 MiB per-file limit.
    const providers = ['wasm'];

    // Load exactly the requested model. In particular, DocForensics must never
    // fall back to YOLO: this run is intended to expose its real strengths and
    // failures throughout the main extraction pipeline.
    const order = [modelId];
    let lastErr = null;
    for (const id of order) {
        const m = manifestFor(id);
        try {
            const buf = await loadModelFromCacheOrNetwork(`${BASE}${m.url}`);
            const sess = await ort.InferenceSession.create(buf, { executionProviders: providers });

            // Verify the session against the manifest BEFORE adopting it. A
            // model whose channel count disagrees with its declared class list
            // is a model whose labels are unknown, and running it produces
            // correct boxes with wrong names — the failure mode that is
            // hardest to notice and most expensive to have shipped.
            const probe = sess.outputMetadata || null;
            const detDims = probe && probe[0] && probe[0].dimensions;
            const detChannels = detDims && detDims.length === 3 ? detDims[1] : (4 + m.classes.length);
            assertSessionMatches(m, detChannels, sess.outputNames.length);

            session = sess;
            manifest = m;
            MODEL_SIZE = m.inputSize;
            CONF_THRESHOLD = m.defaultConfidence;
            CLASS_LABELS = m.classes;
            return { id, classes: [...m.classes], forensics: !!m.forensics,
                     reason: lastErr ? String(lastErr.message || lastErr) : null };
        } catch (err) {
            lastErr = err;
        }
    }
    throw new Error(`no layout model could be loaded: ${lastErr && lastErr.message}`);
}

async function loadModelFromCacheOrNetwork(MODEL_URL) {
    // Try Cache API first
    try {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(MODEL_URL);
        if (cached) {
            return new Uint8Array(await cached.arrayBuffer());
        }
    } catch {
        // Cache API not available or failed
    }

    // Fetch from network
    const response = await fetch(MODEL_URL);
    if (!response.ok) throw new Error(`Failed to fetch model: ${response.status}`);

    // Cache the response for next time
    try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(MODEL_URL, response.clone());
    } catch {
        // Caching failed; not critical
    }

    return new Uint8Array(await response.arrayBuffer());
}

// ── INFERENCE ──────────────────────────────────────────────────────────────

async function detect(imageBitmap, letterbox = false, evidence = null) {
    // Resize to 640x640 and extract pixel data.
    //
    // Two modes, because the original squashes:
    //
    //   legacy (default)  — stretch to fill 640x640. Non-uniform on any page
    //     that is not square, and a two-page spread (aspect 1.63) is distorted
    //     hard enough that DocLayNet stops recognising its own classes: an
    //     Exploring-Chemistry spread yielded ten `page-footer` regions and
    //     missed the table entirely.
    //   letterbox — preserve aspect, pad the remainder. This is what YOLOv8 is
    //     trained and evaluated with. Boxes are unpadded and unscaled below, so
    //     the caller receives SOURCE-image coordinates, not model coordinates.
    //
    // Legacy stays the default because `fileUpload.js` already scales the
    // 640-space boxes itself; flipping the contract underneath it would move
    // every region on the page.
    const srcW = imageBitmap.width, srcH = imageBitmap.height;
    const lbScale = Math.min(MODEL_SIZE / srcW, MODEL_SIZE / srcH);
    const lbW = Math.round(srcW * lbScale), lbH = Math.round(srcH * lbScale);
    const padX = Math.floor((MODEL_SIZE - lbW) / 2), padY = Math.floor((MODEL_SIZE - lbH) / 2);

    const canvas = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE);
    const ctx = canvas.getContext('2d');
    if (letterbox) {
        // Grey pad, the YOLO convention — a white pad reads as page and can
        // grow regions into the margin.
        ctx.fillStyle = '#727272';
        ctx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
        ctx.drawImage(imageBitmap, 0, 0, srcW, srcH, padX, padY, lbW, lbH);
    } else {
        ctx.drawImage(imageBitmap, 0, 0, MODEL_SIZE, MODEL_SIZE);
    }

    // Close it the moment it has been drawn.
    //
    // The bitmap is TRANSFERRED here (`postMessage(..., [imageBitmap])`), so
    // this worker owns it and nothing else can free it. An ImageBitmap holds
    // decoded pixels outside the JS heap — at RENDER_SCALE 2.0 a Letter page is
    // ~7.8 MB — and GC of the small wrapper object does not reliably release
    // them. Without this, a 76-page scan leaks a full-page bitmap per page.
    imageBitmap.close();

    const imageData = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);
    const { data } = imageData;

    // Convert RGBA → NCHW float32.
    //
    // Which normalisation is a per-model fact, declared in the manifest. The
    // incumbent wants plain [0,1]; a model whose backbone was ImageNet-
    // pretrained wants the ImageNet moments. Applying the wrong one costs
    // several points of mAP and produces no error at all, so it is the kind of
    // thing that must be read rather than assumed.
    const numPixels = MODEL_SIZE * MODEL_SIZE;
    const float32 = new Float32Array(3 * numPixels);
    const imagenet = manifest.normalisation === 'imagenet';
    for (let i = 0; i < numPixels; i++) {
        const ri = i * 4;
        let r = data[ri] / 255.0, g = data[ri + 1] / 255.0, b = data[ri + 2] / 255.0;
        if (imagenet) {
            r = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
            g = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
            b = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
        }
        float32[i]                 = r;
        float32[i + numPixels]     = g;
        float32[i + 2 * numPixels] = b;
    }

    const inputTensor = new ort.Tensor('float32', float32, [1, 3, MODEL_SIZE, MODEL_SIZE]);
    const feeds = { [session.inputNames[0]]: inputTensor };
    // Conditional DocForensics exports have a second deterministic evidence
    // input: [is_form, is_geometry, is_clean, reserved]. The image-only YOLO
    // model has no such input. Feed by DECLARED NAME rather than position so a
    // future export cannot silently swap the two inputs.
    for (const name of session.inputNames.slice(1)) {
        if (name !== 'evidence') {
            throw new Error(`unsupported layout-model input "${name}"`);
        }
        const values = Array.isArray(evidence) || ArrayBuffer.isView(evidence)
            ? Array.from(evidence, Number)
            : [0, 0, 0, 0];
        if (values.length !== 4 || values.some((v) => !Number.isFinite(v))) {
            throw new Error('layout evidence must be four finite numbers');
        }
        feeds[name] = new ort.Tensor('float32', Float32Array.from(values), [1, 4]);
    }
    const results = await session.run(feeds);

    // YOLOv8 output shape: [1, numClasses+4, numDetections]
    // First 4 rows: cx, cy, w, h (in model pixel space)
    // Remaining rows: class scores
    const output = results[session.outputNames[0]];
    const rawDetections = parseYolov8Output(output);

    // Apply NMS
    const nmsDetections = nms(rawDetections, IOU_THRESHOLD);

    // Head B, when the manifest says there is one. Read by INDEX into
    // outputNames because ONNX output names are assigned at export time and are
    // not stable across re-exports; the manifest's `signalOrder` is what makes
    // the CONTENTS interpretable, and forensics/signals.js checks it.
    let forensics;
    if (manifest.forensics && session.outputNames.length >= 3) {
        const sigT = results[session.outputNames[1]];
        const mapT = results[session.outputNames[2]];
        if (sigT && mapT) {
            forensics = {
                signalOrder: manifest.forensics.signalOrder,
                mapOrder: manifest.forensics.mapOrder,
                mapGrid: manifest.forensics.mapGrid,
                signals: Array.from(sigT.data),
                maps: Array.from(mapT.data),
            };
        }
    }

    // Map detections to labeled regions. Legacy mode returns 640x640 model
    // space; letterbox mode undoes the pad and scale so boxes come back in
    // SOURCE-image pixels.
    const regions = nmsDetections.map((det, i) => ({
        id: `det_${i}`,
        label: CLASS_LABELS[det.classId] || 'unknown',
        confidence: det.confidence,
        space: letterbox ? 'source' : 'model',
        bbox: letterbox
            ? {
                x: (det.x - padX) / lbScale,
                y: (det.y - padY) / lbScale,
                w: det.w / lbScale,
                h: det.h / lbScale,
            }
            : { x: det.x, y: det.y, w: det.w, h: det.h },
    }));
    return { regions, forensics };
}

// ── YOLOV8 POST-PROCESSING ────────────────────────────────────────────────

function parseYolov8Output(tensor) {
    const [batch, dims, numDets] = tensor.dims;
    const data = tensor.data;
    const numClasses = dims - 4;
    const detections = [];

    for (let d = 0; d < numDets; d++) {
        // Extract cx, cy, w, h
        const cx = data[0 * numDets + d];
        const cy = data[1 * numDets + d];
        const w  = data[2 * numDets + d];
        const h  = data[3 * numDets + d];

        // Find best class
        let bestClass = 0;
        let bestScore = -Infinity;
        for (let c = 0; c < numClasses; c++) {
            const score = data[(4 + c) * numDets + d];
            if (score > bestScore) {
                bestScore = score;
                bestClass = c;
            }
        }

        if (bestScore < CONF_THRESHOLD) continue;

        detections.push({
            x: cx - w / 2,
            y: cy - h / 2,
            w,
            h,
            classId: bestClass,
            confidence: bestScore,
        });
    }

    return detections;
}

/**
 * Non-Maximum Suppression.
 * Sort by confidence, suppress lower-confidence boxes that overlap too much.
 */
function nms(detections, iouThreshold) {
    const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
    const kept = [];

    for (const det of sorted) {
        let dominated = false;
        for (const keptDet of kept) {
            if (iou(det, keptDet) > iouThreshold) {
                dominated = true;
                break;
            }
        }
        if (!dominated) kept.push(det);
    }

    return kept;
}

function iou(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);

    const interW = Math.max(0, x2 - x1);
    const interH = Math.max(0, y2 - y1);
    const inter = interW * interH;

    const areaA = a.w * a.h;
    const areaB = b.w * b.h;
    const union = areaA + areaB - inter;

    return union > 0 ? inter / union : 0;
}
