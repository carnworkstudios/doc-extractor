import { TableEditor } from '../../../table-formatter/src/js/core/TableEditor.js';
import { markHtmlDirty } from './htmlSync.js';
import { pushSnapshot } from './historyController.js';
import { showToast } from './toast.js';
import { GridMapper } from '../../../table-formatter/src/js/core/GridMapper.js';

let _editor = null;
let _preview = null;
let _fab = null;
let _popover = null;
let _activeTable = null;
let _editModeActive = false;
let _observers = [];
let _popoverWired = false;

export function initTableEditing() {
    _preview = document.getElementById('html-preview');

    _createFab();
    _createPopover();
    _wireMainToolbar();

    _observers.forEach(obs => obs.disconnect());
    _observers = [];

    const el = document.getElementById('html-preview');
    if (el) {
        const obs = new MutationObserver(() => _rebind());
        obs.observe(el, { childList: true, subtree: true, characterData: false });
        _observers.push(obs);
    }

    _rebind();

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _editModeActive) _exitEditMode();
    });
    document.addEventListener('click', (e) => {
        if (!_editModeActive) return;
        const insideFab = e.target.closest('.tbl-fab');
        const insidePop = e.target.closest('.tbl-fab-popover');
        const insideRuler = e.target.closest('.tafne-ruler-wrap');
        if (insideFab || insidePop || insideRuler) return;
        const inTable = _editor?.table?.contains(e.target);
        if (!inTable) _exitEditMode();
    });
    window.addEventListener('scroll', _repositionUI, true);
}

// ── FAB ─────────────────────────────────────────────────────────────────────

function _createFab() {
    _fab = document.createElement('div');
    _fab.className = 'tbl-fab';
    _fab.title = 'Edit Table';
    _fab.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="2" width="12" height="12" rx="1.5"/>
            <line x1="2" y1="7" x2="14" y2="7"/>
            <line x1="7" y1="2" x2="7" y2="14"/>
        </svg>`;
    _fab.style.display = 'none';
    window.GxPointer.onPress(_fab, (e) => { e.stopPropagation(); _toggleEditMode(); });
    document.body.appendChild(_fab);
}

// ── Popover ─────────────────────────────────────────────────────────────────

function _createPopover() {
    _popover = document.createElement('div');
    _popover.className = 'tbl-fab-popover';
    _popover.style.display = 'none';
    _popover.addEventListener('click', (e) => e.stopPropagation());
    _popover.innerHTML = `
        <div class="tbl-pop-header">
            <span>Table Options</span>
            <button class="tbl-pop-toggle" id="tbl-pop-toggle" title="Exit table edit mode">Done</button>
        </div>
        <div class="tbl-pop-row">
            <button class="tbl-pop-btn" id="tbl-pop-add-row" title="Add Row Below">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2.5" y="2.5" width="11" height="5" rx="1"/>
                    <line x1="2.5" y1="5.5" x2="13.5" y2="5.5"/>
                    <path d="M8 10v4M6 12h4"/>
                </svg>
            </button>
            <button class="tbl-pop-btn" id="tbl-pop-add-col" title="Add Column Right">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2.5" y="2.5" width="5" height="11" rx="1"/>
                    <line x1="5.5" y1="2.5" x2="5.5" y2="13.5"/>
                    <path d="M10 8h4M12 6v4"/>
                </svg>
            </button>
            <button class="tbl-pop-btn" id="tbl-pop-del-row" title="Delete Row">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2.5" y="2.5" width="11" height="5" rx="1"/>
                    <line x1="2.5" y1="5.5" x2="13.5" y2="5.5"/>
                    <line x1="6" y1="12" x2="10" y2="12" stroke="#ef4444"/>
                </svg>
            </button>
            <button class="tbl-pop-btn" id="tbl-pop-del-col" title="Delete Column">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2.5" y="2.5" width="5" height="11" rx="1"/>
                    <line x1="5.5" y1="2.5" x2="5.5" y2="13.5"/>
                    <line x1="10" y1="8" x2="14" y2="8" stroke="#ef4444"/>
                </svg>
            </button>
        </div>
        <div class="tbl-pop-row">
            <button class="tbl-pop-btn" id="tbl-pop-merge" title="Merge Cells">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2" y="3" width="12" height="10" rx="1.5"/>
                    <path d="M5.5 8h5M4 8l2-2M4 8l2 2M12 8l-2-2M12 8l-2 2"/>
                </svg>
            </button>
            <button class="tbl-pop-btn" id="tbl-pop-dup" title="Duplicate Selection">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="5.5" y="5.5" width="8" height="8" rx="1"/>
                    <path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1"/>
                </svg>
            </button>
            <button class="tbl-pop-btn" id="tbl-pop-undo" title="Undo Table Edit">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3.5 6.5h7a3 3 0 0 1 3 3v0.5a3 3 0 0 1-3 3H9"/>
                    <path d="M6.5 3.5L3.5 6.5l3 3"/>
                </svg>
            </button>
            <button class="tbl-pop-btn" id="tbl-pop-redo" title="Redo Table Edit">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12.5 6.5h-7a3 3 0 0 0-3 3v0.5a3 3 0 0 0 3 3H7"/>
                    <path d="M9.5 3.5l3 3-3 3"/>
                </svg>
            </button>
        </div>
    `;
    document.body.appendChild(_popover);
}

function _wirePopover() {
    if (_popoverWired) return;
    _popoverWired = true;

    const pop = (id, fn) => {
        const el = _popover.querySelector(id);
        if (el) window.GxPointer.onPress(el, () => {
            if (!_editor) return; pushSnapshot(); fn(); _syncPopoverBtns();
        });
    };
    pop('#tbl-pop-add-row', () => _editor.addRow());
    pop('#tbl-pop-add-col', () => _editor.addColumn());
    pop('#tbl-pop-del-row', () => _editor.deleteRow());
    pop('#tbl-pop-del-col', () => _editor.deleteColumn());
    pop('#tbl-pop-merge', () => _editor.mergeCells());
    pop('#tbl-pop-dup', () => _editor.duplicate());

    const undoBtn = _popover.querySelector('#tbl-pop-undo');
    if (undoBtn) window.GxPointer.onPress(undoBtn, () => {
        if (!_editor) return; pushSnapshot(); _editor.history.undo(); _syncPopoverBtns();
        const container = _activeTable?.closest('#html-preview') || document.getElementById('html-preview');
        if (container) markHtmlDirty();
    });
    const redoBtn = _popover.querySelector('#tbl-pop-redo');
    if (redoBtn) window.GxPointer.onPress(redoBtn, () => {
        if (!_editor) return; pushSnapshot(); _editor.history.redo(); _syncPopoverBtns();
        const container = _activeTable?.closest('#html-preview') || document.getElementById('html-preview');
        if (container) markHtmlDirty();
    });
    const toggleBtn = _popover.querySelector('#tbl-pop-toggle');
    if (toggleBtn) window.GxPointer.onPress(toggleBtn, () => _exitEditMode());
}

function _syncPopoverBtns() {
    const has = _editor?.selectedCells.length > 0;
    ['add-row','add-col','del-row','del-col','merge','dup'].forEach(op => {
        const b = _popover.querySelector(`#tbl-pop-${op}`);
        if (b) b.disabled = !has;
    });
    const u = _popover.querySelector('#tbl-pop-undo');
    const r = _popover.querySelector('#tbl-pop-redo');
    if (u) u.disabled = !_editor?.history.canUndo();
    if (r) r.disabled = !_editor?.history.canRedo();
}

// ── Positioning ─────────────────────────────────────────────────────────────

function _repositionUI() {
    if (!_activeTable || _fab.style.display === 'none') return;
    const tr = _activeTable.getBoundingClientRect();
    const f = 32;
    _fab.style.top  = (tr.top - f / 2) + 'px';
    _fab.style.left = (tr.right - f / 2) + 'px';
    if (_editModeActive) {
        const fr = _fab.getBoundingClientRect();
        _popover.style.top  = (fr.bottom + 6) + 'px';
        _popover.style.left = Math.max(4, fr.right - _popover.offsetWidth) + 'px';
    }
}

// ── Rebind table hover events ──────────────────────────────────────────────

export function rebindTableEditing() {
    _rebind();
}

function _rebind() {
    const tables = document.querySelectorAll('#html-preview table');
    tables.forEach(t => {
        if (t._fabWired) return;
        t._fabWired = true;
        t.addEventListener('mouseenter', () => {
            if (_editModeActive) return;
            _activeTable = t;
            _fab.style.display = 'flex';
            _repositionUI();
        });
        t.addEventListener('mouseleave', (e) => {
            if (_editModeActive) return;
            const rel = e.relatedTarget;
            if (rel && (_fab.contains(rel) || _popover.contains(rel))) return;
            setTimeout(() => {
                if (!_fab.matches(':hover') && !_popover.matches(':hover')) {
                    _activeTable = null;
                    _fab.style.display = 'none';
                    _popover.style.display = 'none';
                }
            }, 80);
        });
    });
    _fab.addEventListener('mouseenter', () => { if (_activeTable) _fab.style.display = 'flex'; });
    _fab.addEventListener('mouseleave', (e) => {
        if (_editModeActive) return;
        if (e.relatedTarget && _popover.contains(e.relatedTarget)) return;
        setTimeout(() => {
            if (!_popover.matches(':hover')) {
                _fab.style.display = 'none';
                _popover.style.display = 'none';
            }
        }, 100);
    });
    _popover.addEventListener('mouseenter', () => _fab.style.display = 'flex');
    _popover.addEventListener('mouseleave', () => {
        if (_editModeActive) return;
        setTimeout(() => {
            if (!_fab.matches(':hover')) {
                _fab.style.display = 'none';
                _popover.style.display = 'none';
            }
        }, 100);
    });
}

// ── Edit mode ───────────────────────────────────────────────────────────────

function _toggleEditMode() {
    if (_editModeActive) _exitEditMode();
    else _enterEditMode();
}

function _enterEditMode() {
    if (!_activeTable) return;
    _wirePopover();
    _editModeActive = true;
    _fab.classList.add('tbl-fab--active');

    _activeTable.contentEditable = 'false';
    _editor = new TableEditor(_activeTable, { ruler: true });

    const container = _activeTable.closest('#html-preview') || document.getElementById('html-preview');
    _editor.on('change', () => {
        if (container) markHtmlDirty();
    });
    _editor.on('select', () => _syncPopoverBtns());
    _editor.on('error', (d) => showToast(d.message, 'warning'));

    _activeTable.addEventListener('click', _onCellClick);
    _activeTable.addEventListener('dblclick', _onCellDblClick);

    _popover.style.display = 'flex';
    _repositionUI();
    _syncPopoverBtns();
    _enableToolbarBtns(true);
}

function _onCellClick(e) {
    if (!_editor) return;
    const cell = e.target.closest('td, th');
    if (!cell) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
        const sel = new Set(_editor.selectedCells);
        if (sel.has(cell)) { sel.delete(cell); _editor.selectCells([...sel]); }
        else { sel.add(cell); _editor.selectCells([...sel]); }
    } else if (e.shiftKey && _editor.selectedCells.length > 0) {
        const last = _editor.selectedCells[_editor.selectedCells.length - 1];
        const mapper = new GridMapper(_editor.table);
        const from = mapper.getVisualPosition(last);
        const to = mapper.getVisualPosition(cell);
        if (from && to) {
            const cells = [];
            for (let r = Math.min(from.startRow, to.startRow); r <= Math.max(from.startRow, to.startRow); r++) {
                mapper.getCellsInRow(r).forEach(c => {
                    const p = mapper.getVisualPosition(c);
                    const minC = Math.min(from.startCol, to.startCol);
                    const maxC = Math.max(from.startCol, to.startCol);
                    if (p && p.startRow === r && p.startCol >= minC && p.startCol <= maxC) cells.push(c);
                });
            }
            _editor.selectCells(cells);
        }
    } else {
        _editor.selectCell(cell);
    }
}

function _onCellDblClick(e) {
    const cell = e.target.closest('td, th');
    if (!cell) return;
    _exitEditMode();
    const range = document.createRange();
    range.selectNodeContents(cell);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

function _exitEditMode() {
    if (!_editor) return;
    const container = _activeTable?.closest('#html-preview') || document.getElementById('html-preview');

    _editModeActive = false;
    _fab.classList.remove('tbl-fab--active');

    _editor.table.removeEventListener('click', _onCellClick);
    _editor.table.removeEventListener('dblclick', _onCellDblClick);
    _editor.table.contentEditable = 'inherit';
    _editor.destroy();
    _editor = null;
    _activeTable = null;

    _popover.style.display = 'none';
    _fab.style.display = 'none';
    _enableToolbarBtns(false);
    // `container` IS #html-preview, so the old applyHtmlEverywhere(…, null)
    // sanitized the whole document and wrote it back into the very surface it
    // came from — a full O(document) round-trip that also blew away the caret.
    // The DOM is already correct; only the cached string is stale.
    if (container) markHtmlDirty();
}

// ── Main toolbar ────────────────────────────────────────────────────────────

function _enableToolbarBtns(on) {
    document.querySelectorAll('[id^="btn-table-"]').forEach(b => b.disabled = !on);
}

function _wireMainToolbar() {
    const handler = (fn) => () => { if (!_editor) return; pushSnapshot(); fn(); };
    const map = {
        'btn-table-add-row':  () => _editor.addRow(),
        'btn-table-add-col':  () => _editor.addColumn(),
        'btn-table-del-row':  () => _editor.deleteRow(),
        'btn-table-del-col':  () => _editor.deleteColumn(),
        'btn-table-merge':    () => _editor.mergeCells(),
    };
    Object.entries(map).forEach(([id, fn]) => {
        const el = document.getElementById(id);
        if (el) window.GxPointer.onPress(el, handler(fn));
    });
}

export function getActiveEditor() {
    return _editor;
}
