/**
 * htmlToGxDoc.js
 * Extracted/sanitized HTML → gx-doc/1 IR.
 *
 * Walks the same structural contract as the exporters in exportController.js:
 * pages are `section.pdf-page-content`, structural wrappers are the
 * FLOW_WRAPPER_RE classes, and block leaves are h1–h6 / .fN.ta-x paragraphs /
 * .pdf-table-wrap / ul·ol / aside.pdf-box / hr.pdf-divider / img[data-img-id].
 * `.pdf-region` sentinels carry `data-ry` and `data-rx`, and `.pdf-col`
 * wrappers carry `data-col-id` — those feed the block's `ry` and `colIdx`.
 *
 * Flow chains (paragraphs continued across column seams) are merged first via
 * mergeFlowChains() so reading order is clean before blocks are read.
 */

import { createDoc, addPage, addBlock } from './gxDoc.js';
import { mergeFlowChains, FLOW_WRAPPER_RE, IMAGE_BLOCK_RE } from '../ui/exportController.js';

/**
 * A figure's own labels (callouts, axis ticks) as positioned by the classifier.
 *
 * Read straight off the SVG overlay: `x`/`y` are picture-box user units and `y`
 * is the text BASELINE, the same numbers the assembler measured. `labelBox`
 * records the viewBox those units live in, so the round trip back to HTML
 * reproduces the layer instead of flattening it into the alt text.
 */
function _imageLabels(el) {
    const layer = el.querySelector?.('.pdf-image-textlayer');
    const texts = layer?.querySelectorAll?.('text') || [];
    if (!texts.length) return {};
    const labels = [];
    for (const t of texts) {
        labels.push({
            text: t.textContent || '',
            x: parseFloat(t.getAttribute('x')),
            y: parseFloat(t.getAttribute('y')),
            size: parseFloat(t.getAttribute('font-size')),
            // The advance width the PDF measured. Without it a round trip
            // re-renders the run in the viewer's font at the viewer's metrics,
            // which is the drift textLength exists to remove.
            ...(t.getAttribute('textLength') ? { adv: parseFloat(t.getAttribute('textLength')) } : {}),
            ...(t.getAttribute('transform') ? { rot: t.getAttribute('transform') } : {}),
        });
    }
    const vb = (layer.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    const box = (vb.length === 4 && vb.every(Number.isFinite)) ? { w: vb[2], h: vb[3] } : null;
    return box ? { labels, labelBox: box } : { labels };
}

/**
 * Convert an HTML string into a gx-doc/1 document.
 * @param {string} htmlString
 * @param {object} [meta] — { source, title, pageCount }
 * @returns {object} gxDoc
 */
export function htmlToGxDoc(htmlString, meta = {}) {
    const doc = new DOMParser().parseFromString(htmlString, 'text/html');
    mergeFlowChains(doc);

    const gxDoc = createDoc({
        source: meta.source || 'html',
        title: meta.title ?? null,
        pageCount: meta.pageCount ?? null,
    });

    const pages = doc.querySelectorAll('section.pdf-page-content');
    if (pages.length) {
        pages.forEach((pageEl, pi) => {
            const pageNum = parseInt(pageEl.getAttribute('data-page'), 10) || (pi + 1);
            const width = parseFloat(pageEl.getAttribute('data-page-width')) || 0;
            const page = addPage(gxDoc, pageNum);
            page.width = width;
            page.zones = _readZones(pageEl);
            _emitPage(pageEl, page);
        });
    } else {
        // Generic HTML (imported file, Docling emitter, etc.) — single page,
        // single full-width implicit zone, blocks straight off the body.
        const page = addPage(gxDoc, 1);
        page.width = 0;
        _emitPage(doc.body || doc, page);
    }

    gxDoc.links = _collectLinks(doc);

    return gxDoc;
}

/**
 * Collect every `<a href>` into the document's top-level links list. Each link
 * records the page it lives on, its href, provenance, and the anchored text.
 * The per-run capture in `_runs` keeps the href attached to the exact text
 * spans; this list is the IR-level index exporters and the nav panel consume.
 */
function _collectLinks(doc) {
    const out = [];
    for (const a of doc.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href');
        if (!href) continue;
        const pageEl = a.closest?.('section.pdf-page-content');
        const pageNum = pageEl ? parseInt(pageEl.getAttribute('data-page'), 10) || 1 : 1;
        out.push({
            page: pageNum,
            href,
            ...(a.getAttribute('data-link-source') ? { source: a.getAttribute('data-link-source') } : {}),
            text: (a.textContent || '').replace(/\s+/g, ' ').trim(),
        });
    }
    return out;
}

/** Parse the zone table the assembler stored on the page section. */
function _readZones(pageEl) {
    let zones = [];
    const raw = pageEl.getAttribute('data-zones');
    if (raw) {
        try { zones = JSON.parse(raw); } catch (_) { zones = []; }
    }
    return zones.map(z => ({
        y0: z.y0 ?? 0,
        y1: z.y1 ?? Infinity,
        cols: z.cols ?? 1,
        layout: z.layoutClass === 'layout-feature' ? 'feature'
            : z.layoutClass === 'layout-card-grid' ? 'card-grid'
            : z.cols === 1 ? 'full' : 'equal',
        ...(z.leftFraction != null ? { leftFraction: z.leftFraction } : {}),
    }));
}

/** Walk a page section (or body) in reading order and emit typed blocks. */
function _emitPage(container, page) {
    const walk = (parent) => {
        for (const el of parent.children) {
            const cls = el.className || '';
            if (FLOW_WRAPPER_RE.test(cls)) {
                // A wrapper that IS the leaf (imported markdown's
                // <p class="pdf-region type-paragraph">, assembler's inline
                // <style class="pdf-breakpoints">) — emit it directly.
                if (el.children.length === 0) { _emitLeaf(el, page); continue; }
                walk(el);
                continue;
            }
            _emitLeaf(el, page);
        }
    };
    walk(container);
}

function _emitLeaf(el, page) {
    const tag = el.tagName.toLowerCase();
    const cls = el.className || '';
    const colIdx = _colIdx(el);
    const ry = _readRy(el);

    // Style blocks (assembler breakpoints, imported HTML) and scripts are
    // document chrome, never content — same skip as the exporters' page-label.
    if (tag === 'style' || tag === 'script') return;
    if (cls.includes('page-label')) return;

    if (/^h[1-6]$/.test(tag)) {
        addBlock(page, {
            type: 'heading',
            level: parseInt(tag[1], 10),
            text: _blockText(el),
            ...(alignFromClass(cls) ? { align: alignFromClass(cls) } : {}),
            ..._runs(el),
            colIdx,
            ry,
        });
        return;
    }

    if (tag === 'hr') {
        addBlock(page, { type: 'divider', colIdx, ry });
        return;
    }

    if (cls.includes('pdf-table-wrap')) {
        const table = el.querySelector('table');
        if (table) {
            const block = _tableToBlock(table, colIdx, ry);
            if (block) addBlock(page, block);
        }
        return;
    }

    // Bare tables (imported HTML/Markdown) resolve the same way.
    if (tag === 'table') {
        const block = _tableToBlock(el, colIdx, ry);
        if (block) addBlock(page, block);
        return;
    }

    if (tag === 'aside' && cls.includes('pdf-box')) {
        const kind = cls.includes('warning') ? 'warning'
            : cls.includes('caution') ? 'caution'
            : cls.includes('note') ? 'note'
            : cls.includes('tip') ? 'tip'
            : 'note';
        addBlock(page, {
            type: 'callout',
            kind,
            text: _blockText(el),
            ..._runs(el),
            colIdx,
            ry,
        });
        return;
    }

    if (tag === 'ul' || tag === 'ol') {
        addBlock(page, {
            type: 'list',
            ordered: tag === 'ol',
            items: [...el.querySelectorAll('li')].map(li => _blockText(li)),
            colIdx,
            ry,
        });
        return;
    }

    if (tag === 'img' && el.getAttribute('data-img-id')) {
        addBlock(page, {
            type: 'image',
            id: el.getAttribute('data-img-id') || '',
            alt: el.getAttribute('alt') || '',
            colIdx,
            ry,
        });
        return;
    }

    // A picture: the bare placeholder, or the `.pdf-image-stack` wrapper it
    // gets when the classifier recovered the figure's own labels. The stack is
    // not a flow wrapper, so it lands here as a leaf — and before this matched
    // it, every labelled figure fell through to the paragraph branch below,
    // which emitted the axis ticks as prose and dropped the image.
    if (IMAGE_BLOCK_RE.test(cls)) {
        const img = el.querySelector('img[data-img-id]');
        addBlock(page, {
            type: 'image',
            id: img?.getAttribute('data-img-id') || 'img',
            alt: img?.getAttribute('alt') || '',
            ..._imageLabels(el),
            colIdx,
            ry,
        });
        return;
    }

    // Paragraph — .fN.ta-x div/p, or any other leaf block with text.
    const text = _blockText(el);
    if (text) {
        addBlock(page, {
            type: 'paragraph',
            text,
            ...(alignFromClass(cls) ? { align: alignFromClass(cls) } : {}),
            ..._runs(el),
            colIdx,
            ry,
        });
    }
}

function _colIdx(el) {
    const col = el.closest?.('[data-col-id]');
    if (!col) return -1;
    const id = col.getAttribute('data-col-id');
    if (id === 'full') return -1;
    const m = /^col-(\d+)$/.exec(id || '');
    return m ? parseInt(m[1], 10) : -1;
}

/** Reading-order Y from the .pdf-region sentinel; falls back to 0. */
function _readRy(el) {
    const region = el.closest?.('.pdf-region');
    const raw = region?.getAttribute('data-ry');
    if (raw == null || raw === '') return 0;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
}

function alignFromClass(cls) {
    if (cls.includes('ta-l')) return 'left';
    if (cls.includes('ta-c')) return 'center';
    if (cls.includes('ta-r')) return 'right';
    if (cls.includes('ta-j')) return 'justify';
    return null;
}

/** Recursively extract plain text honoring inline bold/italic spans. */
function _nodeText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    return [...node.childNodes].map(n => _nodeText(n)).join('');
}

function _blockText(el) {
    return _nodeText(el).replace(/\s+/g, ' ').trim();
}

/** Capture inline typography (bold/italic/super/sub/link) as optional runs. */
function _runs(el) {
    const runs = [];
    const visit = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            if (node.textContent) runs.push({ text: node.textContent });
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = node.tagName.toLowerCase();
        const cls = node.className || '';
        const flags = {};
        if (tag === 'b' || tag === 'strong' || cls.includes('bold')) flags.bold = true;
        if (tag === 'i' || tag === 'em' || cls.includes('ital')) flags.italic = true;
        if (tag === 'sup') flags.superscript = true;
        if (tag === 'sub') flags.subscript = true;
        if (tag === 'a' && node.hasAttribute('href')) {
            const text = node.textContent;
            if (text) {
                const href = node.getAttribute('href');
                runs.push({
                    text,
                    ...flags,
                    link: {
                        href,
                        ...(node.getAttribute('data-link-source')
                            ? { source: node.getAttribute('data-link-source') } : {}),
                    },
                });
            }
            return;
        }
        if (node.childNodes.length <= 1 && node.childNodes[0]?.nodeType === Node.TEXT_NODE) {
            const text = node.textContent;
            if (text) runs.push({ text, ...flags });
            return;
        }
        for (const child of node.childNodes) visit(child);
    };
    for (const child of el.childNodes) visit(child);

    // Merge adjacent runs with identical styling.
    const merged = [];
    for (const r of runs) {
        if (!r.text) continue;
        const last = merged[merged.length - 1];
        const same = last && last.bold === r.bold && last.italic === r.italic
            && last.superscript === r.superscript && last.subscript === r.subscript
            && (last.link?.href ?? null) === (r.link?.href ?? null);
        if (same) last.text += r.text;
        else merged.push({ ...r });
    }
    return merged.length ? { runs: merged } : {};
}

function _tableToBlock(table, colIdx, ry) {
    const trs = [...table.querySelectorAll('tr')];
    if (!trs.length) return null;

    const cellTextOf = tr => [...tr.querySelectorAll('td, th')].map(cell =>
        (cell.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(),
    );

    const headerRow = table.querySelector('thead tr') || trs[0];
    const headers = cellTextOf(headerRow);
    const rows = trs.filter(tr => tr !== headerRow).map(cellTextOf);

    // Flags mirror describeTable() (structuredExtract.js) — the DOM facts this
    // flattening can still see, so the MCP fast path stays faithful.
    const flags = [];
    const borderless = table.classList.contains('borderless')
        || !!table.closest('.pdf-table--borderless');
    if (borderless) flags.push('column-boundary-ambiguous');
    if (table.getAttribute('data-text-source') === 'ocr') flags.push('ocr-sourced');
    if (trs[0] && !table.querySelector('thead')) flags.push('header-row-guessed');
    const headerCells = [...trs[0].querySelectorAll('th')];
    if (headerCells.some(th => (th.colSpan || 1) > 1 || (th.rowSpan || 1) > 1)) {
        flags.push('merged-header-inferred');
    }
    const totalSlots = headers.length * (rows.length + 1);
    const filled = headers.filter(Boolean).length
        + rows.reduce((n, r) => n + r.filter(Boolean).length, 0);
    if (totalSlots >= 4 && filled / totalSlots < 0.5) flags.push('low-text-density');

    return {
        type: 'table',
        caption: null,
        borderless,
        confidence: _readConfidence(table),
        flags,
        headers,
        rows,
        colIdx,
        ry,
    };
}

function _readConfidence(table) {
    const raw = table.getAttribute('data-confidence');
    if (raw == null || raw === '') return null;
    const n = parseFloat(raw);
    if (!isFinite(n) || n < 0 || n > 1) return null;
    return n;
}
