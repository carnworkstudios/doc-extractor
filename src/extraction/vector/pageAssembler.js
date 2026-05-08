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
// Regions arrive pre-sorted top→bottom from contextClassifier.

import { buildTable } from './tableBuilder.js';
import { rebuildText } from './textRebuilder.js';
import { RegionType } from './contextClassifier.js';

function esc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Assemble a single page's HTML from its classified regions.
 *
 * @param {PageRegion[]}  regions      — sorted by yCenter (from classifyPage)
 * @param {TextItem[]}    textItems    — full page textContent.items array
 * @param {object}        viewport     — { width, height, transform }
 * @param {number}        pageWidthPt  — page width in PDF points
 * @param {number}        pageNum      — 1-based page number
 * @returns {{ html: string, text: string, tableCount: number }}
 */
export function assemblePage(regions, textItems, viewport, pageWidthPt, pageNum) {
    const parts = [];
    const textParts = [];
    let tableCount = 0;

    for (const region of regions) {
        switch (region.type) {

            case RegionType.TABLE: {
                if (!region.lattice) break;
                // Build table with only the text items that belong to this region
                const scopedItems = region.textItemIndices.map(i => textItems[i]);
                // Create a shared assigned set for just this table
                const assignedSet = new Set();
                const tableHtml = buildTable(region.lattice, scopedItems, viewport, assignedSet);
                if (tableHtml) {
                    parts.push(tableHtml);
                    tableCount++;
                }
                break;
            }

            case RegionType.HEADING: {
                const scopedItems = region.textItemIndices.map(i => textItems[i]);
                const headingText = scopedItems
                    .filter(i => i.str?.trim())
                    .sort((a, b) => a.transform[4] - b.transform[4])
                    .map(i => i.str.trim())
                    .join(' ');
                if (headingText) {
                    const tag = (region.fontSize || 14) > 18 ? 'h3' : 'h4';
                    parts.push(`<${tag}>${esc(headingText)}</${tag}>`);
                    textParts.push(headingText);
                }
                break;
            }

            case RegionType.LIST: {
                const scopedItems = region.textItemIndices.map(i => textItems[i]);
                const listHtml = _buildList(scopedItems, pageWidthPt, region.listOrdered);
                if (listHtml) {
                    parts.push(listHtml);
                    textParts.push(scopedItems.map(i => i.str?.trim()).filter(Boolean).join('\n'));
                }
                break;
            }

            case RegionType.PARAGRAPH: {
                const scopedItems = region.textItemIndices.map(i => textItems[i]);
                // Use the text rebuilder in HTML mode for proper paragraph structure
                const paraHtml = rebuildText(scopedItems, pageWidthPt, { format: 'html' });
                if (paraHtml.trim()) {
                    parts.push(paraHtml);
                    const plainText = rebuildText(scopedItems, pageWidthPt, { format: 'text' });
                    textParts.push(plainText);
                }
                break;
            }

            case RegionType.IMAGE: {
                const { w, h } = region.bbox;
                parts.push(
                    `<figure class="pdf-image-region" ` +
                    `style="width:${Math.round(w)}px;height:${Math.round(h)}px" ` +
                    `data-original-width="${Math.round(w)}" data-original-height="${Math.round(h)}">` +
                    `<figcaption>Image region (${Math.round(w)}×${Math.round(h)}px)</figcaption>` +
                    `</figure>`
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

    return {
        html,
        text: textParts.join('\n\n'),
        tableCount,
    };
}

// ── List builder ─────────────────────────────────────────────────────────────

const BULLET_STRIP_RE = /^[\u2022\u2023\u25E6\u25AA\u25AB\u2013\u2014\u2015•–—·○◦◉▪▫-]\s*/;
const ORDERED_STRIP_RE = /^(?:\d{1,3}[.)]\s*|[a-zA-Z][.)]\s*|[ivxIVX]+[.)]\s*)/;

function _buildList(textItems, pageWidthPt, isOrdered) {
    // Group items into lines by Y-band
    const valid = textItems.filter(i => i.str?.trim());
    if (!valid.length) return '';

    // Simple Y-band grouping
    const fontSizes = valid.map(i => Math.abs(i.transform?.[3] || 12));
    const avgFont = fontSizes.reduce((a, b) => a + b, 0) / fontSizes.length;
    const yTol = avgFont * 0.45;

    const sorted = [...valid].sort((a, b) => b.transform[5] - a.transform[5]); // top first (PDF Y)
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

    // Sort items within each line left-to-right
    for (const l of lines) {
        l.items.sort((a, b) => a.transform[4] - b.transform[4]);
    }

    const tag = isOrdered ? 'ol' : 'ul';
    const stripRe = isOrdered ? ORDERED_STRIP_RE : BULLET_STRIP_RE;

    const listItems = lines.map(l => {
        const text = l.items.map(i => i.str.trim()).join(' ').replace(stripRe, '').trim();
        return text ? `<li>${esc(text)}</li>` : '';
    }).filter(Boolean);

    if (!listItems.length) return '';

    return `<${tag}>\n${listItems.join('\n')}\n</${tag}>`;
}
