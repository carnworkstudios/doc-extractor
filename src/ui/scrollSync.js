/**
 * scrollSync.js
 * Keeps the panes pointed at the same place in the document.
 *
 * ── THE COORDINATE ───────────────────────────────────────────────────────────
 * The panes do not share a pixel space and never can: #pdf-canvas-container
 * shows the paper (117k px for this document), #html-preview shows the
 * extracted flow (140k px for the same document), and neither is a scaled copy
 * of the other — a dense table renders shorter than its page, a paragraph with
 * reflowed lines renders taller. Syncing on scroll percentage drifts by pages.
 *
 * So the panes are tied by DOCUMENT position, not by pixels:
 *
 *     pos = (page - 1) + fraction        // fraction ∈ [0,1) down that page
 *
 * Every surface converts to and from it, and nothing else is shared. Three
 * independent structures already carry what the conversion needs, which is why
 * this needs no new bookkeeping in the extraction:
 *
 *   1. The PAPER — `.page-wrapper[data-page][data-page-w][data-page-h]` in the
 *      canvas pane. The wrapper IS the page, so position within it is exactly
 *      the fraction. This is the reference: it cannot drift.
 *   2. The DOCUMENT — `section.pdf-page-content[data-page][data-page-width]` in
 *      the prose pane, and inside it every region's `data-ry`: the y the region
 *      was found at, in the source page's own space. That is the link between
 *      the two, and it is exact at every region.
 *   3. The ARTIFACTS — the analyze canvas addresses regions by {page, regionId}
 *      and renders one page at a time, so it follows the page component of the
 *      coordinate (see `followPage` on the analyze panel).
 *
 * ── WHY REGION ANCHORS AND NOT A RATIO ───────────────────────────────────────
 * Within one page the two panes still disagree — the extracted page is a
 * different height from the paper. But every `data-ry` is a point where they
 * are known to agree: that region is at source-y `ry` on the paper AND at its
 * own offset in the flow. Interpolating between consecutive anchors makes the
 * mapping exact at every region and linear in between, so a heading stays level
 * with its heading instead of sliding by half a page down a long one.
 *
 * A page with no regions falls back to proportional mapping, which is what a
 * ratio would have given everywhere.
 */

import { state } from '../state.js';

const DOC_SEL = '#html-preview';
const PDF_SEL = '#pdf-canvas-container';

// Where in the viewport "the place you are looking at" is. The top third reads
// better than the centre: you read downward, so the line you are on sits above
// the middle of the pane.
const ANCHOR_RATIO = 0.35;

let _enabled = true;
let _installed = false;
/** The pane that is currently driving. Prevents the echo becoming a feedback loop. */
let _driver = null;
let _releaseTimer = null;
let _rafPending = false;
/** page → { tops: number[], srcYs: number[], height: number } for the prose pane. */
const _anchorCache = new Map();

const _surfaces = [];      // extra surfaces registered by the host (analyze canvas)
const _positionSurfaces = []; // scrolling surfaces such as Monaco

// ── Geometry helpers ─────────────────────────────────────────────────────────

const _clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Piecewise-linear map through control points that ASCEND in x but may step
 * backwards in y (see `_docAnchors` — a column break does exactly that).
 *
 * Inside an ascending segment this is ordinary interpolation. Across a
 * descending one it snaps to the nearer endpoint instead of averaging: that
 * segment is not a gradient the reader passes through, it is the jump from the
 * foot of one column to the head of the next, and there is no position on the
 * paper corresponding to the middle of it.
 */
export function _interpFlow(xs, ys, x) {
    const n = xs.length;
    if (!n) return 0;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] <= x) lo = mid; else hi = mid;
    }
    const span = xs[hi] - xs[lo];
    if (span <= 0) return ys[lo];
    if (ys[hi] < ys[lo]) return (x - xs[lo]) < span / 2 ? ys[lo] : ys[hi];
    return ys[lo] + ((x - xs[lo]) / span) * (ys[hi] - ys[lo]);
}

/**
 * The inverse: a source y back to a flow offset.
 *
 * With a column break the answer is genuinely ambiguous — one y on the paper is
 * two places in the flow, once per column. `near` breaks the tie by continuity:
 * the candidate closest to where the pane already is, so scrolling the paper
 * moves the prose the short way rather than teleporting between columns.
 */
export function _inverseFlow(xs, ys, y, near) {
    const n = xs.length;
    if (n < 2) return xs[0] || 0;
    let best = null, bestD = Infinity;
    for (let i = 1; i < n; i++) {
        const y0 = ys[i - 1], y1 = ys[i];
        let cand;
        if (y1 > y0 && y >= y0 && y <= y1) cand = xs[i - 1] + ((y - y0) / (y1 - y0)) * (xs[i] - xs[i - 1]);
        else if (y < Math.min(y0, y1)) cand = xs[i - 1];
        else if (y > Math.max(y0, y1)) continue;
        else cand = xs[i - 1];
        const d = Math.abs(cand - near);
        if (d < bestD) { bestD = d; best = cand; }
    }
    return best == null ? xs[n - 1] : best;
}

/**
 * `el`'s box inside `scroller`'s scrollable content: {top, height}, both in the
 * scroller's own scroll units.
 *
 * Measured from rects, never from offsetTop/offsetHeight. The paper pane
 * fits pages to the pane with CSS `zoom` (0.61 at this window size), and unlike
 * `transform`, zoom changes layout — so a wrapper reports offsetHeight 1188 and
 * a rect of 727, and scrollTop moves in the second of those. Mixing the two put
 * the paper a fixed 0.29 × (source y) too far down every page, which reads as
 * "close, but drifting as you go down the page".
 */
function _boxIn(scroller, el) {
    const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const r = el.getBoundingClientRect();
    return { top: r.top - base, height: r.height || 1 };
}

/** Offset of `el` inside `scroller`'s scrollable content, in px. */
function _offsetIn(scroller, el) {
    return _boxIn(scroller, el).top;
}

const _docEl = () => document.querySelector(DOC_SEL);
const _pdfEl = () => document.querySelector(PDF_SEL);

/** A pane only participates while it is on screen and actually scrollable. */
function _live(el) {
    return !!el && el.isConnected && el.offsetParent !== null && el.scrollHeight > el.clientHeight + 4;
}

// ── The paper pane: page wrappers ────────────────────────────────────────────

function _pdfWrappers(scroller) {
    return [...scroller.querySelectorAll('.page-wrapper[data-page]')];
}

function _pdfToPos(scroller) {
    const wraps = _pdfWrappers(scroller);
    if (!wraps.length) return null;
    const y = scroller.scrollTop + scroller.clientHeight * ANCHOR_RATIO;
    for (const w of wraps) {
        const { top, height: h } = _boxIn(scroller, w);
        if (y < top + h || w === wraps[wraps.length - 1]) {
            const page = Number(w.dataset.page) || 1;
            return (page - 1) + _clamp((y - top) / h, 0, 0.9999);
        }
    }
    return null;
}

function _posToPdf(scroller, pos) {
    const page = Math.floor(pos) + 1;
    const frac = pos - Math.floor(pos);
    const w = scroller.querySelector(`.page-wrapper[data-page="${page}"]`);
    if (!w) return null;
    const box = _boxIn(scroller, w);
    return box.top + frac * box.height - scroller.clientHeight * ANCHOR_RATIO;
}

// ── The prose pane: page sections + region anchors ───────────────────────────

/**
 * The page's height in SOURCE space — the same space `data-ry` is measured in.
 *
 * `data-page-width` is the page width in that space, and the paper pane's
 * wrapper carries the page's true aspect, so the height follows. Without a
 * paper pane the aspect is unknown, and the last region on the page is the best
 * available lower bound (padded, since content stops before the page does).
 */
function _sourceHeight(section, maxRy) {
    const srcW = Number(section.dataset.pageWidth) || 0;
    const page = section.dataset.page;
    const wrap = document.querySelector(`${PDF_SEL} .page-wrapper[data-page="${page}"]`);
    const pw = Number(wrap?.dataset.pageW) || 0;
    const ph = Number(wrap?.dataset.pageH) || 0;
    if (srcW > 0 && pw > 0 && ph > 0) return srcW * (ph / pw);
    if (maxRy > 0) return maxRy * 1.08;
    return srcW > 0 ? srcW * 1.294 : 0;      // US Letter, the least-wrong guess
}

/**
 * Control points tying this page's flow offsets to source y.
 *
 * Cached because it costs a layout read per region and the answer only changes
 * when the page is re-extracted or the pane is resized — both of which call
 * `refreshScrollSync`.
 */
function _docAnchors(scroller, section) {
    const page = Number(section.dataset.page);
    const hit = _anchorCache.get(page);
    if (hit) return hit;

    const secBox = _boxIn(scroller, section);
    const secTop = secBox.top;
    const secH = secBox.height;

    const pts = [];
    let maxRy = 0;
    for (const el of section.querySelectorAll('[data-ry]')) {
        const ry = Number(el.dataset.ry);
        if (!isFinite(ry)) continue;
        const top = _offsetIn(scroller, el) - secTop;
        if (top < 0 || top > secH) continue;
        pts.push([top, ry]);
        if (ry > maxRy) maxRy = ry;
    }
    pts.sort((a, b) => a[0] - b[0]);

    const srcH = _sourceHeight(section, maxRy);

    // ── Source y is not always a FUNCTION of flow position ───────────────────
    // On a single-column page, reading down the flow means going down the page:
    // the anchors ascend, and interpolating between them is exact.
    //
    // On a MULTI-COLUMN page they do not. The flow runs down the left column
    // and then jumps back to the top of the right one, so the page is traversed
    // twice and the anchor list steps BACKWARDS at the column break. Two
    // different answers are defensible there — "how far through the page have I
    // read" (which advances smoothly) and "where on the paper am I looking"
    // (which jumps back up). For a pane showing the original page, the second is
    // the one the user is checking against: they expect the paragraph they are
    // reading to be level with the same paragraph on the scan.
    //
    // So the anchors are kept in FLOW order, complete with their backsteps, and
    // the interpolation simply refuses to cross one — a segment that descends is
    // a column break, not a gradient, and averaging across it is what dragged
    // everything after the first break toward the bottom of the page (measured
    // at up to 0.58 of a page).
    const tops = [], srcYs = [];
    const push = (t, ry) => {
        if (tops.length && t <= tops[tops.length - 1]) return;   // flow order must be strict
        tops.push(t); srcYs.push(ry);
    };
    push(0, pts.length ? Math.min(pts[0][1], srcH) : 0);
    for (const [t, ry] of pts) push(t, ry);
    push(secH, srcH);

    let breaks = 0;
    for (let i = 1; i < srcYs.length; i++) if (srcYs[i] < srcYs[i - 1]) breaks++;

    const rec = { tops, srcYs, height: srcH || 1, top: secTop, secH, breaks };
    _anchorCache.set(page, rec);
    return rec;
}

function _docSections(scroller) {
    return [...scroller.querySelectorAll('section.pdf-page-content[data-page]')];
}

function _docToPos(scroller) {
    const secs = _docSections(scroller);
    if (!secs.length) return null;
    const y = scroller.scrollTop + scroller.clientHeight * ANCHOR_RATIO;
    for (const s of secs) {
        const { top, height: h } = _boxIn(scroller, s);
        if (y < top + h || s === secs[secs.length - 1]) {
            const a = _docAnchors(scroller, s);
            const srcY = _interpFlow(a.tops, a.srcYs, y - top);
            const page = Number(s.dataset.page) || 1;
            return (page - 1) + _clamp(srcY / a.height, 0, 0.9999);
        }
    }
    return null;
}

function _posToDoc(scroller, pos) {
    const page = Math.floor(pos) + 1;
    const frac = pos - Math.floor(pos);
    const s = scroller.querySelector(`section.pdf-page-content[data-page="${page}"]`);
    if (!s) return null;
    const a = _docAnchors(scroller, s);
    const secTop = _offsetIn(scroller, s);
    // Inverse of the same control points, resolved by continuity: `near` is
    // where this pane already sits, so a column break moves it the short way.
    const near = scroller.scrollTop + scroller.clientHeight * ANCHOR_RATIO - secTop;
    const top = _inverseFlow(a.tops, a.srcYs, frac * a.height, near);
    return secTop + top - scroller.clientHeight * ANCHOR_RATIO;
}

// ── Driving ──────────────────────────────────────────────────────────────────

function _apply(fromEl, pos) {
    const doc = _docEl(), pdf = _pdfEl();
    if (fromEl !== doc && _live(doc)) {
        const y = _posToDoc(doc, pos);
        if (y != null) doc.scrollTop = _clamp(y, 0, doc.scrollHeight - doc.clientHeight);
    }
    if (fromEl !== pdf && _live(pdf)) {
        const y = _posToPdf(pdf, pos);
        if (y != null) pdf.scrollTop = _clamp(y, 0, pdf.scrollHeight - pdf.clientHeight);
    }
    // Surfaces that do not scroll — the analyze canvas renders one page — follow
    // the page component only, and only when it actually changes.
    const page = Math.floor(pos) + 1;
    for (const s of _surfaces) {
        if (s._lastPage === page) continue;
        s._lastPage = page;
        try { s.followPage(page); } catch (_) { /* a surface must not break the scroll */ }
    }
    for (const s of _positionSurfaces) {
        if (fromEl === s || (s.isLive && !s.isLive())) continue;
        try { s.followPosition(pos); } catch (_) { /* one surface must not break the rest */ }
    }
}

function _drive(source, readPosition) {
    if (!_enabled) return;
    // Whoever moved first owns the gesture until it stops. Without this, the
    // pane we just scrolled programmatically scrolls us back, and the two panes
    // walk each other down the document.
    if (_driver && _driver !== source) return;
    _driver = source;
    clearTimeout(_releaseTimer);
    _releaseTimer = setTimeout(() => { _driver = null; }, 120);

    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => {
        _rafPending = false;
        if (!_enabled || _driver !== source) return;
        const pos = readPosition();
        if (pos != null) _apply(source, pos);
    });
}

function _onScroll(e) {
    const el = e.currentTarget;
    _drive(el, () => el === _docEl() ? _docToPos(el) : _pdfToPos(el));
}

// ── Public API ───────────────────────────────────────────────────────────────

export function initScrollSync() {
    if (_installed) return;
    _installed = true;
    for (const sel of [DOC_SEL, PDF_SEL]) {
        const el = document.querySelector(sel);
        if (el) el.addEventListener('scroll', _onScroll, { passive: true });
    }
    window.addEventListener('resize', refreshScrollSync);
}

/** Layout changed — every cached anchor offset is now a lie. */
export function refreshScrollSync() {
    _anchorCache.clear();
}

/** Forget the anchors for ONE page, e.g. after that page was re-extracted. */
export function invalidatePageAnchors(page) {
    _anchorCache.delete(Number(page));
}

export function setScrollSyncEnabled(on) {
    _enabled = !!on;
    if (!_enabled) _driver = null;
}

export function isScrollSyncEnabled() { return _enabled; }

/**
 * Register a surface that follows the page but does not scroll — the analyze
 * canvas draws one page at a time, so it is told which page rather than where.
 */
export function registerPageSurface(followPage) {
    if (typeof followPage === 'function') _surfaces.push({ followPage, _lastPage: null });
}

/**
 * Register a scrolling surface against the same document-position coordinate
 * used by PDF and Doc. `subscribe` wires its native scroll event and returns
 * an optional disposer; the adapter owns all pixel/line conversion.
 */
export function registerPositionSurface({ readPosition, followPosition, subscribe, isLive }) {
    if (typeof readPosition !== 'function' || typeof followPosition !== 'function') return () => {};
    const surface = { readPosition, followPosition, isLive };
    _positionSurfaces.push(surface);
    const nativeDispose = typeof subscribe === 'function'
        ? subscribe(() => _drive(surface, readPosition))
        : null;
    return () => {
        const i = _positionSurfaces.indexOf(surface);
        if (i >= 0) _positionSurfaces.splice(i, 1);
        nativeDispose?.dispose?.();
        if (typeof nativeDispose === 'function') nativeDispose();
    };
}

/** Where the panes currently agree they are. Exposed for verbs and tests. */
export function currentPosition() {
    const doc = _docEl(), pdf = _pdfEl();
    if (_live(doc)) return _docToPos(doc);
    if (_live(pdf)) return _pdfToPos(pdf);
    return null;
}

/** Move every pane to a document position. */
export function scrollToPosition(pos) {
    if (!isFinite(pos)) return false;
    _apply(null, pos);
    return true;
}

/** Move every pane to a page (1-based), optionally to a region on it. */
export function scrollToPage(page, regionId = null) {
    const doc = _docEl();
    if (regionId && doc) {
        const el = doc.querySelector(
            `section.pdf-page-content[data-page="${page}"] [data-region-id="${CSS.escape(String(regionId))}"]`);
        const ry = Number(el?.closest('[data-ry]')?.dataset.ry ?? el?.dataset.ry);
        if (isFinite(ry)) {
            const s = doc.querySelector(`section.pdf-page-content[data-page="${page}"]`);
            const a = _docAnchors(doc, s);
            return scrollToPosition((page - 1) + _clamp(ry / a.height, 0, 0.9999));
        }
    }
    return scrollToPosition((page - 1) + 0.02);
}

/** Diagnostics: what each pane thinks the position is right now. */
export function _debugPositions() {
    const doc = _docEl(), pdf = _pdfEl();
    return {
        enabled: _enabled,
        doc: _live(doc) ? _docToPos(doc) : null,
        pdf: _live(pdf) ? _pdfToPos(pdf) : null,
        cachedPages: _anchorCache.size,
        surfaces: _surfaces.length + _positionSurfaces.length,
        hasDocument: !!state.pdf1.extractedHTML,
    };
}
