/**
 * selectionMode.js
 * Toggles the Doc tab between Edit Mode (contenteditable) and Selection Mode
 * (drag-to-reorder zones/regions, marquee select, group into zone).
 *
 * DOM hierarchy: pdf-page-content > pdf-zone > [pdf-col >] pdf-region > content
 * Zones drag within their pdf-page-content parent.
 * Regions drag within any pdf-zone/pdf-col and can cross zones.
 *
 * Phase 2 additions:
 * - Cross-column region drag
 * - Ghost column (expand grid to N+1)
 * - Column resize dividers
 * - Floating properties panel (padding + translate)
 * - flex-center zone toggle
 */

import { applyHtmlEverywhere } from './htmlSync.js';
import { applyZones } from './zoneToolbar.js';

let _active              = false;
let _selected            = new Set();
let _draggedEl           = null;
let _indicator           = null;
let _marqueeEl           = null;
let _marqueeOrigin       = null;
let _preview             = null;
let _btnSelect           = null;
let _btnGroup            = null;

// Phase 2 state
let _ghostCol      = null;
let _ghostZone     = null;
let _ghostSide     = null;
let _resizeDrag    = null;
let _propsPanel    = null;
let _propsPanelTarget = null;

// ── Public init ───────────────────────────────────────────────────────────────

export function initSelectionMode() {
    _preview   = document.getElementById('html-preview');
    _btnSelect = document.getElementById('btn-select-mode');
    _btnGroup  = document.getElementById('btn-group-selected');

    if (!_preview || !_btnSelect) return;

    _btnSelect.addEventListener('click', _toggle);
    _btnGroup?.addEventListener('click', _groupSelected);
    _createPropsPanel();
}

// ── Toggle ────────────────────────────────────────────────────────────────────

function _toggle() {
    _active = !_active;
    _preview.classList.toggle('selection-mode', _active);
    _preview.contentEditable = _active ? 'false' : 'true';
    _btnSelect.classList.toggle('active', _active);

    if (_active) {
        _attachHandles();
        _injectAllResizeDividers();
        _preview.addEventListener('mousedown', _onMarqueeStart);
        _preview.addEventListener('click',     _onSelectClick, true);
        document.addEventListener('keydown',   _onKeyDown);
    } else {
        _clearSelection();
        _removeHandles();
        _removeAllDividers();
        _removeGhostCol();
        _hidePropsPanel();
        _preview.removeEventListener('mousedown', _onMarqueeStart);
        _preview.removeEventListener('click',     _onSelectClick, true);
        document.removeEventListener('keydown',   _onKeyDown);
    }
    _updateGroupBtn();
}

// ── Drag handles ──────────────────────────────────────────────────────────────

function _attachHandles() {
    _preview.querySelectorAll('.pdf-zone, .pdf-region').forEach(_wireEl);
    _preview.querySelectorAll('.pdf-col').forEach(_wireColEl);
}

function _removeHandles() {
    _preview.querySelectorAll('.sel-drag-handle').forEach(h => h.remove());
    _preview.querySelectorAll('.pdf-zone, .pdf-region').forEach(el => {
        el.draggable = false;
        el.removeEventListener('dragstart', _onDragStart);
        el.removeEventListener('dragover',  _onDragOver);
        el.removeEventListener('drop',      _onDrop);
        el.removeEventListener('dragend',   _onDragEnd);
        el.removeEventListener('dragleave', _onDragLeave);
    });
    _preview.querySelectorAll('.pdf-col').forEach(el => {
        el.removeEventListener('dragover',  _onDragOver);
        el.removeEventListener('drop',      _onDrop);
        el.removeEventListener('dragleave', _onDragLeave);
        delete el._colWired;
    });
}

function _wireEl(el) {
    if (!el.querySelector(':scope > .sel-drag-handle')) {
        const handle = document.createElement('span');
        handle.className = 'sel-drag-handle';
        handle.textContent = '\u283F';
        handle.setAttribute('draggable', 'false');
        el.prepend(handle);
    }

    el.draggable = true;
    el.addEventListener('dragstart', _onDragStart);
    el.addEventListener('dragover',  _onDragOver);
    el.addEventListener('drop',      _onDrop);
    el.addEventListener('dragend',   _onDragEnd);
    el.addEventListener('dragleave', _onDragLeave);
}

function _wireColEl(el) {
    if (el._colWired) return;
    el._colWired = true;
    el.addEventListener('dragover',  _onDragOver);
    el.addEventListener('drop',      _onDrop);
    el.addEventListener('dragleave', _onDragLeave);
}

// ── Cross-column validation ───────────────────────────────────────────────────

function _isValidDrop(dragged, target) {
    if (dragged.classList.contains('pdf-zone') && target.classList.contains('pdf-zone')) return true;
    if (dragged.classList.contains('pdf-region') && target.classList.contains('pdf-region')) return true;
    if (dragged.classList.contains('pdf-region') && target.classList.contains('pdf-col')) return true;
    return false;
}

// ── Drag events ───────────────────────────────────────────────────────────────

function _onDragStart(e) {
    const target = e.target;
    if (!target.classList.contains('pdf-zone') && !target.classList.contains('pdf-region')) {
        e.stopPropagation();
        return;
    }
    _draggedEl = target;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    setTimeout(() => target.classList.add('sel-dragging'), 0);
}

function _onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!_draggedEl || e.currentTarget === _draggedEl) return;

    const target = e.currentTarget;
    if (!_isValidDrop(_draggedEl, target)) return;

    _removeIndicator();
    // Don't show above/below indicator for column containers — they're drop buckets, not reorderable
    if (!target.classList.contains('pdf-col')) {
        const rect = target.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        _indicator = document.createElement('div');
        _indicator.className = 'sel-drop-indicator';
        if (after) {
            target.after(_indicator);
        } else {
            target.before(_indicator);
        }
    }

    // Ghost column detection — only when not already dropping into a column
    if (_draggedEl?.classList.contains('pdf-region') && !target.classList.contains('pdf-col')) {
        const zone = target.closest('.pdf-zone');
        if (zone) {
            const r = zone.getBoundingClientRect();
            const relX = e.clientX - r.left;
            const edgeThreshold = Math.min(60, r.width * 0.15); // 15% of width, max 60px
            if (relX > r.width - edgeThreshold)      _showGhostCol(zone, 'right');
            else if (relX < edgeThreshold)            _showGhostCol(zone, 'left');
            else                                      _removeGhostCol();
        }
    } else if (target.classList.contains('pdf-col')) {
        _removeGhostCol(); // inside a column = no ghost
    }
}

function _onDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) {
        _removeIndicator();
    }
}

function _onDrop(e) {
    e.preventDefault();
    if (!_draggedEl || e.currentTarget === _draggedEl) return;

    const target = e.currentTarget;
    if (!_isValidDrop(_draggedEl, target)) return;

    if (target.classList.contains('pdf-col')) {
        const rect = target.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        if (after) {
            target.appendChild(_draggedEl);
        } else {
            target.prepend(_draggedEl);
        }
    } else {
        const rect = target.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        if (after) {
            target.after(_draggedEl);
        } else {
            target.before(_draggedEl);
        }
    }

    _removeIndicator();
    _syncState();
}

function _onDragEnd() {
    _draggedEl?.classList.remove('sel-dragging');
    _draggedEl = null;
    _removeIndicator();
    _removeGhostCol();
}

function _removeIndicator() {
    _indicator?.remove();
    _indicator = null;
}

// ── Ghost column ──────────────────────────────────────────────────────────────

function _showGhostCol(zone, side) {
    if (_ghostZone === zone && _ghostSide === side) return;
    // Read column count from class name, not child count (cols-1 has no pdf-col children)
    const colsMatch = zone.className.match(/pdf-zone--cols-(\d)/);
    const cols = colsMatch ? parseInt(colsMatch[1]) : 1;
    if (cols >= 4) return;
    _removeGhostCol();

    const ghost = document.createElement('div');
    ghost.className = 'sel-ghost-col';
    ghost.dataset.selUi = '1';
    ghost.textContent = '+ column';

    ghost.addEventListener('dragover', _onGhostDragOver);
    ghost.addEventListener('dragleave', () => ghost.classList.remove('sel-ghost-active'));
    ghost.addEventListener('drop', _onGhostDrop);

    if (side === 'right') zone.appendChild(ghost);
    else zone.prepend(ghost);

    _ghostCol = ghost;
    _ghostZone = zone;
    _ghostSide = side;
}

function _removeGhostCol() {
    _ghostCol?.remove();
    _ghostCol = null;
    _ghostZone = null;
    _ghostSide = null;
}

function _onGhostDragOver(e) {
    e.preventDefault();
    e.currentTarget.classList.add('sel-ghost-active');
}

function _onGhostDrop(e) {
    e.preventDefault();
    if (_ghostZone && _ghostSide && _draggedEl) {
        _expandZoneAndDrop(_ghostZone, _ghostSide, _draggedEl);
    }
    _removeGhostCol();
    _removeIndicator();
    _syncState();
}

function _expandZoneAndDrop(zone, side, regionEl) {
    const pageEl = zone.closest('.pdf-page-content');
    if (!pageEl) return;
    const zones = JSON.parse(pageEl.dataset.zones);
    const zoneIdx = [...pageEl.querySelectorAll('.pdf-zone')].indexOf(zone);
    if (zoneIdx === -1) return;

    const newCols = zones[zoneIdx].cols + 1;
    delete zones[zoneIdx].colWidths;
    zones[zoneIdx].cols = newCols;
    pageEl.dataset.zones = JSON.stringify(zones);

    const pageWidth = parseFloat(pageEl.dataset.pageWidth || '612');
    regionEl.dataset.rx = (side === 'right' ? parseInt(pageWidth) - 1 : 0);

    applyZones(pageEl, zones);
    _preview.querySelectorAll('.pdf-zone, .pdf-region, .pdf-col').forEach(el => {
        if (el.classList.contains('pdf-col')) _wireColEl(el);
        else _wireEl(el);
    });
    // zone reference is stale after applyZones rebuilt the DOM — find the rebuilt zone by index
    const rebuiltZone = [...pageEl.querySelectorAll('.pdf-zone')][zoneIdx];
    if (rebuiltZone) _injectResizeDividers(rebuiltZone);
}

// ── Column resize dividers ────────────────────────────────────────────────────

function _injectResizeDividers(zoneEl) {
    const cols = [...zoneEl.querySelectorAll(':scope > .pdf-col:not([data-sel-ui])')];
    if (cols.length < 2) return;

    for (let i = 0; i < cols.length - 1; i++) {
        const left = cols[i].offsetLeft + cols[i].offsetWidth;
        const div = document.createElement('div');
        div.className = 'sel-col-divider';
        div.dataset.selUi = '1';
        div.dataset.colIdx = i;
        div.style.left = left + 'px';
        div.addEventListener('mousedown', _onDividerMouseDown);
        zoneEl.appendChild(div);
    }
}

function _injectAllResizeDividers() {
    _preview.querySelectorAll('.pdf-zone').forEach(zone => {
        const cols = [...zone.querySelectorAll(':scope > .pdf-col:not([data-sel-ui])')];
        if (cols.length > 1 && !zone.classList.contains('pdf-zone--flex-center')) {
            _injectResizeDividers(zone);
        }
    });
}

function _removeAllDividers() {
    _preview.querySelectorAll('.sel-col-divider').forEach(d => d.remove());
}

function _onDividerMouseDown(e) {
    e.preventDefault();
    const dividerEl = e.currentTarget;
    const zoneEl = dividerEl.closest('.pdf-zone');
    if (!zoneEl) return;

    const compStyle = getComputedStyle(zoneEl);
    const widths = compStyle.gridTemplateColumns.split(' ').map(w => parseFloat(w));
    const colIdx = parseInt(dividerEl.dataset.colIdx, 10);

    _resizeDrag = { dividerEl, zoneEl, startX: e.clientX, startWidths: widths, colIdx };
    dividerEl.classList.add('sel-col-divider--dragging');

    document.addEventListener('mousemove', _onDividerMouseMove);
    document.addEventListener('mouseup', _onDividerMouseUp);
}

function _onDividerMouseMove(e) {
    if (!_resizeDrag) return;
    const { dividerEl, zoneEl, startX, startWidths, colIdx } = _resizeDrag;
    const delta = e.clientX - startX;
    const newWidths = [...startWidths];
    newWidths[colIdx] = Math.max(40, startWidths[colIdx] + delta);
    newWidths[colIdx + 1] = Math.max(40, startWidths[colIdx + 1] - delta);

    zoneEl.style.gridTemplateColumns = newWidths.map(w => w + 'px').join(' ');

    const cumulative = newWidths.slice(0, colIdx + 1).reduce((a, b) => a + b, 0);
    dividerEl.style.left = cumulative + 'px';
}

function _onDividerMouseUp() {
    document.removeEventListener('mousemove', _onDividerMouseMove);
    document.removeEventListener('mouseup', _onDividerMouseUp);
    if (!_resizeDrag) return;

    const { dividerEl, zoneEl } = _resizeDrag;
    dividerEl.classList.remove('sel-col-divider--dragging');
    const finalWidths = getComputedStyle(zoneEl).gridTemplateColumns.split(' ').map(w => parseFloat(w));

    // Null before _saveColWidths so _syncState inside it doesn't read stale state
    _resizeDrag = null;
    _saveColWidths(zoneEl, finalWidths);
}

function _saveColWidths(zoneEl, widths) {
    const pageEl = zoneEl.closest('.pdf-page-content');
    if (!pageEl) return;
    const zones = JSON.parse(pageEl.dataset.zones);
    const zoneIdx = [...pageEl.querySelectorAll('.pdf-zone')].indexOf(zoneEl);
    if (zoneIdx === -1) return;
    zones[zoneIdx].colWidths = widths.map(w => w + 'px');
    pageEl.dataset.zones = JSON.stringify(zones);
    _syncState();
}

// ── Floating properties panel ─────────────────────────────────────────────────

function _createPropsPanel() {
    if (_propsPanel) return;
    const panel = document.createElement('div');
    panel.className = 'sel-props-panel';
    panel.id = 'sel-props-panel';
    panel.hidden = true;
    panel.innerHTML = `
        <div class="sel-props-row">
            <span class="sel-props-label">Padding</span>
            <input class="sel-props-input" id="spp-pad" type="number" min="0" max="80" step="1">
            <span>px all sides</span>
        </div>
        <div class="sel-props-row">
            <span class="sel-props-label">Translate X</span>
            <input class="sel-props-input" id="spp-tx" type="number" step="1">
            <span>px</span>
        </div>
        <div class="sel-props-row">
            <span class="sel-props-label">Translate Y</span>
            <input class="sel-props-input" id="spp-ty" type="number" step="1">
            <span>px</span>
        </div>
    `;
    document.body.appendChild(panel);
    _propsPanel = panel;

    panel.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('input', _onPropsPanelInput);
    });
}

function _showPropsPanel(regionEl) {
    if (!_propsPanel) return;
    _propsPanelTarget = regionEl;

    const pad = regionEl.style.padding || '';
    _propsPanel.querySelector('#spp-pad').value = parseInt(pad, 10) || 0;

    let tx = 0, ty = 0;
    const t = regionEl.style.transform || '';
    const m = t.match(/translate\(([^,]+)px,\s*([^)]+)px\)/);
    if (m) { tx = parseFloat(m[1]) || 0; ty = parseFloat(m[2]) || 0; }
    _propsPanel.querySelector('#spp-tx').value = tx;
    _propsPanel.querySelector('#spp-ty').value = ty;

    const panelHeight = _propsPanel.offsetHeight || 120;
    const r = regionEl.getBoundingClientRect();
    let top = r.top - panelHeight - 8;
    if (top < 8) top = r.bottom + 8;
    const left = Math.min(r.left, window.innerWidth - 210);

    _propsPanel.style.top = top + 'px';
    _propsPanel.style.left = left + 'px';
    _propsPanel.hidden = false;
}

function _hidePropsPanel() {
    if (_propsPanel) _propsPanel.hidden = true;
    _propsPanelTarget = null;
}

function _onPropsPanelInput() {
    if (!_propsPanelTarget) return;
    const pad = _propsPanel.querySelector('#spp-pad').value;
    const tx = _propsPanel.querySelector('#spp-tx').value;
    const ty = _propsPanel.querySelector('#spp-ty').value;

    _propsPanelTarget.style.padding = pad ? pad + 'px' : '';
    _propsPanelTarget.style.transform = (tx || ty) ? 'translate(' + (tx || 0) + 'px,' + (ty || 0) + 'px)' : '';
}

function _onKeyDown(e) {
    if (!_active || !_propsPanelTarget) return;
    if (e.target.tagName === 'INPUT') return;

    const step = e.shiftKey ? 1 : 4;
    let tx = parseFloat(_propsPanel.querySelector('#spp-tx').value) || 0;
    let ty = parseFloat(_propsPanel.querySelector('#spp-ty').value) || 0;

    switch (e.key) {
        case 'ArrowLeft':  tx -= step; e.preventDefault(); break;
        case 'ArrowRight': tx += step; e.preventDefault(); break;
        case 'ArrowUp':    ty -= step; e.preventDefault(); break;
        case 'ArrowDown':  ty += step; e.preventDefault(); break;
        default: return;
    }

    _propsPanelTarget.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';
    _propsPanel.querySelector('#spp-tx').value = tx;
    _propsPanel.querySelector('#spp-ty').value = ty;
}

// ── Click selection ───────────────────────────────────────────────────────────

function _onSelectClick(e) {
    const el = e.target.closest('.pdf-region, .pdf-zone');
    if (!el) {
        _clearSelection();
        return;
    }
    e.stopPropagation();

    if (e.ctrlKey || e.metaKey) {
        if (_selected.has(el)) {
            _selected.delete(el);
            el.classList.remove('sel-selected');
        } else {
            _selected.add(el);
            el.classList.add('sel-selected');
        }
    } else {
        _clearSelection();
        _selected.add(el);
        el.classList.add('sel-selected');
    }

    if (_selected.size === 1 && el.classList.contains('pdf-region')) {
        _showPropsPanel(el);
    } else {
        _hidePropsPanel();
    }
    _updateGroupBtn();
}

function _clearSelection() {
    _selected.forEach(el => el.classList.remove('sel-selected'));
    _selected.clear();
    _hidePropsPanel();
    _updateGroupBtn();
}

// ── Marquee select ────────────────────────────────────────────────────────────

function _onMarqueeStart(e) {
    if (e.target.closest('.pdf-region, .pdf-zone, .sel-drag-handle')) return;
    if (e.button !== 0) return;

    const previewRect = _preview.getBoundingClientRect();
    _marqueeOrigin = {
        x: e.clientX - previewRect.left + _preview.scrollLeft,
        y: e.clientY - previewRect.top  + _preview.scrollTop,
    };

    _marqueeEl = document.createElement('div');
    _marqueeEl.className = 'sel-marquee';
    _preview.appendChild(_marqueeEl);

    document.addEventListener('mousemove', _onMarqueeMove);
    document.addEventListener('mouseup',   _onMarqueeEnd);
}

function _onMarqueeMove(e) {
    if (!_marqueeEl || !_marqueeOrigin) return;
    const previewRect = _preview.getBoundingClientRect();
    const cx = e.clientX - previewRect.left + _preview.scrollLeft;
    const cy = e.clientY - previewRect.top  + _preview.scrollTop;

    const x = Math.min(cx, _marqueeOrigin.x);
    const y = Math.min(cy, _marqueeOrigin.y);
    const w = Math.abs(cx - _marqueeOrigin.x);
    const h = Math.abs(cy - _marqueeOrigin.y);

    Object.assign(_marqueeEl.style, {
        left: x + 'px', top: y + 'px',
        width: w + 'px', height: h + 'px',
    });
}

function _onMarqueeEnd(e) {
    document.removeEventListener('mousemove', _onMarqueeMove);
    document.removeEventListener('mouseup',   _onMarqueeEnd);
    if (!_marqueeEl || !_marqueeOrigin) return;

    const marqueeRect = _marqueeEl.getBoundingClientRect();
    _marqueeEl.remove();
    _marqueeEl = null;
    _marqueeOrigin = null;

    if (!e.ctrlKey && !e.metaKey) _clearSelection();

    _preview.querySelectorAll('.pdf-region').forEach(el => {
        const r = el.getBoundingClientRect();
        const overlaps = !(r.right  < marqueeRect.left  ||
                           r.left   > marqueeRect.right ||
                           r.bottom < marqueeRect.top   ||
                           r.top    > marqueeRect.bottom);
        if (overlaps) {
            _selected.add(el);
            el.classList.add('sel-selected');
        }
    });
    _updateGroupBtn();
}

// ── Group selected into a new zone ────────────────────────────────────────────

function _groupSelected() {
    if (_selected.size < 2) return;

    const regions = [..._selected].filter(el => el.classList.contains('pdf-region'));
    if (regions.length < 2) return;

    const firstParentZone = regions[0].closest('.pdf-zone') || regions[0].parentElement;
    const newZone = document.createElement('div');
    newZone.className = 'pdf-zone pdf-zone--cols-1';

    const handle = document.createElement('span');
    handle.className = 'sel-drag-handle';
    handle.textContent = '\u283F';
    handle.setAttribute('draggable', 'false');
    newZone.appendChild(handle);

    regions.forEach(r => newZone.appendChild(r));
    firstParentZone.before(newZone);

    _wireEl(newZone);

    _clearSelection();
    _syncState();
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _updateGroupBtn() {
    if (!_btnGroup) return;
    const regions = [..._selected].filter(el => el.classList.contains('pdf-region'));
    _btnGroup.style.display = (_active && regions.length >= 2) ? '' : 'none';
}

function _syncState() {
    _removeGhostCol();
    _removeAllDividers();
    _hidePropsPanel();
    _preview.querySelectorAll('.sel-drag-handle').forEach(h => h.remove());
    applyHtmlEverywhere(_preview.innerHTML, _preview);
    if (_active) {
        _attachHandles();
        _injectAllResizeDividers();
    }
}

// ── Exports ───────────────────────────────────────────────────────────────────

export function toggleFlexCenter(zoneEl) {
    const pageEl = zoneEl.closest('.pdf-page-content');
    if (!pageEl) return;
    const zones = JSON.parse(pageEl.dataset.zones);
    const zoneIdx = [...pageEl.querySelectorAll('.pdf-zone')].indexOf(zoneEl);
    if (zoneIdx === -1) return;

    const zone = zones[zoneIdx];
    if (zone.type === 'flex-center') {
        delete zone.type;
        zone.cols = 1;
    } else {
        zone.type = 'flex-center';
        zone.cols = 1;
        delete zone.colWidths;
    }
    zones[zoneIdx] = zone;
    pageEl.dataset.zones = JSON.stringify(zones);

    applyZones(pageEl, zones);
    _preview.querySelectorAll('.pdf-zone, .pdf-region, .pdf-col').forEach(el => {
        if (el.classList.contains('pdf-col')) _wireColEl(el);
        else _wireEl(el);
    });
    _syncState();
}

export function isSelectionModeActive() {
    return _active;
}
