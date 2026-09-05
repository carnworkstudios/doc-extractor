/**
 * pdfCanvas.js
 * Renders a pdf document to canvas elements in a given container using pdfjs-dist.
 */

import $ from 'jquery';
import * as pdfjsLib from 'pdfjs-dist';
import {
    clearParkedTextEdits,
    parkTextEditsForPage,
    refreshTextEditMode,
    refreshTextEditPage,
} from './pdfTextEdit.js';
import { applyPdfReadOnly } from './workspaceLayout.js';
// Global worker source is already configured in pdfAnalyzer.js or geometryWorker.js,
// but just in case, it should be available.

const SCALE = 1.5;
export { SCALE };

// Zoom is applied as a CSS transform on rendered .page-wrapper elements;
// the canvas keeps its rendered resolution, transform handles visual scaling.
let _zoom = 1.0;

export function getPDFZoom() { return _zoom; }

export function setPDFZoom(z) {
    _zoom = z;
    document.documentElement.style.setProperty('--pdf-zoom', String(z));
    // Keep the toolbar readout honest. Zoom now changes from places the user
    // did not click (load, pane toggle), so pairing every call site with a
    // manual label refresh would just be a rule waiting to be forgotten.
    const label = document.getElementById('zoom-pct');
    if (label) label.textContent = Math.round(z * 100) + '%';
}

/**
 * Fit zoom so the rendered page width matches the current container's
 * usable width. Uses the largest visible PDF container present in the DOM.
 */
export function fitPDFWidth() {
    // There is exactly one rendered PDF container, it lives in #pane-pdf, and
    // it never moves — only its pane's visibility and width change
    // (see workspaceLayout.js). So this is always the one to measure.
    const container = document.getElementById('pdf-canvas-container');
    const firstPage = container?.querySelector('.page-wrapper');
    if (!container || !firstPage) return;
    // A hidden pane has clientWidth 0, which would compute a zoom of 0 and
    // clamp to the 0.5 floor — leaving the document tiny once the pane is
    // shown. Callers that fire on load or on a toggle can land here before
    // layout, so bail rather than fit against nothing.
    if (!container.clientWidth) return;
    const styles = getComputedStyle(container);
    const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const usable = container.clientWidth - padX - 8;
    const intrinsic = parseFloat(firstPage.style.width) || firstPage.offsetWidth / _zoom;
    if (intrinsic > 0) setPDFZoom(Math.max(0.5, Math.min(3.0, usable / intrinsic)));
}


// ── Windowed rendering ────────────────────────────────────────────────────────
//
// Why this exists: `renderPDFToCanvas` used to paint EVERY page of the document
// into a DOM canvas and keep all of them alive for the session. A canvas costs
// width x height x 4 bytes the moment it is sized, and at SCALE 1.5 a Letter
// page is 918x1188 = 4.16 MB. The 1236-page PDF reference therefore allocated
// ~5.0 GB of backing store to display one page at a time. Measured in Chrome:
// >5 GB for exactly that document.
//
// Two things made it invisible:
//   1. It scales with page count, so every test document (11-76 pages) looked
//      fine — the cost only appears on the documents users complain about.
//   2. The headless MCP path runs `handleFile()` too, so `extract_pdf` on a
//      long document allocated gigabytes of canvases inside an invisible host
//      that never displays anything. That is almost certainly a contributor to
//      the long-document extraction timeouts.
//
// The fix is to treat the bitmap as a cache of what is on screen rather than a
// property of the document: paint a page when it approaches the viewport, and
// release it when it leaves. Footprint becomes a function of viewport size, not
// document length — roughly 21 MB for the window below, at any page count.
//
// Releasing means `width = height = 0`. Removing the element from the DOM is
// NOT enough: `wrappers` is returned to callers and retained by `pageNav`, so
// the canvases stay reachable and the buffers stay allocated. Zeroing the
// dimensions is what actually frees them in Chrome.

/** Pages either side of the viewport kept painted. 2 covers a fast scroll. */
const WINDOW_MARGIN_PAGES = 2;

const _windows = new Map();

function _teardownWindow(containerId) {
    const existing = _windows.get(containerId);
    if (!existing) return;
    existing.observer.disconnect();
    for (const entry of existing.painters.values()) _release(entry);
    _windows.delete(containerId);
}

function _release(entry) {
    if (!entry.painted) return;
    // cancel() rejects task.promise with RenderingCancelledException. Whoever
    // is awaiting it must be the one to observe that rejection — but _paint
    // may be parked on `await page.getTextContent()` and, by the time it
    // resumes, entry.task is already null here, so it never reaches its
    // `await entry.task.promise` and nothing ever attaches a handler. The
    // result is an unhandled promise rejection, once per released page. On a
    // short document that is invisible; on a 1236-page one the window churns
    // constantly and the console fills with them.
    //
    // Claim the rejection here, at the point of cancellation, instead.
    const task = entry.task;
    entry.task = null;
    if (task) {
        task.promise.catch(() => { /* cancellation is the expected outcome */ });
        try { task.cancel(); } catch { /* already finished */ }
    }
    // Drop the parsed page with the bitmap. Keeping it would make the window
    // bound the canvases but not pdf.js's own per-page memory.
    try { entry._page?.cleanup(); } catch { /* nothing to clean */ }
    entry._page = null;
    // The allocation lives in the backing store, not the element. Zeroing the
    // dimensions is the only thing that returns it.
    entry.canvas.width = 0;
    entry.canvas.height = 0;

    // Drop the spans unless the user is editing inside them. Discarding a live
    // edit to save memory would be trading a real loss for an invisible gain.
    const layer = entry.$textLayer?.[0];
    if (layer && !layer.contains(document.activeElement)) {
        parkTextEditsForPage(entry.wrapper);
        layer.replaceChildren();
    }

    entry.painted = false;
}

async function _paint(entry, pdfDoc) {
    if (entry.painted) return;
    entry.painted = true;               // claim it first: entries can re-fire
    entry.canvas.width = entry.viewport.width;
    entry.canvas.height = entry.viewport.height;
    try {
        const page = await pdfDoc.getPage(entry.pageNum);
        const ctx = entry.canvas.getContext('2d');
        const task = page.render({ canvasContext: ctx, viewport: entry.viewport });
        entry.task = task;

        // Build the text layer only if it is not already there. A page can be
        // repainted (zoom, re-render) with its spans still live, and rebuilding
        // would discard any in-progress edit.
        if (!entry.$textLayer[0].childElementCount) {
            const textContent = await page.getTextContent();
            buildTextLayer(textContent, entry.viewport, entry.$textLayer);
        }

        // Await the LOCAL task, not entry.task: _release can null the field
        // during the getTextContent() await above, which would turn this into
        // a TypeError instead of the cancellation it actually is.
        await task.promise;

        // If _release ran while this was in flight it already cleared the
        // canvas and reset `painted` — do not resurrect its bookkeeping.
        if (entry.task !== task) return;
        entry.task = null;
        entry._page = page;
        // Edit Text may have been enabled while this page was off-screen or
        // still rendering. Apply its mask and restore its edit state only after
        // pdf.js has painted and the page's text layer has been built.
        refreshTextEditPage(entry.wrapper);
    } catch (err) {
        // A cancelled render is the normal result of scrolling past a page
        // before it finished. Anything else is worth seeing.
        if (err?.name !== 'RenderingCancelledException') {
            console.error('pdf page render failed:', err);
        }
        entry.painted = false;
    }
}

function _installWindow(containerId, painters, pdfDoc) {
    if (!painters.size) return;

    // rootMargin in page-heights, so the window is "N pages" rather than "N
    // pixels" — the same margin behaves correctly at any zoom or page size.
    const sample = painters.values().next().value;
    const margin = Math.round((sample?.viewport?.height ?? 1200) * WINDOW_MARGIN_PAGES);

    const observer = new IntersectionObserver(
        entries => {
            for (const e of entries) {
                const entry = painters.get(e.target);
                if (!entry) continue;
                if (e.isIntersecting) _paint(entry, pdfDoc);
                else _release(entry);
            }
        },
        { root: null, rootMargin: `${margin}px 0px ${margin}px 0px`, threshold: 0 }
    );

    for (const wrapper of painters.keys()) observer.observe(wrapper);
    _windows.set(containerId, { observer, painters, pdfDoc });

    // Paint page 1 unconditionally.
    //
    // In a headless host nothing is ever "visible", so the observer would leave
    // the document blank — correct for memory, wrong for any caller that opens
    // a document and screenshots it. One page is 4 MB; the old behaviour was
    // every page.
    const first = painters.values().next().value;
    if (first) _paint(first, pdfDoc);
}

/**
 * Repaint whatever is currently in the window.
 *
 * Zoom is a CSS transform, so a zoom change does not invalidate a bitmap — but
 * a re-render at a new scale would. Exposed for callers that change SCALE.
 */
export function refreshWindowedPages(containerId = 'pdf-canvas-container') {
    const w = _windows.get(containerId);
    if (!w) return;
    for (const entry of w.painters.values()) {
        if (entry.painted) { _release(entry); _paint(entry, w.pdfDoc); }
    }
}

/**
 * Cut a box out of a rendered page and return it as a PNG data URL.
 *
 * `box` is in PDF POINTS — the unit `data-page-w`/`data-page-h` carry and the
 * unit the annotation layer's SVG viewBox uses, so a rectangle picked by the
 * marquee needs no conversion on the way in. This function owns the one
 * conversion that matters (points → canvas pixels), because this module owns
 * the render scale; a caller that computed it from `getBoundingClientRect`
 * would be reading the CSS zoom transform instead and land in the wrong place.
 *
 * Returns null when the page is not currently painted — the windowed renderer
 * releases off-screen bitmaps (see above), so "no pixels" is a normal state
 * and a caller must handle it rather than getting a blank crop.
 *
 * @param {number} pageNum
 * @param {{x:number,y:number,w:number,h:number}} box — PDF points
 * @param {{maxEdge?:number, containerId?:string}} [opts]
 * @returns {{dataUrl:string, w:number, h:number, pageH:number}|null}
 */
export function cropPageBox(pageNum, box, opts = {}) {
    const containerId = opts.containerId || 'pdf-canvas-container';
    const wrapper = document.querySelector(
        `#${containerId} .page-wrapper[data-page="${Number(pageNum)}"]`);
    const canvas = wrapper?.querySelector('canvas');
    // A released canvas is 0×0, which would silently produce an empty crop.
    if (!canvas || !canvas.width || !canvas.height) return null;

    const pageW = parseFloat(wrapper.dataset.pageW) || (canvas.width / SCALE);
    const pageH = parseFloat(wrapper.dataset.pageH) || (canvas.height / SCALE);
    if (!(pageW > 0) || !(pageH > 0)) return null;

    // Points → device pixels, read off the bitmap actually in hand rather than
    // assumed to be SCALE: a repaint at another scale must not misplace a crop.
    const kx = canvas.width / pageW;
    const ky = canvas.height / pageH;

    const sx = Math.max(0, Math.round(box.x * kx));
    const sy = Math.max(0, Math.round(box.y * ky));
    const sw = Math.min(Math.round(box.w * kx), canvas.width - sx);
    const sh = Math.min(Math.round(box.h * ky), canvas.height - sy);
    if (sw < 4 || sh < 4) return null;

    // Cap the long edge: a crop is a reading fragment, not a print master. A
    // full-width page at devicePixelRatio 2 is otherwise ~8 MB per item.
    const maxEdge = opts.maxEdge || 1600;
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(sw * scale));
    out.height = Math.max(1, Math.round(sh * scale));
    try {
        out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
        return { dataUrl: out.toDataURL('image/png'), w: out.width, h: out.height, pageH };
    } catch (err) {
        console.warn('[pdfCanvas] crop failed:', err?.message || err);
        return null;
    }
}

export async function renderPDFToCanvas(bytes, containerId = 'pdf-canvas-container') {
    const $container = $(`#${containerId}`);
    if (!$container.length) return { wrappers: [], numPages: 0 };
    $container.empty();
    _teardownWindow(containerId);
    clearParkedTextEdits();

    const wrappers = [];
    let numPages = 0;
    
    try {
        const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
        numPages = pdfDoc.numPages;

        const painters = new Map();

        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            const page = await pdfDoc.getPage(pageNum);
            const viewport = page.getViewport({ scale: SCALE });
            
            const $wrapper = $('<div>', {
                class: 'page-wrapper',
                css: { width: viewport.width, height: viewport.height, position: 'relative', overflow: 'hidden', marginBottom: '20px' },
                'data-page': pageNum,
                'data-page-w': viewport.width / SCALE,
                'data-page-h': viewport.height / SCALE,
                contentEditable: 'true'
            });

            const $canvas = $('<canvas>', {
                css: { display: 'block', width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 1 },
                contentEditable: 'false'
            });
            // NOT sized here. A sized canvas allocates width*height*4 bytes
            // immediately, whether or not anything is painted on it — that
            // allocation, times every page, is the whole memory problem. The
            // wrapper already carries the geometry, so layout is unaffected.
            $wrapper.append($canvas);

            const $textLayer = $('<div>', {
                class: 'editable-text-layer',
                contenteditable: 'true',
                spellcheck: 'false',
                css: {
                    position: 'absolute', top: 0, left: 0,
                    width: '100%', height: '100%', zIndex: 2,
                    outline: 'none'
                }
            });
            $wrapper.append($textLayer);

            $container.append($wrapper);
            wrappers.push($wrapper[0]);

            // The text layer is windowed too, and it is the bigger half.
            //
            // `buildTextLayer` creates one absolutely-positioned <span> with
            // inline styles PER TEXT ITEM. A dense 1236-page document is on the
            // order of a million DOM nodes — measured at ~4.3 GB peak, which is
            // more than the canvases ever cost. Nothing in JS reads these spans;
            // they are a CSS-styled editing surface, so an off-screen page does
            // not need one.

            // Store the page NUMBER, not the page proxy.
            //
            // A pdf.js PageProxy holds the page's operator list, font data and
            // decoded images. Retaining 1236 of them to "save" a re-fetch trades
            // one leak for another — and the first version of this windowing did
            // exactly that, which is why freeing 5 GB of canvas changed the peak
            // by nothing. `getPage` is cheap and pdf.js caches internally.
            painters.set($wrapper[0], {
                wrapper: $wrapper[0],
                canvas: $canvas[0],
                $textLayer,
                pageNum,
                viewport,
                task: null,
                painted: false,
            });
            // Release this page's parsed resources now that the text layer is
            // built. Without it pdf.js holds every page for the session.
            page.cleanup();
        }

        _installWindow(containerId, painters, pdfDoc);
    } catch(err) {
        console.error("pdfjs render error:", err);
    }

    // The container was emptied above, so the edit-text class has to be
    // re-applied to the fresh wrappers — and so does the read-only state,
    // since every new wrapper is built contenteditable="true".
    refreshTextEditMode();
    applyPdfReadOnly();

    // Fit the freshly rendered document to whatever width its pane currently
    // has. No-ops while the pane is hidden; workspaceLayout re-fits on toggle.
    fitPDFWidth();

    return { wrappers, numPages };
}

function buildTextLayer(textContent, viewport, $layerEl) {
    try {
        const positionedItems = textContent.items.map(item => {
            const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
            const fontSize = Math.hypot(item.transform[0], item.transform[1]) * viewport.scale;

            return {
                str: item.str,
                x,
                y,
                fontSize,
                // item.width/height are in PDF points at scale 1.
                width: (item.width || 0) * viewport.scale,
                fontFamily: item.fontName || 'sans-serif'
            };
        });

        positionedItems.forEach(it => {
            if (!it.str.trim()) return; // Skip empty whitespace

            const $span = $('<span>').text(it.str).addClass('pdf-text-span').css({
                left: it.x,
                top: it.y - it.fontSize,
                fontSize: it.fontSize + 'px',
                fontFamily: it.fontFamily,
                position: 'absolute',
                color: 'transparent',
                whiteSpace: 'pre',
                cursor: 'text'
            });

            // Provenance for the pdf-lib export route: the ORIGINAL string plus
            // the span's box in DISPLAY SPACE (PDF points, top-left origin,
            // y down) — the same space annotations use, so exportPdf can run
            // both through viewportToUserSpace without a second convention.
            const el = $span[0];
            el.dataset.orig = it.str;
            el.dataset.x = String(it.x / viewport.scale);
            el.dataset.y = String((it.y - it.fontSize) / viewport.scale);
            el.dataset.w = String(it.width / viewport.scale);
            el.dataset.fs = String(it.fontSize / viewport.scale);

            // Note: The text layer must be transparent to allow selection
            // while showing the actual PDF rendering beneath it. In text-edit
            // mode the canvas is hidden and CSS makes these spans opaque.
            $layerEl.append($span);
        });
    } catch (e) {
        console.warn("Failed to build pdfjs text layer", e);
    }
}
