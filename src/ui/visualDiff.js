/**
 * visualDiff.js
 * Visual Diff view handling its own resizable panes with jQuery.
 */

import $ from 'jquery';
import { state } from '../state.js';
import { renderPDFToCanvas } from './pdfCanvas.js';
import { registerPages } from './pageNav.js';
import { mountLayers as mountAnnotationLayers, unmountLayers as unmountAnnotationLayers } from '../annotation/layer.js';
import { initTableFeatures } from '../utils/tableLogic.js';
import { rebindTableEditing } from './tableEditorInit.js';

let _rendered = false;

// 'pdf' = left pane (PDF overlay), 'html' = right pane (extracted HTML)
// Defaults to 'pdf' — matches initial view focus.
let _focusedPane = 'pdf';

export function getVisualDiffFocusedPane() {
    return _focusedPane;
}

export function setVisualDiffFocusedPane(pane) {
    if (_focusedPane === pane) return;
    _focusedPane = pane;
    _updatePaneActiveClass();

    // Dynamically update toolbar context and nav panel
    import('./viewController.js').then(m => m.syncToolbarToView('visual-diff'));
    import('./navPanel.js').then(m => m.renderNavPanel());
}

/**
 * Returns the currently focused pane's editable element for execCommand routing.
 * html pane → #visual-diff-html; pdf pane → the focused .editable-text-layer inside #visual-diff-pdf.
 */
export function getVisualDiffFocusedTarget() {
    if (_focusedPane === 'html') {
        return document.getElementById('visual-diff-html');
    }
    // PDF pane: return last focused layer, or first layer as fallback
    const pdfPane = document.getElementById('visual-diff-pdf');
    return pdfPane?.querySelector('.editable-text-layer:focus')
        ?? pdfPane?.querySelector('.editable-text-layer')
        ?? null;
}

export async function activateVisualDiff() {
    if (!state.pdf1.bytes) {
        $('#visual-diff-pdf').html('<p class="empty-hint">Open a PDF first.</p>');
        return;
    }

    if (!_rendered || state.pdf1._diffDirty) {
        await renderPDFToCanvas(state.pdf1.bytes, 'visual-diff-pdf');
        _rendered = true;
        state.pdf1._diffDirty = false;
        unmountAnnotationLayers(document.getElementById('visual-diff-pdf'));
        mountAnnotationLayers(document.getElementById('visual-diff-pdf'), { readOnly: true });
    }

    // Only re-fill the HTML pane when state has actually moved on. Edits the
    // user made in #html-preview have already flowed to state via htmlSync,
    // so blindly overwriting innerHTML on every tab activation would clobber
    // unsynced typing in this pane and reset cursor selection unnecessarily.
    const rightPane = document.getElementById('visual-diff-html');
    if (rightPane && state.pdf1.extractedHTML) {
        const clean = typeof DOMPurify !== 'undefined'
            ? DOMPurify.sanitize(state.pdf1.extractedHTML, { ADD_TAGS: ['img'], ALLOW_DATA_ATTR: true })
            : state.pdf1.extractedHTML;
        if (rightPane.innerHTML !== clean) {
            rightPane.innerHTML = clean;
            initTableFeatures(rightPane);
            rebindTableEditing();
        }
    }

    const wrappers = $('#visual-diff-pdf .page-wrapper').toArray();
    if (wrappers.length) registerPages(wrappers, wrappers.length);

    setupScrollSync();
    _attachPaneFocusListeners();
    _updatePaneActiveClass();
}

/**
 * Wire focusin and click on both vd-pane containers and vd-pane-header to track
 * which pane the user is interacting with.
 */
function _attachPaneFocusListeners() {
    const $panes = $('.vd-pane');
    if (!$panes.length) return;

    $panes.off('click.vdfocus focusin.vdfocus mousedown.vdfocus').on('click.vdfocus focusin.vdfocus mousedown.vdfocus', function () {
        const isPdf = $(this).find('#visual-diff-pdf').length > 0;
        setVisualDiffFocusedPane(isPdf ? 'pdf' : 'html');
    });
}

function _updatePaneActiveClass() {
    $('.vd-pane').each(function () {
        const isPdf = $(this).find('#visual-diff-pdf').length > 0;
        const isActive = _focusedPane === (isPdf ? 'pdf' : 'html');
        $(this).toggleClass('vd-pane--active', isActive);
        $(this).find('.vd-pane-header').toggleClass('vd-pane-header--active', isActive);
    });
}

// ── Scroll sync between PDF pane and HTML pane ───────────────────────────────
//
// Page-snap, IntersectionObserver-driven: each pane has its own IO that
// tracks the most-visible `[data-page]` element. When the active page
// changes, the OTHER pane scrolls so the matching `[data-page]` element
// is at the top. Within-page scrolling stays independent — there is no
// pixel-ratio math, so zoom-induced height mismatches between the
// (spatial) PDF side and the (semantic) HTML side don't cause drift.

let _observers = []; // [{ observer }] from previous activation, to be disposed

function setupScrollSync() {
    const left  = document.getElementById('visual-diff-pdf');
    const right = document.getElementById('visual-diff-html');
    if (!left || !right) return;

    // Tear down observers from a prior activation — DOM elements they were
    // watching get replaced when activateVisualDiff re-renders the panes.
    for (const o of _observers) o.observer.disconnect();
    _observers = [];

    const leftPages  = left.querySelectorAll('.page-wrapper');
    const rightPages = right.querySelectorAll('.pdf-page-content');
    if (!leftPages.length || !rightPages.length) return; // no markers → no sync

    // Re-entrancy guard: when we programmatically scroll pane B, B's observer
    // fires and would try to scroll A back. `suppress > 0` skips one cycle.
    let suppress = 0;

    const scrollOtherTo = (page, targetPane, targetSelector) => {
        if (suppress > 0) { suppress--; return; }
        const el = targetPane.querySelector(`${targetSelector}[data-page="${page}"]`);
        if (!el) return;
        suppress = 1;
        el.scrollIntoView({ block: 'start', behavior: 'auto' });
    };

    _observers.push(createPaneObserver(left,  leftPages,  page =>
        scrollOtherTo(page, right, '.pdf-page-content')));
    _observers.push(createPaneObserver(right, rightPages, page =>
        scrollOtherTo(page, left,  '.page-wrapper')));
}

/**
 * Watch a pane's pages and emit the page number whenever the most-visible
 * page changes. Uses intersection ratio relative to the pane's own scroll
 * box, so zoom and CSS transforms don't affect correctness.
 */
function createPaneObserver(pane, pages, onActivePageChange) {
    const ratios = new Map();
    let activePage = null;

    const observer = new IntersectionObserver(entries => {
        for (const e of entries) ratios.set(e.target, e.intersectionRatio);

        let topEl = null, topRatio = -1;
        for (const [el, r] of ratios) {
            if (r > topRatio) { topRatio = r; topEl = el; }
        }
        if (!topEl) return;

        const page = topEl.getAttribute('data-page');
        if (page === activePage) return;
        activePage = page;
        onActivePageChange(page);
    }, { root: pane, threshold: [0, 0.25, 0.5, 0.75, 1] });

    pages.forEach(p => observer.observe(p));
    return { observer };
}

export function markDiffDirty() {
    _rendered = false;
    if (state.pdf1) state.pdf1._diffDirty = true;
}

export function initDividerResize() {
    const $divider = $('#vd-divider');
    const $layout = $('.visual-diff-layout');
    if (!$divider.length || !$layout.length) return;

    let dragging = false;
    let startPos = 0;   // clientX in row mode, clientY in column mode
    let startSize = 0;  // first pane width (row) or height (column)

    function isStacked() {
        return getComputedStyle($layout[0]).flexDirection === 'column';
    }

    function getEventPos(e) {
        const src = e.touches?.[0] ?? e;
        return isStacked() ? src.clientY : src.clientX;
    }

    function startDrag(e) {
        dragging = true;
        startPos = getEventPos(e);
        const $first = $layout.find('.vd-pane').first();
        startSize = isStacked() ? $first.outerHeight() : $first.outerWidth();
        $divider.addClass('dragging');
        if (!e.touches) {
            $('body').css({ userSelect: 'none', cursor: isStacked() ? 'row-resize' : 'col-resize' });
        }
        e.preventDefault();
    }

    function doDrag(e) {
        if (!dragging) return;
        const delta = getEventPos(e) - startPos;
        const $panes = $layout.find('.vd-pane');
        if (isStacked()) {
            const totalH = $layout.outerHeight();
            const newH = Math.max(120, Math.min(totalH - 120, startSize + delta));
            const topPct = (newH / totalH) * 100;
            $panes.eq(0).css('flex', `0 0 ${topPct}%`);
            $panes.eq(1).css('flex', `0 0 ${100 - topPct}%`);
        } else {
            const totalW = $layout.outerWidth();
            const newW = Math.max(240, Math.min(totalW - 240, startSize + delta));
            const leftPct = (newW / totalW) * 100;
            $panes.eq(0).css('flex', `0 0 ${leftPct}%`);
            $panes.eq(1).css('flex', `0 0 ${100 - leftPct}%`);
        }
        if (e.cancelable) e.preventDefault();
    }

    function endDrag() {
        if (!dragging) return;
        dragging = false;
        $divider.removeClass('dragging');
        $('body').css({ userSelect: '', cursor: '' });
    }

    $divider.on('mousedown', startDrag);
    $divider[0].addEventListener('touchstart', startDrag, { passive: false });

    $(document).on('mousemove', doDrag).on('mouseup', endDrag);
    document.addEventListener('touchmove', doDrag, { passive: false });
    document.addEventListener('touchend', endDrag);
}
