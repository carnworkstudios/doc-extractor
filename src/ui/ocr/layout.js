// layout.js — reusable driver for the YOLOv8/DocLayNet layout worker.
//
// `fileUpload.js` carries its own copy of this manager (ensureLayoutWorker /
// layoutDetect, ~line 596). That one is wired into the upload flow and is not
// exported, so rather than refactor a live path this module re-implements the
// same protocol for the OCR/fusion path. The duplication is deliberate and
// temporary — see the note in architecture/ocr-native-pipeline.md §07.
//
// The worker returns boxes in 640x640 MODEL space, and the model input is
// produced with a non-uniform stretch (`drawImage(bitmap, 0, 0, 640, 640)`).
// Mapping back is therefore an independent scale per axis, which is what
// `toPageSpace` does. Getting this wrong is silent: boxes land plausibly but
// systematically off on any page that is not square.

const MODEL_SIZE = 640;

let _worker = null;
let _ready = false;
let _reqId = 0;
const _cbs = new Map();

export function ensureLayout() {
    if (_ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
        if (!_worker) {
            _worker = new Worker(new URL('../../workers/layoutWorker.js', import.meta.url),
                                 { type: 'module' });
            _worker.addEventListener('message', (e) => {
                const m = e.data;
                if (m.type === 'result' && m.requestId != null) {
                    const cb = _cbs.get(m.requestId);
                    if (cb) { _cbs.delete(m.requestId); cb.resolve(m.regions || []); }
                } else if (m.type === 'error' && m.requestId != null) {
                    const cb = _cbs.get(m.requestId);
                    if (cb) { _cbs.delete(m.requestId); cb.reject(new Error(m.error)); }
                }
            });
            _worker.postMessage({ type: 'init' });
        }
        const onMsg = (e) => {
            if (e.data.type === 'ready') {
                _worker.removeEventListener('message', onMsg); _ready = true; resolve();
            } else if (e.data.type === 'error' && e.data.requestId == null) {
                _worker.removeEventListener('message', onMsg); reject(new Error(e.data.error));
            }
        };
        _worker.addEventListener('message', onMsg);
    });
}

/**
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @returns {Promise<Array<{label,confidence,bbox:{x,y,w,h}}>>} bbox in PAGE space.
 */
export async function detectLayout(canvas) {
    await ensureLayout();
    const bitmap = await createImageBitmap(canvas);
    const regions = await new Promise((resolve, reject) => {
        const id = ++_reqId;
        _cbs.set(id, { resolve, reject });
        _worker.postMessage(
            { type: 'detect', requestId: id, data: { imageBitmap: bitmap, letterbox: true } },
            [bitmap]);
    });
    // letterbox:true means the worker already returned source-image pixels.
    return regions[0] && regions[0].space === 'source'
        ? regions
        : toPageSpace(regions, canvas.width, canvas.height);
}

function toPageSpace(regions, w, h) {
    const sx = w / MODEL_SIZE, sy = h / MODEL_SIZE;
    return regions.map((r) => ({
        ...r,
        bbox: { x: r.bbox.x * sx, y: r.bbox.y * sy, w: r.bbox.w * sx, h: r.bbox.h * sy },
    }));
}

export function disposeLayout() {
    if (!_worker) return;
    _worker.postMessage({ type: 'dispose' });
    _worker.terminate();
    _worker = null; _ready = false; _cbs.clear();
}
