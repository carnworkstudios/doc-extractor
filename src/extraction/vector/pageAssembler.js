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

    const bold   = /bold|heavy|black/i.test(name);
    const italic = /italic|oblique|slanted/i.test(name);

    // Strip variant suffixes before family matching
    const base = name
        .replace(/[,\-](BoldItalicMT|BoldItalic|BoldMT|ItalicMT|Bold|Italic|Oblique|MT|PS|Regular|Roman|Light|Heavy|Black|Narrow|Condensed|Extended)+$/gi, '')
        .trim();

    let family = 'inherit';

    if      (/arial|helvetica|freesans|nimbus.sans/i.test(base))  family = 'Arial, sans-serif';
    else if (/times|timesnewroman|cambria/i.test(base))           family = '"Times New Roman", serif';
    else if (/courier|freemono|nimbus.mono/i.test(base))          family = '"Courier New", monospace';
    else if (/georgia/i.test(base))                               family = 'Georgia, serif';
    else if (/verdana/i.test(base))                               family = 'Verdana, sans-serif';
    else if (/tahoma/i.test(base))                                family = 'Tahoma, sans-serif';
    else if (/calibri|candara/i.test(base))                       family = 'Calibri, sans-serif';
    else if (/trebuchet/i.test(base))                             family = '"Trebuchet MS", sans-serif';
    else if (/garamond|ebgaramond/i.test(base))                   family = 'Garamond, serif';
    else if (/palatino|bookantiqua/i.test(base))                  family = '"Palatino Linotype", serif';
    else if (/lucida/i.test(base))                                family = '"Lucida Sans", sans-serif';
    else if (/symbol|wingdings|zapf|dingbat/i.test(base))        family = 'inherit'; // non-text glyphs
    else if (/^[a-z_][a-z0-9_]{0,6}$/i.test(base))              family = 'inherit'; // short synthetic names

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
    const key  = `${family}|${size}|${bold ? 'b' : ''}${italic ? 'i' : ''}`;
    if (!fontRegistry.has(key)) {
        const cls = `f${fontRegistry._counter++}`;
        let css = `font-size: ${size}pt; font-family: ${family};`;
        if (bold)   css += ' font-weight: bold;';
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
    const lines  = [];
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

    const leftEdges  = lines.map(l => Math.min(...l.map(i => i.vx)));
    const rightEdges = lines.map(l => Math.max(...l.map(i => i.vx + (i.vWidth || 0))));
    const midPoints  = lines.map((l, idx) => (leftEdges[idx] + rightEdges[idx]) / 2);

    const bw = bbox.w || 1;
    const normLeft  = _stdDev(leftEdges)  / bw;
    const normRight = _stdDev(rightEdges) / bw;
    const normMid   = _stdDev(midPoints)  / bw;

    if (normLeft < 0.01 && normRight < 0.03) return 'justify';
    if (normMid  < 0.02)                     return 'center';
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
 * @returns {{ html: string, text: string, tableCount: number }}
 */
export function assemblePage(regions, textMeta, textItems, viewport, pageWidthPt, pageNum, fontRegistry) {
    const parts      = [];
    const textParts  = [];
    let tableCount   = 0;

    for (const region of regions) {
        switch (region.type) {

            case RegionType.TABLE: {
                if (!region.lattice) break;
                const scopedItems = region.textItemIndices.map(i => textItems[i]);
                const tableHtml = buildTable(region.lattice, scopedItems, viewport, new Set(), region.proximityPx);
                if (tableHtml) {
                    parts.push(tableHtml);
                    tableCount++;
                }
                break;
            }

            case RegionType.HEADING: {
                const scopedItems = region.textItemIndices.map(i => textItems[i]);
                const scopedMeta  = region.textItemIndices.map(i => textMeta[i]);
                const headingText = scopedItems
                    .filter(i => i.str?.trim())
                    .sort((a, b) => a.transform[4] - b.transform[4])
                    .map(i => i.str.trim())
                    .join(' ');
                if (!headingText) break;

                const { family, sizePt, bold, italic } = _getRegionFont(scopedMeta);
                const fontClass  = _registerFont(fontRegistry, family, sizePt, bold, italic);
                const alignClass = ALIGN_CLASS[_inferAlignment(scopedMeta, region.bbox)] || 'ta-l';
                const tag        = (region.fontSize || 14) > 18 ? 'h3' : 'h4';

                parts.push(`<${tag} class="${fontClass} ${alignClass}">${esc(headingText)}</${tag}>`);
                textParts.push(headingText);
                break;
            }

            case RegionType.LIST: {
                const scopedItems = region.textItemIndices.map(i => textItems[i]);
                const scopedMeta  = region.textItemIndices.map(i => textMeta[i]);
                const rawList     = _buildList(scopedItems, pageWidthPt, region.listOrdered);
                if (!rawList) break;

                const { family, sizePt, bold, italic } = _getRegionFont(scopedMeta);
                const fontClass = _registerFont(fontRegistry, family, sizePt, bold, italic);
                // Inject class onto the list tag
                const listHtml = rawList.replace(/^<(ul|ol)>/, `<$1 class="${fontClass}">`);

                parts.push(listHtml);
                textParts.push(scopedItems.map(i => i.str?.trim()).filter(Boolean).join('\n'));
                break;
            }

            case RegionType.PARAGRAPH: {
                const scopedItems = region.textItemIndices.map(i => textItems[i]);
                const scopedMeta  = region.textItemIndices.map(i => textMeta[i]);
                const paraHtml    = rebuildText(scopedItems, pageWidthPt, { format: 'html' });
                if (!paraHtml.trim()) break;

                const { family, sizePt, bold, italic } = _getRegionFont(scopedMeta);
                const fontClass  = _registerFont(fontRegistry, family, sizePt, bold, italic);
                const alignClass = ALIGN_CLASS[_inferAlignment(scopedMeta, region.bbox)] || 'ta-l';

                // Wrap in a <div> that carries the font + alignment classes.
                // CSS inheritance propagates font-family, font-size, text-align
                // down to the <p> children without touching each <p>'s attributes.
                parts.push(`<div class="${fontClass} ${alignClass}">${paraHtml}</div>`);

                const plainText = rebuildText(scopedItems, pageWidthPt, { format: 'text' });
                textParts.push(plainText);
                break;
            }

            case RegionType.IMAGE: {
                const { w, h } = region.bbox;
                parts.push(
                    `<figure class="pdf-image-region" ` +
                    `style="width:${Math.round(w)}px;height:${Math.round(h)}px" ` +
                    `data-original-width="${Math.round(w)}" data-original-height="${Math.round(h)}">` +
                    `<figcaption>Image region (${Math.round(w)}×${Math.round(h)}px)</figcaption>` +
                    `</figure>`,
                );
                break;
            }
        }
    }

    const hasContent = parts.length > 0;
    const html = hasContent
        ? `<section class="pdf-page-content" data-page="${pageNum}">\n` +
          `<h4 class="page-label">Page ${pageNum}</h4>\n` +
          parts.join('\n') + '\n</section>'
        : '';

    return { html, text: textParts.join('\n\n'), tableCount };
}

// ── List builder ──────────────────────────────────────────────────────────────

const BULLET_STRIP_RE  = /^[•‣◦▪▫–—―·○◦◉▪▫-]\s*/;
const ORDERED_STRIP_RE = /^(?:\d{1,3}[.)]\s*|[a-zA-Z][.)]\s*|[ivxIVX]+[.)]\s*)/;

function _buildList(textItems, pageWidthPt, isOrdered) {
    const valid = textItems.filter(i => i.str?.trim());
    if (!valid.length) return '';

    const fontSizes = valid.map(i => Math.abs(i.transform?.[3] || 12));
    const avgFont   = fontSizes.reduce((a, b) => a + b, 0) / fontSizes.length;
    const yTol      = avgFont * 0.45;

    const sorted = [...valid].sort((a, b) => b.transform[5] - a.transform[5]);
    const lines  = [];

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

    const tag     = isOrdered ? 'ol' : 'ul';
    const stripRe = isOrdered ? ORDERED_STRIP_RE : BULLET_STRIP_RE;

    const listItems = lines
        .map(l => {
            const text = l.items.map(i => i.str.trim()).join(' ').replace(stripRe, '').trim();
            return text ? `<li>${esc(text)}</li>` : '';
        })
        .filter(Boolean);

    if (!listItems.length) return '';
    return `<${tag}>\n${listItems.join('\n')}\n</${tag}>`;
}
