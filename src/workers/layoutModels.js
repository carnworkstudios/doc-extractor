// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// layoutModels.js — the registry of layout models the worker can load, and the
// flag that chooses between them.
//
// WHY A MANIFEST AND NOT OUTPUT SNIFFING
// --------------------------------------
// The obvious way to support a second model is to look at how many outputs the
// session has and branch. That is precisely how this file's existence is
// justified: layoutWorker.js has a documented history of a bug where the model
// loaded, the geometry decoded correctly, and every class NAME was wrong,
// because a permuted `CLASS_LABELS` array was assumed rather than read from the
// model. Nothing looked broken. Tables came back as `page-header` for weeks.
//
// Sniffing shapes reproduces that failure with more steps. Two models can share
// an output arity and disagree about class order, input normalisation, or
// whether the boxes are cx/cy/w/h or x1/y1/x2/y2 — none of which is visible in
// a shape.
//
// So each model declares everything the worker needs, and the worker reads it.
// If a manifest and a session disagree about anything checkable, the worker
// refuses to run rather than guessing.
//
// THE FLAG
// --------
// One model ships, and it is the default. Selection follows the precedent
// already set by `ocr/index.js`:
// URL param wins over localStorage wins over the default, and which model
// actually ran is reported as a FINDING rather than assumed — an unavailable
// model must never render as the requested one.

/**
 * @typedef {object} LayoutManifest
 * @property {string} id
 * @property {string} url                 relative to BASE_URL
 * @property {number} inputSize
 * @property {'imagenet'|'unit'} normalisation
 * @property {string[]} classes           in the model's own index order
 * @property {'yolov8'} detectionLayout   row order of the detection output
 * @property {string} detectionOutput     output tensor name, or '' for "first"
 * @property {object|null} forensics      null when the model has no Head B
 * @property {string} forensics.signalsOutput
 * @property {string} forensics.mapsOutput
 * @property {string[]} forensics.signalOrder
 * @property {string[]} forensics.mapOrder
 * @property {number} forensics.mapGrid
 * @property {number} defaultConfidence
 */

/**
 * The production detector, and now the only one. The YOLOv8n-DocLayNet model
 * that previously shipped here has been retired: its weights derive from
 * Ultralytics YOLOv8 (AGPL-3.0), which is the encumbrance this model exists to
 * remove, and the comparison that justified the swap is finished. That model
 * file and the bench harnesses now live in the pdf-training repo, which is
 * where the comparison can still be re-run.
 *
 * This model was TRAINED INDEPENDENTLY. It is not distilled from, nor
 * pseudo-labelled by, the model it replaced — `LICENSES.md` bars both, and
 * teacher/student vocabulary is deliberately absent here for that reason.
 *
 * The detection row order is still YOLOv8's — the decode runs inside the ONNX
 * graph and emits (cx, cy, w, h, cls...), so the worker keeps a single
 * exercised parser. A second decode path is the one thing this must not
 * introduce.
 *
 * `classes` is this project's 11, NOT stock DocLayNet: Section-header and Title
 * are merged into `heading`, and the freed slot is `seal/form`. See
 * extraction/forensics/regionMap.js for the full mapping onto RegionType.
 *
 * `defaultConfidence` is deliberately low. A lower threshold is affordable
 * precisely because
 * ocrScale.js can now cross-check region coverage against measured ink, so a
 * spurious region costs a coverage check rather than a wrong extraction.
 */
export const DOCFORENSICS_S = Object.freeze({
    id: 'docforensics-layout-s',
    url: 'models/docforensics-layout-s.onnx',
    inputSize: 640,
    normalisation: 'imagenet',
    classes: Object.freeze([
        'text', 'heading', 'list', 'table', 'picture', 'caption',
        'formula', 'header', 'footer', 'footnote', 'seal',
        'form', 'field', 'checkbox', 'signature',
    ]),
    detectionLayout: 'yolov8',
    detectionOutput: '',
    evidenceInput: Object.freeze({
        name: 'evidence',
        order: Object.freeze(['is_form', 'is_geometry', 'is_clean', 'reserved']),
    }),
    forensics: Object.freeze({
        signalsOutput: '',
        mapsOutput: '',
        signalOrder: Object.freeze(
            ['skew', 'blur', 'noise', 'bleed', 'warp', 'tears', 'handwriting', 'native']),
        mapOrder: Object.freeze(['blur', 'bleed', 'tears', 'handwriting']),
        mapGrid: 20,
    }),
    defaultConfidence: 0.18,
    // Published at https://huggingface.co/ginexys/docforensics-layout — the
    // repo carries the authoritative manifest and sha256 for these weights.
    licence: 'Dual-licensed (AGPL-3.0-or-later, or commercial) by Ginexys / Canworks, LLC — '
        + 'model weights carry no third-party copyleft; backbone init from timm lcnet_100 '
        + '(Apache-2.0), corpus CDLA-Permissive-1.0 + public domain',
});

export const MODELS = Object.freeze({
    [DOCFORENSICS_S.id]: DOCFORENSICS_S,
});

/**
 * DocForensics runs on the normal upload path with no fallback, so a model
 * failure stays visible instead of silently degrading into a different model.
 */
export const DEFAULT_MODEL_ID = DOCFORENSICS_S.id;

/**
 * Which model was ASKED for. URL param, then localStorage, then the default —
 * the same precedence `ocr/index.js` uses, so there is one rule to remember.
 *
 * Whether it actually loaded is a different question, answered by the worker's
 * `ready` message. This function does not know and must not pretend to.
 */
export function requestedModelId(search, storage) {
    try {
        const q = new URLSearchParams(
            search ?? (typeof location !== 'undefined' ? location.search : '')).get('layout');
        if (q && MODELS[q]) return q;
    } catch { /* no location, e.g. under Node */ }
    try {
        const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
        const v = s && s.getItem('gx.layoutModel');
        if (v && MODELS[v]) return v;
    } catch { /* storage unavailable */ }
    return DEFAULT_MODEL_ID;
}

export function manifestFor(id) {
    const m = MODELS[id];
    if (!m) throw new Error(`unknown layout model "${id}"`);
    return m;
}

/**
 * Check a loaded session against its manifest.
 *
 * Refuses rather than adapts. A model whose class count does not match the
 * manifest is a model whose class NAMES are unknown, and running it would
 * reproduce the original bug exactly: plausible geometry, wrong labels, no
 * symptom until somebody reads the output carefully.
 *
 * @param {object} manifest
 * @param {number} detChannels  the 4+C dimension of the detection output
 * @param {number} outputCount
 */
export function assertSessionMatches(manifest, detChannels, outputCount) {
    const expectedChannels = 4 + manifest.classes.length;
    if (detChannels !== expectedChannels) {
        throw new Error(
            `model "${manifest.id}" produced ${detChannels} detection channels; the manifest `
            + `declares ${manifest.classes.length} classes, so ${expectedChannels} were expected. `
            + 'Refusing to guess the class order.');
    }
    const expectedOutputs = manifest.forensics ? 3 : 1;
    if (outputCount < expectedOutputs) {
        throw new Error(
            `model "${manifest.id}" exposes ${outputCount} output(s); the manifest declares `
            + `${expectedOutputs} (detections${manifest.forensics ? ' + forensic signals + maps' : ''}).`);
    }
    return true;
}
