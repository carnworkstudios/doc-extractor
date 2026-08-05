/**
 * gxDocToHtml.js
 * gx-doc/1 → zone-aware CSS Grid HTML — the single render path for the IR.
 *
 * Mirrors the structure pageAssembler.js produces so the existing CSS applies
 * unchanged (src/styles.css and the document-level <style> block emitted here):
 *   <article class="pdf-doc">
 *     <section class="pdf-page-content" data-page="N" data-page-width="…">
 *       <div class="pdf-page-row pdf-page-row--cols-1">
 *         <div class="pdf-col pdf-col--full" data-col-id="full">…</div>
 *       </div>
 *       <div class="pdf-page-row" style="--left-col: 0.55">
 *         <div class="pdf-col pdf-col--left" data-col-id="col-0">…</div>
 *         <div class="pdf-col pdf-col--right" data-col-id="col-1">…</div>
 *       </div>
 *     </section>
 *   </article>
 *
 * Pure string output — no DOM, no global state.
 */

// Static layout CSS the assembler injects per-document (generateDocumentStyles
// minus the per-page font classes). Emitted so gx-doc output renders correctly
// in the Doc view and stands alone in exported HTML/DOCX envelopes.
const LAYOUT_CSS = `
.pdf-doc .ta-l  { text-align: left; }
.pdf-doc .ta-c  { text-align: center; }
.pdf-doc .ta-r  { text-align: right; }
.pdf-doc .ta-j  { text-align: justify; }
.pdf-doc .pdf-page-row { display: grid; grid-template-columns: calc(var(--left-col, 0.5) * 100%) 1fr; column-gap: 20px; }
.pdf-doc .pdf-page-row--cols-1 { display: block; }
.pdf-doc .pdf-page-row--cols-3 { grid-template-columns: repeat(3, 1fr); column-gap: 14px; }
.pdf-doc .pdf-page-row--cols-4 { grid-template-columns: repeat(4, 1fr); column-gap: 10px; }
.pdf-doc .pdf-col { min-width: 0; }
.pdf-doc .pdf-col--full { grid-column: 1 / -1; }
.pdf-doc .pdf-col--left { padding-right: 10px; }
.pdf-doc .pdf-col--center { padding-left: 10px; padding-right: 10px; }
.pdf-doc .pdf-col--right { padding-left: 10px; }
.pdf-doc .pdf-table-wrap { overflow-x: auto; margin: 8px 0; }
.pdf-doc .pdf-table--lattice table { border-collapse: collapse; width: 100%; }
.pdf-doc .pdf-table--lattice td, .pdf-doc .pdf-table--lattice th { border: 1px solid #ccc; padding: 4px 8px; }
.pdf-doc .pdf-table--borderless table { border-collapse: collapse; width: 100%; }
.pdf-doc .pdf-table--borderless td, .pdf-doc .pdf-table--borderless th { padding: 4px 12px 4px 0; }
.pdf-doc .pdf-box { border: 1.5px solid #888; border-radius: 3px; padding: 8px 14px; margin: 10px 0; }
.pdf-doc .pdf-box--warning { border-color: #111; background: #fff5f5; }
.pdf-doc .pdf-box--caution { border-color: #111; background: #fffbe6; }
.pdf-doc .pdf-box--note { border-color: #111; background: #f0f8ff; }
.pdf-doc .pdf-box--tip { border-color: #107c10; background: #f4fff4; }
.pdf-doc .pdf-divider { border: none; border-top: 1px solid #ccc; margin: 14px 0; }
.pdf-doc .pdf-list-wrap { margin: 6px 0; }
.pdf-doc .pdf-list-wrap ol, .pdf-doc .pdf-list-wrap ul { margin: 0; padding-left: 1.4em; }
.pdf-doc .pdf-list-wrap li { margin: 2px 0; }
.pdf-doc .pdf-paragraph { margin: 0.5em 0; }
@media (max-width: 720px) { .pdf-doc .pdf-page-row { grid-template-columns: 1fr; } }
`;

const COL_NAMES = ['left', 'center', 'right'];

/** Render a gx-doc to HTML. */
export function gxDocToHtml(gxDoc) {
    const pages = (gxDoc && Array.isArray(gxDoc.pages)) ? gxDoc.pages : [];
    const pageHtml = pages.map(_pageToHtml).filter(Boolean);
    if (!pageHtml.length) return '';
    return `<article class="pdf-doc">\n<style class="pdf-ir-styles">${LAYOUT_CSS}\n</style>\n${pageHtml.join('\n')}\n</article>`;
}

function _pageToHtml(page) {
    const pageNum = page.page ?? 1;
    const width = Math.round(page.width ?? 0);
    const zones = (Array.isArray(page.zones) && page.zones.length)
        ? page.zones
        : [{ y0: 0, y1: Infinity, cols: 1, layout: 'full' }];
    const blocks = Array.isArray(page.blocks) ? page.blocks : [];
    if (!blocks.length) return '';

    const grouped = _groupByZone(blocks, zones);
    const body = grouped.map(_zoneToHtml).filter(Boolean).join('\n');
    if (!body) return '';

    const zonesAttr = (Array.isArray(page.zones) && page.zones.length)
        ? ` data-zones='${JSON.stringify(page.zones).replace(/'/g, '&#39;')}'`
        : '';
    return `<section class="pdf-page-content" data-page="${pageNum}" data-page-width="${width}"${zonesAttr}>\n${body}\n</section>`;
}

/** Assign each block to the zone whose [y0, y1) contains its ry. */
function _groupByZone(blocks, zones) {
    const assigned = zones.map(z => ({ ...z, blocks: [] }));
    for (const block of blocks) {
        const ry = Number.isFinite(block.ry) ? block.ry : 0;
        let zi = zones.length - 1;
        for (let i = 0; i < zones.length; i++) {
            const z = zones[i];
            if (ry >= (z.y0 ?? 0) && ry < (z.y1 ?? Infinity)) { zi = i; break; }
        }
        assigned[zi].blocks.push(block);
    }
    return assigned;
}

function _zoneToHtml(zone) {
    const blocks = zone.blocks.slice().sort((a, b) => (a.ry ?? 0) - (b.ry ?? 0));
    if (!blocks.length) return '';
    const numCols = zone.cols ?? 1;

    if (numCols <= 1) {
        const inner = blocks.map(_blockToHtml).join('\n');
        return `<div class="pdf-page-row pdf-page-row--cols-1">\n` +
               `<div class="pdf-col pdf-col--full" data-col-id="full">\n${inner}\n</div>\n</div>`;
    }

    // Full-width blocks inside a multi-column zone get their own spanning row so
    // grid-column: 1 / -1 content stays in reading order (mirrors _buildPageRow).
    const fullBlocks = blocks.filter(b => (b.colIdx ?? -1) === -1);
    const colBlocks = blocks.filter(b => (b.colIdx ?? -1) !== -1);

    const parts = [];
    if (fullBlocks.length) {
        const inner = fullBlocks.map(_blockToHtml).join('\n');
        parts.push(`<div class="pdf-page-row pdf-page-row--cols-1">\n` +
                   `<div class="pdf-col pdf-col--full" data-col-id="full">\n${inner}\n</div>\n</div>`);
    }

    if (colBlocks.length) {
        const leftFraction = Number.isFinite(zone.leftFraction) ? zone.leftFraction : 0.5;
        const rowModifier = numCols === 3 ? ' pdf-page-row--cols-3'
            : numCols === 4 ? ' pdf-page-row--cols-4'
            : '';
        const styleAttr = numCols === 2 ? ` style="--left-col: ${leftFraction.toFixed(4)};"` : '';

        const buckets = Array.from({ length: numCols }, () => []);
        for (const b of colBlocks) {
            const ci = Math.min(Math.max(b.colIdx, 0), numCols - 1);
            buckets[ci].push(b);
        }
        for (const bucket of buckets) bucket.sort((a, b) => (a.ry ?? 0) - (b.ry ?? 0));

        const colDivs = buckets.map((bucket, i) => {
            if (!bucket.length) return '';
            const name = numCols <= 3 ? (COL_NAMES[i] || `col-${i}`) : `col-${i}`;
            const inner = bucket.map(_blockToHtml).join('\n');
            return `<div class="pdf-col pdf-col--${name}" data-col-id="col-${i}">\n${inner}\n</div>`;
        }).filter(Boolean);

        parts.push(`<div class="pdf-page-row${rowModifier}"${styleAttr}>\n${colDivs.join('\n')}\n</div>`);
    }

    return parts.join('\n');
}

const ALIGN_CLASS = { left: 'ta-l', center: 'ta-c', right: 'ta-r', justify: 'ta-j' };

function _blockToHtml(block) {
    const alignClass = ALIGN_CLASS[block.align] || '';

    switch (block.type) {
        case 'heading': {
            const level = Math.min(Math.max(block.level || 1, 1), 6);
            const cls = alignClass ? ` class="${alignClass}"` : '';
            return `<h${level}${cls}>${_runsHtml(block)}</h${level}>`;
        }
        case 'paragraph':
            return `<div class="pdf-paragraph f1${alignClass ? ` ${alignClass}` : ''}">${_runsHtml(block)}</div>`;
        case 'table':
            return _tableToHtml(block);
        case 'list': {
            const tag = block.ordered ? 'ol' : 'ul';
            const items = (block.items || []).map(item => `<li>${esc(item)}</li>`).join('');
            return `<div class="pdf-list-wrap">${items ? `<${tag}>${items}</${tag}>` : ''}</div>`;
        }
        case 'callout': {
            const kind = block.kind || 'note';
            return `<aside class="pdf-box pdf-box--${esc(kind)}">${_runsHtml(block)}</aside>`;
        }
        case 'divider':
            return '<hr class="pdf-divider">';
        case 'image': {
            const id = esc(block.id || 'img');
            const alt = esc(block.alt || '');
            return `<div class="pdf-image-placeholder"><img class="extracted-pdf-image" data-img-id="${id}" alt="${alt}"></div>`;
        }
        default:
            return `<div class="pdf-paragraph f1 ${align}">${_runsHtml(block)}</div>`;
    }
}

function _tableToHtml(block) {
    const latticeClass = block.borderless ? 'pdf-table--borderless' : 'pdf-table--lattice';
    const tableClass = block.borderless ? 'tablecoil borderless' : 'tablecoil';
    const conf = block.confidence != null ? ` data-confidence="${block.confidence}"` : '';
    const head = (block.headers && block.headers.length)
        ? `<tr>${block.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>`
        : '';
    const body = (block.rows || []).map(row =>
        `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`,
    ).join('');
    return `<div class="pdf-table-wrap ${latticeClass}">\n` +
           `<table class="${tableClass}"${conf}>\n<tbody>\n${head}${body}\n</tbody>\n</table>\n</div>`;
}

/** Render a block's runs to inline HTML; falls back to its plain text. */
function _runsHtml(block) {
    if (!Array.isArray(block.runs) || !block.runs.length) {
        return esc(block.text || '');
    }
    return block.runs.map(r => {
        let s = esc(r.text || '');
        if (r.bold) s = `<strong>${s}</strong>`;
        if (r.italic) s = `<em>${s}</em>`;
        if (r.superscript) s = `<sup>${s}</sup>`;
        if (r.subscript) s = `<sub>${s}</sub>`;
        return s;
    }).join('');
}

function esc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
