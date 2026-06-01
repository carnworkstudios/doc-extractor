// analyzePanel.js
// Analyze tab — geometry canvas, region overlay, pipeline threshold sliders,
// format toolbar (page nav, Re-extract page, Bulk extract).

import { analyzePDF } from '../extraction/vector/pdfAnalyzer.js';
import { showToast } from './toast.js';

// ── Region colour map ────────────────────────────────────────────────────────
const REGION_COLORS = {
    LATTICE_TABLE: '#2563eb',
    STREAM_TABLE:  '#06b6d4',
    TABLE:         '#2563eb',
    BOX:           '#f97316',
    HEADING:       '#8b5cf6',
    PARAGRAPH:     '#6b7280',
    LIST:          '#14b8a6',
    IMAGE:         '#ef4444',
    DIVIDER:       '#94a3b8',
    HEADER:        '#f59e0b',
    FOOTER:        '#f59e0b',
};

// Text baseline dot colour — magenta, loud against blue/green/orange geometry
const TEXT_DOT_COLOR = 'rgba(232,121,249,0.85)';

// ── State ─────────────────────────────────────────────────────────────────────
let _analysis    = null;   // pdfAnalyzer output (geometry layer data)
let _geoWorker   = null;   // reference passed from fileUpload for re-extract
let _currentPage = 0;
let _confThreshold = 0;

// Active ghost overlay type while a slider is being dragged
let _ghostType   = null;

// PageScale ratio overrides — updated by sliders, consumed by re-extract
const _scaleOverrides = {
    R_Y_BAND:          0.45,
    R_PARA_GAP:        1.80,
    R_COL_GAP_MIN:     1.50,
    STREAM_CONFIDENCE: 0.60,
};

// Region data pushed from geometryWorker, keyed by 1-based page number
const _regionsByPage = new Map();

// Geometry layer visibility
const _layers = {
    hSegs: true, vSegs: true, diagSegs: true,
    rects: true, images: true, text: true,
};

// Region type visibility (also drives re-extract skip list)
const _regionLayers = {
    LATTICE_TABLE: true, STREAM_TABLE: true, BOX: true,
    HEADING: true, PARAGRAPH: true, LIST: true,
    IMAGE: true, DIVIDER: true, HEADER: true, FOOTER: true,
};

// ── Entry point ───────────────────────────────────────────────────────────────

export function initAnalyzePanel(geoWorkerRef) {
    if (geoWorkerRef) _geoWorker = geoWorkerRef;

    // Page nav
    document.getElementById('analyze-page-prev')?.addEventListener('click', () => {
        if (!_analysis || _currentPage <= 0) return;
        _currentPage--;
        _renderPage(_currentPage);
    });
    document.getElementById('analyze-page-next')?.addEventListener('click', () => {
        if (!_analysis || _currentPage >= _analysis.pages.length - 1) return;
        _currentPage++;
        _renderPage(_currentPage);
    });

    // Geometry layer toggles
    document.getElementById('analyze-legend')?.addEventListener('click', e => {
        const btn = e.target.closest('.legend-toggle');
        if (!btn || !('layer' in btn.dataset)) return;
        const layer = btn.dataset.layer;
        if (!(layer in _layers)) return;
        _layers[layer] = !_layers[layer];
        btn.classList.toggle('active', _layers[layer]);
        _redrawCanvas();
    });

    // Region type toggles
    document.getElementById('analyze-region-legend')?.addEventListener('click', e => {
        const btn = e.target.closest('.legend-toggle');
        if (!btn || !('region' in btn.dataset)) return;
        const r = btn.dataset.region;
        if (!(r in _regionLayers)) return;
        _regionLayers[r] = !_regionLayers[r];
        btn.classList.toggle('active', _regionLayers[r]);
        _redrawCanvas();
        _updateReextractBtn();
    });

    // Sliders
    _wireSlider('analyze-conf-slider',       'analyze-conf-val',       v => { _confThreshold = v; _redrawCanvas(); _renderRegionStats(_regionsByPage.get(_currentPage + 1)?.regions ?? []); });
    _wireSlider('analyze-yband-slider',      'analyze-yband-val',      v => { _scaleOverrides.R_Y_BAND = v; });
    _wireSlider('analyze-paragap-slider',    'analyze-paragap-val',    v => { _scaleOverrides.R_PARA_GAP = v; });
    _wireSlider('analyze-colgap-slider',     'analyze-colgap-val',     v => { _scaleOverrides.R_COL_GAP_MIN = v; });
    _wireSlider('analyze-streamconf-slider', 'analyze-streamconf-val', v => { _scaleOverrides.STREAM_CONFIDENCE = v; });

    // Re-extract page button
    document.getElementById('analyze-reextract')?.addEventListener('click', _doReextract);

    // Bulk extract — pro gate
    document.getElementById('analyze-bulk-extract')?.addEventListener('click', () => {
        if (typeof window.openProWaitlist === 'function') {
            window.openProWaitlist('pdf-analyze-bulk', 'Re-extract all pages with custom pipeline settings.');
        }
    });
}

// Wire a slider: updates display val, fires onChange, shows ghost overlay on drag
function _wireSlider(sliderId, valId, onChange) {
    const slider = document.getElementById(sliderId);
    const valEl  = document.getElementById(valId);
    if (!slider) return;

    const ghostType = slider.dataset.ghost;

    slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        if (valEl) valEl.textContent = v.toFixed(2);
        onChange(v);
        _ghostType = ghostType;
        _redrawCanvas();
    });
    slider.addEventListener('change', () => {
        _ghostType = null;
        _redrawCanvas();
    });
    slider.addEventListener('pointerdown', () => {
        _ghostType = ghostType;
    });
}

// ── Public API called from fileUpload.js ──────────────────────────────────────

export function setAnalyzeWorker(worker) {
    _geoWorker = worker;
}

export function pushRegionPage(pageNum, regions, pageScale) {
    _regionsByPage.set(pageNum, { regions: regions || [], pageScale: pageScale || null });
    if (_analysis && pageNum === _currentPage + 1) {
        _renderPageScale(pageScale);
        _renderRegionStats(regions);
        _redrawCanvas();
    }
    // Enable Re-extract once we have a loaded page
    _updateReextractBtn();
}

export function resetAnalysisData() {
    _regionsByPage.clear();
    _currentPage = 0;
    _analysis = null;
    _updateReextractBtn();
}

export async function runAnalysis(bytes, filename) {
    _setStatus(`Analyzing ${filename}…`);
    _regionsByPage.clear();
    try {
        _analysis = await analyzePDF(bytes, (p, total) => {
            _setStatus(`Analyzing page ${p} / ${total}…`);
        });
        _currentPage = 0;
        _renderMetadata(_analysis.metadata, filename);
        _renderPage(0);
        _setStatus('');
        _updateReextractBtn();
    } catch (err) {
        _setStatus(`Analysis error: ${err.message}`);
    }
}

// ── Re-extract ────────────────────────────────────────────────────────────────

function _updateReextractBtn() {
    const btn = document.getElementById('analyze-reextract');
    if (!btn) return;
    btn.disabled = !(_geoWorker && _analysis);
}

function _doReextract() {
    if (!_geoWorker || !_analysis) return;

    // Build skip set from toggled-off region layers
    const skip = Object.entries(_regionLayers)
        .filter(([, on]) => !on)
        .map(([type]) => type);

    const btn = document.getElementById('analyze-reextract');
    if (btn) { btn.disabled = true; btn.textContent = 'Extracting…'; }

    _geoWorker.postMessage({
        type: 'reprocess',
        page: _currentPage + 1,  // 1-based
        pipeline: {
            skip,
            scaleOverrides: { ..._scaleOverrides },
        },
    });
}

// Called from fileUpload when a 'page' message arrives that came from a 'reprocess'
export function onReprocessResult(pageNum, html, regions, pageScale) {
    // Patch the live HTML for just this page
    if (typeof window._patchPageHtml === 'function') {
        window._patchPageHtml(pageNum, html);
    }
    // Update region data
    _regionsByPage.set(pageNum, { regions: regions || [], pageScale: pageScale || null });
    if (pageNum === _currentPage + 1) {
        _renderPageScale(pageScale);
        _renderRegionStats(regions);
        _redrawCanvas();
    }
    const btn = document.getElementById('analyze-reextract');
    if (btn) { btn.disabled = false; btn.textContent = ''; btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Re-extract page`; }
    _updateReextractBtn();
}

// Called from fileUpload when an error arrives that came from a 'reprocess'
export function onReprocessError(pageNum, errMessage) {
    if (pageNum === _currentPage + 1) {
        _setStatus(`Extraction error: ${errMessage}`);
    }
    const btn = document.getElementById('analyze-reextract');
    if (btn) {
        btn.disabled = false;
        btn.textContent = '';
        btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Re-extract page`;
    }
    _updateReextractBtn();
    showToast(`Re-extraction failed: ${errMessage}`, 'error');
}

// ── Metadata ──────────────────────────────────────────────────────────────────

function _renderMetadata(m, filename) {
    const el = document.getElementById('analyze-meta');
    if (!el) return;
    const field = (label, val) => val
        ? `<span class="ameta-field"><span class="ameta-key">${label}</span><span class="ameta-val">${_esc(val)}</span></span>`
        : '';
    el.innerHTML = `
        <div class="ameta-row">
            ${field('File', filename)}${field('PDF', 'v' + m.pdfVersion)}${field('Size', m.fileSize)}${field('Pages', m.numPages)}
        </div>
        <div class="ameta-row">
            ${field('Title', m.title)}${field('Author', m.author)}${field('Creator', m.creator)}${field('Producer', m.producer)}
        </div>
        ${m.created ? `<div class="ameta-row">${field('Created', m.created)}${field('Modified', m.modified)}</div>` : ''}
    `;
}

// ── Page render ───────────────────────────────────────────────────────────────

function _renderPage(idx) {
    if (!_analysis?.pages?.length) return;
    const pg = _analysis.pages[idx];
    _renderStats(pg);
    _renderCanvas(pg);
    _updatePageNav(idx, _analysis.pages.length);
    const pageData = _regionsByPage.get(idx + 1);
    _renderPageScale(pageData?.pageScale ?? null);
    _renderRegionStats(pageData?.regions ?? []);
}

function _renderStats(pg) {
    const el = document.getElementById('analyze-stats');
    if (!el) return;
    const row = (label, val, color) =>
        `<tr><td class="astat-key">${label}</td><td class="astat-val" style="color:${color || 'inherit'}">${val}</td></tr>`;
    el.innerHTML = `<table class="astat-table"><tbody>
        ${row('Page size', `${pg.widthPt}×${pg.heightPt} pt`)}
        ${row('Viewport', `${Math.round(pg.widthPx)}×${Math.round(pg.heightPx)} px`)}
        ${row('Text items',   pg.textItemCount,   '#e879f9')}
        ${row('H segments',   pg.hSegCount,        '#3b82f6')}
        ${row('V segments',   pg.vSegCount,        '#10b981')}
        ${row('Diag segs',    pg.diagSegCount,     '#9ca3af')}
        ${row('Closed rects', pg.closedRectCount,  '#f97316')}
        ${row('Images',       pg.imageCount,       '#ef4444')}
    </tbody></table>`;
}

function _renderRegionStats(regions) {
    const el = document.getElementById('analyze-region-stats');
    if (!el) return;
    if (!regions?.length) {
        el.innerHTML = '<p style="font-size:11px;color:var(--text-muted);padding:4px 0">No region data yet.</p>';
        return;
    }
    const counts = {};
    for (const r of regions) counts[r.type] = (counts[r.type] || 0) + 1;
    const visible = regions.filter(r => (r.confidence ?? 1) >= _confThreshold);
    const rows = Object.entries(counts).sort((a,b) => b[1]-a[1]).map(([type, n]) => {
        const col = REGION_COLORS[type] || '#888';
        const on  = _regionLayers[type] !== false;
        return `<tr style="opacity:${on ? 1 : 0.38}">
            <td style="display:flex;align-items:center;gap:6px;padding:2px 0">
                <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${col}"></span>
                <span class="astat-key">${type}</span>
            </td>
            <td class="astat-val">${n}</td>
        </tr>`;
    }).join('');
    el.innerHTML = `<table class="astat-table"><tbody>${rows}</tbody></table>
        <p style="font-size:10px;color:var(--text-muted);margin-top:4px">${visible.length}/${regions.length} above conf ${_confThreshold.toFixed(2)}</p>`;
}

function _renderPageScale(ps) {
    const row = document.getElementById('analyze-scale-row');
    if (!row) return;
    if (!ps) { row.style.display = 'none'; return; }
    row.style.display = '';
    const fmt = v => typeof v === 'number' ? v.toFixed(1) + 'px' : '—';
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = fmt(v); };
    set('analyze-scale-s',       ps.S);
    set('analyze-scale-colgap',  ps.colGapMinPx);
    set('analyze-scale-yband',   ps.yBandTolPx);
    set('analyze-scale-paragap', ps.paraGapPx);
}

// ── Canvas ────────────────────────────────────────────────────────────────────

function _redrawCanvas() {
    if (!_analysis?.pages?.length) return;
    _renderCanvas(_analysis.pages[_currentPage]);
}

function _renderCanvas(pg) {
    const canvas = document.getElementById('analyze-canvas');
    if (!canvas) return;

    const maxW = Math.min(540, canvas.parentElement?.clientWidth || 540);
    const scale = maxW / pg.widthPx;
    canvas.width  = Math.round(pg.widthPx  * scale);
    canvas.height = Math.round(pg.heightPx * scale);

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);

    const tx = x => x * scale;
    const ty = y => y * scale;

    // ── Geometry layers ────────────────────────────────────────────────────
    if (_layers.images) {
        ctx.fillStyle   = 'rgba(239,68,68,0.12)';
        ctx.strokeStyle = 'rgba(239,68,68,0.65)';
        ctx.lineWidth = 1.5;
        for (const r of pg.imageRegions) {
            ctx.fillRect(tx(r.x), ty(r.y), tx(r.w), ty(r.h));
            ctx.strokeRect(tx(r.x), ty(r.y), tx(r.w), ty(r.h));
        }
    }
    if (_layers.rects) {
        ctx.fillStyle   = 'rgba(249,115,22,0.07)';
        ctx.strokeStyle = 'rgba(249,115,22,0.7)';
        ctx.lineWidth = 1;
        for (const r of pg.closedRects) {
            ctx.fillRect(tx(r.x), ty(r.y), tx(r.w), ty(r.h));
            ctx.strokeRect(tx(r.x), ty(r.y), tx(r.w), ty(r.h));
        }
    }
    if (_layers.diagSegs) {
        ctx.strokeStyle = 'rgba(107,114,128,0.28)';
        ctx.lineWidth = 0.5;
        for (const s of pg.diagSegs) {
            ctx.beginPath(); ctx.moveTo(tx(s.x1), ty(s.y1)); ctx.lineTo(tx(s.x2), ty(s.y2)); ctx.stroke();
        }
    }
    if (_layers.hSegs) {
        ctx.strokeStyle = 'rgba(59,130,246,0.8)';
        ctx.lineWidth = 1;
        for (const s of pg.hSegs) {
            ctx.beginPath(); ctx.moveTo(tx(s.x1), ty(s.y1)); ctx.lineTo(tx(s.x2), ty(s.y2)); ctx.stroke();
        }
    }
    if (_layers.vSegs) {
        ctx.strokeStyle = 'rgba(16,185,129,0.8)';
        ctx.lineWidth = 1;
        for (const s of pg.vSegs) {
            ctx.beginPath(); ctx.moveTo(tx(s.x1), ty(s.y1)); ctx.lineTo(tx(s.x2), ty(s.y2)); ctx.stroke();
        }
    }
    if (_layers.text) {
        ctx.fillStyle = TEXT_DOT_COLOR;
        const vpT = pg.viewport.transform;
        for (const item of pg.textItems) {
            if (!item.str?.trim()) continue;
            const pdfX = item.transform[4], pdfY = item.transform[5];
            const sx = vpT[0]*pdfX + vpT[2]*pdfY + vpT[4];
            const sy = vpT[1]*pdfX + vpT[3]*pdfY + vpT[5];
            ctx.beginPath(); ctx.arc(tx(sx), ty(sy), 1.8, 0, Math.PI * 2); ctx.fill();
        }
    }

    // ── Region overlay ─────────────────────────────────────────────────────
    const pageData = _regionsByPage.get(_currentPage + 1);
    if (pageData?.regions?.length) {
        const workerVpW  = pg.widthPx * (2.0 / 1.5);
        const rScale = canvas.width / workerVpW;

        for (const r of pageData.regions) {
            if (!r.bbox) continue;
            const conf = r.confidence ?? 1.0;
            if (conf < _confThreshold) continue;
            if (!_regionLayers[r.type]) continue;

            const hex    = REGION_COLORS[r.type] || '#888888';
            const alpha  = Math.max(0.12, Math.min(0.50, conf * 0.50));
            const sAlpha = Math.max(0.55, conf);

            const rx = r.bbox.x * rScale, ry = r.bbox.y * rScale;
            const rw = r.bbox.w * rScale, rh = r.bbox.h * rScale;

            ctx.fillStyle   = hex + _alphaHex(alpha);
            ctx.strokeStyle = hex + _alphaHex(sAlpha);
            ctx.lineWidth   = 1.5;
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeRect(rx, ry, rw, rh);

            if (rw > 40 && rh > 12) {
                const label = r.algorithm === 'struct-tree' ? 'ST'
                    : r.algorithm === 'lattice' ? 'LT'
                    : r.algorithm === 'stream'  ? 'SM'
                    : r.type.slice(0, 2);
                const fs = Math.max(8, Math.min(11, rh * 0.35));
                ctx.font      = `bold ${fs}px monospace`;
                ctx.fillStyle = hex;
                ctx.fillText(label, rx + 3, ry + fs + 1);
            }
        }
    }

    // ── Ghost overlay (while slider is dragged) ────────────────────────────
    if (_ghostType && pageData?.pageScale) {
        _drawGhost(ctx, pg, pageData, scale, canvas);
    }
}

function _drawGhost(ctx, pg, pageData, scale, canvas) {
    const ps = pageData.pageScale;
    if (!ps) return;

    // Worker viewport is at scale 2.0, analyzer at 1.5 — same ratio used for regions
    const workerVpW = pg.widthPx * (2.0 / 1.5);
    const rScale    = canvas.width / workerVpW;
    const tx = x => x * scale;
    const ty = y => y * scale;

    if (_ghostType === 'yband') {
        // Draw bracket lines showing the current Y-band tolerance
        const tolPx = ps.S * _scaleOverrides.R_Y_BAND * rScale;
        ctx.strokeStyle = 'rgba(232,121,249,0.7)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([3, 3]);
        for (const r of pageData.regions) {
            if (!r.bbox) continue;
            const ry = r.bbox.y * rScale;
            ctx.beginPath(); ctx.moveTo(0, ry - tolPx); ctx.lineTo(canvas.width, ry - tolPx); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, ry + tolPx); ctx.lineTo(canvas.width, ry + tolPx); ctx.stroke();
        }
        ctx.setLineDash([]);
        _ghostLabel(ctx, canvas, `Y-band tol: ±${(ps.S * _scaleOverrides.R_Y_BAND).toFixed(1)}px`);
    }

    if (_ghostType === 'paragap') {
        const gapPx = ps.S * _scaleOverrides.R_PARA_GAP * rScale;
        ctx.strokeStyle = 'rgba(139,92,246,0.55)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        // Draw gap threshold line from each region bottom
        for (const r of pageData.regions) {
            if (!r.bbox) continue;
            const bottom = (r.bbox.y + r.bbox.h) * rScale;
            ctx.beginPath(); ctx.moveTo(0, bottom + gapPx); ctx.lineTo(canvas.width, bottom + gapPx); ctx.stroke();
        }
        ctx.setLineDash([]);
        _ghostLabel(ctx, canvas, `Para gap: ${(ps.S * _scaleOverrides.R_PARA_GAP).toFixed(1)}px`);
    }

    if (_ghostType === 'colgap') {
        const minGapPx = ps.S * _scaleOverrides.R_COL_GAP_MIN * rScale;
        ctx.fillStyle   = 'rgba(6,182,212,0.18)';
        ctx.strokeStyle = 'rgba(6,182,212,0.7)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        // Shade the minimum column gutter width centred on page midpoint as reference
        const mid = canvas.width / 2;
        ctx.fillRect(mid - minGapPx / 2, 0, minGapPx, canvas.height);
        ctx.beginPath(); ctx.moveTo(mid - minGapPx / 2, 0); ctx.lineTo(mid - minGapPx / 2, canvas.height); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(mid + minGapPx / 2, 0); ctx.lineTo(mid + minGapPx / 2, canvas.height); ctx.stroke();
        ctx.setLineDash([]);
        _ghostLabel(ctx, canvas, `Col gap min: ${(ps.S * _scaleOverrides.R_COL_GAP_MIN).toFixed(1)}px`);
    }

    if (_ghostType === 'streamconf') {
        // Draw confidence badges on stream regions showing their score vs threshold
        for (const r of pageData.regions) {
            if (r.type !== 'STREAM_TABLE' || !r.bbox) continue;
            const rx = r.bbox.x * rScale, ry = r.bbox.y * rScale;
            const conf = r.confidence ?? 0;
            const pass = conf >= _scaleOverrides.STREAM_CONFIDENCE;
            ctx.fillStyle   = pass ? 'rgba(20,184,166,0.25)' : 'rgba(239,68,68,0.25)';
            ctx.strokeStyle = pass ? '#14b8a6' : '#ef4444';
            ctx.lineWidth   = 2;
            ctx.fillRect(rx, ry, r.bbox.w * rScale, r.bbox.h * rScale);
            ctx.strokeRect(rx, ry, r.bbox.w * rScale, r.bbox.h * rScale);
            ctx.fillStyle = pass ? '#0d9488' : '#dc2626';
            ctx.font      = 'bold 11px monospace';
            ctx.fillText(`${conf.toFixed(2)} ${pass ? '✓' : '✗'}`, rx + 4, ry + 14);
        }
        _ghostLabel(ctx, canvas, `Stream conf threshold: ${_scaleOverrides.STREAM_CONFIDENCE.toFixed(2)}`);
    }
}

function _ghostLabel(ctx, canvas, text) {
    ctx.font      = 'bold 11px Inter, sans-serif';
    const w       = ctx.measureText(text).width;
    const x       = canvas.width - w - 12;
    const y       = canvas.height - 10;
    ctx.fillStyle = 'rgba(0,0,0,0.70)';
    ctx.beginPath();
    ctx.roundRect?.(x - 6, y - 15, w + 12, 20, 4) || ctx.rect(x - 6, y - 15, w + 12, 20);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x, y);
}

function _alphaHex(a) {
    return Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function _updatePageNav(idx, total) {
    const counter = document.getElementById('analyze-page-counter');
    if (counter) counter.textContent = `${idx + 1} / ${total}`;
    const prev = document.getElementById('analyze-page-prev');
    const next = document.getElementById('analyze-page-next');
    if (prev) prev.disabled = idx === 0;
    if (next) next.disabled = idx === total - 1;
}

function _setStatus(msg) {
    const el = document.getElementById('analyze-status');
    if (el) el.textContent = msg;
}

function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
