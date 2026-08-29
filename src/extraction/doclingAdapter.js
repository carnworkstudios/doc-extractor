// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 carnworkstudios
// ===================================================================================
// DOCLING ADAPTER — Docling assets → region-anchored pipeline HTML
// ===================================================================================
// Docling's own `export_to_html()` emits `<div class='page'>` and bare `<table>`.
// It carries none of the anchors the rest of this tool is built on:
//
//     data-region-id     -> 0
//     pdf-page-content   -> 0
//     data-page          -> 0
//
// Those anchors are not decoration. `tableOriginOf()` in `ui/exportController.js`
// resolves a table's return address with
// `closest('[data-region-id]')` + `closest('section.pdf-page-content[data-page]')`,
// and returns `null` when either is missing. A null origin means a table sent to
// TAFNE or the Schema Editor is UNADDRESSED — it arrives, and nothing can ever
// annotate back to the page and region it came from. The zone toolbar, the
// annotation layer and interactive region re-extract read the same anchors.
//
// So Docling cannot be routed straight to the document surface. This module
// rebuilds its output in the shape `pageAssembler.assemblePage` produces, which
// is the contract every downstream consumer already expects:
//
//   <article class="pdf-doc">
//     <section class="pdf-page-content" data-page="N" data-page-width="W" data-zones='[…]'>
//       <h4 class="page-label">Page N</h4>
//       <div class="pdf-table-wrap pdf-table--docling" data-region-id="…"><table>…</table></div>
//       <div class="pdf-image-placeholder" data-region-id="…"><img …></div>
//       <div class="pdf-region"><h2>…</h2><p>…</p></div>
//     </section>
//   </article>
//
// ── What this module decides, and what it refuses to ────────────────────────────
// It decides SHAPE: which Docling label becomes which element, how a grid with
// spans becomes a <table>, how items are grouped into pages. It decides nothing
// about correctness — no cell is rewritten, no header is inferred beyond the
// `column_header` flag Docling already set, no empty region is invented. Where
// Docling declares nothing (column zones), this emits the honest default rather
// than a guess.
// ===================================================================================

// Key derivation only — no IndexedDB is touched at import time, so this module
// stays loadable in the node checks.
import { cropKey } from '../utils/imageStore.js';

const LABEL_TAGS = {
    section_header: 'h2',
    title: 'h1',
    paragraph: 'p',
    text: 'p',
    caption: 'figcaption',
    list_item: 'li',
    footnote: 'aside',
    formula: 'p',
    page_header: null,   // furniture — see _isFurniture
    page_footer: null,
};

// Docling classifies running heads/feet as furniture. The geometry pipeline
// drops them from the content flow too, so carrying them through would make the
// two engines disagree on content that neither considers part of the document.
const FURNITURE_LABELS = new Set(['page_header', 'page_footer']);

// Docling's semantic label → the RegionType the geometry classifier would have
// assigned. This is the vocabulary the artifact panel's KIND_DEFS and the
// analyze panel's region layers are both keyed on, so a label that is not here
// falls back to PARAGRAPH rather than producing a region nothing can classify.
//
// `formula` maps to PARAGRAPH, not MATH: `_textHtml` renders it as a <p> with
// no `data-latex`, and an equation artifact whose LaTeX cannot be resolved is a
// tag that promises content it does not have.
const LABEL_REGION_TYPES = {
    title:          'HEADING',
    section_header: 'HEADING',
    list_item:      'LIST',
    caption:        'PARAGRAPH',
    footnote:       'PARAGRAPH',
    formula:        'PARAGRAPH',
    paragraph:      'PARAGRAPH',
    text:           'PARAGRAPH',
};

// The geometry worker rasterises at scale 2.0 and every `region.bbox` the rest
// of the tool consumes is in that space — analyzePanel converts its own 1.5-
// scale analysis canvas with `pg.widthPx * (2.0/1.5)` to meet it (see the SCALE
// TRAP note in app.js). Docling reports PDF points, so points × 2.0 is what
// puts a Docling region on the same canvas as a geometry one.
const WORKER_SCALE = 2.0;

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function _isFurniture(item) {
    return FURNITURE_LABELS.has(item.label) || item.content_layer === 'furniture';
}

// ── Geometry ────────────────────────────────────────────────────────────────
// Docling reports bboxes in PDF points with `coord_origin: "BOTTOMLEFT"`, where
// `t` is the TOP edge and is therefore the LARGER y. The pipeline's zone model
// is top-down viewport space (`region.yCenter` in `pageAssembler`), so every
// bbox has to be flipped against page height before it means anything here.
// Getting this backwards silently inverts the page: zones still compute, the
// bands are just upside down.
function _toTopDown(bbox, pageHeight) {
    if (!bbox) return null;
    const l = Number(bbox.l), r = Number(bbox.r);
    let t = Number(bbox.t), b = Number(bbox.b);
    if (![l, r, t, b].every(Number.isFinite)) return null;
    if (bbox.coord_origin === 'TOPLEFT') {
        // Already top-down; `t` is the smaller value.
        return { x0: Math.min(l, r), x1: Math.max(l, r), yTop: Math.min(t, b), yBot: Math.max(t, b) };
    }
    const H = Number(pageHeight);
    if (!Number.isFinite(H) || H <= 0) return null;
    const yTop = H - Math.max(t, b);
    const yBot = H - Math.min(t, b);
    return { x0: Math.min(l, r), x1: Math.max(l, r), yTop, yBot };
}

// An item this wide is a spanning element (heading, full-width table, rule).
// It cannot belong to one column, so it terminates whatever multi-column band
// was accumulating and forms a single-column band of its own.
const FULL_WIDTH_RATIO = 0.65;
// A gutter narrower than this is inter-word spacing, not a column boundary.
const MIN_GUTTER_RATIO = 0.025;
// Column boundaries live in the middle of the page. A gap at the margin is
// indentation, and treating it as a gutter invents a phantom empty column.
const GUTTER_ZONE = [0.15, 0.85];
// zoneToolbar cycles cols 1→4, so anything above 4 has no representable state.
const MAX_COLS = 4;

/**
 * How many columns does this run of items occupy?
 *
 * Projects every item's x-interval onto the page width and looks for maximal
 * UNCOVERED gaps — the gutters. Column count is gutters + 1.
 *
 * Gap detection rather than clustering of x-centers, because centers cluster
 * badly on ragged columns: a two-column page where one column holds a short
 * paragraph and the other a long one produces centers that overlap, while the
 * gutter between them stays empty on every line.
 */
function _columnsOf(items, pageWidth) {
    const spans = items.map(i => [i.x0, i.x1]).filter(s => s[1] > s[0]);
    if (spans.length < 2) return 1;

    spans.sort((a, b) => a[0] - b[0]);
    const merged = [spans[0].slice()];
    for (const [s, e] of spans.slice(1)) {
        const last = merged[merged.length - 1];
        if (s <= last[1]) last[1] = Math.max(last[1], e);
        else merged.push([s, e]);
    }

    const minGutter = pageWidth * MIN_GUTTER_RATIO;
    const lo = pageWidth * GUTTER_ZONE[0];
    const hi = pageWidth * GUTTER_ZONE[1];
    let gutters = 0;
    for (let i = 1; i < merged.length; i++) {
        const gapStart = merged[i - 1][1];
        const gapEnd = merged[i][0];
        const mid = (gapStart + gapEnd) / 2;
        if (gapEnd - gapStart >= minGutter && mid >= lo && mid <= hi) gutters++;
    }
    return Math.min(MAX_COLS, gutters + 1);
}

/**
 * Derive `{y0, y1, cols}` zone bands from item geometry.
 *
 * This is the layout Docling never reports. It classifies reading order and
 * region types but says nothing about column structure, so emitting a single
 * full-width band — which is what this adapter did first — throws away the
 * two-column structure of every paper and report that has one.
 *
 * Bands are cut where the page changes shape: a spanning item ends a
 * multi-column run. Boundaries sit midway between adjacent bands so every
 * region falls in exactly one zone, matching `_detectAutoZones` in
 * `pageAssembler`.
 */
function _detectZones(items, pageWidth) {
    const placed = items.filter(i => i.geom);
    if (!placed.length) return [{ y0: 0, y1: 99999, cols: 1 }];

    const sorted = [...placed].sort((a, b) => a.ry - b.ry);
    const runs = [];
    for (const it of sorted) {
        const wide = (it.x1 - it.x0) >= pageWidth * FULL_WIDTH_RATIO;
        const last = runs[runs.length - 1];
        if (last && last.wide === wide) last.items.push(it);
        else runs.push({ wide, items: [it] });
    }

    const bands = runs.map(run => ({
        cols: run.wide ? 1 : _columnsOf(run.items, pageWidth),
        yStart: Math.min(...run.items.map(i => i.ry)),
        yEnd: Math.max(...run.items.map(i => i.ry)),
    }));

    // Merge neighbours with the same column count — a heading between two
    // halves of the same two-column body should not split it into three zones
    // the user then has to re-merge by hand.
    const merged = [];
    for (const b of bands) {
        const last = merged[merged.length - 1];
        if (last && last.cols === b.cols) last.yEnd = b.yEnd;
        else merged.push({ ...b });
    }

    return merged.map((b, i) => ({
        y0: i === 0 ? 0 : Math.floor((merged[i - 1].yEnd + b.yStart) / 2),
        y1: i === merged.length - 1 ? 99999 : Math.ceil((b.yEnd + merged[i + 1].yStart) / 2),
        cols: b.cols,
    }));
}

/**
 * Page-local, type-scoped region ids, matching `_ensureRegionIds` in
 * `contextClassifier.js` (`lattice_table_0`, `image_1`). The `docling_` prefix
 * keeps provenance legible and guarantees no collision with a geometry id if
 * both engines ever contribute to one document.
 *
 * The ordinal is per page and per type, taken from the reading-order walk, so
 * it is stable across repeated extractions of the same document — the same
 * property `pdf-extraction-v2.md` relies on for synthesized ids.
 */
function _regionId(kind, pageOrdinal) {
    return `docling_${kind}_${pageOrdinal}`;
}

/**
 * A Docling table grid → HTML.
 *
 * `grid` is row-major with every cell present, INCLUDING the cells a span
 * covers — Docling repeats the origin cell across the area it spans. Emitting
 * those repeats would produce a table wider than `num_cols` and duplicate the
 * text, so covered positions are tracked and skipped.
 */
function _tableHtml(tbl) {
    const grid = tbl.grid || [];
    if (!grid.length) return '';

    const covered = new Set();
    const key = (r, c) => `${r}:${c}`;
    const headRows = [];
    const bodyRows = [];

    grid.forEach((row, r) => {
        const cells = [];
        let rowIsHeader = row.length > 0;
        (row || []).forEach((cell, c) => {
            if (covered.has(key(r, c))) return;
            const rs = Math.max(1, cell.row_span || 1);
            const cs = Math.max(1, cell.col_span || 1);
            for (let dr = 0; dr < rs; dr++) {
                for (let dc = 0; dc < cs; dc++) {
                    if (dr || dc) covered.add(key(r + dr, c + dc));
                }
            }
            const isHeader = !!(cell.column_header || cell.row_header);
            if (!cell.column_header) rowIsHeader = false;
            const tag = isHeader ? 'th' : 'td';
            const attrs =
                (rs > 1 ? ` rowspan="${rs}"` : '') +
                (cs > 1 ? ` colspan="${cs}"` : '');
            cells.push(`<${tag}${attrs}>${esc(cell.text)}</${tag}>`);
        });
        if (!cells.length) return;
        (rowIsHeader ? headRows : bodyRows).push(`<tr>${cells.join('')}</tr>`);
    });

    // Header rows only form a <thead> while they are still the leading rows.
    // A `column_header` cell appearing mid-table is a repeated header inside
    // the body, and hoisting it into <thead> would reorder the document.
    let html = '';
    if (headRows.length) html += `<thead>\n${headRows.join('\n')}\n</thead>\n`;
    if (bodyRows.length) html += `<tbody>\n${bodyRows.join('\n')}\n</tbody>`;
    if (!html) return '';

    const caption = (tbl.captions || [])[0];
    const capHtml = caption ? `<caption>${esc(caption)}</caption>\n` : '';
    return `<table class="tablecoil">\n${capHtml}${html}\n</table>`;
}

/**
 * @param {number} page      1-based page, half of the blob-store key.
 * @param {object|null} sink `{ storeKey: dataUrl }` collector. Docling hands us
 *   the picture as base64, but base64 is not what goes in the document — the
 *   caller moves these into the blob store and the page keeps only the key.
 *   This function stays pure (it is asserted in a node check with no IndexedDB),
 *   so it collects rather than writes.
 */
function _pictureHtml(pic, regionId, page, sink, docId) {
    const caption = (pic.captions || [])[0];
    const capHtml = caption ? `<figcaption>${esc(caption)}</figcaption>` : '';
    if (pic.image) {
        const key = cropKey(docId, page, regionId);
        if (sink) sink[key] = pic.image;
        return `<div class="pdf-image-placeholder" data-region-id="${esc(regionId)}" style="margin: 10px 0;">`
            + `<img class="extracted-pdf-image" data-img-id="${esc(key)}" alt="PDF Image ${esc(regionId)}" `
            + `style="max-width: 100%; height: auto; display: block;">${capHtml}</div>`;
    }
    // No raster came back. Reserve space from the bbox so the page does not
    // reflow, and keep the region addressable — an image the user can still
    // tag and send is worth more than a dropped region.
    const bbox = pic.bbox || {};
    const w = Math.abs((bbox.r ?? 0) - (bbox.l ?? 0));
    const h = Math.abs((bbox.t ?? 0) - (bbox.b ?? 0));
    const aspect = (w > 0 && h > 0)
        ? `aspect-ratio: ${Math.round(w)} / ${Math.round(h)}; height: auto;`
        : 'min-height: 120px;';
    return `<div class="pdf-image-placeholder" data-region-id="${esc(regionId)}" `
        + `style="${aspect} border: 2px dashed #ccc; background: #f9f9f9; margin: 10px 0;">`
        + `<span style="display:block; padding:8px; font-size:10px; font-family:monospace; color:#999;">[${esc(regionId)}]</span>`
        + `${capHtml}</div>`;
}

function _textHtml(item) {
    const tag = LABEL_TAGS[item.label] ?? 'p';
    // Wrap the anchored text of any link carried by this block in <a href>,
    // exactly as the geometry pipeline does for LinkAnnotations. The link text
    // is the child's own `text` (precise, from Docling's body), so a straight
    // substring replace is reliable — no geometry-to-word guessing.
    let text = item.text;
    if (item.links && item.links.length) {
        let out = '';
        let remaining = text;
        for (const l of item.links) {
            if (!l.href || !l.text) continue;
            const idx = remaining.indexOf(l.text);
            if (idx < 0) continue;
            out += esc(remaining.slice(0, idx));
            out += `<a href="${esc(l.href)}" data-link-source="docling" data-link-page="${esc(String(item.page_no ?? ''))}">${esc(l.text)}</a>`;
            remaining = remaining.slice(idx + l.text.length);
        }
        text = out + esc(remaining);
    } else {
        text = esc(text);
    }
    if (item.label === 'section_header' && item.level) {
        const h = Math.min(6, Math.max(1, Number(item.level) + 1));
        return `<h${h}>${text}</h${h}>`;
    }
    if (tag === 'li') return `<ul><li>${text}</li></ul>`;
    return `<${tag}>${text}</${tag}>`;
}

/**
 * `data-link` attribute for a docling region that a link points at but cannot
 * carry as an inline <a> — a picture or table. Text blocks wrap their links
 * themselves via `_textHtml`; these stay on the wrapper, mirroring the
 * geometry pipeline's `_regionLinkAttr`. Link bboxes are pdf points
 * (BOTTOMLEFT), the same space as `obj.bbox`, so both go through `_toTopDown`.
 */
function _regionLinkAttr(item, links, pageHeight) {
    if (!item.geom || !links || !links.length) return '';
    const hrefs = [];
    for (const l of links) {
        if (!l.href) continue;
        const g = _toTopDown(l.bbox, pageHeight);
        if (!g) continue;
        const overlaps = item.x0 <= g.x1 && item.x1 >= g.x0 && item.yTop <= g.yBot && item.yBot >= g.yTop;
        if (overlaps) hrefs.push(l.href);
    }
    return hrefs.length ? ` data-link="${hrefs.join(',')}"` : '';
}

/**
 * One placed item → the region object the rest of the tool consumes.
 *
 * `bbox` is worker space (PDF points × 2.0) so the analyze canvas can draw it
 * with the same `rScale` it uses for a geometry region. An item Docling gave no
 * usable bbox for gets NO bbox rather than a zeroed one: the canvas skips a
 * region without a box, whereas a fake box at the origin draws a wrong claim
 * over the top-left corner of the page. It is still a real artifact — the panel
 * lists it and it resolves through its id — it just cannot be drawn.
 *
 * `confidence` is absent on purpose. Docling's `extract_assets` reports no
 * per-region score, and stamping 1.0 would present a neural detector's guess as
 * a measurement.
 */
function _toRegion(it) {
    return {
        id: it.id,
        type: it.regionType,
        algorithm: 'docling',
        yCenter: it.ry,
        columnIndex: -1,
        ...(it.geom ? {
            bbox: {
                x: it.x0 * WORKER_SCALE,
                y: it.yTop * WORKER_SCALE,
                w: (it.x1 - it.x0) * WORKER_SCALE,
                h: (it.yBot - it.yTop) * WORKER_SCALE,
            },
        } : {}),
    };
}

/**
 * Rebuild Docling's output as region-anchored pipeline HTML.
 *
 * @param {string} docId   namespaces this document's pictures in the blob
 *                         store, so a second document cannot overwrite them.
 * @param {object} assets  backend `extract_assets` output — needs `order`,
 *                         `texts`, `tables`, `pictures`, `page_sizes`.
 * @returns {{html:string, text:string, tableCount:number, pages:Array,
 *            regionCount:number, images:Object}} — `images` maps blob-store key
 *            to the base64 the backend sent; the caller writes it to the store.
 *            Each `pages[]` entry carries a `regions` array in the geometry
 *            worker's shape; the caller must publish it (`pushRegionPage`) or
 *            the document arrives with no artifacts.
 */
export function doclingToRegionHtml(assets, docId = null) {
    const order = assets?.order || [];
    const tables = assets?.tables || [];
    const pictures = assets?.pictures || [];
    const pageSizes = assets?.page_sizes || {};
    const links = assets?.links || [];

    // `texts` is filtered server-side (empty blocks dropped), so array position
    // is NOT the ref index. `order` addresses the original index, so look up by
    // the `index` field or the walk silently reads the wrong block.
    const textsByIndex = new Map();
    for (const t of assets?.texts || []) textsByIndex.set(t.index, t);

    // Reading order is authoritative. Falling back to bbox sort would scramble
    // multi-column pages, so when Docling gives no order we emit items in
    // declaration order instead of inventing one.
    const walk = order.length
        ? order
        : [
            ...(assets?.texts || []).map(t => ({ kind: 'texts', index: t.index })),
            ...tables.map((_, i) => ({ kind: 'tables', index: i })),
            ...pictures.map((_, i) => ({ kind: 'pictures', index: i })),
        ];

    const byPage = new Map();          // pageNo -> { items: [] }
    const perPageOrdinal = new Map();  // `${page}:${kind}` -> next ordinal

    const nextOrdinal = (page, kind) => {
        const k = `${page}:${kind}`;
        const n = perPageOrdinal.get(k) || 0;
        perPageOrdinal.set(k, n + 1);
        return n;
    };

    let tableCount = 0;
    let regionCount = 0;
    // { storeKey: dataUrl } for every picture that came back with pixels. The
    // caller persists these to the blob store; the HTML only references them.
    const images = {};

    for (const ref of walk) {
        let obj = null;
        if (ref.kind === 'texts') obj = textsByIndex.get(ref.index);
        else if (ref.kind === 'tables') obj = tables[ref.index];
        else if (ref.kind === 'pictures') obj = pictures[ref.index];
        if (!obj) continue;                 // filtered out server-side (empty text)
        if (_isFurniture(obj)) continue;

        // An object with no page cannot be placed. Page 1 is a guess that puts
        // content on the wrong page and gives it a wrong return address, which
        // is worse than omitting it — so it is skipped and counted by the caller
        // via the region total.
        const page = obj.page_no;
        if (page == null) continue;

        if (!byPage.has(page)) byPage.set(page, []);
        const bucket = byPage.get(page);

        // Geometry drives both the zone bands and the per-region `data-ry` /
        // `data-rx` the zone toolbar reads. An item with no usable bbox still
        // renders — it just cannot participate in column layout.
        const pageH = pageSizes[String(page)]?.height;
        const geom = _toTopDown(obj.bbox, pageH);
        const common = geom
            ? { geom: true, ry: Math.round((geom.yTop + geom.yBot) / 2), rx: Math.round(geom.x0), x0: geom.x0, x1: geom.x1, yTop: geom.yTop, yBot: geom.yBot }
            : { geom: false, ry: bucket.length, rx: 0, x0: 0, x1: 0, yTop: 0, yBot: 0 };

        if (ref.kind === 'tables') {
            const inner = _tableHtml(obj);
            if (!inner) continue;
            const id = _regionId('table', nextOrdinal(page, 'table'));
            bucket.push({
                ...common,
                type: 'table',
                // TableFormer recovers a ruled grid from the page image, so the
                // structure is a lattice reconstruction, not a whitespace guess.
                regionType: 'LATTICE_TABLE',
                id,
                html: `<div class="pdf-table-wrap pdf-table--docling" data-region-id="${esc(id)}">${inner}</div>`,
                text: (obj.grid || []).map(r => r.map(c => c.text).join('\t')).join('\n'),
            });
            tableCount++;
            regionCount++;
        } else if (ref.kind === 'pictures') {
            const id = _regionId('image', nextOrdinal(page, 'image'));
            bucket.push({
                ...common,
                type: 'image',
                regionType: 'IMAGE',
                id,
                html: _pictureHtml(obj, id, page, images, docId),
                text: (obj.captions || [])[0] || '',
            });
            regionCount++;
        } else {
            // A text block needs an id for exactly the same reason a table does:
            // without one it has no return address, the artifact panel cannot
            // resolve it, and it can never be sent anywhere. The id is scoped by
            // REGION TYPE rather than by "text", mirroring the geometry
            // classifier's `heading_0` / `paragraph_3` so the two engines
            // produce the same shape of id for the same kind of thing.
            const regionType = LABEL_REGION_TYPES[obj.label] || 'PARAGRAPH';
            const id = _regionId(regionType.toLowerCase(), nextOrdinal(page, regionType));
            bucket.push({
                ...common,
                type: 'text',
                regionType,
                id,
                html: _textHtml(obj),
                text: obj.text,
            });
            regionCount++;
        }
    }

    const pages = [];
    const htmlParts = [];
    const textParts = [];

    for (const pageNo of [...byPage.keys()].sort((a, b) => a - b)) {
        const items = byPage.get(pageNo);
        if (!items.length) continue;

        // EVERY item gets its own `.pdf-region` wrapper carrying `data-ry` /
        // `data-rx`, exactly as `pageAssembler` emits them. This is not
        // cosmetic: `applyZones` filters regions with
        // `r.ry >= zone.y0 && r.ry < zone.y1` and buckets them into columns
        // with `Math.floor(r.rx / pageWidth * cols)`. A region missing these
        // attributes parses as NaN, fails every comparison, and is DROPPED —
        // so grouping items under a shared wrapper would make the first click
        // on a zone chip erase the page.
        const width = Math.round(pageSizes[String(pageNo)]?.width || 612);
        const pageLinks = links.filter(l => l.page_no === pageNo);
        const pageHeight = pageSizes[String(pageNo)]?.height;
        const body = items.map(it => {
            // Links pointing at a picture or table ride on the wrapper (text
            // blocks already wrap their own inline links).
            const linkAttr = (it.type === 'image' || it.type === 'table')
                ? _regionLinkAttr(it, pageLinks, pageHeight)
                : '';
            // The id goes on the `.pdf-region` sentinel for every item. Tables
            // and pictures also carry it on their own leaf (and the leaf wins in
            // `htmlToGxDoc._emitAddressable`); a text block has no leaf that
            // could hold it, which is why every heading and paragraph Docling
            // produced used to be unaddressable and therefore un-sendable.
            // Kept AFTER data-ry/data-rx: the adapter check reads `data-ry` as
            // the first attribute of the wrapper.
            return `<div class="pdf-region" data-ry="${it.ry}" data-rx="${it.rx}"`
                + ` data-region-id="${esc(it.id)}"${linkAttr}>${it.html}</div>`;
        });

        const zones = _detectZones(items, width);
        const zonesJson = JSON.stringify(zones);

        htmlParts.push(
            `<article class="pdf-doc">\n`
            + `<section class="pdf-page-content" data-page="${pageNo}" data-page-width="${width}" `
            + `data-zones='${zonesJson}' data-engine="docling">\n`
            + `<h4 class="page-label">Page ${pageNo}</h4>\n`
            + body.join('\n')
            + `\n</section>\n</article>`,
        );
        textParts.push(items.map(i => i.text).filter(Boolean).join('\n\n'));
        pages.push({
            pageNum: pageNo,
            // `page` as well as `pageNum`: the geometry pipeline's per-page
            // results key on `page`, and `mountExtractedDocument` replays
            // regions with `p.page`. Carrying both means a Docling document can
            // be re-mounted (batch focus, slot swap) without losing its regions
            // to a field-name mismatch.
            page: pageNo,
            tableCount: items.filter(i => i.type === 'table').length,
            regionCount: items.length,
            // The regions themselves, in the shape the geometry worker emits.
            // The analyze canvas draws these, the artifact panel turns each one
            // into a tag, and a cross-tool send resolves the tag back through
            // `getRegionHtml(page, id)` — none of which happened on the Docling
            // path, because it published HTML and never published regions.
            regions: items.map(_toRegion),
            // The detected layout, so the Analyze tab can report what was found
            // and a re-extract can be tuned against it rather than guessed at.
            zones,
            maxCols: Math.max(...zones.map(z => z.cols)),
            placedRegions: items.filter(i => i.geom).length,
            source: 'docling',
        });
    }

    return {
        html: htmlParts.join('\n'),
        text: textParts.join('\n\n'),
        tableCount,
        pages,
        regionCount,
        images,
    };
}
