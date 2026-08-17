/**
 * docVirtualizer.js
 * Windowed mounting for the Doc tab's extracted pages.
 *
 * WHY, measured on a 1236-page extraction (16 MB, 93,764 nodes in
 * #html-preview):
 *   - switching to the Doc tab took 740 ms, all of it initial layout
 *   - each keystroke cost ~30 ms
 * Neither is our own JS. The per-key listeners measure 0.1 ms total; the cost
 * is the browser's, and it scales with the size of the contenteditable root.
 * A smaller editable root is the only thing that moves it.
 *
 * WHAT IS *NOT* THE PROBLEM: mounting. Re-parsing ten pages from their HTML
 * costs 0.7 ms and re-attaching retained nodes rounds to 0. So this keeps
 * unmounted pages as plain strings rather than building a node cache — the
 * cheap thing does not need an index, and strings are what every reader
 * (export, Monaco, diff, MCP) ultimately wants anyway.
 *
 * THRESHOLD: documents at or under VIRTUALIZE_MIN_PAGES are left completely
 * alone. Virtualization costs real capability — the browser's Ctrl+F and
 * select-all only see mounted pages — and a 40-page document has nothing to
 * gain. Paying that price only where it buys something keeps the common case
 * exactly as it was.
 *
 * CORRECTNESS: an unmounted page is still part of the document. Anything that
 * reads the whole thing goes through `readFullHtml()`, which stitches the
 * cached strings back in at their original page positions. htmlSync's
 * extractedHTML getter uses it, so export / Monaco / Compare / MCP see the
 * true document whether or not a page happens to be on screen.
 */
import { state } from '../state.js';

const SURFACE_SEL = '#html-preview';
const PAGE_SEL = '.pdf-page-content';

/** Below this, do nothing at all. */
export const VIRTUALIZE_MIN_PAGES = 150;

/** Pages kept mounted either side of the viewport. */
const WINDOW_PAGES = 3;

let _active = false;
let _observer = null;
/** Set when an unmount was skipped because nothing had been laid out yet. */
let _pendingLayout = false;
/** pageNum -> { stub, html } for every page currently unmounted. */
const _parked = new Map();
/** Page order as it appeared at install time, so stitching preserves it. */
let _order = [];

export function isVirtualized() { return _active; }

/**
 * Install windowing on the current #html-preview contents, if the document is
 * big enough to be worth it. Safe to call repeatedly; always tears down first.
 */
export function installDocVirtualizer() {
    teardownDocVirtualizer();

    const surface = document.querySelector(SURFACE_SEL);
    if (!surface) return false;

    const pages = [...surface.querySelectorAll(PAGE_SEL)];
    if (pages.length <= VIRTUALIZE_MIN_PAGES) return false;

    _order = pages.map(p => _pageKey(p));

    // rootMargin in viewport heights: mount a few screens ahead so scrolling
    // meets already-laid-out content rather than a stub being filled in.
    const margin = Math.max(600, surface.clientHeight * WINDOW_PAGES);
    _observer = new IntersectionObserver(entries => {
        for (const e of entries) {
            // Pass the observer's own boundingClientRect through. Calling
            // getBoundingClientRect() inside the callback instead forces a
            // synchronous layout PER PAGE — profiled at 457 ms of the 1173 ms
            // first switch, across 1232 unmounts. The observer already
            // measured every one of these; re-measuring is pure waste.
            if (e.isIntersecting) _mount(e.target);
            else _unmount(e.target, e.boundingClientRect);
        }
    }, { root: surface, rootMargin: `${margin}px 0px ${margin}px 0px`, threshold: 0 });

    for (const page of pages) _observer.observe(page);
    _active = true;
    return true;
}

export function teardownDocVirtualizer() {
    _pendingLayout = false;
    if (_observer) { _observer.disconnect(); _observer = null; }
    // Put every parked page back so the DOM is whole again.
    for (const [, rec] of _parked) _restoreStub(rec);
    _parked.clear();
    _order = [];
    _active = false;
}

/**
 * The full document, including pages that are currently unmounted.
 *
 * A stub carries its page's HTML, so this is a walk over the surface's direct
 * children swapping stubs for the string they stand in for — no re-mount, no
 * layout, and the result is byte-identical to what a non-virtualized surface
 * would have serialized.
 */
export function readFullHtml() {
    const surface = document.querySelector(SURFACE_SEL);
    if (!surface) return '';
    if (!_active || !_parked.size) return surface.innerHTML;

    // Stubs are NOT direct children of the surface — gxDocToHtml wraps pages in
    // <article class="pdf-doc">, so a stub sits one level down. Walking only
    // surface.childNodes silently dropped every parked page and produced a
    // document with 3 of 1235 pages in it. Clone the tree instead and swap
    // stubs in place, wherever they are.
    const clone = surface.cloneNode(true);
    for (const stub of clone.querySelectorAll('.gx-page-stub[data-gx-parked-page]')) {
        const rec = _parked.get(stub.dataset.gxParkedPage);
        if (rec) stub.outerHTML = rec.html;
        else stub.remove();     // no record: better absent than a stray stub
    }
    return clone.innerHTML;
}

/**
 * Mount every page so a whole-document operation can touch real nodes.
 * Used before things that must see the entire DOM (select-all, find, an
 * export path that walks the live surface rather than the string).
 */
export function mountAllPages() {
    if (!_active) return;
    for (const [, rec] of [..._parked]) _restoreStub(rec);
    _parked.clear();
    // Restoration creates new nodes, so the observer's registrations are stale.
    const surface = document.querySelector(SURFACE_SEL);
    if (surface && _observer) {
        _observer.disconnect();
        for (const page of surface.querySelectorAll(PAGE_SEL)) _observer.observe(page);
    }
}

/**
 * Replace the cached HTML for a page that is currently parked.
 *
 * A re-extract can target a page that is not mounted — the Analyze tab is a
 * different pane, so the Doc surface may have windowed that page away.
 * patchPageHtml's `querySelector('[data-page=N]')` finds nothing in that case
 * and silently does nothing, so the re-extraction is lost with no error.
 *
 * @returns {boolean} true if the page was parked and its cache was updated.
 */
export function updateParkedPage(pageNum, html) {
    if (!_active) return false;
    const key = String(pageNum);
    const rec = _parked.get(key);
    if (!rec) return false;
    rec.html = html;
    // The new content may be a different height; drop the pinned height so the
    // stub re-measures from the real page when it next mounts.
    if (rec.stub?.isConnected) rec.stub.style.height = '';
    return true;
}

/** Swap a stub back for the page it stands in for, in place. */
function _restoreStub(rec) {
    const parent = rec.stub?.parentNode;
    if (!parent) return;
    const tmp = document.createElement('template');
    tmp.innerHTML = rec.html;
    const fresh = tmp.content.firstElementChild;
    if (fresh) parent.replaceChild(fresh, rec.stub);
    else rec.stub.remove();
}

// ── internals ───────────────────────────────────────────────────────────────

function _pageKey(el) {
    return el.getAttribute('data-page') ?? String(_order.length);
}

function _unmount(pageEl, observedRect) {
    if (!pageEl.isConnected || pageEl.dataset.gxParkedPage != null) return;
    // Never unmount the page the caret is in — that would destroy a live edit.
    if (pageEl.contains(document.activeElement)) return;

    const key = _pageKey(pageEl);
    // Prefer the observer's measurement; only fall back to a forced layout
    // when called from somewhere that has no rect to hand.
    const rect = observedRect ?? pageEl.getBoundingClientRect();
    // A zero height means the surface has not been laid out yet — the Doc tab
    // is still [hidden], so every page measures 0 and the whole document
    // "fits". Parking on that measurement would collapse the scroll height to
    // nothing. Bail, but remember to try again once the surface is visible;
    // the observer will not re-fire on its own for a page whose intersection
    // state never changed.
    if (!rect.height) { _pendingLayout = true; return; }

    const html = pageEl.outerHTML;
    const stub = document.createElement('div');
    stub.className = 'gx-page-stub';
    stub.dataset.gxParkedPage = key;
    // Hold the exact height so scroll position and the scrollbar do not jump.
    stub.style.height = `${Math.round(rect.height)}px`;

    _observer.unobserve(pageEl);
    pageEl.replaceWith(stub);
    _parked.set(key, { stub, html });
    _observer.observe(stub);
}

function _mount(stubEl) {
    const key = stubEl.dataset?.gxParkedPage;
    if (key == null) return;               // already a real page
    const rec = _parked.get(key);
    if (!rec) return;

    // Replace via a range on the stub's own parent rather than a surface-wide
    // querySelector: pages are nested inside <article class="pdf-doc">, and a
    // document-order scan per mount is a full-surface walk on every scroll.
    const parent = stubEl.parentNode;
    if (!parent) return;

    _observer.unobserve(stubEl);
    const tmp = document.createElement('template');
    tmp.innerHTML = rec.html;
    const fresh = tmp.content.firstElementChild;
    if (!fresh) { _parked.delete(key); return; }

    parent.replaceChild(fresh, stubEl);
    _parked.delete(key);
    _observer.observe(fresh);

    // The parked string references pictures by store key, so a page coming back
    // into view has to be re-hydrated or its figures mount blank. A page parked
    // before its first hydration finished never had a blob: URL to preserve.
    // Dynamic import: htmlSync imports this module, and a static edge back
    // would close the cycle.
    if (fresh.querySelector?.('img[data-img-id]')) {
        import('./htmlSync.js').then(m => m.hydrateImages(fresh)).catch(() => {});
    }
}

/**
 * Re-run the windowing decision now that the surface has layout.
 *
 * The Doc pane is [hidden] until its tab is selected, so at mount time every
 * page measures 0 and nothing can be parked. An IntersectionObserver will not
 * re-fire for a page whose intersection state never changed, so this has to
 * be prodded explicitly the first time the surface becomes visible.
 *
 * Called from workspaceLayout when the Doc pane is shown. Cheap and idempotent:
 * it only reinstalls when a previous pass was starved of measurements.
 */
export function onDocSurfaceVisible() {
    if (!_active || !_pendingLayout) return;
    const surface = document.querySelector(SURFACE_SEL);
    if (!surface || !surface.clientHeight) return;
    _pendingLayout = false;

    // Re-observing is enough — a fresh observe() delivers an initial callback
    // for every target with its current intersection state, which is exactly
    // the missing measurement. Calling installDocVirtualizer() here instead
    // tore the whole thing down first (restoring all 1232 pages, then parking
    // them again): profiled at 575 ms of install plus 101 ms of restore, for
    // a result identical to just re-observing.
    if (!_observer) return;
    _observer.disconnect();
    for (const page of surface.querySelectorAll(PAGE_SEL)) _observer.observe(page);
    for (const [, rec] of _parked) {
        if (rec.stub.isConnected) _observer.observe(rec.stub);
    }
}

/** True when the current document is large enough to want windowing. */
export function shouldVirtualize() {
    const surface = document.querySelector(SURFACE_SEL);
    if (!surface) return false;
    return surface.querySelectorAll(PAGE_SEL).length > VIRTUALIZE_MIN_PAGES;
}

// Re-install whenever a fresh document is mounted into the surface.
export function refreshDocVirtualizer() {
    if (shouldVirtualize()) installDocVirtualizer();
    else teardownDocVirtualizer();
    return _active;
}

// Keep state's page count honest for callers that ask.
export function parkedPageCount() { return _parked.size; }

export function _debugState() {
    return { active: _active, parked: _parked.size, order: _order.length, pdf: !!state.pdf1 };
}
