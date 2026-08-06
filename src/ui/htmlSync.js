/**
 * htmlSync.js
 * Single source-of-truth coordinator for the extracted HTML.
 *
 * Three surfaces render the same `state.pdf1.extractedHTML`:
 *   1. #html-preview         — HTML tab,        contenteditable
 *   2. #visual-diff-html     — Visual Diff,     contenteditable
 *   3. Monaco editor model   — Editor tab,      monaco editable
 *
 * Edits on any surface flow back to state and forward to the other two,
 * gated by a single re-entrancy flag so the bidirectional handlers
 * (monaco onChange + preview input listeners) don't ping-pong.
 *
 * Sanitization: contenteditable input fires per-keystroke; sanitizing on the
 * surface the user is typing in would erase their cursor. We therefore only
 * sanitize when WRITING into a surface (cross-surface mirror + Monaco set),
 * never on read.
 */

import { state } from '../state.js';
import { initTableFeatures } from '../utils/tableLogic.js';
import { getImageBlob } from '../utils/imageStore.js';
import { rebindTableEditing } from './tableEditorInit.js';

let _syncing = false;
const _debouncers = new WeakMap();
const objectUrlCache = {};

const SURFACE_IDS = ['html-preview', 'visual-diff-html'];
const DEBOUNCE_MS = 200;

/** True while a programmatic write is in flight. Edit handlers must early-return. */
export function isSyncing() { return _syncing; }

/**
 * Wire input listeners on every contenteditable preview surface.
 * Call once on app startup.
 */
export function initHTMLSync() {
    SURFACE_IDS.forEach(wirePreview);
}

function wirePreview(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
        if (_syncing) return;
        const prev = _debouncers.get(el);
        if (prev) clearTimeout(prev);
        const t = setTimeout(() => applyHtmlEverywhere(el.innerHTML, el), DEBOUNCE_MS);
        _debouncers.set(el, t);
    });
}

export function stripTableRulers(html) {
    if (!html || typeof html !== 'string') return html;
    if (!html.includes('tafne-ruler-wrap')) return html;
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('.tafne-ruler-wrap').forEach(wrap => {
        const table = wrap.querySelector('table');
        if (table) {
            wrap.replaceWith(table);
        } else {
            wrap.remove();
        }
    });
    return doc.body.innerHTML;
}

/**
 * Write `html` to state, both preview surfaces, and Monaco.
 * @param {string} html
 * @param {Element|null} skipEl  — surface to leave untouched (preserves caret
 *   on the surface the user is currently typing in). Pass null on extraction.
 */
export function applyHtmlEverywhere(html, skipEl = null) {
    if (_syncing) return;
    _syncing = true;
    try {
        const cleanForState = stripTableRulers(html);
        state.pdf1.extractedHTML = cleanForState;
        const clean = sanitize(cleanForState);

        for (const id of SURFACE_IDS) {
            const el = document.getElementById(id);
            if (!el || el === skipEl) continue;
            if (el.innerHTML !== clean) {
                el.innerHTML = clean;
                // Re-bind crosshair / VisualGridMapper to any tables inside.
                initTableFeatures(el);
                rebindTableEditing();
                hydrateImages(el);
            }
        }

        const editor = state.monacoEditor;
        if (editor && editor.getValue() !== cleanForState) {
            editor.getModel()?.setValue(cleanForState);
        }
    } finally {
        _syncing = false;
    }
}

function sanitize(html) {
    return typeof window.DOMPurify !== 'undefined'
        ? window.DOMPurify.sanitize(html, { ADD_TAGS: ['img'], ALLOW_DATA_ATTR: true })
        : html;
}

/**
 * Replace the HTML for a single page in all surfaces without touching other pages.
 * Called by analyzePanel after a 'reprocess' result arrives.
 * @param {number} pageNum  — 1-based page number (matches data-page attribute)
 * @param {string} newHtml  — new page HTML from assemblePage
 */
export function patchPageHtml(pageNum, newHtml) {
    if (_syncing) return;
    _syncing = true;
    try {
        const clean = sanitize(newHtml);

        // Replace in live surfaces
        for (const id of SURFACE_IDS) {
            const container = document.getElementById(id);
            if (!container) continue;
            const existing = container.querySelector(`[data-page="${pageNum}"]`);
            if (!existing) continue;
            const tmp = document.createElement('div');
            tmp.innerHTML = clean;
            const newSection = tmp.querySelector(`[data-page="${pageNum}"]`) || tmp.firstElementChild;
            if (newSection) {
                existing.replaceWith(newSection);
                initTableFeatures(container);
                hydrateImages(container);
            }
        }

        // Rebuild full state HTML from the live preview surface
        const preview = document.getElementById('html-preview');
        if (preview) {
            state.pdf1.extractedHTML = preview.innerHTML;
            const editor = state.monacoEditor;
            if (editor && editor.getValue() !== state.pdf1.extractedHTML) {
                editor.getModel()?.setValue(state.pdf1.extractedHTML);
            }
        }
    } finally {
        _syncing = false;
    }
}

/**
 * Explicitly sync state.pdf1.extractedHTML to a specific DOM surface on focus.
 * Supports lazy DOM mirroring for batch operations.
 * @param {string} surfaceId — 'html-preview' | 'visual-diff-html' | 'monaco'
 */
export function syncStateToDOMOnFocus(surfaceId = 'html-preview') {
    if (_syncing) return;
    _syncing = true;
    try {
        const raw = state.pdf1.extractedHTML || '';
        const clean = sanitize(stripTableRulers(raw));

        if (surfaceId === 'monaco') {
            const editor = state.monacoEditor;
            if (editor && editor.getValue() !== raw) {
                editor.getModel()?.setValue(raw);
            }
        } else {
            const el = document.getElementById(surfaceId);
            if (el && el.innerHTML !== clean) {
                el.innerHTML = clean;
                initTableFeatures(el);
                rebindTableEditing();
                hydrateImages(el);
            }
        }
    } finally {
        _syncing = false;
    }
}

export async function hydrateImages(containerEl) {
    const images = containerEl.querySelectorAll('img[data-img-id]');
    for (const img of images) {
        const id = img.getAttribute('data-img-id');
        
        if (objectUrlCache[id]) {
            img.src = objectUrlCache[id];
            continue;
        }

        try {
            const blob = await getImageBlob(id);
            if (blob) {
                const url = URL.createObjectURL(blob);
                objectUrlCache[id] = url;
                img.src = url;
            }
        } catch (e) {
            console.warn(`Failed to hydrate image ${id}`, e);
        }
    }
}

