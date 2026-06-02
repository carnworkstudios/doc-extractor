/**
 * app.js; main entry point
 */

import $ from 'jquery';
import DOMPurify from 'dompurify';
import { initViewTabs, syncToolbarToView } from './ui/viewController.js';
import { initFileInputs } from './ui/fileUpload.js';
import { initExportSystem } from './ui/exportController.js';
import { initToolbar } from './ui/pageNav.js';
import { initContextMenu } from './ui/contextMenu.js';
import { initDividerResize } from './ui/visualDiff.js';
import { initMonacoEditor } from './editor/monacoSetup.js';
import { initHTMLSync, patchPageHtml } from './ui/htmlSync.js';
import { initZoneToolbar } from './ui/zoneToolbar.js';
import { initSelectionMode } from './ui/selectionMode.js';
import { initViewCode } from './ui/viewCode.js';
import { initPDFEditMode } from './ui/pdfEditMode.js';
import { initHistoryController } from './ui/historyController.js';
import { analyzePDF } from './extraction/vector/pdfAnalyzer.js';
import { showToast } from './ui/toast.js';

// DOMPurify available globally for fileUpload / monacoSetup
window.DOMPurify = DOMPurify;

// patchPageHtml exposed globally so analyzePanel can call it from onReprocessResult
// without a circular import (analyzePanel → htmlSync → state → analyzePanel).
window._patchPageHtml = patchPageHtml;

// ── __GX_PDF_CORE__ — stable hook surface for the injected analyzePanel.js ──
// os-shell.js injects /assets/pdf-processor/ui/analyzePanel.js into this iframe
// after load. That script reads this object instead of using static imports.
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
        _cachedRegions.forEach(([regions, pageScale], pageNum) => cb(pageNum, regions, pageScale));
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
    _dispatchRegionPage(n, r, s) {
        _cachedRegions.set(n, [r, s]);
        _regionPageCallbacks.forEach(cb => cb(n, r, s));
    },
    _dispatchReset() {
        // Clear replay cache so the next file starts fresh.
        _cachedAnalysis = null;
        _cachedRegions  = new Map();
        _resetCallbacks.forEach(cb => cb());
    },
    _dispatchReprocessResult: (n, h, r, s)  => _reprocessResultCallbacks.forEach(cb => cb(n, h, r, s)),
    _dispatchReprocessError:  (n, e)        => _reprocessErrorCallbacks.forEach(cb => cb(n, e)),
};

// ── Analyze tab: standalone CTA vs OS-shell injection ────────────────────────

function _tryInjectAnalyzePanel() {
    if (window.parent !== window) {
        // Inside OS shell — shell will inject the closed-source script via _injectAnalyzePanel().
        // Nothing to do here; the shell fires on iframe 'load'.
        return;
    }
    // Standalone direct navigation — show a CTA card on the Analyze tab.
    _renderAnalyzeStandaloneCTA();
}

function _renderAnalyzeStandaloneCTA() {
    const container = document.getElementById('analyze-panel-inner');
    if (!container) return;
    container.innerHTML = `
        <div class="gx-analyze-cta" style="
            display:flex;flex-direction:column;align-items:center;justify-content:center;
            gap:16px;padding:48px 24px;text-align:center;max-width:420px;margin:0 auto;
        ">
            <div style="font-size:1.2rem;font-weight:600;color:var(--text-primary,#f1f5f9)">
                Analyze — Pro Feature
            </div>
            <div style="font-size:0.875rem;color:var(--text-secondary,#94a3b8);line-height:1.6">
                The Analyze tab includes the geometry canvas, region overlay, and
                pipeline threshold sliders. Open this tool inside Ginexys to access it.
            </div>
            <a href="https://ginexys.com/app/pdf/analyze" class="gx-btn-gold" style="
                display:inline-block;padding:10px 24px;border-radius:6px;
                background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;
                font-size:0.875rem;font-weight:600;text-decoration:none;margin-top:4px;
            ">Open in Ginexys</a>
        </div>
    `;
}

$(() => {
    initViewTabs();
    initFileInputs();
    initToolbar();
    initContextMenu();
    initDividerResize();
    initMonacoEditor();
    initHTMLSync();
    initZoneToolbar();
    initExportSystem();
    initSelectionMode();
    initViewCode();
    initPDFEditMode();
    initHistoryController();
    _tryInjectAnalyzePanel();

    // Sync toolbar to the default active tab (PDF) on first load
    syncToolbarToView('pdf');

    // From our new diffChecker controller logic
    import('./ui/diffViewController.js').then(m => m.initDiffTabsAndLayout());
});

