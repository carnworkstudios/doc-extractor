/**
 * annotationToolbar.js
 * Wires the Annotate ribbon group (shown only in the PDF view) to the
 * annotation engine: mode toggle, tool buttons, undo/redo, and keyboard
 * shortcuts. The engine owns state; this module only reflects it in the DOM.
 */

import $ from 'jquery';
import * as engine from '../annotation/engine.js';

import { showToast } from './toast.js';

const TOOL_ICONS = {
    select: 'ann-tool-select',
    highlight: 'ann-tool-highlight',
    ink: 'ann-tool-ink',
    rect: 'ann-tool-rect',
    ellipse: 'ann-tool-ellipse',
    arrow: 'ann-tool-arrow',
    measure: 'ann-tool-measure',
};

let _sub;

export function initAnnotationToolbar() {
    const root = document.getElementById('annotate-group');
    if (!root) return;

    root.addEventListener('click', (e) => {
        const toolBtn = e.target.closest('[data-ann-tool]');
        if (toolBtn) {
            engine.setMode('annotate');
            engine.setTool(toolBtn.dataset.annTool);
            return;
        }
        const modeBtn = e.target.closest('#btn-ann-mode');
        if (modeBtn) {
            engine.setMode(engine.getMode() === 'annotate' ? 'text' : 'annotate');
            return;
        }
        const undoBtn = e.target.closest('#btn-ann-undo');
        if (undoBtn) { engine.undo(); return; }
        const redoBtn = e.target.closest('#btn-ann-redo');
        if (redoBtn) { engine.redo(); return; }
        const clearBtn = e.target.closest('#btn-ann-clear');
        if (clearBtn) {
            if (confirm('Delete all annotations from this document?')) {
                engine.clearAnnotations();
                showToast('All annotations cleared', 'info');
            }
            return;
        }
    });

    // Keyboard shortcuts: V select, H highlight, P pen, R rect, O ellipse,
    // A arrow, T text, M measure, Q tool lock, Esc handled by layer.
    document.addEventListener('keydown', (e) => {
        if (engine.getMode() !== 'annotate') return;
        if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
        if (e.target.isContentEditable) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const map = { v: 'select', h: 'highlight', p: 'ink', r: 'rect', o: 'ellipse', a: 'arrow', m: 'measure' };
        const tool = map[e.key.toLowerCase()];
        if (tool) {
            e.preventDefault();
            engine.setTool(tool);
        } else if (e.key === 'q' || e.key === 'Q') {
            e.preventDefault();
            engine.toggleToolLock();
        }
    });

    _sub = engine.subscribe(() => _refresh(root));
    _refresh(root);
}

function _refresh(root) {
    const mode = engine.getMode();
    const tool = engine.getTool();
    const lock = engine.getToolLock();

    const modeBtn = root.querySelector('#btn-ann-mode');
    if (modeBtn) modeBtn.classList.toggle('active', mode === 'annotate');

    root.querySelectorAll('[data-ann-tool]').forEach(btn => {
        const active = mode === 'annotate' && btn.dataset.annTool === tool;
        btn.classList.toggle('active', active);
    });

    const undoBtn = root.querySelector('#btn-ann-undo');
    const redoBtn = root.querySelector('#btn-ann-redo');
    const clearBtn = root.querySelector('#btn-ann-clear');
    if (undoBtn) undoBtn.disabled = !engine.canUndo();
    if (redoBtn) redoBtn.disabled = !engine.canRedo();
    if (clearBtn) clearBtn.disabled = engine.getAnnotations().length === 0;

    let lockEl = root.querySelector('#ann-tool-lock');
    if (lock) {
        if (!lockEl) {
            lockEl = document.createElement('button');
            lockEl.id = 'ann-tool-lock';
            lockEl.className = 'tool-btn tool-btn--active';
            lockEl.textContent = 'Q';
            lockEl.title = 'Tool lock ON — tool stays active after draw';
            const label = root.querySelector('.ribbon-group-label');
            root.querySelector('.ribbon-group-buttons').appendChild(lockEl);
        }
    } else if (lockEl) {
        lockEl.remove();
    }
}
