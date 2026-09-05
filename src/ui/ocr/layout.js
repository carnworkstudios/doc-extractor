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

import { widgetRegions, mergeWidgetRegions } from '../../extraction/forensics/widgetRouter.js';

const MODEL_SIZE = 640;

let _worker = null;
let _ready = false;
let _reqId = 0;
const _cbs = new Map();

// What the worker reported it actually loaded. Null until `ensureLayout()`
// resolves.
//
// This is the same rule `ocr/index.js` enforces for engines: WHICH MODEL RAN IS
// A FINDING, NOT A FIELD. A layout model that 404s and silently falls back to
// the incumbent would make an A/B comparison compare the incumbent with itself,
// and the run would look like a tie rather than like a failure to load.
let _report = null;

/** @returns {{model, requested, fellBack, reason, classes, forensics, confidence}|null} */
export function getLayoutReport() {
    return _report ? { ..._report } : null;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.modelId]  which manifest to load. Omit for the default,
 *        which is the incumbent — see workers/layoutModels.js.
 */
export function ensureLayout(opts = {}) {
    if (_ready) return Promise.resolve(_report);
    return new Promise((resolve, reject) => {
        if (!_worker) {
            _worker = new Worker(new URL('../../workers/layoutWorker.js', import.meta.url),
                                 { type: 'module' });
            _worker.addEventListener('message', (e) => {
                const m = e.data;
                if (m.type === 'result' && m.requestId != null) {
                    const cb = _cbs.get(m.requestId);
                    if (cb) {
                        _cbs.delete(m.requestId);
                        // The whole message, not just `regions`: Head B's
                        // signals ride alongside the detections and dropping
                        // them here would mean re-running inference to get them.
                        cb.resolve(m);
                    }
                } else if (m.type === 'error' && m.requestId != null) {
                    const cb = _cbs.get(m.requestId);
                    if (cb) { _cbs.delete(m.requestId); cb.reject(new Error(m.error)); }
                }
            });
            _worker.postMessage({ type: 'init', data: { modelId: opts.modelId } });
        }
        const onMsg = (e) => {
            if (e.data.type === 'ready') {
                _worker.removeEventListener('message', onMsg);
                _ready = true;
                const { type, ...rest } = e.data;
                _report = rest;
                resolve(_report);
            } else if (e.data.type === 'error' && e.data.requestId == null) {
                _worker.removeEventListener('message', onMsg); reject(new Error(e.data.error));
            }
        };
        _worker.addEventListener('message', onMsg);
    });
}

/**
 * Detect, returning ONLY the regions. Unchanged signature, unchanged contract —
 * every existing caller keeps working and none of them has to learn about a
 * forensic head that may or may not be there.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {object} [opts]
 * @returns {Promise<Array<{label,confidence,bbox:{x,y,w,h}}>>} bbox in PAGE space.
 */
export async function detectLayout(canvas, opts = {}) {
    return (await detectLayoutFull(canvas, opts)).regions;
}

/**
 * Detect, returning regions AND the forensic head's output when the loaded
 * model has one.
 *
 * `forensics` is UNDEFINED for a model without Head B, and that is deliberately
 * not `null` or an empty object: a caller that treats a missing forensic
 * reading as "the page is clean" has made the exact mistake this codebase
 * refuses to allow anywhere else — unavailable must never render as clean.
 *
 * @returns {Promise<{regions:Array, forensics:object|undefined, model:string}>}
 *   `forensics` is `{ signals:number[8], maps:number[4*20*20], signalOrder,
 *   mapOrder, mapGrid }`, all still normalised to [0,1];
 *   `extraction/forensics/signals.js` turns them into physical units and is the
 *   only place that knows the de-normalisers.
 */
export async function detectLayoutFull(canvas, opts = {}) {
    await ensureLayout(opts);
    const bitmap = await createImageBitmap(canvas);
    const msg = await new Promise((resolve, reject) => {
        const id = ++_reqId;
        _cbs.set(id, { resolve, reject });
        _worker.postMessage(
            { type: 'detect', requestId: id,
              data: { imageBitmap: bitmap, letterbox: true, evidence: opts.evidence || null } },
            [bitmap]);
    });
    const raw = msg.regions || [];
    // letterbox:true means the worker already returned source-image pixels.
    let regions = raw[0] && raw[0].space === 'source'
        ? raw
        : toPageSpace(raw, canvas.width, canvas.height);

    // ── AcroForm widgets: what the FILE states, not what the model guessed ──
    //
    // The detector cannot see form fields. `seal/form` is its only form-ish
    // class, it is entirely synthetic, and on a real f1040 it fires zero times:
    // the model returns 3 regions and leaves the whole form body empty, which
    // is worse than a wrong label because fusion then has nothing to attach
    // OCR lines to.
    //
    // When the caller supplies the page's annotations, the fields are read
    // straight out of the PDF instead. Opt-in by parameter rather than done
    // here unconditionally, because this module only ever receives a canvas —
    // it has no way to reach the page itself, and inventing one would couple
    // the OCR path to pdf.js.
    let widgets;
    if (opts.annotations && opts.viewport) {
        widgets = widgetRegions(opts.annotations, opts.viewport);
        if (widgets.hasAcroForm) {
            const merged = mergeWidgetRegions(regions, widgets);
            regions = merged.regions;
        }
    }

    return {
        regions,
        forensics: msg.forensics,
        model: msg.model,
        // A finding, like `model`: whether form structure came from the file or
        // was left to the detector is something the caller must be able to see.
        widgets: widgets
            ? { hasAcroForm: widgets.hasAcroForm, fields: widgets.fields }
            : undefined,
    };
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
    _worker = null; _ready = false; _report = null; _cbs.clear();
}
