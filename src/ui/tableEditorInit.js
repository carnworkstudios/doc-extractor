import { TableEditor } from '../../../table-formatter/src/js/core/TableEditor.js';
import { applyHtmlEverywhere } from './htmlSync.js';
import { pushSnapshot } from './historyController.js';
import { showToast } from './toast.js';
import { GridMapper } from '../../../table-formatter/src/js/core/GridMapper.js';

let _editor = null;
let _preview = null;
let _fab = null;
let _popover = null;
let _activeTable = null;
let _editModeActive = false;
let _observer = null;
let _popoverWired = false;

export function initTableEditing() {
    _preview = document.getElementById('html-preview');
    if (!_preview) return;

    _createFab();
    _createPopover();
    _wireMainToolbar();

    _observer = new MutationObserver(() => _rebind());
    _observer.observe(_preview, { childList: true, subtree: true, characterData: false });

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
    _fab.textContent = '\u229E';
    _fab.style.display = 'none';
    _fab.addEventListener('click', (e) => { e.stopPropagation(); _toggleEditMode(); });
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
            <span>Table</span>
            <button class="tbl-pop-toggle" id="tbl-pop-toggle">Select</button>
        </div>
        <div class="tbl-pop-row">
            <button class="tbl-pop-btn" id="tbl-pop-add-row" title="Add row">\u23F4</button>
            <button class="tbl-pop-btn" id="tbl-pop-add-col" title="Add column">\u23F5</button>
            <button class="tbl-pop-btn" id="tbl-pop-del-row" title="Delete row">\u23F8</button>
            <button class="tbl-pop-btn" id="tbl-pop-del-col" title="Delete column">\u23F9</button>
        </div>
        <div class="tbl-pop-row">
            <button class="tbl-pop-btn" id="tbl-pop-merge" title="Merge cells">\u25A3</button>
            <button class="tbl-pop-btn" id="tbl-pop-undo" title="Undo">\u21A9</button>
            <button class="tbl-pop-btn" id="tbl-pop-redo" title="Redo">\u21AA</button>
            <button class="tbl-pop-btn" id="tbl-pop-dup" title="Duplicate">\u229E</button>
        </div>
    `;
    document.body.appendChild(_popover);
}

function _wirePopover() {
    if (_popoverWired) return;
    _popoverWired = true;

    const pop = (id, fn) => {
        _popover.querySelector(id)?.addEventListener('click', () => {
            if (!_editor) return; pushSnapshot(); fn(); _syncPopoverBtns();
        });
    };
    pop('#tbl-pop-add-row', () => _editor.addRow());
    pop('#tbl-pop-add-col', () => _editor.addColumn());
    pop('#tbl-pop-del-row', () => _editor.deleteRow());
    pop('#tbl-pop-del-col', () => _editor.deleteColumn());
    pop('#tbl-pop-merge', () => _editor.mergeCells());
    pop('#tbl-pop-dup', () => _editor.duplicate());

    _popover.querySelector('#tbl-pop-undo')?.addEventListener('click', () => {
        if (!_editor) return; pushSnapshot(); _editor.history.undo(); _syncPopoverBtns();
        if (_preview) applyHtmlEverywhere(_preview.innerHTML, _preview);
    });
    _popover.querySelector('#tbl-pop-redo')?.addEventListener('click', () => {
        if (!_editor) return; pushSnapshot(); _editor.history.redo(); _syncPopoverBtns();
        if (_preview) applyHtmlEverywhere(_preview.innerHTML, _preview);
    });
    _popover.querySelector('#tbl-pop-toggle')?.addEventListener('click', () => _exitEditMode());
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

function _rebind() {
    if (!_preview) return;
    _preview.querySelectorAll('table').forEach(t => {
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

    _editor.on('change', () => {
        if (_preview) applyHtmlEverywhere(_preview.innerHTML, _preview);
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
        document.getElementById(id)?.addEventListener('click', handler(fn));
    });
}

export function getActiveEditor() {
    return _editor;
}
