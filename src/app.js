/**
 * app.js; main entry point
 */

import $ from 'jquery';
import DOMPurify from 'dompurify';
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
import { initBatchViewController } from './ui/batchViewController.js';
import { analyzePDF } from './extraction/vector/pdfAnalyzer.js';
import { showToast } from './ui/toast.js';
import { state } from './state.js';

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
    initViewTabs();
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
    btn.addEventListener('click', function (e) {
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
