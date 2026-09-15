/**
 * htmlSync.js
 * Single source-of-truth coordinator for the extracted HTML.
 *
 * Two surfaces render the same `state.pdf1.extractedHTML`:
 *   1. #html-preview         — HTML tab,        contenteditable
 *   2. Monaco editor model   — Editor tab,      monaco editable
 *
 * Edits on either surface flow back to state and forward to the other,
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
import { getImageBlob, docPrefix } from '../utils/imageStore.js';
import { rebindTableEditing } from './tableEditorInit.js';
import { readFullHtml, refreshDocVirtualizer, updateParkedPage } from './docVirtualizer.js';
import { refreshScrollSync, invalidatePageAnchors } from './scrollSync.js';

let _syncing = false;
const _debouncers = new WeakMap();
const objectUrlCache = {};

const SURFACE_IDS = ['html-preview'];
const DEBOUNCE_MS = 200;

/** True while a programmatic write is in flight. Edit handlers must early-return. */
export function isSyncing() { return _syncing; }

// ── Lazy document serialization ──────────────────────────────────────────────
//
// Every edit used to push the WHOLE document through: serialize #html-preview
// (51 ms on a 1236-page extraction), stripTableRulers, DOMPurify (432 ms),
// compare against the live innerHTML (59 ms), then hand Monaco a 16 MB string.
// Measured end-to-end for one Bold: 1565 ms. All of it O(document) for a
// change to one paragraph.
//
// The fix is to stop treating `state.pdf1.extractedHTML` as something an edit
// must WRITE, and treat it as something a reader DERIVES. #html-preview is
// already the live truth — it holds the edit the moment execCommand runs. So
// an edit just marks the cache stale; the string is rebuilt on the next read,
// once, no matter how many edits happened in between.
//
// Done as an accessor on state.pdf1 so all 26 existing read sites keep working
// unchanged — none of them has to know the value is now computed.
let _htmlCache = '';
let _htmlDirty = false;

function _installLazyHtml() {
    const target = state.pdf1;
    // Seed from whatever the plain property held (extraction may have run).
    _htmlCache = target.extractedHTML || '';
    Object.defineProperty(target, 'extractedHTML', {
        configurable: true,
        enumerable: true,
        get() {
            if (_htmlDirty) {
                const el = document.getElementById('html-preview');
                // readFullHtml() stitches back any page the virtualizer has
                // unmounted, so a reader never sees a truncated document just
                // because part of it is off screen. Falls through to plain
                // innerHTML when virtualization is off (small documents).
                if (el) _htmlCache = stripTableRulers(readFullHtml() || el.innerHTML);
                _htmlDirty = false;
            }
            return _htmlCache;
        },
        set(v) {
            _htmlCache = v || '';
            _htmlDirty = false;
        },
    });
}

/**
 * Record that the live preview has diverged from the cached string.
 *
 * This is what an edit calls instead of applyHtmlEverywhere. It is O(1) — no
 * serialize, no sanitize, no Monaco write. The document is reassembled lazily
 * by the getter above, and Monaco is refreshed when the Editor tab is opened
 * (see syncMonacoFromState).
 */
export function markHtmlDirty() {
    if (_syncing) return;
    _htmlDirty = true;
    // The write-back belongs HERE, not in applyHtmlEverywhere. That function
    // runs on load, history and Monaco — never on a keystroke in the Doc view,
    // which is the edit the user actually makes. Hooking it there meant typing
    // in the Doc never reached the host at all, so sync looked one-way.
    _queueHostEdit(() => state.pdf1.extractedHTML);
}

/**
 * Push the current document into Monaco. Called when the Editor tab becomes
 * visible rather than on every edit — a 16 MB setValue is not something to do
 * behind a Bold button.
 */
export function syncMonacoFromState() {
    const editor = state.monacoEditor;
    if (!editor) return;
    const html = state.pdf1.extractedHTML;
    if (editor.getValue() !== html) editor.getModel()?.setValue(html);
}

/**
 * Wire input listeners on every contenteditable preview surface.
 * Call once on app startup.
 */
export function initHTMLSync() {
    _installLazyHtml();
    SURFACE_IDS.forEach(wirePreview);
}

function wirePreview(id) {
    const el = document.getElementById(id);
    if (!el) return;
    // Typing marks the cache stale and nothing more. This used to debounce
    // into applyHtmlEverywhere, which meant every 200 ms pause while typing
    // paid a full serialize + sanitize of the entire document. The surface
    // being typed into was then skipped anyway, so the sanitized copy was
    // computed and thrown away.
    el.addEventListener('input', () => {
        if (_syncing) return;
        _htmlDirty = true;
        // Same reason as markHtmlDirty: this is the real edit path for typing.
        _queueHostEdit(() => state.pdf1.extractedHTML);
    });
}

export function stripTableRulers(html) {
    if (!html || typeof html !== 'string') return html;
    if (!html.includes('table-ide-ruler-wrap')) return html;
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('.table-ide-ruler-wrap').forEach(wrap => {
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

// ── VS Code write-back ──────────────────────────────────────────────────────
// Inside the VS Code webview the Doc is a view onto a real TextDocument, so an
// edit here has to become an edit there — that is what makes it participate in
// undo, dirty state and Save like any typed change.
//
// Debounced: applyHtmlEverywhere runs on every keystroke, and a WorkspaceEdit
// per character would fight the editor's own undo stack and make each keypress
// its own undo step. 400ms is past the end of normal typing bursts.
//
// No-op outside VS Code, where there is no host document to write to.
let _hostEditTimer = null;
// Text the host most recently gave us. Re-rendering after a host change calls
// applyHtmlEverywhere, which would otherwise push that same text straight back
// and start a ping-pong between the two surfaces. The host has its own echo
// guard; this is the matching half on this side.
let _lastHostText = null;
// Marks that the NEXT render came from the host, so the re-render it triggers
// is not pushed straight back.
//
// This cannot be a text comparison against the file: the host sends raw source,
// the Doc renders it through the parser, and what comes back out is normalised
// (implicit <tbody>, closed tags, re-ordered attributes). Those two strings are
// almost never equal, so comparing them would let every host-driven render echo
// back as an edit. A one-shot flag is the honest mechanism; the host's own
// echoGuard + lastWrittenContent is the authoritative half.
let _suppressNextPush = false;
export function noteHostText(text) {
    _lastHostText = text;
    _suppressNextPush = true;
}

function _pushEditToHost(html) {
    if (!(window.CwsBridge && window.CwsBridge.isEmbedded)) return;
    _queueHostEdit(() => html);
}

/**
 * Schedule a write-back to the VS Code document.
 *
 * `read` is called when the timer fires, NOT now. Typing in the Doc only flips
 * a dirty flag — assembling the document per keystroke is the cost this module
 * exists to avoid — so the HTML must be read at the END of the debounce, once,
 * via the lazy `extractedHTML` getter. Reading it up front would reintroduce
 * exactly the per-keystroke serialize that markHtmlDirty was written to remove.
 */
function _queueHostEdit(read) {
    if (!(window.CwsBridge && window.CwsBridge.isEmbedded)) return;
    clearTimeout(_hostEditTimer);
    _hostEditTimer = setTimeout(() => {
        let html;
        try { html = read(); } catch { return; }
        if (typeof html !== 'string') return;
        // Don't echo the host's own text back at it. Compared here rather than
        // when queueing because the text is only assembled now.
        if (_suppressNextPush) { _suppressNextPush = false; return; }
        if (_lastHostText !== null && html === _lastHostText) return;
        _lastHostText = html;
        try {
            window.CwsBridge.send('ginexys:edit', { content: html });
        } catch { /* host gone; the in-memory doc is still correct */ }
    }, 400);
}

export function applyHtmlEverywhere(html, skipEl = null) {
    if (_syncing) return;
    _syncing = true;
    try {
        const cleanForState = stripTableRulers(html);
        state.pdf1.extractedHTML = cleanForState;
        _pushEditToHost(cleanForState);

        // Which surfaces actually need writing? On an edit the answer is
        // "none" — the caret is in the only surface there is, so it is the
        // skipEl. Sanitizing first and discovering that afterwards spent
        // 432 ms of DOMPurify on a string nobody read.
        const targets = SURFACE_IDS
            .map(id => document.getElementById(id))
            .filter(el => el && el !== skipEl);

        if (targets.length) {
            const clean = sanitize(cleanForState);
            for (const el of targets) {
                if (el.innerHTML !== clean) {
                    el.innerHTML = clean;
                    // Re-bind crosshair / VisualGridMapper to any tables inside.
                    initTableFeatures(el);
                    rebindTableEditing();
                    hydrateImages(el);
                    // Fresh page nodes — re-window them (no-op under the
                    // page threshold).
                    refreshDocVirtualizer();
                    // Every cached scroll anchor was an offset into the
                    // document that just got replaced.
                    refreshScrollSync();
                }
            }
        }

        // Monaco is refreshed when the Editor tab opens (syncMonacoFromState),
        // not here. getValue()+setValue() on a 16 MB model is not something to
        // run behind every edit for a tab that may never be looked at.

        // A null skipEl means a WHOLE document arrived here (extraction,
        // import, history restore, batch mount) — not a keystroke. That is
        // the one signal injected surfaces need to re-bind to the new
        // document; see __GX_PDF_CORE__.onDocumentMounted.
        if (skipEl === null && targets.length) _dispatchDocumentMounted();
    } finally {
        _syncing = false;
    }
}

// ── Document-mounted channel ─────────────────────────────────────────────────
// The tool owns "a document is now mounted"; injected panels subscribe. Same
// replay-on-subscribe contract as the other __GX_PDF_CORE__ channels: a panel
// that boots after extraction still gets the last mount, never silence.
const _mountedCallbacks = [];
let _lastMounted = null;

/**
 * @param {(info: {docId: string|null, ts: number}) => void} cb
 */
export function onDocumentMounted(cb) {
    if (typeof cb !== 'function') return;
    _mountedCallbacks.push(cb);
    if (_lastMounted) cb(_lastMounted);   // replay — closes the boot race
}

function _dispatchDocumentMounted() {
    _lastMounted = { docId: state.pdf1.docId || null, ts: Date.now() };
    for (const cb of _mountedCallbacks) {
        try { cb(_lastMounted); } catch (err) { console.warn('[htmlSync] onDocumentMounted listener failed:', err); }
    }
}

function sanitize(html) {
    return typeof window.DOMPurify !== 'undefined'
        ? window.DOMPurify.sanitize(html, { ADD_TAGS: ['img'], ALLOW_DATA_ATTR: true, ADD_ATTR: ['style'] })
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
            if (!existing) {
                // Not in the live DOM — the virtualizer may have parked it.
                // Update the cached string so the re-extraction is not lost
                // when the page scrolls back into view.
                updateParkedPage(pageNum, clean);
                continue;
            }
            const tmp = document.createElement('div');
            tmp.innerHTML = clean;

            // assemblePage returns <article class="pdf-doc"><section data-page=N>.
            // Reaching straight for [data-page] pulls the SECTION out of that
            // wrapper — and every column rule is scoped `.pdf-doc .pdf-page-row`,
            // so a section re-inserted without a .pdf-doc ancestor loses
            // `display:grid` and every multi-column page collapses to one
            // full-width run. The Analyze canvas still drew the split (it reads
            // `regions`, which were correct), so the split looked applied and
            // rendered flat.
            //
            // Swap like for like: if the page being replaced sits under a
            // .pdf-doc, insert just the section; if it does not, keep the
            // incoming wrapper so the styles have something to hang off.
            const incomingSection = tmp.querySelector(`[data-page="${pageNum}"]`);
            const replacement = existing.closest('.pdf-doc')
                // Already under a .pdf-doc (per-page article, or the single
                // IR-path wrapper) — swap the section and inherit the styles.
                ? (incomingSection || tmp.firstElementChild)
                // No wrapper above it: keep the incoming <article class="pdf-doc">
                // so the column rules have an ancestor to match.
                : (incomingSection?.closest('.pdf-doc') || tmp.firstElementChild);

            if (replacement) {
                existing.replaceWith(replacement);
                initTableFeatures(container);
                hydrateImages(container);
                // This page's regions moved; every other page's anchors are
                // still valid, and re-measuring them all on a single-page
                // re-extract would be the expensive way to learn that.
                invalidatePageAnchors(pageNum);
            }
        }

        // The DOM is now the truth; let the accessor rebuild the string on the
        // next read. Assigning preview.innerHTML directly here would write a
        // TRUNCATED document whenever the virtualizer has pages parked, and
        // would re-introduce the per-patch Monaco setValue that the lazy sync
        // exists to avoid.
        _htmlDirty = true;
    } finally {
        _syncing = false;
    }
}

/**
 * Explicitly sync state.pdf1.extractedHTML to a specific DOM surface on focus.
 * Supports lazy DOM mirroring for batch operations.
 * @param {string} surfaceId — 'html-preview' | 'monaco'
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

/**
 * Drop every cached object URL.
 *
 * Scoped to one document when a `docId` is given, because several documents are
 * live at once — a compare slot, a batch — and revoking all of them because one
 * was replaced blanks the others. Called wherever a document's blobs are
 * deleted, so the cache cannot serve a URL whose blob is gone.
 */
export function resetImageHydration(docId = null) {
    const prefix = docId == null ? null : docPrefix(docId);
    for (const [key, url] of Object.entries(objectUrlCache)) {
        if (prefix && !key.startsWith(prefix)) continue;
        try { URL.revokeObjectURL(url); } catch (_) { /* already gone */ }
        delete objectUrlCache[key];
    }
}

/**
 * Resolve every `data-img-id` in a subtree to a blob: object URL.
 *
 * This is the step that puts pixels on screen. The document string holds only
 * keys, so any surface that has just been written — a fresh extraction, a
 * re-extracted page, a page the virtualizer brought back — has to be hydrated
 * or its pictures stay blank.
 */
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

