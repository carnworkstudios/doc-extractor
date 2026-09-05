// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
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
import { buildDisplayMath } from './mathBuilder.js';
import { RegionType } from './classifiers/regionTypes.js';
import { linkFlows } from './classifiers/flowLinker.js';
import { entryOffsets } from './classifiers/referenceDetector.js';
import { detectZoneColumns } from './contextClassifier.js';
import { PageScale } from './pageScale.js';
import { layoutTreeBuilder, compareBoxes } from './layoutTreeBuilder.js';
import { resolveLayout } from '@canwork/boxwood';
import { createPdfMeasure } from './pdfMeasure.js';
// Display math is typeset HERE, at assembly time, because this is the one
// function BOTH extraction paths go through — the geometry worker and the
// synthetic/scanned path in fileUpload. Rendering downstream of it means one of
// the two silently emits unrendered equations.
//
// A render is not an assertion that the reconstruction is correct: the block
// carries `data-math-suggested` until a human confirms it in TAFNE, and keeps
// the page's own glyphs in `data-math-source`. See the MATH branch below.
import { renderMath, mathMarker } from '../../utils/mathRender.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Join two flow-linked text fragments at a column/page seam.
function _joinFlowText(a, b, join) {
    if (join === 'dehyphenate') return a.replace(/[-‐‑­]\s*$/, '') + b.replace(/^\s+/, '');
    if (join === 'hyphen-keep') return a.replace(/\s+$/, '') + b.replace(/^\s+/, '');
    return a.replace(/\s+$/, '') + ' ' + b.replace(/^\s+/, '');
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
        fontRegistry.set(key, { className: cls, cssLine: `.pdf-doc .${cls} { ${css} }` });
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
        '.pdf-doc .ta-l  { text-align: left; }',
        '.pdf-doc .ta-c  { text-align: center; }',
        '.pdf-doc .ta-r  { text-align: right; }',
        '.pdf-doc .ta-j  { text-align: justify; }',
        '.pdf-doc p[data-indent] { text-indent: 1.5em; }',
        '.pdf-doc .bold  { font-weight: bold; }',
        '.pdf-doc .ital  { font-style: italic; }',
        '.pdf-doc .uline { text-decoration: underline; }',
        '.pdf-doc .col-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }',
        '.pdf-doc .col-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }',
        // Table variants
        '.pdf-doc .pdf-table-wrap { overflow-x: auto; margin: 8px 0; }',
        '.pdf-doc .pdf-table--lattice table   { border-collapse: collapse; width: 100%; }',
        '.pdf-doc .pdf-table--lattice td, .pdf-doc .pdf-table--lattice th { border: 1px solid #ccc; padding: 4px 8px; }',
        '.pdf-doc .pdf-table--borderless table { border-collapse: collapse; width: 100%; }',
        '.pdf-doc .pdf-table--borderless td, .pdf-doc .pdf-table--borderless th { padding: 4px 12px 4px 0; }',
        // Semantic box containers
        '.pdf-doc .pdf-box { border: 1.5px solid #888; border-radius: 3px; padding: 8px 14px; margin: 10px 0; }',
        '.pdf-doc .pdf-box--warning { border-color: #111; background: #fff5f5; }',
        '.pdf-doc .pdf-box--caution { border-color: #111; background: #fffbe6; }',
        '.pdf-doc .pdf-box--note    { border-color: #111; background: #f0f8ff; }',
        '.pdf-doc .pdf-box--tip     { border-color: #107c10; background: #f4fff4; }',
        // Admonition banner header: black bar with icon + big label, matching the
        // source. The box loses its top padding so the banner spans edge-to-edge.
        '.pdf-doc .pdf-box:has(.pdf-box-banner) { padding: 0; overflow: hidden; }',
        '.pdf-doc .pdf-box:has(.pdf-box-banner) > :not(.pdf-box-banner) { margin-left: 14px; margin-right: 14px; }',
        '.pdf-doc .pdf-box:has(.pdf-box-banner) > :first-of-type:not(.pdf-box-banner) { margin-top: 10px; }',
        '.pdf-doc .pdf-box:has(.pdf-box-banner) > :last-child { margin-bottom: 10px; }',
        '.pdf-doc .pdf-box-banner { background: #111; color: #fff; font-weight: 700; letter-spacing: .06em;',
        '  font-size: 1.35em; text-align: center; padding: 8px 14px; display: flex; align-items: center;',
        '  justify-content: center; gap: 10px; text-transform: uppercase; }',
        '.pdf-doc .pdf-box-icon { font-size: 1.1em; line-height: 1; }',
        // Divider
        '.pdf-doc .pdf-divider { border: none; border-top: 1px solid #ccc; margin: 14px 0; }',
        // Standalone list wrapper (prevents adjacent lists from merging in contenteditable)
        '.pdf-doc .pdf-list-wrap { margin: 6px 0; }',
        '.pdf-doc .pdf-list-wrap ol, .pdf-doc .pdf-list-wrap ul { margin: 0; padding-left: 1.4em; }',
        '.pdf-doc .pdf-list-wrap li { margin: 2px 0; }',
        // Zone / column layout
        '.pdf-doc .pdf-zone { }',
        '.pdf-doc .pdf-zone--flex-center { display: flex; justify-content: center; }',
        '.pdf-doc .layout-feature { align-items: start; }',
        '.pdf-doc .layout-card-grid { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)) !important; }',
        '.pdf-doc .pdf-zone--cols-1 { }',
        // Page-row model: one grid per page section, columns are persistent divs
        '.pdf-doc .pdf-page-row { display: grid; grid-template-columns: calc(var(--left-col, 0.5) * 100%) 1fr; column-gap: 20px; }',
        '.pdf-doc .pdf-page-row--cols-1 { display: block; }',
        '.pdf-doc .pdf-page-row--cols-3 { grid-template-columns: repeat(3, 1fr); column-gap: 14px; }',
        '.pdf-doc .pdf-page-row--cols-4 { grid-template-columns: repeat(4, 1fr); column-gap: 10px; }',
        '.pdf-doc .pdf-col { min-width: 0; }',
        '.pdf-doc .pdf-col--full { grid-column: 1 / -1; }',
        '.pdf-doc .pdf-region { }',
        // Semantic class for paragraph blocks — clean hook for CSS frameworks.
        // The .fN class still carries precise font sizing from the PDF; the
        // pdf-paragraph class is a stable semantic anchor that Tailwind,
        // Bootstrap, or custom CSS can target without depending on numbered
        // font classes.
        '.pdf-doc .pdf-paragraph { margin: 0.5em 0; }',
        '.pdf-doc .pdf-text-body { }',  /* alias for framework hooks */
        '@media (max-width: 720px) { .pdf-doc .pdf-page-row { grid-template-columns: 1fr; } }',
        // Stacked columns restore reading order — visually fuse continuations
        // with their predecessor (see flowLinker.js).
        // data-continuation now lives on the <p> element itself (flattened
        // paragraph markup), so the selector targets the <p> directly.
        '@media (max-width: 720px) { .pdf-doc [data-continuation] { margin-top: 0; text-indent: 0; } }',
        // Running header / footer
        '.pdf-doc .pdf-header { font-size: 0.78em; color: #555; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-bottom: 12px; }',
        '.pdf-doc .pdf-footer { font-size: 0.78em; color: #555; border-top: 1px solid #ddd; padding-top: 4px; margin-top: 12px; }',
        // Tree-based layout classes (Phase 2)
        '.pdf-doc .pdf-tree-cols { min-width: 0; container-type: inline-size; }',
        '.pdf-doc .pdf-tree-cols > * { min-width: 0; }',
        '.pdf-doc .pdf-tree-cols--cards { display: flex !important; flex-wrap: wrap; }',
        '.pdf-doc .pdf-tree-cols--cards > * { flex: 1 1 200px; min-width: 0; }',
        '.pdf-doc .pdf-tree-row > * + * { margin-top: 0; }',
    ];

    return [...fontLines, ...staticLines].join('\n');
}

// ── Content-derived breakpoints (§35) ────────────────────────────────────────
// For each col-split node in the tree, find the narrowest width at which its
// columns must collapse (switching from grid to block flow). Uses binary search
// with resolveLayout to detect overflow signals.

function _deriveBreakpoints(tree, pageBox, textItems, fontRegistry, pageScale) {
    const breakpoints = [];
    _walkTreeForBreakpoints(tree, pageBox, textItems, fontRegistry, pageScale, breakpoints, []);
    return breakpoints;
}

function _walkTreeForBreakpoints(node, pageBox, textItems, fontRegistry, pageScale, breakpoints, path) {
    if (!node) return;

    if (node.split && 'cols' in node.split && node.children && node.children.length >= 2) {
        // Compute min readable width: max(narrowest unbreakable token width, k_min * avgCharW)
        const avgCharW = (pageScale ? pageScale.S * 0.5 : 7);
        const kMin = 15; // minimum chars per column
        const minReadable = avgCharW * kMin;

        // Binary search for collapse width between minReadable and pageBox.w
        let lo = minReadable;
        let hi = pageBox.w;
        const collapseWidth = _findCollapseWidth(node, pageBox, textItems, fontRegistry, lo, hi, pageBox.w);

        if (collapseWidth > 0) {
            breakpoints.push({
                path: path.join('.'),
                collapseWidth,
                minReadable,
                colCount: node.children.length,
            });
        }
    }

    // Recurse into children, tracking path
    if (node.children) {
        for (let i = 0; i < node.children.length; i++) {
            const childPath = [...path, i];
            _walkTreeForBreakpoints(node.children[i], pageBox, textItems, fontRegistry, pageScale, breakpoints, childPath);
        }
    }
}

function _findCollapseWidth(node, pageBox, textItems, fontRegistry, lo, hi, originalW) {
    if (lo >= hi) return 0;
    const measure = createPdfMeasure(textItems, fontRegistry);

    // Binary search: find the boundary width where overflow just starts
    let best = 0;
    for (let iter = 0; iter < 8; iter++) {
        const mid = (lo + hi) / 2;
        const testBox = { x: 0, y: 0, w: mid, h: pageBox.h };
        try {
            const result = resolveLayout(node, testBox, { measure, collide: false });
            if (result.overflow && result.overflow.length > 0) {
                // Overflow — too narrow; widen
                lo = mid;
            } else {
                // No overflow — still fits; try narrower
                best = mid;
                hi = mid;
            }
        } catch (_) {
            lo = mid;
        }
    }
    return best > 0 ? Math.max(best, originalW * 0.3) : 0;
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

// Classify a block whose own shape is uninformative (a single line, or a
// uniform rectangle of flush lines) by its margins inside the containing
// column/page frame. A single centered line is geometrically identical to a
// left-aligned one until it is compared against something wider than itself.
export function _edgeAlignment(bbox, container, canJustify) {
    if (!bbox || !container || !(container.w > bbox.w * 1.02)) {
        return canJustify ? 'justify' : 'left';
    }
    const left  = bbox.x - container.x;
    const right = (container.x + container.w) - (bbox.x + bbox.w);
    const tol = Math.max(container.w * 0.03, 4);
    if (left <= tol && right <= tol) return canJustify ? 'justify' : 'left';
    if (left > tol && right > tol &&
        Math.abs(left - right) <= Math.max(container.w * 0.06, 8)) return 'center';
    if (right <= tol && left > 2 * tol) return 'right';
    return 'left';
}

export function _inferAlignment(items, bbox, container) {
    if (!items || !items.length || !bbox) return 'left';

    // Use the median vFont as a local yTol for line grouping
    const fonts = items.map(i => i.vFont || 12).sort((a, b) => a - b);
    const medFont = fonts[Math.floor(fonts.length / 2)];
    const lines = _groupMetaByY(items, medFont * 0.45);
    if (lines.length < 2) return _edgeAlignment(bbox, container, false);

    const leftEdges = lines.map(l => Math.min(...l.map(i => i.vx)));
    const rightEdges = lines.map(l => Math.max(...l.map(i => i.vx + (i.vWidth || 0))));
    const midPoints = lines.map((l, idx) => (leftEdges[idx] + rightEdges[idx]) / 2);

    // The last line of a justified/centered block is typically short — it
    // carries no alignment signal, so drop it from the edge statistics.
    const rightUse = lines.length >= 3 ? rightEdges.slice(0, -1) : rightEdges;
    const midUse   = lines.length >= 3 ? midPoints.slice(0, -1)  : midPoints;

    const bw = bbox.w || 1;
    const normLeft = _stdDev(leftEdges) / bw;
    const normRight = _stdDev(rightUse) / bw;
    const normMid = _stdDev(midUse) / bw;

    // Uniform rectangle: every full line flush on both sides — the block's own
    // shape cannot distinguish justify/center/left, so read container margins.
    if (normLeft < 0.01 && normRight < 0.03) return _edgeAlignment(bbox, container, true);
    if (normMid < 0.02) return 'center';
    if (normRight < 0.01 && normLeft > 0.02) return 'right';
    return 'left';
}

const ALIGN_CLASS = { left: 'ta-l', center: 'ta-c', right: 'ta-r', justify: 'ta-j' };

// Alignment reference frames, derived from the regions themselves: each
// column's frame is the union x-extent of its sibling regions; full-width
// regions (columnIndex -1) measure against the page content frame (union of
// ALL regions — i.e. the text area inside the margins). A column with a single
// region falls back to the page frame rather than comparing a box to itself.
export function _buildContainers(regions, viewportWidth) {
    const all = { x0: Infinity, x1: -Infinity };
    const cols = new Map();
    for (const r of regions) {
        if (!r.bbox) continue;
        all.x0 = Math.min(all.x0, r.bbox.x);
        all.x1 = Math.max(all.x1, r.bbox.x + r.bbox.w);
        const ci = r.columnIndex ?? -1;
        if (ci < 0) continue;
        const s = cols.get(ci) || { x0: Infinity, x1: -Infinity, n: 0 };
        s.x0 = Math.min(s.x0, r.bbox.x);
        s.x1 = Math.max(s.x1, r.bbox.x + r.bbox.w);
        s.n++;
        cols.set(ci, s);
    }
    const page = all.x1 > all.x0
        ? { x: all.x0, w: all.x1 - all.x0 }
        : { x: 0, w: viewportWidth || 1 };
    const byCol = new Map();
    for (const [ci, s] of cols) {
        byCol.set(ci, s.n >= 2 && s.x1 > s.x0 ? { x: s.x0, w: s.x1 - s.x0 } : page);
    }
    return { page, byCol };
}

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
 * @param {object}             opts         — { skipMath } — MATH switched off in
 *   the Regions legend, so a paragraph that reconstructs to LaTeX still renders
 *   as prose.
 * @returns {{ html: string, text: string, tableCount: number }}
 */
export function assemblePage(regions, textMeta, textItems, viewport, pageWidthPt, pageNum, fontRegistry, columnSplits = [], extractedImages = {}, docScale = null, links = [], opts = {}) {
    const parts = [];
    const textParts = [];
    let tableCount = 0;
    let layoutTree = null;
    let fidelityScore = 0;
    let layoutMethod = 'flat-zones';

    // Accept both plain X numbers and {x, leftFraction} objects. Plain numbers
    // previously made `splits[0]?.leftFraction` undefined, so every 2-col zone
    // silently rendered 50/50 regardless of the real gutter position.
    columnSplits = (columnSplits || []).map(s => (typeof s === 'number')
        ? { x: s, leftFraction: viewport.width ? s / viewport.width : 0.5 }
        : s);

    // Create PageScale early for adaptive thresholds throughout assembly
    const pageScale = textMeta.length > 0 ? new PageScale(textMeta, viewport) : null;

    // OCR text layer detection: a page whose image regions cover most of the
    // canvas but that still carries real text is a scanned page with an OCR
    // overlay. The text is readable, its geometry is scanner-made — word gaps
    // are packed to the scan, so textRebuilder runs with the OCR-relaxed
    // bimodal gates (ported from pdf_md repair_ocr_text_layer semantics).
    const pageArea = (viewport.width || 1) * (viewport.height || 1);
    const imageArea = regions
        .filter(r => r.type === 'IMAGE' && r.bbox)
        .reduce((sum, r) => sum + r.bbox.w * r.bbox.h, 0);
    const ocrLayer = imageArea >= 0.5 * pageArea && textMeta.length > 20;

    const pageScaleOpts = {
        ...(pageScale ? { pageScale: pageScale.toJSON() } : {}),
        ...(ocrLayer ? { ocr: true } : {}),
    };

    // Step 4: Figure+caption detection pre-pass
    _mergeFigureCaptions(regions, textMeta);

    // Step 5: Heading levels (first large heading on page 1 becomes H1)
    if (pageNum === 1) {
        let maxH = null;
        for (const r of regions) {
            if (r.type === RegionType.HEADING) {
                if (!maxH || r.fontSize > maxH.fontSize) maxH = r;
            }
        }
        if (maxH && maxH.fontSize > 20) maxH.isH1 = true;
    }

    const numCols = Math.max(1, columnSplits.length + 1);
    const pageWidth = viewport.width || 612;

    // Detect zone layout from classifier column assignments
    const autoZones = _detectAutoZones(regions, numCols, pageWidth);

    // Zone-level column re-detection: for each zone the page-level pass left as
    // single-column, re-run bipartite on that zone's text items with Gate 3 dropped.
    // Gate 3 (vertical persistence) is the page-level guard against short header
    // clusters — it is irrelevant inside a bounded zone whose own height is the
    // persistence window.  A minimum zone height guard (10 body-text lines) keeps
    // Gate 3 active for caption bands and label clusters too short to trust.
    if (textMeta.length > 0 && pageScale) {
        // Text already claimed by structural regions (tables, figures, boxes)
        // must not feed zone-level column re-detection: table columns and
        // figure labels form disjoint X clusters that read as phantom text
        // columns.
        const structurallyClaimed = new Set();
        for (const r of regions) {
            if (r.type === RegionType.LATTICE_TABLE || r.type === RegionType.STREAM_TABLE ||
                r.type === RegionType.TABLE || r.type === RegionType.IMAGE ||
                r.type === RegionType.BOX) {
                for (const idx of (r.textItemIndices || [])) structurallyClaimed.add(idx);
                // A box's children hold text the box itself no longer lists —
                // a nested table takes its cells out of the parent's index list.
                // Missing them here would feed a grid's columns back into text
                // column detection as phantom columns, which is the exact thing
                // this set exists to prevent.
                for (const c of (r.children || [])) {
                    for (const idx of (c.textItemIndices || [])) structurallyClaimed.add(idx);
                }
            }
        }
        for (const zone of autoZones) {
            if (zone.cols > 1) continue; // page-level already found this split
            if (!zone.isFullWidth) continue; // classified as multi-col regions already — skip
            const zoneItems = textMeta.filter(tm =>
                tm.vy >= zone.y0 && tm.vy < zone.y1 && !structurallyClaimed.has(tm.idx));
            if (zoneItems.length < 6) continue;
            const { splits: zoneSplits } = detectZoneColumns(zoneItems, viewport, pageScale);
            if (!zoneSplits.length) continue;
            // Promote zone to multi-column and patch columnIndex on its regions
            zone.cols = zoneSplits.length + 1;
            zone.isFullWidth = false;
            zone.layoutClass = 'layout-equal';
            zone._zoneSplits = zoneSplits; // carried into render loop for --left-col
            const tol = 5;
            for (const r of regions) {
                if (!r.bbox) continue;
                if ((r.yCenter ?? 0) < zone.y0 || (r.yCenter ?? 0) >= zone.y1) continue;
                if (r.columnIndex !== -1) continue; // already assigned
                const cx = r.bbox.x + r.bbox.w / 2;
                for (let ci = 0; ci <= zoneSplits.length; ci++) {
                    const lo = ci === 0 ? -Infinity : zoneSplits[ci - 1].x;
                    const hi = ci === zoneSplits.length ? Infinity : zoneSplits[ci].x;
                    if (cx >= lo && cx < hi) { r.columnIndex = ci; break; }
                }
            }
        }
    }

    // Flow chains: link paragraph fragments across column/zone seams. Links
    // are non-destructive — the spatial HTML keeps every fragment in its
    // column; the plain-text pass below joins linked fragments.
    if (pageScale && textMeta.length > 0) {
        linkFlows(regions, textMeta, autoZones, columnSplits, pageScale, pageWidth, pageNum);
    }

    // ── Phase 2: Layout tree + fidelity score ───────────────────────────────
    // Build a recursive XY-cut tree from region boxes, resolve it forward,
    // and compare against measured bboxes. The score arbitrates which HTML
    // renderer is used (tree vs flat zones).
    const pageBox = { x: 0, y: 0, w: pageWidth, h: viewport.height || pageWidth * 1.4 };
    const treeResult = layoutTreeBuilder(regions, pageBox, pageScale, {
        docScale,
        textItems,
        measureText: createPdfMeasure(textItems, fontRegistry),
    });
    layoutTree = treeResult.tree;
    layoutMethod = treeResult.method;

    if (treeResult.method === 'xycut' && treeResult.tree && textItems.length > 0) {
        try {
            const pdfMeasure = createPdfMeasure(textItems, fontRegistry);
            const layoutResult = resolveLayout(treeResult.tree, pageBox, { measure: pdfMeasure, collide: false });
            const compareResult = compareBoxes(layoutResult.boxes, regions);
            fidelityScore = compareResult.score;
        } catch (_) {
            fidelityScore = 0;
        }
    }

    // Render each region wrapped in a .pdf-region sentinel that carries
    // its viewport-space Y/X so the zone toolbar can rearrange without
    // re-running the extractor.
    const textEntries = [];
    const containers = _buildContainers(regions, viewport.width);

    // Item → link map (first link over an item wins). _scopeItems copies the
    // matched link onto the item as `_gxLink`, and textRebuilder wraps any run
    // carrying one in <a href>. Links that cover no rendered text (figures,
    // tables, whole-page graphics) instead surface as a data-link attribute on
    // the region wrapper below.
    // Each entry carries the character span the link actually covers, because
    // pdf.js routinely emits a whole line as one item and only a few words of
    // it are the link.
    const linkByIndex = new Map();
    for (const l of links || []) {
        const spans = (l.spans && l.spans.length)
            ? l.spans
            : (l.itemIndices || []).map(i => ({ index: i, start: 0, end: Infinity }));
        for (const s of spans) {
            if (!linkByIndex.has(s.index)) linkByIndex.set(s.index, { link: l, start: s.start, end: s.end });
        }
    }

    const rendered = regions.map(region => {
        const { html, text, tables } = _renderRegion(region, textMeta, textItems, viewport, pageWidthPt, fontRegistry, extractedImages, pageScaleOpts, containers, linkByIndex, { skipMath: !!opts.skipMath });
        tableCount += tables;
        if (text) textEntries.push({ region, text });
        const ry = Math.round(region.yCenter ?? 0);
        const rx = Math.round(region.bbox?.x ?? 0);
        // The sentinel is where a region becomes ADDRESSABLE. Only tables and
        // pictures used to carry `data-region-id`, so every text, math, box,
        // header and footer artifact resolved to null in getRegionHtml() and
        // could not be jumped to, previewed, or sent anywhere. The id belongs
        // on the wrapper, not the leaf, because it is the one element every
        // region type produces.
        const idAttr = region.id != null
            ? ` data-region-id="${_escAttr(String(region.id))}" data-region-type="${_escAttr(String(region.type || ''))}"`
            : '';
        return {
            html: html ? `<div class="pdf-region"${idAttr} data-ry="${ry}" data-rx="${rx}"${_regionLinkAttr(region, links)}>${html}</div>` : '',
            colIdx: region.columnIndex,
            ry,
            rx,
            id: region.id,
        };
    }).filter(r => r.html);

    // Walk flow chains head-first, absorbing continuation text into the head
    // entry so the plain-text output reads as unbroken paragraphs.
    const byFlowId = new Map();
    for (const e of textEntries) {
        if (e.region.flowId) byFlowId.set(e.region.flowId, e);
    }
    for (const e of textEntries) {
        const r = e.region;
        if (!r.flowNext) continue;
        if (r.flowPrev && byFlowId.has(r.flowPrev)) continue; // not a chain head
        let cur = r;
        while (cur.flowNext && byFlowId.has(cur.flowNext)) {
            const nx = byFlowId.get(cur.flowNext);
            e.text = _joinFlowText(e.text, nx.text, nx.region.flowJoin);
            nx.absorbed = true;
            cur = nx.region;
        }
    }
    for (const e of textEntries) {
        if (!e.absorbed) textParts.push(e.text);
    }

    const COL_NAMES = ['left', 'center', 'right'];

    // ── Phase 2: Placement offsets (alignment within resolved cell frames) ───
    // resolveLayout predicts a cell frame per region; comparing it to the actual
    // bbox gives justify-self / align-self hints that survive into the row model.
    const placementMap = new Map();
    if (layoutTree && layoutMethod === 'xycut') {
        try {
            const pdfMeasure = createPdfMeasure(textItems, fontRegistry);
            const layoutResult = resolveLayout(layoutTree, pageBox, { measure: pdfMeasure, collide: false });
            for (const rb of layoutResult.boxes) {
                if (!rb.node?.id || !rb.box) continue;
                const region = regions.find(rr => rr.id === rb.node.id);
                if (!region || !region.bbox) continue;
                const cellFrame = rb.box;
                const actualBbox = region.bbox;
                const leftOffset = actualBbox.x - cellFrame.x;
                const rightOffset = (cellFrame.x + cellFrame.w) - (actualBbox.x + actualBbox.w);
                const topOffset = actualBbox.y - cellFrame.y;
                const bottomOffset = (cellFrame.y + cellFrame.h) - (actualBbox.y + actualBbox.h);
                const tol = pageScale ? pageScale.S * 2 : 10;
                const styles = [];
                if (Math.abs(leftOffset - rightOffset) < tol) {
                    styles.push('justify-self: center');
                } else if (rightOffset < tol) {
                    styles.push('justify-self: end');
                } else if (leftOffset < tol) {
                    styles.push('justify-self: start');
                }
                if (Math.abs(topOffset - bottomOffset) < tol && cellFrame.h > actualBbox.h + tol) {
                    styles.push('align-self: center');
                }
                if (styles.length > 0) placementMap.set(rb.node.id, styles.join('; '));
            }
        } catch (_) { /* no placement data */ }
    }

    // Apply placement styles to rendered html entries
    const renderedWithPlacement = rendered.map(r => {
        if (!r.id || !placementMap.has(r.id)) return r;
        const pStyle = placementMap.get(r.id);
        return {
            ...r,
            // The class attribute is emitted with its closing quote, so the
            // capture must include it — matching `<div class="pdf-region`
            // without the quote produced
            // `class="pdf-region style="justify-self: center;""`, which folds
            // the style into the class value and drops the hint entirely.
            html: r.html.replace(/^(<div class="pdf-region")/, `$1 style="${pStyle};"`)
        };
    });

    // ── Row model assembly ─────────────────────────────────────────────────
    // One pdf-page-row per page section. All left-column regions go into
    // pdf-col--left, right into pdf-col--right, full-width into pdf-col--full.
    // pdf-zone wrappers are preserved inside each column so selectionMode.js
    // and zoneToolbar.js continue to work without changes.
    parts.push(_buildPageRow(renderedWithPlacement, autoZones, columnSplits, numCols, pageWidth, COL_NAMES));

    // ── Phase 3: Content-derived breakpoints (§35) ──────────────────────────
    // For each col-split node in the layout tree, compute the min width at
    // which columns must collapse. Uses resolveLayout at decreasing widths
    // watching OverflowSignal. Falls back to 720px when no tree or no text.
    let breakpoints = null;
    if (layoutTree && layoutMethod === 'xycut' && fidelityScore > 0 && textItems.length > 0) {
        try {
            breakpoints = _deriveBreakpoints(layoutTree, pageBox, textItems, fontRegistry, pageScale);
        } catch (_) { /* keep null — 720px fallback applies */ }
    }

    const hasContent = parts.length > 0 && parts.some(Boolean);
    const zonesJson = JSON.stringify(autoZones).replace(/'/g, '&#39;');

    let contentHtml = parts.filter(Boolean).join('\n');
    let extraStyles = '';

    // Emit content-derived breakpoints as container queries targeting pdf-page-row.
    // 720px media query is the fallback for browsers without container query support.
    if (breakpoints && breakpoints.length > 0) {
        const bpLines = breakpoints.map(bp => {
            const px = Math.round(bp.collapseWidth);
            return [
                `@container (max-width: ${px}px) {`,
                `  .pdf-page-row { grid-template-columns: 1fr; }`,
                `}`,
                `@media (max-width: ${Math.max(720, px)}px) {`,
                `  .pdf-page-row { grid-template-columns: 1fr !important; }`,
                `}`,
            ].join('\n');
        }).join('\n');
        extraStyles = `<style class="pdf-breakpoints">\n${bpLines}\n</style>`;
    }

    const html = hasContent
        ? `<article class="pdf-doc">\n<section class="pdf-page-content" id="page-${pageNum}" data-page="${pageNum}" data-page-width="${Math.round(pageWidth)}" data-zones='${zonesJson}'>\n` +
          `<h4 class="page-label">Page ${pageNum}</h4>\n` +
          contentHtml + '\n' + extraStyles + '\n</section>\n</article>'
        : '';

    return {
        html,
        text: textParts.join('\n\n'),
        tableCount,
        layoutTree,
        fidelityScore,
        layoutMethod,
    };
}

// Group regions into contiguous zones of same column type (full-width vs N-col).
// Y boundaries are midpoints between adjacent groups so every region falls in
// exactly one zone.
function _detectAutoZones(regions, numCols, pageWidth) {
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
        const next = groups[i + 1];
        
        // Step 6: Zone boundaries use deterministic bbox.y of the lead element
        const lead = g.list[0];
        const y0 = i === 0 ? 0 : (lead.bbox ? Math.floor(lead.bbox.y) : Math.floor(lead.yCenter));
        
        let y1 = 99999;
        if (next) {
            const nextLead = next.list[0];
            y1 = nextLead.bbox ? Math.floor(nextLead.bbox.y) : Math.floor(nextLead.yCenter);
        }
        
        const zoneCols = g.isFullWidth ? 1 : numCols;
        let layoutClass = 'layout-equal';
        
        if (!g.isFullWidth) {
            // Check for CARD_GRID: 3+ HEADINGs at same Y
            const headings = g.list.filter(r => r.type === RegionType.HEADING);
            let isCardGrid = false;
            if (headings.length >= 3) {
                const yBuckets = [];
                for (const h of headings) {
                    const bucket = yBuckets.find(b => Math.abs(b.y - h.yCenter) < 15);
                    if (bucket) { bucket.count++; bucket.y = (bucket.y * (bucket.count - 1) + h.yCenter) / bucket.count; }
                    else yBuckets.push({ y: h.yCenter, count: 1 });
                }
                if (yBuckets.some(b => b.count >= 3)) isCardGrid = true;
            }
            
            // Check for FEATURE_LAYOUT: 2 cols, left is all visual, right is text
            let isFeature = false;
            if (zoneCols === 2) {
                const col0 = g.list.filter(r => r.columnIndex === 0 || (r.colIdx === undefined && r.bbox?.x < pageWidth/2));
                const col1 = g.list.filter(r => r.columnIndex === 1 || (r.colIdx === undefined && r.bbox?.x >= pageWidth/2));
                const col0AllVisual = col0.length > 0 && col0.every(r => r.type === RegionType.HEADING || r.type === RegionType.IMAGE);
                const col1HasText = col1.some(r => r.type === RegionType.PARAGRAPH || r.type === RegionType.LIST);
                if (col0AllVisual && col1HasText) isFeature = true;
            }
            
            if (isCardGrid) layoutClass = 'layout-card-grid';
            else if (isFeature) layoutClass = 'layout-feature';
        }
        
        return { y0, y1, cols: zoneCols, layoutClass };
    });
}

// Assemble all rendered regions for a page into one pdf-page-row.
// Column regions are bucketed by colIdx and sorted by Y within each bucket.
// Full-width regions (colIdx === -1, or in a 1-col zone) land in pdf-col--full
// and span the entire grid via grid-column: 1 / -1.
// pdf-zone wrappers are preserved inside each column bucket so selectionMode
// and zoneToolbar continue to work against .pdf-zone without changes.
function _buildPageRow(rendered, autoZones, columnSplits, numCols, pageWidth, colNames) {
    if (!rendered.length) return '';

    // Single-column page: no grid, just flat block flow in one full-width col
    if (numCols <= 1) {
        const zoneHtml = _groupIntoZones(rendered, autoZones);
        return `<div class="pdf-page-row pdf-page-row--cols-1"><div class="pdf-col pdf-col--full" data-col-id="full">${zoneHtml}</div></div>`;
    }

    // Multi-column: split the page into vertical bands (sub-rows) so that a
    // full-width element (a spanning table, figure, or abstract) at the top of
    // the page renders ABOVE the multi-column prose below it, preserving reading
    // order. A single page-wide row would force all full-width content (via
    // grid-column: 1 / -1) to render after both prose columns regardless of Y.
    //
    // autoZones already segments the page into contiguous full-width and
    // multi-column runs in Y order. We emit one pdf-page-row per run: full-width
    // runs become a single spanning column; multi-column runs become left/right
    // (or N) column buckets. This keeps the vertical order the PDF actually has.
    const fullWidthZoneRanges = autoZones
        .filter(z => z.cols === 1)
        .map(z => ({ y0: z.y0, y1: z.y1 }));

    const isFullWidth = r => {
        if (r.colIdx === -1) return true;
        return fullWidthZoneRanges.some(z => r.ry >= z.y0 && r.ry < z.y1);
    };

    const leftFraction = columnSplits[0]?.leftFraction || 0.5;
    const rowModifier = numCols === 3 ? ' pdf-page-row--cols-3'
        : numCols === 4 ? ' pdf-page-row--cols-4'
        : '';
    const styleAttr = (numCols === 2)
        ? ` style="--left-col: ${leftFraction.toFixed(4)};"`
        : '';

    // Tag each rendered entry with its band type, then group consecutive entries
    // (in Y order) of the same band type into runs. Each run emits one row.
    // X tiebreak: regions sharing a baseline (one visual line split into
    // several regions) must read left→right, not in detection order.
    const ordered = [...rendered].sort((a, b) => (a.ry - b.ry) || (a.rx - b.rx));
    const runs = [];
    for (const r of ordered) {
        const fw = isFullWidth(r);
        const last = runs[runs.length - 1];
        if (last && last.fw === fw) last.items.push(r);
        else runs.push({ fw, items: [r] });
    }

    const emitFullRow = items => {
        const inner = `<div class="pdf-zone pdf-zone--cols-1">${items.map(r => r.html).join('\n')}</div>`;
        return `<div class="pdf-page-row pdf-page-row--cols-1">` +
               `<div class="pdf-col pdf-col--full" data-col-id="full">${inner}</div></div>`;
    };

    const emitColRow = items => {
        const colBuckets = Array.from({ length: numCols }, () => []);
        for (const r of items) {
            const ci = (r.colIdx >= 0 && r.colIdx < numCols)
                ? r.colIdx
                : Math.min(Math.floor(r.rx / pageWidth * numCols), numCols - 1);
            colBuckets[ci].push(r);
        }
        for (const bucket of colBuckets) bucket.sort((a, b) => (a.ry - b.ry) || (a.rx - b.rx));
        const colDivs = colBuckets.map((bucket, i) => {
            if (!bucket.length) return '';
            const name = numCols <= 3 ? (colNames[i] || `col-${i}`) : `col-${i}`;
            const inner = `<div class="pdf-zone pdf-zone--cols-1">${bucket.map(r => r.html).join('\n')}</div>`;
            return `<div class="pdf-col pdf-col--${name}" data-col-id="col-${i}">${inner}</div>`;
        }).filter(Boolean);
        return `<div class="pdf-page-row${rowModifier}"${styleAttr}>\n${colDivs.join('\n')}\n</div>`;
    };

    const rowsHtml = runs
        .map(run => (run.fw ? emitFullRow(run.items) : emitColRow(run.items)))
        .filter(Boolean);

    return rowsHtml.join('\n');
}

// Wrap a flat list of rendered entries in pdf-zone divs matching autoZones boundaries.
// Used for the single-column path where there is no column partitioning.
function _groupIntoZones(rendered, autoZones) {
    const parts = [];
    for (const zone of autoZones) {
        const zoneItems = rendered.filter(r => r.ry >= zone.y0 && r.ry < zone.y1);
        if (!zoneItems.length) continue;
        const cls = zone.cols > 1
            ? `pdf-zone pdf-zone--cols-${zone.cols} ${zone.layoutClass}`
            : 'pdf-zone pdf-zone--cols-1';
        parts.push(`<div class="${cls}">${zoneItems.map(r => r.html).join('\n')}</div>`);
    }
    return parts.join('\n');
}

// Pre-pass: Merge adjacent image and paragraph regions if they look like a figure + caption
function _mergeFigureCaptions(regions, textMeta) {
    for (let i = 0; i < regions.length - 1; i++) {
        const r1 = regions[i];
        if (r1.type !== RegionType.IMAGE) continue;
        const r2 = regions[i + 1];
        if (r2.type !== RegionType.PARAGRAPH) continue;
        
        const imgBottom = r1.bbox ? r1.bbox.y + r1.bbox.h : r1.yCenter;
        const capTop = r2.bbox ? r2.bbox.y : r2.yCenter;
        
        if (capTop >= imgBottom - 10 && capTop <= imgBottom + 45) {
            const capText = r2.textItemIndices.map(idx => textMeta[idx].str).join(' ');
            const isFig = /(?:Figure|Fig\.|Table|Exhibit)\s*\d+/i.test(capText);
            const isShortCenter = capText.length < 150 && r2.bbox && r1.bbox &&
                Math.abs((r2.bbox.x + r2.bbox.w / 2) - (r1.bbox.x + r1.bbox.w / 2)) < 30;
            
            if (isFig || isShortCenter) {
                r1.captionRegion = r2;
                regions.splice(i + 1, 1);
            }
        }
    }
}

// Merge bold/italic/underlined flags from textMeta (which has the reliable
// font-style data from page.commonObjs) onto the raw PDF.js items so
// textRebuilder can emit <strong>/<em>/<u> wrappers per-item. Link coverage is
// attached the same way: an item under a LinkAnnotation carries `_gxLink` so
// textRebuilder wraps its run in <a href>.
function _scopeItems(region, textItems, textMeta, linkByIndex = null) {
    const out = [];
    for (const i of (region.textItemIndices || [])) {
        const raw  = textItems[i];
        const meta = textMeta[i];
        const hit  = linkByIndex ? linkByIndex.get(i) : null;
        if (!meta && !hit) { out.push(raw); continue; }
        const merged = (meta && (meta.bold || meta.italic || meta.underlined))
            ? { ...raw, bold: meta.bold, italic: meta.italic, underlined: meta.underlined }
            : raw;
        if (!hit) { out.push(merged); continue; }
        const gxLink = { href: hit.link.href, source: 'pdf', page: hit.link.page };
        for (const piece of _splitItemAtSpan(merged, hit.start, hit.end, gxLink)) out.push(piece);
    }
    return out;
}

/**
 * Slice one text item into up to three items: the text before the link, the
 * linked text, and the text after it. Geometry is interpolated proportionally
 * (x advance and width scale with character count), the same approximation the
 * math atomizer uses — the consumers only compare these against thresholds of
 * roughly a third of a font size.
 *
 * Without this a link over "Fig. 8" makes the whole sentence clickable,
 * because pdf.js hands the extractor a full line as a single item.
 */
function _splitItemAtSpan(item, start, end, gxLink) {
    const str = item.str || '';
    const s = Math.max(0, Math.min(str.length, start | 0));
    const e = Math.max(s, Math.min(str.length, end === Infinity ? str.length : (end | 0)));
    if (s <= 0 && e >= str.length) return [{ ...item, _gxLink: gxLink }];

    const width   = item.width || 0;
    const perChar = width / Math.max(str.length, 1);
    const x0      = item.transform ? item.transform[4] : 0;
    const cut = (from, to, link) => {
        const text = str.slice(from, to);
        if (!text) return null;
        const piece = {
            ...item,
            str: text,
            width: perChar * (to - from),
        };
        if (item.transform) {
            piece.transform = [...item.transform];
            piece.transform[4] = x0 + perChar * from;
        }
        if (link) piece._gxLink = link;
        else delete piece._gxLink;
        return piece;
    };
    return [cut(0, s, null), cut(s, e, gxLink), cut(e, str.length, null)].filter(Boolean);
}

/**
 * data-link attribute for links this region must carry but cannot express as
 * item-level <a> wrappers — a figure, table, or full-page graphic that a link
 * annotation points at. Text-rendering regions skip links whose covered items
 * are all inside their own text item set: textRebuilder already wrapped them.
 * Image/table regions never render item-level <a>, so any link whose rect
 * touches them is carried here (their caption/label items, even if covered,
 * do not become clickable text).
 */
const LINK_TEXT_REGION_TYPES = new Set(['PARAGRAPH', 'HEADING', 'LIST', 'MATH', 'REFERENCE', 'BOX', 'HEADER', 'FOOTER']);

function _regionLinkAttr(region, links, slack = 4) {
    const b = region.bbox;
    if (!b) return '';
    const regionIdx = new Set(region.textItemIndices || []);
    const rendersText = LINK_TEXT_REGION_TYPES.has(region.type);
    const hrefs = [];
    for (const l of links || []) {
        const r = l.rect;
        if (!r) continue;
        if (!(r.x - slack < b.x + b.w && r.x + r.w + slack > b.x &&
              r.y - slack < b.y + b.h && r.y + r.h + slack > b.y)) continue;
        const covered = l.itemIndices || [];
        if (rendersText && covered.length && covered.every(i => regionIdx.has(i))) continue;
        hrefs.push(l.href);
    }
    return hrefs.length ? ` data-link="${hrefs.join(',')}"` : '';
}

/**
 * Build a positioned text layer for a picture's own labels, as an SVG overlay.
 *
 * This was CSS: absolutely positioned spans, percentage offsets, font size in
 * `cqw`. It required `container-type: inline-size` on the wrapper to give the
 * container query a container, and that is what destroyed the picture — see
 * `_imageStack` below. It also had to guess a cap height to convert a baseline
 * into a CSS `top`.
 *
 * TWO things make an SVG overlay land exactly, and both are about refusing to
 * round:
 *
 *   1. The viewBox is the CROP'S OWN PIXEL GRID (`pw × ph`), not the region
 *      bbox. `preserveAspectRatio="none"` stretches the viewBox onto the
 *      element box, and the element box is showing exactly those `pw × ph`
 *      pixels stretched the same way — so bitmap pixel and user unit are the
 *      same thing by construction, whatever the layout does. Using the bbox
 *      instead re-derives the mapping from `width`/`height` attributes that are
 *      INTEGERS: a 97-viewport-px crop declares 48 where it is really 48.5, and
 *      the 0.5 becomes a 1.5% horizontal/vertical scale MISMATCH that skews
 *      every label a little further out the further it sits from the origin.
 *
 *   2. Each run declares `textLength` — the advance width pdf.js measured — with
 *      `lengthAdjust="spacingAndGlyphs"`. The overlay is not drawn in the
 *      document's embedded font (it is drawn in whatever `font-family: inherit`
 *      resolves to), so an unconstrained run drifts from its raster twin as it
 *      gets longer. The PDF already states the true width; forcing the run into
 *      it is the same correction pdf.js's own text layer applies.
 *
 * And SVG `<text>` is positioned by its BASELINE, which is exactly what the
 * classifier measured, so the old cap-height fudge disappears with it.
 */
function _imageTextLayer(region, textMeta, imgPixels = null, visible = false) {
    const bbox = region.bbox;
    const idxs = region.textItemIndices || [];
    if (!bbox || !bbox.w || !bbox.h || !idxs.length) return { html: '', text: '' };

    const items = idxs
        .map(i => textMeta[i])
        .filter(tm => tm && tm.str && tm.str.trim())
        .sort((a, b) => a.vy - b.vy || a.vx - b.vx);
    if (!items.length) return { html: '', text: '' };

    // Viewport px → crop px. Falls back to 1:1 (viewport units) for a region
    // with no crop, where the placeholder box IS the bbox.
    const vbW = imgPixels?.pw || bbox.w;
    const vbH = imgPixels?.ph || bbox.h;
    const sx = vbW / bbox.w;
    const sy = vbH / bbox.h;

    // Viewport → crop space. Composed onto each run's own matrix below rather
    // than applied to a scalar x/y, so a run that is rotated AND sheared AND
    // non-uniformly scaled lands as one transform instead of three separate
    // approximations that each fix one axis and break another.
    const toCrop = [sx, 0, 0, sy, -bbox.x * sx, -bbox.y * sy];

    const texts = [];
    for (const tm of items) {
        // The matrix path is the schema editor's: it carries the run's full
        // orientation, and the em size is the LENGTH of its y basis vector.
        // Scalars stay as the fallback for meta built without a matrix.
        const m = tm.vm ? _mulMatrix(toCrop, tm.vm) : null;
        const x = m ? m[4] : (tm.vx - bbox.x) * sx;
        const y = m ? m[5] : (tm.vy - bbox.y) * sy;   // baseline, straight through
        if (!isFinite(x) || !isFinite(y)) continue;
        const fs = m ? (Math.hypot(m[2], m[3]) || 1) : (tm.vFont || 10) * sy;
        if (!(fs > 0.4)) continue;                    // sub-visible, not a label
        // A single glyph has no inter-character spacing to redistribute, and a
        // zero/absent advance means pdf.js never measured one.
        const adv = (tm.vWidth || 0) * sx;
        const fit = (adv > 0 && tm.str.length > 1)
            ? ` textLength="${adv.toFixed(2)}" lengthAdjust="spacingAndGlyphs"`
            : '';

        let place;
        if (m) {
            // The matrix ALREADY carries the em size — a text matrix maps a
            // 1-unit em box into place — so font-size beside an un-normalised
            // matrix multiplies the two. Divide the basis out and let font-size
            // carry the scale alone.
            //
            // `scale(1,-1)` un-flips the glyphs. The viewport transform negates
            // y, so the composed matrix maps text-space up to screen-space
            // down: without the flip the baseline is right and the letters are
            // upside down, which is the classic form of this bug. Negating the
            // coordinates instead would move the baseline, not the glyphs.
            //
            // x/y stay explicit zeros: the translate lives in the matrix, and
            // the IR round trip reads x/y off this element. Dropping the
            // attributes would make them parse as NaN.
            const n = [m[0] / fs, m[1] / fs, m[2] / fs, m[3] / fs];
            place = ` x="0" y="0" transform="matrix(${_num2(n[0])} ${_num2(n[1])} ` +
                    `${_num2(n[2])} ${_num2(n[3])} ${_num2(x)} ${_num2(y)}) scale(1,-1)"`;
        } else {
            const rot = (tm.rot && Math.abs(tm.rot) > 0.0087)
                ? ` transform="rotate(${(tm.rot * 180 / Math.PI).toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)})"`
                : '';
            place = ` x="${x.toFixed(2)}" y="${y.toFixed(2)}"${rot}`;
        }

        texts.push(
            `<text class="pdf-img-label"${place} ` +
            `font-size="${fs.toFixed(2)}"${fit} xml:space="preserve">${esc(tm.str)}</text>`
        );
    }
    if (!texts.length) return { html: '', text: '' };

    return {
        html: `<svg class="pdf-image-textlayer" viewBox="0 0 ${_num(vbW)} ${_num(vbH)}" ` +
              `preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" ` +
              `style="position:absolute;left:0;top:0;width:100%;height:100%;` +
              `fill:${visible ? 'currentColor' : 'transparent'};font-family:inherit;">${texts.join('')}</svg>`,
        text: items.map(tm => tm.str).join(' ').replace(/\s+/g, ' ').trim(),
    };
}

function _rgb(color, fallback = 'none') {
    if (!Array.isArray(color) || color.length < 3) return fallback;
    return `rgb(${color.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(' ')})`;
}

function _vectorFigureSvg(region, overlay = false) {
    const b = region.bbox;
    if (!b?.w || !b?.h || !region.vectorPaths?.length) return '';
    const paths = region.vectorPaths.map(path => {
        const d = path.commands.map(c => `${c[0]}${c.slice(1).map(_num).join(' ')}`).join(' ');
        const fill = path.filled ? _rgb(path.fillColor, 'currentColor') : 'none';
        const stroke = _rgb(path.strokeColor, 'currentColor');
        return `<path d="${d}" fill="${fill}" stroke="${stroke}" ` +
            `stroke-width="${_num((path.strokeWidth || 1) * 2)}" vector-effect="non-scaling-stroke"/>`;
    }).join('');
    const style = overlay
        ? 'position:absolute;inset:0;width:100%;height:100%;display:block;'
        : `display:block;width:100%;height:auto;aspect-ratio:${_num(b.w)}/${_num(b.h)}`;
    return `<svg class="extracted-pdf-vector" data-img-id="${esc(region.id)}" ` +
        `viewBox="0 0 ${_num(b.w)} ${_num(b.h)}" preserveAspectRatio="none" ` +
        `xmlns="http://www.w3.org/2000/svg" style="${style}">${paths}</svg>`;
}

/** Compose two 2D affine matrices in PDF's [a b c d e f] order: apply b, then a. */
function _mulMatrix(a, b) {
    return [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ];
}

/** Two decimals, trailing zeros dropped — matrix terms need no more. */
function _num2(v) {
    return String(Math.round(v * 100) / 100);
}

/** Trim a float to a short, exact-enough string without forcing an integer. */
function _num(v) {
    return Number.isInteger(v) ? String(v) : Number(v.toFixed(2)).toString();
}

/**
 * Wrap a picture and its label overlay in a box that is exactly the picture.
 *
 * Two things must hold and both were broken:
 *
 *   1. NO `container-type` here. Inline-size containment makes a box compute
 *      its inline size as if it had no contents, and this box is shrink-to-fit
 *      (`display: inline-block`) — so it resolved to zero, `max-width: 100%`
 *      on the image resolved against zero, and every labelled picture in the
 *      document rendered 0×0. Measured, not theorised: removing this one
 *      declaration took the image from 0×0 back to 206×112.
 *   2. The overlay is positioned against THIS box, so this box has to be the
 *      picture's box. The placeholder's `margin: 10px 0` moves to the wrapper;
 *      left on the inner div it pushed the picture down inside the wrapper and
 *      every label sat ~10px high.
 */
function _imageStack(imgHtml, layerHtml) {
    const inner = imgHtml.replace(/(<div class="pdf-image-placeholder"[^>]*style="[^"]*?)margin:\s*10px 0;\s*/, '$1');
    return `<div class="pdf-image-stack" style="position: relative; display: inline-block; ` +
           `max-width: 100%; margin: 10px 0;">${inner}${layerHtml}</div>`;
}

function _renderRegion(region, textMeta, textItems, viewport, pageWidthPt, fontRegistry, extractedImages = {}, _pageScaleOpts = {}, containers = null, linkByIndex = null, renderOpts = {}) {
    const container = containers
        ? (containers.byCol.get(region.columnIndex ?? -1) || containers.page)
        : null;
    let html = '';
    let text = '';
    let tables = 0;

    // A table cell is a layout container. Its classifier-produced children go
    // through this same renderer so headings, paragraphs, lists, boxes, images
    // and nested tables retain their semantics instead of becoming one inline
    // text string. Spanning cells collect children from every covered grid slot.
    const renderTableCell = region.cellChildren ? ({ row, col, rowspan, colspan, fallbackContent }) => {
        const children = [];
        for (let dr = 0; dr < rowspan; dr++) {
            for (let dc = 0; dc < colspan; dc++) {
                children.push(...(region.cellChildren[`${row + dr}:${col + dc}`] || []));
            }
        }
        if (!children.length) return fallbackContent;
        children.sort((a, b) => (a.bbox?.y ?? 0) - (b.bbox?.y ?? 0) ||
                                (a.bbox?.x ?? 0) - (b.bbox?.x ?? 0));
        const parts = [];
        for (const child of children) {
            const rendered = _renderRegion(child, textMeta, textItems, viewport, pageWidthPt,
                fontRegistry, extractedImages, _pageScaleOpts, containers, linkByIndex, renderOpts);
            tables += rendered.tables;
            if (rendered.html) {
                const childAddr = child.id != null
                    ? ` data-region-id="${_escAttr(String(child.id))}"` +
                      ` data-region-type="${_escAttr(String(child.type || ''))}"`
                    : '';
                parts.push(`<div class="pdf-table-cell-block"${childAddr}>${rendered.html}</div>`);
            }
        }
        return parts.join('') || fallbackContent;
    } : null;

    switch (region.type) {
        case RegionType.LATTICE_TABLE:
        case RegionType.TABLE: {          // TABLE kept as legacy alias
            if (!region.lattice) break;
            const scopedItems = _scopeItems(region, textItems, textMeta, linkByIndex);
            const tableHtml = buildTable(region.lattice, scopedItems, viewport, new Set(), region.proximityPx, renderTableCell);
            if (tableHtml) {
                html = `<div class="pdf-table-wrap pdf-table--lattice" data-region-id="${region.id}">${tableHtml}</div>`;
                tables = 1;
            }
            break;
        }

        case RegionType.STREAM_TABLE: {
            if (!region.lattice) break;
            const scopedItems = _scopeItems(region, textItems, textMeta, linkByIndex);
            const tableHtml = buildTable(region.lattice, scopedItems, viewport, new Set(), region.proximityPx, renderTableCell);
            if (tableHtml) {
                html = `<div class="pdf-table-wrap pdf-table--borderless" data-region-id="${region.id}">${tableHtml}</div>`;
                tables = 1;
            }
            break;
        }

        case RegionType.DIVIDER: {
            html = `<hr class="pdf-divider">`;
            break;
        }

        case RegionType.IMAGE: {
            const imgEntry = extractedImages[region.id];
            // The crop's address in the blob store, written by the producer
            // (which is the only side that knows the page number — a region id
            // is page-local). `dataUrl` is the legacy shape, still accepted for
            // producers with no store to write to, but nothing in the app uses
            // it: pixels belong in IndexedDB, not in the document string.
            const storeKey = imgEntry?.key ?? null;
            const dataUrl  = imgEntry?.dataUrl ?? null;

            let imgTag, imgHtml;
            const vectorSvg = _vectorFigureSvg(region);
            if (storeKey || dataUrl) {
                // pw/ph are the crop dimensions at the producer's render scale
                // (`scale`, 4× for the geometry worker's page render). Divide by
                // it to get CSS px at 1× (96 dpi equivalent of PDF pt). The
                // scale is carried on the entry rather than assumed: the scanned
                // bridge crops off a 2× canvas, and a hardcoded 4 would halve
                // every picture it produced.
                const cropScale = imgEntry.scale || 4;
                const natW = Math.round(imgEntry.pw / cropScale);
                const natH = Math.round(imgEntry.ph / cropScale);
                // The box these pixels were cut from, in viewport space. Stated
                // on the element so a later pass can tell whether the crop still
                // describes the region: re-extraction re-classifies the page, and
                // a picture whose box did not move needs no new pixels. Without
                // it, reuse would be a guess and the only safe move would be to
                // render the page again for every re-extract.
                const cb = region.bbox;
                const cropAttr = cb
                    ? ` data-crop="${Math.round(cb.x)},${Math.round(cb.y)},${Math.round(cb.w)},${Math.round(cb.h)}"`
                    : '';
                // Reference, not payload. `hydrateImages` resolves the key to a
                // blob: object URL when this markup reaches a live surface, and
                // the export re-inlines base64 into the downloaded file. The
                // width/height stay on the tag so the page reserves the right
                // box before — and if — the pixels arrive.
                const srcAttr = storeKey
                    ? ` data-img-id="${storeKey}"`
                    : ` src="${dataUrl}"`;
                imgTag  = `<img class="extracted-pdf-image"${srcAttr} width="${natW}" height="${natH}" alt="PDF Image ${region.id}" style="max-width: 100%; height: auto; display: block;">`;
                imgHtml = `<div class="pdf-image-placeholder" data-region-id="${region.id}"${cropAttr} style="margin: 10px 0;">${imgTag}</div>`;
            } else if (vectorSvg) {
                imgHtml = `<div class="pdf-image-placeholder pdf-vector-figure" data-region-id="${esc(region.id)}" ` +
                    `style="margin:10px 0;width:100%;">${vectorSvg}</div>`;
            } else {
                // Placeholder: use bbox proportions so layout reserves the right space
                const bboxW = region.bbox ? region.bbox.w : 0;
                const bboxH = region.bbox ? region.bbox.h : 0;
                const widthPct = viewport.width > 0
                    ? Math.min(100, Math.round((bboxW / viewport.width) * 100))
                    : 100;
                const aspectStyle = (bboxW > 0 && bboxH > 0)
                    ? `aspect-ratio: ${Math.round(bboxW)} / ${Math.round(bboxH)}; height: auto;`
                    : `min-height: 120px;`;
                // Bare region id, not a store key: there are no pixels to
                // address. It marks the element as an image for the IR
                // (htmlToGxDoc) and keeps it addressable if a crop is produced
                // for it later.
                imgTag  = `<img class="extracted-pdf-image" data-img-id="${region.id}" alt="PDF Image ${region.id}" style="width: 100%; height: auto; display: block;">`;
                imgHtml = `<div class="pdf-image-placeholder" data-region-id="${region.id}" style="width: ${widthPct}%; ${aspectStyle} border: 2px dashed #ccc; background: #f9f9f9; margin: 10px 0; overflow: hidden;">` +
                    `<span style="display: block; padding: 8px; font-size: 10px; font-family: monospace; color: #999;">[${region.id}]</span>` +
                    imgTag + `</div>`;
            }

            // Overlay the picture's own labels as a positioned, editable text
            // layer — the same shape as a PDF viewer's selectable text over a
            // page canvas. A diagram's callouts are real content: the region
            // CLAIMS them so they don't scatter into the paragraph flow, and
            // without this they were then dropped from both the markup and the
            // text output, silently deleting every label on the page.
            const layer = _imageTextLayer(region, textMeta, imgEntry || null, !!vectorSvg);
            // Operator geometry is transfer metadata, not a second visible
            // rendering. Showing it above the crop duplicates strokes and can
            // make a mixed raster/vector figure look like several images. The
            // semantic label layer remains because the worker deliberately
            // masks PDF.js's broken embedded-font pixels before this replaces
            // them. Schema receives the vector Scene separately.
            if (layer.html) {
                imgHtml = _imageStack(imgHtml, layer.html);
            }
            if (layer.html) {
                text = layer.text;
            }

            if (region.captionRegion) {
                const capData = _renderRegion(region.captionRegion, textMeta, textItems, viewport, pageWidthPt, fontRegistry, extractedImages, _pageScaleOpts, containers, linkByIndex, renderOpts);
                html = `<figure class="pdf-figure" style="margin: 16px 0;">${imgHtml}<figcaption class="pdf-figcaption" style="text-align: center; font-size: 0.9em; color: #666; margin-top: 8px;">${capData.html}</figcaption></figure>`;
                text = text ? `${text}\n${capData.text}` : capData.text;
            } else {
                html = imgHtml;
            }
            break;
        }

        case RegionType.HEADING: {
            const scopedItems = _scopeItems(region, textItems, textMeta, linkByIndex);
            const scopedMeta  = region.textItemIndices.map(i => textMeta[i]);
            // Use inline-html to get styled runs without a wrapping <p>
            const headingHtml = rebuildText(scopedItems, pageWidthPt, { format: 'inline-html', ..._pageScaleOpts });
            if (!headingHtml.trim()) break;

            const { family, sizePt, bold, italic } = _getRegionFont(scopedMeta);
            const fontClass  = _registerFont(fontRegistry, family, sizePt, bold, italic);
            const alignClass = ALIGN_CLASS[_inferAlignment(scopedMeta, region.bbox, container)] || 'ta-l';
            const tag = region.isH1 ? 'h1' : ((region.fontSize || 14) > 18 ? 'h2' : 'h3');

            html = `<${tag} class="${fontClass} ${alignClass}">${headingHtml}</${tag}>`;
            text = rebuildText(scopedItems, pageWidthPt, { format: 'text', ..._pageScaleOpts });
            break;
        }

        case RegionType.LIST: {
            const scopedItems = _scopeItems(region, textItems, textMeta, linkByIndex);
            const scopedMeta  = region.textItemIndices.map(i => textMeta[i]);
            const rawList = _buildList(scopedItems, pageWidthPt, region.listOrdered);
            if (!rawList) break;

            const { family, sizePt, bold, italic } = _getRegionFont(scopedMeta);
            const fontClass = _registerFont(fontRegistry, family, sizePt, bold, italic);

            // Parse the raw <ul>/<ol> into standalone list with correct semantics
            html = _buildStandaloneList(rawList.html, fontClass, rawList.startNum);
            text = scopedItems.map(i => i.str?.trim()).filter(Boolean).join('\n');
            break;
        }

        // MATH is the same renderer as PARAGRAPH with the detector forced on:
        // a region the user tagged by hand goes to LaTeX even when the gate
        // would have refused it, and falls back to prose if it cannot be built.
        case RegionType.MATH:
        case RegionType.PARAGRAPH: {
            const forceMath = region.type === RegionType.MATH;
            const scopedItems = _scopeItems(region, textItems, textMeta, linkByIndex);
            const scopedMeta  = region.textItemIndices.map(i => textMeta[i]);

            // Display math: a math-dense line with structure (fractions,
            // series limits, radicals, scripts) assembles to LaTeX.
            //
            // WHAT IS NOT DONE HERE, DELIBERATELY: the LaTeX is not rendered as
            // the visible content. Reconstruction has to infer structure from
            // glyph positions because the operators that carry the meaning are
            // vector-drawn and absent from the text layer, so a summation's
            // limits routinely come back as a fraction. That output is valid
            // TeX, typesets cleanly, and is wrong — and rendering it REPLACES
            // the glyphs that were the only evidence it was wrong.
            //
            // So the reconstruction ships as a suggestion in `data-latex` while
            // the page keeps showing what the page actually said. It becomes
            // the rendering only once a human confirms it, via
            // core.applyRegionLatex, which is what `data-math` now marks.
            let mathLatex = null;
            try {
                if (renderOpts.skipMath) mathLatex = null;
                else mathLatex = buildDisplayMath(scopedItems, { force: forceMath });
            } catch { /* any failure degrades to the plain-text path */ }

            const paraHtml = rebuildText(scopedItems, pageWidthPt, { format: 'html', ..._pageScaleOpts });
            if (!paraHtml.trim() && !mathLatex) break;

            const { family, sizePt, bold, italic } = _getRegionFont(scopedMeta);
            const fontClass  = _registerFont(fontRegistry, family, sizePt, bold, italic);
            const alignClass = ALIGN_CLASS[_inferAlignment(scopedMeta, region.bbox, container)] || 'ta-l';

            // Flow-chain attrs: semantic surfaces rejoin column-broken
            // paragraphs via these attributes. Only the first <p> in a
            // region carries them (subsequent blocks are continuations).
            let firstFlowAttrs = '';
            if (region.flowId) {
                firstFlowAttrs = ` id="${region.flowId}"`;
                if (region.flowNext) firstFlowAttrs += ` data-flow-next="${region.flowNext}"`;
                if (region.flowPrev) {
                    firstFlowAttrs += ` data-flow-prev="${region.flowPrev}" data-continuation=""`;
                    if (region.flowJoin && region.flowJoin !== 'space') {
                        firstFlowAttrs += ` data-flow-join="${region.flowJoin}"`;
                    }
                }
            }

            if (mathLatex) {
                // A real math block. Three things go out together, and each one
                // answers a different question:
                //
                //   data-latex        the TeX — the CONTENT, what TAFNE opens
                //                     and what every exporter carries.
                //   the body          the typeset equation, so an equation
                //                     reads as an equation on the page.
                //   data-math-source  the glyphs the page actually contained —
                //                     the EVIDENCE the render replaced.
                //
                // An earlier pass left the glyphs on screen unrendered, on the
                // grounds that typesetting a reconstruction asserts it is
                // right. The concern is real but the remedy was worse: it made
                // every equation in every document display as broken inline
                // text. Rendering with the source kept beside it answers it
                // properly — `data-math-suggested` still says nobody has
                // checked this, the styling marks it, and the original glyphs
                // are one attribute away, so a wrong reconstruction is visible
                // and recoverable rather than invisible and lossy.
                const texAttr = String(mathLatex).replace(/"/g, '&quot;');
                // rebuildText emits one <p> per line. Those cannot be nested
                // inside this one: the parser auto-closes the outer <p> at the
                // first inner one and the glyphs end up as SIBLINGS of an empty
                // math block, which is how this shipped empty the first time.
                // Flattened to inline runs so the sub/superscripts that make an
                // equation readable survive, with the line breaks kept.
                const glyphBody = _inlineParagraphs(paraHtml) || esc(mathLatex);
                const glyphText = scopedItems.map(i => i.str).join('').trim();

                // TeX that will not typeset is NOT rendered — the block falls
                // back to the glyphs. An equation that silently disappears
                // because its reconstruction was malformed is the one failure
                // worse than an ugly one.
                const typeset = renderMath(mathLatex);
                const marker = ' ' + mathMarker({ typeset: !!typeset });
                const srcAttr = typeset
                    ? ` data-math-source="${_escAttr(glyphText)}"`
                    : '';
                html = `<p class="${fontClass} ${alignClass} pdf-paragraph pdf-math-block"` +
                       `${firstFlowAttrs}${marker} data-latex="${texAttr}"${srcAttr}>` +
                       `${typeset || glyphBody}</p>`;
                // `text` is what this block MEANS in plain text, and the page's
                // own glyphs are a better answer than a guess at their TeX.
                text = glyphText || mathLatex;
                // Tell the analyze overlay what this actually became, so the
                // Regions legend can show — and switch off — the equations.
                region.type = RegionType.MATH;
                break;
            }
            // A MATH region whose LaTeX could not be built is prose again, and
            // must say so or the legend would show an equation that is not one.
            if (forceMath) region.type = RegionType.PARAGRAPH;

            // Flatten: extract <p> contents from rebuildText's html output
            // and re-wrap in proper <p> tags with font/alignment classes.
            // This eliminates the intermediate <div class="f0 ta-l"> wrapper:
            //
            //   Before: .pdf-region > div.f0.ta-l > p   (3 levels)
            //   After:  .pdf-region > p.f0.ta-l.pdf-paragraph  (2 levels)
            //
            // The result is valid HTML that editors and CSS frameworks
            // can work with directly. Multiple <p> blocks per region
            // (from sentence-aware paragraph breaks in rebuildText) are
            // emitted as separate <p> siblings — only the first carries
            // flow-chain metadata.
            const pBlocks = [];
            const pRe = /<p([^>]*)>([\s\S]*?)<\/p>/g;
            let pm;
            while ((pm = pRe.exec(paraHtml)) !== null) {
                pBlocks.push({ attrs: pm[1] || '', content: pm[2] });
            }

            if (pBlocks.length) {
                html = pBlocks.map((b, fi) => {
                    const attrs = (fi === 0 ? firstFlowAttrs : '') + b.attrs;
                    return `<p class="${fontClass} ${alignClass} pdf-paragraph"${attrs}>${b.content}</p>`;
                }).join('\n');
            } else {
                // Fallback: if rebuildText produced no <p> blocks (e.g. all
                // headings from textRebuilder's heuristic inside a paragraph-
                // classified region), keep the original wrapper structure.
                html = `<div class="${fontClass} ${alignClass}"${firstFlowAttrs}>${paraHtml}</div>`;
            }
            text = rebuildText(scopedItems, pageWidthPt, { format: 'text', ..._pageScaleOpts });
            break;
        }

        case RegionType.BOX: {
            let scopedItems = _scopeItems(region, textItems, textMeta, linkByIndex);
            let scopedMeta  = region.textItemIndices.map(i => textMeta[i]);

            // In-box banner: when the black "! WARNING" bar shares the same
            // bordered rectangle as the body (right-column admonitions), the
            // banner label lives in the box's top items at a much larger font.
            // Split those items into bannerText and drop them from the body flow
            // so the header renders once, styled, not as oversized inline text.
            let bannerText = region.bannerText || null;
            if (!bannerText && region.boxRole && region.boxRole !== 'generic' && scopedMeta.length) {
                const bodyFonts = scopedMeta.map(m => m.vFont || 0).filter(Boolean).sort((a, b) => a - b);
                const medFont = bodyFonts[Math.floor(bodyFonts.length / 2)] || 0;
                const topY = Math.min(...scopedMeta.map(m => m.vy));
                const bandTol = medFont * 0.8;
                const bannerIdx = new Set();
                let labelParts = [];
                for (let k = 0; k < scopedMeta.length; k++) {
                    const m = scopedMeta[k];
                    if (m.vy <= topY + bandTol && (m.vFont || 0) >= medFont * 1.5) {
                        bannerIdx.add(k);
                        if (/[A-Za-z]/.test(m.str)) labelParts.push(m.str.trim());
                    }
                }
                const label = labelParts.join(' ').toUpperCase();
                if (bannerIdx.size && /\b(WARNING|CAUTION|DANGER|NOTICE|NOTE|IMPORTANT)\b/.test(label)) {
                    bannerText = label;
                    scopedItems = scopedItems.filter((_, k) => !bannerIdx.has(k));
                    scopedMeta = scopedMeta.filter((_, k) => !bannerIdx.has(k));
                }
            }

            // The contents were classified as a document fragment of their own
            // (contextClassifier's box-interior pass), so render those children
            // through this same function and wrap the box around the result.
            // Rendering the box's items as one flat text rebuild — the old path,
            // kept below for a box with no children — is what flattened a
            // callout's headings, bullets and nested tables into a single block.
            let innerHtml = '';
            let innerText = '';
            const kids = region.children || [];
            if (kids.length) {
                const parts = [];
                for (const child of kids) {
                    const kid = _renderRegion(child, textMeta, textItems, viewport, pageWidthPt,
                        fontRegistry, extractedImages, _pageScaleOpts, containers, linkByIndex, renderOpts);
                    tables += kid.tables;
                    if (!kid.html) continue;
                    const kidId = child.id != null
                        ? ` data-region-id="${_escAttr(String(child.id))}"` +
                          ` data-region-type="${_escAttr(String(child.type || ''))}"`
                        : '';
                    parts.push(`<div class="pdf-box-block"${kidId}>${kid.html}</div>`);
                    if (kid.text) innerText += (innerText ? '\n' : '') + kid.text;
                }
                innerHtml = parts.join('');
            }
            if (!innerHtml) {
                innerHtml = rebuildText(scopedItems, pageWidthPt, { format: 'html', ..._pageScaleOpts });
                innerText = rebuildText(scopedItems, pageWidthPt, { format: 'text', ..._pageScaleOpts });
            }
            if (!innerHtml.trim() && !bannerText) break;

            const { family, sizePt, bold, italic } = _getRegionFont(scopedMeta);
            const fontClass  = _registerFont(fontRegistry, family, sizePt, bold, italic);
            const alignClass = ALIGN_CLASS[_inferAlignment(scopedMeta, region.bbox, container)] || 'ta-l';
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


            // Safety admonitions (WARNING/CAUTION/NOTICE) carry a banner header
            // that the source draws as a black bar with an icon. Render it as a
            // styled header so the box reads like the PDF, not as inline text.
            const roleIcon = { warning: '⚠', caution: '⚠', note: 'ℹ', tip: '💡' };
            let bannerHtml = '';
            if (bannerText) {
                const icon = roleIcon[region.boxRole] || '';
                bannerHtml = `<div class="pdf-box-banner">${icon ? `<span class="pdf-box-icon">${icon}</span>` : ''}${esc(bannerText)}</div>`;
            }

            html = `<aside class="pdf-box${roleClass} ${fontClass} ${alignClass}"${bgStyle}>${bannerHtml}${innerHtml}</aside>`;
            text = (bannerText ? bannerText + '\n' : '') + innerText;
            break;
        }

        case RegionType.REFERENCE: {
            const scopedItems = _scopeItems(region, textItems, textMeta, linkByIndex);
            const scopedMeta  = region.textItemIndices.map(i => textMeta[i]);
            const innerHtml   = rebuildText(scopedItems, pageWidthPt, { format: 'inline-html', ..._pageScaleOpts });
            if (!innerHtml.trim()) break;

            const { family, sizePt, bold, italic } = _getRegionFont(scopedMeta);
            const fontClass = _registerFont(fontRegistry, family, sizePt, bold, italic);

            // A bibliography that cannot be addressed per entry is not usable
            // as an artifact — you cannot cite, count, or export "the wall of
            // text on page 21". The detector recorded where each entry begins;
            // split the rebuilt line on those boundaries so every entry is its
            // own <li>. A continuation carries no boundaries of its own and
            // stays one item, marked as such.
            const groups = _splitReferenceItems(scopedItems);
            const contAttr = region.continuationOf ? ' data-ref-continuation=""' : '';
            const items = (groups.length > 1 ? groups : [scopedItems])
                .map(g => rebuildText(g, pageWidthPt, { format: 'inline-html', ..._pageScaleOpts }))
                .filter(h => h.trim())
                .map((h, i) => `<li class="pdf-reference" data-ref-index="${i}">${h}</li>`)
                .join('');
            html = `<ol class="pdf-references ${fontClass}"${contAttr}>${items}</ol>`;
            text = rebuildText(scopedItems, pageWidthPt, { format: 'text', ..._pageScaleOpts });
            break;
        }

        case RegionType.HEADER:
        case RegionType.FOOTER: {
            const scopedItems = _scopeItems(region, textItems, textMeta, linkByIndex);
            const scopedMeta  = region.textItemIndices.map(i => textMeta[i]);
            const innerHtml   = rebuildText(scopedItems, pageWidthPt, { format: 'inline-html', ..._pageScaleOpts });
            if (!innerHtml.trim()) break;

            const { family, sizePt, bold, italic } = _getRegionFont(scopedMeta);
            const fontClass = _registerFont(fontRegistry, family, sizePt, bold, italic);
            const alignClass = ALIGN_CLASS[_inferAlignment(scopedMeta, region.bbox, container)] || 'ta-l';
            const tag = region.type === RegionType.HEADER ? 'header' : 'footer';

            html = `<${tag} class="pdf-${tag} ${fontClass} ${alignClass}">${innerHtml}</${tag}>`;
            text = rebuildText(scopedItems, pageWidthPt, { format: 'text', ..._pageScaleOpts });
            break;
        }
    }

    return { html, text, tables };
}

// ── List builder ──────────────────────────────────────────────────────────────

const BULLET_STRIP_RE = /^[•‣◦▪▫–—―·○o◦◉▪▫-]\s*/;
// (?!\d) prevents decimal values ("0.5 amp") from being read as marker "0."
const ORDERED_STRIP_RE = /^(?:\d{1,3}[.)](?!\d)\s*|[a-zA-Z][.)](?:\s+|$)|[ivxIVX]+[.)](?:\s+|$))/;

// Inline-style helpers (mirrors textRebuilder without the module dependency)
function _itemStyle(item) {
    const name = (item.fontName || '').replace(/^[A-Z]{6}\+/, '');
    return {
        bold:      item.bold   ?? /bold|heavy|black/i.test(name),
        italic:    item.italic ?? /italic|oblique|slanted/i.test(name),
        underlined: !!item.underlined,
        link:      item._gxLink ?? null,
    };
}

/**
 * Split a reference block's text items into one group per bibliography entry.
 *
 * The boundaries are recomputed here rather than read off `region.entryOffsets`
 * on purpose: those offsets index the classifier's joined text, and _scopeItems
 * may not hand back that exact sequence. Recomputing against the items actually
 * being rendered means the split lands between items instead of near them.
 *
 * Returns one group per entry, or a single group when no boundary was found.
 */
function _splitReferenceItems(items) {
    // Item index → character offset of that item in the joined text, built the
    // same way the detector builds it (single spaces, collapsed runs).
    const starts = [];
    let joined = '';
    for (const item of items) {
        const str = String(item?.str ?? '');
        if (joined) joined += ' ';
        starts.push(joined.length);
        joined += str;
    }
    joined = joined.replace(/\s+/g, ' ');
    // The collapse can shift offsets; redo it on the collapsed string by
    // walking the same items, which is exact for the single-space join above.
    const offsets = entryOffsets(joined);
    if (offsets.length < 2) return [items];

    const groups = [];
    let cursor = 0;
    for (const off of offsets) {
        // First item whose start is at or past this boundary.
        let idx = starts.findIndex((s, i) => i > cursor - 1 && s >= off);
        if (idx < 0) idx = items.length;
        if (idx > cursor) { groups.push(items.slice(cursor, idx)); cursor = idx; }
    }
    if (cursor < items.length) groups.push(items.slice(cursor));
    return groups.filter(g => g.length);
}

/**
 * Collapse a run of block <p> elements into inline content joined by <br>.
 *
 * Only used where the result has to live INSIDE a <p> (display math). The inner
 * markup — <em>, <sub>, <sup> — is what makes an equation legible as text, so it
 * is kept; only the block wrappers go. Empty paragraphs are dropped rather than
 * becoming stray breaks.
 */
function _inlineParagraphs(html) {
    const src = String(html || '');
    if (!/<p[\s>]/i.test(src)) return src.trim();
    const parts = [];
    const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = re.exec(src))) {
        const inner = m[1].trim();
        if (inner) parts.push(inner);
    }
    return parts.join('<br>');
}

function _escAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function _wrapStyle(text, style) {
    let html = esc(text);
    if (style.underlined) html = `<u>${html}</u>`;
    if (style.italic)     html = `<em>${html}</em>`;
    if (style.bold)       html = `<strong>${html}</strong>`;
    if (style.link) {
        const link = style.link;
        const src = link.source ? ` data-link-source="${_escAttr(link.source)}"` : '';
        const pg  = link.page != null ? ` data-link-page="${_escAttr(String(link.page))}"` : '';
        html = `<a href="${_escAttr(link.href)}"${src}${pg}>${html}</a>`;
    }
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
    const markerRe = isOrdered ? ORDERED_STRIP_RE : BULLET_STRIP_RE;

    // Group visual lines into list items: a line starting with a marker opens a
    // new <li>; an unmarked line is the wrapped continuation of the current one.
    // (One <li> per visual line split every wrapped item into fake siblings.)
    const itemGroups = [];
    for (const l of lines) {
        const firstStr = (l.items[0]?.str || '').trimStart();
        const startsNew = markerRe.test(firstStr) || !itemGroups.length;
        if (startsNew) itemGroups.push([]);
        itemGroups[itemGroups.length - 1].push(l);
    }

    // The first ordered marker is the list's START NUMBER. A source that begins
    // at 5 must assemble as <ol start="5">, not restart at 1. The marker is
    // stripped from the <li> text below, so capture it from the raw string here
    // and hand it to the standalone wrapper — detecting it afterwards can never
    // work because the prefix is already gone.
    let startNum = 1;
    const listItems = itemGroups
        .map((group, gi) => {
            const styled = group.flatMap((l, lineIdx) =>
                l.items.map((item, idx) => {
                    let str = item.str.trim();
                    if (lineIdx === 0 && idx === 0) {
                        const numMatch = /^(\d{1,3})[.)](?!\d)/.exec(str);
                        if (gi === 0 && numMatch) startNum = parseInt(numMatch[1], 10);
                        str = str.replace(stripRe, '').trim();
                    }
                    return str ? _wrapStyle(str, _itemStyle(item)) : '';
                })
            ).filter(Boolean).join(' ');
            return styled ? `<li>${styled}</li>` : '';
        })
        .filter(Boolean);

    if (!listItems.length) return '';
    return {
        html: `<${tag}>\n${listItems.join('\n')}\n</${tag}>`,
        startNum,
    };
}

/**
 * Wraps a raw <ul>/<ol> string as a standalone, semantically-correct list.
 *
 * Improvements over the previous rawList.replace() approach:
 *  - Carries the ordered start number (captured by _buildList before it strips
 *    the marker) onto <ol start="N"> so a list that begins at 5 does not
 *    restart at 1
 *  - Strips numeric/bullet prefixes that _buildList may have left on <li> text
 *  - Detects nested items (deeper indentation prefix inside an <li>) and wraps
 *    them as child <ul>/<ol> inside the parent <li>
 *  - Wraps the whole thing in <div class="pdf-list-wrap"> so adjacent lists
 *    never merge in the DOM (contenteditable collapses adjacent same-type lists)
 */
function _buildStandaloneList(rawHtml, fontClass, startNum = 1) {
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

    // Build <li> elements — detect nested sub-items within each li
    const liTags = liContents.map(content => {
        const plainText = content.replace(/<[^>]+>/g, '').trim();
        // Strip leading bullet/number prefix that was kept by _buildList in edge cases
        const stripped = content
            .replace(/^(\s*(?:<[^>]+>\s*)*)(?:\d+[.)](?!\d)\s*|[•‣◦▪▫–—―·○◦◉▪▫-]\s*)/, '$1');

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
    const startAttr  = isOrdered ? ` start="${startNum}"` : '';
    const listHtml   = `<${tag} class="${fontClass}"${startAttr}>\n${liTags.join('\n')}\n</${tag}>`;

    return `<div class="pdf-list-wrap">${listHtml}</div>`;
}
