// textRebuilder.js
// Reconstructs reading-order plain text from a PDF.js getTextContent() item array.
//
// Three-stage pipeline (mirrors what diffchecker-class tools do):
//   1. Line clustering     — items join the nearest open line whose running-mean
//                            baseline is within 0.5 × max(line size, item size);
//                            the tolerance derives itself per line, per font size
//   2. Column detection    — XY-cut projection finds multi-column layouts
//   3. Text construction   — per-line bimodal word-gap thresholds + paragraph
//                            break detection; sub/superscripts detected from
//                            size + baseline offset (html formats)
//
// The clustering, word-gap and script heuristics are ported from pdf_md
// (github.com/MasakatsuFunaki/pdf_md, MIT) — layout_lines.cpp / layout_math.cpp —
// adapted from per-glyph to pdfjs per-run granularity.
//
// Works entirely in PDF user-space coordinates (points). No viewport / DOM required.
// Safe to run inside a Web Worker.
//
// Usage:
//   import { rebuildText } from './textRebuilder.js';
//   const text = rebuildText(textContent.items, page.view[2] - page.view[0]);
//   const html = rebuildText(textContent.items, pageWidthPt, { format: 'html' });

const DEFAULTS = {
    // Items from a repaired OCR text layer: relaxes the word-gap gates, since
    // OCR geometry packs words tighter than typeset text.
    ocr:                 false,

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

    // Body size: median of item font sizes — robust against a page of
    // subscripts or one display heading skewing the mean.
    const bodyFontSize = _median(valid.map(i => Math.abs(i.transform?.[3] || i.height || 12))) || 12;

    // ── 1. Line clustering ───────────────────────────────────────────────────
    const lines = _clusterLines(valid);
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

// ── Line clustering ───────────────────────────────────────────────────────────

function _median(values) {
    if (!values.length) return 0;
    const v = [...values].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function _itemSize(item) {
    return Math.abs(item.transform?.[3] || item.height || 12);
}

// Open-line clustering: each item joins the NEAREST open line whose running-
// mean baseline is within 0.5 × max(line size, item size). The tolerance
// derives itself per line and per font size — a footnote line and a display
// heading on the same page each get their own correct band, and a subscript
// (smaller, slightly off-baseline) still lands on its parent line.
function _clusterLines(items) {
    // PDF Y origin is bottom-left (Y increases upward): top of page first.
    const sorted = [...items].sort((a, b) =>
        (b.transform[5] - a.transform[5]) || (a.transform[4] - b.transform[4]));

    const lines = [];
    for (const item of sorted) {
        const y = item.transform[5];
        const size = _itemSize(item);
        let best = null, bestDist = Infinity;
        for (const l of lines) {
            const tol = 0.5 * Math.max(l.sizeMax, size);
            const dist = Math.abs(l.y - y);
            if (dist <= tol && dist < bestDist) { best = l; bestDist = dist; }
        }
        if (!best) {
            best = { y, sizeMax: 0, items: [] };
            lines.push(best);
        }
        const n = best.items.length;
        best.y = (best.y * n + y) / (n + 1); // running mean baseline
        best.sizeMax = Math.max(best.sizeMax, size);
        best.items.push(item);
    }

    for (const l of lines) {
        l.items.sort((a, b) => a.transform[4] - b.transform[4]);
        _finalizeLine(l);
    }
    // Reading order: top of page first, then left to right.
    lines.sort((a, b) => (b.y - a.y) || (a.items[0].transform[4] - b.items[0].transform[4]));
    return lines;
}

// Derives the line's typographic facts once the membership is final:
//   size    — median item size (the line's body size)
//   sizeRef — script reference: the max size, unless a single oversized glyph
//             (a drop cap, > 1.8 × median) would make ordinary text look like
//             subscripts — then the median
//   y       — true baseline: median y of BASE-level items only (≥ 0.83 ×
//             sizeRef), so a line that is half subscript still reports the
//             baseline of its main text
function _finalizeLine(l) {
    const sizes = l.items.map(_itemSize);
    l.size = Math.max(_median(sizes), 1);
    const sizeMax = Math.max(...sizes);
    l.sizeRef = sizeMax <= 1.8 * l.size ? sizeMax : l.size;
    const baseYs = l.items.filter(i => _itemSize(i) >= 0.83 * l.sizeRef)
        .map(i => i.transform[5]);
    l.y = _median(baseYs.length ? baseYs : l.items.map(i => i.transform[5]));
    l.wordGap = 0; // computed lazily per output pass (needs opts.ocr)
}

// Per-line adaptive word-gap threshold. The inter-item gaps on a line are
// bimodal: run-continuation gaps (≈0, style changes mid-word) vs real word
// gaps. When the two clusters separate cleanly, the threshold sits in the
// largest jump between them; otherwise a fixed fraction of the line size.
// OCR text layers pack words to the scan's geometry, so their gates and
// floors are lower (with an absolute 1.2pt floor so a kerning outlier inside
// a word cannot split it).
function _wordGapThreshold(l, ocr) {
    const gaps = [];
    for (let i = 1; i < l.items.length; i++) {
        const prevEnd = l.items[i - 1].transform[4] + (l.items[i - 1].width || 0);
        gaps.push(Math.max(0, l.items[i].transform[4] - prevEnd));
    }
    const base = 0.28 * l.size;
    if (gaps.length < 3) return base;

    gaps.sort((a, b) => a - b);
    let bestJump = 0, threshold = base;
    for (let i = 1; i < gaps.length; i++) {
        const jump = gaps[i] - gaps[i - 1];
        if (jump > bestJump && gaps[i - 1] <= 0.6 * l.size) {
            bestJump = jump;
            threshold = (gaps[i - 1] + gaps[i]) / 2;
        }
    }
    const jumpGate = (ocr ? 0.06 : 0.11) * l.size;
    const clampHi = 0.9 * l.size;
    const clampLo = Math.min(ocr ? Math.max(0.10 * l.size, 1.2) : 0.18 * l.size, clampHi);
    if (bestJump < jumpGate) return base; // not bimodal enough
    return Math.min(Math.max(threshold, clampLo), clampHi);
}

// 0 = normal, 1 = superscript, 2 = subscript. An item is a script only when it
// is clearly smaller than the line's reference size AND sits off the baseline —
// the size test keeps uniformly-small lines (footnotes, captions) from tripping.
function _scriptRole(l, item) {
    const size = _itemSize(item);
    const ref = l.sizeRef || l.size;
    if (!ref || size >= 0.82 * ref) return 0;
    const off = item.transform[5] - l.y;
    if (off > 0.10 * ref) return 1;
    if (off < -0.06 * ref) return 2;
    return 0;
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
            // Keep the line's typographic facts (size/sizeRef/baseline) — the
            // column subset inherits them; only membership changed.
            if (colItems.length) cols[ci].push({ ...line, items: colItems });
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
        const lineStr = _buildLine(lines[li], o);
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
            html:     useHtml ? _buildLineHtml(lines[li], o) : null,
            fontSize: lines[li].size,
            x0:       lines[li].items[0].transform[4],
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
        // Sentence-aware paragraph emission: a gap-detected block that begins
        // before the previous block finished a sentence is a visual break, not
        // a semantic one. Keep it inside the same <p> joined with a space so
        // the <p> structure follows sentences rather than preserving PDF line
        // breaks. Editors and downstream consumers get clean reflowable text
        // instead of hard-wrapped <br> fragments.
        const indents = _detectFirstLineIndents(paragraphs, bodyFontSize);

        const blocks = paragraphs.map((p, pi) => {
            const inner = p.lines.map(l => l.html || _escHtml(l.str)).join(' ');
            const plain = p.lines.map(l => l.str).join(' ').trim();
            const isHeading = p.lines.length === 1 &&
                p.lines[0].fontSize > bodyFontSize * o.headingScale;
            const headingTag = isHeading
                ? (p.lines[0].fontSize > bodyFontSize * 1.6 ? 'h3' : 'h4')
                : null;
            return { inner, plain, isHeading, headingTag, indent: indents[pi] };
        }).filter(b => b.inner.trim());

        const out = [];
        for (const b of blocks) {
            const prev = out[out.length - 1];
            if (!b.isHeading && prev && !prev.isHeading && prev.open &&
                !_LIST_MARKER_RE.test(b.plain)) {
                prev.inner += ' ' + b.inner;
                prev.open = _sentenceOpen(b.plain);
                continue;
            }
            out.push({ ...b, open: !b.isHeading && _sentenceOpen(b.plain) });
        }

        return out.map(b => b.isHeading
            ? `<${b.headingTag}>${b.inner}</${b.headingTag}>`
            : `<p${b.indent ? ' data-indent=""' : ''}>${b.inner}</p>`
        ).join('\n');
    }

    // Default: 'text'
    return paragraphs
        .map(p => p.lines.map(l => l.str).join(' '))
        .join('\n\n');
}

// ── First-line indent detection (html format) ─────────────────────────────────

// A paragraph carries a typographic first-line indent when its opening line
// steps in from the column's dominant left edge by roughly an em (0.8–3.5 ×
// body size) while the rest of the paragraph returns to that edge. Single-line
// paragraphs qualify only when the column edge is well-attested by other
// lines — otherwise a short centered line would read as an indent.
function _detectFirstLineIndents(paragraphs, bodyFontSize) {
    const x0s = paragraphs.flatMap(p => p.lines.map(l => l.x0));
    if (x0s.length < 2) return paragraphs.map(() => false);
    const colLeft = Math.min(...x0s);
    const edgeTol = 0.3 * bodyFontSize;
    const atEdge = x0s.filter(x => x - colLeft <= edgeTol).length;
    const edgeAttested = atEdge / x0s.length >= 0.3;

    return paragraphs.map(p => {
        const d = p.lines[0].x0 - colLeft;
        if (d < 0.8 * bodyFontSize || d > 3.5 * bodyFontSize) return false;
        if (p.lines.length > 1) {
            return p.lines.slice(1).every(l => l.x0 - colLeft <= edgeTol);
        }
        return edgeAttested;
    });
}

// ── Sentence-boundary helpers (html format) ───────────────────────────────────

// Mirrors flowLinker's seam test at region scope: a block whose text does not
// end in terminal punctuation has not finished its sentence.
const _SENTENCE_CLOSERS_RE = /["'”’»›)\]\}]+$/;
const _SENTENCE_END_RE = /[.!?:…]$/;
const _LIST_MARKER_RE = /^(?:[•‣◦▪▫–—―·○◉-]\s|\d{1,3}[.)](?!\d)\s|[a-zA-Z][.)]\s|[ivxIVX]+[.)]\s)/;

function _sentenceOpen(plain) {
    if (!plain) return false;
    return !_SENTENCE_END_RE.test(plain.replace(_SENTENCE_CLOSERS_RE, ''));
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

// ── Line builder with adaptive space insertion ────────────────────────────────

// True when a space belongs between items i-1 and i of the line, judged
// against the line's bimodal word-gap threshold. Scripts (sub/superscripts)
// attach to their base without a space regardless of gap — `d_k` is one token.
function _needsSpace(l, i, threshold, roles) {
    const prev = l.items[i - 1];
    const curr = l.items[i];
    if (/\s$/.test(prev.str) || /^\s/.test(curr.str)) return false;
    if (roles && (roles[i] !== 0 || roles[i - 1] !== 0) &&
        curr.transform[4] - (prev.transform[4] + (prev.width || 0)) < 0.6 * l.size) {
        return false;
    }
    const gap = curr.transform[4] - (prev.transform[4] + (prev.width || 0));
    return gap > threshold;
}

function _buildLine(l, o) {
    if (!l.items.length) return '';
    const threshold = _wordGapThreshold(l, o.ocr);

    let result = l.items[0].str;
    for (let i = 1; i < l.items.length; i++) {
        if (_needsSpace(l, i, threshold)) result += ' ';
        result += l.items[i].str;
    }
    return result;
}

// Style-aware version — groups items into same-style/same-script runs and wraps
// each in the right HTML (<strong>, <em>, <u>, <sub>, <sup>).
function _buildLineHtml(l, o) {
    if (!l.items.length) return '';
    const threshold = _wordGapThreshold(l, o.ocr);
    const roles = l.items.map(item => _scriptRole(l, item));

    const tokens = [];
    for (let i = 0; i < l.items.length; i++) {
        if (i > 0 && _needsSpace(l, i, threshold, roles)) {
            tokens.push({ text: ' ', style: _getItemStyle(l.items[i]), role: roles[i] });
        }
        tokens.push({ text: l.items[i].str, style: _getItemStyle(l.items[i]), role: roles[i] });
    }
    if (!tokens.length) return '';

    // Group consecutive same-style same-role tokens into runs
    const runs = [];
    let run = { text: tokens[0].text, style: tokens[0].style, role: tokens[0].role };
    for (let i = 1; i < tokens.length; i++) {
        if (_styleKey(tokens[i].style) === _styleKey(run.style) && tokens[i].role === run.role) {
            run.text += tokens[i].text;
        } else {
            runs.push(run);
            run = { text: tokens[i].text, style: tokens[i].style, role: tokens[i].role };
        }
    }
    runs.push(run);

    return runs.map(r => {
        let html = _wrapInlineStyle(r.text, r.style);
        if (r.role === 1) html = `<sup>${html}</sup>`;
        else if (r.role === 2) html = `<sub>${html}</sub>`;
        return html;
    }).join('');
}

function _escHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
