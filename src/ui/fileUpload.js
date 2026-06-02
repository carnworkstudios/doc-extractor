/**
 * fileUpload.js
 * Handles file input events, loads PDF documents, drives extraction via the
 * OS Worker Broker (backend → local geometry worker fallback), and populates all views.
 */

import $ from 'jquery';
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
// analyzePanel.js is injected by os-shell.js into this iframe at runtime.
// All calls are proxied through window.__GX_PDF_CORE__ dispatchers set up in app.js.
const _core = () => window.__GX_PDF_CORE__;

async function runAnalysis(bytes, filename) {
    const core = _core();
    if (!core) return;
    // Status updates go through the shared setStatus in viewController
    // (analyzePanel's own _setStatus will handle in-panel messaging once injected).
    try {
        const analysis = await core.getAnalyzePDF()(bytes, () => {});
        core._dispatchAnalysisReady(analysis);
    } catch (e) {
        console.warn('[Analyze] Analysis failed:', e.message);
    }
}

const pushRegionPage    = (n, r, s)    => _core()?._dispatchRegionPage(n, r, s);
const resetAnalysisData = ()           => _core()?._dispatchReset();
const setAnalyzeWorker  = (w)          => { window.__GX_PDF_GEO_WORKER__ = w; _core()?._dispatchWorkerReady(w); };
const onReprocessResult = (n, h, r, s) => _core()?._dispatchReprocessResult(n, h, r, s);
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
function _isProUser() {
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
                    onReprocessResult(msg.page, msg.html, msg.regions, msg.pageScale);
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
                if (msg.regions) pushRegionPage(msg.page, msg.regions, msg.pageScale);
            } else if (msg.type === 'complete') {
                clearTimeout(timeout);
                const styleBlock = msg.styles ? `<style>\n${msg.styles}\n</style>\n` : '';
                const html = htmlParts.length > 0
                    ? styleBlock + htmlParts.join('\n')
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

        worker.postMessage({ 
            type: 'process', 
            bytes,
            pdfWorkerSrc: window.__VSC_PDF_WORKER_SRC__ 
        });
    });
}

export function initFileInputs() {
    cwsBroker.init().then(() => {
        brokerReady = true;
        const mode = cwsBroker.getBackendStatus() ? 'Cloud Backend' : 'Offline (local geometry worker)';
        console.log(`[FileUpload] Broker ready — mode: ${mode}`);
    });

    $('#file1-input').on('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        if (/\.(html?|md)$/i.test(file.name)) {
            handleDocumentFile(file);
        } else {
            handleFile(file, 1);
        }
    });

    $('#file2-input').on('change', e => {
        if (e.target.files[0]) handleFile(e.target.files[0], 2);
    });

    // VS Code extension: signal ready then receive PDF bytes from extension host
    if (window.CwsBridge?.isEmbedded) {
        window.CwsBridge.send('ginexys:pdf-ready', {});
        window.addEventListener('message', e => {
            if (e.data?.type === 'ginexys:pdf-bytes') {
                const { buffer, fileName, mode } = e.data.payload;
                const bytes = new Uint8Array(buffer);
                const blob = new Blob([bytes], { type: 'application/pdf' });
                const file = new File([blob], fileName ?? 'document.pdf', { type: 'application/pdf' });
                handleFile(file, 1).then(() => {
                    if (mode) switchView(mode);
                });
            }
        });
    }
}

async function handleDocumentFile(file) {
    const text = await file.text();
    let html = text;

    if (/\.md$/i.test(file.name)) {
        html = markdownToHtml(text);
    }

    const clean = typeof DOMPurify !== 'undefined'
        ? DOMPurify.sanitize(html, { ADD_TAGS: ['img'], ALLOW_DATA_ATTR: true })
        : html;

    state.pdf1.extractedHTML = clean;
    state.pdf1.file = file;
    $('#file1-name').text(file.name);
    $('#file1-input').closest('.file-btn').addClass('loaded');

    applyHtmlEverywhere(clean, null);
    switchView('html');
    showToast(`${file.name} loaded`, 'success');
}

function markdownToHtml(md) {
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
            const bytesForAnalysis = pdfState.bytes.slice();

            // Unconditionally initialize geometry worker and give analyzePanel its reference
            const worker = ensureGeometryWorker();
            // Cache PDF bytes in the geometry worker so interactive re-extraction works on any pipeline
            worker.postMessage({
                type: 'cache-bytes',
                bytes: bytesForAnalysis.slice()
            });

            runAnalysis(bytesForAnalysis, file.name).catch(err =>
                console.warn('[Analyze] Analysis failed:', err.message),
            );
        }

        const formData = new FormData();
        formData.append('file', file);

        // Advance Extraction (AI layout via Docling + OpenRouter) is a Pro feature gated
        // by the .gx-pro-interceptor overlay in index.html. The checkbox is disabled in
        // markup so .checked is always false for free users; the explicit check below
        // is defense in depth against DOM manipulation.
        const toggle = document.getElementById('ai-layout-toggle');
        const useAiLayout = toggle && !toggle.disabled && toggle.checked;
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
        } else {
            // ── Local geometry worker fallback ────────────────────────────────
            showStatus('Backend offline — running local vector extraction…');
            const result = await extractViaGeometryWorker(bytesForWorker, (msg) => showStatus(msg));
            data = { html: result.html, text: result.text || '', source: 'local', tableCount: result.tableCount };
        }

        pdfState.extractedHTML = data.html;
        pdfState.extractedText = data.text || '';

        if (pdfIndex === 1) {
            // Push the freshly-extracted HTML to ALL surfaces in one shot:
            // state, both contenteditable previews, and the Monaco model.
            applyHtmlEverywhere(pdfState.extractedHTML, null);
            // Populate zone chips for the first visible page
            refreshZoneToolbar();
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
    hydrateImages(el);
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

    // Restore body innerHTML as the document string
    html = doc.body.innerHTML;

    const title = state.pdf1.file?.name || 'Extracted PDF';
    const blob = new Blob(
        [`<!doctype html><html><head><meta charset="utf-8"/><title>${title}</title><style>body{font-family:sans-serif;max-width:1000px;margin:0 auto;padding:2rem;}img{max-width:100%;}</style></head><body>\n${html}\n</body></html>`],
        { type: 'text/html' },
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (title.replace(/\.pdf$/i, '') || 'extracted') + '.html';
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Download complete', 'success');
}

export function exportExtractedPDF() {
    const preview = document.getElementById('html-preview');
    if (!preview?.innerHTML?.trim()) { showToast('No content to export', 'error'); return; }
    window.print();
}
