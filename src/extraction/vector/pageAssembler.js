// pageAssembler.js
// Takes classified page regions and produces final HTML in document order.
//
// Each region type is rendered by its specialist:
//   TABLE     → buildTable() from tableBuilder.js
//   PARAGRAPH → rebuildText() from textRebuilder.js
//   HEADING   → <h3> or <h4> tag
//   LIST      → <ul>/<ol> with <li> items
//   IMAGE     → <figure> placeholder with dimensions
//
// Styling: each region gets class="fN ta-x" where fN is a font instance
// class and ta-x is one of ta-l / ta-c / ta-r / ta-j. Font instance classes
// are accumulated in a FontRegistry (passed in from geometryWorker) so a
// single document-level <style> block can be emitted after all pages are done.
//
// Regions arrive pre-sorted top→bottom from contextClassifier.

import { buildTable } from './tableBuilder.js';
import { rebuildText } from './textRebuilder.js';
import { RegionType } from './contextClassifier.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ── Font normalization ────────────────────────────────────────────────────────

/**
 * Parse a raw PDF font name into a CSS-ready { family, bold, italic } triple.
 * PDF font names are frequently subset-prefixed (ABCDEF+) and carry variant
 * suffixes (-BoldMT, -ItalicMT, etc.).
 */
function _normalizeFontFamily(rawName) {
    if (!rawName) return { family: 'inherit', bold: false, italic: false };

    // Strip 6-char uppercase subset prefix e.g. "ABCDEF+"
    const name = rawName.replace(/^[A-Z]{6}\+/, '');

    const bold = /bold|heavy|black/i.test(name);
    const italic = /italic|oblique|slanted/i.test(name);

    // Strip variant suffixes before family matching
    const base = name
        .replace(/[,\-](BoldItalicMT|BoldItalic|BoldMT|ItalicMT|Bold|Italic|Oblique|MT|PS|Regular|Roman|Light|Heavy|Black|Narrow|Condensed|Extended)+$/gi, '')
        .trim();

    let family = 'inherit';

    if (/arial|helvetica|freesans|nimbus.sans/i.test(base)) family = 'Arial, sans-serif';
    else if (/times|timesnewroman|cambria/i.test(base)) family = '"Times New Roman", serif';
    else if (/courier|freemono|nimbus.mono/i.test(base)) family = '"Courier New", monospace';
    else if (/georgia/i.test(base)) family = 'Georgia, serif';
    else if (/verdana/i.test(base)) family = 'Verdana, sans-serif';
    else if (/tahoma/i.test(base)) family = 'Tahoma, sans-serif';
    else if (/calibri|candara/i.test(base)) family = 'Calibri, sans-serif';
    else if (/trebuchet/i.test(base)) family = '"Trebuchet MS", sans-serif';
    else if (/garamond|ebgaramond/i.test(base)) family = 'Garamond, serif';
    else if (/palatino|bookantiqua/i.test(base)) family = '"Palatino Linotype", serif';
    else if (/lucida/i.test(base)) family = '"Lucida Sans", sans-serif';
    else if (/symbol|wingdings|zapf|dingbat/i.test(base)) family = 'inherit'; // non-text glyphs
    else if (/^[a-z_][a-z0-9_]{0,6}$/i.test(base)) family = 'inherit'; // short synthetic names

    return { family, bold, italic };
}

// ── Font registry ─────────────────────────────────────────────────────────────

/**
 * Create a fresh font registry for one document run.
 * The registry is a Map keyed by font fingerprint; each value holds the
 * generated class name and the CSS rule for that class.
 */
export function createFontRegistry() {
    const reg = new Map();
    reg._counter = 0;
    return reg;
}

function _registerFont(fontRegistry, family, sizePt, bold, italic) {
    const size = Math.round(sizePt) || 10;
    const key = `${family}|${size}|${bold ? 'b' : ''}${italic ? 'i' : ''}`;
    if (!fontRegistry.has(key)) {
        const cls = `f${fontRegistry._counter++}`;
        let css = `font-size: ${size}pt; font-family: ${family};`;
        if (bold) css += ' font-weight: bold;';
        if (italic) css += ' font-style: italic;';
        fontRegistry.set(key, { className: cls, cssLine: `.${cls} { ${css} }` });
    }
    return fontRegistry.get(key).className;
}

/**
 * Generate the complete document-level CSS string from a finalised font registry.
 * Call this once after all pages are assembled, then prepend the result as a
 * <style> block to the combined HTML.
 */
export function generateDocumentStyles(fontRegistry) {
    const fontLines = [...fontRegistry.values()].map(e => e.cssLine);

    const staticLines = [
        '.ta-l  { text-align: left; }',
        '.ta-c  { text-align: center; }',
        '.ta-r  { text-align: right; }',
        '.ta-j  { text-align: justify; }',
        '.bold  { font-weight: bold; }',
        '.ital  { font-style: italic; }',
        '.uline { text-decoration: underline; }',
        '.col-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }',
        '.col-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }',
        // Table variants
        '.pdf-table-wrap { overflow-x: auto; margin: 8px 0; }',
        '.pdf-table--lattice table   { border-collapse: collapse; width: 100%; }',
        '.pdf-table--lattice td, .pdf-table--lattice th { border: 1px solid #ccc; padding: 4px 8px; }',
        '.pdf-table--borderless table { border-collapse: collapse; width: 100%; }',
        '.pdf-table--borderless td, .pdf-table--borderless th { padding: 4px 12px 4px 0; }',
        // Semantic box containers
        '.pdf-box { border: 1.5px solid #888; border-radius: 3px; padding: 8px 14px; margin: 10px 0; }',
        '.pdf-box--warning { border-color: #d9534f; background: #fff5f5; }',
        '.pdf-box--caution { border-color: #e6a000; background: #fffbe6; }',
        '.pdf-box--note    { border-color: #0078d4; background: #f0f8ff; }',
        '.pdf-box--tip     { border-color: #107c10; background: #f4fff4; }',
        // Divider
        '.pdf-divider { border: none; border-top: 1px solid #ccc; margin: 14px 0; }',
        // Standalone list wrapper (prevents adjacent lists from merging in contenteditable)
        '.pdf-list-wrap { margin: 6px 0; }',
        '.pdf-list-wrap ol, .pdf-list-wrap ul { margin: 0; padding-left: 1.4em; }',
        '.pdf-list-wrap li { margin: 2px 0; }',
        // Zone / column layout
        '.pdf-zone { }',
        '.pdf-zone--cols-1 { }',
        '.pdf-zone--cols-2 { display: grid; grid-template-columns: repeat(2, 1fr); column-gap: 20px; }',
        '.pdf-zone--cols-3 { display: grid; grid-template-columns: repeat(3, 1fr); column-gap: 14px; }',
        '.pdf-zone--cols-4 { display: grid; grid-template-columns: repeat(4, 1fr); column-gap: 10px; }',
        '.pdf-col { min-width: 0; }',
        '.pdf-region { }',
        '@media (max-width: 720px) { .pdf-zone--cols-2, .pdf-zone--cols-3, .pdf-zone--cols-4 { grid-template-columns: 1fr; } }',
        // Running header / footer
        '.pdf-header { font-size: 0.78em; color: #555; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-bottom: 12px; }',
        '.pdf-footer { font-size: 0.78em; color: #555; border-top: 1px solid #ddd; padding-top: 4px; margin-top: 12px; }',
    ];

    return [...fontLines, ...staticLines].join('\n');
}

// ── Region font helpers ───────────────────────────────────────────────────────

function _getRegionFont(regionTextMeta) {
    if (!regionTextMeta.length) return { family: 'inherit', sizePt: 10, bold: false, italic: false };

    // Dominant font name (most frequent across items in the region)
    const counts = new Map();
    for (const tm of regionTextMeta) {
        const k = tm.fontName || '';
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    let domName = '';
    let domCount = 0;
    for (const [name, count] of counts) {
        if (count > domCount) { domCount = count; domName = name; }
    }

    const { family, bold, italic } = _normalizeFontFamily(domName);
    const sizePt = regionTextMeta.reduce((s, tm) => s + tm.fontSize, 0) / regionTextMeta.length;

    return { family, sizePt, bold, italic };
}

// ── Alignment inference ───────────────────────────────────────────────────────

function _stdDev(arr) {
    if (arr.length < 2) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

function _groupMetaByY(items, yTol) {
    const sorted = [...items].sort((a, b) => a.vy - b.vy);
    const lines = [];
    for (const tm of sorted) {
        let placed = false;
        for (const l of lines) {
            if (Math.abs(l.y - tm.vy) <= yTol) {
                l.items.push(tm);
                placed = true;
                break;
            }
        }
        if (!placed) lines.push({ y: tm.vy, items: [tm] });
    }
    return lines.map(l => l.items);
}

function _inferAlignment(items, bbox) {
    if (!items || items.length < 2) return 'left';

    // Use the median vFont as a local yTol for line grouping
    const fonts = items.map(i => i.vFont || 12).sort((a, b) => a - b);
    const medFont = fonts[Math.floor(fonts.length / 2)];
    const lines = _groupMetaByY(items, medFont * 0.45);
    if (lines.length < 2) return 'left';

    const leftEdges = lines.map(l => Math.min(...l.map(i => i.vx)));
    const rightEdges = lines.map(l => Math.max(...l.map(i => i.vx + (i.vWidth || 0))));
    const midPoints = lines.map((l, idx) => (leftEdges[idx] + rightEdges[idx]) / 2);

    const bw = bbox.w || 1;
    const normLeft = _stdDev(leftEdges) / bw;
    const normRight = _stdDev(rightEdges) / bw;
    const normMid = _stdDev(midPoints) / bw;

    if (normLeft < 0.01 && normRight < 0.03) return 'justify';
    if (normMid < 0.02) return 'center';
    if (normRight < 0.01 && normLeft > 0.02) return 'right';
    return 'left';
}

const ALIGN_CLASS = { left: 'ta-l', center: 'ta-c', right: 'ta-r', justify: 'ta-j' };

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Assemble a single page's HTML from its classified regions.
 *
 * @param {PageRegion[]}       regions      — sorted by yCenter (from classifyPage)
 * @param {TextMetaItem[]}     textMeta     — viewport-enriched items (from classifyPage)
 * @param {TextItem[]}         textItems    — full page textContent.items (PDF user-space)
 * @param {object}             viewport     — { width, height, transform }
 * @param {number}             pageWidthPt  — page width in PDF points
 * @param {number}             pageNum      — 1-based page number
 * @param {Map}                fontRegistry — shared registry; mutated in place
 * @param {number[]}           columnSplits — array of X coordinates for column gutters
 * @returns {{ html: string, text: string, tableCount: number }}
 */
export function assemblePage(regions, textMeta, textItems, viewport, pageWidthPt, pageNum, fontRegistry, columnSplits = [], extractedImages = {}) {
    const parts = [];
    const textParts = [];
    let tableCount = 0;

    const numCols = Math.max(1, columnSplits.length + 1);
    const pageWidth = viewport.width || 612;

    // Detect zone layout from classifier column assignments
    const autoZones = _detectAutoZones(regions, numCols);

    // Render each region wrapped in a .pdf-region sentinel that carries
    // its viewport-space Y/X so the zone toolbar can rearrange without
    // re-running the extractor.
    const rendered = regions.map(region => {
        const { html, text, tables } = _renderRegion(region, textMeta, textItems, viewport, pageWidthPt, fontRegistry, extractedImages);
        tableCount += tables;
        if (text) textParts.push(text);
        const ry = Math.round(region.yCenter ?? 0);
        const rx = Math.round(region.bbox?.x ?? 0);
        return {
            html: html ? `<div class="pdf-region" data-ry="${ry}" data-rx="${rx}">${html}</div>` : '',
            colIdx: region.columnIndex,
            ry,
            rx,
        };
    }).filter(r => r.html);

    const COL_NAMES = ['left', 'center', 'right'];

    for (const zone of autoZones) {
        const zoneRegions = rendered.filter(r => r.ry >= zone.y0 && r.ry < zone.y1);
        if (!zoneRegions.length) continue;

        if (zone.cols === 1) {
            parts.push(`<div class="pdf-zone pdf-zone--cols-1">${zoneRegions.map(r => r.html).join('\n')}</div>`);
        } else {
            const cols = zone.cols;
            const colGroups = Array.from({ length: cols }, () => []);
            for (const r of zoneRegions) {
                // Use classifier's column index if valid; X-based otherwise.
                const ci = (r.colIdx >= 0 && r.colIdx < cols)
                    ? r.colIdx
                    : Math.min(Math.floor(r.rx / pageWidth * cols), cols - 1);
                colGroups[ci].push(r);
            }
            const colDivs = colGroups.map((col, i) => {
                const name = cols <= 3 ? COL_NAMES[i] : `col-${i}`;
                return `<div class="pdf-col pdf-col--${name}">${col.map(r => r.html).join('\n')}</div>`;
            });
            parts.push(`<div class="pdf-zone pdf-zone--cols-${cols}">${colDivs.join('\n')}</div>`);
        }
    }

    const hasContent = parts.length > 0;
    const zonesJson = JSON.stringify(autoZones).replace(/'/g, '&#39;');
    const html = hasContent
        ? `<section class="pdf-page-content" data-page="${pageNum}" data-page-width="${Math.round(pageWidth)}" data-zones='${zonesJson}'>\n` +
          `<h4 class="page-label">Page ${pageNum}</h4>\n` +
          parts.join('\n') + '\n</section>'
        : '';

    return { html, text: textParts.join('\n\n'), tableCount };
}

// Group regions into contiguous zones of same column type (full-width vs N-col).
// Y boundaries are midpoints between adjacent groups so every region falls in
// exactly one zone.
function _detectAutoZones(regions, numCols) {
    if (!regions.length) return [{ y0: 0, y1: 99999, cols: 1 }];

    const sorted = [...regions].sort((a, b) => (a.yCenter ?? 0) - (b.yCenter ?? 0));

    const groups = [];
    let cur = { isFullWidth: sorted[0].columnIndex === -1, list: [sorted[0]] };
    for (let i = 1; i < sorted.length; i++) {
        const fw = sorted[i].columnIndex === -1;
        if (fw === cur.isFullWidth) {
            cur.list.push(sorted[i]);
        } else {
            groups.push(cur);
            cur = { isFullWidth: fw, list: [sorted[i]] };
        }
    }
    groups.push(cur);

    return groups.map((g, i) => {
        const prev = groups[i - 1];
        const next = groups[i + 1];
        const y0 = prev
            ? Math.round((prev.list[prev.list.length - 1].yCenter + g.list[0].yCenter) / 2)
            : 0;
        const y1 = next
            ? Math.round((g.list[g.list.length - 1].yCenter + next.list[0].yCenter) / 2)
            : 99999;
        return { y0, y1, cols: g.isFullWidth ? 1 : numCols };
    });
}

// Merge bold/italic/underlined flags from textMeta (which has the reliable
// font-style data from page.commonObjs) onto the raw PDF.js items so
// textRebuilder can emit <strong>/<em>/<u> wrappers per-item.
function _scopeItems(region, textItems, textMeta) {
    return region.textItemIndices.map(i => {
        const raw  = textItems[i];
        const meta = textMeta[i];
        if (!meta) return raw;
        const needsMerge = meta.bold || meta.italic || meta.underlined;
        if (!needsMerge) return raw;
        return {
            ...raw,
            bold:      meta.bold,
            italic:    meta.italic,
            underlined: meta.underlined,
        };
    });
}

function _renderRegion(region, textMeta, textItems, viewport, pageWidthPt, fontRegistry, extractedImages = {}) {
    let html = '';
    let text = '';
    let tables = 0;

    switch (region.type) {
        case RegionType.LATTICE_TABLE:
        case RegionType.TABLE: {          // TABLE kept as legacy alias
            if (!region.lattice) break;
            const scopedItems = region.textItemIndices.map(i => textItems[i]);
            const tableHtml = buildTable(region.lattice, scopedItems, viewport, new Set(), region.proximityPx);
            if (tableHtml) {
                html = `<div class="pdf-table-wrap pdf-table--lattice">${tableHtml}</div>`;
                tables = 1;
            }
            break;
        }

        case RegionType.STREAM_TABLE: {
            if (!region.lattice) break;
            const scopedItems = region.textItemIndices.map(i => textItems[i]);
            const tableHtml = buildTable(region.lattice, scopedItems, viewport, new Set(), region.proximityPx);
            if (tableHtml) {
                html = `<div class="pdf-table-wrap pdf-table--borderless">${tableHtml}</div>`;
                tables = 1;
            }
            break;
        }

        case RegionType.DIVIDER: {
            html = `<hr class="pdf-divider">`;
            break;
        }

        case RegionType.IMAGE: {
            html = `<div class="pdf-image-placeholder" style="width: 100%; height: auto; border: 2px dashed #ccc; display: flex; align-items: center; justify-content: center; background: #f9f9f9; color: #999; margin: 10px 0; position: relative; overflow: auto">` +
                `<span style="position: absolute; top: 8px; left: 8px; font-size: 10px; font-family: monospace;">[${region.id}]</span>` +
                `<img class="extracted-pdf-image" data-img-id="${region.id}" alt="PDF Image ${region.id}" style="max-width: 100%; max-height: 100%; object-fit: contain;">` +
                `</div>`;
            break;
        }

        case RegionType.HEADING: {
            const scopedItems = _scopeItems(region, textItems, textMeta);
            const scopedMeta  = region.textItemIndices.map(i => textMeta[i]);
            // Use inline-html to get styled runs without a wrapping <p>
            const headingHtml = rebuildText(scopedItems, pageWidthPt, { format: 'inline-html' });
            if (!headingHtml.trim()) break;

            const { family, sizePt, bold, italic } = _getRegionFont(scopedMeta);
            const fontClass  = _registerFont(fontRegistry, family, sizePt, bold, italic);
            const alignClass = ALIGN_CLASS[_inferAlignment(scopedMeta, region.bbox)] || 'ta-l';
            const tag = (region.fontSize || 14) > 18 ? 'h3' : 'h4';

            html = `<${tag} class="${fontClass} ${alignClass}">${headingHtml}</${tag}>`;
            text = rebuildText(scopedItems, pageWidthPt, { format: 'text' });
            break;
        }

        case RegionType.LIST: {
            const scopedItems = _scopeItems(region, textItems, textMeta);
            const scopedMeta  = region.textItemIndices.map(i => textMeta[i]);
            const rawList = _buildList(scopedItems, pageWidthPt, region.listOrdered);
            if (!rawList) break;

            const { family, sizePt, bold, italic } = _getRegionFont(scopedMeta);
            const fontClass = _registerFont(fontRegistry, family, sizePt, bold, italic);

            // Parse the raw <ul>/<ol> into standalone list with correct semantics
            html = _buildStandaloneList(rawList, fontClass);
            text = scopedItems.map(i => i.str?.trim()).filter(Boolean).join('\n');
            break;
        }

        case RegionType.PARAGRAPH: {
            const scopedItems = _scopeItems(region, textItems, textMeta);
            const scopedMeta  = region.textItemIndices.map(i => textMeta[i]);
            const paraHtml = rebuildText(scopedItems, pageWidthPt, { format: 'html' });
            if (!paraHtml.trim()) break;

            const { family, sizePt, bold, italic } = _getRegionFont(scopedMeta);
            const fontClass  = _registerFont(fontRegistry, family, sizePt, bold, italic);
            const alignClass = ALIGN_CLASS[_inferAlignment(scopedMeta, region.bbox)] || 'ta-l';

            // CSS inheritance propagates font-family/size/text-align down to <p> children
            html = `<div class="${fontClass} ${alignClass}">${paraHtml}</div>`;
            text = rebuildText(scopedItems, pageWidthPt, { format: 'text' });
            break;
        }

        case RegionType.BOX: {
            const scopedItems = _scopeItems(region, textItems, textMeta);
            const scopedMeta  = region.textItemIndices.map(i => textMeta[i]);
            const innerHtml = rebuildText(scopedItems, pageWidthPt, { format: 'html' });
            if (!innerHtml.trim()) break;

            const { family, sizePt, bold, italic } = _getRegionFont(scopedMeta);
            const fontClass  = _registerFont(fontRegistry, family, sizePt, bold, italic);
            const alignClass = ALIGN_CLASS[_inferAlignment(scopedMeta, region.bbox)] || 'ta-l';
            const roleClass  = region.boxRole && region.boxRole !== 'generic'
                ? ` pdf-box--${region.boxRole}` : '';

            // Only apply fill color if it's a meaningful chromatic/tinted shade.
            // Black ([0,0,0]) is the PDF default fill state — never set by the document —
            // and near-white is indistinguishable from the page background.
            const fc = region.fillColor;
            const isNeutral = !fc
                || fc.every(c => c > 0.92)           // near-white
                || fc.every(c => c < 0.08);           // near-black (PDF default)
            const bgStyle = isNeutral
                ? ''
                : ` style="background:rgb(${fc.map(c => Math.round(c * 255)).join(',')})"`;


            html = `<aside class="pdf-box${roleClass} ${fontClass} ${alignClass}"${bgStyle}>${innerHtml}</aside>`;
            text = rebuildText(scopedItems, pageWidthPt, { format: 'text' });
            break;
        }

        case RegionType.HEADER:
        case RegionType.FOOTER: {
            const scopedItems = _scopeItems(region, textItems, textMeta);
            const scopedMeta  = region.textItemIndices.map(i => textMeta[i]);
            const innerHtml   = rebuildText(scopedItems, pageWidthPt, { format: 'inline-html' });
            if (!innerHtml.trim()) break;

            const { family, sizePt, bold, italic } = _getRegionFont(scopedMeta);
            const fontClass = _registerFont(fontRegistry, family, sizePt, bold, italic);
            const tag = region.type === RegionType.HEADER ? 'header' : 'footer';

            html = `<${tag} class="pdf-${tag} ${fontClass}">${innerHtml}</${tag}>`;
            text = rebuildText(scopedItems, pageWidthPt, { format: 'text' });
            break;
        }
    }

    return { html, text, tables };
}

// ── List builder ──────────────────────────────────────────────────────────────

const BULLET_STRIP_RE = /^[•‣◦▪▫–—―·○o◦◉▪▫-]\s*/;
const ORDERED_STRIP_RE = /^(?:\d{1,3}[.)]\s*|[a-zA-Z][.)]\s*|[ivxIVX]+[.)]\s*)/;

// Inline-style helpers (mirrors textRebuilder without the module dependency)
function _itemStyle(item) {
    const name = (item.fontName || '').replace(/^[A-Z]{6}\+/, '');
    return {
        bold:      item.bold   ?? /bold|heavy|black/i.test(name),
        italic:    item.italic ?? /italic|oblique|slanted/i.test(name),
        underlined: !!item.underlined,
    };
}

function _wrapStyle(text, style) {
    let html = esc(text);
    if (style.underlined) html = `<u>${html}</u>`;
    if (style.italic)     html = `<em>${html}</em>`;
    if (style.bold)       html = `<strong>${html}</strong>`;
    return html;
}

function _buildList(textItems, pageWidthPt, isOrdered) {
    const valid = textItems.filter(i => i.str?.trim());
    if (!valid.length) return '';

    const fontSizes = valid.map(i => Math.abs(i.transform?.[3] || 12));
    const avgFont = fontSizes.reduce((a, b) => a + b, 0) / fontSizes.length;
    const yTol = avgFont * 0.45;

    const sorted = [...valid].sort((a, b) => b.transform[5] - a.transform[5]);
    const lines = [];

    for (const item of sorted) {
        const y = item.transform[5];
        let band = lines.find(l => Math.abs(l.y - y) <= yTol);
        if (band) {
            band.items.push(item);
            const n = band.items.length;
            band.y = (band.y * (n - 1) + y) / n;
        } else {
            lines.push({ y, items: [item] });
        }
    }

    for (const l of lines) l.items.sort((a, b) => a.transform[4] - b.transform[4]);

    const tag = isOrdered ? 'ol' : 'ul';
    const stripRe = isOrdered ? ORDERED_STRIP_RE : BULLET_STRIP_RE;

    const listItems = lines
        .map(l => {
            // Build styled spans per item then strip bullet marker from the first item
            const styled = l.items.map((item, idx) => {
                let str = item.str.trim();
                if (idx === 0) str = str.replace(stripRe, '').trim();
                return str ? _wrapStyle(str, _itemStyle(item)) : '';
            }).filter(Boolean).join(' ');
            return styled ? `<li>${styled}</li>` : '';
        })
        .filter(Boolean);

    if (!listItems.length) return '';
    return `<${tag}>\n${listItems.join('\n')}\n</${tag}>`;
}

/**
 * Wraps a raw <ul>/<ol> string as a standalone, semantically-correct list.
 *
 * Improvements over the previous rawList.replace() approach:
 *  - Detects ordered start number from the first <li> text prefix and sets start="N"
 *  - Strips numeric/bullet prefixes that _buildList may have left on <li> text
 *  - Detects nested items (deeper indentation prefix inside an <li>) and wraps
 *    them as child <ul>/<ol> inside the parent <li>
 *  - Wraps the whole thing in <div class="pdf-list-wrap"> so adjacent lists
 *    never merge in the DOM (contenteditable collapses adjacent same-type lists)
 */
function _buildStandaloneList(rawHtml, fontClass) {
    const isOrdered = rawHtml.trimStart().startsWith('<ol');

    // Parse via DOM (we're in a Worker — use a lightweight regex approach instead)
    // Extract all <li>...</li> contents
    const liContents = [];
    const liRe = /<li>([\s\S]*?)<\/li>/g;
    let m;
    while ((m = liRe.exec(rawHtml)) !== null) {
        liContents.push(m[1]);
    }
    if (!liContents.length) return rawHtml; // fallback — return as-is

    // Detect start number from first item's visible text
    const firstText = liContents[0].replace(/<[^>]+>/g, '').trim();
    const orderedStartMatch = /^(\d+)[.)]\s/.exec(firstText);
    const startNum = orderedStartMatch ? parseInt(orderedStartMatch[1], 10) : 1;

    // Build <li> elements — detect nested sub-items within each li
    const liTags = liContents.map(content => {
        const plainText = content.replace(/<[^>]+>/g, '').trim();
        // Strip leading bullet/number prefix that was kept by _buildList in edge cases
        const stripped = content
            .replace(/^(\s*(?:<[^>]+>\s*)*)(?:\d+[.)]\s*|[•‣◦▪▫–—―·○◦◉▪▫-]\s*)/, '$1');

        // Detect nested items: lines inside the content that begin with an
        // indented bullet or numbered prefix (after any inline tags)
        const nestedRe = /(?:<br\s*\/?>|\n)\s*([•‣◦▪▫–—*-]|\d+[.)])\s+/;
        if (nestedRe.test(stripped)) {
            // Split on <br> or newlines into sub-items
            const parts = stripped.split(/<br\s*\/?>/i);
            const primary = parts[0].trim();
            const subItems = parts.slice(1).filter(p => p.trim());

            if (subItems.length) {
                // Determine sub-list type from first sub-item prefix
                const firstSub = subItems[0].replace(/<[^>]+>/g, '').trim();
                const subIsOl  = /^\d+[.)]/.test(firstSub);
                const subTag   = subIsOl ? 'ol' : 'ul';
                const subLis   = subItems.map(s => {
                    const clean = s.replace(/^(?:\d+[.)]\s*|[•‣◦▪▫–—*-]\s*)/, '').trim();
                    return `<li>${clean}</li>`;
                }).join('');
                return `<li>${primary}<${subTag} class="${fontClass}">${subLis}</${subTag}></li>`;
            }
        }

        return `<li>${stripped}</li>`;
    });

    const tag        = isOrdered ? 'ol' : 'ul';
    const startAttr  = (isOrdered && startNum !== 1) ? ` start="${startNum}"` : '';
    const listHtml   = `<${tag} class="${fontClass}"${startAttr}>\n${liTags.join('\n')}\n</${tag}>`;

    return `<div class="pdf-list-wrap">${listHtml}</div>`;
}
