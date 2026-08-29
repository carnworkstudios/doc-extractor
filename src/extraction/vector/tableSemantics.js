// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 carnworkstudios
// tableSemantics.js — is this table's MEANING intact, not just its geometry?
//
// The other two scorers answer mechanical questions. `externalScorer` asks
// whether the regions cover the page's text; `flowScorer` asks whether the
// output is in reading order. A table can pass both perfectly and still be
// wrong in the way that matters: the columns assigned to the wrong headers, a
// currency column split across two, a header row read as data.
//
// ── Why this needs no model and no source PDF ────────────────────────────────
// A misassigned column is not a subtle judgement. It is a type violation, and
// type violations are countable. Real table columns are homogeneous — a column
// is dates, or currency, or integers, or labels. When an extractor shifts a
// boundary, values from two columns land in one, and the column stops being one
// type. That is visible in the GRID ALONE, with no reference to the page it
// came from.
//
// This is the honest limit of the claim: it detects a column that has become
// incoherent. It cannot tell you that "Q1 Revenue" was labelled "Q2 Revenue" —
// both are currency, both are coherent, and nothing short of reading the page
// distinguishes them. Where that limit bites is stated in the output.
//
// Pure data — no DOM, no imports, no network.

// ── Value typing ─────────────────────────────────────────────────────────────
//
// Ordered by specificity: the first pattern that matches wins, so `currency`
// is tested before `number` and `percent` before both. A value that matches
// nothing specific is `text`, which is a real type (labels, names, notes) and
// not a failure.

const CURRENCY_RE = /^[-(]?\s*[$£€¥₦₹]\s?[\d,.\s]+\)?$|^[-(]?\s*[\d,.\s]+\s?(?:USD|EUR|GBP|NGN|CAD|AUD|JPY)\)?$/i;
const PERCENT_RE = /^[-+]?\s*[\d.,]+\s*%$/;
const INTEGER_RE = /^[-(]?\s*\d{1,3}(?:,\d{3})*\)?$|^[-(]?\s*\d+\)?$/;
const DECIMAL_RE = /^[-(]?\s*\d{1,3}(?:,\d{3})*\.\d+\)?$|^[-(]?\s*\d*\.\d+\)?$/;
// Deliberately broad on separators and narrow on shape: a bare 4-digit year is
// NOT a date here, because a table of years is a table of integers and calling
// it a date column would invent a semantic that is not there.
const DATE_RE = new RegExp(
    '^(?:' +
    '\\d{1,4}[-/.]\\d{1,2}[-/.]\\d{1,4}' +                          // 2026-08-08, 8/8/26
    '|\\d{1,2}\\s+' +
      '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*' +
      '\\.?\\s*\\d{0,4}' +                                          // 8 Aug 2026
    '|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*' +
      '\\.?\\s+\\d{1,2},?\\s*\\d{0,4}' +                            // Aug 8, 2026
    ')$',
    'i',
);
const BOOL_RE = /^(?:yes|no|y|n|true|false|✓|✗|x|—|–|-)$/i;

/** Classify one cell's value. `empty` is tracked separately from `text`. */
export function valueType(raw) {
    const v = (raw ?? '').toString().replace(/\u00a0/g, ' ').trim();
    if (!v) return 'empty';
    if (PERCENT_RE.test(v)) return 'percent';
    if (CURRENCY_RE.test(v)) return 'currency';
    if (DATE_RE.test(v)) return 'date';
    if (DECIMAL_RE.test(v)) return 'decimal';
    if (INTEGER_RE.test(v)) return 'integer';
    if (BOOL_RE.test(v)) return 'boolean';
    return 'text';
}

/** Numeric-ish types. Mixing these with `text` is the misassignment signature. */
const NUMERIC = new Set(['currency', 'percent', 'decimal', 'integer']);

/**
 * Format fingerprint within a type — catches a subtler failure than type
 * mixing: one column holding two currencies, or two date conventions, is a
 * merge of columns that were never the same column.
 */
function formatKey(type, raw) {
    const v = (raw ?? '').toString().trim();
    if (type === 'currency') {
        const sym = v.match(/[$£€¥₦₹]|USD|EUR|GBP|NGN|CAD|AUD|JPY/i);
        return sym ? sym[0].toUpperCase() : '?';
    }
    if (type === 'date') {
        if (/^\d{4}[-/.]/.test(v)) return 'Y-M-D';
        if (/^\d{1,2}[-/.]/.test(v)) return 'D/M/Y or M/D/Y';
        return 'named-month';
    }
    if (type === 'decimal') {
        const dp = v.split('.')[1]?.replace(/[^\d]/g, '').length ?? 0;
        return `${dp}dp`;
    }
    return type;
}

// ── Grid construction ────────────────────────────────────────────────────────

/**
 * Build a dense row-major grid from the contract's resolved cells.
 *
 * `cells` already address a zero-based grid (spans resolved upstream by
 * VisualGridMapper), so this only has to place them and record which positions
 * nothing claimed. A hole is not the same as an empty cell: an empty cell was
 * extracted and found blank, a hole was never produced at all, and the second
 * means the grid is ragged.
 */
export function buildGrid(table) {
    const rows = Math.max(0, table?.rows ?? 0);
    const cols = Math.max(0, table?.cols ?? 0);
    if (!rows || !cols) return null;

    const grid = Array.from({ length: rows }, () => new Array(cols).fill(null));
    let placed = 0;
    let outOfBounds = 0;

    for (const c of table.cells ?? []) {
        const r = c?.r ?? 0, col = c?.c ?? 0;
        if (r < 0 || col < 0 || r >= rows || col >= cols) { outOfBounds++; continue; }
        // Only the cell's origin is written. Span continuation positions stay
        // null and are counted as covered below, because a 2-column span is one
        // value, not two — typing its shadow would double-count it.
        if (grid[r][col] === null) { grid[r][col] = c; placed++; }
    }

    let covered = 0;
    for (const c of table.cells ?? []) {
        const rs = Math.max(1, c?.rowSpan ?? 1), cs = Math.max(1, c?.colSpan ?? 1);
        covered += rs * cs;
    }

    return { grid, rows, cols, placed, outOfBounds, covered, capacity: rows * cols };
}

// ── Column analysis ──────────────────────────────────────────────────────────

/**
 * Score one column's coherence.
 *
 * `coherence` is the share of NON-EMPTY values holding the dominant type.
 * Empties are excluded from the denominator on purpose: a sparse column is a
 * layout fact, not a semantic failure, and counting blanks as disagreement
 * would penalise every optional field in every form ever extracted.
 */
export function analyzeColumn(values) {
    const typed = values.map(v => ({ raw: v, type: valueType(v) }));
    const nonEmpty = typed.filter(t => t.type !== 'empty');

    if (!nonEmpty.length) {
        return {
            dominantType: 'empty', coherence: null, values: values.length, nonEmpty: 0,
            note: 'Column is entirely empty — nothing to check.',
        };
    }

    const counts = {};
    for (const t of nonEmpty) counts[t.type] = (counts[t.type] ?? 0) + 1;
    const [dominantType, dominantCount] =
        Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

    const coherence = dominantCount / nonEmpty.length;
    const offenders = nonEmpty.filter(t => t.type !== dominantType);

    // Format consistency within the dominant type only. Values of another type
    // are already counted against coherence; charging them twice would make a
    // single bad cell look like two separate problems.
    const formats = {};
    for (const t of nonEmpty) {
        if (t.type !== dominantType) continue;
        const k = formatKey(dominantType, t.raw);
        formats[k] = (formats[k] ?? 0) + 1;
    }
    const formatKeys = Object.keys(formats);
    const formatConsistency = dominantCount
        ? Math.max(...Object.values(formats)) / dominantCount
        : 1;

    return {
        dominantType,
        coherence: Math.round(coherence * 1000) / 1000,
        values: values.length,
        nonEmpty: nonEmpty.length,
        empties: typed.length - nonEmpty.length,
        typeCounts: counts,
        formatConsistency: Math.round(formatConsistency * 1000) / 1000,
        formats: formatKeys.length > 1 ? formats : undefined,
        // Capped: an agent needs to see WHICH values disagree, not all 400.
        offendingValues: offenders.slice(0, 5).map(o => ({ value: o.raw, type: o.type })),
        offenderCount: offenders.length,
        // The signature of a shifted boundary specifically: a numeric column
        // holding text, or a text column holding numbers. Generic type mixing
        // (integer among decimals) is far more often just formatting.
        mixedNumericAndText:
            NUMERIC.has(dominantType)
                ? offenders.some(o => o.type === 'text')
                : dominantType === 'text' && offenders.some(o => NUMERIC.has(o.type)),
    };
}

/**
 * Is row 0 plausibly a header?
 *
 * Headers are labels over data. When the body of a column is numeric and its
 * first row is text, that is a header. When row 0 is typed exactly like the
 * body, either there is no header row or the extractor consumed it as data —
 * and the second is a real, common failure that nothing else here catches.
 */
export function analyzeHeader(grid, rows, cols) {
    if (rows < 2) {
        return { verdict: 'unknown', reason: 'Fewer than two rows — nothing to compare.' };
    }

    const declared = (grid[0] ?? []).some(c => c?.isHeader);
    let textOverNumeric = 0;
    let comparable = 0;

    for (let c = 0; c < cols; c++) {
        const head = valueType(grid[0]?.[c]?.text);
        const body = [];
        for (let r = 1; r < rows; r++) {
            const t = valueType(grid[r]?.[c]?.text);
            if (t !== 'empty') body.push(t);
        }
        if (!body.length || head === 'empty') continue;
        const bodyNumeric = body.filter(t => NUMERIC.has(t)).length / body.length;
        if (bodyNumeric < 0.6) continue;   // text body: the test says nothing
        comparable++;
        if (head === 'text') textOverNumeric++;
    }

    if (!comparable) {
        return {
            verdict: 'unknown', declaredHeader: declared,
            reason: 'No column has a numeric body, so a text-over-numeric header cannot be detected. '
                + 'This is not evidence against a header row.',
        };
    }

    const ratio = textOverNumeric / comparable;
    return {
        verdict: ratio >= 0.5 ? 'header-present' : 'header-missing-or-consumed',
        declaredHeader: declared,
        textOverNumericColumns: textOverNumeric,
        comparableColumns: comparable,
        reason: ratio >= 0.5
            ? `${textOverNumeric} of ${comparable} numeric columns have a text label above them.`
            : `Only ${textOverNumeric} of ${comparable} numeric columns have a text label above them. `
              + 'Row 0 is typed like the data, so either this table has no header or the header '
              + 'row was read as data.',
    };
}

/**
 * How many leading rows are header?
 *
 * A row is header-like when every value it holds is text (or empty). Merged
 * headers stack two or three such rows; the data below them is not all text,
 * which is what stops this consuming a table of labels.
 *
 * Three guards, each earning its place:
 *   - hard cap of 3 rows: beyond that it is not a header, it is prose;
 *   - never more than 40% of the table;
 *   - always leave at least 2 data rows, or there is nothing left to type and
 *     the column check silently becomes a no-op reporting perfect coherence.
 */
export function headerDepth(grid, rows, cols) {
    const MAX_HEADER_ROWS = 3;
    const limit = Math.min(
        MAX_HEADER_ROWS,
        Math.floor(rows * 0.4),
        Math.max(0, rows - 2),
    );
    if (limit < 1) return Math.min(1, rows);

    let depth = 0;
    for (let r = 0; r < limit; r++) {
        let sawValue = false;
        let allText = true;
        for (let c = 0; c < cols; c++) {
            const t = valueType(grid[r]?.[c]?.text);
            if (t === 'empty') continue;
            sawValue = true;
            if (t !== 'text') { allText = false; break; }
        }
        if (!sawValue || !allText) break;
        depth++;
    }
    // `analyzeHeader` already concluded a header exists, so a depth of 0 here
    // means row 0 mixes text and values — a single header row is still the
    // right read, and returning 0 would type the labels as data.
    return Math.max(1, depth);
}

// ── Table scoring ────────────────────────────────────────────────────────────

/** Columns below this are treated as incoherent rather than merely untidy. */
const COHERENCE_FLOOR = 0.8;
/** A column needs this many real values before its coherence means anything. */
const MIN_VALUES = 3;

/**
 * Score one table's semantic integrity.
 *
 * The composite weights column coherence highest because a shifted boundary is
 * both the most common failure and the most damaging: every downstream number
 * is attributed to the wrong thing, silently, and looks perfectly well-formed.
 */
export function scoreTable(table) {
    const built = buildGrid(table);
    if (!built) {
        return {
            page: table?.page ?? null,
            ok: false,
            reason: 'empty-grid',
            detail: 'Table declares no rows or columns.',
        };
    }
    const { grid, rows, cols, covered, capacity, outOfBounds } = built;

    const header = analyzeHeader(grid, rows, cols);
    // Header rows are excluded from typing: a text label sitting in a currency
    // column would report every well-formed table as ~90% coherent and make the
    // floor below meaningless. Decided once for the whole table.
    //
    // DEPTH, not just row 0. A merged header — "Region | Q1 | Q2" over
    // "Units | Revenue | Units | Revenue" — is two header rows, and treating
    // the second as data produced two confident false positives on our own
    // fixture ("Column 1 is mostly integer but holds 1 text value: 'Revenue'").
    const firstDataRow = header.verdict === 'header-present'
        ? headerDepth(grid, rows, cols)
        : 0;

    const columns = [];
    for (let c = 0; c < cols; c++) {
        const values = [];
        for (let r = firstDataRow; r < rows; r++) values.push(grid[r]?.[c]?.text ?? '');
        columns.push({ index: c, header: grid[0]?.[c]?.text ?? null, ...analyzeColumn(values) });
    }

    const measurable = columns.filter(c => c.nonEmpty >= MIN_VALUES && c.coherence !== null);
    const columnCoherence = measurable.length
        ? measurable.reduce((s, c) => s + c.coherence, 0) / measurable.length
        : null;
    const formatConsistency = measurable.length
        ? measurable.reduce((s, c) => s + c.formatConsistency, 0) / measurable.length
        : null;

    // Ragged: the resolved spans should exactly tile the declared grid. Under
    // means holes the extractor never produced; over means spans that overlap,
    // which is a span-resolution bug and not a layout property.
    const fill = capacity ? covered / capacity : 0;

    const issues = [];
    for (const c of measurable) {
        if (c.mixedNumericAndText) {
            // Name the offenders by THEIR type, not a hardcoded one. The first
            // version said "mostly text but holds 1 text value(s)", which reads
            // as nonsense and hides which value is the problem.
            const kinds = [...new Set(c.offendingValues.map(o => o.type))].join('/');
            issues.push({
                severity: 'high', column: c.index, header: c.header,
                type: 'mixed-numeric-and-text',
                detail: `Column ${c.index}${c.header ? ` ("${c.header}")` : ''} is mostly `
                    + `${c.dominantType} but holds ${c.offenderCount} ${kinds} value(s) `
                    + `(${c.offendingValues.map(o => JSON.stringify(o.value)).join(', ')}). `
                    + 'That is the signature of a column boundary in the wrong place.',
            });
        } else if (c.coherence < COHERENCE_FLOOR) {
            issues.push({
                severity: 'medium', column: c.index, header: c.header,
                type: 'low-type-coherence',
                detail: `Column ${c.index}${c.header ? ` ("${c.header}")` : ''} is `
                    + `${Math.round(c.coherence * 100)}% ${c.dominantType}; the rest is `
                    + Object.entries(c.typeCounts).filter(([t]) => t !== c.dominantType)
                        .map(([t, n]) => `${n} ${t}`).join(', ') + '.',
            });
        }
        if (c.formats && c.formatConsistency < COHERENCE_FLOOR) {
            issues.push({
                severity: 'medium', column: c.index, header: c.header,
                type: 'mixed-format',
                detail: `Column ${c.index} mixes ${Object.keys(c.formats).join(' and ')} `
                    + 'within one type — often two columns merged into one.',
            });
        }
    }
    if (fill < 0.95) {
        issues.push({
            severity: 'medium', type: 'ragged-grid',
            detail: `Resolved spans cover ${Math.round(fill * 100)}% of the declared `
                + `${rows}×${cols} grid. The remainder is holes no cell claimed.`,
        });
    }
    if (fill > 1.05 || outOfBounds) {
        issues.push({
            severity: 'high', type: 'overlapping-spans',
            detail: `Spans cover ${Math.round(fill * 100)}% of the grid`
                + (outOfBounds ? ` and ${outOfBounds} cell(s) fall outside it` : '')
                + '. Row/colspan resolution produced an inconsistent grid.',
        });
    }
    if (header.verdict === 'header-missing-or-consumed') {
        issues.push({ severity: 'medium', type: 'header-not-detected', detail: header.reason });
    }

    // Composite. null when no column had enough values to measure — reported as
    // unmeasured rather than defaulted to 1.0, which would let a table of three
    // sparse rows report perfect semantics.
    //
    // ── Why a detected issue CAPS the score instead of just lowering it ──────
    // The weighted mean dilutes. Measured on a four-column table where a
    // shifted boundary corrupted two columns, the mean came out at 0.888 —
    // a number a reader skims past, for a table where half the revenue figures
    // are attributed to the wrong row. Averaging is right for "how tidy is
    // this overall" and wrong for "can I trust this", and the second is the
    // question being asked.
    //
    // So a high-severity finding — a boundary error or a broken span grid —
    // caps the table at 0.5 however clean the other columns are, and a medium
    // finding caps it at 0.85. The mean still applies below the cap, so a badly
    // corrupted table still scores worse than a slightly corrupted one.
    const hasHigh = issues.some(i => i.severity === 'high');
    const hasMedium = issues.some(i => i.severity === 'medium');
    const cap = hasHigh ? 0.5 : hasMedium ? 0.85 : 1;

    const composite = columnCoherence === null ? null :
        0.60 * columnCoherence +
        0.20 * (formatConsistency ?? 1) +
        0.20 * Math.min(1, fill);
    const semanticScore = composite === null
        ? null
        : Math.round(Math.min(composite, cap) * 1000) / 1000;

    return {
        page: table?.page ?? null,
        ok: true,
        rows, cols,
        semanticScore,
        columnCoherence: columnCoherence === null ? null : Math.round(columnCoherence * 1000) / 1000,
        formatConsistency: formatConsistency === null ? null : Math.round(formatConsistency * 1000) / 1000,
        gridFill: Math.round(fill * 1000) / 1000,
        // Surfaced so a caller can tell "clean table" from "capped by a
        // finding" — without it, 0.5 and 0.5 look identical whether they came
        // from genuinely poor columns or from one high-severity cap.
        scoreCappedBy: hasHigh ? 'high-severity-issue' : hasMedium ? 'medium-severity-issue' : null,
        uncappedScore: composite === null ? null : Math.round(composite * 1000) / 1000,
        measurableColumns: measurable.length,
        totalColumns: cols,
        header,
        columns: columns.map(c => ({
            index: c.index, header: c.header, dominantType: c.dominantType,
            coherence: c.coherence, formatConsistency: c.formatConsistency,
            nonEmpty: c.nonEmpty, offenderCount: c.offenderCount,
            offendingValues: c.offendingValues,
        })),
        issues,
    };
}

/** Score every table and roll up. */
export function scoreTables(tables) {
    const results = (tables ?? []).map(scoreTable);
    const scored = results.filter(r => r.ok && r.semanticScore !== null);

    // Weighted by cell count: a 2×2 lookup and a 40×8 financial table are not
    // equally informative about whether this extraction can be trusted.
    const weight = (r) => Math.max(1, r.rows * r.cols);
    const totalWeight = scored.reduce((s, r) => s + weight(r), 0);
    const mean = (key) => {
        if (!scored.length || !totalWeight) return null;
        return Math.round(
            (scored.reduce((s, r) => s + (r[key] ?? 0) * weight(r), 0) / totalWeight) * 1000
        ) / 1000;
    };

    const allIssues = results.flatMap(r => (r.issues ?? []).map(i => ({ page: r.page, ...i })));
    return {
        tableCount: results.length,
        tablesScored: scored.length,
        tablesUnmeasurable: results.length - scored.length,
        semanticScore: mean('semanticScore'),
        columnCoherence: mean('columnCoherence'),
        formatConsistency: mean('formatConsistency'),
        gridFill: mean('gridFill'),
        highSeverityIssues: allIssues.filter(i => i.severity === 'high').length,
        issues: allIssues,
        tables: results,
    };
}
