/**
 * workspaceLayout.js
 * Owns which workspace panes are on screen.
 *
 * THE MODEL: every pane (#pane-pdf, #pane-doc, #pane-analyze, #pane-editor,
 * #pane-diff) is a permanent sibling inside #app-workspace. A tab chooses
 * which panes are VISIBLE. It does not choose where anything lives, and
 * nothing is ever moved between parents.
 *
 * That is the whole point. The previous two designs both tried to put the
 * rendered PDF in two places:
 *   - Visual Diff rendered it TWICE (a second renderPDFToCanvas into
 *     #visual-diff-pdf, plus a second contenteditable clone of the doc kept
 *     in sync) — which then needed dirty flags, scroll-sync observers and a
 *     third toolbar-target resolver to keep the copies honest.
 *   - The mirror reparented the ONE container into whichever pane asked for
 *     it — which needed an owner registry, and silently dropped scrollTop
 *     and contenteditable every time, because a detached element keeps
 *     neither.
 * Both were solving "the PDF must appear beside the doc" by relocating it.
 * It never had to move: it only had to stop being locked inside a
 * mutually-exclusive tab panel.
 *
 * DOM order (#pane-pdf, #pane-divider, then the rest) is load-bearing —
 * it puts the single divider between the PDF and whichever pane follows it,
 * so Doc+PDF and Analyze+PDF share one divider.
 */
import $ from 'jquery';
import { initPaneDivider, initPaneActiveTracking, clearPaneSizes, restorePaneSizes } from './paneDivider.js';

// The flex/grid row that holds the panes. NOT #app-workspace — that also
// contains the 40px nav rail, so sizing and class toggles aimed at the panes
// have to land on the inner container.
const LAYOUT_SEL = '#workspace-split';
const DIVIDER_SEL = '#pane-divider';
const STACK_SEL = '#pane-stack';
const STACK_DIVIDER_SEL = '#stack-divider';
const PANE_SEL = '#pane-pdf, #pane-doc, #pane-analyze';

/** Every pane a view can ask for, in DOM order. */
const PANES = ['pdf', 'doc', 'analyze', 'editor', 'diff'];

/** The pane each view shows on its own. */
const BASE_PANE = {
    pdf: 'pdf',
    html: 'doc',
    analyze: 'analyze',
    editor: 'editor',
    diff: 'diff',
};

/**
 * Which extra panes each view can show beside its own.
 *
 * The Doc tab can borrow the Original; Analyze can borrow either document
 * pane, independently — showing the Extracted HTML next to the canvas is
 * useful without the Original, and vice versa. One flag for "the mirror"
 * could not express that.
 */
const MIRRORABLE = {
    html: ['pdf'],
    analyze: ['pdf', 'doc'],
};

/** Header bars only make sense once two panes share the screen. */
const HEADER_SEL = '#pdf-header-bar, #doc-header-bar, #analyze-canvas-header-bar';

/** view -> Set of extra pane names currently shown beside its base pane. */
const _mirrorOn = new Map();
let _view = 'pdf';
let _focusedPane = 'doc';      // which pane owns the format toolbar

export function initWorkspaceLayout() {
    // Two dividers, each scoped to the container it resizes. paneDivider reads
    // that container's own flex-direction at drag time, so the same code drags
    // horizontally or vertically depending on how the layout has reflowed —
    // no orientation is hard-coded.
    // #pane-divider is registered ONCE. Its container is resolved per drag,
    // not at init: outside the T it separates two panes inside
    // #workspace-split; inside the T it separates the two stacked doc panes
    // inside #pane-stack. Binding it twice would attach two competing
    // mousedown handlers to the same element.
    initPaneDivider(
        () => ($(LAYOUT_SEL).hasClass('t-split') ? STACK_SEL : LAYOUT_SEL),
        DIVIDER_SEL, PANE_SEL, 160,
    );
    initPaneDivider(LAYOUT_SEL, STACK_DIVIDER_SEL, `${STACK_SEL}, #pane-analyze`, 160);
    initPaneActiveTracking(PANE_SEL, (paneEl) => {
        const pane = paneEl.id === 'pane-pdf' ? 'pdf' : 'doc';
        if (_focusedPane === pane) return;
        _focusedPane = pane;
        import('./viewController.js').then(m => m.syncToolbarToView(_view));
        import('./navPanel.js').then(m => m.renderNavPanel());
    });
    applyLayout();
}

/** Which pane the caret is in. Only meaningful while the PDF is shared. */
export function getFocusedPane() {
    return isSplit() ? _focusedPane : (BASE_PANE[_view] === 'pdf' ? 'pdf' : 'doc');
}

function _extras(view = _view) {
    return _mirrorOn.get(view) ?? new Set();
}

/** True when any extra pane is on screen next to the view's own. */
export function isSplit() {
    return _extras().size > 0;
}

/** @param {'pdf'|'doc'} [pane] — omit to ask "is anything mirrored". */
export function isMirrorOn(view = _view, pane) {
    const set = _extras(view);
    return pane ? set.has(pane) : set.size > 0;
}

export function setView(viewName) {
    _view = viewName;
    if (!isSplit()) _focusedPane = BASE_PANE[viewName] === 'pdf' ? 'pdf' : 'doc';
    applyLayout();
}

/**
 * Toggle ONE extra pane for a view.
 * @param {string} viewName
 * @param {'pdf'|'doc'} [pane] — defaults to the view's first mirrorable pane,
 *   which keeps the Doc tab's single "Show original PDF" button working.
 */
export function toggleMirror(viewName, pane) {
    const allowed = MIRRORABLE[viewName];
    if (!allowed) return false;
    const target = pane ?? allowed[0];
    if (!allowed.includes(target)) return false;

    const set = _mirrorOn.get(viewName) ?? new Set();
    const next = !set.has(target);
    if (next) set.add(target); else set.delete(target);
    _mirrorOn.set(viewName, set);
    applyLayout();
    return next;
}

/**
 * Analyze's split is a T, not a row: Original and Extracted HTML on one side,
 * the canvas on the other. Same panes as the Doc tab — the arrangement is the
 * only difference, and it lives entirely in CSS (`.t-split`).
 */
export function isTSplit() {
    if (_view !== 'analyze') return false;
    const set = _extras('analyze');
    // Only BOTH document panes make a T. One of them beside the canvas is an
    // ordinary two-pane row, which the existing layout already handles.
    return set.has('pdf') && set.has('doc');
}

export function applyLayout() {
    const visible = new Set([BASE_PANE[_view]]);
    for (const extra of _extras()) visible.add(extra);

    const tSplit = isTSplit();
    PANES.forEach(p => $(`#pane-${p}`).attr('hidden', !visible.has(p)));
    $(LAYOUT_SEL).toggleClass('t-split', tSplit);

    // #pane-divider sits between the two document panes; #stack-divider sits
    // between that group and the canvas. Outside the T only the first exists,
    // separating whichever two panes are up.
    const split = visible.size > 1;
    $(DIVIDER_SEL).attr('hidden', !split);
    $(STACK_DIVIDER_SEL).attr('hidden', !tSplit);

    // Headers stay up in every layout, not just the split. They carry the
    // open document's name and its close control (the .gx-file-chip), which
    // are exactly as useful with one pane on screen as with two.
    $(HEADER_SEL).removeAttr('hidden');

    // The divider writes inline flex percentages onto the panes it sizes.
    // Those must not outlive the split, or the surviving pane stays pinned
    // to its dragged width with a dead strip beside it.
    if (split) restorePaneSizes(LAYOUT_SEL, PANE_SEL);
    else clearPaneSizes(LAYOUT_SEL, PANE_SEL);

    // A reference view is not an editing surface. Analyze routes no toolbar
    // to the PDF, so leaving it editable there would let edits land somewhere
    // the toolbar never reflects.
    applyPdfReadOnly();

    $('.pdf-mirror-toggle').attr('aria-expanded', String(isMirrorOn(_view, 'pdf')));
    $('.doc-mirror-toggle').attr('aria-expanded', String(isMirrorOn(_view, 'doc')));

    // Showing/hiding a pane changes the PDF pane's width, so the fitted zoom
    // is stale the moment the layout changes. Re-fit on the next frame —
    // clientWidth is still the pre-toggle value until the browser has laid
    // the new arrangement out.
    if (visible.has('pdf')) {
        requestAnimationFrame(() => {
            import('./pdfCanvas.js').then(m => m.fitPDFWidth());
        });
    }

    // The Doc surface only has layout once its pane is on screen, and page
    // windowing needs real heights to decide what to park (see
    // docVirtualizer.js). Prod it here rather than guessing a timeout.
    if (visible.has('doc')) {
        import('./docVirtualizer.js').then(m => m.onDocSurfaceVisible());
    }
}

/**
 * Exported because renderPDFToCanvas rebuilds every .page-wrapper with
 * contenteditable="true" baked in, so opening a new document has to
 * re-assert this rather than inherit it.
 */
export function applyPdfReadOnly() {
    const readOnly = _view === 'analyze';
    $('#pdf-canvas-container')
        .find('.page-wrapper, .editable-text-layer')
        .attr('contenteditable', String(!readOnly));
}
