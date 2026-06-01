// textRebuilder.js
// Reconstructs reading-order plain text from a PDF.js getTextContent() item array.
//
// Three-stage pipeline (mirrors what diffchecker-class tools do):
//   1. Y-band grouping     — cluster items that share a visual line (adaptive tolerance)
//   2. Column detection    — XY-cut projection finds multi-column layouts
//   3. Text construction   — gap-based space insertion + paragraph break detection
//
// Works entirely in PDF user-space coordinates (points). No viewport / DOM required.
// Safe to run inside a Web Worker.
//
// Usage:
//   import { rebuildText } from './textRebuilder.js';
//   const text = rebuildText(textContent.items, page.view[2] - page.view[0]);
//   const html = rebuildText(textContent.items, pageWidthPt, { format: 'html' });

const DEFAULTS = {
    // Y tolerance as a fraction of avg font size — adaptive to the document
    yTolFraction:        0.45,

    // Min X gap (relative to estimated char width) to insert a space between tokens
    spaceGapFraction:    0.25,

    // Vertical gap multiplier over average line spacing → paragraph break
    paragraphGapMult:    1.5,

    // Min X gap (in PDF points) with zero coverage to consider a column separator
    columnGapPt:         18,

    // Min fraction of lines the gap must appear in to count as a real column split
    columnLineFraction:  0.12,

    // Output format: 'text' | 'html' | 'inline-html' | 'lines'
    //   text        — paragraphs separated by \n\n, lines within a paragraph joined with space
    //   html        — <p> elements, headings promoted to <h3>/<h4>; inline bold/italic/underline
    //   inline-html — same inline styling but NO block-level wrappers (<p>/<h3>); use for
    //                 headings and box content where the caller controls the outer tag
    //   lines       — one string per visual line, joined with \n (no reflow)
    format:              'text',

    // Heading detection: a line whose font size exceeds body average by this factor
    headingScale:        1.25,
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Rebuild clean plain text (or HTML paragraphs) from getTextContent() items.
 *
 * @param {Array}   items       — textContent.items
 * @param {number}  pageWidthPt — page width in PDF points (page.view[2] - page.view[0])
 * @param {object}  [opts]      — override DEFAULTS
 * @returns {string}
 */
export function rebuildText(items, pageWidthPt, opts = {}) {
    const o = { ...DEFAULTS, ...opts };

    // Derive columnGapPt from PageScale if provided (adaptive column gap)
    if (o.pageScale && o.pageScale.colGapMinPx != null && o.pageScale.vScale != null) {
        o.columnGapPt = o.pageScale.colGapMinPx / o.pageScale.vScale;
    }

    const valid = (items || []).filter(i => i.str?.trim());
    if (!valid.length) return '';

    // ── Adaptive Y tolerance ─────────────────────────────────────────────────
    const fontSizes = valid.map(i => Math.abs(i.transform?.[3] || i.height || 12));
    const avgFontSize = fontSizes.reduce((a, b) => a + b, 0) / fontSizes.length;
    const yTol = avgFontSize * o.yTolFraction;
    const bodyFontSize = avgFontSize;

    // ── 1. Y-band grouping ───────────────────────────────────────────────────
    const lines = _groupByYBand(valid, yTol);
    if (!lines.length) return '';

    // ── 2. Column detection ──────────────────────────────────────────────────
    const splits = pageWidthPt > 0
        ? _detectColumnSplits(lines, pageWidthPt, o.columnGapPt, o.columnLineFraction)
        : [];

    // ── 3. Build output ──────────────────────────────────────────────────────
    if (splits.length === 0) {
        return _buildOutput(lines, o, bodyFontSize);
    }

    // Multi-column: process each column separately, then join
    const cols = _splitIntoColumns(lines, splits);
    const colTexts = cols.map(c => _buildOutput(c, o, bodyFontSize));

    return o.format === 'html'
        ? colTexts.join('\n')
        : colTexts.join('\n\n');
}

// ── Y-band grouping ───────────────────────────────────────────────────────────

function _groupByYBand(items, yTol) {
    // PDF Y origin is bottom-left (Y increases upward).
    // Sort descending → top of page first.
    const sorted = [...items].sort((a, b) => b.transform[5] - a.transform[5]);

    const lines = [];
    for (const item of sorted) {
        const y = item.transform[5];
        // Find existing band within tolerance
        let band = null;
        for (const l of lines) {
            if (Math.abs(l.y - y) <= yTol) { band = l; break; }
        }
        if (band) {
            const n = band.items.length;
            band.y = (band.y * n + y) / (n + 1); // running average Y
            band.items.push(item);
        } else {
            lines.push({ y, items: [item] });
        }
    }

    // Sort items within each band left-to-right
    for (const l of lines) {
        l.items.sort((a, b) => a.transform[4] - b.transform[4]);
    }

    return lines;
}

// ── Column split detection (XY-cut) ──────────────────────────────────────────

function _detectColumnSplits(lines, pageWidthPt, minGapPt, minLineFraction) {
    const w = Math.ceil(pageWidthPt);
    // coverage[x] = number of text items whose X-range covers pixel x
    const coverage = new Float32Array(w);

    for (const l of lines) {
        for (const item of l.items) {
            const x1 = Math.max(0, Math.floor(item.transform[4]));
            const x2 = Math.min(w - 1, Math.ceil(item.transform[4] + (item.width || 0)));
            for (let x = x1; x <= x2; x++) coverage[x]++;
        }
    }

    // Collect zero-coverage gaps of minimum width
    const candidates = [];
    let gStart = null;
    for (let x = 0; x < w; x++) {
        if (coverage[x] === 0) {
            if (gStart === null) gStart = x;
        } else if (gStart !== null) {
            if (x - gStart >= minGapPt) candidates.push((gStart + x) / 2);
            gStart = null;
        }
    }

    // Keep only splits that actually separate items across enough lines
    return candidates.filter(sx => {
        let separated = 0;
        for (const l of lines) {
            const hasL = l.items.some(i => i.transform[4] < sx);
            const hasR = l.items.some(i => i.transform[4] > sx);
            if (hasL && hasR) separated++;
        }
        return separated / lines.length >= minLineFraction;
    });
}

// ── Split lines into column buckets ──────────────────────────────────────────

function _splitIntoColumns(lines, splits) {
    const boundaries = [0, ...splits, Infinity];
    const cols = boundaries.slice(0, -1).map(() => []);

    for (const line of lines) {
        for (let ci = 0; ci < cols.length; ci++) {
            const xMin = boundaries[ci];
            const xMax = boundaries[ci + 1];
            const colItems = line.items.filter(i => i.transform[4] >= xMin - 1 && i.transform[4] < xMax);
            if (colItems.length) cols[ci].push({ y: line.y, items: colItems });
        }
    }

    return cols.filter(c => c.length > 0);
}

// ── Output builder ────────────────────────────────────────────────────────────

function _buildOutput(lines, o, bodyFontSize) {
    if (!lines.length) return '';

    // Estimate average line gap for paragraph detection
    let totalGap = 0, gapCount = 0;
    for (let i = 1; i < lines.length; i++) {
        const g = Math.abs(lines[i - 1].y - lines[i].y);
        if (g < bodyFontSize * 3) { totalGap += g; gapCount++; } // ignore huge jumps
    }
    const avgGap = gapCount ? totalGap / gapCount : bodyFontSize * 1.2;
    const paraThreshold = avgGap * o.paragraphGapMult;

    const useHtml = o.format === 'html' || o.format === 'inline-html';

    // Collect paragraphs: each paragraph is an array of line objects
    const paragraphs = [];
    let current = [];

    for (let li = 0; li < lines.length; li++) {
        const lineStr = _buildLine(lines[li].items, o.spaceGapFraction);
        if (!lineStr.trim()) continue;

        if (li > 0 && current.length > 0) {
            const gap       = Math.abs(lines[li - 1].y - lines[li].y);
            const prevEOL   = lines[li - 1].items.some(i => i.hasEOL);
            const isParaBrk = gap > paraThreshold || prevEOL;
            if (isParaBrk) {
                paragraphs.push({ lines: current, y: lines[li - 1].y });
                current = [];
            }
        }

        current.push({
            str:      lineStr.trim(),
            html:     useHtml ? _buildLineHtml(lines[li].items, o.spaceGapFraction) : null,
            fontSize: _lineFontSize(lines[li].items),
        });
    }
    if (current.length) paragraphs.push({ lines: current });

    // ── Format ───────────────────────────────────────────────────────────────

    if (o.format === 'lines') {
        return paragraphs.flatMap(p => p.lines.map(l => l.str)).join('\n');
    }

    if (o.format === 'inline-html') {
        // Raw inline content only — caller wraps in their own block tag.
        return paragraphs
            .map(p => p.lines.map(l => l.html || _escHtml(l.str)).join(' '))
            .join('<br>');
    }

    if (o.format === 'html') {
        return paragraphs.map(p => {
            const inner = p.lines.map(l => l.html || _escHtml(l.str)).join(' ');
            const isHeading = p.lines.length === 1 &&
                p.lines[0].fontSize > bodyFontSize * o.headingScale;
            if (isHeading) {
                const tag = p.lines[0].fontSize > bodyFontSize * 1.6 ? 'h3' : 'h4';
                return `<${tag}>${inner}</${tag}>`;
            }
            return `<p>${inner}</p>`;
        }).join('\n');
    }

    // Default: 'text'
    return paragraphs
        .map(p => p.lines.map(l => l.str).join(' '))
        .join('\n\n');
}

// ── Inline style helpers ──────────────────────────────────────────────────────

function _getItemStyle(item) {
    // Prefer pre-computed flags from classifyPage (sourced from page.commonObjs).
    // Fall back to fontName string parsing for PDFs processed without commonObjs access.
    const name = (item.fontName || '').replace(/^[A-Z]{6}\+/, '');
    return {
        bold:      item.bold   ?? /bold|heavy|black/i.test(name),
        italic:    item.italic ?? /italic|oblique|slanted/i.test(name),
        underlined: !!item.underlined,
    };
}

function _styleKey(s) {
    return (s.bold ? 'b' : '') + (s.italic ? 'i' : '') + (s.underlined ? 'u' : '');
}

function _wrapInlineStyle(text, style) {
    let html = _escHtml(text);
    if (style.underlined) html = `<u>${html}</u>`;
    if (style.italic)     html = `<em>${html}</em>`;
    if (style.bold)       html = `<strong>${html}</strong>`;
    return html;
}

// ── Line builder with gap-based space insertion ───────────────────────────────

function _buildLine(items, spaceGapFraction) {
    if (!items.length) return '';

    let result = items[0].str;

    for (let i = 1; i < items.length; i++) {
        const prev    = items[i - 1];
        const curr    = items[i];
        const prevEnd = prev.transform[4] + (prev.width || 0);
        const gap     = curr.transform[4] - prevEnd;

        // Estimate char width: item width / char count, fallback to font size * 0.5
        const charW = prev.str.length > 0
            ? (prev.width || 0) / prev.str.length
            : Math.abs(prev.transform[3] || 6) * 0.5;

        // If there's already trailing/leading whitespace in the strings, don't double-add
        const prevEndsSpace = /\s$/.test(prev.str);
        const currStartsSpace = /^\s/.test(curr.str);

        if (!prevEndsSpace && !currStartsSpace && gap > charW * spaceGapFraction) {
            result += ' ';
        }

        result += curr.str;
    }

    return result;
}

// Style-aware version — groups items into same-style runs and wraps each in
// appropriate HTML tags (<strong>, <em>, <u>). Returns an HTML fragment string.
function _buildLineHtml(items, spaceGapFraction) {
    if (!items.length) return '';

    // Build tokens: { text, style } with gap-based space insertion
    const tokens = [];
    for (let i = 0; i < items.length; i++) {
        if (i > 0) {
            const prev    = items[i - 1];
            const curr    = items[i];
            const prevEnd = prev.transform[4] + (prev.width || 0);
            const gap     = curr.transform[4] - prevEnd;
            const charW   = prev.str.length > 0
                ? (prev.width || 0) / prev.str.length
                : Math.abs(prev.transform[3] || 6) * 0.5;
            const prevEndsSpace  = /\s$/.test(prev.str);
            const currStartsSpace = /^\s/.test(curr.str);
            if (!prevEndsSpace && !currStartsSpace && gap > charW * spaceGapFraction) {
                tokens.push({ text: ' ', style: _getItemStyle(items[i]) });
            }
        }
        tokens.push({ text: items[i].str, style: _getItemStyle(items[i]) });
    }

    if (!tokens.length) return '';

    // Group consecutive same-style tokens into runs
    const runs = [];
    let runStyle = tokens[0].style;
    let runText  = tokens[0].text;
    for (let i = 1; i < tokens.length; i++) {
        if (_styleKey(tokens[i].style) === _styleKey(runStyle)) {
            runText += tokens[i].text;
        } else {
            runs.push({ text: runText, style: runStyle });
            runStyle = tokens[i].style;
            runText  = tokens[i].text;
        }
    }
    runs.push({ text: runText, style: runStyle });

    return runs.map(r => _wrapInlineStyle(r.text, r.style)).join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _lineFontSize(items) {
    if (!items.length) return 12;
    return items.reduce((s, i) => s + Math.abs(i.transform?.[3] || 12), 0) / items.length;
}

function _escHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
