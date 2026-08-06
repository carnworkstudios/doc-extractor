/**
 * viewController.js
 * Manages the 5-tab view system: PDF | HTML | Editor | Visual Diff | Compare Diff
 */

import $ from 'jquery';
import { state } from '../state.js';
import { deactivateSelectionMode } from './selectionMode.js';
import { renderNavPanel } from './navPanel.js';

const VIEWS = ['analyze', 'pdf', 'html', 'editor', 'visual-diff', 'diff'];

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

    VIEWS.forEach(v => {
        $(`#view-${v}`).toggleClass('active', v === viewName);
    });

    $('.tab-btn[data-view]').each(function() {
        $(this).toggleClass('active', $(this).data('view') === viewName);
    });

    state.activeView = viewName;

    // Monaco needs layout() call when made visible
    if (viewName === 'editor' && state.monacoEditor) state.monacoEditor.layout();

    // Visual diff needs its own activation logic
    if (viewName === 'visual-diff') {
        const { activateVisualDiff } = await import('./visualDiff.js');
        activateVisualDiff();
    }

    if (viewName === 'diff') {
        const { refreshCompareDiff } = await import('./diffViewController.js');
        refreshCompareDiff();
    }

    syncToolbarToView(viewName);
    renderNavPanel();
}

import { getVisualDiffFocusedPane } from './visualDiff.js';

/** Returns active view, respecting visual-diff pane focus if active. */
export function getEffectiveActiveView() {
    if (state.activeView === 'visual-diff') {
        return getVisualDiffFocusedPane();
    }
    return state.activeView || 'pdf';
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

    const currentView = viewName || state.activeView || 'pdf';
    const targetCtx = currentView === 'visual-diff' ? getVisualDiffFocusedPane() : currentView;

    if (TOOLBAR_HIDDEN_VIEWS.has(targetCtx)) {
        $bar.addClass('toolbar-bar--hidden');
        return;
    }
    $bar.removeClass('toolbar-bar--hidden');

    // Show/hide each group and separator based on ctx list
    $bar.find('[data-toolbar-ctx]').each(function() {
        const ctxList = $(this).attr('data-toolbar-ctx').split(' ');
        $(this).toggleClass('toolbar-ctx--hidden', !ctxList.includes(targetCtx));
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
