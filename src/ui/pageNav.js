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

export function initToolbar() {
    $('#btn-bold').on('click', () => fmt('bold'));
    $('#btn-italic').on('click', () => fmt('italic'));
    $('#btn-underline').on('click', () => fmt('underline'));
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
        $('#btn-bold, #btn-italic, #btn-underline').removeClass('active');
        setActiveAlign('left');
        return;
    }

    $('#btn-bold').toggleClass('active', document.queryCommandState('bold'));
    $('#btn-italic').toggleClass('active', document.queryCommandState('italic'));
    $('#btn-underline').toggleClass('active', document.queryCommandState('underline'));

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
 */
function initSplitDropdown(rootSelector, insertCmd) {
    const $root = $(rootSelector);
    const $caret = $root.find('.split-btn-caret');
    const $menu = $root.find('.dropdown-menu');

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

    $menu.on('click', '.dropdown-item', function(e) {
        e.stopPropagation();
        const styleType = $(this).data('list-style');
        applyListStyle(insertCmd, styleType);
        $root.removeClass('open');
    });
}

function applyListStyle(insertCmd, styleType) {
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

    $('#btn-columns').on('click', () => applyColumnSplit(2));

    $caret.on('click', (e) => {
        e.stopPropagation();
        const isOpen = $root.hasClass('open');
        $('.dropdown.open').removeClass('open');

        if (!isOpen) {
            const sel = window.getSelection();
            _columnSplitRange = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;

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
        textAlign: cs.textAlign
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
    try {
        range.surroundContents(span);
    } catch {
        span.appendChild(range.extractContents());
        range.insertNode(span);
    }

    let block = span.closest('p, div, li, h1, h2, h3, h4, h5, h6');
    if (block) block.style.textAlign = _paintedStyle.textAlign;

    syncStructuralEdit();
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
    const wrapper = _pageWrappers[n - 1];
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
