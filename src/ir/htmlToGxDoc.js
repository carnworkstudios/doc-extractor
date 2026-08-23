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
            // The placement transform, whole. It is a bare `rotate(…)` on the
            // scalar path and a `matrix(…) scale(1,-1)` on the matrix path —
            // the key is `place` because it is no longer only a rotation.
            ...(t.getAttribute('transform') ? { place: t.getAttribute('transform') } : {}),
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
    return _convert(htmlString, meta).gxDoc;
}

/**
 * The same conversion, plus the source markup with every block-producing
 * element stamped with the id of the block it produced.
 *
 * An imported HTML or Markdown file is rendered from its ORIGINAL markup, not
 * from the IR, so it keeps its own styles and structure. That left it
 * unaddressable: getRegionHtml() locates content by `data-region-id` inside a
 * `section.pdf-page-content`, and generic HTML has neither. Every artifact on
 * an imported document therefore resolved to null and could not be sent
 * anywhere. Stamping during the walk is the only place the block and the
 * element that produced it are both in hand.
 *
 * Generic markup is also wrapped in the page scope the rest of the pipeline
 * addresses through, so an import lands in the same coordinate system as an
 * extraction rather than a parallel one.
 *
 * @returns {{ gxDoc: object, html: string }}
 */
export function htmlToGxDocAddressable(htmlString, meta = {}) {
    return _convert(htmlString, { ...meta, stamp: true });
}

function _convert(htmlString, meta = {}) {
    const doc = new DOMParser().parseFromString(htmlString, 'text/html');
    mergeFlowChains(doc);

    const gxDoc = createDoc({
        source: meta.source || 'html',
        title: meta.title ?? null,
        pageCount: meta.pageCount ?? null,
    });

    const stamp = !!meta.stamp;
    const pages = doc.querySelectorAll('section.pdf-page-content');
    let wrapped = false;

    if (pages.length) {
        pages.forEach((pageEl, pi) => {
            const pageNum = parseInt(pageEl.getAttribute('data-page'), 10) || (pi + 1);
            const width = parseFloat(pageEl.getAttribute('data-page-width')) || 0;
            const page = addPage(gxDoc, pageNum);
            page.width = width;
            page.zones = _readZones(pageEl);
            _emitPage(pageEl, page, { stamp, pageNum });
        });
    } else {
        // Generic HTML (imported file, Docling emitter, etc.) — single page,
        // single full-width implicit zone, blocks straight off the body.
        const page = addPage(gxDoc, 1);
        page.width = 0;
        _emitPage(doc.body || doc, page, { stamp, pageNum: 1 });
        wrapped = true;
    }

    gxDoc.links = _collectLinks(doc);

    let html = htmlString;
    if (stamp) {
        const body = doc.body ? doc.body.innerHTML : htmlString;
        html = wrapped
            ? `<article class="pdf-doc">\n<section class="pdf-page-content" data-page="1" data-page-width="0">\n${body}\n</section>\n</article>`
            : body;
    }

    return { gxDoc, html };
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
function _emitPage(container, page, ctx = {}) {
    const walk = (parent) => {
        for (const el of parent.children) {
            const cls = el.className || '';
            if (FLOW_WRAPPER_RE.test(cls)) {
                // A wrapper that IS the leaf (imported markdown's
                // <p class="pdf-region type-paragraph">, assembler's inline
                // <style class="pdf-breakpoints">) — emit it directly.
                if (el.children.length === 0) { _emitAddressable(el, page, ctx); continue; }
                walk(el);
                continue;
            }
            _emitAddressable(el, page, ctx);
        }
    };
    walk(container);
}

/**
 * _emitLeaf, wrapped so the block it appends carries an id that names the
 * element it came from.
 *
 * Done here rather than inside _emitLeaf because that function has a dozen
 * addBlock call sites; the block count before and after is a single place to
 * catch all of them, and it stays correct if a new block type is added.
 */
function _emitAddressable(el, page, ctx) {
    const before = page.blocks.length;
    _emitLeaf(el, page, ctx);
    if (page.blocks.length === before) return;   // chrome, skipped

    const pageNum = ctx.pageNum ?? page.page ?? 1;
    // The id lives on the `.pdf-region` sentinel, which is a flow wrapper the
    // walk descends THROUGH — so the leaf that produced the block usually does
    // not carry it and has to look up. Tables and pictures stamp it on the leaf
    // as well; the leaf wins when both are present.
    const existing = el.getAttribute?.('data-region-id')
        || el.closest?.('.pdf-region[data-region-id]')?.getAttribute('data-region-id')
        || null;
    // One `.pdf-region` can hold several leaves (rebuildText emits a <p> per
    // sentence-aware break), and every one of them would otherwise claim the
    // wrapper's id. Two blocks with one id between them is the same failure as
    // no id: getRegionHtml resolves both to whichever comes first.
    const used = ctx.usedIds || (ctx.usedIds = new Set());
    const _unique = (id) => {
        if (!used.has(id)) { used.add(id); return id; }
        let n = 2;
        while (used.has(`${id}__${n}`)) n++;
        used.add(`${id}__${n}`);
        return `${id}__${n}`;
    };

    for (let i = before; i < page.blocks.length; i++) {
        const block = page.blocks[i];
        if (existing) {
            // The source already names this region (the assembler stamps every
            // one). Carrying it through is a plain round-trip fix: the IR used
            // to drop it, so an export could not be pointed back at the
            // extraction it came from.
            block.id = block.id || _unique(existing);
            continue;
        }
        if (!ctx.stamp) continue;   // plain conversion invents nothing
        const id = block.id || _unique(`${block.type || 'block'}_${pageNum}_${i}`);
        block.id = id;
        el.setAttribute?.('data-region-id', id);
    }
}

function _emitLeaf(el, page, ctx = {}) {
    const tag = el.tagName.toLowerCase();
    const cls = el.className || '';
    const colIdx = _colIdx(el);
    const ry = _readRy(el);

    // Style blocks (assembler breakpoints, imported HTML) and scripts are
    // document chrome, never content — same skip as the exporters' page-label.
    if (tag === 'style' || tag === 'script') return;
    if (cls.includes('page-label')) return;
    // A callout's banner is carried on the callout block as `banner`, so
    // emitting it again from inside the box would duplicate the header as the
    // panel's first paragraph.
    if (cls.includes('pdf-box-banner')) return;

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

    // Display math. The TeX lives in `data-latex`; whether it has been CONFIRMED
    // lives in which marker the element carries. `data-math` is a rendering a
    // human approved, `data-math-suggested` is the extractor's reconstruction
    // and is unchecked.
    //
    // Both halves have to survive the round trip. Keeping only the TeX would
    // silently promote every guess to a fact on the way back out; keeping only
    // the text would throw away work someone already did in TAFNE.
    if (el.hasAttribute?.('data-latex') || cls.includes('pdf-math-block')) {
        const latex = el.getAttribute('data-latex') || '';
        const confirmed = el.hasAttribute('data-math') || el.getAttribute('data-gx-annotated') === 'true';
        // On a confirmed block the visible text is KaTeX's glyph soup, so the
        // page's own words were stashed at annotation time. Prefer them.
        const text = (confirmed && el.getAttribute('data-math-source')) || _blockText(el);
        if (latex || text) {
            addBlock(page, {
                type: 'equation', latex, text: text || latex,
                ...(confirmed ? { confirmed: true } : {}),
                colIdx, ry,
            });
            return;
        }
    }

    // A bibliography block: one <li> per entry.
    if (cls.includes('pdf-references') || tag === 'ol' && cls.includes('pdf-references')) {
        const entries = [...el.querySelectorAll('li')].map(li => _blockText(li)).filter(Boolean);
        if (entries.length) {
            addBlock(page, {
                type: 'reference',
                entries,
                ...(el.hasAttribute('data-ref-continuation') ? { continuation: true } : {}),
                colIdx,
                ry,
            });
            return;
        }
    }

    // Running heads and page furniture. They arrive as <header>/<footer>, and
    // without this they were read as ordinary paragraphs — which is why a
    // running title reappeared in the middle of the body text on export.
    if (tag === 'header' || tag === 'footer') {
        addBlock(page, {
            type: 'paragraph',
            role: tag === 'header' ? 'header' : 'footer',
            text: _blockText(el),
            ...(alignFromClass(cls) ? { align: alignFromClass(cls) } : {}),
            ..._runs(el),
            colIdx,
            ry,
        });
        return;
    }

    if (tag === 'aside' && cls.includes('pdf-box')) {
        const kind = cls.includes('warning') ? 'warning'
            : cls.includes('caution') ? 'caution'
            : cls.includes('note') ? 'note'
            : cls.includes('tip') ? 'tip'
            : 'note';
        // A callout's contents are blocks, not a string. Walk them into a
        // nested block list with the same emitter the page uses, so a heading,
        // a bullet list or a table inside a panel survives the round trip as
        // what it is. `text` stays alongside for consumers that only want the
        // words — it is a rendering of the children, never the source of truth.
        const banner = el.querySelector?.('.pdf-box-banner')?.textContent?.trim() || '';
        const inner = { blocks: [] };
        _emitPage(el, inner, ctx);

        addBlock(page, {
            type: 'callout',
            kind,
            ...(banner ? { banner } : {}),
            text: _blockText(el),
            ...(inner.blocks.length ? { blocks: inner.blocks } : _runs(el)),
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
