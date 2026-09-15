/**
 * Two-way position sync between the Doc view and the native VS Code editor.
 *
 * Only active inside the VS Code webview; in a browser there is no editor to
 * sync with and every function here returns immediately.
 *
 * The model is the one used by vscode-web-visual-editor and already proven in
 * the Table IDE extension: the host sends a character range for every element
 * in the source file, those ranges are stamped onto the rendered nodes, and
 * each side can then translate a position into the other's coordinates.
 *
 *   host → here  ginexys:source-ranges   one {tag,start,end} per source element
 *   here → host  ginexys:reveal-source   clicked element's range; host moves the cursor
 *   host → here  ginexys:select-source   cursor offsets; highlight the element
 *
 * Matching rendered nodes to source ranges is done by TAG IN DOCUMENT ORDER
 * rather than by index, because the browser's parser inserts implicit elements
 * the source never contained (<tbody> is the usual one) and drops others. A
 * positional zip would therefore drift by one after the first implicit node and
 * silently map every later element to its neighbour — worse than not mapping.
 */

const SOURCE_START = 'data-gx-source-start';
const SOURCE_END = 'data-gx-source-end';
const SELECTED_CLASS = 'gx-vscode-source-selected';

// The Doc view's rendered content. Ranges are only meaningful inside it.
const DOC_ROOT = '#html-preview';

function _embedded() {
    return !!(window.CwsBridge && window.CwsBridge.isEmbedded);
}

function _docRoot() {
    return document.querySelector(DOC_ROOT);
}

/** Stamp each rendered element with the character range it came from. */
export function applySourceRanges(ranges) {
    const root = _docRoot();
    if (!root || !Array.isArray(ranges)) return;

    const elements = Array.from(root.querySelectorAll('*'));
    elements.forEach(el => {
        el.removeAttribute(SOURCE_START);
        el.removeAttribute(SOURCE_END);
    });

    let cursor = 0;
    ranges.forEach(range => {
        const tag = String(range && range.tag || '').toLowerCase();
        if (!tag) return;
        // Skip forward to the next rendered element of this tag. An element the
        // parser invented has no range and is simply passed over; one the
        // parser dropped leaves its range unconsumed. Either way the following
        // elements stay correctly aligned.
        while (cursor < elements.length &&
               elements[cursor].tagName.toLowerCase() !== tag) cursor++;
        if (cursor >= elements.length) return;
        elements[cursor].setAttribute(SOURCE_START, String(range.start));
        elements[cursor].setAttribute(SOURCE_END, String(range.end));
        cursor++;
    });
}

/** Highlight the SMALLEST mapped element containing the editor's cursor. */
export function selectFromSource(selections) {
    const root = _docRoot();
    if (!root) return;

    root.querySelectorAll('.' + SELECTED_CLASS).forEach(el => {
        el.classList.remove(SELECTED_CLASS);
    });

    let first = null;
    (selections || []).forEach(sel => {
        let best = null;
        let bestSpan = Infinity;
        // Smallest containing range, not the first match: ranges nest, so the
        // <body> that contains everything would otherwise always win and the
        // highlight would never be more precise than the whole document.
        root.querySelectorAll(`[${SOURCE_START}][${SOURCE_END}]`).forEach(el => {
            const start = Number(el.getAttribute(SOURCE_START));
            const end = Number(el.getAttribute(SOURCE_END));
            if (!Number.isFinite(start) || !Number.isFinite(end)) return;
            if (start <= sel.start && sel.end <= end && (end - start) < bestSpan) {
                best = el;
                bestSpan = end - start;
            }
        });
        if (best) {
            best.classList.add(SELECTED_CLASS);
            if (!first) first = best;
        }
    });

    if (first && typeof first.scrollIntoView === 'function') {
        first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
}

/**
 * Click an element in the Doc → move the native editor's cursor to its markup.
 *
 * Bound once, delegated from the document, so it survives every re-render of
 * the Doc content without needing to be re-attached.
 */
export function initVscodeDocSync() {
    if (!_embedded()) return;

    document.addEventListener('click', function (e) {
        const target = e.target;
        if (!target || typeof target.closest !== 'function') return;
        const el = target.closest(`[${SOURCE_START}][${SOURCE_END}]`);
        if (!el) return;
        // Ignore clicks outside the Doc view — the Editor and Analyze panes
        // carry no source ranges but share the document-level listener.
        if (!el.closest(DOC_ROOT)) return;

        const start = Number(el.getAttribute(SOURCE_START));
        const end = Number(el.getAttribute(SOURCE_END));
        if (!Number.isInteger(start) || !Number.isInteger(end)) return;
        window.CwsBridge.send('ginexys:reveal-source', { start, end });
    });

    window.addEventListener('message', function (e) {
        const msg = e.data;
        if (!msg || !msg.__ginexys) return;
        if (msg.type === 'ginexys:source-ranges') {
            applySourceRanges(msg.payload && msg.payload.ranges);
        } else if (msg.type === 'ginexys:select-source') {
            selectFromSource(msg.payload && msg.payload.selections);
        }
    });
}
