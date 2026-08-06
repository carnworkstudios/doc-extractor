/**
 * fileUpload.js
 * Handles file input events, loads PDF documents, drives extraction via the
 * OS Worker Broker (backend → local geometry worker fallback), and populates all views.
 */

import $ from 'jquery';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { state } from '../state.js';
import { renderPDFToCanvas } from './pdfCanvas.js';
import { showStatus, hideStatus, enableDiffTab, disableDiffTab, switchView } from './viewController.js';
import { registerPages } from './pageNav.js';
import { markDiffDirty } from './visualDiff.js';
import { registerPDFLayers, resetPDFLayers } from './pdfEditMode.js';
import { initTableFeatures } from '../utils/tableLogic.js';
import { applyHtmlEverywhere, hydrateImages } from './htmlSync.js';
import { showToast } from './toast.js';
import { cwsBroker } from '@os/worker-broker.js';
import { checkDoclingAgreement } from '../extraction/doclingCheck.js';
import { buildStructuredPayload } from './structuredExtract.js';
import { classifyPage } from '../extraction/vector/contextClassifier.js';
import { assemblePage, createFontRegistry } from '../extraction/vector/pageAssembler.js';
import { synthesizeFromWords, makeSyntheticViewport } from '../extraction/vector/rasterSynth.js';
import { ensureTesseract, recognizePage } from './tesseractOcr.js';
import { htmlToGxDoc } from '../ir/htmlToGxDoc.js';
import { gxDocToHtml } from '../ir/gxDocToHtml.js';
import { docxToGxDoc } from '../ir/docxToGxDoc.js';
import { jsonToGxDoc } from '../ir/jsonToGxDoc.js';
import * as annotationEngine from '../annotation/engine.js';
import { mountLayers as mountAnnotationLayers, unmountLayers as unmountAnnotationLayers } from '../annotation/layer.js';
// analyzePanel.js is injected by os-shell.js into this iframe at runtime.
// All calls are proxied through window.__GX_PDF_CORE__ dispatchers set up in app.js.
const _core = () => window.__GX_PDF_CORE__;

async function runAnalysis(bytes, filename) {
    const core = _core();
    if (!core) return null;
    // Status updates go through the shared setStatus in viewController
    // (analyzePanel's own _setStatus will handle in-panel messaging once injected).
    try {
        const analysis = await core.getAnalyzePDF()(bytes, () => {});
        core._dispatchAnalysisReady(analysis);
        return analysis;
    } catch (e) {
        console.warn('[Analyze] Analysis failed:', e.message);
        return null;
    }
}

// Resolves to the pre-flight analysis of the current pdf1, or null.
// Kept so the docling cross-check and OCR suggestion can await it.
let _analysisPromise = null;

// Resolves when the in-flight load of slot 1 has finished (or failed). An MCP
// caller can send bytes and immediately ask for the structured extraction, so
// the reply has to wait for the pipeline instead of answering "no document".
let _slot1Load = null;


export function integrationBackendUrl() {
    if (window.CwsContracts && window.CwsContracts.resolveBackend) {
        return window.CwsContracts.resolveBackend().url;
    }
    const meta = document.querySelector('meta[name="cws-backend"]');
    if (meta?.content) return meta.content.replace(/\/$/, '');
    const stored = localStorage.getItem('cws-backend-url');
    if (stored) return stored.replace(/\/$/, '');
    return 'http://localhost:8000';
}

// Cross-check the Docling result against the deterministic analyzer and
// surface + record disagreements. Best-effort: never blocks or fails the
// extraction it verifies.
async function _crossCheckDocling(assets) {
    try {
        const analysis = await _analysisPromise;
        if (!analysis?.pages?.length) return;
        const report = checkDoclingAgreement(analysis.pages, assets);
        if (report.flags.length) {
            console.warn('[Verifier] Docling vs geometry disagreements:', report.flags);
            showToast(
                `Verifier: ${report.flags.length} disagreement(s) between semantic and geometric views ` +
                `(agreement ${Math.round(report.agreementScore * 100)}%). Check the Analyze tab.`,
                'info',
            );
        }
        fetch(`${integrationBackendUrl()}/api/v1/ai/pdf/check/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ report }),
        }).catch(() => { /* corpus reporting is best-effort */ });
    } catch (e) {
        console.warn('[Verifier] Docling cross-check failed:', e.message);
    }
}

// ── AI auto-tune (Advance Extraction, vector docs) ───────────────────────────
// Document-level drive-and-verify: after Pass 1, the AI reviews pages the
// verifier scored poorly, proposes parameter/classification ops (validated
// server-side against the closed vocabulary), the deterministic engine
// re-runs those pages, and the verifier decides which result survives.
// A page is never left worse than Pass 1 left it.

const TUNE_MAX_PAGES = 5;   // cost circuit-breaker, not a quality gate
const DEFAULT_SCALE_OVERRIDES = {
    R_Y_BAND: 0.45, R_PARA_GAP: 1.80, R_COL_GAP_MIN: 1.50, STREAM_CONFIDENCE: 0.60,
};

// Best-effort product-analytics capture. window.posthog is initialised in
// index.html (assets/js/posthog-init.js); guard it so standalone/forked builds
// without the snippet don't throw. Frontend AI-funnel events land under the
// same project as the backend; the distinct_id stitching work (see
// project_analytics_baseline) is what will chain them end-to-end.
function _phCapture(event, props) {
    // GxTrack (assets/js/gx-track.js) picks the working transport: window.posthog
    // on the web, the extension-host bridge inside a VS Code webview where the
    // CSP blocks PostHog entirely. Falls back to posthog directly so a
    // standalone/forked build without the shim still reports.
    try {
        if (window.GxTrack) window.GxTrack(event, { tool: 'pdf-processor', ...props });
        else window.posthog?.capture?.(event, { tool: 'pdf-processor', ...props });
    } catch (_) { /* analytics is never load-bearing */ }
}

// ── Large-document gate for the AI drive-and-verify pass ─────────────────────
// The AI pass (Advance Extraction) is a Pro feature — the toggle is disabled in
// markup for free users. This gate is the SIZE dimension layered on top: Pro
// users have no page limit; any non-Pro context (e.g. a DOM-forced toggle, or a
// future BYO-key surface) reaching the AI pass with a document beyond
// AI_MAX_FREE_PAGES is the `document_too_large_for_ai` conversion moment — we
// skip only the costly AI refinement (deterministic extraction has already
// produced the full document), record it, and surface a Pro upsell.
const AI_MAX_FREE_PAGES = 20;

function _aiSizeGateOk(pageCount) {
    if (_isProUser() || pageCount <= AI_MAX_FREE_PAGES) return true;
    _phCapture('document_too_large_for_ai', {
        page_count: pageCount, limit: AI_MAX_FREE_PAGES, tier: 'free',
    });
    showToast(
        `${pageCount}-page document: AI refinement is capped at ${AI_MAX_FREE_PAGES} pages on the free tier. `
        + `Upgrade to Pro for unlimited AI on large documents — the deterministic extraction below is complete.`,
        'info',
    );
    return false;
}

async function _autoTunePages(pageResults) {
    const scored = pageResults.filter(p => p.verification);
    if (!scored.length) return;
    // Relative gate: pages differ (a diagram page legitimately scores lower
    // than a dense text page), so an absolute threshold misjudges both
    // directions. A page is a tune candidate when it falls clearly below its
    // OWN document's typical quality (median − 0.12); the absolute floor
    // catches uniformly bad documents where nothing is below the median by
    // much because everything is bad.
    const scores = scored.map(p => p.verification.score).sort((a, b) => a - b);
    const median = scores[Math.floor(scores.length / 2)];
    const gate = Math.max(0.60, median - 0.12);
    const candidates = scored
        .filter(p => p.verification.score < gate)
        .sort((a, b) => a.verification.score - b.verification.score)
        .slice(0, TUNE_MAX_PAGES);
    if (!candidates.length) {
        showToast('AI review: no page falls below this document\'s own quality baseline.', 'success');
        return;
    }
    // AI funnel — requested. Pairs with the ai_extraction_completed event below
    // so the requested→completed insight (dashboard 1916836) can be built from
    // frontend data instead of only backend spans.
    _phCapture('ai_extraction_requested', { candidate_pages: candidates.length });
    showToast(`AI reviewing ${candidates.length} low-scoring page(s)…`, 'info');
    let improved = 0, failed = 0;
    for (const p of candidates) {
        try {
            if (await _autoTunePage(p)) improved++;
        } catch (e) {
            failed++;
            console.warn(`[AI tune] page ${p.page} failed:`, e.message);
        }
    }
    _phCapture('ai_extraction_completed', {
        candidate_pages: candidates.length, improved, failed,
    });
    showToast(`AI tune: improved ${improved} of ${candidates.length} page(s)`, improved ? 'success' : 'info');
}

async function _autoTunePage(pageResult) {
    const analysis = await _analysisPromise;
    const pg = analysis?.pages?.[pageResult.page - 1];

    // Coordinate-free page summary — same AI boundary contract as the panel.
    const signals = {
        page: pageResult.page,
        textItemCount:   pg?.textItemCount ?? 0,
        hSegCount:       pg?.hSegCount ?? 0,
        vSegCount:       pg?.vSegCount ?? 0,
        diagSegCount:    pg?.diagSegCount ?? 0,
        closedRectCount: pg?.closedRectCount ?? 0,
        imageCount:      pg?.imageCount ?? 0,
        regions: (pageResult.regions || []).map(r => ({
            id: r.id, type: r.type, algorithm: r.algorithm,
            confidence: Math.round((r.confidence ?? 1) * 100) / 100,
        })),
        params: { ...DEFAULT_SCALE_OVERRIDES },
        skippedTypes: [],
        verification: pageResult.verification,
    };

    const res = await fetch(`${integrationBackendUrl()}/api/v1/ai/pdf/tune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            signals,
            context: { region_ids: signals.regions.map(r => r.id), params: signals.params },
        }),
    });
    const tune = await res.json();
    if (tune.status !== 'success' || !tune.ops?.length) return false;

    // Translate validated ops into a stateless reprocess pipeline.
    const scaleOverrides = { ...DEFAULT_SCALE_OVERRIDES };
    const skip = [];
    const customRegions = [];
    for (const op of tune.ops) {
        if (op.op === 'set_param' && op.param in scaleOverrides) {
            scaleOverrides[op.param] = op.value;
        } else if (op.op === 'skip_region_type') {
            skip.push(op.region_type);
        } else if (op.op === 'set_region_type') {
            const r = (pageResult.regions || []).find(x => x.id === op.region_id);
            if (r?.bbox) customRegions.push({ ...r, type: op.new_type, algorithm: 'custom-override' });
        }
    }

    const before = pageResult.verification.score;
    const after = await _reprocessAndWait(pageResult.page, {
        skip, scaleOverrides, customRegions, manualSplits: [],
    });
    const afterScore = after.verification?.score ?? 0;

    fetch(`${integrationBackendUrl()}/api/v1/ai/pdf/tune/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            trace_id: tune.trace_id,
            score_before: before,
            score_after: afterScore,
            verification_after: after.verification || {},
        }),
    }).catch(() => { /* corpus reporting is best-effort */ });

    if (afterScore <= before) {
        // The verifier rejected the proposal — restore the Pass 1 result.
        await _reprocessAndWait(pageResult.page, {
            skip: [], scaleOverrides: { ...DEFAULT_SCALE_OVERRIDES }, customRegions: [], manualSplits: [],
        });
        return false;
    }
    return true;
}

// Post a reprocess and resolve with that page's result message. The permanent
// listener still dispatches the same message to the analyze panel, which is
// what patches the visible HTML — this waiter only observes.
function _reprocessAndWait(pageNum, pipeline) {
    const worker = ensureGeometryWorker();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            worker.removeEventListener('message', handler);
            reject(new Error('tune reprocess timed out'));
        }, 120_000);
        const handler = (e) => {
            const msg = e.data;
            if (!msg.reprocess || msg.page !== pageNum) return;
            clearTimeout(timer);
            worker.removeEventListener('message', handler);
            if (msg.type === 'page') resolve(msg);
            else reject(new Error(msg.error || 'reprocess failed'));
        };
        worker.addEventListener('message', handler);
        worker.postMessage({ type: 'reprocess', page: pageNum, pipeline });
    });
}

// Local vector pipeline cannot read scanned pages — point the user at the
// Advance Extraction (Docling/OCR) path instead of silently returning nothing.
async function _maybeSuggestOcr() {
    try {
        const analysis = await _analysisPromise;
        const scanned = analysis?.pages?.filter(p => p.scanned).length || 0;
        if (!scanned) return;
        showToast(
            `${scanned} page(s) look scanned — the local vector pipeline can't read them. ` +
            `Use Advance Extraction (OCR) for this document.`,
            'info',
        );
    } catch (_) { /* analysis failed — nothing to suggest */ }
}

const pushRegionPage    = (n, r, s, v)    => _core()?._dispatchRegionPage(n, r, s, v);
const resetAnalysisData = ()              => _core()?._dispatchReset();
const setAnalyzeWorker  = (w)             => { window.__GX_PDF_GEO_WORKER__ = w; _core()?._dispatchWorkerReady(w); };
const onReprocessResult = (n, h, r, s, v) => _core()?._dispatchReprocessResult(n, h, r, s, v);
const onReprocessError  = (n, e)       => _core()?._dispatchReprocessError(n, e);
import { clearImages, saveImages, getImageBlob } from '../utils/imageStore.js';
import { refreshZoneToolbar } from './zoneToolbar.js';

let brokerReady = false;

// Lazily created geometry worker for local (offline) table extraction
let _geoWorker = null;

// Pro tier check — gates Advance Extraction (Docling/OpenRouter backend path) and
// the Analyze tab pipeline. Mirrors the architecture in pro-gate-system.md §7C.
// Embedded: ask the OS shell for the current user's tier. Standalone: default to free.
// Until auth Phase 7 wires real tier detection, this always returns false.
export function isProUser() { return _isProUser(); }

function _isProUser() {
    // Dev bypass — localhost always gets Pro so the AI layer can be exercised
    // against the local backend. Production hostnames use the real tier.
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return true;
    try {
        if (window.parent !== window && window.parent.OsShell && typeof window.parent.OsShell.getUser === 'function') {
            const user = window.parent.OsShell.getUser();
            return !!(user && (user.tier === 'pro' || user.tier === 'team'));
        }
    } catch (_) {
        // Cross-origin access can throw — treat as free.
    }
    return false;
}

// Unlock the Advance Extraction checkbox for Pro/dev users: enable the input,
// drop the locked styling, and remove the waitlist interceptor so checking it
// routes extraction through the backend AI path (Docling / OCR / all PDF types).
function _ungateAdvanceExtraction() {
    const toggle = document.getElementById('ai-layout-toggle');
    if (!toggle) return;
    toggle.disabled = false;
    toggle.style.cursor = 'pointer';
    const label = toggle.closest('label');
    if (label) {
        label.classList.remove('gx-pro-locked');
        label.style.cursor = 'pointer';
        label.querySelector('.gx-pro-interceptor')?.remove();
    }
}

// ── OCR: Tesseract.js (browser-native, whole-page, words+bbox+confidence) ────
// Replaced the TrOCR (Transformers.js single-line) path. See tesseractOcr.js.
// Tesseract does its own segmentation and returns word geometry, so the layout
// worker (YOLO) is kept only to LABEL regions, not to find text lines.

// ── Layout worker (YOLOv8/DocLayNet region detection) ───────────────────────
// Mirrors the OCR worker's manager: requestId-matched detect() calls and a
// stall-based init timeout (the ONNX model download can be slow on cold cache).
const LAYOUT_MODEL_SIZE = 640;   // model input is 640×640 (see layoutWorker.js)
let _layoutWorker = null;
let _layoutReady = false;
const _layoutCallbacks = new Map(); // requestId -> { resolve, reject }
let _layoutReqId = 0;

function ensureLayoutWorker() {
    return new Promise((resolve, reject) => {
        if (_layoutReady) { resolve(); return; }
        if (_layoutWorker) {
            const onReadyAgain = (e) => {
                if (e.data.type === 'ready') {
                    _layoutWorker.removeEventListener('message', onReadyAgain);
                    _layoutReady = true;
                    resolve();
                } else if (e.data.type === 'error' && e.data.requestId == null) {
                    _layoutWorker.removeEventListener('message', onReadyAgain);
                    reject(new Error(e.data.error));
                }
            };
            _layoutWorker.addEventListener('message', onReadyAgain);
            return;
        }

        _layoutWorker = new Worker(
            new URL('../workers/layoutWorker.js', import.meta.url),
            { type: 'module' },
        );

        // Permanent listener: resolve detect() promises by requestId.
        _layoutWorker.addEventListener('message', (e) => {
            const msg = e.data;
            if (msg.type === 'progress' && msg.status) {
                console.log('[layoutWorker]', msg.status);
                return;
            }
            if (msg.type === 'result' && msg.requestId != null) {
                const cb = _layoutCallbacks.get(msg.requestId);
                if (cb) { _layoutCallbacks.delete(msg.requestId); cb.resolve(msg.regions || []); }
                return;
            }
            if (msg.type === 'error' && msg.requestId != null) {
                const cb = _layoutCallbacks.get(msg.requestId);
                if (cb) { _layoutCallbacks.delete(msg.requestId); cb.reject(new Error(msg.error || 'Layout detection failed')); }
                return;
            }
        });

        _layoutWorker.postMessage({ type: 'init' });

        const STALL_MS = 90_000;
        let stallTimer = null;
        const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
        const armStall = () => {
            clearStall();
            stallTimer = setTimeout(() => {
                _layoutWorker.removeEventListener('message', onReady);
                reject(new Error('Layout model load stalled (no progress for 90s).'));
            }, STALL_MS);
        };
        const onReady = (e) => {
            if (e.data.type === 'progress') { armStall(); return; }
            if (e.data.type === 'ready') {
                clearStall();
                _layoutWorker.removeEventListener('message', onReady);
                _layoutReady = true;
                resolve();
            } else if (e.data.type === 'error' && e.data.requestId == null) {
                clearStall();
                _layoutWorker.removeEventListener('message', onReady);
                reject(new Error(e.data.error));
            }
        };
        _layoutWorker.addEventListener('message', onReady);
        armStall();
    });
}

/**
 * Run layout detection on a page image.
 * @param {ImageBitmap} imageBitmap
 * @returns {Promise<Array<{label,confidence,bbox}>>} bbox in 640×640 model space.
 */
function layoutDetect(imageBitmap) {
    return new Promise((resolve, reject) => {
        if (!_layoutWorker || !_layoutReady) {
            reject(new Error('Layout worker not ready. Call ensureLayoutWorker() first.'));
            return;
        }
        const reqId = ++_layoutReqId;
        _layoutCallbacks.set(reqId, { resolve, reject });
        _layoutWorker.postMessage(
            { type: 'detect', requestId: reqId, data: { imageBitmap } },
            [imageBitmap],
        );
    });
}

function _disposeLayoutWorker() {
    if (_layoutWorker) {
        _layoutWorker.postMessage({ type: 'dispose' });
        _layoutWorker.terminate();
        _layoutWorker = null;
        _layoutReady = false;
    }
}

/**
 * Extract a SCANNED PDF by rejoining the vector geometry pipeline:
 *   render page → layoutWorker (regions) → per-region TrOCR → rasterSynth
 *   (synthetic PDF.js text items + table borders) → classifyPage + assemblePage.
 * This is the CTM-synthesis path: scanned docs produce the same record shapes
 * and downstream output (tables, headings, columns) as vector PDFs, instead of
 * the naive full-page single-line OCR dump.
 *
 * @param {Uint8Array} bytes
 * @param {function} [onProgress]
 * @returns {Promise<{html,text,tableCount,pages,source}>}
 */
async function extractViaScannedGeometry(bytes, onProgress) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = window.__VSC_PDF_WORKER_SRC__ || pdfWorkerUrl;

    const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const numPages = pdf.numPages;

    if (onProgress) onProgress('Preparing layout + OCR models…');
    await ensureTesseract();
    const layoutAvailable = await ensureLayoutWorker().then(() => true).catch(layoutErr => {
        console.warn('[extractViaScannedGeometry] Layout model unavailable, OCR will run without region labels:', layoutErr.message);
        return false;
    });

    const VIEWPORT_SCALE = 2.0;   // classifyPage viewport scale
    const RENDER_SCALE = 2.0;     // page render scale for detection + OCR
    const fontRegistry = createFontRegistry();
    const htmlParts = [];
    const textParts = [];
    const pageResults = [];
    const analysisPages = [];     // analysis.pages[] for analyzePanel
    const worker = ensureGeometryWorker();
    let totalTables = 0;

    for (let i = 1; i <= numPages; i++) {
        if (onProgress) onProgress(`Layout + OCR page ${i}/${numPages}…`);

        const page = await pdf.getPage(i);
        const pageWidthPt = page.view[2] - page.view[0];
        const pageHeightPt = page.view[3] - page.view[1];

        // Render the page once; both layout detection and Tesseract read it.
        const rViewport = page.getViewport({ scale: RENDER_SCALE });
        const rw = Math.round(rViewport.width);
        const rh = Math.round(rViewport.height);
        const pageCanvas = new OffscreenCanvas(rw, rh);
        const pctx = pageCanvas.getContext('2d');
        await page.render({ canvasContext: pctx, viewport: rViewport }).promise;

        // 1) Layout detection (YOLO) + full-page OCR (Tesseract) in parallel.
        //    Tesseract does its OWN line/word segmentation and returns words with
        //    real bboxes + confidence — no projection-profile line splitting, no
        //    per-line model round-trips. YOLO is kept ONLY to LABEL regions
        //    (table/figure/heading) so tableBuilder + heading detection fire.
        const detectBitmap = layoutAvailable ? await createImageBitmap(pageCanvas) : null;
        const [rawRegions, ocr] = await Promise.all([
            detectBitmap ? layoutDetect(detectBitmap) : Promise.resolve([]),   // bbox in 640-space
            recognizePage(pageCanvas),           // { words:[{text,bbox,confidence}], text }
        ]);

        // Normalize 640-space YOLO boxes → fractional [0,1] page coords (top-left).
        const labelRegions = rawRegions
            .map(r => ({
                label: r.label,
                confidence: r.confidence,
                bbox: {
                    x: Math.max(0, r.bbox.x / LAYOUT_MODEL_SIZE),
                    y: Math.max(0, r.bbox.y / LAYOUT_MODEL_SIZE),
                    w: Math.min(1, r.bbox.w / LAYOUT_MODEL_SIZE),
                    h: Math.min(1, r.bbox.h / LAYOUT_MODEL_SIZE),
                },
            }))
            .filter(r => r.bbox.w > 0.005 && r.bbox.h > 0.005);

        // 2) Synthesize vector-shaped inputs from WORDS (real bboxes) and run the
        //    real pipeline. YOLO labels tag words (heading/table) + emit borders.
        const geom = {
            pageWidthPt, pageHeightPt,
            renderWidth: rw, renderHeight: rh,
            viewportWidth: pageWidthPt * VIEWPORT_SCALE,
            viewportHeight: pageHeightPt * VIEWPORT_SCALE,
        };
        const synth = synthesizeFromWords(ocr.words, labelRegions, geom);
        const viewport = makeSyntheticViewport(pageWidthPt, pageHeightPt, VIEWPORT_SCALE);

        // No path segments on a scanned page; filledRects carry the table frames.
        const { regions: classified, textMeta, columnSplits, rawSplits } = classifyPage(
            [], synth.textItems, viewport, pageWidthPt, synth.imageMeta,
            { filledRects: synth.filledRects },
        );
        const result = assemblePage(
            classified, textMeta, synth.textItems, viewport, pageWidthPt, i,
            fontRegistry, rawSplits ?? columnSplits, {}, null,
        );

        totalTables += result.tableCount || 0;
        htmlParts.push(result.html);
        textParts.push((result.text || '').trim());
        pageResults.push({ page: i, ocr: true, scanned: true, tables: result.tableCount || 0 });

        // Cache this page's synthetic inputs in the geometry worker so a later
        // re-extract (analyzePanel sliders / column splits) re-runs classify on
        // the SAME synthetic text items instead of re-parsing the (image-only) PDF.
        worker.postMessage({
            type: 'cache-scanned-page',
            page: i,
            synth: { textItems: synth.textItems, filledRects: synth.filledRects, imageMeta: synth.imageMeta },
            pageWidthPt, pageHeightPt, viewportScale: VIEWPORT_SCALE,
        });

        // Build the analysis page object so analyzePanel renders this scanned
        // page exactly like a technical one (canvas, region layers, re-extract).
        analysisPages.push({
            scanned: true,
            ocrLayer: true,
            pageNum: i,
            widthPx: viewport.width,
            heightPx: viewport.height,
            widthPt: pageWidthPt,
            heightPt: pageHeightPt,
            widthIn: (pageWidthPt / 72).toFixed(2),
            heightIn: (pageHeightPt / 72).toFixed(2),
            textItemCount: synth.textItems.length,
            hSegCount: synth.hSegs.length,
            vSegCount: synth.vSegs.length,
            diagSegCount: 0,
            totalSegCount: synth.hSegs.length + synth.vSegs.length,
            imageCount: synth.imageRegions.length,
            closedRectCount: 0,
            hSegs: synth.hSegs,
            vSegs: synth.vSegs,
            diagSegs: [],
            closedRects: [],
            imageRegions: synth.imageRegions,
            textItems: synth.textItems,
            viewport,
        });

        page.cleanup();
    }

    // Push the synthetic analysis so analyzePanel treats scanned pages like
    // technical ones (region editing, sliders, send-to-schema all light up).
    try {
        _core()?._dispatchAnalysisReady({
            metadata: { pageCount: numPages, source: 'local-ocr-geometry', scanned: true },
            pages: analysisPages,
        });
    } catch (e) {
        console.warn('[ScannedGeometry] analysis dispatch failed:', e.message);
    }

    return {
        html: htmlParts.join('\n'),
        text: textParts.join('\n\n'),
        tableCount: totalTables,
        pages: pageResults,
        source: 'local-ocr-geometry',
    };
}

function ensureGeometryWorker() {
    if (!_geoWorker) {
        _geoWorker = new Worker(
            new URL('../workers/geometryWorker.js', import.meta.url),
            { type: 'module' },
        );
        
        // Permanent listener for reprocess results and errors, which can happen anytime
        _geoWorker.addEventListener('message', (e) => {
            const msg = e.data;
            if (msg.reprocess) {
                if (msg.type === 'page') {
                    onReprocessResult(msg.page, msg.html, msg.regions, msg.pageScale, msg.verification);
                } else if (msg.type === 'error') {
                    onReprocessError(msg.page, msg.error);
                }
            }
        });

        // Give analyzePanel a reference so Re-extract page can post messages
        setAnalyzeWorker(_geoWorker);
    }
    return _geoWorker;
}

/**
 * Run the local vector extraction pipeline via geometryWorker.
 * Returns { html, tableCount } on success; throws on error.
 */
function extractViaGeometryWorker(bytes, onProgress) {
    return new Promise((resolve, reject) => {
        const worker = ensureGeometryWorker();

        // Accumulate per-page results on the main thread
        // to avoid structured clone stack overflow on large PDFs
        const htmlParts = [];
        const textParts = [];
        const pageResults = [];   // {page, regions, verification} — feeds the AI auto-tune pass
        let totalTables = 0;

        const timeout = setTimeout(() => {
            reject(new Error('Local extraction timed out (>5min).'));
        }, 300_000);

        worker.onmessage = (e) => {
            const msg = e.data;
            // Reprocess responses are handled by the permanent event listener, ignore here
            if (msg.reprocess) return;
            if (msg.type === 'progress' && onProgress) {
                onProgress(`Extracting page ${msg.page}/${msg.total}…`);
            } else if (msg.type === 'page') {
                if (msg.html) htmlParts.push(msg.html);
                if (msg.text) textParts.push(msg.text);
                totalTables += msg.tables || 0;
                if (msg.regions) {
                    pushRegionPage(msg.page, msg.regions, msg.pageScale, msg.verification);
                    pageResults.push({ page: msg.page, regions: msg.regions, verification: msg.verification || null });
                }
            } else if (msg.type === 'complete') {
                clearTimeout(timeout);
                const styleBlock = msg.styles ? `<style>\n${msg.styles}\n</style>\n` : '';
                const html = htmlParts.length > 0
                    ? styleBlock + htmlParts.join('\n')
                    : '<p class="no-tables-msg">No table structures detected. This PDF may use text-only layout.</p>';
                const text = textParts.join('\n\n--- page break ---\n\n');
                resolve({ html, text, tableCount: msg.tableCount ?? totalTables, pages: pageResults });
            } else if (msg.type === 'error') {
                clearTimeout(timeout);
                reject(new Error(msg.error));
            }
        };

        worker.onerror = (err) => {
            clearTimeout(timeout);
            reject(new Error('Geometry worker crashed: ' + (err.message || err)));
        };

        worker.postMessage({ 
            type: 'process', 
            bytes,
            pdfWorkerSrc: window.__VSC_PDF_WORKER_SRC__ 
        });
    });
}

export async function loadFileToSlot(file, slot = 1) {
    const route = _routeFile(file.name);
    let process;
    if (route === 'docx') {
        process = handleDocxFile(file, slot);
    } else if (route === 'doc') {
        process = handleDocumentFile(file, slot);
    } else if (route === 'json') {
        process = handleJsonFile(file, slot);
    } else {
        process = handleFile(file, slot);
    }
    if (slot === 1) {
        _slot1Load = process.catch(() => {});
    }
    return process;
}

export function initFileInputs() {
    if (_isProUser()) _ungateAdvanceExtraction();

    // AI panel (OS shell) content requests — reply with the extracted document text
    window.addEventListener('message', e => {
        if (e.origin !== window.location.origin || e.data?.type !== 'gx:ai-get-context') return;
        e.source.postMessage({
            type: 'gx:ai-context',
            requestId: e.data.requestId,
            payload: { text: state.pdf1.extractedText || '' },
        }, e.origin);
    });

    cwsBroker.init().then(() => {
        brokerReady = true;
        const mode = cwsBroker.getBackendStatus() ? 'Cloud Backend' : 'Offline (local geometry worker)';
        console.log(`[FileUpload] Broker ready — mode: ${mode}`);
    });

    $('#file1-input').on('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        loadFileToSlot(file, 1);
    });

    $('#file2-input').on('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        loadFileToSlot(file, 2);
    });

    // VS Code extension: signal ready then receive file bytes from extension host
    if (window.CwsBridge?.isEmbedded) {
        window.CwsBridge.send('ginexys:pdf-ready', {});
        window.addEventListener('message', e => {
            // MCP round-trip: extension host requests extracted text, reply with it
            if (e.data?.__ginexys && e.data.type === 'ginexys:mcp-extract-text') {
                const text = window.state?.pdf1?.extractedText ?? '';
                window.CwsBridge.reply(e.data.requestId, { text: text || null });
                return;
            }
            // MCP round-trip: STRUCTURED extraction — span-resolved tables,
            // per-table confidence and provenance (headless-extraction-contract.md).
            // Awaits an in-flight load first: bytes and this request can arrive
            // back-to-back from an agent that never opened the file by hand.
            if (e.data?.__ginexys && e.data.type === 'ginexys:mcp-extract-structured') {
                const requestId = e.data.requestId;
                Promise.resolve(_slot1Load).catch(() => {}).then(() => {
                    let payload;
                    try {
                        payload = buildStructuredPayload();
                    } catch (err) {
                        payload = {
                            ok: false,
                            reason: 'structured-extract-failed',
                            detail: String(err?.message || err),
                        };
                    }
                    window.CwsBridge.reply(requestId, payload);
                });
                return;
            }
            if (e.data?.type === 'ginexys:pdf-bytes') {
                const { buffer, encoding, fileName, mode } = e.data.payload;
                const name = fileName ?? 'document.pdf';
                const route = _routeFile(name);
                const mimeType = route === 'docx'
                    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                    : route === 'json' ? 'application/json'
                    : route === 'doc' ? 'text/html' : 'application/pdf';
                // 0.1.7+ sends base64; older hosts sent a plain byte array.
                let bytes;
                if (encoding === 'base64' || typeof buffer === 'string') {
                    const bin = atob(buffer);
                    bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                } else {
                    bytes = new Uint8Array(buffer);
                }
                const blob = new Blob([bytes], { type: mimeType });
                const file = new File([blob], name, { type: mimeType });
                const process = route === 'docx' ? handleDocxFile(file, 1)
                    : route === 'json' ? handleJsonFile(file, 1)
                    : route === 'doc' ? handleDocumentFile(file)
                    : handleFile(file, 1);
                _slot1Load = process.catch(() => {});
                process.then(() => { if (mode) switchView(mode); });
            }
        });
    }
}

/** File extension → import pipeline: 'docx' | 'doc' (HTML/MD) | 'json' | 'pdf'. */
function _routeFile(name) {
    if (/\.docx$/i.test(name)) return 'docx';
    if (/\.json$/i.test(name)) return 'json';
    if (/\.(html?|md)$/i.test(name)) return 'doc';
    return 'pdf';
}

async function handleDocumentFile(file, slot = 1) {
    const text = await file.text();
    let html = text;

    if (/\.md$/i.test(file.name)) {
        html = markdownToHtml(text);
    }

    // For external HTML files, preserve <style> blocks so the document renders
    // with its own styles. DOMPurify strips <style> by default.
    // <link rel="stylesheet"> pointing to external URLs is intentionally not
    // allowed -- it would load arbitrary third-party CSS into the tool page.
    // Scripts remain blocked regardless.
    const clean = typeof DOMPurify !== 'undefined'
        ? DOMPurify.sanitize(html, {
            ADD_TAGS: ['style'],
            ALLOW_DATA_ATTR: true,
            FORCE_BODY: false,
          })
        : html;

    const pdfState = slot === 2 ? state.pdf2 : state.pdf1;
    const label = slot === 2 ? 'file2' : 'file1';

    pdfState.extractedHTML = clean;
    pdfState.extractedText = clean.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    pdfState.file = file;
    pdfState.gxDoc = htmlToGxDoc(clean, {
        source: /\.md$/i.test(file.name) ? 'markdown' : 'html',
        title: file.name,
    });
    // An imported HTML/Markdown document was never run through the PDF
    // pipeline — no page model, no scanned classification, nothing measured.
    pdfState.extraction = {
        source: 'document-import',
        pageCount: null,
        tableCount: null,
        scannedPageCount: null,
        isScanned: null,
    };
    $(`#${label}-name`).text(file.name);
    $(`#${label}-input`).closest('.file-btn').addClass('loaded');

    if (slot === 2) {
        _onSlotLoaded(2);
        showToast(`${file.name} loaded for compare`, 'success');
        return;
    }

    applyHtmlEverywhere(clean, null);
    switchView('html');
    _onSlotLoaded(1);
    showToast(`${file.name} loaded`, 'success');
}

async function handleDocxFile(file, slot = 1) {
    const buf = await file.arrayBuffer();
    const gxDoc = await docxToGxDoc(buf, { source: 'docx', title: file.name });
    const html = gxDocToHtml(gxDoc);
    const pdfState = slot === 2 ? state.pdf2 : state.pdf1;
    const label = slot === 2 ? 'file2' : 'file1';

    pdfState.gxDoc = gxDoc;
    pdfState.extractedHTML = html;
    pdfState.extractedText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    pdfState.file = file;
    pdfState.extraction = {
        source: 'docx',
        pageCount: gxDoc.pages.length,
        tableCount: null,
        scannedPageCount: null,
        isScanned: false,
    };
    $(`#${label}-name`).text(file.name);
    $(`#${label}-input`).closest('.file-btn').addClass('loaded');

    if (slot === 2) {
        _onSlotLoaded(2);
        showToast(`${file.name} loaded for compare`, 'success');
        return;
    }

    applyHtmlEverywhere(html, null);
    switchView('html');
    _onSlotLoaded(1);
    showToast(`${file.name} loaded`, 'success');
}

async function handleJsonFile(file, slot = 1) {
    try {
        const text = await file.text();
        const gxDoc = jsonToGxDoc(text, { source: 'json', title: file.name });
        const html = gxDocToHtml(gxDoc);
        const pdfState = slot === 2 ? state.pdf2 : state.pdf1;
        const label = slot === 2 ? 'file2' : 'file1';

        pdfState.gxDoc = gxDoc;
        pdfState.extractedHTML = html;
        pdfState.extractedText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        pdfState.file = file;
        pdfState.extraction = {
            source: 'json',
            pageCount: gxDoc.pages.length,
            tableCount: null,
            scannedPageCount: null,
            isScanned: false,
        };
        if (slot === 1) annotationEngine.loadFromGxDoc(gxDoc);
        $(`#${label}-name`).text(file.name);
        $(`#${label}-input`).closest('.file-btn').addClass('loaded');

        if (slot === 2) {
            _onSlotLoaded(2);
            showToast(`${file.name} loaded for compare`, 'success');
            return;
        }

        applyHtmlEverywhere(html, null);
        switchView('html');
        _onSlotLoaded(1);
        showToast(`${file.name} loaded`, 'success');
    } catch (err) {
        showToast(`Could not import ${file.name}: ${err.message}`, 'error');
    }
}

export function markdownToHtml(md) {
    return md
        .replace(/^#{6}\s+(.+)$/gm, '<h6>$1</h6>')
        .replace(/^#{5}\s+(.+)$/gm, '<h5>$1</h5>')
        .replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>')
        .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
        .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
        .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>\n?)+/g, s => `<ul>${s}</ul>`)
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\n{2,}/g, '</p><p>')
        .replace(/^(?!<[h|u|l|p])/gm, '')
        .replace(/^(.+)$/gm, (line) => {
            if (/^<(h[1-6]|ul|li|p)/.test(line)) return line;
            return `<p class="pdf-region type-paragraph">${line}</p>`;
        });
}

async function handleFile(file, pdfIndex) {
    const pdfState = pdfIndex === 1 ? state.pdf1 : state.pdf2;
    const label = pdfIndex === 1 ? 'file1' : 'file2';

    pdfState.file = file;
    $(`#${label}-name`).text(file.name);
    $(`#${label}-input`).closest('.file-btn').addClass('loaded');

    showStatus('Loading PDF…');
    try {
        const buf = await file.arrayBuffer();
        pdfState.bytes = new Uint8Array(buf.slice(0));

        // Pre-copy slices before any PDF.js call — getDocument transfers and detaches the buffer.
        const bytesForCanvas   = pdfState.bytes.slice();
        const bytesForWorker   = pdfState.bytes.slice();

        if (pdfIndex === 1) {
            resetPDFLayers();
            resetAnalysisData();
            const { wrappers, numPages } = await renderPDFToCanvas(bytesForCanvas, 'pdf-canvas-container');
            registerPages(wrappers, numPages);
            registerPDFLayers(document.getElementById('pdf-canvas-container'));
            unmountAnnotationLayers(document.getElementById('pdf-canvas-container'));
            mountAnnotationLayers(document.getElementById('pdf-canvas-container'));
            const bytesForAnalysis = pdfState.bytes.slice();

            // Unconditionally initialize geometry worker and give analyzePanel its reference
            const worker = ensureGeometryWorker();
            // Cache PDF bytes in the geometry worker so interactive re-extraction works on any pipeline
            worker.postMessage({
                type: 'cache-bytes',
                bytes: bytesForAnalysis.slice()
            });

            _analysisPromise = runAnalysis(bytesForAnalysis, file.name).catch(err => {
                console.warn('[Analyze] Analysis failed:', err.message);
                return null;
            });
        }

        const formData = new FormData();
        formData.append('file', file);

        // Advance Extraction (AI layout via Docling + OpenRouter) is a Pro feature gated
        // by the .gx-pro-interceptor overlay in index.html. The checkbox is disabled in
        // markup so .checked is always false for free users; the explicit check below
        // is defense in depth against DOM manipulation.
        const toggle = document.getElementById('ai-layout-toggle');
        const useAiLayout = toggle && !toggle.disabled && toggle.checked;

        let data;
        let runAutoTune = false;
        let scannedCount = 0;
        let isScannedDoc = false;
        let useLocalScannedGeometry = false;
        let localOcrFailReason = null;

        // Routing (pdf-extraction-v2.md §01): pdfjs-visible vector content is
        // ALWAYS extracted by the deterministic geometry engine — Advance
        // Extraction does not swap extractors, it adds the AI drive-and-verify
        // pass on top (auto-tune of low-scoring pages, Pass 2).
        //
        // SCANNED documents (no vector substrate — e.g. 0 fonts, image-only
        // pages) have nothing for the geometry engine to read, so they route to
        // the local-first raster→geometry bridge: layoutWorker (YOLOv8) finds
        // regions, TrOCR transcribes each, and rasterSynth feeds synthetic text
        // items back into the SAME classifyPage/assemblePage pipeline. This is
        // free and in-tab (manifesto: heavy work, no server) — NOT gated behind
        // the Pro Advance-Extraction toggle. Docling stays as the backend
        // fallback only when the local models fail to load.
        let useBackend = false;
        if (pdfIndex === 1) {
            showStatus('Pre-flight: classifying document…');
            const analysis = await _analysisPromise;
            const pages = analysis?.pages || [];
            scannedCount = pages.filter(p => p.scanned).length;
            isScannedDoc = pages.length > 0 && scannedCount > pages.length / 2;

            if (isScannedDoc) {
                // Scanned → local raster→geometry bridge (layout + OCR in-tab).
                // Tesseract (OCR) is the load-bearing piece and is required; the
                // YOLO layout model only LABELS regions (table/heading) for nicer
                // structure, so its failure alone must not force a fallback to
                // the Pro-gated backend — that would wrongly look like local OCR
                // is tier-gated when it isn't.
                showStatus('Scanned document — preparing local OCR…');
                try {
                    await ensureTesseract();
                    useLocalScannedGeometry = true;
                    ensureLayoutWorker().catch(layoutErr =>
                        console.warn('[HandleFile] Layout model failed to load, OCR will run without region labels:', layoutErr.message));
                } catch (mlErr) {
                    localOcrFailReason = mlErr.message;
                    console.warn('[HandleFile] Local OCR (Tesseract) init failed, falling back to backend:', mlErr.message);
                    if (!brokerReady) {
                        showStatus('Connecting to backend OCR service…');
                        await cwsBroker.init();
                        brokerReady = true;
                    }
                    useBackend = cwsBroker.getBackendStatus();
                }
            } else if (useAiLayout) {
                // Vector doc + Advance Extraction: geometry runs, AI re-tolerances
                // low-scoring pages afterward (Pass 2). The AI pass is Pro-only
                // (toggle-gated) and additionally size-gated — Pro has no page
                // limit, non-Pro large docs skip the AI pass with a Pro upsell.
                // Deterministic extraction below runs regardless and stays free.
                runAutoTune = _aiSizeGateOk(pages.length);
            }
        }

        if (useBackend) {
            // ── Advance Extraction, scanned doc: plain Docling (no LLM stage) ─
            data = await cwsBroker.extractPdf(formData, (msg) => showStatus(
                typeof msg === 'string' ? msg : (msg.message || 'Processing…'),
            ));
            
            // If backend provides images, cache them
            if (data.images || data.assets) {
                const imgDict = data.images || data.assets;
                // convert base64 dict to blobs if needed
                const blobsToSave = {};
                for (const [id, val] of Object.entries(imgDict)) {
                    if (val instanceof Blob) {
                        blobsToSave[id] = val;
                    } else if (typeof val === 'string' && val.startsWith('data:image')) {
                        const res = await fetch(val);
                        blobsToSave[id] = await res.blob();
                    }
                }
                await clearImages();
                await saveImages(blobsToSave);
            }

            // Verifier link: cross-check Docling's semantic view against the
            // deterministic pre-flight analyzer. Disagreements are flagged to
            // the user and recorded to the corpus (fuel-quality.md capture point).
            if (pdfIndex === 1 && data.assets) {
                _crossCheckDocling(data.assets);
            }
        } else if (useLocalScannedGeometry) {
            // ── Local scanned path: layout (YOLOv8, labels) + Tesseract (words) →
            //    rasterSynth → classifyPage/assemblePage. Same downstream as
            //    vector PDFs, so tables/headings/columns are reconstructed.
            showStatus('Running local layout + OCR on scanned pages…');
            const result = await extractViaScannedGeometry(bytesForWorker, (msg) => showStatus(msg));
            data = { html: result.html, text: result.text || '', source: 'local-ocr-geometry', tableCount: result.tableCount, pages: result.pages };
        } else {
            // ── Primary: deterministic geometry pipeline (Pass 1 + verifier) ──
            // NOTE: a SCANNED doc reaching here means both local OCR (Tesseract)
            // and the backend fell through — the vector engine has nothing to
            // read, so warn instead of silently reporting an empty "success".
            if (isScannedDoc) {
                showToast(
                    localOcrFailReason
                        ? `Scanned document, but local OCR failed to start (${localOcrFailReason}) and the backend is unavailable — extraction will be empty.`
                        : 'Scanned document, but local OCR and backend are both unavailable — extraction will be empty.',
                    'error',
                );
            }
            const result = await extractViaGeometryWorker(bytesForWorker, (msg) => showStatus(msg));
            data = { html: result.html, text: result.text || '', source: 'local', tableCount: result.tableCount, pages: result.pages };
            if (pdfIndex === 1) _maybeSuggestOcr();
        }

        pdfState.extractedHTML = data.html;
        pdfState.extractedText = data.text || '';
        // The typed IR mirrors the rendered HTML so exporters and the MCP fast
        // path can read blocks without re-parsing the DOM (import-export-gateway.md).
        pdfState.gxDoc = htmlToGxDoc(data.html, {
            source: data.source === 'local-ocr-geometry' ? 'pdf-scanned' : 'pdf',
            title: file.name,
            pageCount: data.pages?.length ?? null,
        });
        if (pdfIndex === 1) annotationEngine.loadFromGxDoc(pdfState.gxDoc);
        // Extraction facts the DOM cannot carry — which engine ran, how many
        // pages it saw, and whether the pre-flight classified the document as
        // scanned. The structured MCP reply reports these rather than guessing.
        pdfState.extraction = {
            source: data.source ?? null,
            pageCount: data.pages?.length ?? null,
            tableCount: data.tableCount ?? null,
            // Pre-flight classification only runs for slot 1; null (unknown)
            // rather than false for the compare slot.
            scannedPageCount: pdfIndex === 1 ? scannedCount : null,
            isScanned: pdfIndex === 1 ? !!isScannedDoc : null,
        };

        if (pdfIndex === 1) {
            // Push the freshly-extracted HTML to ALL surfaces in one shot:
            // state, both contenteditable previews, and the Monaco model.
            applyHtmlEverywhere(pdfState.extractedHTML, null);
            // Populate zone chips for the first visible page
            refreshZoneToolbar();
            markDiffDirty();
            _onSlotLoaded(1);
            // Advance Extraction, vector doc: AI reviews the verifier's scores
            // and re-tolerances weak pages. Runs async — pages patch in place
            // through the same path as a manual analyze-tab re-extract.
            if (runAutoTune && data.pages?.length) {
                _autoTunePages(data.pages).catch(e =>
                    console.warn('[AI tune] auto pass failed:', e.message));
            }
        } else {
            _onSlotLoaded(2);
        }

        const SOURCE_LABELS = {
            'local': 'deterministic vector pipeline',
            'local-ocr-geometry': 'local layout + OCR (scanned)',
        };
        const source = SOURCE_LABELS[data.source] || 'Advance Extraction (Docling)';
        const warnSuffix = data.warning ? ` (${data.warning})` : '';
        const tableSuffix = (data.source === 'local' || data.source === 'local-ocr-geometry') && data.tableCount != null
            ? ` — ${data.tableCount} table${data.tableCount !== 1 ? 's' : ''} detected`
            : '';
        _onSlotLoaded(pdfIndex);
        // The outcome event. `data.source` distinguishes the local deterministic
        // pipeline from local OCR and from the backend, so the three engines can
        // be compared on table yield rather than guessed at.
        _phCapture('document_extracted', {
            source: data.source,
            table_count: data.tableCount ?? null,
            page_count: data.pages?.length ?? null,
            found_tables: (data.tableCount ?? 0) > 0,
            has_warning: !!data.warning,
            is_scanned: !!isScannedDoc,
            slot: pdfIndex,
        });
        showToast(`PDF loaded via ${source}${tableSuffix}${warnSuffix}`, 'success');
        hideStatus();

    } catch (err) {
        console.error(`Error loading PDF ${pdfIndex}:`, err);
        hideStatus();
        // No `is_scanned` here: it is declared with `let` inside the try block
        // above, so reading it from catch would throw a ReferenceError and take
        // out the error toast with it.
        _phCapture('document_extraction_failed', {
            reason: (err && err.message) ? String(err.message).slice(0, 200) : 'unknown',
            slot: pdfIndex,
        });
        showToast('Extraction Error: ' + (err.message || err.toString()), 'error');
        if (pdfIndex === 2) disableDiffTab();
    }
}

export function populateHTMLPreview(html, containerId = 'html-preview') {
    const el = document.getElementById(containerId);
    if (!el) return;
    const clean = typeof DOMPurify !== 'undefined'
        ? DOMPurify.sanitize(html, { ADD_TAGS: ['img'], ALLOW_DATA_ATTR: true })
        : html;
    el.innerHTML = clean;
    // VisualGridMapper is invoked here via initTableFeatures → initCrosshair,
    // enabling crosshair highlight and column features on merged-cell tables.
    initTableFeatures(el);
    hydrateImages(el);
}

/**
 * Mount an ALREADY-EXTRACTED document into a slot and bring every surface up
 * with it: canvas render, text layers, annotation layers, analysis regions,
 * zone chips, diff state.
 *
 * This is the one path a document takes into the app. `handleFile` runs it after
 * the geometry worker returns; the batch view runs it when a queued document is
 * focused. Batch used to mount by hand and skipped most of this, which is why a
 * focused batch document had no analyze panel, no zone toolbar, no annotation
 * layer and no editable text — it looked loaded and behaved like nothing was.
 *
 * @param {object} doc
 *   file, bytes (Uint8Array|null), html, text, gxDoc, pages (per-page regions),
 *   extraction (facts about the engine that produced this), slot (1|2)
 */
export async function mountExtractedDocument({
    file, bytes = null, html = '', text = '', gxDoc = null,
    pages = [], extraction = null, slot = 1,
}) {
    const pdfState = slot === 2 ? state.pdf2 : state.pdf1;
    const label = slot === 2 ? 'file2' : 'file1';

    pdfState.file = file || null;
    // Keep a pristine copy: pdf.js and pdf-lib both detach the buffer they are
    // handed, so the slot must never hold the same array anything else consumes.
    pdfState.bytes = bytes ? bytes.slice() : null;
    pdfState.extractedHTML = html;
    pdfState.extractedText = text;
    pdfState.gxDoc = gxDoc;
    pdfState.extraction = extraction;

    $(`#${label}-name`).text(file?.name || '');
    $(`#${label}-input`).closest('.file-btn').addClass('loaded');

    if (slot === 2) {
        _onSlotLoaded(2);
        return;
    }

    resetPDFLayers();
    resetAnalysisData();

    if (pdfState.bytes) {
        const container = document.getElementById('pdf-canvas-container');
        const { wrappers, numPages } = await renderPDFToCanvas(pdfState.bytes.slice(), 'pdf-canvas-container');
        registerPages(wrappers, numPages);
        registerPDFLayers(container);
        unmountAnnotationLayers(container);
        mountAnnotationLayers(container);

        // The analyze panel re-extracts single pages against bytes CACHED IN THE
        // WORKER. Without this, "Re-extract page" is dead for the document.
        const worker = ensureGeometryWorker();
        worker.postMessage({ type: 'cache-bytes', bytes: pdfState.bytes.slice() });

        _analysisPromise = runAnalysis(pdfState.bytes.slice(), file?.name || 'document')
            .catch(err => { console.warn('[Analyze] Analysis failed:', err.message); return null; });
    }

    // Replay the per-page regions the extraction already produced, so the
    // analyze panel and zone toolbar are populated without a second pass.
    for (const p of pages) {
        pushRegionPage(p.page, p.regions, p.pageScale, p.verification);
    }

    annotationEngine.loadFromGxDoc(gxDoc);
    applyHtmlEverywhere(html, null);
    refreshZoneToolbar();
    markDiffDirty();
    _onSlotLoaded(1);
}

function _onSlotLoaded(slot) {
    _updateVisualDiffLabels();

    const has1 = Boolean(state.pdf1.extractedHTML || state.pdf1.extractedText || state.pdf1.file);
    const has2 = Boolean(state.pdf2.extractedHTML || state.pdf2.extractedText || state.pdf2.file);

    if (has2) {
        enableDiffTab();
    } else {
        disableDiffTab();
    }

    if (has1 && has2) {
        refreshCodeDiff();
    }
}

function _updateVisualDiffLabels() {
    const f1 = state.pdf1.file?.name ?? '';
    const f2 = state.pdf2.file?.name ?? '';
    const labelEl = document.getElementById('vd-label-left');
    const hintEl  = document.getElementById('vd-hint-left');
    if (labelEl) labelEl.textContent = f1 || 'Original';
    if (hintEl)  hintEl.textContent  = f2 ? `${f1 || 'Left'} vs ${f2}` : (f1 || 'Rendered source');
}

function refreshCodeDiff() {
    import('../ui/diffViewController.js').then(m => m.refreshCompareDiff());
}

export async function downloadExtractedHTML() {
    let html = state.pdf1.extractedHTML;
    if (!html) { showToast('No extracted HTML yet; load a PDF first', 'error'); return; }

    showToast('Preparing standalone HTML with embedded images...', 'info');

    // Inject images using Base64 for a standalone HTML file
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const images = doc.querySelectorAll('img[data-img-id]');
    
    for (const img of images) {
        const id = img.getAttribute('data-img-id');
        try {
            const blob = await getImageBlob(id);
            if (blob) {
                const dataUrl = await new Promise((res) => {
                    const reader = new FileReader();
                    reader.onloadend = () => res(reader.result);
                    reader.readAsDataURL(blob);
                });
                img.src = dataUrl;
                img.removeAttribute('data-img-id');
            }
        } catch (err) {
            console.error(`Failed to inline image ${id} for export`, err);
        }
    }

    // Preserve font CSS that was in the extracted HTML's <style> block.
    // DOMParser moves it into <head>; doc.body.innerHTML drops it, so
    // we extract it explicitly before discarding the parsed document.
    const styleTags = doc.head?.querySelectorAll('style') || [];
    const fontCss = Array.from(styleTags)
        .map(s => s.outerHTML)
        .join('\n');

    // Restore body innerHTML as the document string
    html = doc.body.innerHTML;

    const title = state.pdf1.file?.name || 'Extracted PDF';
    const exportedHead = [
        '<meta charset="utf-8"/>',
        `<title>${title}</title>`,
        fontCss,
        '<style>body{font-family:sans-serif;max-width:1000px;margin:0 auto;padding:2rem;}img{max-width:100%;}',
        '.pdf-doc .f0,.pdf-doc .f1,.pdf-doc .f2,.pdf-doc .f3,.pdf-doc .f4,.pdf-doc .f5,.pdf-doc .f6,.pdf-doc .f7,.pdf-doc .f8,.pdf-doc .f9 { margin: 0; }',
        '.pdf-doc .pdf-paragraph { margin: 0.5em 0; }',
        '.pdf-doc { max-width: 1000px; margin: 0 auto; }',
        '.pdf-page-content { padding: 40px 48px; }',
        '</style>',
    ].filter(Boolean).join('\n');
    const blob = new Blob(
        [`<!doctype html><html><head>\n${exportedHead}\n</head><body>\n${html}\n</body></html>`],
        { type: 'text/html' },
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (title.replace(/\.pdf$/i, '') || 'extracted') + '.html';
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Download complete', 'success');
}
