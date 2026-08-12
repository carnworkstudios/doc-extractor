/**
 * docPdfMirror.js
 * Toggle a read-only mirror of the original PDF alongside the Doc editor
 * (#html-preview), so the source layout stays visible while editing the
 * extracted text. Renders through the same renderPDFToCanvas() pipeline
 * visualDiff.js already uses for its left pane — just pointed at a
 * different container id — then strips the editability that pipeline
 * normally wires up, since this pane is reference-only.
 */
import $ from 'jquery';
import { state } from '../state.js';
import { renderPDFToCanvas } from './pdfCanvas.js';
import { showToast } from './toast.js';

const CONTAINER_ID = 'doc-pdf-mirror';

let active = false;

export function initDocPdfMirror() {
    $('#btn-toggle-pdf-mirror').on('click', toggleDocPdfMirror);
}

async function toggleDocPdfMirror() {
    if (!active && !state.pdf1?.bytes) {
        showToast('Open a PDF first to show it as a reference.', 'error');
        return;
    }

    active = !active;
    $('#btn-toggle-pdf-mirror').toggleClass('active', active);
    $('#view-html').toggleClass('doc-pdf-mirror-active', active);
    $('#doc-pdf-mirror-pane').attr('hidden', !active);

    if (!active) return;

    // Re-render fresh on every activation rather than caching: the doc
    // editor's own content can go through document reloads/undo restores
    // this module has no visibility into, and a stale mirror pane pointed
    // at a previous PDF would be worse than a brief re-render.
    $(`#${CONTAINER_ID}`).html('<p class="empty-hint">Loading…</p>');
    await renderPDFToCanvas(state.pdf1.bytes, CONTAINER_ID);
    _makeReadOnly();
}

/** renderPDFToCanvas wires every page wrapper up as contenteditable — fine
 * for the real PDF tab, wrong for a side-reference pane the user never means
 * to type into. */
function _makeReadOnly() {
    const $container = $(`#${CONTAINER_ID}`);
    $container.find('[contenteditable]').attr('contenteditable', 'false');
    $container.css('user-select', 'text');
}
