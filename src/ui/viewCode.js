/**
 * viewCode.js
 * "Edit Code" context menu action: opens the outerHTML of the right-clicked
 * content element in a Monaco editor dialog so the user can edit and apply it
 * back to the live rendered output.
 *
 * Triggered by docSelectionMenu.js calling openViewCode(targetEl).
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
import { markHtmlDirty } from './htmlSync.js';

const CONTENT_TAGS    = new Set(['H1','H2','H3','H4','H5','H6','DIV','P','ASIDE','UL','OL','HR','IMG','FIGURE','TABLE','BLOCKQUOTE','PRE','SECTION']);
const REGION_SELECTOR = '.pdf-region, .pdf-zone, .pdf-table-wrap';

// The blocks gxDocToHtml actually emits. `_resolveTarget` used to require a
// REGION_SELECTOR ancestor, but extracted documents are made of these classes
// and carry no .pdf-region wrapper at all — so Edit Code resolved to null on
// ordinary paragraphs and did nothing at all. Anything here is editable.
const BLOCK_SELECTOR =
    '.pdf-paragraph, .pdf-list-wrap, .pdf-box, .pdf-table-wrap, ' +
    '.pdf-image-placeholder, .pdf-col, .pdf-page-row, .pdf-page-content';

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

    window.GxPointer.onPress(document.getElementById('vc-apply'), _applyCode);
    window.GxPointer.onPress(document.getElementById('vc-cancel'), () => _dialog.close());
    window.GxPointer.onPress(document.getElementById('vc-close'),  () => _dialog.close());

    // Close on backdrop click
    _dialog.addEventListener('click', e => { if (e.target === _dialog) _dialog.close(); });

    // Lazy-create Monaco and populate the editor when the dialog opens
    _dialog.addEventListener('toggle', _onDialogToggle);
}

// ── Called by docSelectionMenu.js ───────────────────────────────────────────

/**
 * Resolve the best editable element from the raw target, then open the code
 * editor dialog.
 * @param {Element} rawTarget  — e.target from contextmenu, or the element a
 *   text selection resolved to (see docSelectionMenu.js)
 * @returns {boolean} whether a target was resolved and the dialog opened.
 *   Callers use this to tell the user nothing happened rather than leaving
 *   the click looking broken.
 */
export function openViewCode(rawTarget) {
    const el = _resolveTarget(rawTarget);
    if (!el) return false;

    _currentEl = el;
    _pending   = el.outerHTML;

    // Label: tag + short text preview
    const tag     = el.tagName.toLowerCase();
    const snippet = el.textContent.trim().slice(0, 48);
    if (_label) {
        _label.textContent = `<${tag}>${snippet ? '  ' + snippet + (snippet.length === 48 ? '…' : '') : ''}`;
    }

    _dialog.showModal();
    return true;
}

// ── Target resolution ─────────────────────────────────────────────────────────

/**
 * Walk up from the clicked node to the nearest element worth editing.
 *
 * Order matters: a region/zone wrapper wins over a bare tag, and an extracted
 * block (.pdf-paragraph &c.) wins over the generic DIV/P fallback, so the
 * dialog opens on the smallest meaningful unit rather than on whatever
 * happens to be a DIV first.
 */
function _resolveTarget(node) {
    // The node may be a text node (a selection's startContainer).
    let el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;

    // Only edit inside a prose surface — never the browser chrome or the
    // popover that launched this.
    const surface = el?.closest?.('.prose-area');
    if (!surface) return null;

    while (el && el !== surface) {
        if (el.matches?.(REGION_SELECTOR)) return el;
        if (el.matches?.(BLOCK_SELECTOR)) return el;
        if (CONTENT_TAGS.has(el.tagName)) return el;
        el = el.parentElement;
    }
    // Nothing granular matched — editing the whole surface is not useful.
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

    markHtmlDirty();
    _dialog.close();
}
