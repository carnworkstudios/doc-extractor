/**
 * monacoSetup.js
 * Creates and manages the Monaco HTML editor instance.
 * vite-plugin-monaco-editor handles the worker configuration automatically.
 */

import * as monaco from 'monaco-editor';
import { state } from '../state.js';
import { applyHtmlEverywhere, isSyncing } from '../ui/htmlSync.js';
import { registerPositionSurface } from '../ui/scrollSync.js';

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
        theme: document.documentElement.dataset.theme === 'dark' ? 'vs-dark' : 'vs',
        automaticLayout: true,
        wordWrap: 'on',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        tabSize: 2,
        formatOnPaste: true,
    });

    state.monacoEditor = editor;

    window.addEventListener('pdf-theme-change', event => {
        monaco.editor.setTheme(event.detail?.theme === 'dark' ? 'vs-dark' : 'vs');
    });

    // Monaco participates in the same page+fraction coordinate as PDF, Doc,
    // and Analyze. Page markers already exist in the canonical HTML, so no
    // parallel navigation index is needed.
    let markerVersion = -1;
    let markers = [];
    const pageMarkers = () => {
        const model = editor.getModel();
        if (!model) return [];
        const version = model.getVersionId();
        if (version === markerVersion) return markers;
        markerVersion = version;
        markers = [];
        const text = model.getValue();
        const re = /<section\b[^>]*\bdata-page\s*=\s*["']?(\d+)/gi;
        let match;
        while ((match = re.exec(text))) {
            markers.push({ page: Number(match[1]), line: model.getPositionAt(match.index).lineNumber });
        }
        return markers;
    };

    registerPositionSurface({
        isLive: () => !document.getElementById('pane-editor')?.hidden,
        readPosition: () => {
            const list = pageMarkers();
            if (!list.length) return null;
            const line = editor.getVisibleRanges()[0]?.startLineNumber || editor.getPosition()?.lineNumber || 1;
            let i = list.findIndex((m, index) => line < (list[index + 1]?.line ?? Infinity));
            if (i < 0) i = list.length - 1;
            const cur = list[i];
            const nextLine = list[i + 1]?.line ?? (editor.getModel()?.getLineCount() || cur.line + 1) + 1;
            const fraction = Math.max(0, Math.min(0.9999, (line - cur.line) / Math.max(1, nextLine - cur.line)));
            return (cur.page - 1) + fraction;
        },
        followPosition: (pos) => {
            const list = pageMarkers();
            if (!list.length) return;
            const page = Math.floor(pos) + 1;
            const fraction = pos - Math.floor(pos);
            const exact = list.findIndex(m => m.page === page);
            let i = exact;
            if (i < 0) {
                i = 0;
                while (i + 1 < list.length && list[i + 1].page < page) i++;
            }
            const cur = list[i];
            const nextLine = list[i + 1]?.line ?? (editor.getModel()?.getLineCount() || cur.line + 1) + 1;
            const line = Math.round(cur.line + fraction * Math.max(1, nextLine - cur.line));
            editor.revealLineNearTop(line);
        },
        subscribe: (drive) => editor.onDidScrollChange(e => {
            if (e.scrollTopChanged) drive();
        }),
    });

    // A selection in the rendered document should identify the same text in
    // source view. Scope the lookup to its data-page section so repeated table
    // headings on other pages do not steal the match.
    let selectionFrame = 0;
    document.addEventListener('selectionchange', () => {
        cancelAnimationFrame(selectionFrame);
        selectionFrame = requestAnimationFrame(() => {
            const pane = document.getElementById('pane-editor');
            const selection = window.getSelection();
            if (pane?.hidden || !selection || selection.isCollapsed || !selection.rangeCount) return;

            const range = selection.getRangeAt(0);
            const startEl = range.startContainer.nodeType === Node.ELEMENT_NODE
                ? range.startContainer
                : range.startContainer.parentElement;
            if (!startEl?.closest('#html-preview')) return;

            const page = Number(startEl.closest('section.pdf-page-content[data-page]')?.dataset.page);
            const list = pageMarkers();
            const markerIndex = list.findIndex(marker => marker.page === page);
            if (markerIndex < 0) return;

            const model = editor.getModel();
            const startLine = list[markerIndex].line;
            const endLine = (list[markerIndex + 1]?.line ?? ((model?.getLineCount() || startLine) + 1)) - 1;
            const scope = new monaco.Range(startLine, 1, endLine, model?.getLineMaxColumn(endLine) || 1);
            const text = selection.toString().trim();
            if (!text) return;

            const escaped = text
                .replaceAll('&', '&amp;')
                .replaceAll('<', '&lt;')
                .replaceAll('>', '&gt;');
            const candidates = [...new Set([text, text.replaceAll('\u00a0', ' '), escaped])];
            let match = null;
            for (const query of candidates) {
                match = model?.findMatches(query, scope, false, false, null, false)?.[0] || null;
                if (match) break;
            }
            if (!match) return;

            editor.setSelection(match.range);
            editor.revealRangeInCenterIfOutsideViewport(match.range);
        });
    });

    // Monaco edits → state + previews. The isSyncing() guard skips the
    // synchronous re-fire that occurs when applyHtmlEverywhere itself
    // calls model.setValue() during a cross-surface mirror.
    editor.onDidChangeModelContent(() => {
        if (isSyncing()) return;
        applyHtmlEverywhere(editor.getValue(), null);
    });

    return editor;
}
