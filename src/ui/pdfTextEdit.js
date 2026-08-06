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

const CONTAINER_SEL = '#pdf-canvas-container';
const MODE_CLASS = 'pdf-text-edit-mode';

let _on = false;
const _listeners = new Set();

export function isTextEditMode() { return _on; }

export function onTextEditChange(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
}

function _containers() {
    return Array.from(document.querySelectorAll(CONTAINER_SEL));
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
}

/**
 * Diff every span against its `data-orig`.
 * @returns {Array<{page:number,x:number,y:number,w:number,h:number,
 *                  fontSize:number,from:string,to:string}>}
 *          Boxes are in display space (PDF points, top-left origin, y down).
 */
export function collectTextEdits() {
    const edits = [];
    _containers().forEach(container => {
        container.querySelectorAll('.page-wrapper').forEach(wrapper => {
            const page = parseInt(wrapper.dataset.page, 10) || 1;
            wrapper.querySelectorAll('.pdf-text-span').forEach(span => {
                const orig = span.dataset.orig;
                if (orig == null) return;              // not a pdf.js-built span
                const now = span.textContent ?? '';
                if (now === orig) return;

                const fontSize = parseFloat(span.dataset.fs) || 0;
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
            });
        });
    });
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
