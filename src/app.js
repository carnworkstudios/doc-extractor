/**
 * app.js; main entry point
 */

import $ from 'jquery';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import { initViewTabs, syncToolbarToView } from './ui/viewController.js';
import { initFileInputs } from './ui/fileUpload.js';
import { initExportSystem } from './ui/exportController.js';
import { initToolbar } from './ui/pageNav.js';
import { initTableEditing } from './ui/tableEditorInit.js';
import { initMonacoEditor } from './editor/monacoSetup.js';
import { initHTMLSync, patchPageHtml } from './ui/htmlSync.js';
import { initZoneToolbar } from './ui/zoneToolbar.js';
import { initSelectionMode } from './ui/selectionMode.js';
import { initViewCode } from './ui/viewCode.js';
import { initPDFEditMode } from './ui/pdfEditMode.js';
import { initPDFTextEdit } from './ui/pdfTextEdit.js';
import { initAuthGate } from './ui/authGate.js';
import { initHistoryController } from './ui/historyController.js';
import { initAnnotationToolbar } from './ui/annotationToolbar.js';
import { initNavPanel } from './ui/navPanel.js';
import { initPdfContextMenu } from './ui/pdfContextMenu.js';
import { initDocSelectionMenu } from './ui/docSelectionMenu.js';
import { initWorkspaceLayout, toggleMirror } from './ui/workspaceLayout.js';
import { initScrollSync, refreshScrollSync, invalidatePageAnchors, registerPageSurface, scrollToPage, _debugPositions } from './ui/scrollSync.js';
import { initBatchViewController } from './ui/batchViewController.js';
import { analyzePDF } from './extraction/vector/pdfAnalyzer.js';
import { showToast } from './ui/toast.js';
import { state } from './state.js';
import { getImageBlob, clearImages } from './utils/imageStore.js';

// DOMPurify available globally for fileUpload / monacoSetup
window.DOMPurify = DOMPurify;

// patchPageHtml exposed globally so analyzePanel can call it from onReprocessResult
// without a circular import (analyzePanel → htmlSync → state → analyzePanel).
window._patchPageHtml = patchPageHtml;

// ── __GX_PDF_CORE__ — stable hook surface for the analyze panel ─────────────
// The panel is an optional add-on loaded at runtime by the host, not a static
// import. It reads this object; the tool works fully without it.
//
// Each on* registration replays the last known value immediately if it arrived
// before analyzePanel.js booted. This closes the race where file extraction
// completes before the inject fires: regions/analysis are never silently dropped.
const _analysisReadyCallbacks  = [];
const _workerReadyCallbacks    = [];
const _regionPageCallbacks     = [];
const _resetCallbacks          = [];
const _reprocessResultCallbacks = [];
const _reprocessErrorCallbacks  = [];

// Replay cache — holds the last dispatched value for each channel.
// Cleared on reset so stale data from a previous file is never replayed.
let _cachedAnalysis  = null;               // last _dispatchAnalysisReady arg
let _cachedWorker    = null;               // last _dispatchWorkerReady arg
let _cachedRegions   = new Map();          // pageNum → [regions, pageScale]

window.__GX_PDF_CORE__ = {
    getAnalyzePDF:     () => analyzePDF,
    getGeoWorker:      () => window.__GX_PDF_GEO_WORKER__ || null,
    patchPageHtml:     (page, html) => patchPageHtml(page, html),
    showToast:         (msg, type) => showToast(msg, type),

    // Real-content resolvers for the artifacts panel's cross-tool Send — a
    // region/tag is just an id+page reference, these turn that reference back
    // into the actual content so Send ships real IR, not a metadata stub.
    //
    // EVERY lookup here is page-scoped, and that is load-bearing rather than
    // defensive: the extractors number regions PER PAGE (`lattice_0`,
    // `picture_0` and `vecfig_0` all restart at each page), so an unscoped
    // `querySelector` returns whichever page appears first in the document.
    // Selecting five tables off page 9 previously resolved all five against
    // page 1 — the reason a multi-page selection appeared to "only send a few".
    getExtractedHtml:  () => state.pdf1.extractedHTML,

    // ── Pane synchronisation ────────────────────────────────────────────────
    // The tool owns the shared coordinate (scrollSync.js); the panel owns the
    // canvas. So the panel does not compute positions — it hands over a
    // `followPage` and asks to be moved by page or region, in the same
    // {page, regionId} terms every other cross-tool address uses.
    registerPageSurface: (followPage) => registerPageSurface(followPage),
    scrollToPage:        (page, regionId) => scrollToPage(page, regionId),
    refreshScrollSync:   () => refreshScrollSync(),
    // Diagnostic: what each pane believes the shared position is. Used by the
    // scroll-sync check and worth having when a pane disagrees on screen.
    debugScrollSync:     () => _debugPositions(),
    invalidatePageAnchors: (page) => invalidatePageAnchors(page),

    /**
     * Real vector geometry for a region, in the region's OWN coordinate space.
     *
     * ── THE SCALE TRAP ───────────────────────────────────────────────────────
     * These two inputs are rendered at different scales and it is invisible
     * until the output is wrong:
     *
     *   pdfAnalyzer.js  getViewport({ scale: 1.5 })  → hSegs / vSegs / diagSegs
     *   geometryWorker  getViewport({ scale: 2.0 })  → region.bbox
     *
     * Clipping 1.5-space segments against a 2.0-space box selects the wrong
     * strokes AND misplaces every one it does select, by exactly 33%. Nothing
     * throws; you just get a plausible-looking drawing of the wrong part of the
     * page. analyzePanel carries the same conversion (`pg.widthPx * (2.0/1.5)`)
     * everywhere it maps regions onto the canvas.
     *
     * Output is region-LOCAL (origin subtracted) at worker scale, so it lines up
     * with the rasterised crop of the same region without further conversion.
     */
    getRegionGeometry(page, regionId) {
        const ANALYSIS_SCALE = 1.5, WORKER_SCALE = 2.0;
        const S = WORKER_SCALE / ANALYSIS_SCALE;   // 1.5-space → 2.0-space

        const cached = _cachedRegions.get(page);
        const regions = cached ? cached[0] : null;
        const region = (regions || []).find(r => String(r.id) === String(regionId));
        if (!region || !region.bbox) return null;

        const pg = _cachedAnalysis?.pages?.[page - 1];
        if (!pg) return null;

        const b = region.bbox;                       // worker space
        const all = [...(pg.hSegs || []), ...(pg.vSegs || []), ...(pg.diagSegs || [])];
        const segments = [];
        for (const s of all) {
            const x1 = s.x1 * S, y1 = s.y1 * S, x2 = s.x2 * S, y2 = s.y2 * S;
            // Midpoint containment — the same test figureDetector uses to decide
            // which segments belong to a figure, so the two agree on membership.
            const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
            if (mx < b.x || mx > b.x + b.w || my < b.y || my > b.y + b.h) continue;
            segments.push({
                x1: x1 - b.x, y1: y1 - b.y, x2: x2 - b.x, y2: y2 - b.y,
                width: (s.w ?? s.width ?? s.lineWidth ?? 1) * S,
            });
        }
        return {
            bbox: { x: b.x, y: b.y, w: b.w, h: b.h },
            segments,
            vectorFigure: !!region.vectorFigure,
            textItemCount: (region.textItemIndices || []).length,
        };
    },

    /** Page-scoped region lookup → the region's outerHTML, or null. */
    getRegionHtml(page, regionId) {
        try {
            const doc = new DOMParser().parseFromString(state.pdf1.extractedHTML || '', 'text/html');
            const scope = doc.querySelector(`section.pdf-page-content[data-page="${page}"]`);
            if (!scope) return null;
            const el = scope.querySelector(`[data-region-id="${CSS.escape(String(regionId))}"]`);
            return el ? el.outerHTML : null;
        } catch (_) { return null; }
    },

    /**
     * Every picture crop already on a page, as store REFERENCES keyed by region id.
     *
     * A re-extraction re-classifies the page but does not change the paper: a
     * picture whose box comes back unchanged can keep the crop it already has
     * instead of making the worker render the page again at 4× for pixels it is
     * already holding. Since the pixels live in the blob store, "keeping" them
     * means passing a key — nothing heavier than a string crosses the wire.
     *
     * `crop` is the viewport-space box the pixels were cut from, written by the
     * assembler, so the caller can verify the crop still describes the region
     * rather than assuming an id match means an unchanged picture.
     */
    getPageImageCrops(page) {
        const out = {};
        try {
            const doc = new DOMParser().parseFromString(state.pdf1.extractedHTML || '', 'text/html');
            const scope = doc.querySelector(`section.pdf-page-content[data-page="${page}"]`);
            if (!scope) return out;
            for (const el of scope.querySelectorAll('[data-region-id][data-crop]')) {
                const img = el.querySelector('img.extracted-pdf-image');
                const key = img?.getAttribute('data-img-id');
                if (!key) continue;
                const crop = el.getAttribute('data-crop').split(',').map(Number);
                if (crop.length !== 4 || crop.some(n => !isFinite(n))) continue;
                out[el.getAttribute('data-region-id')] = {
                    key,
                    w: Number(img.getAttribute('width')) || 0,
                    h: Number(img.getAttribute('height')) || 0,
                    crop,
                };
            }
        } catch (_) { /* no document, or unparseable — the worker re-crops */ }
        return out;
    },

    /**
     * A picture's pixels as a data URL, for consumers that must have bytes —
     * the artifacts preview stage and anything sent to another tool.
     *
     * The store is asked FIRST. Pictures live there now; the document holds only
     * keys, so parsing the whole document string to look for a `src` would be a
     * full DOMParser pass that finds nothing. The inline branch remains for the
     * two cases that still put pixels in the markup: a legacy document extracted
     * before the store rail, and a region whose content was replaced by an
     * annotated SVG.
     */
    async getImageDataUrl(id, page) {
        // The key is READ from the markup, never rebuilt. The page owns its own
        // addresses: it may have been extracted under a different document id
        // (a batch item, a reloaded slot), and a consumer that recomputes the
        // key would resolve a different document's picture or nothing at all.
        const keys = [];
        let inlineSrc = null;
        try {
            const doc = new DOMParser().parseFromString(state.pdf1.extractedHTML || '', 'text/html');
            const scope = page != null
                ? doc.querySelector(`section.pdf-page-content[data-page="${page}"]`)
                : null;
            const el = (scope || doc).querySelector(`[data-region-id="${CSS.escape(String(id))}"] img`);
            const key = el?.getAttribute('data-img-id');
            if (key) keys.push(key);
            const src = el?.getAttribute('src');
            if (src?.startsWith('data:')) inlineSrc = src;   // legacy or annotated
        } catch (_) { /* no document — fall back to the bare id below */ }
        keys.push(String(id));          // legacy / backend document-unique key
        for (const key of keys) {
            try {
                const blob = await getImageBlob(key);
                if (!blob) continue;
                return await new Promise((res, rej) => {
                    const reader = new FileReader();
                    reader.onloadend = () => res(reader.result);
                    reader.onerror = () => rej(reader.error);
                    reader.readAsDataURL(blob);
                });
            } catch (_) { /* try the next key, then the inline fallback */ }
        }
        return inlineSrc;
    },

    /**
     * Replace a figure region's content with an annotated SVG.
     *
     * The SVG carries the original raster as its backdrop plus the edited
     * vector layer, so applying an annotation does not silently restyle the
     * figure — everything the extraction could not vectorise (fills, gradients,
     * rendered type) is still exactly the pixels it always was. Only the
     * geometry on top changes, which is the only thing the user edited.
     */
    applyRegionSvg(page, regionId, svg) {
        try {
            const doc = new DOMParser().parseFromString(state.pdf1.extractedHTML || '', 'text/html');
            const scope = doc.querySelector(`section.pdf-page-content[data-page="${page}"]`);
            if (!scope) return false;
            const region = scope.querySelector(`[data-region-id="${CSS.escape(String(regionId))}"]`);
            if (!region) return false;

            const tmp = doc.createElement('div');
            tmp.innerHTML = svg;
            const svgEl = tmp.querySelector('svg');
            if (!svgEl) return false;
            // Keep the region's own box; only its contents change.
            svgEl.setAttribute('style', 'width:100%;height:auto;display:block');
            region.innerHTML = '';
            region.appendChild(svgEl);
            region.setAttribute('data-gx-annotated', 'true');

            const pageEl = doc.querySelector(`section.pdf-page-content[data-page="${page}"]`);
            const wrapper = pageEl?.closest('article.pdf-doc');
            state.pdf1.extractedHTML = doc.body.innerHTML;
            patchPageHtml(page, (wrapper || pageEl).outerHTML);
            return true;
        } catch (_) { return false; }
    },

    /**
     * Write an edited table back over the region it was extracted from, then
     * re-render that page. This is the receiving half of a round trip: TAFNE
     * edits a sheet that came from here and sends it back, addressed by the
     * origin (page + regionId) the table has carried the whole way.
     */
    applyRegionTableHtml(page, regionId, tableHtml) {
        try {
            const doc = new DOMParser().parseFromString(state.pdf1.extractedHTML || '', 'text/html');
            const scope = doc.querySelector(`section.pdf-page-content[data-page="${page}"]`);
            if (!scope) return false;
            const region = scope.querySelector(`[data-region-id="${CSS.escape(String(regionId))}"]`);
            const existing = region?.querySelector('table');
            if (!existing) return false;
            const tmp = doc.createElement('div');
            tmp.innerHTML = tableHtml;
            const replacement = tmp.querySelector('table');
            if (!replacement) return false;
            existing.replaceWith(replacement);

            // Persist to the canonical string, then push the page through the
            // normal sync path so live surfaces and parked/virtualized pages
            // both stay consistent.
            const pageEl = doc.querySelector(`section.pdf-page-content[data-page="${page}"]`);
            const wrapper = pageEl?.closest('article.pdf-doc');
            state.pdf1.extractedHTML = doc.body.innerHTML;
            patchPageHtml(page, (wrapper || pageEl).outerHTML);
            return true;
        } catch (_) { return false; }
    },

    // Callbacks registered by analyzePanel.js.
    // Each replays the cached value immediately if data arrived before registration.
    onAnalysisReady(cb) {
        _analysisReadyCallbacks.push(cb);
        if (_cachedAnalysis) cb(_cachedAnalysis);
    },
    onWorkerReady(cb) {
        _workerReadyCallbacks.push(cb);
        if (_cachedWorker) cb(_cachedWorker);
    },
    onRegionPage(cb) {
        _regionPageCallbacks.push(cb);
        // Replay all pages that arrived before analyzePanel.js registered.
        _cachedRegions.forEach(([regions, pageScale, verification], pageNum) => cb(pageNum, regions, pageScale, verification));
    },
    onResetAnalysis:     (cb) => _resetCallbacks.push(cb),
    onReprocessResult:   (cb) => _reprocessResultCallbacks.push(cb),
    onReprocessError:    (cb) => _reprocessErrorCallbacks.push(cb),

    // Dispatch helpers called by fileUpload.js
    _dispatchAnalysisReady(a) {
        _cachedAnalysis = a;
        _analysisReadyCallbacks.forEach(cb => cb(a));
    },
    _dispatchWorkerReady(w) {
        _cachedWorker = w;
        _workerReadyCallbacks.forEach(cb => cb(w));
    },
    _dispatchRegionPage(n, r, s, v) {
        _cachedRegions.set(n, [r, s, v]);
        _regionPageCallbacks.forEach(cb => cb(n, r, s, v));
    },
    _dispatchReset() {
        // Clear replay cache so the next file starts fresh.
        _cachedAnalysis = null;
        _cachedRegions  = new Map();
        _resetCallbacks.forEach(cb => cb());
    },
    _dispatchReprocessResult: (n, h, r, s, v)  => _reprocessResultCallbacks.forEach(cb => cb(n, h, r, s, v)),
    _dispatchReprocessError:  (n, e)        => _reprocessErrorCallbacks.forEach(cb => cb(n, e)),
};

// ── Analyze tab: standalone CTA vs OS-shell injection ────────────────────────

function _tryInjectAnalyzePanel() {
    if (window.parent !== window) {
        // Hosted — the host supplies the panel once the frame has loaded.
        // Nothing to do here.
        return;
    }
    if (window.CwsBridge && window.CwsBridge.isEmbedded) {
        // VS Code webview — the extension supplies the panel.
        return;
    }
    // Standalone direct navigation used to render a CTA card on the Analyze
    // tab. That renderer is commented out below; the call to it was left
    // behind, and since this runs inside the DOM-ready handler the resulting
    // ReferenceError aborted everything registered after it — which is why
    // the Compare tab's layout/precision/mode pills had no click handlers
    // (initDiffTabsAndLayout is the last line of that handler).
}

// function _renderAnalyzeStandaloneCTA() {
//     const container = document.getElementById('analyze-panel-inner');
//     if (!container) return;
//     container.innerHTML = `
//         <div class="gx-analyze-cta" style="
//             display:flex;flex-direction:column;align-items:center;justify-content:center;
//             gap:16px;padding:48px 24px;text-align:center;max-width:400px;margin:0 auto;
//         ">
//             <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="1.5" style="opacity:0.9">
//                 <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
//                 <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
//             </svg>
//             <div style="font-size:1.05rem;font-weight:600;color:var(--text-tertiary,#f1f5f9)">
//                 See inside your PDF
//             </div>
//             <div style="font-size:0.85rem;color:var(--text-secondary,#94a3b8);line-height:1.65">
//                 Analyze shows the geometry canvas, region overlays, and pipeline controls —
//                 the full structural view of your document. Available inside the Ginexys platform.
//             </div>
//             <a href="https://ginexys.com/app/pdf/analyze" style="
//                 display:inline-block;padding:10px 24px;border-radius:6px;
//                 background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;
//                 font-size:0.85rem;font-weight:600;text-decoration:none;margin-top:4px;
//             ">Open in Ginexys</a>
//         </div>
//     `;
// }

$(() => {
    // Start every session with an empty picture cache.
    //
    // Nothing persists an extracted document across a reload — `extractedHTML`
    // lives in memory only — so every blob left in the store at boot is
    // unreachable by definition: no markup exists anywhere that references its
    // key. Reclaiming it here is what keeps the cache from accumulating one
    // dead document per session, and leaves the byte budget to do the job it is
    // actually for, which is bounding a long session with many documents open.
    clearImages().catch(err =>
        console.warn('[imageStore] could not reclaim last session:', err?.message || err));

    initViewTabs();
    // Panes are tied by document POSITION, not by pixels — see scrollSync.js.
    initScrollSync();
    initFileInputs();
    initToolbar();
    initMonacoEditor();
    initHTMLSync();
    initZoneToolbar();
    initExportSystem();
    initSelectionMode();
    initTableEditing();
    initViewCode();
    initPDFEditMode();
    initPDFTextEdit();
    initAuthGate();
    initHistoryController();
    initAnnotationToolbar();
    initNavPanel();
    initPdfContextMenu();
    initDocSelectionMenu();
    initWorkspaceLayout();
    // Both "show original PDF" buttons do the same thing: add #pane-pdf to
    // the current view's visible set. No per-owner wiring, because there is
    // no ownership — the pane never moves.
    $(document).on('click', '.pdf-mirror-toggle', () => {
        if (!state.pdf1?.bytes) {
            showToast('Open a PDF first to show it as a reference.', 'error');
            return;
        }
        toggleMirror(state.activeView, 'pdf');
        syncToolbarToView(state.activeView);
    });
    // Analyze only: the extracted HTML is an independent second reference, so
    // it gets its own toggle rather than riding on the Original one.
    $(document).on('click', '.doc-mirror-toggle', () => {
        if (!state.pdf1?.extractedHTML) {
            showToast('Extract a document first to show it as a reference.', 'error');
            return;
        }
        toggleMirror(state.activeView, 'doc');
        syncToolbarToView(state.activeView);
    });
    initBatchViewController();

    // Optional/best-effort add-ons. These are isolated because everything in
    // this handler shares one call stack: a throw here used to abort the rest
    // of boot silently, and the only visible symptom was that some unrelated
    // feature further down had no event handlers. Core wiring must not depend
    // on an optional panel being injectable.
    try { _tryInjectAnalyzePanel(); } catch (err) { console.warn('[boot] analyze panel:', err); }
    try { _initMcpPill(); } catch (err) { console.warn('[boot] mcp pill:', err); }

    // Sync toolbar to the default active tab (PDF) on first load
    syncToolbarToView('pdf');

    // From our new diffChecker controller logic
    import('./ui/diffViewController.js').then(m => m.initDiffTabsAndLayout());
});


function _initMcpPill() {
    var btn = document.getElementById('mcpPillBtn');
    var popover = document.getElementById('mcpPopover');
    if (!btn || !popover) return;
    document.body.appendChild(popover);
    window.GxPointer.onPress(btn, function (e) {
        e.stopPropagation();
        var open = popover.classList.toggle('open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
            var r = btn.getBoundingClientRect();
            popover.style.top  = (r.bottom + 8) + 'px';
            popover.style.left = Math.max(8, r.right - 340) + 'px';
        }
    });
    document.addEventListener('click', function () {
        popover.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
    });
}
