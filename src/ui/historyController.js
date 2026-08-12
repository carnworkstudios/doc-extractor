/**
 * historyController.js
 * Wires #btn-undo / #btn-redo toolbar buttons and Ctrl+Z / Ctrl+Y keyboard
 * shortcut to the structural ContentHistory stack, and drives native
 * execCommand undo/redo for typing/formatting so the key always resolves
 * to something even when the host (e.g. the VS Code webview) would
 * otherwise intercept it first. See the keydown handler below for why.
 */

import $ from 'jquery';
import { state } from '../state.js';
import { ContentHistory } from './contentHistory.js';
import { applyHtmlEverywhere } from './htmlSync.js';
import { initTableFeatures } from '../utils/tableLogic.js';
import { refreshZoneToolbar } from './zoneToolbar.js';
import { showToast } from './toast.js';

// One shared history instance for the HTML surface.
export const htmlHistory = new ContentHistory(50);

// ── Public API used by mutation sites ────────────────────────────────────────

/**
 * Call BEFORE any structural mutation to save the pre-change state.
 * Reads innerHTML from #html-preview (the canonical source of truth).
 */
export function pushSnapshot() {
    const el = document.getElementById('html-preview');
    if (el && !htmlHistory.isRestoring) htmlHistory.push(el.innerHTML);
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initHistoryController() {
    $('#btn-undo').on('click', performUndo);
    $('#btn-redo').on('click', performRedo);

    // Keyboard: Ctrl+Z / Ctrl+Y always resolve through this handler, even
    // while a contenteditable element is focused.
    //
    // The comment this replaced said to defer to the browser's native undo
    // stack while typing, on the assumption that document.execCommand
    // ('undo') fires on its own from the raw keydown. That holds in a plain
    // browser tab, but inside the VS Code webview the host editor's global
    // `ctrl+z`/`cmd+z` keybinding can intercept the key before the native
    // contenteditable undo ever runs, so nothing happens. Explicitly driving
    // execCommand ourselves — and stopping the event before it can bubble to
    // that host keybinding — fixes the webview case and is a no-op change in
    // a normal browser, where execCommand('undo') is exactly what native
    // Ctrl+Z already triggers.
    //
    // Structural mutations (zone reorder/split/group, insert-box, add-page,
    // column split) still go through the custom ContentHistory stack via
    // performUndo/performRedo; typing/bold/italic/list edits stay on the
    // browser's own undo manager via execCommand.
    document.addEventListener('keydown', (e) => {
        const view = state.activeView;
        if (view !== 'html' && view !== 'visual-diff') return;

        const isUndo = (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z';
        const isRedo = (e.ctrlKey || e.metaKey) &&
            ((e.shiftKey && e.key.toLowerCase() === 'z') || e.key.toLowerCase() === 'y');
        if (!isUndo && !isRedo) return;

        const active = document.activeElement;
        const isContentEditable = active?.isContentEditable;

        e.preventDefault();
        e.stopPropagation();

        if (isContentEditable) {
            // Native undo/redo for typing and inline formatting. Falls
            // through to the structural stack below when there is nothing
            // left for the browser to undo (e.g. the surface was just
            // restored from a structural snapshot and has no native history
            // of its own yet).
            const did = document.execCommand(isUndo ? 'undo' : 'redo');
            if (did) return;
        }

        if (isUndo) performUndo();
        else performRedo();
    });

    syncUndoRedoUI();
}

// ── Core actions ──────────────────────────────────────────────────────────────

export function performUndo() {
    const snapshot = htmlHistory.undo();
    if (!snapshot) { showToast('Nothing to undo', 'info'); return; }
    _restore(snapshot);
    showToast('Undo', 'success');
}

export function performRedo() {
    const snapshot = htmlHistory.redo();
    if (!snapshot) { showToast('Nothing to redo', 'info'); return; }
    _restore(snapshot);
    showToast('Redo', 'success');
}

/**
 * Apply a snapshot to all surfaces and re-wire features.
 * Mirrors the pattern from tableHistory.js's performUndo/performRedo.
 */
function _restore(snapshot) {
    htmlHistory.isRestoring = true;
    try {
        applyHtmlEverywhere(snapshot, null);
        const el = document.getElementById('html-preview');
        if (el) initTableFeatures(el);
        refreshZoneToolbar();
    } finally {
        htmlHistory.isRestoring = false;
    }
    syncUndoRedoUI();
}

export function syncUndoRedoUI() {
    const canUndo = htmlHistory.canUndo();
    const canRedo = htmlHistory.canRedo();
    $('#btn-undo').prop('disabled', !canUndo).toggleClass('disabled', !canUndo);
    $('#btn-redo').prop('disabled', !canRedo).toggleClass('disabled', !canRedo);
}
