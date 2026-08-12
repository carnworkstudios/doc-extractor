/**
 * pageNav.js
 * Page navigation (prev/next/jump/counter) and formatting toolbar handlers.
 */

import $ from 'jquery';
import { state } from '../state.js';
import { setPDFZoom, getPDFZoom, fitPDFWidth } from './pdfCanvas.js';
import { getActivePDFTarget } from './pdfEditMode.js';
import { getVisualDiffFocusedTarget } from './visualDiff.js';
import { pushSnapshot, syncUndoRedoUI } from './historyController.js';
import { applyHtmlEverywhere } from './htmlSync.js';
import { showToast } from './toast.js';

let _totalPages = 0;
let _currentPage = 1;
let _pageWrappers = [];
let _paintedStyle = null;
let _hiliteColor = '#ffff00';
let _fontColor = '#111111';

// Word-style highlight palette (16) and a text color palette (18, 6-col grid).
const HIGHLIGHT_COLORS = [
    '#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#0000ff', '#ff0000',
    '#008000', '#ffa500', '#800080', '#000080', '#808000', '#66ccff',
    '#7f7f7f', '#cccccc', '#ffe0b3', '#f4cccc'
];
const FONT_COLORS = [
    '#111111', '#333333', '#555555', '#777777', '#999999', '#bbbbbb',
    '#dddddd', '#ffffff', '#cc0000', '#ff4d00', '#ffaa00', '#ffd400',
    '#4caf50', '#00bcd4', '#1565c0', '#7b1fa2', '#d81b60', '#8d6e63'
];

export function initToolbar() {
    $('#btn-bold').on('click', () => fmt('bold'));
    $('#btn-italic').on('click', () => fmt('italic'));
    $('#btn-underline').on('click', () => fmt('underline'));
    $('#btn-superscript').on('click', () => fmt('superscript'));
    $('#btn-subscript').on('click', () => fmt('subscript'));
    $('#btn-highlight').on('click', () => fmtColor('hiliteColor', _hiliteColor));
    $('#btn-font-color').on('click', () => fmtColor('foreColor', _fontColor));
    $('#btn-border').on('click', toggleParagraphBorder);

    initColorSplitDropdown('#dd-highlight', 'hiliteColor');
    initColorSplitDropdown('#dd-font-color', 'foreColor');
    buildColorMenus();
    $('#btn-ul').on('click', () => fmt('insertUnorderedList'));
    $('#btn-ol').on('click', () => fmt('insertOrderedList'));
    $('#btn-dl').on('click', insertDefinitionList);

    $('#btn-indent').on('click', increaseIndent);
    $('#btn-outdent').on('click', decreaseIndent);

    initSplitDropdown('#dd-bullets', 'insertUnorderedList');
    initSplitDropdown('#dd-numbering', 'insertOrderedList');

    $('#sel-font-family').on('change', function() {
        const v = $(this).val();
        if (v) fmt('fontName', v);
        $(this).val('');
    });
    $('#sel-font-size').on('change', function() {
        const v = $(this).val();
        if (v) fmt('fontSize', v);
        $(this).val('');
    });

    $('#btn-format-painter').on('click', toggleFormatPainter);

    $('#sel-block').on('change', function() {
        const v = $(this).val();
        fmt('formatBlock', v || 'p');
        $(this).val('');
    });

    $('#btn-align-left').on('click',    () => fmt('justifyLeft'));
    $('#btn-align-center').on('click',  () => fmt('justifyCenter'));
    $('#btn-align-right').on('click',   () => fmt('justifyRight'));
    $('#btn-align-justify').on('click', () => fmt('justifyFull'));

    $('#btn-dist-h').on('click', () => distributeChildren('row'));
    $('#btn-dist-v').on('click', () => distributeChildren('column'));

    initColumnSplitDropdown();
    initDocTextDragMove();

    $('#btn-add-page').on('click', addEditorPage);
    $('#btn-insert-box').on('click', insertBox);

    $('#btn-zoom-in').on('click',  () => bumpZoom(+0.1));
    $('#btn-zoom-out').on('click', () => bumpZoom(-0.1));
    $('#btn-zoom-fit').on('click', () => { fitPDFWidth(); refreshZoomLabel(); });
    refreshZoomLabel();

    $('#btn-prev-page').on('click', prevPage);
    $('#btn-next-page').on('click', nextPage);
    $('#page-jump').on('change', function() { jumpToPage(+$(this).val()); });

    document.addEventListener('selectionchange', syncToolbarToSelection);
}

const EDITABLE_SURFACE_SEL = '#html-preview, #visual-diff-html, .editable-text-layer';

const FONT_SIZE_PX_TO_LEGACY = [
    [10, '1'], [13, '2'], [16, '3'], [18, '4'], [24, '5'], [32, '6'], [48, '7']
];

/**
 * Push the current #html-preview content to state + Monaco + the mirrored
 * Visual Diff surface. Needed after any manual DOM mutation that doesn't
 * go through document.execCommand — appendChild/before/remove/insertNode
 * don't fire a native 'input' event, so htmlSync.js's wirePreview() listener
 * (which is what normally keeps every tab/export in sync) never sees these
 * edits. Every toolbar action that moves nodes around by hand must call
 * this after mutating, mirroring what typing or execCommand gets for free.
 */
function syncStructuralEdit() {
    const el = document.getElementById('html-preview');
    if (el) applyHtmlEverywhere(el.innerHTML, el);
}

/**
 * Reflect the current selection's formatting onto the toolbar — Word-style
 * "the toolbar always shows what's true of what's selected". Runs on every
 * selectionchange while the caret/selection sits inside one of the editable
 * surfaces; no-ops (and clears active states) otherwise so stale state from
 * a previous surface doesn't linger after the user clicks away.
 */
function syncToolbarToSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;

    let node = sel.getRangeAt(0).commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;

    const surface = node?.closest?.(EDITABLE_SURFACE_SEL);
    if (!surface) {
        $('#btn-bold, #btn-italic, #btn-underline, #btn-superscript, #btn-subscript').removeClass('active');
        $('#btn-highlight, #btn-font-color, #btn-border').removeClass('active');
        setActiveAlign('left');
        return;
    }

    $('#btn-bold').toggleClass('active', document.queryCommandState('bold'));
    $('#btn-italic').toggleClass('active', document.queryCommandState('italic'));
    $('#btn-underline').toggleClass('active', document.queryCommandState('underline'));
    $('#btn-superscript').toggleClass('active', document.queryCommandState('superscript'));
    $('#btn-subscript').toggleClass('active', document.queryCommandState('subscript'));

    // Highlight / font color / border are read by walking the inline ancestors
    // of the caret — computed style on a bare <p> is transparent by default,
    // so a non-transparent background-color or a non-default color on any
    // inline element counts as "formatted". queryCommandState can't see these.
    const defaultColor = (getComputedStyle(document.body).color || '').toLowerCase();
    let highlighted = false;
    let colored = false;
    let el = node;
    while (el && el !== surface) {
        const tag = el.tagName?.toLowerCase();
        if (['span', 'mark', 'b', 'strong', 'i', 'em', 'u', 'a', 'sup', 'sub'].includes(tag)) {
            const inline = getComputedStyle(el);
            if (!isTransparent(inline.backgroundColor)) highlighted = true;
            if ((inline.color || '').toLowerCase() !== defaultColor) colored = true;
            if (highlighted && colored) break;
        }
        el = el.parentElement;
    }
    $('#btn-highlight').toggleClass('active', highlighted);
    $('#btn-font-color').toggleClass('active', colored);
    $('#btn-border').toggleClass('active', !!node.closest?.('[data-par-border]'));

    if (document.queryCommandState('justifyCenter')) {
        setActiveAlign('center');
    } else if (document.queryCommandState('justifyRight')) {
        setActiveAlign('right');
    } else if (document.queryCommandState('justifyFull')) {
        setActiveAlign('justify');
    } else {
        setActiveAlign('left');
    }

    const cs = window.getComputedStyle(node);
    const $family = $('#sel-font-family');
    if (!$family.is(':focus')) {
        const match = [...$family[0].options].find(o =>
            o.value && cs.fontFamily.split(',')[0].replace(/["']/g, '').trim().toLowerCase() ===
                       o.value.split(',')[0].replace(/["']/g, '').trim().toLowerCase()
        );
        $family.val(match ? match.value : '');
    }

    const $size = $('#sel-font-size');
    if (!$size.is(':focus')) {
        const px = Math.round(parseFloat(cs.fontSize));
        let closest = FONT_SIZE_PX_TO_LEGACY[0];
        for (const pair of FONT_SIZE_PX_TO_LEGACY) {
            if (Math.abs(pair[0] - px) < Math.abs(closest[0] - px)) closest = pair;
        }
        $size.val(closest[1]);
    }

    const $block = $('#sel-block');
    if ($block.length && !$block.is(':focus')) {
        const blockEl = node?.closest?.('h1, h2, h3, h4, p, div');
        const tag = blockEl?.tagName?.toLowerCase();
        $block.val(['h1', 'h2', 'h3', 'h4'].includes(tag) ? tag : '');
    }
}

function setActiveAlign(which) {
    $('#btn-align-left, #btn-align-center, #btn-align-right, #btn-align-justify').removeClass('active');
    $(`#btn-align-${which}`).addClass('active');
}

/**
 * Route a document.execCommand call to the correct editable surface.
 * In pdf view → focus the active .editable-text-layer.
 * In visual-diff → focus the tracked pane (pdf overlay or html).
 * Elsewhere → standard behaviour (currently focused element).
 */
function fmt(cmd, val) {
    const view = state.activeView;
    if (view === 'pdf') {
        const target = getActivePDFTarget();
        if (target) target.focus();
    } else if (view === 'visual-diff') {
        const target = getVisualDiffFocusedTarget();
        if (target) target.focus();
    }
    document.execCommand(cmd, false, val || null);
}

/**
 * Apply a text color / highlight via execCommand, forcing inline styles.
 * styleWithCSS makes foreColor/hiliteColor emit `color:`/`background-color:`
 * styles instead of <font> tags; it is toggled back right away so bold/italic
 * keep producing <strong>/<em>, which the gx-doc IR reads (htmlToGxDoc).
 */
function fmtColor(cmd, color) {
    const view = state.activeView;
    if (view === 'pdf') {
        const target = getActivePDFTarget();
        if (target) target.focus();
    } else if (view === 'visual-diff') {
        const target = getVisualDiffFocusedTarget();
        if (target) target.focus();
    }
    document.execCommand('styleWithCSS', false, true);
    document.execCommand(cmd, false, color);
    document.execCommand('styleWithCSS', false, false);
}

/**
 * Fill the color swatch grids declared in the toolbar markup
 * (<div class="color-swatch-grid" data-color-grid="hiliteColor|foreColor">).
 * The palette lives here, in one place, not in four index.html copies.
 */
function buildColorMenus() {
    document.querySelectorAll('.color-swatch-grid[data-color-grid]').forEach(grid => {
        const cmd = grid.dataset.colorGrid;
        const palette = cmd === 'hiliteColor' ? HIGHLIGHT_COLORS : FONT_COLORS;
        const frag = document.createDocumentFragment();
        palette.forEach(hex => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'color-swatch';
            b.dataset.color = hex;
            b.style.background = hex;
            b.title = hex;
            frag.appendChild(b);
        });
        const custom = document.createElement('label');
        custom.className = 'color-swatch color-swatch--custom';
        custom.title = 'Custom color\u2026';
        const input = document.createElement('input');
        input.type = 'color';
        input.value = cmd === 'hiliteColor' ? _hiliteColor : _fontColor;
        custom.appendChild(input);
        frag.appendChild(custom);
        grid.appendChild(frag);
    });
}

/**
 * Wire a color split-button (highlight / font color). Same positioning
 * strategy as initSplitDropdown — the menu is positioned fixed on open so it
 * escapes the ribbon's horizontal scroll clipping.
 */
function initColorSplitDropdown(rootSelector, cmd) {
    const $root = $(rootSelector);
    const $caret = $root.find('.split-btn-caret');
    const $menu = $root.find('.dropdown-menu');
    if (!$root.length || !$caret.length || !$menu.length) return;

    $caret.on('click', (e) => {
        e.stopPropagation();
        const isOpen = $root.hasClass('open');
        $('.dropdown.open').removeClass('open');
        if (!isOpen) {
            const rect = $caret[0].getBoundingClientRect();
            $menu.css({ top: rect.bottom + 4 + 'px', left: rect.left + 'px' });
            $root.addClass('open');
        }
    });

    $(document).on('click', () => $root.removeClass('open'));

    $menu.on('click', '.color-swatch', function(e) {
        e.stopPropagation();
        const hex = $(this).data('color');
        if (hex) {
            if (cmd === 'hiliteColor') _hiliteColor = hex;
            else _fontColor = hex;
            fmtColor(cmd, hex);
        }
        $root.removeClass('open');
    });

    $menu.on('change', 'input[type="color"]', function(e) {
        e.stopPropagation();
        const hex = this.value;
        if (cmd === 'hiliteColor') _hiliteColor = hex;
        else _fontColor = hex;
        fmtColor(cmd, hex);
        $root.removeClass('open');
    });

    if (cmd === 'hiliteColor') {
        $menu.on('click', '[data-clear-highlight]', (e) => {
            e.stopPropagation();
            removeHighlight();
            $root.removeClass('open');
        });
    }
}

/**
 * Remove highlight from the selection. execCommand('hiliteColor','transparent')
 * clears the marker but leaves `background-color: transparent` inline spans in
 * Chromium — strip those so the DOM stays clean for the IR/exporters.
 */
function removeHighlight() {
    const view = state.activeView;
    let target = null;
    if (view === 'pdf') target = getActivePDFTarget();
    else if (view === 'visual-diff') target = getVisualDiffFocusedTarget();
    if (target) target.focus();

    document.execCommand('styleWithCSS', false, true);
    document.execCommand('hiliteColor', false, 'transparent');
    document.execCommand('styleWithCSS', false, false);

    const sel = window.getSelection();
    if (sel?.rangeCount) {
        let root = sel.getRangeAt(0).commonAncestorContainer;
        if (root.nodeType === Node.TEXT_NODE) root = root.parentElement;
        const scope = root?.closest?.(EDITABLE_SURFACE_SEL) || root;
        scope?.querySelectorAll?.('[style]').forEach(el => {
            const bg = (el.style && el.style.backgroundColor) || '';
            if (/^(transparent|rgba?\(\s*0,\s*0,\s*0,\s*0\s*\))$/i.test(bg)) {
                el.style.removeProperty('background-color');
            }
            if (el.getAttribute && !el.getAttribute('style')) el.removeAttribute('style');
        });
        syncStructuralEditFromSurface(scope);
    }
}

const BLOCK_TAGS = new Set(['p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'aside', 'dl', 'dt', 'dd']);
const BORDER_SKIP = '.prose-area, .pdf-doc, .pdf-page-content, .pdf-page-row, .pdf-col, .pdf-table-wrap, .pdf-list-wrap, .pdf-col-split, .pdf-region, .f1, .f2, .ta-l, .ta-c, .ta-r, .ta-j';

/** Nearest block worth drawing a border around (paragraph, heading, list item, callout/box, bare div). */
function nearestBorderBlock(node) {
    let el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const surface = el?.closest?.(EDITABLE_SURFACE_SEL) || null;

    while (el && el !== document.body) {
        const tag = el.tagName?.toLowerCase();
        if (BLOCK_TAGS.has(tag)) return el;
        if (tag === 'div' && !el.matches?.(BORDER_SKIP)) return el;
        // A full-document selection puts the common ancestor on the surface
        // itself (or on a structural wrapper like .pdf-page-content). Climbing
        // past the surface means "nothing to border", so instead descend to
        // the first real block inside it.
        if (el === surface && surface) {
            return surface.querySelector('p, li, h1, h2, h3, h4, h5, h6, aside, blockquote, dl, dt, dd') || null;
        }
        el = el.parentElement;
    }
    return null;
}

/**
 * Word-style paragraph / box border: draw a border box around the closest
 * block of the selection; clicking again removes it. Uses inline styles so it
 * travels with HTML/DOC export, and a data-par-border marker for the toggle
 * state + toolbar active state.
 */
function toggleParagraphBorder() {
    const sel = window.getSelection();
    let node = sel?.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;

    const surface = node?.closest?.(EDITABLE_SURFACE_SEL);
    if (!surface) {
        showToast('Place the cursor in a paragraph or box to add a border.', 'error');
        return;
    }
    const block = nearestBorderBlock(node);
    if (!block) {
        showToast('Nothing to border here.', 'error');
        return;
    }

    pushSnapshot();

    if (block.dataset.parBorder === '1') {
        block.style.border = '';
        block.style.padding = '';
        block.style.borderRadius = '';
        delete block.dataset.parBorder;
    } else {
        block.style.border = '1.5px solid #666';
        block.style.padding = '6px 10px';
        block.style.borderRadius = '3px';
        block.dataset.parBorder = '1';
    }

    syncStructuralEditFromSurface(surface);
    syncUndoRedoUI();
}

/**
 * Push a manual DOM edit to state + every surface. Only the real document
 * surfaces (#html-preview / #visual-diff-html) may be pushed — .editable-text-
 * layer is a per-page PDF overlay, not the document, and its innerHTML has no
 * page structure, so pushing it would corrupt state.pdf1.extractedHTML.
 */
function syncStructuralEditFromSurface(surface) {
    if (surface && surface.matches('#html-preview, #visual-diff-html')) {
        applyHtmlEverywhere(surface.innerHTML, surface);
    }
}

/** True when a computed color string means "no background set". */
function isTransparent(color) {
    if (!color) return true;
    return /^(transparent|rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|initial|inherit)$/i.test(color.trim());
}

/**
 * Increase/decrease indent. Inside a list item, defer to execCommand
 * ('indent'/'outdent'), which does real <ul>/<ol> nesting there. Everywhere
 * else (plain paragraphs, headings), execCommand('indent') is a no-op in
 * most browsers — there's no block to indent into — so instead insert or
 * strip a literal tab character (\t, the same byte a TSV parser splits on)
 * at the start of the current line.
 *
 * A raw \t text node renders as a single collapsed space under normal HTML
 * whitespace rules, so the tab is wrapped in a <span class="tab-char"> with
 * white-space: pre (src/styles.css) to actually show as a gap — without
 * switching the whole block to pre-wrap and affecting line-wrapping.
 */
function increaseIndent() {
    const sel = window.getSelection();
    let node = sel?.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;

    if (node?.closest?.('li')) {
        fmt('indent');
        return;
    }
    if (!sel?.rangeCount) return;

    const range = sel.getRangeAt(0);
    const tabSpan = document.createElement('span');
    tabSpan.className = 'tab-char';
    tabSpan.textContent = '\t';
    range.collapse(true);
    range.insertNode(tabSpan);

    const r = document.createRange();
    r.setStartAfter(tabSpan);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);

    syncStructuralEdit();
}

function decreaseIndent() {
    const sel = window.getSelection();
    let node = sel?.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;

    if (node?.closest?.('li')) {
        fmt('outdent');
        return;
    }

    const block = node?.closest?.('p, div, h1, h2, h3, h4');
    if (!block) return;

    // Skip leading empty text nodes (range.insertNode can leave a stray ""
    // text node before the inserted span) to find the real first token.
    let firstChild = block.firstChild;
    while (firstChild?.nodeType === Node.TEXT_NODE && firstChild.textContent === '') {
        firstChild = firstChild.nextSibling;
    }

    if (firstChild?.nodeType === Node.ELEMENT_NODE && firstChild.classList?.contains('tab-char')) {
        firstChild.remove();
        syncStructuralEdit();
        return;
    }
    if (firstChild?.nodeType === Node.TEXT_NODE && firstChild.textContent.startsWith('\t')) {
        firstChild.textContent = firstChild.textContent.slice(1);
        syncStructuralEdit();
    }
}

/**
 * Wire a split-button dropdown (bullet/numbering style menu). The main button
 * (already handled by btn-ul/btn-ol click handlers) inserts the list with the
 * browser default marker; the caret opens a menu of list-style-type options
 * that apply to the list ancestor of the current selection, converting plain
 * text to a list first via execCommand if the caret isn't in one yet.
 *
 * The menu is positioned fixed to the viewport (computed from the caret's
 * bounding rect on open) rather than absolute within .split-btn — the ribbon
 * bar scrolls horizontally (overflow-x: auto), and an absolutely-positioned
 * descendant would get clipped by that scroll container. This mirrors
 * exportController.js's #export-dropdown positioning.
 *
 * The selection is captured (cloned) on caret-open, same as
 * initColumnSplitDropdown below. Clicking the caret button, then a menu item,
 * is two clicks on non-editable buttons; by the time the item click fires,
 * focus has moved off the editable surface and window.getSelection() no
 * longer points at the text the user picked — so re-reading it at click time
 * (the previous behavior) silently applied the list style to nothing.
 */
function initSplitDropdown(rootSelector, insertCmd) {
    const $root = $(rootSelector);
    const $caret = $root.find('.split-btn-caret');
    const $menu = $root.find('.dropdown-menu');

    let capturedRange = null;

    $caret.on('click', (e) => {
        e.stopPropagation();
        const isOpen = $root.hasClass('open');
        $('.dropdown.open').removeClass('open');

        if (!isOpen) {
            const sel = window.getSelection();
            capturedRange = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;

            const rect = $caret[0].getBoundingClientRect();
            $menu.css({ top: rect.bottom + 4 + 'px', left: rect.left + 'px' });
            $root.addClass('open');
        }
    });

    $(document).on('click', () => $root.removeClass('open'));

    $menu.on('click', '.dropdown-item', function(e) {
        e.stopPropagation();
        const styleType = $(this).data('list-style');
        applyListStyle(insertCmd, styleType, capturedRange);
        $root.removeClass('open');
    });
}

function applyListStyle(insertCmd, styleType, capturedRange) {
    if (capturedRange) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(capturedRange);
    }

    const sel = window.getSelection();
    let node = sel?.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;

    let list = node?.closest?.('ul, ol');
    if (!list) {
        fmt(insertCmd);
        const sel2 = window.getSelection();
        let node2 = sel2?.rangeCount ? sel2.getRangeAt(0).commonAncestorContainer : null;
        if (node2 && node2.nodeType === Node.TEXT_NODE) node2 = node2.parentElement;
        list = node2?.closest?.('ul, ol');
    }
    if (!list) {
        showToast('Select text to turn into a list first.', 'error');
        return;
    }
    list.style.listStyleType = styleType;
    syncStructuralEdit();
}

/**
 * Wire the Columns split-button. Unlike the bullet/numbering dropdowns,
 * this needs the actual Range object (not just an anchor node) to know the
 * full extent of the user's selection, and a Range can be invalidated by
 * DOM mutations that happen between opening the menu and clicking an item
 * (e.g. focus/blur normalizing whitespace). So the Range is cloned and
 * stashed on open, then consumed on item click, rather than re-reading
 * window.getSelection() at click time the way applyListStyle() does.
 */
let _columnSplitRange = null;

function initColumnSplitDropdown() {
    const $root = $('#dd-columns');
    const $caret = $root.find('.split-btn-caret');
    const $menu = $root.find('.dropdown-menu');

    // Shared by the plain button and the caret dropdown: whichever the user
    // clicks, the range in effect at that exact click needs to be captured
    // right then, before focus moves to the button and window.getSelection()
    // stops pointing at the text the user chose.
    function captureColumnSplitRange() {
        const sel = window.getSelection();
        _columnSplitRange = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    }

    // Previously this read `_columnSplitRange` without ever setting it —
    // that variable was only assigned inside the caret's click handler below,
    // so clicking the plain "Columns" button directly (the default 2-column
    // split, without opening the style menu first) always split against
    // whatever range was captured by a previous caret click, or null on
    // first use. Capture fresh here so the direct click works on its own.
    $('#btn-columns').on('click', () => {
        captureColumnSplitRange();
        applyColumnSplit(2);
    });

    $caret.on('click', (e) => {
        e.stopPropagation();
        const isOpen = $root.hasClass('open');
        $('.dropdown.open').removeClass('open');

        if (!isOpen) {
            captureColumnSplitRange();

            const rect = $caret[0].getBoundingClientRect();
            $menu.css({ top: rect.bottom + 4 + 'px', left: rect.left + 'px' });
            $root.addClass('open');
        }
    });

    $(document).on('click', () => $root.removeClass('open'));

    $menu.on('click', '.dropdown-item', function(e) {
        e.stopPropagation();
        applyColumnSplit(parseInt($(this).data('cols'), 10));
        $root.removeClass('open');
    });
}

/**
 * Split the selected top-level blocks into N columns, newspaper-style:
 * the first ceil(count/N) blocks fill column 1 top-to-bottom, the next
 * chunk fills column 2, and so on — not round-robin. .pdf-box callouts and
 * tables are treated as single atomic blocks (never split internally) and
 * counted the same as a <p> when dividing into chunks.
 *
 * "Top-level" here means the selection's actual shared parent — e.g. three
 * sibling <p>s selected inside a PDF-extracted <div class="f2 ta-l"> region
 * (pageAssembler.js's per-region text wrapper) — not always the page
 * section. Range.commonAncestorContainer already gives us exactly that
 * shared parent, so we walk its children rather than assuming
 * .pdf-page-content is always the direct parent of what got selected.
 *
 * cols=1 means "remove columns": if the selection is inside an existing
 * .pdf-col-split, unwrap it back to flat sibling blocks in original order.
 */
function applyColumnSplit(cols) {
    const range = _columnSplitRange;
    if (!range) {
        showToast('Select some content first, then choose a column count.', 'error');
        return;
    }

    let node = range.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;

    const surface = node?.closest?.(EDITABLE_SURFACE_SEL);
    if (!surface) {
        showToast('Column split only works inside the document text.', 'error');
        return;
    }

    if (cols === 1) {
        removeColumnSplit(node);
        return;
    }

    // node is the selection's nearest element ancestor; its own children
    // (if 2+) are the split candidates. If the selection sits inside a
    // single leaf element with no siblings in range (e.g. the caret is in
    // one <p> with no selection breadth), fall back to that element's
    // parent so a single fully-selected block can still be split
    // alongside its siblings.
    let container = node;
    if (container.nodeType !== Node.ELEMENT_NODE) container = surface;

    const candidateOf = (el) => [...el.children].filter(c => !c.classList.contains('page-label'));
    let topBlocks = candidateOf(container);
    let selected = topBlocks.filter(el => range.intersectsNode(el));

    if (selected.length < 2 && container.parentElement && container !== surface) {
        container = container.parentElement;
        topBlocks = candidateOf(container);
        selected = topBlocks.filter(el => range.intersectsNode(el));
    }

    if (selected.length === 0) {
        showToast('No content found in the selection to split.', 'error');
        return;
    }
    if (selected.length === 1) {
        showToast('Select more than one paragraph/block — a single element can\'t be split into columns.', 'error');
        return;
    }
    if (selected.length < cols) {
        showToast(`Only ${selected.length} block${selected.length > 1 ? 's' : ''} selected — can't fill ${cols} columns.`, 'error');
        return;
    }

    pushSnapshot();

    const chunkSize = Math.ceil(selected.length / cols);
    const chunks = Array.from({ length: cols }, (_, i) =>
        selected.slice(i * chunkSize, (i + 1) * chunkSize)
    );

    const splitEl = document.createElement('div');
    splitEl.className = `pdf-col-split pdf-page-row pdf-page-row--cols-${cols}`;

    // Anchor the new container at the first selected block's position
    // before moving any blocks (moving selected[0] first would lose its
    // original slot in the DOM).
    selected[0].before(splitEl);

    chunks.forEach(chunk => {
        const colEl = document.createElement('div');
        colEl.className = 'pdf-col';
        chunk.forEach(block => colEl.appendChild(block));
        splitEl.appendChild(colEl);
    });

    syncStructuralEdit();
    syncUndoRedoUI();
}

/**
 * Unwrap a .pdf-col-split back into flat sibling blocks in original
 * (reading) order — column 1's blocks first, then column 2's, etc.
 */
function removeColumnSplit(node) {
    const splitEl = node.closest('.pdf-col-split');
    if (!splitEl) {
        showToast('Selection isn\'t inside a column split.', 'error');
        return;
    }

    pushSnapshot();

    const blocks = [...splitEl.querySelectorAll(':scope > .pdf-col')]
        .flatMap(col => [...col.children]);
    blocks.forEach(block => splitEl.before(block));
    splitEl.remove();
    syncStructuralEdit();
    syncUndoRedoUI();
}

/**
 * Re-implement drag-and-drop of a selected text range inside the document
 * surfaces. A contenteditable makes this work natively with zero code in a
 * normal browser tab — select text, drag it, drop it elsewhere — but the
 * native OS-level drag session that gesture relies on does not reliably
 * complete inside the VS Code webview: dragstart fires, the drop target sees
 * dragover, but nothing is ever inserted. selectionMode.js's region-reorder
 * drag (plain dragstart/dragover/drop on elements with draggable="true")
 * already works in this same webview, so driving the move explicitly over
 * those same event types — rather than depending on the browser's built-in
 * text-selection-drag internals — sidesteps whatever part of it the webview
 * host swallows, and behaves identically to native drag in a normal tab.
 */
let _textDragRange = null;

function initDocTextDragMove() {
    document.addEventListener('dragstart', (e) => {
        const surface = e.target.closest?.(EDITABLE_SURFACE_SEL);
        if (!surface) return;

        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        // Only take over drags that start from inside the current text
        // selection — anything else (an image, a link) is a different kind
        // of native drag and should be left alone.
        if (!range.intersectsNode(e.target)) return;

        _textDragRange = range.cloneRange();
        e.dataTransfer.setData('text/plain', sel.toString());
        e.dataTransfer.effectAllowed = 'move';
    });

    document.addEventListener('dragover', (e) => {
        if (!_textDragRange) return;
        if (!e.target.closest?.(EDITABLE_SURFACE_SEL)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    });

    document.addEventListener('drop', (e) => {
        if (!_textDragRange) return;
        const surface = e.target.closest?.(EDITABLE_SURFACE_SEL);
        const range = _textDragRange;
        _textDragRange = null;
        if (!surface) return;
        e.preventDefault();

        const dropRange = document.caretRangeFromPoint?.(e.clientX, e.clientY);
        if (!dropRange) return;
        // Dropped back inside (or right at the edge of) the source
        // selection — nothing to do.
        if (range.comparePoint(dropRange.startContainer, dropRange.startOffset) === 0 ||
            (range.intersectsNode(dropRange.startContainer) &&
             range.isPointInRange(dropRange.startContainer, dropRange.startOffset))) {
            return;
        }

        pushSnapshot();

        const fragment = range.extractContents();
        dropRange.insertNode(fragment);

        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(dropRange);

        syncStructuralEditFromSurface(surface);
        syncUndoRedoUI();
    });

    document.addEventListener('dragend', () => { _textDragRange = null; });
}

/**
 * Insert a <dl> (definition list) with one starter term/description pair
 * as a block-level sibling of the current block. HTML natively supports
 * dl/dt/dd — Word's ribbon has no equivalent, so this is exposed as its own
 * button rather than folded into the bullet/numbering split-buttons.
 *
 * Inserted after the caret's containing block (not via range.insertNode at
 * the raw caret position) so a <dl> never lands nested inside a <p> — a <dl>
 * is a block element and contenteditable/execCommand don't guard against
 * block-in-inline placement themselves.
 */
function insertDefinitionList() {
    const view = state.activeView;
    let $surface;
    if (view === 'html') $surface = $('#html-preview');
    else if (view === 'visual-diff') $surface = $('#visual-diff-html');
    if (!$surface?.length) {
        showToast('Switch to the Doc or Visual Diff tab to insert a definition list.', 'error');
        return;
    }

    pushSnapshot();

    const dl = document.createElement('dl');
    dl.innerHTML = '<dt>Term</dt><dd>Description</dd>';

    const sel = window.getSelection();
    let node = sel?.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const currentBlock = node && $surface[0].contains(node)
        ? node.closest('p, div, li, h1, h2, h3, h4, dl')
        : null;

    if (currentBlock && currentBlock.parentElement) {
        currentBlock.after(dl);
    } else {
        $surface.append(dl);
    }

    const r = document.createRange();
    r.selectNodeContents(dl.querySelector('dt'));
    sel.removeAllRanges();
    sel.addRange(r);
    syncStructuralEdit();
    syncUndoRedoUI();
}

/**
 * Format Painter — Office-style "copy formatting, click target to apply".
 * First click: capture computed style of the current selection's anchor node,
 * arm the painter (cursor + active button state), and listen for the next
 * selection change on the active editable surface. Second interaction:
 * apply the captured font/weight/style/decoration/alignment to the new
 * selection via execCommand, then disarm.
 */
function toggleFormatPainter() {
    const $btn = $('#btn-format-painter');
    if ($btn.hasClass('painting')) {
        disarmFormatPainter();
        return;
    }

    const sel = window.getSelection();
    let node = sel?.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!node) {
        showToast('Place your cursor in some text to copy its formatting.', 'error');
        return;
    }

    const cs = window.getComputedStyle(node);
    _paintedStyle = {
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        textDecorationLine: cs.textDecorationLine,
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        textAlign: cs.textAlign,
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        superscript: !!node.closest('sup'),
        subscript: !!node.closest('sub')
    };

    $btn.addClass('painting');
    document.body.classList.add('format-painter-active');
    document.addEventListener('mouseup', applyFormatPainterOnce, { once: true });
}

function applyFormatPainterOnce() {
    if (!_paintedStyle) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
        showToast('Format Painter needs a text selection to apply to.', 'error');
        disarmFormatPainter();
        return;
    }

    const range = sel.getRangeAt(0);
    const span = document.createElement('span');
    span.style.fontWeight = _paintedStyle.fontWeight;
    span.style.fontStyle = _paintedStyle.fontStyle;
    span.style.textDecorationLine = _paintedStyle.textDecorationLine;
    span.style.fontFamily = _paintedStyle.fontFamily;
    span.style.fontSize = _paintedStyle.fontSize;
    span.style.color = _paintedStyle.color;
    if (!isTransparent(_paintedStyle.backgroundColor)) {
        span.style.backgroundColor = _paintedStyle.backgroundColor;
    }
    try {
        range.surroundContents(span);
    } catch {
        span.appendChild(range.extractContents());
        range.insertNode(span);
    }

    let block = span.closest('p, div, li, h1, h2, h3, h4, h5, h6');
    if (block) block.style.textAlign = _paintedStyle.textAlign;

    if (_paintedStyle.superscript) {
        const sup = document.createElement('sup');
        span.parentNode.insertBefore(sup, span);
        sup.appendChild(span);
    } else if (_paintedStyle.subscript) {
        const sub = document.createElement('sub');
        span.parentNode.insertBefore(sub, span);
        sub.appendChild(span);
    }

    syncStructuralEditFromSurface(span.closest(EDITABLE_SURFACE_SEL));
    disarmFormatPainter();
}

function disarmFormatPainter() {
    _paintedStyle = null;
    $('#btn-format-painter').removeClass('painting');
    document.body.classList.remove('format-painter-active');
    document.removeEventListener('mouseup', applyFormatPainterOnce);
}

/**
 * Apply flex distribution to the closest block ancestor of the current selection.
 * direction='row' → space-between horizontally; 'column' → even vertical gap.
 * Re-applying the same direction toggles back to default block flow.
 */
function distributeChildren(direction) {
    const sel = window.getSelection();
    let node = sel?.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!node) {
        const $active = $('#html-preview:visible, #visual-diff-html:visible').first();
        node = $active[0]?.lastElementChild || $active[0];
    }
    if (!node) return;

    // Find nearest block-level ancestor that has 2+ direct children to distribute
    let target = node;
    while (target && target.children?.length < 2 && target.parentElement &&
           !target.matches?.('.prose-area')) {
        target = target.parentElement;
    }
    if (!target || target.children.length < 2) return;

    const cur = target.dataset.distribute;
    if (cur === direction) {
        target.style.display = '';
        target.style.flexDirection = '';
        target.style.justifyContent = '';
        target.style.alignItems = '';
        target.style.gap = '';
        delete target.dataset.distribute;
    } else {
        target.style.display = 'flex';
        target.style.flexDirection = direction;
        target.style.justifyContent = direction === 'row' ? 'space-between' : 'flex-start';
        target.style.alignItems = direction === 'row' ? 'center' : 'stretch';
        target.style.gap = direction === 'row' ? '12px' : '16px';
        target.dataset.distribute = direction;
    }
}

// ── PDF zoom controls (delegate to pdfCanvas) ────────────────────────────────

function bumpZoom(delta) {
    const next = clamp(getPDFZoom() + delta, 0.5, 3.0);
    setPDFZoom(next);
    refreshZoomLabel();
}

function refreshZoomLabel() {
    $('#zoom-pct').text(Math.round(getPDFZoom() * 100) + '%');
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Insert a styled callout box (<aside class="pdf-box">) at the current
 * caret position inside the active editable surface.
 * Ported from schema-editor's _textPlace() pattern: insert → select → focus.
 */
function insertBox() {
    const view = state.activeView;
    let $surface;
    if (view === 'html') $surface = $('#html-preview');
    else if (view === 'visual-diff') $surface = $('#visual-diff-html');
    if (!$surface?.length) {
        showToast('Switch to the Doc or Visual Diff tab to insert a callout box.', 'error');
        return;
    }

    pushSnapshot();

    const aside = document.createElement('aside');
    aside.className = 'pdf-box';
    // contenteditable on the aside itself so the user can type straight in
    aside.setAttribute('contenteditable', 'true');
    aside.innerHTML = '<p>Box content here&hellip;</p>';

    const sel = window.getSelection();
    if (sel?.rangeCount) {
        const range = sel.getRangeAt(0);
        // Make sure the caret is inside our surface
        if ($surface[0].contains(range.commonAncestorContainer)) {
            range.collapse(false);
            range.insertNode(aside);
            // Move caret inside the new box (mirrors schema-editor's setTimeout focus)
            setTimeout(() => {
                const r = document.createRange();
                const p = aside.querySelector('p');
                r.selectNodeContents(p || aside);
                r.collapse(false);
                sel.removeAllRanges();
                sel.addRange(r);
                aside.focus();
            }, 20);
        } else {
            $surface.append(aside);
            aside.focus();
        }
    } else {
        $surface.append(aside);
        aside.focus();
    }
    syncStructuralEdit();
    syncUndoRedoUI();
}

/**
 * Add a new PDF-style page: a full <article class="pdf-doc"> wrapping a
 * <section class="pdf-page-content">, matching pageAssembler.js's per-page
 * output structure (see extraction/vector/pageAssembler.js:590). Appending a
 * plain <div> here would not get the page-card styling in
 * .prose-area .pdf-page-content (src/styles.css:924) and would break any
 * code that walks pages via `.closest('.pdf-page-content')` or
 * `querySelectorAll('.pdf-page-content')` (exportController.js, zoneToolbar.js).
 */
function addEditorPage() {
    const $preview = $('#html-preview');
    if (!$preview.length) return;
    pushSnapshot();
    $preview.trigger('focus');

    const existingPages = $preview.find('.pdf-page-content[data-page]').toArray();
    const nextPageNum = existingPages.reduce(
        (max, el) => Math.max(max, parseInt(el.dataset.page, 10) || 0), 0
    ) + 1;

    const article = document.createElement('article');
    article.className = 'pdf-doc';
    const section = document.createElement('section');
    section.className = 'pdf-page-content';
    section.dataset.page = String(nextPageNum);
    section.innerHTML =
        `<h4 class="page-label">Page ${nextPageNum}</h4>\n<p>New page content here&hellip;</p>`;
    article.appendChild(section);

    $preview.append(article);
    const allPages = [...$preview.find('.pdf-page-content')];
    registerPages(allPages, allPages.length);

    const r = document.createRange();
    r.selectNodeContents(section.querySelector('p'));
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);

    syncStructuralEdit();
}

export function registerPages(wrappers, total) {
    _pageWrappers = wrappers;
    _totalPages = total;
    _currentPage = 1;
    updateCounter(1, total);
    buildJumpSelect(total);
    setupIntersectionObserver();
}

export function getCurrentPage() {
    return _currentPage;
}

export function prevPage() {
    if (_currentPage > 1) scrollToPage(_currentPage - 1);
}

export function nextPage() {
    if (_currentPage < _totalPages) scrollToPage(_currentPage + 1);
}

export function jumpToPage(n) {
    if (n >= 1 && n <= _totalPages) scrollToPage(n);
}

function scrollToPage(n) {
    let wrapper = _pageWrappers[n - 1];
    if (state.activeView === 'visual-diff') {
        const vdWrapper = document.querySelector(`#visual-diff-pdf .page-wrapper[data-page="${n}"]`);
        if (vdWrapper) wrapper = vdWrapper;
    } else if (!wrapper || !document.body.contains(wrapper)) {
        wrapper = document.querySelector(`.page-wrapper[data-page="${n}"], .pdf-page-content[data-page="${n}"]`);
    }

    if (wrapper) {
        wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
        _currentPage = n;
        updateCounter(n, _totalPages);
        $('#page-jump').val(n);
    }
}

function updateCounter(current, total) {
    $('#page-counter').text(`Page ${current} of ${total}`);
}

function buildJumpSelect(total) {
    const $jump = $('#page-jump');
    if (!$jump.length) return;
    $jump.empty();
    
    for (let i = 1; i <= total; i++) {
        $('<option>').val(i).text(`Page ${i}`).appendTo($jump);
    }
}

function setupIntersectionObserver() {
    if (!_pageWrappers.length) return;
    const observer = new IntersectionObserver(entries => {
        let mostVisible = null, maxRatio = 0;
        for (const entry of entries) {
            if (entry.intersectionRatio > maxRatio) {
                maxRatio = entry.intersectionRatio;
                mostVisible = entry.target;
            }
        }
        if (mostVisible) {
            const idx = _pageWrappers.indexOf(mostVisible);
            if (idx !== -1 && idx + 1 !== _currentPage) {
                _currentPage = idx + 1;
                updateCounter(_currentPage, _totalPages);
                $('#page-jump').val(_currentPage);
            }
        }
    }, { threshold: [0, 0.25, 0.5, 0.75, 1] });

    _pageWrappers.forEach(w => observer.observe(w));
}
