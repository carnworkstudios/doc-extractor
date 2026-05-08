/**
 * monacoSetup.js
 * Creates and manages the Monaco HTML editor instance.
 * vite-plugin-monaco-editor handles the worker configuration automatically.
 */

import * as monaco from 'monaco-editor';
import { state } from '../state.js';
import { applyHtmlEverywhere, isSyncing } from '../ui/htmlSync.js';

/**
 * Initialize the Monaco HTML editor in #monaco-editor-container.
 * Call once on app startup.
 */
export function initMonacoEditor() {
    const container = document.getElementById('monaco-editor-container');
    if (!container) return;

    const editor = monaco.editor.create(container, {
        value: '',
        language: 'html',
        theme: 'vs-dark',
        automaticLayout: true,
        wordWrap: 'on',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        tabSize: 2,
        formatOnPaste: true,
    });

    state.monacoEditor = editor;

    // Monaco edits → state + previews. The isSyncing() guard skips the
    // synchronous re-fire that occurs when applyHtmlEverywhere itself
    // calls model.setValue() during a cross-surface mirror.
    editor.onDidChangeModelContent(() => {
        if (isSyncing()) return;
        applyHtmlEverywhere(editor.getValue(), null);
    });

    return editor;
}
