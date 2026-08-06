/**
 * diffViewController.js
 * Diffchecker-style line-by-line diff with:
 *   - Line numbers in a gutter
 *   - Full removed lines highlighted red (left), added lines green (right)
 *   - Inline word/char highlighting within changed lines
 *   - Synchronized scroll between split panes
 *   - Unified view collapses unchanged context
 */

import $ from 'jquery';
import * as jsdiff from 'diff';
import { state } from '../state.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CONTEXT_LINES = 3; // unchanged lines shown around a change block

// ── Init ──────────────────────────────────────────────────────────────────────
export function initDiffTabsAndLayout() {
    $('.diff-pill[data-cmp-view]').on('click', function () {
        $('.diff-pill[data-cmp-view]').removeClass('active');
        $(this).addClass('active');
        state.diffActiveView = $(this).data('cmp-view');
        refreshCompareDiff();
    });

    $('#layout-split').on('click', function () {
        $('#layout-split, #layout-unified').removeClass('active');
        $(this).addClass('active');
        $('#diff-container').removeClass('unified-view').addClass('split-view');
        $('#pane-resizer').show();
        state.diffLayout = 'split';
        refreshCompareDiff();
    });

    $('#layout-unified').on('click', function () {
        $('#layout-split, #layout-unified').removeClass('active');
        $(this).addClass('active');
        $('#diff-container').removeClass('split-view').addClass('unified-view');
        $('#pane-resizer').hide();
        state.diffLayout = 'unified';
        refreshCompareDiff();
    });

    $('#precision-word, #precision-char').on('click', function () {
        $('#precision-word, #precision-char').removeClass('active');
        $(this).addClass('active');
        state.diffPrecision = $(this).attr('id') === 'precision-word' ? 'word' : 'char';
        refreshCompareDiff();
    });

    initDiffDividerResize();
    initSyncScroll();
}

// ── Main diff renderer ────────────────────────────────────────────────────────
export function refreshCompareDiff() {
    const useHtml = state.diffActiveView === 'rich-text';

    // Extract plain text from HTML when in plain mode
    const raw1 = useHtml ? state.pdf1.extractedHTML : state.pdf1.extractedText;
    const raw2 = useHtml ? state.pdf2.extractedHTML : state.pdf2.extractedText;

    if (!raw1 && !raw2) {
        _setEmpty('Load Original File', 'Load Modified File');
        _setStats(0, 0);
        return;
    }
    if (!raw2) {
        _renderSinglePane(raw1, useHtml);
        _setStats(0, 0);
        return;
    }
    if (!raw1) {
        _renderSingleRightPane(raw2, useHtml);
        _setStats(0, 0);
        return;
    }

    // Normalise to plain text lines for the line diff
    const lines1 = _toLines(raw1, useHtml);
    const lines2 = _toLines(raw2, useHtml);

    // Line-level diff
    const lineDiffs = jsdiff.diffArrays(lines1, lines2);

    // Build matched line pairs: { left: string|null, right: string|null, type: 'equal'|'remove'|'add' }
    const pairs = _buildPairs(lineDiffs);

    if (state.diffLayout === 'split') {
        _renderSplit(pairs, useHtml);
    } else {
        _renderUnified(pairs, useHtml);
    }

    const removals = pairs.filter(p => p.type === 'remove' || p.type === 'change').length;
    const additions = pairs.filter(p => p.type === 'add'    || p.type === 'change').length;
    _setStats(additions, removals);
}

// ── Line extraction ───────────────────────────────────────────────────────────
function _toLines(content, isHtml) {
    if (!content) return [];
    const text = isHtml ? _stripTags(content) : content;
    return text.split('\n');
}

function _stripTags(html) {
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"');
}

// ── Pair builder ──────────────────────────────────────────────────────────────
// Converts jsdiff array diff into {left, right, type} pairs for rendering.
// Changed blocks pair removed and added lines 1-to-1 by index (same as GitHub).
function _buildPairs(lineDiffs) {
    const pairs = [];
    for (const part of lineDiffs) {
        if (!part.added && !part.removed) {
            // Equal lines
            for (const line of part.value) {
                pairs.push({ left: line, right: line, type: 'equal' });
            }
        } else if (part.removed) {
            // Collect the corresponding added block if it follows immediately
            pairs.push({ _removed: part.value, _partRef: part });
        } else if (part.added) {
            // Check if the previous entry was a pending removed block — pair them
            const prev = pairs[pairs.length - 1];
            if (prev && prev._removed) {
                const removed = prev._removed;
                const added   = part.value;
                const maxLen  = Math.max(removed.length, added.length);
                pairs.pop(); // remove the pending entry
                for (let i = 0; i < maxLen; i++) {
                    pairs.push({
                        left:  i < removed.length ? removed[i] : null,
                        right: i < added.length   ? added[i]   : null,
                        type:  i < removed.length && i < added.length ? 'change' : (i < removed.length ? 'remove' : 'add'),
                    });
                }
            } else {
                // Pure addition with no matching removal
                for (const line of part.value) {
                    pairs.push({ left: null, right: line, type: 'add' });
                }
            }
        }
    }

    // Flush any trailing pending removed blocks (deletions at end with no following add)
    for (let i = 0; i < pairs.length; i++) {
        if (pairs[i]._removed) {
            const removed = pairs[i]._removed;
            const replacement = removed.map(line => ({ left: line, right: null, type: 'remove' }));
            pairs.splice(i, 1, ...replacement);
            i += replacement.length - 1;
        }
    }

    return pairs;
}

// ── Split renderer ────────────────────────────────────────────────────────────
function _renderSplit(pairs, useHtml) {
    let leftNum  = 0;
    let rightNum = 0;
    let leftHtml  = '';
    let rightHtml = '';

    const changed = new Set(
        pairs.map((p, i) => (p.type !== 'equal' ? i : -1)).filter(i => i >= 0)
    );

    let i = 0;
    while (i < pairs.length) {
        const p = pairs[i];

        if (p.type === 'equal') {
            // Check if this equal block should be collapsed
            const prevChanged = _nearChanged(i, pairs, 'before');
            const nextChanged = _nearChanged(i, pairs, 'after');

            if (!prevChanged && !nextChanged) {
                // Far from any change — collapse
                const blockEnd = _equalBlockEnd(i, pairs);
                const count = blockEnd - i;
                if (count > CONTEXT_LINES * 2) {
                    // Render first CONTEXT_LINES then collapse then skip
                    for (let j = i; j < i + CONTEXT_LINES && j < blockEnd; j++) {
                        leftNum++; rightNum++;
                        leftHtml  += _row(leftNum,  pairs[j].left,  'equal', false);
                        rightHtml += _row(rightNum, pairs[j].right, 'equal', false);
                    }
                    const skipped = count - CONTEXT_LINES * 2;
                    if (skipped > 0) {
                        leftHtml  += `<div class="diff-skip-row">↕ ${skipped} unchanged lines</div>`;
                        rightHtml += `<div class="diff-skip-row">↕ ${skipped} unchanged lines</div>`;
                        leftNum  += skipped;
                        rightNum += skipped;
                    }
                    for (let j = blockEnd - CONTEXT_LINES; j < blockEnd; j++) {
                        leftNum++; rightNum++;
                        leftHtml  += _row(leftNum,  pairs[j].left,  'equal', false);
                        rightHtml += _row(rightNum, pairs[j].right, 'equal', false);
                    }
                    i = blockEnd;
                    continue;
                }
            }

            leftNum++; rightNum++;
            leftHtml  += _row(leftNum,  p.left,  'equal', false);
            rightHtml += _row(rightNum, p.right, 'equal', false);

        } else if (p.type === 'remove') {
            leftNum++;
            leftHtml  += _row(leftNum,  p.left,  'remove', false);
            rightHtml += _row(null, null, 'empty', false);

        } else if (p.type === 'add') {
            rightNum++;
            leftHtml  += _row(null, null, 'empty', false);
            rightHtml += _row(rightNum, p.right, 'add', false);

        } else if (p.type === 'change') {
            leftNum++;  rightNum++;
            const { leftInline, rightInline } = _inlineDiff(p.left || '', p.right || '');
            leftHtml  += _row(leftNum,  leftInline,  'remove', true);
            rightHtml += _row(rightNum, rightInline, 'add',    true);
        }

        i++;
    }

    $('#content-left').html(leftHtml);
    $('#content-right').html(rightHtml);
}

// ── Unified renderer ──────────────────────────────────────────────────────────
function _renderUnified(pairs, useHtml) {
    let leftNum  = 0;
    let rightNum = 0;
    let html = '';

    let i = 0;
    while (i < pairs.length) {
        const p = pairs[i];

        if (p.type === 'equal') {
            const blockEnd = _equalBlockEnd(i, pairs);
            const count = blockEnd - i;
            const prevChanged = i > 0 && pairs[i - 1].type !== 'equal';
            const nextChanged = blockEnd < pairs.length && pairs[blockEnd].type !== 'equal';

            const renderCount = (prevChanged || nextChanged) ? Math.min(count, CONTEXT_LINES) : 0;
            const skipCount = count - (prevChanged ? CONTEXT_LINES : 0) - (nextChanged ? CONTEXT_LINES : 0);

            if (prevChanged) {
                for (let j = i; j < Math.min(i + CONTEXT_LINES, blockEnd); j++) {
                    leftNum++; rightNum++;
                    html += _unifiedRow(leftNum, rightNum, p.left, 'equal');
                }
            }
            if (skipCount > 0) {
                const skip = Math.max(0, count - renderCount);
                html += `<div class="diff-skip-row">↕ ${skip} unchanged lines</div>`;
                leftNum += skip; rightNum += skip;
            }
            if (nextChanged) {
                const start = blockEnd - CONTEXT_LINES;
                for (let j = Math.max(i, start); j < blockEnd; j++) {
                    leftNum++; rightNum++;
                    html += _unifiedRow(leftNum, rightNum, pairs[j].left, 'equal');
                }
            }
            i = blockEnd;
            continue;

        } else if (p.type === 'remove') {
            leftNum++;
            html += _unifiedRow(leftNum, null, p.left, 'remove');
        } else if (p.type === 'add') {
            rightNum++;
            html += _unifiedRow(null, rightNum, p.right, 'add');
        } else if (p.type === 'change') {
            leftNum++;
            const { leftInline, rightInline } = _inlineDiff(p.left || '', p.right || '');
            html += _unifiedRow(leftNum, null, leftInline,  'remove', true);
            rightNum++;
            html += _unifiedRow(null, rightNum, rightInline, 'add',    true);
        }

        i++;
    }

    $('#content-left').html(html);
    $('#content-right').html('');
}

// ── Row builders ──────────────────────────────────────────────────────────────
function _row(lineNum, content, type, isInline) {
    if (type === 'empty') {
        return `<div class="diff-row diff-row--empty"><span class="diff-gutter"></span><span class="diff-line"></span></div>`;
    }
    const glyph = type === 'remove' ? '−' : type === 'add' ? '+' : ' ';
    const cls   = `diff-row diff-row--${type}`;
    const num   = lineNum != null ? lineNum : '';
    const text  = isInline ? content : _esc(content ?? '');
    return `<div class="${cls}"><span class="diff-gutter"><span class="diff-lineno">${num}</span><span class="diff-glyph">${glyph}</span></span><span class="diff-line">${text}</span></div>`;
}

function _unifiedRow(leftNum, rightNum, content, type, isInline = false) {
    const glyph = type === 'remove' ? '−' : type === 'add' ? '+' : ' ';
    const cls   = `diff-row diff-row--${type}`;
    const ln    = leftNum  != null ? leftNum  : '';
    const rn    = rightNum != null ? rightNum : '';
    const text  = isInline ? content : _esc(content ?? '');
    return `<div class="${cls}"><span class="diff-gutter"><span class="diff-lineno diff-lineno--left">${ln}</span><span class="diff-lineno diff-lineno--right">${rn}</span><span class="diff-glyph">${glyph}</span></span><span class="diff-line">${text}</span></div>`;
}

// ── Inline word/char diff ─────────────────────────────────────────────────────
function _inlineDiff(oldLine, newLine) {
    const method = state.diffPrecision === 'char' ? 'diffChars' : 'diffWords';
    const parts  = jsdiff[method](oldLine, newLine);

    let leftInline  = '';
    let rightInline = '';

    for (const part of parts) {
        const esc = _esc(part.value);
        if (part.removed) {
            leftInline  += `<mark class="diff-inline-remove">${esc}</mark>`;
        } else if (part.added) {
            rightInline += `<mark class="diff-inline-add">${esc}</mark>`;
        } else {
            leftInline  += esc;
            rightInline += esc;
        }
    }

    return { leftInline, rightInline };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _nearChanged(i, pairs, direction) {
    const range = CONTEXT_LINES;
    if (direction === 'before') {
        for (let j = i - 1; j >= Math.max(0, i - range); j--) {
            if (pairs[j].type !== 'equal') return true;
        }
    } else {
        for (let j = i + 1; j <= Math.min(pairs.length - 1, i + range); j++) {
            if (pairs[j].type !== 'equal') return true;
        }
    }
    return false;
}

function _equalBlockEnd(i, pairs) {
    let j = i;
    while (j < pairs.length && pairs[j].type === 'equal') j++;
    return j;
}

function _esc(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function _setEmpty(left, right) {
    $('#content-left').html(`<div class="empty-state">${left}</div>`);
    $('#content-right').html(`<div class="empty-state">${right}</div>`);
}

function _renderSinglePane(content, useHtml) {
    const lines = _toLines(content, useHtml);
    let html = '';
    lines.forEach((line, i) => {
        html += _row(i + 1, line, 'equal', false);
    });
    $('#content-left').html(html);
    $('#content-right').html('<div class="empty-state">Load Modified File to compare</div>');
}

function _renderSingleRightPane(content, useHtml) {
    const lines = _toLines(content, useHtml);
    let html = '';
    lines.forEach((line, i) => {
        html += _row(i + 1, line, 'equal', false);
    });
    $('#content-left').html('<div class="empty-state">Load Original File to compare</div>');
    $('#content-right').html(html);
}

function _setStats(additions, removals) {
    $('#stat-added-count').text(additions);
    $('#stat-removed-count').text(removals);
}

// ── Synchronized scroll ───────────────────────────────────────────────────────
function initSyncScroll() {
    const left  = document.getElementById('content-left');
    const right = document.getElementById('content-right');
    if (!left || !right) return;

    let syncing = false;

    left.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true;
        right.scrollTop  = left.scrollTop;
        right.scrollLeft = left.scrollLeft;
        syncing = false;
    });

    right.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true;
        left.scrollTop  = right.scrollTop;
        left.scrollLeft = right.scrollLeft;
        syncing = false;
    });
}

// ── Divider resize ────────────────────────────────────────────────────────────
function initDiffDividerResize() {
    let dragging = false, startX = 0, startLeftW = 0;
    const resizer = document.getElementById('pane-resizer');
    if (!resizer) return;

    function startDrag(e) {
        dragging = true;
        startX = (e.touches?.[0] ?? e).clientX;
        startLeftW = $('#pane-left').outerWidth();
        $('#pane-resizer').addClass('dragging');
        if (!e.touches) $('body').css({ userSelect: 'none', cursor: 'col-resize' });
        e.preventDefault();
    }
    function doDrag(e) {
        if (!dragging) return;
        const delta  = (e.touches?.[0] ?? e).clientX - startX;
        const totalW = $('#diff-container').outerWidth();
        const newW   = Math.max(200, Math.min(totalW - 200, startLeftW + delta));
        const pct    = (newW / totalW) * 100;
        $('#pane-left').css('flex', `0 0 ${pct}%`);
        $('#pane-right').css('flex', `0 0 ${100 - pct}%`);
        if (e.cancelable) e.preventDefault();
    }
    function endDrag() {
        if (!dragging) return;
        dragging = false;
        $('#pane-resizer').removeClass('dragging');
        $('body').css({ userSelect: '', cursor: '' });
    }

    $('#pane-resizer').on('mousedown', startDrag);
    resizer.addEventListener('touchstart', startDrag, { passive: false });
    $(document).on('mousemove', doDrag).on('mouseup', endDrag);
    document.addEventListener('touchmove', doDrag, { passive: false });
    document.addEventListener('touchend', endDrag);
}
