/**
 * viewController.js
 * Tab bar: PDF | Doc | Editor | Analyze | Compare Diff.
 *
 * A tab selects which panes are visible, nothing more — workspaceLayout.js
 * owns the panes themselves. "Show original PDF" is not a view switch and
 * not a DOM move; it just adds #pane-pdf to the visible set.
 */

import $ from 'jquery';
import { state } from '../state.js';
import { deactivateSelectionMode } from './selectionMode.js';
import { renderNavPanel } from './navPanel.js';
import { setView, getFocusedPane, isSplit } from './workspaceLayout.js';

const VIEWS = ['analyze', 'pdf', 'html', 'editor', 'diff'];

// Views where the toolbar is completely hidden
const TOOLBAR_HIDDEN_VIEWS = new Set(['editor', 'analyze', 'diff']);

export function initViewTabs() {
    $('.tab-btn[data-view]').on('click', function() {
        if ($(this).prop('disabled')) return;
        switchView($(this).data('view'));
    });
}

export async function switchView(viewName) {
    deactivateSelectionMode();
    if (!VIEWS.includes(viewName)) return;

    if (viewName === 'diff') {
        $('#diff-tab-btn').prop('disabled', false);
    }

    state.activeView = viewName;
    setView(viewName);

    $('.tab-btn[data-view]').each(function() {
        $(this).toggleClass('active', $(this).data('view') === viewName);
    });

    // Monaco needs layout() when made visible, and it is also where the
    // deferred document sync lands: edits mark the cache stale rather than
    // pushing a 16 MB setValue per keystroke (see htmlSync.js).
    if (viewName === 'editor' && state.monacoEditor) {
        const { syncMonacoFromState } = await import('./htmlSync.js');
        syncMonacoFromState();
        state.monacoEditor.layout();
    }

    if (viewName === 'diff') {
        const { refreshCompareDiff } = await import('./diffViewController.js');
        refreshCompareDiff();
    }

    syncToolbarToView(viewName);
    renderNavPanel();

    try {
        if (window.parent !== window) {
            const publicSlug = viewName === 'html' ? 'doc' : (viewName === 'diff' ? 'compare' : viewName);
            window.parent.postMessage({
                type: 'cws:view-change',
                source: 'pdf_processor',
                appId: 'pdf_processor',
                view: publicSlug
            }, '*');
        }
    } catch (_) {}
}

/**
 * The ONE answer to "which surface is the toolbar acting on".
 *
 * With the PDF sharing the screen, the Doc tab has two editable surfaces, so
 * the answer is the focused pane rather than the tab. Everything that used to
 * ask this question separately — pageNav's fmt/fmtColor/removeHighlight, the
 * toolbar group visibility, the nav panel — goes through here.
 */
export function getEffectiveActiveView() {
    const view = state.activeView || 'pdf';
    if (isSplit() && getFocusedPane() === 'pdf') return 'pdf';
    return view;
}

/**
 * Show/hide toolbar groups and separators based on the active view.
 * Each group/sep carries a data-toolbar-ctx attribute listing the views
 * where it should be visible (space-separated). Groups without the attribute
 * are always shown (legacy fallback).
 */
export function syncToolbarToView(viewName) {
    const $bar = $('#format-toolbar');
    if (!$bar.length) return;

    const requested = viewName || state.activeView || 'pdf';
    const currentView = (isSplit() && getFocusedPane() === 'pdf') ? 'pdf' : requested;

    if (TOOLBAR_HIDDEN_VIEWS.has(currentView)) {
        $bar.addClass('toolbar-bar--hidden');
        return;
    }
    $bar.removeClass('toolbar-bar--hidden');

    // Show/hide each group and separator based on ctx list
    $bar.find('[data-toolbar-ctx]').each(function() {
        const ctxList = $(this).attr('data-toolbar-ctx').split(' ');
        $(this).toggleClass('toolbar-ctx--hidden', !ctxList.includes(currentView));
    });
}

export function enableDiffTab() {
    $('#diff-tab-btn').prop('disabled', false);
}

export function disableDiffTab() {
    const btn = $('#diff-tab-btn');
    btn.prop('disabled', true);
    if (state.activeView === 'diff') switchView('pdf');
}

export function showStatus(msg, progress = '') {
    $('#status-bar').show();
    $('#status-msg').text(msg);
    $('#status-progress').text(progress);
}

export function hideStatus() {
    $('#status-bar').hide();
}
