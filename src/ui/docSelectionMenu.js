/**
 * docSelectionMenu.js
 * Floating context menu (popover style) for text selections in the document
 * surfaces (#html-preview / #visual-diff-html) — the "Doc" and "Visual Diff"
 * tabs. Mirrors pdfContextMenu.js's pdf-context-popover: appears above the
 * selection as soon as text is selected, no right-click required.
 *
 * This replaces the old #ctx-menu right-click menu (contextMenu.js) for
 * text-selection actions. contextMenu.js still owns element-targeted actions
 * that have nothing to do with a text selection (insert image, edit region
 * code, center a zone) and keeps its right-click trigger for those.
 */
import $ from 'jquery';
import { pushSnapshot, syncUndoRedoUI } from './historyController.js';
import { applyHtmlEverywhere } from './htmlSync.js';
import { showToast } from './toast.js';
import { addNewHyperlink } from './navPanel.js';

const SURFACE_SEL = '#html-preview, #visual-diff-html';

let $popover = null;
let currentRange = null;

export function initDocSelectionMenu() {
    _createPopoverDOM();
    _bindSelectionListeners();
}

function _createPopoverDOM() {
    if ($('#doc-context-popover').length) return;

    $popover = $(`
        <div id="doc-context-popover" class="pdf-context-popover">
            <button class="pdf-ctx-btn" id="doc-ctx-link" title="Add hyperlink to selection">
                <iconify-icon icon="material-symbols:link"></iconify-icon> Link
            </button>
            <button class="pdf-ctx-btn" id="doc-ctx-highlight" title="Highlight text">
                <iconify-icon icon="material-symbols:format-ink-highlighter"></iconify-icon> Highlight
            </button>
            <button class="pdf-ctx-btn del" id="doc-ctx-clear" title="Clear link / highlight">
                <iconify-icon icon="material-symbols:delete-outline"></iconify-icon> Clear
            </button>
        </div>
    `);

    $('body').append($popover);

    $popover.find('#doc-ctx-link').on('click', (e) => {
        e.stopPropagation();
        hidePopover();
        // addNewHyperlink() reads window.getSelection() itself and captures
        // its own range before awaiting the URL prompt (see navPanel.js) —
        // no need to pass currentRange through, just don't clear the
        // selection out from under it.
        addNewHyperlink();
    });

    $popover.find('#doc-ctx-highlight').on('click', (e) => {
        e.stopPropagation();
        _highlightSelection();
    });

    $popover.find('#doc-ctx-clear').on('click', (e) => {
        e.stopPropagation();
        _clearSelectionMarks();
    });
}

function _bindSelectionListeners() {
    $(document).on('mouseup selectionchange', () => {
        setTimeout(_checkTextSelection, 20);
    });

    $(window).on('scroll resize', hidePopover);
}

function _checkTextSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
        hidePopover();
        return;
    }

    const range = sel.getRangeAt(0);
    const text = sel.toString().trim();
    if (!text) {
        hidePopover();
        return;
    }

    const surface = $(range.commonAncestorContainer).closest(SURFACE_SEL);
    if (!surface.length) {
        hidePopover();
        return;
    }

    currentRange = range.cloneRange();

    const rects = range.getClientRects();
    const primaryRect = rects.length ? rects[0] : range.getBoundingClientRect();
    const top = primaryRect.top - 42 + window.scrollY;
    const left = primaryRect.left + (primaryRect.width / 2) - 90 + window.scrollX;

    $popover.css({
        top: `${Math.max(10, top)}px`,
        left: `${Math.max(10, left)}px`,
    }).addClass('active');
}

export function hidePopover() {
    if ($popover) $popover.removeClass('active');
}

function _surfaceFromRange(range) {
    let node = range.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    return node?.closest?.(SURFACE_SEL) || null;
}

function _highlightSelection() {
    const range = currentRange;
    if (!range) return;
    const surface = _surfaceFromRange(range);
    if (!surface) { hidePopover(); return; }

    pushSnapshot();

    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    document.execCommand('styleWithCSS', false, true);
    document.execCommand('hiliteColor', false, '#ffeb3b');
    document.execCommand('styleWithCSS', false, false);

    showToast('Highlighted selection', 'success');
    applyHtmlEverywhere(surface.innerHTML, surface);
    syncUndoRedoUI();
    hidePopover();
}

function _clearSelectionMarks() {
    const range = currentRange;
    if (!range) return;
    const surface = _surfaceFromRange(range);
    if (!surface) { hidePopover(); return; }

    pushSnapshot();

    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    document.execCommand('styleWithCSS', false, true);
    document.execCommand('hiliteColor', false, 'transparent');
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('unlink', false);

    showToast('Marks cleared', 'info');
    applyHtmlEverywhere(surface.innerHTML, surface);
    syncUndoRedoUI();
    hidePopover();
    window.getSelection().removeAllRanges();
}
