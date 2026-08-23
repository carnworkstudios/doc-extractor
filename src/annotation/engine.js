/**
 * engine.js
 * The standalone PDF annotation engine. Owns the annotation list, the active
 * tool, the Text/Annotate mode switch, pointer-drag draft state, and its own
 * undo/redo stacks. No DOM — the layer (layer.js) renders whatever the engine
 * says and routes pointer events back here in display space.
 *
 * Annotations ride along at the top level of the gx-doc IR (doc.annotations),
 * so they survive JSON export/import and re-extraction. The engine keeps the
 * in-memory list in sync with state.pdf1.gxDoc.annotations.
 *
 * Coordinate space: display space = PDF points, top-left origin, y down —
 * the SVG viewBox space. Layer converts screen→display before calling in.
 */

import { state } from '../state.js';
import {
    createAnnotation,
    cloneAnnotations,
    annotationBBox,
    annotationsFromGxDoc,
    ensureGxDocAnnotations,
} from './annotations.js';
import {
    rectFromPoints,
    pointInRect,
    closestPointOnSegment,
    simplifyPolyline,
    smoothPolyline,
} from './geometry.js';

export const MODES = ['text', 'annotate'];

// Tool semantics:
//   draw     — drag creates a new annotation (highlight/ink/rect/ellipse/arrow/measure)
//   text     — click places a text note, inline edit commits
//   select   — click/drag manipulates existing annotations
export const TOOLS = ['select', 'highlight', 'ink', 'rect', 'ellipse', 'arrow', 'measure'];
export const DRAW_TOOLS = new Set(['highlight', 'ink', 'rect', 'ellipse', 'arrow', 'measure']);

const MIN_DIM = 3;          // minimum drag size for rect/ellipse/highlight
const INK_MIN_DIST = 1.5;   // display-space px between ink samples
const UNDO_LIMIT = 100;

let _mode = 'text';
let _tool = 'select';
let _toolLock = false;

// Annotations for the current document. Always the normalized list.
let _annotations = [];

let _undoStack = [];
let _redoStack = [];

// In-progress gesture (drag) — set by beginDrag, consumed by endDrag.
let _draft = null;
let _inGesture = false;

// Selection state (per session).
let _selectedId = null;

const _listeners = new Set();

// ── Subscription / state getters ─────────────────────────────────────────────

export function subscribe(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
}

function _notify(evt) {
    for (const fn of _listeners) {
        try { fn(evt); } catch (err) { console.error('[annotation.engine] listener error', err); }
    }
}

export function getMode() { return _mode; }
export function getTool() { return _tool; }
export function getToolLock() { return _toolLock; }
export function getSelectedId() { return _selectedId; }
export function getAnnotations() { return _annotations; }
export function annotationsForPage(pageNum) {
    return _annotations.filter(a => a.page === pageNum);
}

/** Current draw style defaults (overridable via updateStyle). */
export const DRAW_STYLE_DEFAULTS = {
    highlight: { color: '#ffeb3b', opacity: 0.4 },
    ink:       { color: '#e11d48', strokeWidth: 2 },
    rect:      { color: '#1565c0', strokeWidth: 2 },
    ellipse:   { color: '#1565c0', strokeWidth: 2 },
    arrow:     { color: '#e11d48', strokeWidth: 2 },
    text:      { color: '#111111', fontSize: 14 },
    measure:   { color: '#7b1fa2', strokeWidth: 1.5 },
};

let _styleOverrides = {};

export function getStyleFor(kind) {
    return { ...(DRAW_STYLE_DEFAULTS[kind] || {}), ...(_styleOverrides[kind] || {}) };
}

export function updateStyle(kind, patch) {
    const next = { ...(_styleOverrides[kind] || {}), ...patch };
    _styleOverrides[kind] = Object.keys(next).length ? next : null;
    _notify({ type: 'style' });
}

// ── Mode / tool ──────────────────────────────────────────────────────────────

export function setMode(mode) {
    if (!MODES.includes(mode)) return;
    if (mode === _mode) return;
    _mode = mode;
    if (mode === 'text') {
        _cancelDraft();
        _selectedId = null;
    }
    _notify({ type: 'mode' });
}

export function setTool(tool) {
    if (!TOOLS.includes(tool)) return;
    _cancelDraft();
    _tool = tool;
    _notify({ type: 'tool' });
}

export function toggleToolLock() {
    _toolLock = !_toolLock;
    _notify({ type: 'tool' });
}

/**
 * After a draw commit, revert to Select unless the tool is locked (Q).
 * Text stays on text so the user can place several notes.
 */
function _maybeRevertTool() {
    if (_toolLock) return;
    if (DRAW_TOOLS.has(_tool)) setTool('select');
}

// ── Sync with the gx-doc IR ──────────────────────────────────────────────────

export function loadFromGxDoc(doc) {
    _annotations = annotationsFromGxDoc(doc || state.pdf1?.gxDoc);
    _undoStack = [];
    _redoStack = [];
    _selectedId = null;
    _notify({ type: 'load' });
}

export function syncToGxDoc() {
    const doc = state.pdf1?.gxDoc;
    if (!doc) return;
    ensureGxDocAnnotations(doc);
    doc.annotations = cloneAnnotations(_annotations);
}

export function reset() {
    _annotations = [];
    _undoStack = [];
    _redoStack = [];
    _selectedId = null;
    _draft = null;
    _mode = 'text';
    _tool = 'select';
    _toolLock = false;
    _notify({ type: 'reset' });
}

// ── Undo / redo (annotation's own stack) ─────────────────────────────────────

export function canUndo() { return _undoStack.length > 0; }
export function canRedo() { return _redoStack.length > 0; }

function _pushUndo() {
    if (_inGesture) return;
    _undoStack.push(cloneAnnotations(_annotations));
    if (_undoStack.length > UNDO_LIMIT) _undoStack.shift();
    _redoStack = [];
}

/**
 * Begin a multi-update gesture (drag/move/resize). Snapshot once up front so
 * the whole drag is a single undo step. endGesture() must always be called.
 */
export function beginGesture() {
    if (_inGesture) return;
    _inGesture = true;
    _undoStack.push(cloneAnnotations(_annotations));
    if (_undoStack.length > UNDO_LIMIT) _undoStack.shift();
    _redoStack = [];
}

export function endGesture() {
    _inGesture = false;
}

/** Mutate without pushing a new undo entry (used mid-gesture). */
export function updateAnnotationLive(id, patch) {
    const idx = _annotations.findIndex(a => a.id === id);
    if (idx === -1) return;
    _annotations[idx] = { ..._annotations[idx], ...patch, edited: new Date().toISOString() };
    syncToGxDoc();
    _notify({ type: 'update' });
}

export function undo() {
    if (!_undoStack.length) return false;
    _redoStack.push(cloneAnnotations(_annotations));
    _annotations = _undoStack.pop();
    _selectedId = null;
    syncToGxDoc();
    _notify({ type: 'undo' });
    return true;
}

export function redo() {
    if (!_redoStack.length) return false;
    _undoStack.push(cloneAnnotations(_annotations));
    _annotations = _redoStack.pop();
    _selectedId = null;
    syncToGxDoc();
    _notify({ type: 'redo' });
    return true;
}

// ── Mutations ────────────────────────────────────────────────────────────────

export function addAnnotation(ann) {
    _pushUndo();
    _annotations.push(ann);
    syncToGxDoc();
    _notify({ type: 'add' });
}

export function updateAnnotation(id, patch) {
    const idx = _annotations.findIndex(a => a.id === id);
    if (idx === -1) return;
    _pushUndo();
    _annotations[idx] = { ..._annotations[idx], ...patch, edited: new Date().toISOString() };
    syncToGxDoc();
    _notify({ type: 'update' });
}

export function removeAnnotation(id) {
    if (!_annotations.some(a => a.id === id)) return;
    _pushUndo();
    _annotations = _annotations.filter(a => a.id !== id);
    if (_selectedId === id) _selectedId = null;
    syncToGxDoc();
    _notify({ type: 'remove' });
}

export function clearAnnotations() {
    if (!_annotations.length) return;
    _pushUndo();
    _annotations = [];
    _selectedId = null;
    syncToGxDoc();
    _notify({ type: 'remove' });
}

export function selectAnnotation(id) {
    _selectedId = id;
    _notify({ type: 'select' });
}

// ── Draft (drag gesture) ─────────────────────────────────────────────────────

export function getDraft() { return _draft; }

function _cancelDraft() {
    _draft = null;
}

/**
 * Start a draw/select gesture. pt in display space.
 *
 * `opts.pick` runs the SAME gesture for a caller that wants the geometry and
 * not an annotation — the reference board's crop marquee. Same draft, same
 * live preview, same rectFromPoints normalisation; only the ending differs
 * (endDrag hands the draft back instead of committing it). It also bypasses
 * the annotate-mode gate, because a crop is not an edit to the document and
 * must not require the user to arm annotation first.
 *
 * @param {number} pageNum
 * @param {{x:number,y:number}} pt
 * @param {{pick?:boolean, kind?:string}} [opts]
 */
export function beginDrag(pageNum, pt, opts = {}) {
    if (!opts.pick && _mode !== 'annotate') return;
    _cancelDraft();
    _selectedId = null;
    const kind = opts.kind || _tool;
    _draft = { page: pageNum, start: { ...pt }, kind, pick: !!opts.pick };
    if (kind === 'ink') _draft.points = [pt];
    _notify({ type: 'draft' });
}

export function updateDraft(pt) {
    if (!_draft) return;
    const d = _draft;
    if (d.kind === 'ink') {
        if (!d.points) d.points = [d.start];
        const last = d.points[d.points.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) < INK_MIN_DIST) return;
        d.points.push({ ...pt });
    } else if (d.kind === 'text') {
        // text is click-commit, no drag geometry
        d.pt = { ...pt };
    } else {
        d.rect = rectFromPoints(d.start, pt);
    }
    _notify({ type: 'draft' });
}

export function cancelDrag() {
    if (!_draft) return;
    _cancelDraft();
    _notify({ type: 'draft' });
}

/**
 * End the gesture: commit the draft as an annotation, or drop too-small ones.
 *
 * A `pick` draft is handed BACK instead of committed — the caller asked for a
 * rectangle, not a mark on the page. Returns the draft (pick) or the committed
 * annotation, so either caller can read the result without re-deriving it.
 */
export function endDrag() {
    const d = _draft;
    if (!d) return null;
    _cancelDraft();
    _notify({ type: 'draft' });

    // A pick leaves nothing behind: no annotation, no selection, and no tool
    // revert — the tool was never switched, so there is nothing to revert to.
    if (d.pick) return d;

    const ann = _commitDraft(d);
    if (!ann) return null;
    addAnnotation(ann);
    _selectedId = ann.id;
    _notify({ type: 'select' });
    _maybeRevertTool();
    return ann;
}

function _commitDraft(d) {
    const style = getStyleFor(d.kind);

    switch (d.kind) {
        case 'highlight': {
            if (!d.rect || d.rect.w < MIN_DIM || d.rect.h < MIN_DIM) return null;
            return createAnnotation({ kind: 'highlight', page: d.page, rect: d.rect, style });
        }
        case 'rect': {
            if (!d.rect || d.rect.w < MIN_DIM || d.rect.h < MIN_DIM) return null;
            return createAnnotation({ kind: 'rect', page: d.page, rect: d.rect, style });
        }
        case 'ellipse': {
            if (!d.rect || d.rect.w < MIN_DIM || d.rect.h < MIN_DIM) return null;
            return createAnnotation({ kind: 'ellipse', page: d.page, rect: d.rect, style });
        }
        case 'arrow': {
            if (!d.rect || (d.rect.w === 0 && d.rect.h === 0)) return null;
            return createAnnotation({ kind: 'arrow', page: d.page, rect: d.rect, style });
        }
        case 'measure': {
            if (!d.rect || (d.rect.w === 0 && d.rect.h === 0)) return null;
            const len = Math.hypot(d.rect.w, d.rect.h);
            const label = `${len.toFixed(1)} pt`;
            return createAnnotation({ kind: 'measure', page: d.page, rect: d.rect, style, label });
        }
        case 'ink': {
            const pts = (d.points || []).map(p => ({ x: p.x, y: p.y }));
            if (pts.length < 2) return null;
            const simplified = simplifyPolyline(pts, 0.75);
            const smooth = smoothPolyline(simplified);
            return createAnnotation({
                kind: 'ink', page: d.page,
                points: smooth.map(p => [p.x, p.y]),
                style,
            });
        }
        case 'text': {
            const fs = style.fontSize || 14;
            const x = d.start.x;
            const y = d.start.y;
            const w = Math.max(12, fs * 6);
            return createAnnotation({
                kind: 'text', page: d.page,
                rect: { x, y, w, h: fs * 1.4 },
                text: 'Type here…',
                style,
            });
        }
        default:
            return null;
    }
}

// ── Hit testing (used by layer for select) ──────────────────────────────────

export function findAt(pageNum, pt, tol = 6) {
    const list = annotationsForPage(pageNum);
    for (let i = list.length - 1; i >= 0; i--) {
        const ann = list[i];
        const b = annotationBBox(ann);
        if (pointInRect(pt, b, tol)) return ann;
        if (ann.kind === 'ink' && ann.points) {
            // ink: bbox is loose — tighten with a per-segment distance test
            if (_inkHit(ann.points, pt, tol)) return ann;
        }
    }
    return null;
}

function _inkHit(points, pt, tol) {
    for (let i = 1; i < points.length; i++) {
        const a = { x: points[i - 1][0], y: points[i - 1][1] };
        const b = { x: points[i][0], y: points[i][1] };
        if (closestPointOnSegment(pt, a, b).dist <= tol) return true;
    }
    return false;
}
