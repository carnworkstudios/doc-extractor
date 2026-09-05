/**
 * pdfTextEdit.js
 * The PDF "Edit Text" surface.
 *
 * The PDF view stacks three things on one .page-wrapper:
 *   z1  <canvas>              — pdf.js raster render of the page
 *   z2  .editable-text-layer  — pdf.js text items as absolutely-positioned
 *                               contenteditable spans
 *   z3  .annotation-layer     — the SVG annotation overlay
 *
 * At rest the spans are transparent so the raster shows through and selection
 * still works. That is correct for reading, and wrong for editing: typing into
 * a transparent span leaves the ORIGINAL glyphs painted on the canvas behind
 * the new ones, so an edit reads as doubled text.
 *
 * Edit-text mode hides the raster and makes the spans the only visible layer.
 * The extracted structural document (HTML view / gx-doc) is produced headlessly
 * by the geometry worker and is NOT what this surface shows, so nothing is lost
 * by hiding the canvas here.
 *
 * Edits are collected as a diff against each span's `data-orig` and written to
 * `gxDoc.textEdits`, which exportPdf.js replays through pdf-lib: cover the
 * original box, draw the new string. That is the export route that produces a
 * real PDF with neither the raster image nor the original text under it.
 */

import { state } from '../state.js';
import * as engine from '../annotation/engine.js';
import { SCALE } from './pdfCanvas.js';

const CONTAINER_SEL = '#pdf-canvas-container';
const MODE_CLASS = 'pdf-text-edit-mode';

let _on = false;
const _listeners = new Set();
// Windowed PDF rendering deliberately removes off-screen text-layer nodes.
// DOM is therefore only a view of an edit, not its source of truth. Keep the
// changed runs keyed by their stable PDF-space identity so scrolling, zooming,
// and re-rendering never discard an edit.
const _parkedEdits = new Map(); // page -> Map(stable span key -> export record)

export function isTextEditMode() { return _on; }

export function onTextEditChange(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
}

function _containers() {
    return Array.from(document.querySelectorAll(CONTAINER_SEL));
}

function _pageWrappers(roots) {
    const wrappers = new Set();
    for (const root of roots) {
        if (root?.matches?.('.page-wrapper')) wrappers.add(root);
        root?.querySelectorAll?.('.page-wrapper').forEach(wrapper => wrappers.add(wrapper));
    }
    return wrappers;
}

// ── Editable scope ───────────────────────────────────────────────────────────

/**
 * Move contenteditable from the LAYER onto each SPAN.
 *
 * The layer holds ~100+ absolutely-positioned spans. With the layer as the
 * editable root, the browser treats all of them as one document in DOM order —
 * which has nothing to do with visual reading order. Ctrl+A selects the whole
 * page, Home/End walk to the wrong span, and typed text lands wherever the
 * caret drifted. Measured: Ctrl+A then typing PREPENDED to a span instead of
 * replacing it.
 *
 * Per-span editing scopes every one of those operations to the run the user
 * actually clicked, which is also the unit the export rewrites.
 */
function _setEditableScope(on, roots = _containers()) {
    _pageWrappers(roots).forEach(wrapper => {
        // The .page-wrapper is ALSO contenteditable (pdfCanvas.js), and it is
        // the outermost one — so IT is the editing host the browser uses for
        // Ctrl+A / Home / End, no matter what the layer or span say. Both have
        // to be switched off for per-span editing to actually scope.
        wrapper.contentEditable = on ? 'false' : 'true';
        wrapper.querySelectorAll('.editable-text-layer').forEach(layer => {
            layer.contentEditable = on ? 'false' : 'true';
        });
        wrapper.querySelectorAll('.pdf-text-span').forEach(span => {
            if (on) {
                span.contentEditable = 'true';
                span.spellcheck = false;
            } else {
                span.removeAttribute('contenteditable');
            }
        });
    });
}

// ── Canvas text masking ──────────────────────────────────────────────────────

// Keep a pristine bitmap for each currently-rendered canvas. Toggling edit mode
// then restores from that bitmap before applying a fresh mask, so masks never
// accumulate across mode changes.
const _pristine = new WeakMap(); // canvas -> ImageData before masking

function _maskCanvasText(on, roots = _containers()) {
    _pageWrappers(roots).forEach(wrapper => {
        const canvas = wrapper.querySelector('canvas');
        if (!canvas || !canvas.width) return;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;

        if (!on) {
            const snap = _pristine.get(canvas);
            if (snap) ctx.putImageData(snap, 0, 0);
            return;
        }

        if (!_pristine.has(canvas)) {
            try {
                _pristine.set(canvas, ctx.getImageData(0, 0, canvas.width, canvas.height));
            } catch (_) {
                return; // tainted canvas — leave this page unmasked
            }
        } else {
            ctx.putImageData(_pristine.get(canvas), 0, 0);
        }

        ctx.save();
        ctx.fillStyle = '#ffffff';
        wrapper.querySelectorAll('.pdf-text-span').forEach(span => {
            const x = parseFloat(span.dataset.x);
            const y = parseFloat(span.dataset.y);
            const w = parseFloat(span.dataset.w);
            const fs = parseFloat(span.dataset.fs);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(fs)) return;
            const pad = fs * SCALE * 0.28;
            ctx.fillRect(
                x * SCALE - pad,
                y * SCALE - pad,
                Math.max((Number.isFinite(w) ? w : 0) * SCALE, fs * SCALE * 0.5) + pad * 2,
                fs * SCALE + pad * 2,
            );
        });
        ctx.restore();
    });
}

/**
 * Enter/leave text-edit mode. Annotate mode is mutually exclusive with it —
 * the annotation SVG sets the text layer to contenteditable=false, so being in
 * both at once is a state where the surface silently refuses keystrokes.
 */
export function setTextEditMode(on) {
    on = Boolean(on);
    if (on === _on) return _on;
    _on = on;

    if (on && engine.getMode() === 'annotate') engine.setMode('text');

    _containers().forEach(c => c.classList.toggle(MODE_CLASS, on));
    document.body.classList.toggle(MODE_CLASS, on);
    _setEditableScope(on);
    _maskCanvasText(on);
    if (on) _fitAll(); else _clearFit();

    if (!on) syncTextEditsToGxDoc();
    _listeners.forEach(fn => { try { fn(_on); } catch (_) {} });
    return _on;
}

export function toggleTextEditMode() { return setTextEditMode(!_on); }

/**
 * Re-apply the mode class after a re-render. renderPDFToCanvas() empties the
 * container, so the class has to be restored by whoever re-rendered.
 */
export function refreshTextEditMode() {
    _containers().forEach(c => c.classList.toggle(MODE_CLASS, _on));
    // Fresh canvases and spans need their edit scope, mask, and fitted text restored.
    if (_on) { _setEditableScope(true); _maskCanvasText(true); _fitAll(); }
}

/**
 * Called by the windowed renderer after a page has finished painting. A page
 * that enters the viewport after edit mode was enabled needs its edit scope,
 * mask, and restored edits, just like pages visible at the time of the toggle.
 */
export function refreshTextEditPage(wrapper) {
    if (!_on || !wrapper) return;
    _restorePageEdits(wrapper);
    _setEditableScope(true, [wrapper]);
    _maskCanvasText(true, [wrapper]);
    _measureSlots(wrapper);
    wrapper.querySelectorAll('.pdf-text-span').forEach(_fitSpan);
}

/** Store a page's diffs immediately before its text nodes are windowed out. */
export function parkTextEditsForPage(wrapper) {
    if (!wrapper) return;
    const page = Number(wrapper.dataset.page) || 1;
    const edits = new Map();
    wrapper.querySelectorAll('.pdf-text-span').forEach(span => {
        const orig = span.dataset.orig;
        if (orig == null || span.textContent === orig) return;
        edits.set(_spanKey(span), {
            x: parseFloat(span.dataset.x) || 0,
            y: parseFloat(span.dataset.y) || 0,
            w: parseFloat(span.dataset.w) || 0,
            fontSize: parseFloat(span.dataset.fitFs) || parseFloat(span.dataset.fs) || 0,
            from: orig,
            to: span.textContent ?? '',
        });
    });
    if (edits.size) _parkedEdits.set(page, edits);
    else _parkedEdits.delete(page);
}

/** A new PDF render is a different document, so its page identities reset. */
export function clearParkedTextEdits() { _parkedEdits.clear(); }

function _spanKey(span) {
    return JSON.stringify([span.dataset.x || '', span.dataset.y || '', span.dataset.w || '',
        span.dataset.fs || '', span.dataset.orig || '']);
}

function _restorePageEdits(wrapper) {
    const edits = _parkedEdits.get(Number(wrapper.dataset.page) || 1);
    if (!edits?.size) return;
    wrapper.querySelectorAll('.pdf-text-span').forEach(span => {
        const edit = edits.get(_spanKey(span));
        if (!edit) return;
        span.textContent = edit.to;
        span.classList.toggle('pdf-text-span--edited', edit.to !== span.dataset.orig);
    });
}

/**
 * Diff every span against its `data-orig`.
 * @returns {Array<{page:number,x:number,y:number,w:number,h:number,
 *                  fontSize:number,from:string,to:string}>}
 *          Boxes are in display space (PDF points, top-left origin, y down).
 */
export function collectTextEdits() {
    const edits = [];
    const seen = new Set();
    const mountedPages = new Set();
    _containers().forEach(container => {
        container.querySelectorAll('.page-wrapper').forEach(wrapper => {
            const page = parseInt(wrapper.dataset.page, 10) || 1;
            mountedPages.add(page);
            wrapper.querySelectorAll('.pdf-text-span').forEach(span => {
                const orig = span.dataset.orig;
                if (orig == null) return;              // not a pdf.js-built span
                const now = span.textContent ?? '';
                if (now === orig) return;

                // The fitted size, when the run was shrunk to stay in its slot.
                // Reporting the original here would export text that overflows
                // the box the preview showed it fitting inside.
                const fontSize = parseFloat(span.dataset.fitFs) || parseFloat(span.dataset.fs) || 0;
                edits.push({
                    page,
                    x: parseFloat(span.dataset.x) || 0,
                    y: parseFloat(span.dataset.y) || 0,
                    w: parseFloat(span.dataset.w) || 0,
                    h: fontSize,
                    fontSize,
                    from: orig,
                    to: now,
                });
                seen.add(`${page}:${_spanKey(span)}`);
            });
        });
    });
    // Include changed runs on pages currently outside the renderer window.
    // Their boxes are encoded in the key, which is sufficient to restore the
    // export record without retaining their DOM nodes.
    for (const [page, pageEdits] of _parkedEdits) {
        if (mountedPages.has(page)) continue;
        for (const [key, edit] of pageEdits) {
            if (seen.has(`${page}:${key}`)) continue;
            edits.push({ ...edit, page, h: edit.fontSize });
        }
    }
    return edits;
}

/** Write the current diff into the gx-doc IR so exporters can read it. */
export function syncTextEditsToGxDoc() {
    const doc = state.pdf1?.gxDoc;
    if (!doc) return [];
    const edits = collectTextEdits();
    if (edits.length) doc.textEdits = edits;
    else delete doc.textEdits;
    return edits;
}

export function hasTextEdits() {
    return collectTextEdits().length > 0;
}

// ── Containment ──────────────────────────────────────────────────────────────

/**
 * Compute each span's usable width: the gap to the next span that shares its
 * baseline, or the page edge when nothing blocks it.
 *
 * A PDF text run has no notion of a "box" — it is a position and a glyph
 * sequence. So an edited run has nothing to be contained BY until we derive it,
 * and the only honest boundary is the next thing on the same line.
 *
 * Measured once on entering the mode; positions do not move while editing.
 */
function _measureSlots(wrapper) {
    const spans = [...wrapper.querySelectorAll('.pdf-text-span')].map(el => ({
        el,
        x: parseFloat(el.dataset.x) || 0,
        y: parseFloat(el.dataset.y) || 0,
        w: parseFloat(el.dataset.w) || 0,
        fs: parseFloat(el.dataset.fs) || 0,
    }));
    const pageW = parseFloat(wrapper.dataset.pageW) || 0;

    for (const s of spans) {
        // Same line = baselines within half a font size of each other.
        const tol = Math.max(2, s.fs * 0.5);
        let limit = pageW || (s.x + s.w);
        for (const o of spans) {
            if (o === s || Math.abs(o.y - s.y) > tol) continue;
            if (o.x >= s.x + s.w * 0.5 && o.x < limit) limit = o.x;
        }
        const slot = Math.max(s.w, limit - s.x);
        s.el.dataset.slotW = String(slot);
    }
}

/**
 * Keep an edited run inside its slot by shrinking it, never by pushing
 * neighbours. Reflowing the page would move text the user did not touch and
 * destroy the fidelity the whole extraction pipeline exists to preserve.
 *
 * The floor is 55% of the original size; past that the edit is simply too long
 * for the space and the span is flagged rather than shrunk into illegibility.
 */
const SHRINK_FLOOR = 0.55;

function _fitSpan(span) {
    if (span.dataset.orig == null) return;
    const baseFs = parseFloat(span.dataset.fs) || 0;
    const slot = parseFloat(span.dataset.slotW) || 0;
    if (!baseFs || !slot) return;

    // Reset to natural size before measuring, or each keystroke compounds.
    span.style.fontSize = `${baseFs * SCALE}px`;
    span.style.maxWidth = '';
    span.style.overflow = '';
    delete span.dataset.fitFs;
    span.classList.remove('pdf-text-span--overflow');

    const slotPx = slot * SCALE;
    const natural = span.scrollWidth;
    if (natural <= slotPx || !natural) return;

    const ratio = slotPx / natural;
    if (ratio >= SHRINK_FLOOR) {
        span.style.fontSize = `${baseFs * SCALE * ratio}px`;
        span.dataset.fitFs = String(baseFs * ratio);
    } else {
        // Too long to shrink into the slot legibly. Clip it to the slot rather
        // than let it paint over the neighbouring column, and flag it red.
        span.style.fontSize = `${baseFs * SCALE * SHRINK_FLOOR}px`;
        span.style.maxWidth = `${slotPx}px`;
        span.style.overflow = 'hidden';
        span.dataset.fitFs = String(baseFs * SHRINK_FLOOR);
        span.classList.add('pdf-text-span--overflow');
    }
}

function _fitAll() {
    _containers().forEach(c => {
        c.querySelectorAll('.page-wrapper').forEach(w => {
            _measureSlots(w);
            w.querySelectorAll('.pdf-text-span').forEach(_fitSpan);
        });
    });
}

function _clearFit() {
    _containers().forEach(c => {
        c.querySelectorAll('.pdf-text-span').forEach(span => {
            span.style.fontSize = '';
            span.style.maxWidth = '';
            span.style.overflow = '';
            delete span.dataset.fitFs;
            span.classList.remove('pdf-text-span--overflow');
        });
    });
}

/**
 * Wire the toolbar toggle and the live edited-span marker.
 * Delegated from document, so it survives every re-render of the PDF view.
 */
export function initPDFTextEdit() {
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('#btn-pdf-text-edit');
        if (!btn) return;
        e.preventDefault();
        toggleTextEditMode();
    });

    // Mark spans that differ from their original so the user can see exactly
    // what the pdf-lib export will rewrite.
    document.addEventListener('input', (e) => {
        const span = e.target.closest?.('.pdf-text-span');
        if (!span || span.dataset.orig == null) return;
        span.classList.toggle('pdf-text-span--edited', span.textContent !== span.dataset.orig);
        _fitSpan(span);
    }, true);

    // Annotate mode sets the text layer to contentEditable=false (layer.js
    // syncEnvironment), so staying in edit-text mode would leave a surface that
    // looks editable and silently refuses keystrokes.
    engine.subscribe(() => {
        if (_on && engine.getMode() === 'annotate') setTextEditMode(false);
    });

    onTextEditChange(() => {
        document.querySelectorAll('#btn-pdf-text-edit').forEach(btn => {
            btn.classList.toggle('active', _on);
            btn.setAttribute('aria-pressed', String(_on));
        });
    });
}

/** Restore every span to its original string and drop the recorded edits. */
export function revertTextEdits() {
    _containers().forEach(container => {
        container.querySelectorAll('.pdf-text-span').forEach(span => {
            if (span.dataset.orig == null) return;
            span.textContent = span.dataset.orig;
            span.classList.remove('pdf-text-span--edited');
        });
    });
    if (state.pdf1?.gxDoc) delete state.pdf1.gxDoc.textEdits;
}
