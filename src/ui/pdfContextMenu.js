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
            <button class="pdf-ctx-btn" id="pdf-ctx-edit" title="Edit text">
                <iconify-icon icon="material-symbols:edit-outline"></iconify-icon> Edit
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

    $popover.find('#pdf-ctx-edit').on('click', (e) => {
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
        const linkObj = {
            id: `link_${Date.now()}`,
            page: currentSelection.page,
            text: currentSelection.text,
            href: cleanUrl,
            rect: currentSelection.rect,
            isExternal: isExternal,
            created: new Date().toISOString()
        };

        gxDoc.links.push(linkObj);

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

    // Apply vector highlight annotation
    annEngine.addAnnotation({
        kind: 'highlight',
        page: currentSelection.page,
        rect: currentSelection.rect,
        style: { color: '#ffeb3b', opacity: 0.4 },
        text: currentSelection.text
    });

    _applyStyleToRange(currentSelection.range, 'pdf-word-highlight');
    showToast(`Highlighted "${currentSelection.text}"`, 'success');

    hidePdfContextMenu();
    window.getSelection().removeAllRanges();
}

function _editSelectionText() {
    if (!currentSelection) return;

    const newText = prompt('Edit PDF text:', currentSelection.text);
    if (newText !== null && newText.trim() !== '') {
        const span = document.createElement('span');
        span.className = 'pdf-edited-text';
        span.textContent = newText.trim();

        currentSelection.range.deleteContents();
        currentSelection.range.insertNode(span);

        showToast('Text updated', 'success');
    }

    hidePdfContextMenu();
    window.getSelection().removeAllRanges();
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
