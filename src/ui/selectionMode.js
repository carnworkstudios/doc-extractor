/**
 * selectionMode.js
 * Toggles the Doc tab between Edit Mode (contenteditable) and Selection Mode
 * (drag-to-reorder zones/regions, marquee select, group into zone).
 *
 * DOM hierarchy: pdf-page-content > pdf-zone > [pdf-col >] pdf-region > content
 * Zones drag within their pdf-page-content parent.
 * Regions drag within any pdf-zone/pdf-col and can cross zones.
 */

import { applyHtmlEverywhere } from './htmlSync.js';

let _active       = false;
let _selected     = new Set();   // Set of .pdf-region or .pdf-zone elements
let _draggedEl    = null;
let _indicator    = null;        // div.sel-drop-indicator currently in DOM
let _marqueeEl    = null;
let _marqueeOrigin = null;       // { x, y, scrollTop } at mousedown
let _preview      = null;        // #html-preview element
let _btnSelect    = null;
let _btnGroup     = null;

// ── Public init ───────────────────────────────────────────────────────────────

export function initSelectionMode() {
    _preview   = document.getElementById('html-preview');
    _btnSelect = document.getElementById('btn-select-mode');
    _btnGroup  = document.getElementById('btn-group-selected');

    if (!_preview || !_btnSelect) return;

    _btnSelect.addEventListener('click', _toggle);
    _btnGroup?.addEventListener('click', _groupSelected);
}

// ── Toggle ────────────────────────────────────────────────────────────────────

function _toggle() {
    _active = !_active;
    _preview.classList.toggle('selection-mode', _active);
    _preview.contentEditable = _active ? 'false' : 'true';
    _btnSelect.classList.toggle('active', _active);

    if (_active) {
        _attachHandles();
        _preview.addEventListener('mousedown', _onMarqueeStart);
        _preview.addEventListener('click',     _onSelectClick, true);
    } else {
        _clearSelection();
        _removeHandles();
        _preview.removeEventListener('mousedown', _onMarqueeStart);
        _preview.removeEventListener('click',     _onSelectClick, true);
    }
    _updateGroupBtn();
}

// ── Drag handles ──────────────────────────────────────────────────────────────

function _attachHandles() {
    _preview.querySelectorAll('.pdf-zone, .pdf-region').forEach(_wireEl);
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
}

function _wireEl(el) {
    // Inject handle as first child if not already present
    if (!el.querySelector(':scope > .sel-drag-handle')) {
        const handle = document.createElement('span');
        handle.className = 'sel-drag-handle';
        handle.textContent = '⠿';
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

// ── Drag events ───────────────────────────────────────────────────────────────

function _onDragStart(e) {
    // Only start drag from handle or the element itself (not nested content)
    const target = e.target;
    if (!target.classList.contains('pdf-zone') && !target.classList.contains('pdf-region')) {
        e.stopPropagation();
        return;
    }
    _draggedEl = target;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ''); // required for Firefox
    setTimeout(() => target.classList.add('sel-dragging'), 0);
}

function _onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!_draggedEl || e.currentTarget === _draggedEl) return;

    const target = e.currentTarget;
    // Only allow drop on same level: zone-onto-zone, region-onto-region
    const sameKind = _draggedEl.classList.contains('pdf-zone') === target.classList.contains('pdf-zone');
    if (!sameKind) return;

    _removeIndicator();
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

function _onDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) {
        _removeIndicator();
    }
}

function _onDrop(e) {
    e.preventDefault();
    if (!_draggedEl || e.currentTarget === _draggedEl) return;

    const target = e.currentTarget;
    const sameKind = _draggedEl.classList.contains('pdf-zone') === target.classList.contains('pdf-zone');
    if (!sameKind) return;

    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;

    if (after) {
        target.after(_draggedEl);
    } else {
        target.before(_draggedEl);
    }

    _removeIndicator();
    _syncState();
}

function _onDragEnd() {
    _draggedEl?.classList.remove('sel-dragging');
    _draggedEl = null;
    _removeIndicator();
}

function _removeIndicator() {
    _indicator?.remove();
    _indicator = null;
}

// ── Click selection ───────────────────────────────────────────────────────────

function _onSelectClick(e) {
    const el = e.target.closest('.pdf-region, .pdf-zone');
    if (!el) {
        // Click on empty area — clear selection
        _clearSelection();
        return;
    }
    // Don't bubble to parent zone when clicking a region inside it
    e.stopPropagation();

    if (e.ctrlKey || e.metaKey) {
        // Additive toggle
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
    _updateGroupBtn();
}

function _clearSelection() {
    _selected.forEach(el => el.classList.remove('sel-selected'));
    _selected.clear();
    _updateGroupBtn();
}

// ── Marquee select ────────────────────────────────────────────────────────────

function _onMarqueeStart(e) {
    // Only start marquee on the bare preview background, not on a region/zone
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

    // Find all regions intersecting the marquee
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

    // Collect only regions (zones aren't groupable into another zone cleanly)
    const regions = [..._selected].filter(el => el.classList.contains('pdf-region'));
    if (regions.length < 2) return;

    // Insert new zone before the first selected region's parent zone
    const firstParentZone = regions[0].closest('.pdf-zone') || regions[0].parentElement;
    const newZone = document.createElement('div');
    newZone.className = 'pdf-zone pdf-zone--cols-1';

    // Add drag handle to new zone
    const handle = document.createElement('span');
    handle.className = 'sel-drag-handle';
    handle.textContent = '⠿';
    handle.setAttribute('draggable', 'false');
    newZone.appendChild(handle);

    // Move all selected regions into the new zone
    regions.forEach(r => newZone.appendChild(r));

    // Insert before the first parent zone
    firstParentZone.before(newZone);

    // Wire the new zone for drag
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
    applyHtmlEverywhere(_preview.innerHTML, _preview);
}
