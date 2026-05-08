/**
 * pageNav.js
 * Page navigation (prev/next/jump/counter) and formatting toolbar handlers.
 */

import $ from 'jquery';
import { state } from '../state.js';
import { setPDFZoom, getPDFZoom, fitPDFWidth } from './pdfCanvas.js';

let _totalPages = 0;
let _currentPage = 1;
let _pageWrappers = [];

export function initToolbar() {
    $('#btn-bold').on('click', () => fmt('bold'));
    $('#btn-italic').on('click', () => fmt('italic'));
    $('#btn-underline').on('click', () => fmt('underline'));
    $('#btn-ul').on('click', () => fmt('insertUnorderedList'));
    $('#btn-ol').on('click', () => fmt('insertOrderedList'));

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

    $('#btn-2col').on('click', toggle2col);
    $('#btn-add-page').on('click', addEditorPage);

    $('#btn-zoom-in').on('click',  () => bumpZoom(+0.1));
    $('#btn-zoom-out').on('click', () => bumpZoom(-0.1));
    $('#btn-zoom-fit').on('click', () => { fitPDFWidth(); refreshZoomLabel(); });
    refreshZoomLabel();

    $('#btn-prev-page').on('click', prevPage);
    $('#btn-next-page').on('click', nextPage);
    $('#page-jump').on('change', function() { jumpToPage(+$(this).val()); });
}

function fmt(cmd, val) {
    document.execCommand(cmd, false, val || null);
}

function toggle2col() {
    const $active = $('.prose-area.active, #html-preview, #visual-diff-html').filter(':visible').first();
    if (!$active.length) return;

    const is2Col = $active.css('columnCount') === '2';
    $active.css({
        columnCount: is2Col ? 'auto' : '2',
        columnGap: is2Col ? 'normal' : '32px'
    });
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

function addEditorPage() {
    const $preview = $('#html-preview');
    if (!$preview.length) return;
    $preview.trigger('focus');
    
    const $div = $('<div>')
        .css({
            pageBreakBefore: 'always',
            borderTop: '2px dashed #d1d5db',
            margin: '40px 0 20px',
            paddingTop: '20px'
        })
        .html('<p>New page content here…</p>');
        
    const sel = window.getSelection();
    if (sel?.rangeCount) {
        const range = sel.getRangeAt(0);
        range.collapse(false);
        range.insertNode($div[0]);
    } else {
        $preview.append($div);
    }
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
