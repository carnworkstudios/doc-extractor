/**
 * fileUpload.js
 * Handles file input events, loads PDF documents, drives extraction via the
 * OS Worker Broker (backend → local geometry worker fallback), and populates all views.
 */

import $ from 'jquery';
import { state } from '../state.js';
import { renderPDFToCanvas } from './pdfCanvas.js';
import { showStatus, hideStatus, enableDiffTab, disableDiffTab } from './viewController.js';
import { registerPages } from './pageNav.js';
import { markDiffDirty } from './visualDiff.js';
import { initTableFeatures } from '../utils/tableLogic.js';
import { applyHtmlEverywhere } from './htmlSync.js';
import { showToast } from './toast.js';
import { cwsBroker } from '@os/worker-broker.js';
import { runAnalysis } from './analyzePanel.js';

let brokerReady = false;

// Lazily created geometry worker for local (offline) table extraction
let _geoWorker = null;

function ensureGeometryWorker() {
    if (!_geoWorker) {
        _geoWorker = new Worker(
            new URL('../workers/geometryWorker.js', import.meta.url),
            { type: 'module' },
        );
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
        let totalTables = 0;

        const timeout = setTimeout(() => {
            reject(new Error('Local extraction timed out (>5min).'));
        }, 300_000);

        worker.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'progress' && onProgress) {
                onProgress(`Extracting page ${msg.page}/${msg.total}…`);
            } else if (msg.type === 'page') {
                // Per-page streaming result
                if (msg.html) htmlParts.push(msg.html);
                if (msg.text) textParts.push(msg.text);
                totalTables += msg.tables || 0;
            } else if (msg.type === 'complete') {
                clearTimeout(timeout);
                const html = htmlParts.length > 0
                    ? htmlParts.join('\n')
                    : '<p class="no-tables-msg">No table structures detected. This PDF may use text-only layout.</p>';
                const text = textParts.join('\n\n--- page break ---\n\n');
                resolve({ html, text, tableCount: msg.tableCount ?? totalTables });
            } else if (msg.type === 'error') {
                clearTimeout(timeout);
                reject(new Error(msg.error));
            }
        };

        worker.onerror = (err) => {
            clearTimeout(timeout);
            reject(new Error('Geometry worker crashed: ' + (err.message || err)));
        };

        worker.postMessage({ type: 'process', bytes });
    });
}

export function initFileInputs() {
    cwsBroker.init().then(() => {
        brokerReady = true;
        const mode = cwsBroker.getBackendStatus() ? 'Cloud Backend' : 'Offline (local geometry worker)';
        console.log(`[FileUpload] Broker ready — mode: ${mode}`);
    });

    $('#file1-input').on('change', e => {
        if (e.target.files[0]) handleFile(e.target.files[0], 1);
    });

    $('#file2-input').on('change', e => {
        if (e.target.files[0]) handleFile(e.target.files[0], 2);
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

        if (pdfIndex === 1) {
            // pdfjsLib.getDocument will transfer and detach the ArrayBuffer, so we MUST pass a copy (.slice())
            const { wrappers, numPages } = await renderPDFToCanvas(pdfState.bytes.slice(), 'pdf-canvas-container');
            registerPages(wrappers, numPages);
            // Kick off analysis in the background — populates the Analyze tab
            runAnalysis(pdfState.bytes.slice(), file.name).catch(err =>
                console.warn('[Analyze] Analysis failed:', err.message),
            );
        }

        const formData = new FormData();
        formData.append('file', file);

        const useAiLayout = document.getElementById('ai-layout-toggle')?.checked;
        const apiKey = document.getElementById('ai-api-key')?.value;
        if (useAiLayout) {
            formData.append('use_ai_layout', 'true');
            if (apiKey) formData.append('api_key', apiKey);
        }

        if (!brokerReady) {
            showStatus('Connecting to extraction service…');
            await cwsBroker.init();
            brokerReady = true;
        }

        let data;

        if (cwsBroker.getBackendStatus()) {
            // ── Backend path (orchestrator or legacy) ────────────────────────
            data = await cwsBroker.extractPdf(formData, (msg) => showStatus(
                typeof msg === 'string' ? msg : (msg.message || 'Processing…'),
            ));
        } else {
            // ── Local geometry worker fallback ────────────────────────────────
            showStatus('Backend offline — running local vector extraction…');
            // worker.postMessage might transfer the buffer, so pass a copy
            const result = await extractViaGeometryWorker(pdfState.bytes.slice(), (msg) => showStatus(msg));
            data = { html: result.html, text: result.text || '', source: 'local', tableCount: result.tableCount };
        }

        pdfState.extractedHTML = data.html;
        pdfState.extractedText = data.text || '';

        if (pdfIndex === 1) {
            // Push the freshly-extracted HTML to ALL surfaces in one shot:
            // state, both contenteditable previews, and the Monaco model.
            applyHtmlEverywhere(pdfState.extractedHTML, null);
            markDiffDirty();
            if (state.pdf2.bytes) refreshCodeDiff();
        } else {
            refreshCodeDiff();
            enableDiffTab();
        }

        const source = data.source === 'local' ? 'Local (vector tables only)' : 'Cloud Backend';
        const warnSuffix = data.warning ? ` (${data.warning})` : '';
        const tableSuffix = data.source === 'local' && data.tableCount != null
            ? ` — ${data.tableCount} table${data.tableCount !== 1 ? 's' : ''} detected`
            : '';
        showToast(`PDF loaded via ${source}${tableSuffix}${warnSuffix}`, 'success');
        hideStatus();

    } catch (err) {
        console.error(`Error loading PDF ${pdfIndex}:`, err);
        hideStatus();
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
}

function refreshCodeDiff() {
    import('../ui/diffViewController.js').then(m => m.refreshCompareDiff());
}

export function downloadExtractedHTML() {
    const html = state.pdf1.extractedHTML;
    if (!html) { showToast('No extracted HTML yet; load a PDF first', 'error'); return; }
    const blob = new Blob(
        [`<!doctype html><html><head><meta charset="utf-8"/></head><body>\n${html}\n</body></html>`],
        { type: 'text/html' },
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.pdf1.file?.name?.replace(/\.pdf$/i, '') || 'extracted') + '.html';
    a.click();
    URL.revokeObjectURL(a.href);
}

export function exportExtractedPDF() {
    const preview = document.getElementById('html-preview');
    if (!preview?.innerHTML?.trim()) { showToast('No content to export', 'error'); return; }
    window.print();
}
