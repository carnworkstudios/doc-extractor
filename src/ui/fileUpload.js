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
import { registerPDFLayers, resetPDFLayers } from './pdfEditMode.js';
import { initTableFeatures } from '../utils/tableLogic.js';
import { applyHtmlEverywhere, hydrateImages, resetImageHydration } from './htmlSync.js';
import { setDocumentStyles, getDocumentStyles, splitLeadingStyles } from './docStyles.js';
import { showToast } from './toast.js';
import { cwsBroker } from '@os/worker-broker.js';
import { checkDoclingAgreement } from '../extraction/doclingCheck.js';
import { doclingToRegionHtml } from '../extraction/doclingAdapter.js';
import { buildStructuredPayload } from './structuredExtract.js';
import { initMcpVerbs } from './mcpVerbs.js';
import { classifyPage } from '../extraction/vector/contextClassifier.js';
import { assemblePage, createFontRegistry } from '../extraction/vector/pageAssembler.js';
import { katexExportCss } from '../extraction/vector/katexExport.css.js';
import { synthesizeFromWords, makeSyntheticViewport } from '../extraction/vector/rasterSynth.js';
import { ensureTesseract, recognizePage } from './tesseractOcr.js';
import { htmlToGxDoc, htmlToGxDocAddressable } from '../ir/htmlToGxDoc.js';
import { gxDocToHtml } from '../ir/gxDocToHtml.js';
import { docxToGxDoc } from '../ir/docxToGxDoc.js';
import { jsonToGxDoc } from '../ir/jsonToGxDoc.js';
import { ensureBlockIds } from '../ir/gxDoc.js';
import { gxDocToRegions } from '../ir/gxDocToRegions.js';
import * as annotationEngine from '../annotation/engine.js';
import { mountLayers as mountAnnotationLayers, unmountLayers as unmountAnnotationLayers } from '../annotation/layer.js';
// The analyze panel is an optional add-on loaded at runtime by the host.
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

// Headers for a call to the hosted AI backend. The backend resolves this token
// to a user, checks entitlement, and meters before spending any inference; the
// corpus-write endpoints use it to attribute the record. Without it the call is
// anonymous and the hosted backend rejects it.
//
// Guarded on both sides, so a fork running this tool standalone still works:
// the shell may not be there (no framing parent), and the token may not be
// there (signed out). Either way this returns plain JSON headers and the call
// goes out exactly as it does today.
export function integrationAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    try {
        const shell = window.parent !== window ? window.parent.OsShell : null;
        const token = shell?.getAccessToken ? shell.getAccessToken() : null;
        if (token) headers['Authorization'] = 'Bearer ' + token;
    } catch (_) { /* cross-origin parent — send unauthenticated */ }
    return headers;
}

// Cross-check the Docling result against the deterministic analyzer and
// surface + record disagreements. Best-effort: never blocks or fails the
// extraction it verifies.
async function _crossCheckDocling(assets) {
    try {
        const analysis = await _analysisPromise;
        if (!analysis?.pages?.length) return null;
        const report = checkDoclingAgreement(analysis.pages, assets);
        if (report.flags.length) {
            console.warn('[Verifier] Docling vs geometry disagreements:', report.flags);
            showToast(
                `Verifier: ${report.flags.length} disagreement(s) between semantic and geometric views ` +
                `(agreement ${Math.round(report.agreementScore * 100)}%). Check the Analyze tab.`,
                'info',
            );
        } else if (report.claims > 0) {
            // A clean run is a result too. Without this the pass is indis-
            // tinguishable from one that never happened, which is exactly how
            // the vector run read: a `check/report` POST in the server log and
            // nothing at all in the tool.
            showToast(
                `Verifier: semantic and geometric views agree on all ${report.claims} claim(s).`,
                'success',
            );
        } else {
            // Zero claims is not agreement — it is an empty comparison. Never
            // report it as a pass.
            console.info('[Verifier] Docling ran but no page offered a comparable claim — nothing verified.');
        }
        fetch(`${integrationBackendUrl()}/api/v1/ai/pdf/check/report`, {
            method: 'POST',
            headers: integrationAuthHeaders(),
            body: JSON.stringify({ report }),
        }).catch(() => { /* corpus reporting is best-effort */ });
        return report;
    } catch (e) {
        console.warn('[Verifier] Docling cross-check failed:', e.message);
        return null;
    }
}

// ── Docling semantic pass (Smart OCR, parallel) ─────────────────────────────
// pdf-extraction-v2.md §Pass 1: Docling is a semantic CLASSIFIER whose output is
// compared against the geometry engine's structural output — "it runs *in
// addition to* the geometry engine, not instead of it." It is not the extractor.
//
// So this fires alongside the deterministic pipeline and never owns `data`. The
// geometry engine (vector) or local Tesseract (scanned) still produces the
// document the user sees; Docling's return is used only to cross-check and to
// carry the semantic view. That ordering is deliberate — Docling runs neural
// layout + table models per page and is minutes slower than reading the operator
// stream, and blocking a result we already have on a view we merely want to
// compare against would trade the whole latency budget for a verification.
//
// Deliberately NOT sent: `force_ocr`. On a scanned page there is no text layer,
// so Docling's own heuristic OCRs it anyway, and the default converter is the
// one warmed at startup (backend/main.py startup_warmup only warms force_ocr=
// False). Asking for forced OCR here would load a second set of models on the
// first request for no additional pages read.
//
// Returns a promise, or null when the pass does not apply. Never rejects.
async function _startDoclingSemanticPass(file, { isScannedDoc } = {}) {
    // The comparator has no basis on a scanned document. `checkDoclingAgreement`
    // skips every page where `scanned` is true — geometry read no vector
    // substrate, so it has no standing to dispute Docling — which on a fully
    // scanned doc means zero claims adjudicated and a vacuous agreement of 1.0.
    // Running the pass anyway costs minutes of neural OCR to produce a report
    // that examined none of it. Refuse it and say why.
    //
    // The useful comparison on these documents is Docling's OCR against the
    // LOCAL Tesseract/YOLO result, not against the vector analyzer. That is a
    // different comparator and does not exist yet.
    if (isScannedDoc) {
        console.info(
            '[Semantic] Scanned document — skipping the Docling pass: the invariant '
            + 'checker discards scanned pages, so the run would compare nothing.',
        );
        return null;
    }
    return _doclingSemanticPass(file);
}

async function _doclingSemanticPass(file) {
    // Pro + toggle: same gate as the AI tune pass. The toggle is disabled in
    // markup for free users, so `.checked` cannot be true without DOM edits;
    // the tier check is the defense in depth behind it.
    const toggle = document.getElementById('ai-layout-toggle');
    if (!toggle || toggle.disabled || !toggle.checked) return null;
    if (!_isProUser()) return null;

    try {
        if (!brokerReady) {
            await cwsBroker.init();
            brokerReady = true;
        }
        if (!cwsBroker.getBackendStatus()) {
            console.info('[Semantic] Smart OCR is on but the backend is offline — skipping the Docling pass.');
            return null;
        }
    } catch (e) {
        console.warn('[Semantic] Broker init failed, skipping the Docling pass:', e.message);
        return null;
    }

    // A second FormData over the same File. `file` is a Blob and is readable
    // more than once; reusing the primary FormData would hand the same body to
    // two in-flight requests.
    const fd = new FormData();
    fd.append('file', file);

    // No progress callback on purpose: the deterministic pipeline owns the
    // status bar, and a slower parallel request must not narrate over it.
    return cwsBroker.extractPdf(fd).catch(e => {
        console.warn('[Semantic] Docling pass failed:', e.message);
        return null;
    });
}

// ── AI auto-tune (Smart OCR, vector docs) ───────────────────────────
// Document-level drive-and-verify: after Pass 1, the AI reviews pages the
// verifier scored poorly, proposes parameter/classification ops (validated
// server-side against the closed vocabulary), the deterministic engine
// re-runs those pages, and the verifier decides which result survives.
// A page is never left worse than Pass 1 left it.

// The free-page cap, the tune-candidate selection gate, and the default
// reprocess scale overrides are POLICY, not mechanism — they live in the
// portfolio root (assets/pdf-processor/ui/tunePolicy.js) and are injected
// into this frame at runtime as window.__GX_PDF_POLICY__ (see
// shell/inject.js). This file only drives the tune (fetch calls, worker
// reprocess, verifier score compare); it does not decide which pages
// qualify or how far reprocessing is allowed to go. A standalone fork
// without the injected policy simply gets no AI-tune candidates.
const _policy = () => window.__GX_PDF_POLICY__;

// Best-effort product-analytics capture. window.posthog is initialised by the
// host page; guard it so a standalone build without the snippet doesn't throw.
function _phCapture(event, props) {
    // GxTrack, when present, picks the working transport: window.posthog on the
    // web, or the extension-host bridge inside a VS Code webview where the CSP
    // blocks PostHog entirely. Falls back to posthog directly.
    try {
        if (window.GxTrack) window.GxTrack(event, { tool: 'pdf-processor', ...props });
        else window.posthog?.capture?.(event, { tool: 'pdf-processor', ...props });
    } catch (_) { /* analytics is never load-bearing */ }
}

// ── Large-document gate for the AI drive-and-verify pass ─────────────────────
// The AI pass (Smart OCR) is a Pro feature — the toggle is disabled in
// markup for free users. This gate is the SIZE dimension layered on top: Pro
// users have no page limit; any non-Pro context (e.g. a DOM-forced toggle, or a
// future BYO-key surface) reaching the AI pass with a document beyond the
// policy's page cap is the `document_too_large_for_ai` conversion moment — we
// skip only the costly AI refinement (deterministic extraction has already
// produced the full document), record it, and surface a Pro upsell. Without
// the injected policy (standalone fork) the gate is closed outright.
function _aiSizeGateOk(pageCount) {
    const policy = _policy();
    if (!policy) return false;
    if (policy.aiSizeGateOk(pageCount, _isProUser())) return true;
    _phCapture('document_too_large_for_ai', {
        page_count: pageCount, limit: policy.aiMaxFreePages, tier: 'free',
    });
    showToast(
        `${pageCount}-page document: AI refinement is capped at ${policy.aiMaxFreePages} pages on the free tier. `
        + `Upgrade to Pro for unlimited AI on large documents — the deterministic extraction below is complete.`,
        'info',
    );
    return false;
}

async function _autoTunePages(pageResults) {
    const scored = pageResults.filter(p => p.verification);
    if (!scored.length) return;
    const policy = _policy();
    // No injected policy (standalone fork) — no candidate-selection rule to
    // apply, so there is nothing to tune.
    const candidates = policy ? policy.selectTuneCandidates(scored) : [];
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
    const policy = _policy();
    if (!policy) return false;
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
        params: policy.scaleOverrides(),
        skippedTypes: [],
        verification: pageResult.verification,
    };

    const res = await fetch(`${integrationBackendUrl()}/api/v1/ai/pdf/tune`, {
        method: 'POST',
        headers: integrationAuthHeaders(),
        body: JSON.stringify({
            signals,
            context: { region_ids: signals.regions.map(r => r.id), params: signals.params },
        }),
    });
    const tune = await res.json();
    if (tune.status !== 'success' || !tune.ops?.length) return false;

    // Translate validated ops into a stateless reprocess pipeline.
    const scaleOverrides = policy.scaleOverrides();
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
        headers: integrationAuthHeaders(),
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
            skip: [], scaleOverrides: policy.scaleOverrides(), customRegions: [], manualSplits: [],
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

// One request/response round trip to the geometry worker, matched by requestId.
//
// The worker has a permanent listener feeding the analyze panel, so this
// attaches its own and removes it on settle rather than touching `onmessage` —
// assigning that would silently unhook the extraction stream.
let _workerReqSeq = 0;
function _requestWorker(message, timeoutMs = 120_000) {
    const worker = ensureGeometryWorker();
    const requestId = `wreq-${++_workerReqSeq}`;
    const expect = `${message.type}-result`;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            worker.removeEventListener('message', handler);
            reject(new Error(`${message.type} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        const handler = (e) => {
            if (e.data?.type !== expect || e.data.requestId !== requestId) return;
            clearTimeout(timer);
            worker.removeEventListener('message', handler);
            const { type: _t, requestId: _r, ...payload } = e.data;
            resolve(payload);
        };
        worker.addEventListener('message', handler);
        worker.postMessage({ ...message, requestId });
    });
}

// Local vector pipeline cannot read scanned pages — point the user at the
// Smart OCR (Docling/OCR) path instead of silently returning nothing.
async function _maybeSuggestOcr() {
    try {
        const analysis = await _analysisPromise;
        const scanned = analysis?.pages?.filter(p => p.scanned).length || 0;
        if (!scanned) return;
        showToast(
            `${scanned} page(s) look scanned — the local vector pipeline can't read them. ` +
            `Turn on Smart OCR to read this document.`,
            'info',
        );
    } catch (_) { /* analysis failed — nothing to suggest */ }
}

const pushRegionPage    = (n, r, s, v)    => _core()?._dispatchRegionPage(n, r, s, v);
const resetAnalysisData = ()              => _core()?._dispatchReset();

/**
 * Publish an imported document's artifacts.
 *
 * Regions are what the whole platform is built on: the analyze canvas reads
 * them, the artifact/tag panel turns each one into a tag, and every cross-tool
 * handoff resolves a tag back to content. A PDF gets them from the classifier.
 * An imported DOCX/HTML/Markdown/JSON never touched the classifier, so it
 * produced none, and the document arrived with no tags — which meant no
 * artifacts, which meant nothing could be sent to another tool. It rendered,
 * and it was inert.
 *
 * The IR already knows the structure, so this maps it across rather than
 * re-detecting it. Call AFTER the document's HTML is in state, because the
 * panel resolves a region id against the rendered markup.
 */
function publishImportedRegions(gxDoc, algorithm) {
    if (!gxDoc) return;
    // Every call site fires this synchronously, unawaited, immediately before
    // switchView('html') — tagging/cross-tool-send is a side effect of
    // showing the document, not a precondition for it. An exception here
    // (an unusual block shape from a hand-authored HTML/MD file, say) used to
    // propagate out and abort the caller before it reached switchView, which
    // left the pane hidden and the document invisible until the user
    // manually clicked a tab and re-triggered it. Never let this step take
    // the document view down with it.
    try {
        // Ids first: gxDocToRegions and the rendered markup both address blocks by
        // block.id, and they have to be looking at the same strings.
        ensureBlockIds(gxDoc);
        // A previous document's regions are not this document's.
        resetAnalysisData();
        for (const { page, regions } of gxDocToRegions(gxDoc, { algorithm })) {
            pushRegionPage(page, regions, null, null);
        }
        _core()?._dispatchAnalysisReady({
            metadata: { title: gxDoc.meta?.title || null },
            source: algorithm,
            pageCount: gxDoc.pages?.length ?? null,
        });
    } catch (err) {
        console.error('[fileUpload] publishImportedRegions failed — document will still render, but tags/cross-tool send may be unavailable:', err);
    }
}
/**
 * Publish the regions the Docling adapter resolved.
 *
 * The backend path used to publish HTML and nothing else. That is enough to
 * SHOW a document and not enough to do anything with one: the analyze canvas
 * draws regions, the artifact panel builds its tags from regions, and a
 * cross-tool send resolves a tag's (page, regionId) back through
 * `getRegionHtml`. With no regions published, a Docling extraction rendered
 * perfectly, drew no overlays, and offered zero artifacts to send — the tables
 * were on screen and unreachable.
 *
 * Deliberately NOT preceded by a reset: the pre-flight analysis for this
 * document has already been dispatched by the time the backend answers, and
 * `_dispatchReset` clears that cache too, which would blank the analyze canvas
 * the regions are meant to be drawn on. Re-pushing a page id replaces it.
 *
 * @param {Array<{pageNum:number, regions:Array}>} pages — adapter `pages`.
 */
function publishDoclingRegions(pages) {
    for (const p of pages || []) {
        if (!p?.regions?.length) continue;
        // No pageScale: that is the geometry engine's tolerance record, used to
        // draw the re-extract ghost. Docling has no such thing, and passing a
        // fabricated one would put a ghost box on the canvas describing
        // tolerances nothing ran.
        pushRegionPage(p.pageNum, p.regions, null, null);
    }
}

const setAnalyzeWorker  = (w)             => { window.__GX_PDF_GEO_WORKER__ = w; _core()?._dispatchWorkerReady(w); };
const onReprocessResult = (n, h, r, s, v) => _core()?._dispatchReprocessResult(n, h, r, s, v);
const onReprocessError  = (n, e)       => _core()?._dispatchReprocessError(n, e);
import { saveImages, getImageBlob, cropKey, deleteDoc } from '../utils/imageStore.js';
import { refreshZoneToolbar } from './zoneToolbar.js';
import { refreshDocVirtualizer, mountAllPages } from './docVirtualizer.js';

let brokerReady = false;

// Lazily created geometry worker for local (offline) table extraction
let _geoWorker = null;

// Tier check — gates Smart OCR (the hosted AI-assisted path).
// Embedded: ask the host shell for the resolved tier via OsShell.isProTier(),
// which owns the dev-host bypass and the pro/team check (assets/os/shell/auth.js).
// Standalone (no parent shell, e.g. a fork run on its own): always free — this
// file has no tier policy of its own to fall back on.
export function isProUser() { return _isProUser(); }

function _isProUser() {
    try {
        if (window.parent !== window && window.parent.OsShell && typeof window.parent.OsShell.isProTier === 'function') {
            return !!window.parent.OsShell.isProTier();
        }
    } catch (_) {
        // Cross-origin access can throw — treat as free.
    }
    return false;
}

// Unlock the Smart OCR toggle for Pro/dev users: enable the input, drop the
// locked styling, and remove the waitlist interceptor so switching it on
// routes extraction through the backend AI path (Docling / OCR / all PDF types).
//
// The control is a real <input type="checkbox"> styled as a switch, so
// enabling the input is all that is needed — the track/knob read :checked and
// :disabled off it in CSS, no inline styles to undo.
function _ungateAdvanceExtraction() {
    const toggle = document.getElementById('ai-layout-toggle');
    if (!toggle) return;
    toggle.disabled = false;
    const label = toggle.closest('label');
    if (label) {
        label.classList.remove('gx-pro-locked');
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
 * Crop every IMAGE region out of an already-rendered page canvas.
 *
 * The scanned path renders each page once for layout detection and OCR. That
 * same canvas IS the picture source — there is no operator list to crop from on
 * a scanned page, and re-rendering to get one would pay for the page twice.
 *
 * Region boxes are in the SYNTHETIC viewport's space, which is derived from the
 * page's point size rather than from this canvas, so the two are related by a
 * ratio and not by an assumed scale. Computing it from the actual dimensions is
 * what keeps the crop on the picture when the two scales drift apart.
 *
 * @returns {Promise<Object>} `{ [regionId]: { key, pw, ph, scale } }` in the
 *   shape `assemblePage` expects — the pixels go to the blob store, the entry
 *   carries its key. Regions that cannot be cropped are simply absent, and the
 *   assembler falls back to a sized placeholder for them.
 */
/**
 * Move a {key: base64|Blob} dict into the blob store.
 *
 * Every producer ends here: the document string never carries pixels, so
 * whatever made them has to put them somewhere the page can reference. A write
 * failure is logged, not thrown — the extraction is still worth showing.
 */
async function _persistExtractedImages(images) {
    if (!images) return;
    const blobs = {};
    for (const [key, val] of Object.entries(images)) {
        try {
            if (val instanceof Blob) blobs[key] = val;
            else if (typeof val === 'string' && val.startsWith('data:image')) {
                blobs[key] = await (await fetch(val)).blob();
            }
        } catch (err) {
            console.warn(`[imageStore] could not decode image ${key}:`, err?.message || err);
        }
    }
    if (!Object.keys(blobs).length) return;
    try {
        await saveImages(blobs);
    } catch (err) {
        console.warn('[imageStore] write failed:', err?.message || err);
    }
}

async function _cropRegionsFromCanvas(pageCanvas, regions, viewport, renderScale, pageNum, docId) {
    const out = {};
    const blobs = {};
    const pics = (regions || []).filter(r => r.type === 'IMAGE' && r.bbox && r.id);
    const cw = pageCanvas?.width || 0;
    const ch = pageCanvas?.height || 0;
    if (!pics.length || !cw || !ch || typeof OffscreenCanvas === 'undefined') return out;

    const rx = cw / (viewport.width || cw);
    const ry = ch / (viewport.height || ch);

    for (const pic of pics) {
        if (out[pic.id]) continue;
        const sx = Math.max(0, Math.round(pic.bbox.x * rx));
        const sy = Math.max(0, Math.round(pic.bbox.y * ry));
        const sw = Math.min(Math.round(pic.bbox.w * rx), cw - sx);
        const sh = Math.min(Math.round(pic.bbox.h * ry), ch - sy);
        if (sw < 4 || sh < 4) continue;
        try {
            const crop = new OffscreenCanvas(sw, sh);
            crop.getContext('2d').drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
            const blob = await crop.convertToBlob({ type: 'image/png' });
            // The pixels go to the blob store; the page gets the key. Same rule
            // as the vector worker — a scanned document is the one most likely
            // to be all pictures, so it is the last place to inline base64.
            const key = cropKey(docId, pageNum, pic.id);
            blobs[key] = blob;
            out[pic.id] = { key, pw: sw, ph: sh, scale: renderScale };
        } catch (err) {
            console.warn(`[extractViaScannedGeometry] crop failed for ${pic.id}:`, err?.message || err);
        }
    }
    if (Object.keys(blobs).length) {
        try {
            await saveImages(blobs);
        } catch (err) {
            // A page that assembles without its pictures still beats a page
            // that does not assemble.
            console.warn('[extractViaScannedGeometry] crop store write failed:', err?.message || err);
        }
    }
    return out;
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
async function extractViaScannedGeometry(bytes, onProgress, docId = null) {
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
    // pdfAnalyzer renders at 1.5 and analyzePanel converts to worker space with
    // a hardcoded `pg.widthPx * (2.0/1.5)` (the SCALE TRAP note in app.js). The
    // synthetic analysis page below therefore has to be stated in 1.5 space too:
    // handing the panel 2.0-space dimensions makes it compute a worker viewport
    // 33% too wide and draw every region overlay in the wrong place. Every other
    // layer is scale-invariant (they share `maxW / pg.widthPx`), which is why
    // this was invisible until regions started being published.
    const ANALYSIS_SCALE = 1.5;
    const A = ANALYSIS_SCALE / VIEWPORT_SCALE;   // 2.0-space → 1.5-space
    const _aSeg = s => ({ ...s, x1: s.x1 * A, y1: s.y1 * A, x2: s.x2 * A, y2: s.y2 * A });
    const _aRect = r => ({ ...r, x: r.x * A, y: r.y * A, w: r.w * A, h: r.h * A });
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

        // Picture crops, off the canvas that is already rendered and still in
        // hand. Passing {} here (what this did before) sent every figure on
        // every scanned page through the assembler's PLACEHOLDER branch — an
        // empty dashed box with no src — so a locally-OCR'd document showed the
        // regions, tagged them, and displayed none of them. The pictures were
        // never missing; nobody had cropped them.
        const extractedImages = await _cropRegionsFromCanvas(
            pageCanvas, classified, viewport, RENDER_SCALE, i, docId,
        );

        // The 2.0-scale page canvas has served every consumer (layout detect via
        // the transferred bitmap, Tesseract, and the picture crops above). Zero
        // it before the next iteration allocates another: at ~7.8 MB a page,
        // holding these across a long scan is the difference between hundreds of
        // MB and gigabytes.
        pageCanvas.width = 0;
        pageCanvas.height = 0;

        const result = assemblePage(
            classified, textMeta, synth.textItems, viewport, pageWidthPt, i,
            fontRegistry, rawSplits ?? columnSplits, extractedImages, null,
        );

        totalTables += result.tableCount || 0;
        htmlParts.push(result.html);
        textParts.push((result.text || '').trim());
        // The regions this page resolved to, in the same shape geometryWorker
        // posts on its 'page' message. This path had the same hole as the
        // Docling one: it published HTML and no regions, so a locally-OCR'd
        // document drew no overlays on the analyze canvas and offered no
        // artifacts to send. `assemblePage` stamps `data-region-id` from these
        // same objects, so the ids published here are the ids in the markup.
        const pageRegions = classified.map((r, ri) => ({
            id: r.id || `p${i}-r${ri}`,
            type: r.type,
            bbox: r.bbox,
            algorithm: r.algorithm ?? 'ocr-geometry',
            confidence: r.confidence ?? 1.0,
            columnIndex: r.columnIndex ?? -1,
            imageId: r.imageId ?? null,
        }));
        pageResults.push({
            page: i, ocr: true, scanned: true,
            tables: result.tableCount || 0,
            regions: pageRegions,
        });
        pushRegionPage(i, pageRegions, null, null);

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
        // Stated in ANALYSIS space (1.5), which is the space pdfAnalyzer emits
        // and the only one the panel's region conversion is correct for.
        // `textItems` are exempt: their `transform` is PDF points and is mapped
        // by the viewport, so re-scaling them would double-apply the conversion.
        const aViewport = makeSyntheticViewport(pageWidthPt, pageHeightPt, ANALYSIS_SCALE);
        analysisPages.push({
            scanned: true,
            ocrLayer: true,
            pageNum: i,
            widthPx: aViewport.width,
            heightPx: aViewport.height,
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
            hSegs: synth.hSegs.map(_aSeg),
            vSegs: synth.vSegs.map(_aSeg),
            diagSegs: [],
            closedRects: [],
            imageRegions: synth.imageRegions.map(_aRect),
            textItems: synth.textItems,
            viewport: aViewport,
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
function extractViaGeometryWorker(bytes, onProgress, docId = null) {
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
                // A partial extraction is a real result, not a failure — but it
                // must not look like a clean one.
                if (msg.failedPages?.length) {
                    const n = msg.failedPages.length;
                    console.warn('[HandleFile] pages skipped:', msg.failedPages.slice(0, 10));
                    showToast(
                        `${n} of ${msg.pageCount} page(s) could not be extracted and were skipped. `
                        + `The rest of the document is here.`,
                        'info',
                    );
                }
                // The document's CSS travels BESIDE the markup, not inside it.
                // Prepending it as a <style> block put it where the HTML parser
                // parks leading styles — <head> — so every reader that takes
                // body.innerHTML dropped it, fonts and all.
                const html = htmlParts.length > 0
                    ? htmlParts.join('\n')
                    : '<p class="no-tables-msg">No table structures detected. This PDF may use text-only layout.</p>';
                const text = textParts.join('\n\n--- page break ---\n\n');
                resolve({ html, text, styles: msg.styles || '',
                          tableCount: msg.tableCount ?? totalTables, pages: pageResults });
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
            docId,
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

    // The pane header is the document's handle: click the name to swap the
    // file, ✕ to close it. Delegated, because the headers are re-shown by
    // workspaceLayout as panes come and go.
    $(document).on('click', '.gx-file-x', function (e) {
        e.preventDefault();
        e.stopPropagation();
        unloadSlot(Number($(this).data('unload-slot')) === 2 ? 2 : 1);
    });

    $(document).on('click', '.gx-file-chip', function (e) {
        if ($(e.target).closest('.gx-file-x').length) return;
        const slot = Number($(this).data('slot')) === 2 ? 2 : 1;
        $(`#file${slot}-input`).trigger('click');
    });

    syncSlotNames();

    // VS Code extension: signal ready then receive file bytes from extension host
    if (window.CwsBridge?.isEmbedded) {
        // Convert / merge / verify verbs. Registered before `pdf-ready` so a host
        // that fires a request the instant it sees ready cannot beat the listener.
        initMcpVerbs({
            requestWorker: _requestWorker,
            whenLoaded: () => _slot1Load,
        });
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
            ADD_ATTR: ['style'],
            FORCE_BODY: false,
          })
        : html;

    const pdfState = slot === 2 ? state.pdf2 : state.pdf1;
    const label = slot === 2 ? 'file2' : 'file1';

    // Addressable, not plain: the walk stamps data-region-id onto the elements
    // that produced blocks and wraps generic markup in the page scope the rest
    // of the pipeline addresses through. The document still renders from its
    // OWN markup, so its styles and structure survive; it is simply reachable
    // now. Without this an imported file's artifacts all resolved to null.
    const source = /\.md$/i.test(file.name) ? 'markdown' : 'html';
    const { gxDoc, html: addressable } = htmlToGxDocAddressable(clean, {
        source,
        title: file.name,
    });

    pdfState.extractedHTML = addressable;
    pdfState.extractedText = clean.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    pdfState.file = file;
    pdfState.gxDoc = gxDoc;
    // An imported HTML/Markdown document was never run through the PDF
    // pipeline — no page model, no scanned classification, nothing measured.
    pdfState.extraction = {
        source: 'document-import',
        pageCount: null,
        tableCount: null,
        scannedPageCount: null,
        isScanned: null,
    };
    $(`#${label}-input`).closest('.file-btn').addClass('loaded');

    if (slot === 2) {
        _onSlotLoaded(2);
        showToast(`${file.name} loaded for compare`, 'success');
        return;
    }

    applyHtmlEverywhere(addressable, null);
    publishImportedRegions(gxDoc, `${source}-import`);
    switchView('html');
    _onSlotLoaded(1);
    showToast(`${file.name} loaded`, 'success');
}

async function handleDocxFile(file, slot = 1) {
    const buf = await file.arrayBuffer();
    const gxDoc = await docxToGxDoc(buf, { source: 'docx', title: file.name });
    // Ids before render: gxDocToHtml writes block.id out as data-region-id, so
    // the markup and the regions address each other by the same string.
    ensureBlockIds(gxDoc);
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
    $(`#${label}-input`).closest('.file-btn').addClass('loaded');

    if (slot === 2) {
        _onSlotLoaded(2);
        showToast(`${file.name} loaded for compare`, 'success');
        return;
    }

    applyHtmlEverywhere(html, null);
    publishImportedRegions(gxDoc, 'docx-import');
    switchView('html');
    _onSlotLoaded(1);
    showToast(`${file.name} loaded`, 'success');
}

async function handleJsonFile(file, slot = 1) {
    try {
        const text = await file.text();
        const gxDoc = jsonToGxDoc(text, { source: 'json', title: file.name });
        ensureBlockIds(gxDoc);
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
            $(`#${label}-input`).closest('.file-btn').addClass('loaded');

        if (slot === 2) {
            _onSlotLoaded(2);
            showToast(`${file.name} loaded for compare`, 'success');
            return;
        }

        applyHtmlEverywhere(html, null);
        publishImportedRegions(gxDoc, 'json-import');
        switchView('html');
        _onSlotLoaded(1);
        showToast(`${file.name} loaded`, 'success');
    } catch (err) {
        showToast(`Could not import ${file.name}: ${err.message}`, 'error');
    }
}

/**
 * GitHub-flavoured pipe tables → HTML, lifted out before any other rule runs.
 *
 * A markdown table used to fall through every rule here and land as a run of
 * paragraphs, one per row. The document looked roughly right and the TABLE
 * artifact was gone: nothing to tag, nothing to send to the table tool, which
 * is the single most useful thing an imported document has. The delimiter row
 * is also indistinguishable from a thematic break once split, so tables have
 * to be claimed before `---` means anything else.
 *
 * Each table is swapped for a placeholder so the inline rules below cannot
 * reach inside it and mangle the markup.
 */
function _extractMdTables(md, out) {
    const ROW = /^\s*\|(.+)\|\s*$/;
    const DELIM = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
    const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
        .split('|').map(c => c.trim());

    const lines = md.split('\n');
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
        const isTable = ROW.test(lines[i]) && i + 1 < lines.length && DELIM.test(lines[i + 1]);
        if (!isTable) { kept.push(lines[i]); continue; }

        const headers = cells(lines[i]);
        const rows = [];
        let j = i + 2;
        for (; j < lines.length && ROW.test(lines[j]); j++) rows.push(cells(lines[j]));

        const head = `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`;
        const body = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
        out.push(`<div class="pdf-table-wrap pdf-table--lattice">` +
                 `<table class="tablecoil"><tbody>${head}${body}</tbody></table></div>`);
        kept.push(`@@GXTABLE${out.length - 1}@@`);
        i = j - 1;
    }
    return kept.join('\n');
}

export function markdownToHtml(md) {
    const tables = [];
    const html = _extractMdTables(md, tables)
        // A thematic break is a real block: it becomes a DIVIDER artifact.
        // Claimed after tables so a delimiter row cannot be mistaken for one.
        .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '<hr>')
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
            if (/^<(h[1-6]|ul|li|p|hr|div|table)/.test(line)) return line;
            if (/^@@GXTABLE\d+@@$/.test(line)) return line;
            return `<p class="pdf-region type-paragraph">${line}</p>`;
        });

    return html.replace(/@@GXTABLE(\d+)@@/g, (_, i) => tables[Number(i)] || '');
}

async function handleFile(file, pdfIndex) {
    const pdfState = pdfIndex === 1 ? state.pdf1 : state.pdf2;
    const label = pdfIndex === 1 ? 'file1' : 'file2';

    // A slot's pictures are namespaced by document, so replacing the document
    // in a slot retires exactly that document's crops — not the other slot's,
    // and not a batch's. `clearImages()` here would blank every other document
    // the session is holding, which is why nothing calls it on load any more.
    const previousDocId = pdfState.docId;
    pdfState.docId = `s${pdfIndex}-${Date.now().toString(36)}`;
    pdfState.file = file;
    $(`#${label}-input`).closest('.file-btn').addClass('loaded');
    if (previousDocId) {
        resetImageHydration(previousDocId);
        deleteDoc(previousDocId).catch(err =>
            console.warn('[imageStore] could not retire previous document:', err?.message || err));
    }

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
            // Crops are keyed by page + region id, which are per-DOCUMENT. A new
            // document reuses those keys, so last document's pixels have to go
            // before this one's are written — otherwise page 3 of the new file
            // could hydrate page 3 of the old one. Cleared here, at the one
            // point where a document is replaced, and never during extraction.

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
                docId: pdfState.docId,
                bytes: bytesForAnalysis.slice()
            });

            _analysisPromise = runAnalysis(bytesForAnalysis, file.name).catch(err => {
                console.warn('[Analyze] Analysis failed:', err.message);
                return null;
            });
        }

        const formData = new FormData();
        formData.append('file', file);

        // Smart OCR (AI layout via Docling + OpenRouter) is a Pro feature gated
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
        // pages) have nothing for the geometry engine to read. Two engines can
        // read them, and on a scanned page they are not close:
        //
        //   local  — Tesseract WASM for words + YOLOv8 for region labels,
        //            through rasterSynth into classifyPage/assemblePage.
        //   Docling — RapidOCR (PP-OCRv4) for words + TableFormer for table
        //            structure. Verified as the engine actually loaded by this
        //            backend's `agent-env`.
        //
        // TableFormer is the decisive difference: recovering a table grid from
        // pixels is exactly what the YOLO+heuristic bridge is weakest at. So
        // Docling is PRIMARY on scanned documents whenever the backend is up,
        // and local OCR is the fallback that keeps the tool working offline —
        // the reverse of the earlier arrangement.
        //
        // This is a disposition, not a contest: local has no axis on which it
        // beats Docling here except speed, so there is nothing to arbitrate.
        // Vector documents are unaffected — geometry still owns those, where it
        // genuinely does win on structural precision.
        let useBackend = false;
        // Set when the backend result must be rebuilt through doclingAdapter
        // rather than used as-is. Docling's own HTML has no region anchors.
        let backendIsScannedPrimary = false;
        // Docling's semantic view, running in parallel with whichever engine
        // below owns the output. Null when Smart OCR is off, the user is not
        // Pro, or the backend is unreachable.
        let semanticPromise = null;
        if (pdfIndex === 1) {
            showStatus('Pre-flight: classifying document…');
            const analysis = await _analysisPromise;
            const pages = analysis?.pages || [];
            scannedCount = pages.filter(p => p.scanned).length;
            isScannedDoc = pages.length > 0 && scannedCount > pages.length / 2;

            if (isScannedDoc) {
                showStatus('Scanned document — checking for backend OCR…');
                if (!brokerReady) {
                    try {
                        await cwsBroker.init();
                        brokerReady = true;
                    } catch (_) { /* offline — local OCR below */ }
                }
                if (cwsBroker.getBackendStatus()) {
                    useBackend = true;
                    backendIsScannedPrimary = true;
                } else {
                    // Offline fallback: local raster→geometry bridge. Tesseract
                    // (OCR) is the load-bearing piece and is required; the YOLO
                    // layout model only LABELS regions (table/heading), so its
                    // failure alone must not sink the run.
                    showStatus('Scanned document — preparing local OCR…');
                    try {
                        await ensureTesseract();
                        useLocalScannedGeometry = true;
                        ensureLayoutWorker().catch(layoutErr =>
                            console.warn('[HandleFile] Layout model failed to load, OCR will run without region labels:', layoutErr.message));
                    } catch (mlErr) {
                        localOcrFailReason = mlErr.message;
                        console.warn('[HandleFile] Local OCR (Tesseract) init failed and backend is offline:', mlErr.message);
                    }
                }
            } else if (useAiLayout) {
                // Vector doc + Smart OCR: geometry runs, AI re-tolerances
                // low-scoring pages afterward (Pass 2). The AI pass is Pro-only
                // (toggle-gated) and additionally size-gated — Pro has no page
                // limit, non-Pro large docs skip the AI pass with a Pro upsell.
                // Deterministic extraction below runs regardless and stays free.
                runAutoTune = _aiSizeGateOk(pages.length);
            }

            // Start the semantic pass now, so it overlaps the deterministic
            // engine instead of running after it. Skipped when `useBackend` is
            // set — there Docling IS the primary extractor (local OCR failed to
            // start) and the existing branch already cross-checks its result, so
            // a parallel pass would be the same request run twice.
            // Not awaited: `_startDoclingSemanticPass` is async and therefore
            // ADOPTS the extract promise it returns, so awaiting here would
            // block on the entire Docling run — the exact thing this pass exists
            // to avoid. The handle resolves to the result (or null) later.
            if (!useBackend) {
                semanticPromise = _startDoclingSemanticPass(file, { isScannedDoc });
            }
        }

        if (useBackend) {
            // ── Scanned doc, backend up: Docling is the primary extractor ─────
            //
            // Docling costs ~7s per scanned page and cannot be made materially
            // faster (measured: MPS + FAST TableFormer buys ~10%, 4-way
            // parallelism 1.63x). So the backend streams page CHUNKS, and each
            // one is rendered the moment it lands. Total wall-clock is
            // unchanged; time-to-first-page drops from the whole document to
            // roughly one chunk.
            //
            // Chunks are only consumed when Docling owns the surface. On the
            // vector path the geometry engine owns it and the parallel semantic
            // pass passes no handler, so its chunks are simply never delivered.
            let streamedHtml = '';
            let streamedTables = 0;
            const streamedPages = [];
            const onChunk = backendIsScannedPrimary ? async (chunk) => {
                if (pdfIndex !== 1 || !chunk?.assets?.order) return;
                const part = doclingToRegionHtml(chunk.assets, pdfState.docId);
                if (!part.regionCount) return;
                // Pixels into the store BEFORE the markup that references them
                // reaches a surface — hydration reads the store once per paint.
                await _persistExtractedImages(part.images);
                streamedHtml += (streamedHtml ? '\n' : '') + part.html;
                streamedTables += part.tableCount;
                streamedPages.push(...part.pages);
                // Paint immediately. `applyHtmlEverywhere` rewrites the state
                // and every surface, so the accumulated document stays the
                // single source of truth rather than being patched in place.
                applyHtmlEverywhere(streamedHtml, null);
                // Regions for the pages in THIS chunk, so the analyze canvas and
                // the artifact panel fill in as the document streams rather than
                // only at the end.
                publishDoclingRegions(part.pages);
                refreshZoneToolbar();
                showStatus(
                    `Pages ${chunk.page_start}–${chunk.page_end}`
                    + (chunk.page_count ? ` of ${chunk.page_count}` : '')
                    + ` ready — ${streamedTables} table${streamedTables !== 1 ? 's' : ''} so far…`,
                );
            } : null;

            try {
                data = await cwsBroker.extractPdf(formData, (msg) => showStatus(
                    typeof msg === 'string' ? msg : (msg.message || 'Processing…'),
                ), onChunk);
                if (streamedPages.length) {
                    _phCapture('extraction_streamed', {
                        pages: streamedPages.length,
                        tables: streamedTables,
                        chunks: streamedPages.length,
                    });
                }
            } catch (beErr) {
                // Docling was the primary engine and it failed. Fall back to
                // local OCR rather than dropping to the vector pipeline, which
                // has no substrate to read on a scanned page and would report
                // an empty document as a success.
                console.warn('[HandleFile] Docling failed, falling back to local OCR:', beErr.message);
                data = null;
                useBackend = false;
                backendIsScannedPrimary = false;
                try {
                    await ensureTesseract();
                    useLocalScannedGeometry = true;
                } catch (mlErr) {
                    localOcrFailReason = mlErr.message;
                }
            }
        }

        if (useBackend) {
            // Docling's own HTML carries no `data-region-id` / `data-page`
            // anchors, so a table taken from it has no return address and can
            // never be annotated back to the page it came from. Rebuild it in
            // the pipeline's region-anchored shape before it reaches any
            // surface. `assets.order` is Docling's reading order — required,
            // because bbox sorting scrambles multi-column pages.
            if (backendIsScannedPrimary && data?.assets?.order) {
                const rebuilt = doclingToRegionHtml(data.assets, pdfState.docId);
                if (rebuilt.regionCount > 0) {
                    await _persistExtractedImages(rebuilt.images);
                    data = {
                        ...data,
                        html: rebuilt.html,
                        text: rebuilt.text || data.text || '',
                        tableCount: rebuilt.tableCount,
                        pages: rebuilt.pages,
                        source: 'docling-ocr',
                    };
                    // The full document's regions. Re-publishing a page already
                    // pushed by a stream chunk replaces it with the same
                    // content, so the two paths do not fight.
                    if (pdfIndex === 1) publishDoclingRegions(rebuilt.pages);
                } else {
                    // The adapter placed nothing. Keeping Docling's raw HTML
                    // costs the return address but is still a readable
                    // document; silently showing an empty page is not.
                    console.warn('[HandleFile] Docling adapter produced no regions — using raw Docling HTML (tables will be unaddressed).');
                    showToast('Extracted, but the page structure could not be anchored — tables sent onward will not support back-annotation.', 'info');
                }
            } else if (backendIsScannedPrimary) {
                console.warn('[HandleFile] Backend returned no `assets.order` — the backend may predate the reading-order change. Tables will be unaddressed.');
            }


            // Legacy `data.images` shape (a flat {id: base64} dict from older
            // backends). The adapter's own pictures are already stored under
            // page-scoped keys above; this must NOT clear the store first, or a
            // response carrying both shapes would delete the crops the page is
            // about to reference.
            if (data.images) await _persistExtractedImages(data.images);

            // Verifier link: cross-check Docling's semantic view against the
            // deterministic pre-flight analyzer. Disagreements are flagged to
            // the user and recorded to the corpus (fuel-quality.md capture point).
            // Skipped when Docling is the scanned primary: the checker discards
            // scanned pages, so it would adjudicate zero claims and post an
            // empty report (see the `claims` field on its result).
            if (pdfIndex === 1 && data.assets && !backendIsScannedPrimary) {
                _crossCheckDocling(data.assets);
            }
        } else if (useLocalScannedGeometry) {
            // ── Local scanned path: layout (YOLOv8, labels) + Tesseract (words) →
            //    rasterSynth → classifyPage/assemblePage. Same downstream as
            //    vector PDFs, so tables/headings/columns are reconstructed.
            showStatus('Running local layout + OCR on scanned pages…');
            const result = await extractViaScannedGeometry(bytesForWorker, (msg) => showStatus(msg), pdfState.docId);
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
            const result = await extractViaGeometryWorker(bytesForWorker, (msg) => showStatus(msg), pdfState.docId);
            data = { html: result.html, text: result.text || '', styles: result.styles || '', source: 'local', tableCount: result.tableCount, pages: result.pages };
            if (pdfIndex === 1) _maybeSuggestOcr();
        }

        // The document's own CSS goes to the app's stylesheet, not into the
        // document string. A string that has to carry its own <style> block
        // cannot survive a parse/serialize round trip — see docStyles.js.
        setDocumentStyles(data.styles || '');

        pdfState.extractedHTML = data.html;
        pdfState.extractedText = data.text || '';
        // The typed IR mirrors the rendered HTML so exporters and the MCP fast
        // path can read blocks without re-parsing the DOM (import-export-gateway.md).
        pdfState.gxDoc = htmlToGxDoc(data.html, {
            source: (data.source === 'local-ocr-geometry' || data.source === 'docling-ocr')
                ? 'pdf-scanned' : 'pdf',
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
            _onSlotLoaded(1);
            // Smart OCR, vector doc: AI reviews the verifier's scores
            // and re-tolerances weak pages. Runs async — pages patch in place
            // through the same path as a manual analyze-tab re-extract.
            if (runAutoTune && data.pages?.length) {
                _autoTunePages(data.pages).catch(e =>
                    console.warn('[AI tune] auto pass failed:', e.message));
            }
            // Docling's semantic view lands whenever it lands — typically after
            // the document is already on screen. It replaces nothing: it records
            // the classification alongside the extraction and runs the invariant
            // check that pdf-extraction-v2.md §Pass 1 specifies.
            if (semanticPromise) {
                semanticPromise.then(async (sem) => {
                    if (!sem || !sem.assets) return;
                    const report = await _crossCheckDocling(sem.assets);
                    pdfState.semantic = {
                        source: 'docling',
                        assets: sem.assets,
                        html: sem.html ?? null,
                        pageCount: sem.page_count ?? null,
                        // Null, not 1, when nothing was adjudicated — a vacuous
                        // agreement must not be stored as a verified one.
                        agreement: report?.claims ? report.agreementScore : null,
                        claims: report?.claims ?? 0,
                        flags: report?.flags ?? [],
                    };
                    _phCapture('semantic_pass_completed', {
                        primary_source: data.source,
                        agreement: report?.claims ? report.agreementScore : null,
                        claims: report?.claims ?? 0,
                        flag_count: report?.flags?.length ?? 0,
                        docling_tables: sem.assets.tables?.length ?? 0,
                        geometry_tables: data.tableCount ?? null,
                    });
                }).catch(e =>
                    console.warn('[Semantic] pass failed after extraction:', e.message));
            }
        } else {
            _onSlotLoaded(2);
        }

        const SOURCE_LABELS = {
            'local': 'deterministic vector pipeline',
            'local-ocr-geometry': 'local layout + OCR (scanned)',
            'docling-ocr': 'Docling OCR + TableFormer (scanned)',
        };
        const source = SOURCE_LABELS[data.source] || 'Smart OCR (Docling)';
        const warnSuffix = data.warning ? ` (${data.warning})` : '';
        const COUNTED_SOURCES = new Set(['local', 'local-ocr-geometry', 'docling-ocr']);
        const tableSuffix = COUNTED_SOURCES.has(data.source) && data.tableCount != null
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
        if (window.GxTrack) {
            window.GxTrack.documentProcessed({
                tool: 'pdf-processor',
                format: 'pdf',
                source: data.source,
                page_count: data.pages?.length ?? 1,
                table_count: data.tableCount ?? 0,
                is_scanned: !!isScannedDoc,
            });
            window.GxTrack.artifactGenerated({
                tool: 'pdf-processor',
                artifact_type: 'structured_ir',
                schema: 'gx-doc/1',
                page_count: data.pages?.length ?? 1,
                table_count: data.tableCount ?? 0,
                block_count: (data.gxDoc?.pages || []).reduce((acc, p) => acc + (p.blocks?.length || 0), 0),
                has_provenance: true,
            });
        }
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
        ? DOMPurify.sanitize(html, { ADD_TAGS: ['img'], ALLOW_DATA_ATTR: true, ADD_ATTR: ['style'] })
        : html;
    el.innerHTML = clean;
    // VisualGridMapper is invoked here via initTableFeatures → initCrosshair,
    // enabling crosshair highlight and column features on merged-cell tables.
    initTableFeatures(el);
    hydrateImages(el);
    // Window the pages if this document is large enough to need it. No-op at
    // or below the page threshold, so small documents are untouched.
    refreshDocVirtualizer();
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
    file, bytes = null, html = '', text = '', styles = '', gxDoc = null,
    pages = [], extraction = null, slot = 1, docId = null,
}) {
    const pdfState = slot === 2 ? state.pdf2 : state.pdf1;
    const label = slot === 2 ? 'file2' : 'file1';

    pdfState.file = file || null;
    // Whichever document is mounted owns the stylesheet. Two documents define
    // `.f0` differently, so this replaces rather than merges — mounting a batch
    // item must not leave the previous one's fonts applied to it.
    //
    // `splitLeadingStyles` covers documents whose markup still has the block
    // prepended (anything extracted before docStyles.js, and the cached batch
    // results those runs produced): the CSS is lifted out to where it works
    // instead of being handed to a parser that will drop it.
    const lead = splitLeadingStyles(html);
    if (slot === 1) setDocumentStyles(styles || lead.css);
    html = lead.html;
    if (docId) pdfState.docId = docId;
    // Keep a pristine copy: pdf.js and pdf-lib both detach the buffer they are
    // handed, so the slot must never hold the same array anything else consumes.
    pdfState.bytes = bytes ? bytes.slice() : null;
    pdfState.extractedHTML = html;
    pdfState.extractedText = text;
    pdfState.gxDoc = gxDoc;
    pdfState.extraction = extraction;

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
    _onSlotLoaded(1);
}

function _onSlotLoaded(slot) {
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

    syncSlotNames();
}

// ── Loaded-file names ───────────────────────────────────────────────────────
// The name of the open document belongs to the surface showing it, not to the
// button that opened it. The file inputs are load actions with fixed labels
// ("Open File" / "Compare File"); the pane headers and the compare-pane labels
// carry the filename and the unload affordance.
//
// One writer for all of it: every load path already funnels through
// _onSlotLoaded, so the name is derived from state rather than pushed from
// each of the five format-specific handlers that used to set it themselves.

const SLOT_NAME_TARGETS = {
    // slot -> [selectors of .gx-file-name spans that should show it]
    1: ['#pdf-header-bar', '#doc-header-bar', '#analyze-canvas-header-bar', '#pane-left'],
    2: ['#pane-right'],
};

/**
 * Close the document in a slot.
 *
 * The mirror image of the tail of _commitSlot: clear the slot's state, then
 * tear down the derived surfaces it populated. Slot 2 is the cheap case (it
 * only feeds Compare). Slot 1 owns the rendered canvas, the page registry,
 * the annotation layers, the analysis cache and the HTML preview, so all of
 * those have to be dropped or they keep describing a document that is gone.
 */
export function unloadSlot(slot = 1) {
    const pdfState = slot === 2 ? state.pdf2 : state.pdf1;
    const hadFile = Boolean(pdfState.file || pdfState.extractedHTML || pdfState.extractedText);
    if (!hadFile) return;

    const name = pdfState.file?.name || 'Document';

    pdfState.file = null;
    pdfState.doc = null;
    pdfState.bytes = null;
    pdfState.extractedHTML = '';
    pdfState.extractedText = '';
    pdfState.gxDoc = null;
    pdfState.extraction = null;

    $(`#file${slot}-input`).val('').closest('.file-btn').removeClass('loaded');

    if (slot === 2) {
        $('#content-right').html('<div class="empty-state">Load Modified PDF</div>');
        _onSlotLoaded(2);
        showToast(`${name} closed`, 'info');
        return;
    }

    const container = document.getElementById('pdf-canvas-container');
    if (container) {
        unmountAnnotationLayers(container);
        $(container).empty().append('<p class="empty-hint">Open a PDF to view it here.</p>');
    }
    resetPDFLayers();
    resetAnalysisData();
    registerPages([], 0);
    annotationEngine.loadFromGxDoc(null);
    _analysisPromise = null;

    $('#html-preview').html(
        '<p class="empty-hint">Open a PDF to see the extracted HTML or Add Blank Page to Edit.</p>'
    );
    $('#content-left').html('<div class="empty-state">Load Original PDF</div>');

    _onSlotLoaded(1);
    showToast(`${name} closed`, 'info');
}

export function syncSlotNames() {
    [1, 2].forEach(slot => {
        const st = slot === 2 ? state.pdf2 : state.pdf1;
        const name = st.file?.name || st.gxDoc?.title || '';
        (SLOT_NAME_TARGETS[slot] || []).forEach(sel => {
            const $host = $(sel);
            if (!$host.length) return;
            $host.find('.gx-file-name').text(name);
            // The unload control is only meaningful once something is loaded.
            $host.find('.gx-file-chip').toggleClass('is-empty', !name);
        });
    });
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

    // Re-attach the document's own CSS. It is no longer in the string — it
    // lives in the app's stylesheet (docStyles.js), precisely because a leading
    // <style> block does not survive a parse/serialize round trip. An exported
    // file has no app around it, so this is where the two are rejoined.
    //
    // doc.head is still read as well: a document mounted from a pre-docStyles
    // cache may still carry the block, and the parser will have parked it there.
    const headCss = Array.from(doc.head?.querySelectorAll('style') || [])
        .map(s => s.outerHTML)
        .join('\n');
    const ownCss = getDocumentStyles();
    const fontCss = [ownCss ? `<style>\n${ownCss}\n</style>` : '', headCss]
        .filter(Boolean).join('\n');

    // Math blocks are KaTeX markup, which needs its stylesheet (and fonts) to
    // render. A standalone export has no app to load them, so inline the
    // generated self-contained KaTeX CSS (fonts as base64 data URIs) whenever
    // the document actually contains math.
    // Matched on any math marker, not just the confirmed one: the extractor now
    // typesets its reconstruction too, so a document can be full of KaTeX markup
    // without a single `data-math=""` in it. Gating on the confirmed marker
    // alone shipped those exports with no stylesheet, which renders an equation
    // as a vertical stack of unstyled glyphs.
    const katexCss = /class="[^"]*katex/.test(html) || /data-math(-suggested)?=""/.test(html)
        ? `<style>\n${katexExportCss}\n</style>`
        : '';

    // Restore body innerHTML as the document string
    html = doc.body.innerHTML;

    const title = state.pdf1.file?.name || 'Extracted PDF';
    const exportedHead = [
        '<meta charset="utf-8"/>',
        `<title>${title}</title>`,
        fontCss,
        katexCss,
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
