/**
 * visualDiff.js
 * Visual Diff view handling its own resizable panes with jQuery.
 */

import $ from 'jquery';
import { state } from '../state.js';
import { renderPDFToCanvas } from './pdfCanvas.js';
import { registerPages } from './pageNav.js';

let _rendered = false;

export async function activateVisualDiff() {
    if (!state.pdf1.bytes) {
        $('#visual-diff-pdf').html('<p class="empty-hint">Open a PDF first.</p>');
        return;
    }

    if (!_rendered || state.pdf1._diffDirty) {
        await renderPDFToCanvas(state.pdf1.bytes, 'visual-diff-pdf');
        _rendered = true;
        state.pdf1._diffDirty = false;
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
        if (rightPane.innerHTML !== clean) rightPane.innerHTML = clean;
    }

    const wrappers = $('#visual-diff-pdf .page-wrapper').toArray();
    if (wrappers.length) registerPages(wrappers, wrappers.length);

    setupScrollSync();
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
    let startX = 0;
    let startLeftW = 0;

    $divider.on('mousedown', function(e) {
        dragging = true;
        startX = e.clientX;
        startLeftW = $layout.find('.vd-pane').first().outerWidth();
        $(this).addClass('dragging');
        $('body').css({ userSelect: 'none', cursor: 'col-resize' });
    });

    $(document).on('mousemove', function(e) {
        if (!dragging) return;
        const delta = e.clientX - startX;
        const totalW = $layout.outerWidth();
        const newLeftW = Math.max(240, Math.min(totalW - 240, startLeftW + delta));
        const leftPct = (newLeftW / totalW) * 100;
        
        const $panes = $layout.find('.vd-pane');
        $panes.eq(0).css('flex', `0 0 ${leftPct}%`);
        $panes.eq(1).css('flex', `0 0 ${100 - leftPct}%`);
    });

    $(document).on('mouseup', function() {
        if (!dragging) return;
        dragging = false;
        $divider.removeClass('dragging');
        $('body').css({ userSelect: '', cursor: '' });
    });
}
