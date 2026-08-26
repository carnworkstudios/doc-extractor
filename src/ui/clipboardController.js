/**
 * clipboardController.js
 * Ctrl+C / Ctrl+X / Ctrl+V for the Doc (contenteditable) and Editor (Monaco)
 * surfaces, driven explicitly instead of left to native/host handling.
 *
 * Same root cause as the undo/redo fix in historyController.js: inside the
 * VS Code webview, the host editor's global clipboard keybindings can
 * intercept Ctrl+C/X/V before either the browser's native contenteditable
 * handling or Monaco's own internal handling ever sees the key — so neither
 * copy nor paste does anything. Explicitly driving the action ourselves and
 * stopping the event before it can bubble to that host keybinding fixes the
 * webview case; it is a no-op change in a plain browser tab, where this is
 * exactly what native Ctrl+C/X/V already does.
 *
 * `execCommand('copy'|'cut')` is reliable everywhere, including here — it is
 * `execCommand('paste')` specifically that Chromium/Electron disables by
 * default for security. Paste goes through the async Clipboard API instead.
 */

import { state } from '../state.js';

export function initClipboardController() {
    document.addEventListener('keydown', (e) => {
        const key = e.key.toLowerCase();
        const isCopy = (e.ctrlKey || e.metaKey) && key === 'c';
        const isCut = (e.ctrlKey || e.metaKey) && key === 'x';
        const isPaste = (e.ctrlKey || e.metaKey) && key === 'v';
        if (!isCopy && !isCut && !isPaste) return;

        const view = state.activeView;

        if (view === 'editor' && state.monacoEditor) {
            const editor = state.monacoEditor;
            if (!editor.hasTextFocus()) return;
            e.preventDefault();
            e.stopPropagation();
            if (isCopy) editor.trigger('keyboard', 'editor.action.clipboardCopyAction', null);
            else if (isCut) editor.trigger('keyboard', 'editor.action.clipboardCutAction', null);
            else pasteIntoMonaco(editor);
            return;
        }

        if (view === 'html') {
            const active = document.activeElement;
            if (!active?.isContentEditable) return;
            e.preventDefault();
            e.stopPropagation();
            if (isCopy) document.execCommand('copy');
            else if (isCut) document.execCommand('cut');
            else pasteIntoContentEditable();
        }
    });
}

async function pasteIntoMonaco(editor) {
    let text;
    try {
        text = await navigator.clipboard.readText();
    } catch (err) {
        console.warn('[clipboard] readText failed — clipboard-read may not be permitted here:', err);
        return;
    }
    if (!text) return;
    const selection = editor.getSelection();
    if (!selection) return;
    editor.executeEdits('paste', [{ range: selection, text, forceMoveMarkers: true }]);
    editor.pushUndoStop();
}

async function pasteIntoContentEditable() {
    let text;
    try {
        text = await navigator.clipboard.readText();
    } catch (err) {
        console.warn('[clipboard] readText failed — clipboard-read may not be permitted here:', err);
        return;
    }
    if (!text) return;
    // insertText (unlike execCommand('paste')) is reliably supported and
    // goes through the same contenteditable input pipeline a native paste
    // would, so htmlSync's input listener marks the cache dirty as usual.
    document.execCommand('insertText', false, text);
}
