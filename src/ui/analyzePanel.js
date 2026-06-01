// analyzePanel.js
// Analyze tab — renders PDF metadata, per-page geometry canvas, region overlay,
// and per-page PageScale info.
//
// Geometry layers (from pdfAnalyzer):
//   Blue   — horizontal path segments
//   Green  — vertical path segments
//   Gray   — diagonal / other paths
//   Orange — closed rectangle candidates
//   Red    — image / bitmap regions
//   Yellow — text item baseline positions
//
// Region overlay (from geometryWorker 'page' messages):
//   LATTICE_TABLE → blue   STREAM_TABLE → cyan   BOX → orange
//   HEADING → purple       PARAGRAPH → gray       LIST → teal
//   IMAGE → red            DIVIDER → slate        HEADER/FOOTER → amber

import { analyzePDF } from '../extraction/vector/pdfAnalyzer.js';

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

// ── State ─────────────────────────────────────────────────────────────────────
let _analysis = null;       // from pdfAnalyzer (geometry layer data)
let _currentPage = 0;
let _confThreshold = 0;

// Region data pushed from geometryWorker, keyed by 1-based page number
const _regionsByPage = new Map();   // page → { regions: [], pageScale: {} }

// Geometry layer visibility
const _layers = {
    hSegs: true, vSegs: true, diagSegs: true,
    rects: true, images: true, text: true,
};

// Region type visibility
const _regionLayers = {
    LATTICE_TABLE: true, STREAM_TABLE: true, BOX: true,
    HEADING: true, PARAGRAPH: true, LIST: true,
    IMAGE: true, DIVIDER: true, HEADER: true, FOOTER: true,
};

// ── Entry point ───────────────────────────────────────────────────────────────

export function initAnalyzePanel() {
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
    const legend = document.getElementById('analyze-legend');
    if (legend) {
        legend.addEventListener('click', (e) => {
            const btn = e.target.closest('.legend-toggle');
            if (!btn || !('layer' in btn.dataset)) return;
            const layer = btn.dataset.layer;
            if (!(layer in _layers)) return;
            _layers[layer] = !_layers[layer];
            btn.classList.toggle('active', _layers[layer]);
            _redrawCanvas();
        });
    }

    // Region type toggles
    const regionLegend = document.getElementById('analyze-region-legend');
    if (regionLegend) {
        regionLegend.addEventListener('click', (e) => {
            const btn = e.target.closest('.legend-toggle');
            if (!btn || !('region' in btn.dataset)) return;
            const r = btn.dataset.region;
            if (!(r in _regionLayers)) return;
            _regionLayers[r] = !_regionLayers[r];
            btn.classList.toggle('active', _regionLayers[r]);
            _redrawCanvas();
        });
    }

    // Confidence slider
    const slider = document.getElementById('analyze-conf-slider');
    const confVal = document.getElementById('analyze-conf-val');
    if (slider) {
        slider.addEventListener('input', () => {
            _confThreshold = parseFloat(slider.value);
            if (confVal) confVal.textContent = _confThreshold.toFixed(2);
            _redrawCanvas();
        });
    }
}

// ── Called from fileUpload.js on each geometryWorker 'page' message ───────────

export function pushRegionPage(pageNum, regions, pageScale) {
    _regionsByPage.set(pageNum, { regions: regions || [], pageScale: pageScale || null });
    // If this is the page currently shown, redraw immediately
    if (_analysis && pageNum === _currentPage + 1) {
        _renderPageScale(pageScale);
        _redrawCanvas();
        _renderRegionStats(regions);
    }
}

// ── Called from fileUpload.js when a new PDF is loaded ───────────────────────

export function resetAnalysisData() {
    _regionsByPage.clear();
    _currentPage = 0;
    _analysis = null;
}

/**
 * Run geometry analysis (pdfAnalyzer) on a PDF file and populate the Analyze tab.
 * Only runs when the dev panel is visible (or via the _isProUser gate in fileUpload).
 */
export async function runAnalysis(bytes, filename) {
    const panel = document.getElementById('view-analyze');
    if (!panel) return;

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
    } catch (err) {
        _setStatus(`Analysis error: ${err.message}`);
    }
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
            ${field('File', filename)}
            ${field('PDF', 'v' + m.pdfVersion)}
            ${field('Size', m.fileSize)}
            ${field('Pages', m.numPages)}
        </div>
        <div class="ameta-row">
            ${field('Title', m.title)}
            ${field('Author', m.author)}
            ${field('Creator', m.creator)}
            ${field('Producer', m.producer)}
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
    el.innerHTML = `
        <table class="astat-table"><tbody>
            ${row('Page size', `${pg.widthPt}×${pg.heightPt} pt (${pg.widthIn}"×${pg.heightIn}")`)}
            ${row('Viewport', `${Math.round(pg.widthPx)}×${Math.round(pg.heightPx)} px`)}
            ${row('Text items', pg.textItemCount, '#eab308')}
            ${row('H segments', pg.hSegCount, '#3b82f6')}
            ${row('V segments', pg.vSegCount, '#10b981')}
            ${row('Diagonal segs', pg.diagSegCount, '#9ca3af')}
            ${row('Closed rects', pg.closedRectCount, '#f97316')}
            ${row('Image regions', pg.imageCount, '#ef4444')}
        </tbody></table>
    `;
}

function _renderRegionStats(regions) {
    const el = document.getElementById('analyze-region-stats');
    if (!el) return;
    if (!regions || !regions.length) {
        el.innerHTML = '<p style="font-size:11px;color:var(--text-muted);padding:4px 0">No region data yet.</p>';
        return;
    }
    const counts = {};
    for (const r of regions) {
        counts[r.type] = (counts[r.type] || 0) + 1;
    }
    const visible = regions.filter(r => (r.confidence ?? 1) >= _confThreshold);
    const rows = Object.entries(counts).sort((a,b) => b[1]-a[1]).map(([type, n]) => {
        const col = REGION_COLORS[type] || '#888';
        return `<tr>
            <td style="display:flex;align-items:center;gap:6px">
                <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${col}"></span>
                <span class="astat-key">${type}</span>
            </td>
            <td class="astat-val">${n}</td>
        </tr>`;
    }).join('');
    el.innerHTML = `<table class="astat-table"><tbody>${rows}</tbody></table>
        <p style="font-size:10px;color:var(--text-muted);margin-top:4px">${visible.length} of ${regions.length} above conf ${_confThreshold.toFixed(2)}</p>`;
}

function _renderPageScale(ps) {
    const row = document.getElementById('analyze-scale-row');
    if (!row) return;
    if (!ps) { row.style.display = 'none'; return; }
    row.style.display = 'flex';
    const fmt = v => (typeof v === 'number' ? v.toFixed(1) + 'px' : '—');
    const sEl    = document.getElementById('analyze-scale-s');
    const cgEl   = document.getElementById('analyze-scale-colgap');
    const ybEl   = document.getElementById('analyze-scale-yband');
    if (sEl)  sEl.textContent  = fmt(ps.S);
    if (cgEl) cgEl.textContent = fmt(ps.colGapMinPx);
    if (ybEl) ybEl.textContent = fmt(ps.yBandTolPx);
}

// ── Canvas drawing ────────────────────────────────────────────────────────────

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
        ctx.fillStyle = 'rgba(239,68,68,0.15)';
        ctx.strokeStyle = 'rgba(239,68,68,0.7)';
        ctx.lineWidth = 1.5;
        for (const r of pg.imageRegions) {
            ctx.fillRect(tx(r.x), ty(r.y), tx(r.w), ty(r.h));
            ctx.strokeRect(tx(r.x), ty(r.y), tx(r.w), ty(r.h));
        }
    }
    if (_layers.rects) {
        ctx.fillStyle = 'rgba(249,115,22,0.08)';
        ctx.strokeStyle = 'rgba(249,115,22,0.75)';
        ctx.lineWidth = 1;
        for (const r of pg.closedRects) {
            ctx.fillRect(tx(r.x), ty(r.y), tx(r.w), ty(r.h));
            ctx.strokeRect(tx(r.x), ty(r.y), tx(r.w), ty(r.h));
        }
    }
    if (_layers.diagSegs) {
        ctx.strokeStyle = 'rgba(107,114,128,0.3)';
        ctx.lineWidth = 0.5;
        for (const s of pg.diagSegs) {
            ctx.beginPath(); ctx.moveTo(tx(s.x1), ty(s.y1)); ctx.lineTo(tx(s.x2), ty(s.y2)); ctx.stroke();
        }
    }
    if (_layers.hSegs) {
        ctx.strokeStyle = 'rgba(59,130,246,0.75)';
        ctx.lineWidth = 1;
        for (const s of pg.hSegs) {
            ctx.beginPath(); ctx.moveTo(tx(s.x1), ty(s.y1)); ctx.lineTo(tx(s.x2), ty(s.y2)); ctx.stroke();
        }
    }
    if (_layers.vSegs) {
        ctx.strokeStyle = 'rgba(16,185,129,0.75)';
        ctx.lineWidth = 1;
        for (const s of pg.vSegs) {
            ctx.beginPath(); ctx.moveTo(tx(s.x1), ty(s.y1)); ctx.lineTo(tx(s.x2), ty(s.y2)); ctx.stroke();
        }
    }
    if (_layers.text) {
        ctx.fillStyle = 'rgba(234,179,8,0.55)';
        const vpT = pg.viewport.transform;
        for (const item of pg.textItems) {
            if (!item.str?.trim()) continue;
            const pdfX = item.transform[4], pdfY = item.transform[5];
            const sx = vpT[0] * pdfX + vpT[2] * pdfY + vpT[4];
            const sy = vpT[1] * pdfX + vpT[3] * pdfY + vpT[5];
            ctx.beginPath(); ctx.arc(tx(sx), ty(sy), 1.5, 0, Math.PI * 2); ctx.fill();
        }
    }

    // ── Region overlay (on top of geometry) ───────────────────────────────
    const pageData = _regionsByPage.get(_currentPage + 1);
    if (pageData?.regions?.length) {
        // Scale: region bboxes are in geometryWorker viewport space (scale 2.0).
        // pdfAnalyzer uses scale 1.5. We need to re-scale from worker space → canvas space.
        // Worker viewport width at scale 2.0 ≈ pg.widthPx * (2.0/1.5).
        const workerVpW = pg.widthPx * (2.0 / 1.5);
        const regionScale = canvas.width / workerVpW;

        for (const r of pageData.regions) {
            if (!r.bbox) continue;
            const conf = r.confidence ?? 1.0;
            if (conf < _confThreshold) continue;
            const type = r.type;
            if (!_regionLayers[type]) continue;

            const hex = REGION_COLORS[type] || '#888888';
            const alpha = Math.max(0.15, Math.min(0.6, conf * 0.55));
            const strokeAlpha = Math.max(0.5, conf);

            const rx = r.bbox.x * regionScale;
            const ry = r.bbox.y * regionScale;
            const rw = r.bbox.w * regionScale;
            const rh = r.bbox.h * regionScale;

            ctx.fillStyle   = hex + _alphaHex(alpha);
            ctx.strokeStyle = hex + _alphaHex(strokeAlpha);
            ctx.lineWidth   = 1.5;
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeRect(rx, ry, rw, rh);

            // Algorithm badge (top-left of region)
            if (rw > 40 && rh > 12) {
                const label = r.algorithm === 'struct-tree' ? 'ST'
                    : r.algorithm === 'lattice' ? 'LT'
                    : r.algorithm === 'stream' ? 'SM'
                    : type.slice(0, 2);
                ctx.font = `bold ${Math.max(8, Math.min(11, rh * 0.35))}px monospace`;
                ctx.fillStyle = hex;
                ctx.fillText(label, rx + 3, ry + Math.max(8, Math.min(11, rh * 0.35)) + 1);
            }
        }
    }
}

// Convert 0–1 alpha to 2-char hex suffix for colour strings
function _alphaHex(a) {
    return Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function _updatePageNav(idx, total) {
    const counter = document.getElementById('analyze-page-counter');
    if (counter) counter.textContent = `Page ${idx + 1} of ${total}`;
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
