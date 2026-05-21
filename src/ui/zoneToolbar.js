/**
 * zoneToolbar.js
 * Per-page zone layout controls in the Doc view toolbar.
 *
 * A "zone" is a Y-range of a page with a fixed column count (1–4).
 * The zone layout is stored as JSON in data-zones on each .pdf-page-content
 * section. Changing a zone cycles its column count and restructures the DOM
 * in-place — no re-extraction required.
 *
 * Toolbar: [Z1·2col] [Z2·1col] [+ Zone]
 *   - Click a zone chip → cycle cols 1→2→3→4→1
 *   - Click + Zone     → split the zone with the largest Y gap into two zones
 */

import { showToast } from './toast.js';

let _refreshTimer = null;

export function initZoneToolbar() {
    document.getElementById('zone-chips')?.addEventListener('click', e => {
        const chip = e.target.closest('[data-zone-idx]');
        if (!chip) return;
        const pageEl = _getActivePage();
        if (pageEl) _cycleZoneCols(pageEl, parseInt(chip.dataset.zoneIdx, 10));
    });

    document.getElementById('btn-add-zone')?.addEventListener('click', () => {
        const pageEl = _getActivePage();
        if (pageEl) _splitZone(pageEl);
    });

    // Refresh chips as user scrolls through pages
    document.getElementById('html-preview')?.addEventListener('scroll', () => {
        clearTimeout(_refreshTimer);
        _refreshTimer = setTimeout(refreshZoneToolbar, 120);
    }, { passive: true });
}

export function refreshZoneToolbar() {
    const container = document.getElementById('zone-chips');
    if (!container) return;
    container.innerHTML = '';

    const pageEl = _getActivePage();
    if (!pageEl) return;

    const zones = _readZones(pageEl);
    zones.forEach((zone, i) => {
        const chip = document.createElement('button');
        chip.className = 'tool-btn zone-chip';
        chip.dataset.zoneIdx = i;
        chip.title = `Zone ${i + 1} — click to cycle column count (current: ${zone.cols})`;
        chip.textContent = zone.type === 'flex-center' ? `Z${i + 1}·center` : `Z${i + 1}·${zone.cols}col`;
        container.appendChild(chip);
    });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _getActivePage() {
    const preview = document.getElementById('html-preview');
    if (!preview) return null;
    const pages = [...preview.querySelectorAll('.pdf-page-content')];
    if (!pages.length) return null;
    const previewRect = preview.getBoundingClientRect();
    let best = null, bestArea = 0;
    for (const page of pages) {
        const r = page.getBoundingClientRect();
        const area = Math.max(0, Math.min(r.bottom, previewRect.bottom) - Math.max(r.top, previewRect.top));
        if (area > bestArea) { bestArea = area; best = page; }
    }
    return best;
}

function _cycleZoneCols(pageEl, zoneIdx) {
    const zones = _readZones(pageEl);
    if (!zones[zoneIdx]) return;
    const z = zones[zoneIdx];
    if (z.type === 'flex-center') {
        delete z.type;
        z.cols = 1;
        zones[zoneIdx] = z;
    } else {
        zones[zoneIdx] = { ...z, cols: (z.cols % 4) + 1 };
    }
    _writeZones(pageEl, zones);
    applyZones(pageEl, zones);
    refreshZoneToolbar();
}

function _splitZone(pageEl) {
    const zones = _readZones(pageEl);
    let bestZoneIdx = -1, bestGap = 0, bestSplitY = null;

    for (let zi = 0; zi < zones.length; zi++) {
        const zone = zones[zi];
        const regionEls = [...pageEl.querySelectorAll('.pdf-region')]
            .filter(el => {
                const ry = parseFloat(el.dataset.ry);
                return ry >= zone.y0 && ry < zone.y1;
            })
            .sort((a, b) => parseFloat(a.dataset.ry) - parseFloat(b.dataset.ry));

        for (let i = 1; i < regionEls.length; i++) {
            const gap = parseFloat(regionEls[i].dataset.ry) - parseFloat(regionEls[i - 1].dataset.ry);
            if (gap > bestGap) {
                bestGap = gap;
                bestSplitY = (parseFloat(regionEls[i - 1].dataset.ry) + parseFloat(regionEls[i].dataset.ry)) / 2;
                bestZoneIdx = zi;
            }
        }
    }

    if (bestZoneIdx === -1) {
        showToast('No natural split point found on this page', 'info');
        return;
    }

    const orig = zones[bestZoneIdx];
    zones.splice(bestZoneIdx, 1,
        { y0: orig.y0, y1: Math.round(bestSplitY), cols: orig.cols },
        { y0: Math.round(bestSplitY), y1: orig.y1, cols: orig.cols },
    );
    _writeZones(pageEl, zones);
    applyZones(pageEl, zones);
    refreshZoneToolbar();
}

function _readZones(pageEl) {
    try { return JSON.parse(pageEl.dataset.zones); }
    catch { return [{ y0: 0, y1: 99999, cols: 1 }]; }
}

function _writeZones(pageEl, zones) {
    pageEl.dataset.zones = JSON.stringify(zones);
}

// ── Public: DOM restructure ───────────────────────────────────────────────────

/**
 * Re-group all .pdf-region elements inside pageEl according to the given zones.
 * Each zone becomes a .pdf-zone--cols-N grid; regions are assigned to columns
 * purely by X position (rx / pageWidth * cols).
 */
export function applyZones(pageEl, zones) {
    const pageWidth = parseFloat(pageEl.dataset.pageWidth || '612');
    const regionEls = [...pageEl.querySelectorAll('.pdf-region')];
    const annotated = regionEls.map(el => ({
        el,
        ry: parseFloat(el.dataset.ry),
        rx: parseFloat(el.dataset.rx),
    }));

    // Remove existing zone containers (keep .page-label)
    [...pageEl.children].forEach(child => {
        if (!child.classList.contains('page-label')) child.remove();
    });

    const COL_NAMES = ['left', 'center', 'right'];

    for (const zone of zones) {
        const zoneRegions = annotated
            .filter(r => r.ry >= zone.y0 && r.ry < zone.y1)
            .sort((a, b) => a.ry - b.ry);
        if (!zoneRegions.length) continue;

        const zoneDiv = document.createElement('div');
        if (zone.type === 'flex-center') {
            zoneDiv.className = 'pdf-zone pdf-zone--flex-center';
            zoneRegions.forEach(r => zoneDiv.appendChild(r.el));
            pageEl.appendChild(zoneDiv);
            continue;
        }
        zoneDiv.className = `pdf-zone pdf-zone--cols-${zone.cols}`;

        if (zone.colWidths && zone.cols > 1) {
            zoneDiv.style.gridTemplateColumns = zone.colWidths.join(' ');
        }

        if (zone.cols === 1) {
            zoneRegions.forEach(r => zoneDiv.appendChild(r.el));
        } else {
            const cols = zone.cols;
            const colGroups = Array.from({ length: cols }, () => []);
            for (const r of zoneRegions) {
                const ci = Math.min(Math.floor(r.rx / pageWidth * cols), cols - 1);
                colGroups[ci].push(r);
            }
            for (let i = 0; i < cols; i++) {
                const colDiv = document.createElement('div');
                colDiv.className = `pdf-col pdf-col--${cols <= 3 ? COL_NAMES[i] : `col-${i}`}`;
                colGroups[i].sort((a, b) => a.ry - b.ry).forEach(r => colDiv.appendChild(r.el));
                zoneDiv.appendChild(colDiv);
            }
        }

        pageEl.appendChild(zoneDiv);
    }
}
