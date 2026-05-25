/**
 * viewCode.js
 * "Edit Code" context menu action: opens the outerHTML of the right-clicked
 * content element in a Monaco editor dialog so the user can edit and apply it
 * back to the live rendered output.
 *
 * Triggered by contextMenu.js calling openViewCode(targetEl).
 * Does NOT intercept right-click — the normal context menu appears first,
 * and "Edit Code" is one of its items.
 *
 * Target resolution: resolves the nearest meaningful content element
 * (h3, h4, div, p, aside, ul, ol, table-wrap, hr, img) inside a pdf-region/zone.
 * Falls back to the region/zone itself.
 *
 * Monaco deferred-setValue pattern (same as TAFNE multi-cell edit):
 *   store pending value → showModal() → dialog 'toggle' → layout() + setValue()
 */

import * as monaco from 'monaco-editor';
import { applyHtmlEverywhere } from './htmlSync.js';

const CONTENT_TAGS    = new Set(['H3','H4','H5','H6','DIV','P','ASIDE','UL','OL','HR','IMG','FIGURE']);
const REGION_SELECTOR = '.pdf-region, .pdf-zone, .pdf-table-wrap';

let _dialog    = null;
let _label     = null;
let _container = null;
let _preview   = null;
let _editor    = null;    // dedicated Monaco instance (created once, reused)
let _currentEl = null;    // element whose outerHTML is loaded in the editor
let _pending   = null;    // outerHTML waiting for setValue after layout

// ── Public init ───────────────────────────────────────────────────────────────

export function initViewCode() {
    _dialog    = document.getElementById('view-code-dialog');
    _label     = document.getElementById('vc-element-label');
    _container = document.getElementById('vc-monaco-container');
    _preview   = document.getElementById('html-preview');

    if (!_dialog || !_container || !_preview) return;

    document.getElementById('vc-apply')?.addEventListener('click',  _applyCode);
    document.getElementById('vc-cancel')?.addEventListener('click', () => _dialog.close());
    document.getElementById('vc-close')?.addEventListener('click',  () => _dialog.close());

    // Close on backdrop click
    _dialog.addEventListener('click', e => { if (e.target === _dialog) _dialog.close(); });

    // Lazy-create Monaco and populate the editor when the dialog opens
    _dialog.addEventListener('toggle', _onDialogToggle);
}

// ── Called by contextMenu.js ──────────────────────────────────────────────────

/**
 * Resolve the best editable element from the raw right-click target,
 * then open the code editor dialog.
 * @param {Element} rawTarget  — e.target from the contextmenu event
 */
export function openViewCode(rawTarget) {
    const el = _resolveTarget(rawTarget);
    if (!el) return;

    _currentEl = el;
    _pending   = el.outerHTML;

    // Label: tag + short text preview
    const tag     = el.tagName.toLowerCase();
    const snippet = el.textContent.trim().slice(0, 48);
    if (_label) {
        _label.textContent = `<${tag}>${snippet ? '  ' + snippet + (snippet.length === 48 ? '…' : '') : ''}`;
    }

    _dialog.showModal();
}

// ── Target resolution ─────────────────────────────────────────────────────────

/**
 * Walk up from the clicked node to find the nearest content-level element
 * that lives inside a .pdf-region or .pdf-zone (or is one itself).
 */
function _resolveTarget(node) {
    let el = node;
    while (el && el !== _preview) {
        if (CONTENT_TAGS.has(el.tagName) && el.closest(REGION_SELECTOR)) return el;
        if (el.matches?.(REGION_SELECTOR)) return el;
        el = el.parentElement;
    }
    return null;
}

// ── Dialog open → layout + setValue ──────────────────────────────────────────

function _onDialogToggle() {
    if (!_dialog.open) return;

    if (!_editor) _editor = _createEditor();

    // Defer one frame so the dialog has painted and Monaco can measure its container
    requestAnimationFrame(() => {
        _editor.layout();
        if (_pending !== null) {
            _editor.setValue(_pending);
            _editor.setPosition({ lineNumber: 1, column: 1 });
            _editor.revealLine(1);
            _pending = null;
        }
        _editor.focus();
    });
}

function _createEditor() {
    return monaco.editor.create(_container, {
        language:             'html',
        theme:                'vs-dark',
        automaticLayout:      false,
        wordWrap:             'on',
        minimap:              { enabled: false },
        tabSize:              2,
        formatOnPaste:        true,
        scrollBeyondLastLine: false,
    });
}

// ── Apply edited HTML back to DOM ─────────────────────────────────────────────

function _applyCode() {
    if (!_editor || !_currentEl) return;

    const raw    = _editor.getValue();
    const doc    = new DOMParser().parseFromString(raw, 'text/html');
    const parsed = doc.body.firstElementChild;

    if (!parsed) { _dialog.close(); return; }

    const activePreview = _currentEl.closest('.prose-area') || _preview;

    _currentEl.replaceWith(parsed);
    _currentEl = null;

    applyHtmlEverywhere(activePreview.innerHTML, activePreview);
    _dialog.close();
}
