/**
 * pdfContextMenu.js
 * Floating context menu (popover style) for PDF text selections.
 * Allows word-level linking, highlighting, and editing directly on PDF text layers.
 */

import $ from 'jquery';
import { state } from '../state.js';
import { getCurrentPage } from './pageNav.js';
import * as annEngine from '../annotation/engine.js';
import { renderLinksTab } from './navPanel.js';
import { showToast } from './toast.js';
import { getEffectiveActiveView } from './viewController.js';
import { setTextEditMode, isTextEditMode } from './pdfTextEdit.js';

let $popover = null;
let currentSelection = null; // { text, page, rect, range }

export function initPdfContextMenu() {
    _createPopoverDOM();
    _bindSelectionListeners();
}

function _createPopoverDOM() {
    if ($('#pdf-context-popover').length) return;

    $popover = $(`
        <div id="pdf-context-popover" class="pdf-context-popover">
            <button class="pdf-ctx-btn" id="pdf-ctx-link" title="Add Hyperlink to selection">
                <iconify-icon icon="material-symbols:link"></iconify-icon> Link
            </button>
            <button class="pdf-ctx-btn" id="pdf-ctx-highlight" title="Highlight text">
                <iconify-icon icon="material-symbols:format-ink-highlighter"></iconify-icon> Highlight
            </button>
            <button class="pdf-ctx-btn" id="pdf-ctx-text" title="Edit this text in place">
                <iconify-icon icon="material-symbols:text-fields"></iconify-icon> Text
            </button>
            <button class="pdf-ctx-btn del" id="pdf-ctx-remove" title="Remove link / annotation">
                <iconify-icon icon="material-symbols:delete-outline"></iconify-icon> Clear
            </button>
        </div>
    `);

    $('body').append($popover);

    // Event handlers for popover buttons
    $popover.find('#pdf-ctx-link').on('click', (e) => {
        e.stopPropagation();
        _addLinkToSelection();
    });

    $popover.find('#pdf-ctx-highlight').on('click', (e) => {
        e.stopPropagation();
        _highlightSelection();
    });

    $popover.find('#pdf-ctx-text').on('click', (e) => {
        e.stopPropagation();
        _editSelectionText();
    });

    $popover.find('#pdf-ctx-remove').on('click', (e) => {
        e.stopPropagation();
        _clearSelectionMarks();
    });
}

function _bindSelectionListeners() {
    $(document).on('mouseup selectionchange', (e) => {
        if (getEffectiveActiveView() !== 'pdf') {
            hidePdfContextMenu();
            return;
        }

        // Delay slightly to let browser complete text selection
        setTimeout(_checkTextSelection, 20);
    });

    $(window).on('scroll resize', () => {
        hidePdfContextMenu();
    });
}

/**
 * Convert a CLIENT rect (viewport px, scroll-dependent) into DISPLAY space —
 * PDF points, origin at the page's top-left, y down.
 *
 * This is the conversion the whole annotation stack assumes and this file was
 * skipping. `getClientRects()` returns browser-viewport coordinates; the
 * annotation engine, the SVG overlay (viewBox "0 0 pageW pageH") and the PDF
 * exporter all read display space. Storing one as the other put every
 * selection-derived highlight and link at an offset that also moved with
 * scroll position.
 *
 * Reading through the wrapper's own bounding rect means the page's render
 * scale and the CSS `zoom` on .page-wrapper are both already accounted for.
 */
function _clientRectToDisplay(rect, wrapper) {
    const wr = wrapper.getBoundingClientRect();
    const pageW = parseFloat(wrapper.dataset.pageW) || wr.width;
    const pageH = parseFloat(wrapper.dataset.pageH) || wr.height;
    if (!wr.width || !wr.height) return null;
    const sx = pageW / wr.width;
    const sy = pageH / wr.height;
    return {
        x: (rect.left - wr.left) * sx,
        y: (rect.top - wr.top) * sy,
        w: rect.width * sx,
        h: rect.height * sy,
    };
}

/**
 * Split a selection into one display-space rect PER LINE, each tagged with the
 * page it fell on. getClientRects() yields a rect per line box, so a selection
 * spanning three lines produces three rects. The old code took rects[0] and
 * discarded the rest, so a multi-line highlight only ever marked its first line.
 */
function _selectionRectsByPage(range) {
    const wrappers = [...document.querySelectorAll(
        '#pdf-canvas-container .page-wrapper, #visual-diff-pdf .page-wrapper')];
    const out = [];
    for (const r of range.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const wrapper = wrappers.find(w => {
            const b = w.getBoundingClientRect();
            return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
        });
        if (!wrapper) continue;
        const disp = _clientRectToDisplay(r, wrapper);
        if (disp) out.push({ page: parseInt(wrapper.dataset.page, 10) || 1, rect: disp });
    }
    return out;
}

function _checkTextSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
        hidePdfContextMenu();
        return;
    }

    const range = sel.getRangeAt(0);
    const selectedText = sel.toString().trim();
    if (!selectedText) {
        hidePdfContextMenu();
        return;
    }

    // Ensure selection is inside #pdf-canvas-container or #visual-diff-pdf
    const pdfContainer = document.getElementById('pdf-canvas-container');
    const vdContainer = document.getElementById('visual-diff-pdf');
    const isInsidePdf = pdfContainer && pdfContainer.contains(range.commonAncestorContainer);
    const isInsideVd = vdContainer && vdContainer.contains(range.commonAncestorContainer);

    if (!isInsidePdf && !isInsideVd) {
        hidePdfContextMenu();
        return;
    }

    // Determine page wrapper
    const $pageWrapper = $(range.commonAncestorContainer).closest('.page-wrapper');
    const pageNum = parseInt($pageWrapper.attr('data-page'), 10) || getCurrentPage();

    // Compute bounding rect relative to page or viewport
    const rects = range.getClientRects();
    const primaryRect = rects.length ? rects[0] : range.getBoundingClientRect();

    currentSelection = {
        text: selectedText,
        page: pageNum,
        rect: {
            x: primaryRect.left,
            y: primaryRect.top,
            w: primaryRect.width,
            h: primaryRect.height,
        },
        clientRect: primaryRect,
        // Display-space, one entry per line box. This is what annotations and
        // links are built from; `rect` above stays client-space and is only
        // used to position the popover.
        displayRects: _selectionRectsByPage(range),
        range: range.cloneRange(),
    };

    // Position popover right above selection
    const top = primaryRect.top - 42 + window.scrollY;
    const left = primaryRect.left + (primaryRect.width / 2) - 110 + window.scrollX;

    $popover.css({
        top: `${Math.max(10, top)}px`,
        left: `${Math.max(10, left)}px`,
    }).addClass('active');
}

export function hidePdfContextMenu() {
    if ($popover) $popover.removeClass('active');
}

function _addLinkToSelection() {
    if (!currentSelection) return;

    const url = prompt(`Add Hyperlink for "${currentSelection.text}":`, 'https://');
    if (!url || !url.trim()) return;

    const cleanUrl = url.trim();
    const gxDoc = state.pdf1.gxDoc;
    if (gxDoc) {
        gxDoc.links = gxDoc.links || [];

        const isExternal = cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://') || cleanUrl.startsWith('mailto:');
        const parts = currentSelection.displayRects || [];
        if (!parts.length) {
            showToast('Could not resolve that selection to a page position.', 'error');
            hidePdfContextMenu();
            return;
        }
        // A link spanning lines needs a clickable rect PER LINE — one union
        // rect would make the whitespace between lines clickable too.
        const baseId = `link_${Date.now()}`;
        parts.forEach((p, i) => gxDoc.links.push({
            id: parts.length > 1 ? `${baseId}_${i}` : baseId,
            page: p.page,
            text: currentSelection.text,
            href: cleanUrl,
            rect: p.rect,
            isExternal,
            created: new Date().toISOString(),
        }));

        // Apply blue underline highlight on selected text node
        _applyStyleToRange(currentSelection.range, 'pdf-word-link');

        showToast(`Linked "${currentSelection.text}" to ${cleanUrl}`, 'success');
        renderLinksTab();
    }

    hidePdfContextMenu();
    window.getSelection().removeAllRanges();
}

function _highlightSelection() {
    if (!currentSelection) return;

    // One highlight per line box, in DISPLAY space. A multi-line selection is
    // several rects; a single union rect would also cover the page margins
    // between the lines.
    const parts = currentSelection.displayRects || [];
    if (!parts.length) {
        showToast('Could not resolve that selection to a page position.', 'error');
        hidePdfContextMenu();
        return;
    }
    parts.forEach(p => annEngine.addAnnotation({
        kind: 'highlight',
        page: p.page,
        rect: p.rect,
        style: { color: '#ffeb3b', opacity: 0.4 },
        text: currentSelection.text,
    }));

    _applyStyleToRange(currentSelection.range, 'pdf-word-highlight');
    showToast(`Highlighted "${currentSelection.text}"`, 'success');

    hidePdfContextMenu();
    window.getSelection().removeAllRanges();
}

/**
 * Enter Edit Text mode and drop the caret into the run the user selected.
 *
 * This used to open a `prompt()` and splice a fresh <span> into the layer. That
 * span had no `data-orig` and no geometry, so the export diff could not see it:
 * the edit showed on screen and never reached the exported PDF. Routing through
 * the real surface means one editing path, and every edit is exportable.
 */
function _editSelectionText() {
    const sel = currentSelection;
    hidePdfContextMenu();
    if (!sel) return;

    if (!isTextEditMode()) setTextEditMode(true);

    // Resolve the selection back to its owning span, then place the caret there.
    const node = sel.range?.commonAncestorContainer;
    const span = (node?.nodeType === 3 ? node.parentElement : node)?.closest?.('.pdf-text-span');

    window.getSelection().removeAllRanges();
    if (!span) {
        showToast('Edit Text mode on — click any text to edit it.', 'info');
        return;
    }
    span.focus();
    const r = document.createRange();
    r.selectNodeContents(span);
    const s2 = window.getSelection();
    s2.removeAllRanges();
    s2.addRange(r);
}

function _clearSelectionMarks() {
    if (!currentSelection) return;

    const $ancestor = $(currentSelection.range.commonAncestorContainer);
    $ancestor.find('.pdf-word-link, .pdf-word-highlight').contents().unwrap();

    showToast('Marks cleared', 'info');
    hidePdfContextMenu();
    window.getSelection().removeAllRanges();
}

function _applyStyleToRange(range, className) {
    try {
        const span = document.createElement('span');
        span.className = className;
        range.surroundContents(span);
    } catch (e) {
        // Fallback for multi-node selections
        const contents = range.extractContents();
        const span = document.createElement('span');
        span.className = className;
        span.appendChild(contents);
        range.insertNode(span);
    }
}
