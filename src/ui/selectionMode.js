/**
 * selectionMode.js
 * Enhanced Selection & Spatial Manipulation Engine for Doc View
 *
 * DOM hierarchy: pdf-page-content > [pdf-page-row >] pdf-zone > [pdf-col >] pdf-region > content
 *
 * Features:
 * - Free marquee rectangle selection + Shift/Cmd multi-selection
 * - Batch deletion (Delete / Backspace) with empty container cleanup
 * - Directional 4-way drag & drop (Up/Down reorder, Left/Right multi-column/row creation)
 * - Cross-zone region transfers & zone unwrapping onto page canvas
 * - Interactive ghost drop indicators & column resize dividers
 * - Floating properties panel (Padding, Translate X/Y)
 */

import { markHtmlDirty } from './htmlSync.js';
import { applyZones } from './zoneToolbar.js';
import { pushSnapshot, syncUndoRedoUI } from './historyController.js';
import { state } from '../state.js';

let _active              = false;
let _selected            = new Set();
let _draggedEl           = null;
let _indicator           = null;
let _marqueeEl           = null;
let _marqueeOrigin       = null;
let _preview             = null;
let _btnSelect           = null;
let _btnGroup            = null;

// Directional & Ghost drag state
let _ghostCol         = null;
let _ghostZone        = null;
let _ghostSide        = null;
let _resizeDrag       = null;
let _propsPanel       = null;
let _propsPanelTarget = null;
let _quadrantTarget   = null;
let _currentDropTarget = null;
let _currentDropPosition = null; // 'before' | 'after' | 'left' | 'right' | 'inside' | 'unwrap'

// ── Helpers ───────────────────────────────────────────────────────────────────

function _resolvePreview() {
    return document.getElementById('html-preview');
}

// ── Public Init ───────────────────────────────────────────────────────────────

export function initSelectionMode() {
    _preview   = document.getElementById('html-preview');
    _btnSelect = document.getElementById('btn-select-mode');
    _btnGroup  = document.getElementById('btn-group-selected');

    if (!_preview || !_btnSelect) return;

    _btnSelect.addEventListener('click', _toggle);
    _btnGroup?.addEventListener('click', _groupSelected);
    _createPropsPanel();
}

// ── Toggle Mode ───────────────────────────────────────────────────────────────

function _toggle() {
    _preview = _resolvePreview();
    _active = !_active;
    _preview.classList.toggle('selection-mode', _active);
    _preview.contentEditable = _active ? 'false' : 'true';
    _btnSelect.classList.toggle('active', _active);

    if (_active) {
        _attachHandles();
        _injectAllResizeDividers();
        _preview.addEventListener('pointerdown', _onMarqueeStart);
        _preview.addEventListener('click',     _onSelectClick, true);
        document.addEventListener('keydown',   _onKeyDown);
    } else {
        _clearSelection();
        _removeHandles();
        _removeAllDividers();
        _removeGhostCol();
        _hidePropsPanel();
        _removeIndicator();
        _preview.removeEventListener('pointerdown', _onMarqueeStart);
        _preview.removeEventListener('click',     _onSelectClick, true);
        document.removeEventListener('keydown',   _onKeyDown);
    }
    _updateGroupBtn();
}

// ── Drag Handles & Element Wiring ─────────────────────────────────────────────

function _attachHandles() {
    if (!_preview) return;
    _preview.querySelectorAll('.pdf-zone, .pdf-region').forEach(_wireEl);
    _preview.querySelectorAll('.pdf-col, .pdf-page-row, .pdf-page-content').forEach(_wireDropContainer);
}

function _removeHandles() {
    if (!_preview) return;
    _preview.querySelectorAll('.sel-drag-handle').forEach(h => h.remove());
    _preview.querySelectorAll('.pdf-zone, .pdf-region').forEach(el => {
        el.draggable = false;
        el.removeEventListener('dragstart', _onDragStart);
        el.removeEventListener('dragover',  _onDragOver);
        el.removeEventListener('drop',      _onDrop);
        el.removeEventListener('dragend',   _onDragEnd);
        el.removeEventListener('dragleave', _onDragLeave);
        delete el._dragWired;
    });
    _preview.querySelectorAll('.pdf-col, .pdf-page-row, .pdf-page-content').forEach(el => {
        el.removeEventListener('dragover',  _onDragOver);
        el.removeEventListener('drop',      _onDrop);
        el.removeEventListener('dragleave', _onDragLeave);
        delete el._containerWired;
    });
}

function _wireEl(el) {
    if (el._dragWired) return;
    el._dragWired = true;

    if (!el.querySelector(':scope > .sel-drag-handle')) {
        const handle = document.createElement('span');
        handle.className = 'sel-drag-handle';
        handle.textContent = '\u283F';
        handle.setAttribute('draggable', 'false');
        handle.title = 'Drag to reorder or rearrange';
        el.prepend(handle);
    }

    el.draggable = true;
    el.addEventListener('dragstart', _onDragStart);
    el.addEventListener('dragover',  _onDragOver);
    el.addEventListener('drop',      _onDrop);
    el.addEventListener('dragend',   _onDragEnd);
    el.addEventListener('dragleave', _onDragLeave);
}

function _wireDropContainer(el) {
    if (el._containerWired) return;
    el._containerWired = true;
    el.addEventListener('dragover',  _onDragOver);
    el.addEventListener('drop',      _onDrop);
    el.addEventListener('dragleave', _onDragLeave);
}

// ── Drag & Drop Engine ────────────────────────────────────────────────────────

function _isValidDrop(dragged, target) {
    if (!dragged || !target) return false;
    if (dragged === target || dragged.contains(target)) return false;

    // Regions can drop on regions, zones, columns, or the page content
    if (dragged.classList.contains('pdf-region')) {
        return target.classList.contains('pdf-region') ||
               target.classList.contains('pdf-zone') ||
               target.classList.contains('pdf-col') ||
               target.classList.contains('pdf-page-content') ||
               target.classList.contains('pdf-page-row');
    }

    // Zones can drop on zones, page rows, or the page content
    if (dragged.classList.contains('pdf-zone')) {
        return target.classList.contains('pdf-zone') ||
               target.classList.contains('pdf-page-row') ||
               target.classList.contains('pdf-page-content');
    }

    return false;
}

function _onDragStart(e) {
    const target = e.target.closest('.pdf-region, .pdf-zone');
    if (!target) {
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
    if (!_draggedEl) return;

    let target = e.target.closest('.pdf-region, .pdf-zone, .pdf-col, .pdf-page-row, .pdf-page-content');
    if (!target || target === _draggedEl || _draggedEl.contains(target)) return;
    if (!_isValidDrop(_draggedEl, target)) return;

    _removeIndicator();

    const rect = target.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
    const relY = (e.clientY - rect.top)  / Math.max(1, rect.height);

    _currentDropTarget = target;

    // 1. Region dragged over another Region
    if (_draggedEl.classList.contains('pdf-region') && target.classList.contains('pdf-region')) {
        const zone = target.closest('.pdf-zone');
        const inMultiCol = zone && !zone.classList.contains('pdf-zone--cols-1')
                                && !zone.classList.contains('pdf-zone--flex-center');

        // Left/Right edge (25%) -> create multi-column layout
        if (!inMultiCol && (relX < 0.25 || relX > 0.75)) {
            const onLeft = relX < 0.25;
            _currentDropPosition = onLeft ? 'left' : 'right';
            _setQuadrantHighlight(target, onLeft);
            _indicator = document.createElement('div');
            _indicator.className = 'sel-drop-indicator sel-drop-indicator--col';
            _indicator.textContent = onLeft ? '← new column' : 'new column →';
            if (onLeft) target.before(_indicator);
            else target.after(_indicator);
            return;
        }

        // Top/Bottom (50%) -> reorder before / after
        _clearQuadrantHighlight();
        const after = relY >= 0.5;
        _currentDropPosition = after ? 'after' : 'before';
        _indicator = document.createElement('div');
        _indicator.className = 'sel-drop-indicator';
        _indicator.textContent = after ? '↓ move region after' : '↑ move region before';
        if (after) target.after(_indicator);
        else target.before(_indicator);
        return;
    }

    // 2. Region dragged over a Zone
    if (_draggedEl.classList.contains('pdf-region') && target.classList.contains('pdf-zone')) {
        _clearQuadrantHighlight();
        if (relY < 0.15) {
            _currentDropPosition = 'before';
            _indicator = document.createElement('div');
            _indicator.className = 'sel-drop-indicator';
            _indicator.textContent = '↑ unwrap region before zone';
            target.before(_indicator);
        } else if (relY > 0.85) {
            _currentDropPosition = 'after';
            _indicator = document.createElement('div');
            _indicator.className = 'sel-drop-indicator';
            _indicator.textContent = '↓ unwrap region after zone';
            target.after(_indicator);
        } else if (relX < 0.18) {
            _currentDropPosition = 'left';
            _showGhostCol(target, 'left');
        } else if (relX > 0.82) {
            _currentDropPosition = 'right';
            _showGhostCol(target, 'right');
        } else {
            _currentDropPosition = 'inside';
            _removeGhostCol();
            target.classList.add('sel-zone-drop-inside');
        }
        return;
    }

    // 3. Region dragged over a Column container
    if (_draggedEl.classList.contains('pdf-region') && target.classList.contains('pdf-col')) {
        _clearQuadrantHighlight();
        const after = relY >= 0.5;
        _currentDropPosition = after ? 'after' : 'before';
        _indicator = document.createElement('div');
        _indicator.className = 'sel-drop-indicator';
        _indicator.textContent = after ? '↓ insert at bottom of column' : '↑ insert at top of column';
        if (after) target.appendChild(_indicator);
        else target.prepend(_indicator);
        return;
    }

    // 4. Zone dragged over another Zone
    if (_draggedEl.classList.contains('pdf-zone') && target.classList.contains('pdf-zone')) {
        _clearQuadrantHighlight();
        // Left/Right side (25%) -> group zones side-by-side into a row
        if (relX < 0.25 || relX > 0.75) {
            const onLeft = relX < 0.25;
            _currentDropPosition = onLeft ? 'left' : 'right';
            _indicator = document.createElement('div');
            _indicator.className = 'sel-drop-indicator sel-drop-indicator--row';
            _indicator.textContent = onLeft ? '← place zone side-by-side' : 'place zone side-by-side →';
            if (onLeft) target.before(_indicator);
            else target.after(_indicator);
            return;
        }

        // Top/Bottom -> reorder zones
        const after = relY >= 0.5;
        _currentDropPosition = after ? 'after' : 'before';
        _indicator = document.createElement('div');
        _indicator.className = 'sel-drop-indicator';
        _indicator.textContent = after ? '↓ move zone below' : '↑ move zone above';
        if (after) target.after(_indicator);
        else target.before(_indicator);
        return;
    }

    // 5. Dragged over Page Content directly -> unwrap or append
    if (target.classList.contains('pdf-page-content')) {
        _clearQuadrantHighlight();
        _currentDropPosition = 'unwrap';
        _indicator = document.createElement('div');
        _indicator.className = 'sel-drop-indicator';
        _indicator.textContent = '+ drop here as new zone';
        target.appendChild(_indicator);
    }
}

function _onDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) {
        _removeIndicator();
    }
}

function _onDrop(e) {
    e.preventDefault();
    if (!_draggedEl || !_currentDropTarget || _currentDropTarget === _draggedEl) {
        _onDragEnd();
        return;
    }

    pushSnapshot();

    const target = _currentDropTarget;
    const position = _currentDropPosition;

    // ── Position-based Execution ──

    // A. Unwrap region into a new standalone zone on the page
    if (position === 'unwrap' || (target.classList.contains('pdf-page-content') && _draggedEl.classList.contains('pdf-region'))) {
        const newZone = document.createElement('div');
        newZone.className = 'pdf-zone pdf-zone--cols-1';
        target.appendChild(newZone);
        newZone.appendChild(_draggedEl);
    }
    // B. Region-on-region left/right column creation
    else if (_draggedEl.classList.contains('pdf-region') && target.classList.contains('pdf-region') && (position === 'left' || position === 'right')) {
        _wrapRegionsInGrid(_draggedEl, target, position);
    }
    // C. Zone-on-zone left/right row creation (side-by-side zones)
    else if (_draggedEl.classList.contains('pdf-zone') && target.classList.contains('pdf-zone') && (position === 'left' || position === 'right')) {
        _groupZonesInRow(_draggedEl, target, position);
    }
    // D. Drop into column container
    else if (target.classList.contains('pdf-col')) {
        if (position === 'before') target.prepend(_draggedEl);
        else target.appendChild(_draggedEl);
    }
    // E. Drop inside zone directly
    else if (position === 'inside') {
        if (target.classList.contains('pdf-zone')) {
            const firstCol = target.querySelector(':scope > .pdf-col');
            if (firstCol) firstCol.appendChild(_draggedEl);
            else target.appendChild(_draggedEl);
        }
    }
    // F. Normal Before / After insertion
    else if (position === 'before') {
        // If region dropped before a zone, unwrap into its own zone before target zone
        if (_draggedEl.classList.contains('pdf-region') && target.classList.contains('pdf-zone')) {
            const newZone = document.createElement('div');
            newZone.className = 'pdf-zone pdf-zone--cols-1';
            target.before(newZone);
            newZone.appendChild(_draggedEl);
        } else {
            target.before(_draggedEl);
        }
    }
    else if (position === 'after') {
        // If region dropped after a zone, unwrap into its own zone after target zone
        if (_draggedEl.classList.contains('pdf-region') && target.classList.contains('pdf-zone')) {
            const newZone = document.createElement('div');
            newZone.className = 'pdf-zone pdf-zone--cols-1';
            target.after(newZone);
            newZone.appendChild(_draggedEl);
        } else {
            target.after(_draggedEl);
        }
    }

    _normalizeDom();
    _syncState();
    syncUndoRedoUI();
    _onDragEnd();
}

function _onDragEnd() {
    _draggedEl?.classList.remove('sel-dragging');
    _draggedEl = null;
    _currentDropTarget = null;
    _currentDropPosition = null;
    _removeIndicator();
    _clearQuadrantHighlight();
    _removeGhostCol();
    _preview?.querySelectorAll('.sel-zone-drop-inside').forEach(el => el.classList.remove('sel-zone-drop-inside'));
}

function _removeIndicator() {
    _indicator?.remove();
    _indicator = null;
    _preview?.querySelectorAll('.sel-zone-drop-inside').forEach(el => el.classList.remove('sel-zone-drop-inside'));
}

function _setQuadrantHighlight(target, onLeft) {
    if (_quadrantTarget && _quadrantTarget !== target) _clearQuadrantHighlight();
    _quadrantTarget = target;
    target.classList.remove('sel-drop-left', 'sel-drop-right');
    target.classList.add(onLeft ? 'sel-drop-left' : 'sel-drop-right');
}

function _clearQuadrantHighlight() {
    if (_quadrantTarget) {
        _quadrantTarget.classList.remove('sel-drop-left', 'sel-drop-right');
        _quadrantTarget = null;
    }
}

// ── Ghost Column ──────────────────────────────────────────────────────────────

function _showGhostCol(zone, side) {
    if (_ghostZone === zone && _ghostSide === side) return;
    const colsMatch = zone.className.match(/pdf-zone--cols-(\d)/);
    const cols = colsMatch ? parseInt(colsMatch[1], 10) : 1;
    if (cols >= 4) return;
    _removeGhostCol();

    const ghost = document.createElement('div');
    ghost.className = 'sel-ghost-col';
    ghost.dataset.selUi = '1';
    ghost.textContent = '+ new column';

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
        pushSnapshot();
        _expandZoneAndDrop(_ghostZone, _ghostSide, _draggedEl);
    }
    _removeGhostCol();
    _removeIndicator();
    _normalizeDom();
    _syncState();
    syncUndoRedoUI();
}

function _expandZoneAndDrop(zone, side, regionEl) {
    const pageEl = zone.closest('.pdf-page-content');
    if (!pageEl) return;
    const zones = JSON.parse(pageEl.dataset.zones || '[]');
    const zoneIdx = [...pageEl.querySelectorAll('.pdf-zone')].indexOf(zone);
    if (zoneIdx === -1) return;

    const newCols = Math.min(4, (zones[zoneIdx]?.cols || 1) + 1);
    delete zones[zoneIdx].colWidths;
    zones[zoneIdx].cols = newCols;
    pageEl.dataset.zones = JSON.stringify(zones);

    const pageWidth = parseFloat(pageEl.dataset.pageWidth || '612');
    regionEl.dataset.rx = (side === 'right' ? parseInt(pageWidth, 10) - 1 : 0);

    applyZones(pageEl, zones);
    _attachHandles();
}

// ── Multi-Column & Row Grouping Helpers ────────────────────────────────────────

function _wrapRegionsInGrid(dragged, target, side) {
    const bookmark = document.createElement('div');
    bookmark.dataset.selUi = '1';
    target.before(bookmark);

    const [leftRegion, rightRegion] = side === 'left' ? [dragged, target] : [target, dragged];

    const newZone = document.createElement('div');
    newZone.className = 'pdf-zone pdf-zone--cols-2';

    const handle = document.createElement('span');
    handle.className = 'sel-drag-handle';
    handle.textContent = '\u283F';
    handle.setAttribute('draggable', 'false');
    newZone.appendChild(handle);

    ['left', 'right'].forEach((name, i) => {
        const col = document.createElement('div');
        col.className = `pdf-col pdf-col--${name}`;
        col.appendChild(i === 0 ? leftRegion : rightRegion);
        newZone.appendChild(col);
    });

    bookmark.replaceWith(newZone);
    _wireEl(newZone);
    newZone.querySelectorAll('.pdf-col').forEach(_wireDropContainer);
    _injectResizeDividers(newZone);
}

function _groupZonesInRow(dragged, target, side) {
    let parentRow = target.closest('.pdf-page-row');
    const [leftZone, rightZone] = side === 'left' ? [dragged, target] : [target, dragged];

    if (!parentRow) {
        parentRow = document.createElement('div');
        parentRow.className = 'pdf-page-row pdf-page-row--cols-2';
        target.before(parentRow);
        parentRow.appendChild(leftZone);
        parentRow.appendChild(rightZone);
    } else {
        if (side === 'left') target.before(dragged);
        else target.after(dragged);
        const count = parentRow.querySelectorAll(':scope > .pdf-zone').length;
        parentRow.className = `pdf-page-row pdf-page-row--cols-${Math.min(4, count)}`;
    }
}

// ── Column Resize Dividers ────────────────────────────────────────────────────

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
        div.addEventListener('pointerdown', _onDividerPointerDown);
        zoneEl.appendChild(div);
    }
}

function _injectAllResizeDividers() {
    if (!_preview) return;
    _preview.querySelectorAll('.pdf-zone').forEach(zone => {
        const cols = [...zone.querySelectorAll(':scope > .pdf-col:not([data-sel-ui])')];
        if (cols.length > 1 && !zone.classList.contains('pdf-zone--flex-center')) {
            _injectResizeDividers(zone);
        }
    });
}

function _removeAllDividers() {
    if (!_preview) return;
    _preview.querySelectorAll('.sel-col-divider').forEach(d => d.remove());
}

function _onDividerPointerDown(e) {
    if (e.button !== 0 || e.isPrimary === false) return;
    e.preventDefault();
    const dividerEl = e.currentTarget;
    const zoneEl = dividerEl.closest('.pdf-zone');
    if (!zoneEl) return;

    const compStyle = getComputedStyle(zoneEl);
    const widths = compStyle.gridTemplateColumns.split(' ').map(w => parseFloat(w));
    const colIdx = parseInt(dividerEl.dataset.colIdx, 10);

    _resizeDrag = { dividerEl, zoneEl, startX: e.clientX, startWidths: widths, colIdx };
    dividerEl.classList.add('sel-col-divider--dragging');

    document.addEventListener('pointermove', _onDividerPointerMove);
    document.addEventListener('pointerup',   _onDividerPointerUp);
    document.addEventListener('pointercancel', _onDividerPointerUp);
}

function _onDividerPointerMove(e) {
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

function _onDividerPointerUp() {
    document.removeEventListener('pointermove', _onDividerPointerMove);
    document.removeEventListener('pointerup',   _onDividerPointerUp);
    document.removeEventListener('pointercancel', _onDividerPointerUp);
    if (!_resizeDrag) return;

    const { dividerEl, zoneEl } = _resizeDrag;
    dividerEl.classList.remove('sel-col-divider--dragging');
    const finalWidths = getComputedStyle(zoneEl).gridTemplateColumns.split(' ').map(w => parseFloat(w));

    _resizeDrag = null;
    _saveColWidths(zoneEl, finalWidths);
}

function _saveColWidths(zoneEl, widths) {
    const pageEl = zoneEl.closest('.pdf-page-content');
    if (!pageEl) return;
    const zones = JSON.parse(pageEl.dataset.zones || '[]');
    const zoneIdx = [...pageEl.querySelectorAll('.pdf-zone')].indexOf(zoneEl);
    if (zoneIdx === -1 || !zones[zoneIdx]) return;
    zones[zoneIdx].colWidths = widths.map(w => w + 'px');
    pageEl.dataset.zones = JSON.stringify(zones);
    _syncState();
}

// ── DOM Normalization ─────────────────────────────────────────────────────────

function _normalizeDom() {
    if (!_preview) return;

    // 1. Remove truly empty zones (no meaningful children, images, tables, or text)
    _preview.querySelectorAll('.pdf-zone').forEach(zone => {
        const meaningfulChildren = [...zone.children].filter(c => !c.classList.contains('sel-drag-handle') && !c.dataset.selUi);
        if (meaningfulChildren.length === 0 && zone.textContent.trim() === '' && !zone.querySelector('img, svg, table')) {
            zone.remove();
        }
    });

    // 2. Remove truly empty columns
    _preview.querySelectorAll('.pdf-col').forEach(col => {
        const meaningfulChildren = [...col.children].filter(c => !c.classList.contains('sel-drag-handle') && !c.dataset.selUi);
        if (meaningfulChildren.length === 0 && col.textContent.trim() === '' && !col.querySelector('img, svg, table')) {
            col.remove();
        }
    });

    // 3. Remove truly empty rows
    _preview.querySelectorAll('.pdf-page-row').forEach(row => {
        const meaningfulChildren = [...row.children].filter(c => !c.classList.contains('sel-drag-handle') && !c.dataset.selUi);
        if (meaningfulChildren.length === 0 && row.textContent.trim() === '' && !row.querySelector('img, svg, table')) {
            row.remove();
        }
    });
}

// ── Floating Properties Panel ─────────────────────────────────────────────────

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
    markHtmlDirty();
}

// ── Keyboard Actions (Delete / Backspace / Arrow Keys) ─────────────────────────

function _onKeyDown(e) {
    if (!_active) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    // 1. Delete / Backspace: Remove selected elements
    if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        _deleteSelection();
        return;
    }

    // 2. Escape: Deselect all
    if (e.key === 'Escape') {
        _clearSelection();
        return;
    }

    // 3. Arrow Keys: Nudge translate offset of target element
    if (_propsPanelTarget) {
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
        markHtmlDirty();
    }
}

function _deleteSelection() {
    const targets = _selected.size > 0 ? [..._selected] : (_propsPanelTarget ? [_propsPanelTarget] : []);
    if (!targets.length) return;

    pushSnapshot();

    targets.forEach(el => {
        el.classList.remove('sel-selected');
        el.remove();
    });

    _selected.clear();
    _hidePropsPanel();
    _normalizeDom();
    _syncState();
    syncUndoRedoUI();
}

// ── Click Selection & Multi-Select ────────────────────────────────────────────

function _onSelectClick(e) {
    if (e.target.closest('.sel-drag-handle, .sel-props-panel, .sel-col-divider')) return;

    const el = e.target.closest('.pdf-region, .pdf-zone');
    if (!el) {
        _clearSelection();
        return;
    }
    e.stopPropagation();

    // Multi-select toggle (Shift or Ctrl/Cmd)
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
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

// ── Marquee Select ────────────────────────────────────────────────────────────

function _onMarqueeStart(e) {
    if (e.button !== 0 || e.isPrimary === false) return;
    if (e.target.closest('.sel-drag-handle, .sel-props-panel, .sel-col-divider, input, button')) return;

    const onSelectable = e.target.closest('.pdf-region, .pdf-zone');
    // Start marquee if shift key is held OR if clicking on background
    if (onSelectable && !e.shiftKey) return;

    e.preventDefault();

    const previewRect = _preview.getBoundingClientRect();
    _marqueeOrigin = {
        x: e.clientX - previewRect.left + _preview.scrollLeft,
        y: e.clientY - previewRect.top  + _preview.scrollTop,
        clientX: e.clientX,
        clientY: e.clientY,
    };

    _marqueeEl = document.createElement('div');
    _marqueeEl.className = 'sel-marquee';
    _preview.appendChild(_marqueeEl);

    document.addEventListener('pointermove', _onMarqueeMove);
    document.addEventListener('pointerup',   _onMarqueeEnd);
    document.addEventListener('pointercancel', _onMarqueeEnd);
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
    document.removeEventListener('pointermove', _onMarqueeMove);
    document.removeEventListener('pointerup',   _onMarqueeEnd);
    document.removeEventListener('pointercancel', _onMarqueeEnd);
    if (!_marqueeEl || !_marqueeOrigin) return;

    const marqueeRect = _marqueeEl.getBoundingClientRect();
    _marqueeEl.remove();
    _marqueeEl = null;

    // If movement was negligible (< 4px), don't treat as marquee drag
    if (Math.abs(e.clientX - _marqueeOrigin.clientX) < 4 && Math.abs(e.clientY - _marqueeOrigin.clientY) < 4) {
        _marqueeOrigin = null;
        return;
    }
    _marqueeOrigin = null;

    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) _clearSelection();

    _preview.querySelectorAll('.pdf-region, .pdf-zone').forEach(el => {
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

// ── Group Selected into a New Zone ────────────────────────────────────────────

function _groupSelected() {
    if (_selected.size < 2) return;

    pushSnapshot();

    const regions = [..._selected].filter(el => el.classList.contains('pdf-region'));
    if (regions.length < 2) return;

    const cols = Math.min(regions.length, 4);
    const firstParentZone = regions[0].closest('.pdf-zone') || regions[0].parentElement;

    const newZone = document.createElement('div');
    newZone.className = `pdf-zone pdf-zone--cols-${cols}`;

    const handle = document.createElement('span');
    handle.className = 'sel-drag-handle';
    handle.textContent = '\u283F';
    handle.setAttribute('draggable', 'false');
    newZone.appendChild(handle);

    const COL_NAMES = ['left', 'center', 'right'];
    regions.forEach((r, i) => {
        const col = document.createElement('div');
        col.className = `pdf-col pdf-col--${cols <= 3 ? COL_NAMES[i] : `col-${i}`}`;
        col.appendChild(r);
        newZone.appendChild(col);
    });

    firstParentZone.before(newZone);
    _wireEl(newZone);
    newZone.querySelectorAll('.pdf-col').forEach(_wireDropContainer);
    if (cols > 1) _injectResizeDividers(newZone);

    _clearSelection();
    _normalizeDom();
    _syncState();
    syncUndoRedoUI();
}

// ── Utilities & State Synchronization ─────────────────────────────────────────

function _updateGroupBtn() {
    if (!_btnGroup) return;
    const regions = [..._selected].filter(el => el.classList.contains('pdf-region'));
    _btnGroup.style.display = (_active && regions.length >= 2) ? '' : 'none';
}

function _syncState() {
    _removeGhostCol();
    _removeAllDividers();
    _hidePropsPanel();
    _preview?.querySelectorAll('.sel-drag-handle').forEach(h => h.remove());
    markHtmlDirty();
    if (_active) {
        _attachHandles();
        _injectAllResizeDividers();
    }
}

// ── Exports ───────────────────────────────────────────────────────────────────

export function toggleFlexCenter(zoneEl) {
    const pageEl = zoneEl.closest('.pdf-page-content');
    if (!pageEl) return;
    pushSnapshot();
    const zones = JSON.parse(pageEl.dataset.zones || '[]');
    const zoneIdx = [...pageEl.querySelectorAll('.pdf-zone')].indexOf(zoneEl);
    if (zoneIdx === -1 || !zones[zoneIdx]) return;

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
    _syncState();
    syncUndoRedoUI();
}

export function deactivateSelectionMode() {
    if (!_active) return;
    _toggle();
}

export function isSelectionModeActive() {
    return _active;
}