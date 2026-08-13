/**
 * paneDivider.js
 * Generic draggable divider between two flex panes, resizing them by
 * adjusting `flex` as a percentage. Drives the one workspace divider
 * between #pane-pdf and whichever pane it is sharing the screen with
 * (see workspaceLayout.js).
 */
import $ from 'jquery';

// "<layoutSelector>|<dividerSelector>" -> last dragged split, as a first-pane
// percentage. Keyed by BOTH because one layout can host two dividers (the
// Analyze T-split) and they must not overwrite each other's remembered size.
// Dragging writes inline `flex` onto BOTH panes, and that outlives the pane it
// was sizing: hide one and the survivor is still pinned to `0 0 62%`, leaving a
// dead strip where the other used to be. So the split is remembered here and the
// inline styles are treated as transient — cleared whenever the layout drops to
// one pane, reapplied when it becomes two again.
const _splits = new Map();

/** Drop the inline sizes so a single remaining pane fills the layout again. */
export function clearPaneSizes(layoutSelector, paneSelector = '.vd-pane') {
    $(layoutSelector).find(paneSelector).css('flex', '');
}

/**
 * Reapply the last dragged split, if this layout has one.
 *
 * Only the FIRST pane is pinned; the second is told to absorb whatever is
 * left. Pinning both to percentages of the container over-commits it by the
 * width of the divider itself (two percentages summing to 100% leave no room
 * for the 4px handle between them), which overflows the row.
 */
export function restorePaneSizes(layoutSelector, paneSelector = '.vd-pane', dividerSelector = '#pane-divider') {
    const pct = _splits.get(layoutSelector + '|' + dividerSelector);
    const $panes = $(layoutSelector).find(paneSelector).filter(':visible');
    if (pct == null || $panes.length < 2) return;
    $panes.eq(0).css('flex', `0 0 ${pct}%`);
    $panes.eq(1).css('flex', '1 1 0');
}

/**
 * @param {string|function(): string} layout  the flex container, or a function
 *   returning its selector. A FUNCTION is what lets one handle serve two
 *   layouts: the Analyze T-split moves #pane-divider from #workspace-split
 *   into #pane-stack, and re-binding it per layout would leave two competing
 *   mousedown handlers on the same element.
 * @param {string} dividerSelector  the draggable handle inside it
 * @param {string} paneSelector     the resizable children (default '.vd-pane')
 * @param {number} minSize          minimum px each pane may shrink to
 */
export function initPaneDivider(layout, dividerSelector, paneSelector = '.vd-pane', minSize = 200) {
    const $divider = $(dividerSelector);
    if (!$divider.length) return;

    // Resolved per interaction, never cached: the container can change (T-split)
    // and its flex-direction can change under a media query.
    const layoutSel = () => (typeof layout === 'function' ? layout() : layout);
    const $L = () => $(layoutSel());
    if (!$L().length) return;

    let dragging = false;
    let startPos = 0;
    let startSize = 0;

    /**
     * Which axis this drag runs along.
     *
     * Read from the CONTAINER's computed flex-direction at drag time, so a
     * media query that flips row -> column flips the drag with it. This was
     * silently broken while the caller passed #app-workspace — that element is
     * always a row (it holds the nav rail beside the panes), so `column` never
     * matched and the handle only ever dragged horizontally, including on
     * narrow screens where the panes were visibly stacked.
     */
    function isStacked() {
        const el = $L()[0];
        return !!el && getComputedStyle(el).flexDirection === 'column';
    }

    function getEventPos(e) {
        const src = e.touches?.[0] ?? e;
        return isStacked() ? src.clientY : src.clientX;
    }

    // paneSelector matches every resizable pane, but only two are ever on
    // screen at once — the hidden ones must not shift eq(0)/eq(1).
    function visiblePanes() {
        return $L().find(paneSelector).filter(':visible');
    }

    function startDrag(e) {
        dragging = true;
        startPos = getEventPos(e);
        const $first = visiblePanes().first();
        startSize = isStacked() ? $first.outerHeight() : $first.outerWidth();
        $divider.addClass('dragging');
        if (!e.touches) {
            $('body').css({ userSelect: 'none', cursor: isStacked() ? 'row-resize' : 'col-resize' });
        }
        e.preventDefault();
    }

    function doDrag(e) {
        if (!dragging) return;
        const delta = getEventPos(e) - startPos;
        const $panes = visiblePanes();
        if ($panes.length < 2) return;
        const $layout = $L();
        const total = isStacked() ? $layout.outerHeight() : $layout.outerWidth();
        const next = Math.max(minSize, Math.min(total - minSize, startSize + delta));
        const pct = (next / total) * 100;
        $panes.eq(0).css('flex', `0 0 ${pct}%`);
        $panes.eq(1).css('flex', '1 1 0');   // absorbs the remainder incl. the divider
        _splits.set(layoutSel() + '|' + dividerSelector, pct);
        if (e.cancelable) e.preventDefault();
    }

    function endDrag() {
        if (!dragging) return;
        dragging = false;
        $divider.removeClass('dragging');
        $('body').css({ userSelect: '', cursor: '' });
    }

    $divider.on('mousedown', startDrag);
    $divider[0].addEventListener('touchstart', startDrag, { passive: false });

    $(document).on('mousemove', doDrag).on('mouseup', endDrag);
    document.addEventListener('touchmove', doDrag, { passive: false });
    document.addEventListener('touchend', endDrag);
}

/**
 * Pane-focus tracking: clicking/focusing inside a pane marks it active and
 * clears the others. The visual highlight is the point, but `onFocusChange`
 * is also what routes the format toolbar to whichever surface holds the
 * caret when two panes share the screen (see workspaceLayout.js).
 */
export function initPaneActiveTracking(paneSelector, onFocusChange) {
    const $panes = $(paneSelector);
    if (!$panes.length) return;

    $panes.off('click.paneActive focusin.paneActive mousedown.paneActive')
        .on('click.paneActive focusin.paneActive mousedown.paneActive', function () {
            $panes.removeClass('work-pane--active');
            $panes.find('.vd-pane-header').removeClass('vd-pane-header--active');
            $(this).addClass('work-pane--active');
            $(this).find('.vd-pane-header').addClass('vd-pane-header--active');
            if (onFocusChange) onFocusChange(this);
        });
}
