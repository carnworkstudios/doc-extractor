/**
 * layer.js
 * Renders the annotation engine's state as an SVG overlay on each .page-wrapper
 * and routes pointer/keyboard input back into the engine in display space.
 *
 * Coordinate space: SVG viewBox is page display space (PDF points, top-left,
 * y down). Screen→display conversion uses getBoundingClientRect, which already
 * accounts for the 1.5× render scale AND the CSS `zoom` on .page-wrapper — so
 * no transform math is needed here.
 *
 * Mount per container (PDF view: editable; Visual Diff left pane: readOnly).
 * `mountLayers` is idempotent per container.
 */

import $ from 'jquery';
import { state } from '../state.js';
import * as engine from './engine.js';
import { createAnnotation, annotationBBox } from './annotations.js';
import {
    rectFromPoints,
    rectHandles,
    handleAtPoint,
    pointInRect,
    arrowHeadPoints,
    dist,
} from './geometry.js';

const NS = 'http://www.w3.org/2000/svg';
const HANDLE_TOL = 8;      // screen px tolerance for handle hit
const HIT_TOL = 6;         // display-space tol for shape hit

const _mounts = new Map(); // containerEl → mount handle

function el(tag, attrs = {}, children) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    (children || []).forEach(c => node.appendChild(c));
    return node;
}

/** Convert a client point to display space for the given SVG. */
function toDisplay(svg, clientX, clientY) {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return {
        x: ((clientX - r.left) * vb.width) / r.width,
        y: ((clientY - r.top) * vb.height) / r.height,
    };
}

// ── Mount / unmount ──────────────────────────────────────────────────────────

/**
 * Create SVG overlays for every .page-wrapper in `container` and keep them
 * synced to the engine. readOnly = no pointer/keyboard handling (visual diff).
 * Idempotent: calling again tears down the previous mount for the container.
 */
export function mountLayers(container, { readOnly = false } = {}) {
    if (!container) return null;
    unmountLayers(container);

    const handle = { container, readOnly, svgs: [], disposed: false };
    const unsub = engine.subscribe(() => {
        if (!handle.disposed) {
            handle.svgs.forEach(renderLayer);
            syncEnvironment(handle);
        }
    });
    handle.unsub = unsub;

    container.querySelectorAll('.page-wrapper').forEach(wrapper => {
        const svg = createSvg(wrapper, readOnly);
        handle.svgs.push({ wrapper, svg, readOnly });
    });
    handle.svgs.forEach(renderLayer);
    syncEnvironment(handle);
    _mounts.set(container, handle);
    wireLayers(handle);
    return handle;
}

export function unmountLayers(container) {
    const h = _mounts.get(container);
    if (!h) return;
    h.disposed = true;
    h.unsub();
    h._cleanup?.();
    h.svgs.forEach(({ svg }) => svg.remove());
    _mounts.delete(container);
}

function createSvg(wrapper, readOnly) {
    const canvas = wrapper.querySelector('canvas');
    const pageW = parseFloat(wrapper.dataset.pageW) || ((canvas?.width || 0) / 1.5);
    const pageH = parseFloat(wrapper.dataset.pageH) || ((canvas?.height || 0) / 1.5);
    const pageNum = wrapper.dataset.page || '1';
    const svg = el('svg', {
        class: 'annotation-layer',
        'data-annotation-layer': '1',
        'data-page': pageNum,
        viewBox: `0 0 ${pageW} ${pageH}`,
        preserveAspectRatio: 'none',
    });
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:3;pointer-events:none;';
    wrapper.appendChild(svg);
    return svg;
}

/** Toggle pointer-events + contentEditable based on mode. */
function syncEnvironment(handle) {
    const annotating = engine.getMode() === 'annotate';
    handle.container.querySelectorAll('.page-wrapper').forEach(wrapper => {
        const svg = wrapper.querySelector('.annotation-layer');
        if (svg) svg.style.pointerEvents = (!handle.readOnly && annotating) ? 'auto' : 'none';
        const textLayer = wrapper.querySelector('.editable-text-layer');
        // Edit-text mode owns contenteditable placement (it moves the editing
        // host down onto each span). Re-asserting it here would put the host
        // back on the wrapper and break caret scoping.
        const textEditing = wrapper.closest('.pdf-text-edit-mode') !== null;
        if (textEditing) return;
        if (textLayer) textLayer.contentEditable = annotating ? 'false' : 'true';
        wrapper.contentEditable = annotating ? 'false' : 'true';
    });
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderLayer({ wrapper, svg }) {
    const pageNum = parseInt(wrapper.dataset.page, 10) || 1;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const anns = engine.annotationsForPage(pageNum);
    const selectedId = engine.getSelectedId();
    const draft = engine.getDraft();
    const showDraft = draft && draft.page === pageNum && engine.getMode() === 'annotate';

    anns.forEach(ann => renderAnnotation(svg, ann, selectedId === ann.id));
    if (showDraft && draft.kind !== 'text') renderDraft(svg, draft);
}

function renderAnnotation(svg, ann, selected) {
    const st = ann.style || {};
    const root = (sel, attrs, children) => {
        const g = el('g', { class: `ann-${sel}`, ...attrs });
        (children || []).forEach(c => g.appendChild(c));
        svg.appendChild(g);
        return g;
    };

    switch (ann.kind) {
        case 'highlight':
            if (ann.rect) {
                root('highlight', { opacity: st.opacity ?? 0.4 }, [
                    el('rect', {
                        x: ann.rect.x, y: ann.rect.y, width: ann.rect.w, height: ann.rect.h,
                        fill: st.color || '#ffeb3b',
                    }),
                ]);
            } else if (ann.points) {
                root('highlight', { opacity: st.opacity ?? 0.4 }, [
                    el('path', { d: polyPath(ann.points, true), fill: st.color || '#ffeb3b' }),
                ]);
            }
            break;
        case 'rect':
            root('rect', {}, [
                el('rect', {
                    x: ann.rect.x, y: ann.rect.y, width: ann.rect.w, height: ann.rect.h,
                    fill: 'none', stroke: st.color || '#1565c0',
                    'stroke-width': st.strokeWidth || 2,
                }),
            ]);
            break;
        case 'ellipse':
            root('ellipse', {}, [
                el('ellipse', {
                    cx: ann.rect.x + ann.rect.w / 2, cy: ann.rect.y + ann.rect.h / 2,
                    rx: ann.rect.w / 2, ry: ann.rect.h / 2,
                    fill: 'none', stroke: st.color || '#1565c0',
                    'stroke-width': st.strokeWidth || 2,
                }),
            ]);
            break;
        case 'arrow': {
            const from = { x: ann.rect.x, y: ann.rect.y };
            const to = { x: ann.rect.x + ann.rect.w, y: ann.rect.y + ann.rect.h };
            const lw = st.strokeWidth || 2;
            const [p1, p2] = arrowHeadPoints(from, to, Math.max(8, lw * 4));
            root('arrow', {}, [
                el('line', {
                    x1: from.x, y1: from.y, x2: to.x, y2: to.y,
                    stroke: st.color || '#e11d48', 'stroke-width': lw,
                }),
                el('polygon', {
                    points: `${to.x},${to.y} ${p1.x},${p1.y} ${p2.x},${p2.y}`,
                    fill: st.color || '#e11d48',
                }),
            ]);
            break;
        }
        case 'ink':
            if (ann.points) {
                root('ink', {}, [
                    el('path', {
                        d: polyPath(ann.points, false),
                        fill: 'none', stroke: st.color || '#e11d48',
                        'stroke-width': st.strokeWidth || 2,
                        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
                    }),
                ]);
            }
            break;
        case 'text':
            root('textnote', {}, [
                el('text', {
                    x: ann.rect.x, y: ann.rect.y + (st.fontSize || 14),
                    'font-size': st.fontSize || 14,
                    fill: st.color || '#111111',
                }, [document.createTextNode(String(ann.text || ''))]),
            ]);
            break;
        case 'measure': {
            const from = { x: ann.rect.x, y: ann.rect.y };
            const to = { x: ann.rect.x + ann.rect.w, y: ann.rect.y + ann.rect.h };
            const lw = st.strokeWidth || 1.5;
            const label = String(ann.label || '');
            const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
            root('measure', {}, [
                el('line', {
                    x1: from.x, y1: from.y, x2: to.x, y2: to.y,
                    stroke: st.color || '#7b1fa2', 'stroke-width': lw,
                }),
                el('text', {
                    x: mid.x, y: mid.y - 4,
                    'font-size': st.fontSize || 12,
                    fill: st.color || '#7b1fa2',
                    'text-anchor': 'middle',
                }, [document.createTextNode(label)]),
            ]);
            break;
        }
    }

    if (selected) renderSelection(svg, ann);
}

function renderDraft(svg, draft) {
    const kind = draft.kind;
    const st = engine.getStyleFor(kind);
    switch (kind) {
        case 'highlight':
        case 'rect':
        case 'ellipse':
        case 'arrow':
        case 'measure': {
            if (!draft.rect) return;
            const fill = kind === 'highlight' ? (st.color || '#ffeb3b') : 'none';
            const opacity = kind === 'highlight' ? (st.opacity ?? 0.4) : 1;
            const stroke = kind === 'highlight' ? 'none' : (st.color || '#e11d48');
            const lw = st.strokeWidth || 2;
            if (kind === 'ellipse') {
                svg.appendChild(el('ellipse', {
                    cx: draft.rect.x + draft.rect.w / 2, cy: draft.rect.y + draft.rect.h / 2,
                    rx: draft.rect.w / 2, ry: draft.rect.h / 2,
                    fill, stroke, 'stroke-width': lw, opacity, 'stroke-dasharray': '4 3',
                }));
            } else {
                svg.appendChild(el('rect', {
                    x: draft.rect.x, y: draft.rect.y, width: draft.rect.w, height: draft.rect.h,
                    fill, stroke, 'stroke-width': lw, opacity, 'stroke-dasharray': '4 3',
                }));
            }
            if (kind === 'measure') {
                const len = Math.hypot(draft.rect.w, draft.rect.h).toFixed(1);
                svg.appendChild(el('text', {
                    x: draft.rect.x + draft.rect.w / 2, y: draft.rect.y + draft.rect.h / 2 - 4,
                    'font-size': st.fontSize || 12, fill: st.color || '#7b1fa2',
                    'text-anchor': 'middle',
                }, [document.createTextNode(`${len} pt`)]));
            }
            break;
        }
        case 'ink': {
            const pts = (draft.points || []).map(p => [p.x, p.y]);
            if (pts.length < 2) return;
            svg.appendChild(el('path', {
                d: polyPath(pts, false),
                fill: 'none', stroke: st.color || '#e11d48',
                'stroke-width': st.strokeWidth || 2,
                'stroke-linecap': 'round', 'stroke-linejoin': 'round',
            }));
            break;
        }
    }
}

function renderSelection(svg, ann) {
    const b = annotationBBox(ann);
    if (!b || (b.w === 0 && b.h === 0)) return;

    const pad = 3;
    const box = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
    svg.appendChild(el('rect', {
        class: 'ann-selection-box',
        x: box.x, y: box.y, width: box.w, height: box.h,
        fill: 'none', stroke: '#3b82f6', 'stroke-width': 1.5,
        'stroke-dasharray': '5 3', 'pointer-events': 'none',
    }));

    // Resize handles only for rect-shaped annotations (not freehand ink).
    if (ann.points && !ann.rect) return;
    const hs = rectHandles(box);
    Object.entries(hs).forEach(([key, pt]) => {
        const size = 8;
        svg.appendChild(el('rect', {
            class: `ann-handle ann-handle--${key}`,
            x: pt.x - size / 2, y: pt.y - size / 2,
            width: size, height: size,
            fill: '#ffffff', stroke: '#3b82f6', 'stroke-width': 1.5,
            'pointer-events': 'none',
        }));
    });
}

function polyPath(points, close) {
    const pts = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ');
    return close ? `${pts} Z` : pts;
}

// ── Pointer interaction (editable mounts only) ───────────────────────────────

export function wireLayers(handle) {
    if (handle.readOnly || handle.wired) return;
    handle.wired = true;

    handle.container.addEventListener('mousedown', onMouseDown);
    handle.container.addEventListener('dblclick', onDblClick);
    document.addEventListener('keydown', onKeyDown);
    handle._cleanup = () => {
        handle.container.removeEventListener('mousedown', onMouseDown);
        handle.container.removeEventListener('dblclick', onDblClick);
        document.removeEventListener('keydown', onKeyDown);
    };
}

function onMouseDown(e) {
    if (engine.getMode() !== 'annotate') return;
    if (e.button !== 0) return;
    const svg = e.target.closest?.('.annotation-layer');
    if (!svg) return;
    e.preventDefault();
    e.stopPropagation();

    const wrapper = svg.parentElement;
    const pageNum = parseInt(wrapper.dataset.page, 10) || 1;
    const pt = toDisplay(svg, e.clientX, e.clientY);
    const tool = engine.getTool();

    if (tool === 'select') {
        startSelectGesture(e, wrapper, pageNum, pt);
    } else if (tool === 'text') {
        placeText(wrapper, pageNum, pt);
    } else {
        startDrawGesture(e, svg, pageNum, pt);
    }
}

function startDrawGesture(e, svg, pageNum, pt) {
    engine.beginDrag(pageNum, pt);
    const move = ev => engine.updateDraft(toDisplay(svg, ev.clientX, ev.clientY));
    const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        engine.endDrag();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
}

function startSelectGesture(e, wrapper, pageNum, pt) {
    const anns = engine.annotationsForPage(pageNum);
    const sel = engine.getSelectedId();
    const selAnn = sel ? anns.find(a => a.id === sel) : null;

    // Handle resize first (on the current selection's bbox).
    if (selAnn) {
        const b = annotationBBox(selAnn);
        const box = expandBBox(b, 3);
        const h = handleAtPoint(pt, box, HANDLE_TOL / scaleOf(wrapper));
        if (h) {
            const b2 = annotationBBox(selAnn);
            startResizeGesture(e, wrapper, selAnn, b2, h, pt);
            return;
        }
    }

    const hit = engine.findAt(pageNum, pt, HIT_TOL / scaleOf(wrapper));
    if (hit) {
        if (engine.getSelectedId() !== hit.id) engine.selectAnnotation(hit.id);
        startMoveGesture(e, wrapper, hit, pt);
    } else {
        engine.selectAnnotation(null);
    }
}

function startMoveGesture(e, wrapper, ann, pt) {
    const svg = wrapper.querySelector('.annotation-layer');
    const annId = ann.id;
    engine.beginGesture();
    const move = ev => {
        const p = toDisplay(svg, ev.clientX, ev.clientY);
        const dx = p.x - pt.x, dy = p.y - pt.y;
        pt = p;
        // Re-read the annotation's current state from the engine to avoid
        // accumulating drift from a stale captured reference.
        const current = engine.getAnnotations().find(a => a.id === annId);
        if (!current) return;
        const b = annotationBBox(current);
        const patch = { rect: { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h } };
        if (current.points) {
            patch.points = current.points.map(([x, y]) => [x + dx, y + dy]);
            delete patch.rect;
        }
        engine.updateAnnotationLive(annId, patch);
    };
    const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        engine.endGesture();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
}

function startResizeGesture(e, wrapper, ann, b, handle, startPt) {
    const svg = wrapper.querySelector('.annotation-layer');
    const annId = ann.id;
    const origRect = { ...b };
    engine.beginGesture();
    const move = ev => {
        const p = toDisplay(svg, ev.clientX, ev.clientY);
        // Compute total delta from the drag start point (absolute, not incremental)
        // so each frame applies a clean offset from the original rect snapshot.
        const dx = p.x - startPt.x, dy = p.y - startPt.y;
        engine.updateAnnotationLive(annId, { rect: resizeRect(origRect, handle, dx, dy) });
    };
    const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        engine.endGesture();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
}

function resizeRect(b, handle, dx, dy) {
    const r = { ...b };
    if (handle.includes('w')) { r.x += dx; r.w -= dx; }
    if (handle.includes('e')) { r.w += dx; }
    if (handle.includes('n')) { r.y += dy; r.h -= dy; }
    if (handle.includes('s')) { r.h += dy; }
    if (r.w < 0) { r.x += r.w; r.w = -r.w; }
    if (r.h < 0) { r.y += r.h; r.h = -r.h; }
    return r;
}

function expandBBox(b, pad) {
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

/** 1 display pt → screen px for the given wrapper (handles zoom+scale). */
function scaleOf(wrapper) {
    const svg = wrapper.querySelector('.annotation-layer');
    if (!svg) return 1;
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return r.width / vb.width || 1;
}

function onDblClick(e) {
    if (engine.getMode() !== 'annotate') return;
    const svg = e.target.closest?.('.annotation-layer');
    if (!svg) return;
    const wrapper = svg.parentElement;
    const pageNum = parseInt(wrapper.dataset.page, 10) || 1;
    const pt = toDisplay(svg, e.clientX, e.clientY);
    const hit = engine.findAt(pageNum, pt, HIT_TOL / scaleOf(wrapper));
    if (hit && hit.kind === 'text') {
        engine.selectAnnotation(hit.id);
        startInlineEdit(wrapper, hit);
    }
}

function onKeyDown(e) {
    if (engine.getMode() !== 'annotate') return;
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.target.isContentEditable) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
        const sel = engine.getSelectedId();
        if (sel) {
            e.preventDefault();
            engine.removeAnnotation(sel);
        }
    } else if (e.key === 'Escape') {
        engine.cancelDrag();
        engine.selectAnnotation(null);
    } else if (e.key === 'q' || e.key === 'Q') {
        engine.toggleToolLock();
    }
}

// ── Text annotation inline editing ───────────────────────────────────────────

function placeText(wrapper, pageNum, pt) {
    const st = engine.getStyleFor('text');
    const ann = createAnnotation({
        kind: 'text', page: pageNum,
        rect: { x: pt.x, y: pt.y, w: 12, h: (st.fontSize || 14) * 1.4 },
        text: '',
        style: st,
    });
    engine.addAnnotation(ann);
    engine.selectAnnotation(ann.id);
    startInlineEdit(wrapper, ann);
}

export function startInlineEdit(wrapper, ann) {
    const svg = wrapper.querySelector('.annotation-layer');
    const edit = document.createElement('div');
    edit.className = 'ann-inline-edit';
    edit.contentEditable = 'true';
    edit.spellcheck = 'false';

    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const xPx = (ann.rect.x / vb.width) * r.width;
    const yPx = (ann.rect.y / vb.height) * r.height;
    const wPx = (Math.max(ann.rect.w, 60) / vb.width) * r.width;
    const fsPx = ((ann.style?.fontSize || 14) * r.width) / vb.width;

    edit.style.cssText = `left:${xPx}px;top:${yPx}px;width:${wPx}px;font-size:${fsPx}px;`;
    edit.textContent = ann.text || '';
    wrapper.appendChild(edit);
    edit.focus();

    const done = (commit) => {
        if (!edit.isConnected) return;
        const text = edit.textContent.trim();
        edit.remove();
        if (commit && text) engine.updateAnnotation(ann.id, { text });
        else if (!text && !ann.text) engine.removeAnnotation(ann.id);
        else if (!commit) engine.updateAnnotation(ann.id, { text: ann.text || '' });
        engine.selectAnnotation(null);
    };

    edit.addEventListener('blur', () => done(true));
    edit.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            edit.blur();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            done(false);
        }
    });
    setTimeout(() => {
        const range = document.createRange();
        range.selectNodeContents(edit);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }, 0);
}

// ── Convenience ──────────────────────────────────────────────────────────────

export function unmountAll() {
    [..._mounts.keys()].forEach(c => unmountLayers(c));
}

export function refreshMounts() {
    _mounts.forEach(h => {
        h.svgs.forEach(renderLayer);
        syncEnvironment(h);
    });
}
