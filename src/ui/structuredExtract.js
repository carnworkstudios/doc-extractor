/**
 * structuredExtract.js
 *
 * Builds the STRUCTURED extraction payload for the headless extraction
 * request `ginexys:mcp-extract-structured`.
 *
 * A plain text blob is a commodity — pdfplumber returns one for free. What it
 * cannot return is whether the extraction is trustworthy. This module reports
 * exactly that, and only from signals the pipeline actually produced:
 *
 *   • span topology, resolved to a zero-based grid so a consumer can index
 *     cells directly without replaying rowspans/colspans;
 *   • per-table confidence, read from the `data-confidence` the extractor
 *     stamped when it MEASURED one (OCR word confidence, stream-detector
 *     score) — and `null` when it did not;
 *   • flags, each earned by a condition that is checked here;
 *   • provenance, assembled by the shell-injected GxProvenance policy module.
 *
 * NOTHING in here invents a number. If a signal is missing the field is null
 * or the flag is absent, because a fabricated confidence makes an
 * untrustworthy extraction look measured — the one failure worse than no
 * answer at all.
 */

import { state } from '../state.js';
import { VisualGridMapper } from '../utils/tableLogic.js';
import { scoreTables } from '../extraction/vector/tableSemantics.js';

// Flag vocabulary — see the contract. Only the entries this module can prove
// are ever emitted; `row-spans-page-break` is deliberately absent (see below).
const FLAGS = {
    MERGED_HEADER_INFERRED:    'merged-header-inferred',
    COLUMN_BOUNDARY_AMBIGUOUS: 'column-boundary-ambiguous',
    OCR_SOURCED:               'ocr-sourced',
    LOW_TEXT_DENSITY:          'low-text-density',
    HEADER_ROW_GUESSED:        'header-row-guessed',
    SCANNED_DOCUMENT:          'scanned-document',
};

// Occupancy threshold shared with latticeDetector's `_cellOccupancy` gate:
// measured on reference PDFs, real tables sit at 0.58–0.96 occupancy and
// spurious grids at 0.00–0.33. Below half-full is a genuinely sparse grid.
const MIN_CELL_OCCUPANCY = 0.5;

/** Collapse whitespace and the &nbsp; the table builder uses for empty cells. */
function cellText(el) {
    return (el.textContent || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** parseFloat that refuses anything that is not a real 0..1 reading. */
function readConfidence(el) {
    const raw = el?.getAttribute?.('data-confidence');
    if (raw == null || raw === '') return null;
    const n = parseFloat(raw);
    if (!isFinite(n) || n < 0 || n > 1) return null;
    return n;
}

/** Page number from the nearest ancestor that declares one. */
function tablePage(table) {
    const host = table.closest?.('[data-page]');
    if (!host) return null;
    const n = parseInt(host.getAttribute('data-page'), 10);
    return Number.isFinite(n) ? n : null;
}

/**
 * Resolve one <table> to the contract's table object.
 *
 * Grid resolution is delegated to VisualGridMapper (src/utils/tableLogic.js),
 * the mapper the tool already uses for its own row/column features — the same
 * algorithm as table-formatter's GridMapper. r/c are its post-span
 * startRow/startCol, so `cells` addresses the resolved grid directly.
 */
function describeTable(table) {
    const mapper = new VisualGridMapper(table);
    const rows = mapper.maxRows;
    const cols = mapper.maxCols;

    const cells = [];
    let headerSpanned = false;
    let filledSlots = 0;

    for (const [el, pos] of mapper.cellMap.entries()) {
        const text = cellText(el);
        const rowSpan = pos.rowspan || 1;
        const colSpan = pos.colspan || 1;
        const isHeader = !!pos.isHeader;
        if (isHeader && (rowSpan > 1 || colSpan > 1)) headerSpanned = true;
        if (text) filledSlots += rowSpan * colSpan;
        cells.push({ r: pos.startRow, c: pos.startCol, rowSpan, colSpan, text, isHeader });
    }
    cells.sort((a, b) => (a.r - b.r) || (a.c - b.c));

    const flags = [];

    // merged-header-inferred: the extractor resolved a rowspan/colspan inside
    // the header band. Those spans are inferred from ruled lines or geometry
    // (tableBuilder's vLinePresent/hLinePresent scan), never declared by the
    // PDF, so a consumer is told the header shape is reconstructed.
    if (headerSpanned) flags.push(FLAGS.MERGED_HEADER_INFERRED);

    // column-boundary-ambiguous: a borderless table. tableBuilder marks a table
    // `borderless` exactly when it had zero hLines and zero vLines, i.e. the
    // column boundaries came from whitespace/alignment analysis rather than
    // from ruling the PDF actually draws.
    if (table.classList?.contains('borderless')
        || table.closest?.('.pdf-table--borderless')) {
        flags.push(FLAGS.COLUMN_BOUNDARY_AMBIGUOUS);
    }

    // ocr-sourced: tableBuilder stamps data-text-source="ocr" when the text
    // items that landed in this table came from rasterSynth's OCR words.
    if (table.getAttribute('data-text-source') === 'ocr') flags.push(FLAGS.OCR_SOURCED);

    // low-text-density: more than half the resolved grid slots are empty — the
    // same occupancy measure (and threshold) latticeDetector uses to reject a
    // grid as decoration. Only meaningful on a grid with something to measure.
    const totalSlots = rows * cols;
    if (totalSlots >= 4 && (filledSlots / totalSlots) < MIN_CELL_OCCUPANCY) {
        flags.push(FLAGS.LOW_TEXT_DENSITY);
    }

    // header-row-guessed: there are <th> cells but no <thead>. The vector
    // pipeline promotes row 0 to <th> purely by position (tableBuilder:
    // `const tag = r === 0 ? 'th' : 'td'`) and emits tbody-only markup, so the
    // header is a positional guess. Markup that carries a real <thead> (the
    // AST/Docling emitter, an imported HTML document, a user edit) does not
    // raise this.
    const hasHeaderCells = cells.some(c => c.isHeader);
    if (hasHeaderCells && !table.querySelector('thead')) flags.push(FLAGS.HEADER_ROW_GUESSED);

    // row-spans-page-break is NOT emitted: nothing in the pipeline links a
    // table across a page boundary today (flowLinker chains paragraphs only,
    // and streamDetector's spanning search is within-page column gutters), so
    // there is no signal to earn it with.

    return {
        page: tablePage(table),
        rows,
        cols,
        confidence: readConfidence(table),
        cells,
        flags,
    };
}

/**
 * Build the `ginexys:mcp-extract-structured` reply payload from the currently
 * extracted document. Never throws for "nothing loaded" — returns the
 * contract's failure shape instead.
 *
 * Fast path: when the gx-doc/1 IR is present (state.pdf1.gxDoc), tables are
 * read from the typed blocks with no DOM re-parse. Fallback: the existing
 * DOMParser walk, used for any document that predates the IR.
 *
 * @returns {object} payload — { ok: true, … } or { ok: false, reason, detail }
 */
export function buildStructuredPayload() {
    const pdf = state.pdf1;
    const html = pdf?.extractedHTML || '';
    const text = pdf?.extractedText || '';
    const gxDoc = pdf?.gxDoc || null;

    if (!html && !text && !gxDoc) {
        return {
            ok: false,
            reason: 'no-document',
            detail: 'No document has been extracted in this webview yet. Send ginexys:pdf-bytes first.',
        };
    }

    let tables;
    let pageCount;
    if (gxDoc) {
        // Fast path: typed IR, no DOM re-parse. Cells resolve to a zero-based
        // grid (header row at r 0) exactly like VisualGridMapper's output.
        tables = gxDoc.pages.flatMap(p =>
            (p.blocks || [])
                .filter(b => b.type === 'table')
                .map(b => ({
                    page: p.page,
                    rows: (b.rows || []).length + 1,
                    // MAX across the header and every data row, not the header
                    // length. A table with a merged header — "Region | Q1 | Q2"
                    // above "Units | Revenue | Units | Revenue" — has a 3-cell
                    // header row and 5-cell data rows, and reporting cols: 3
                    // silently truncated every consumer that indexed by it.
                    // Found by the table semantic check on our own fixture,
                    // which flagged spans covering 138% of the declared grid.
                    cols: Math.max(
                        b.headers?.length ?? 0,
                        ...(b.rows ?? []).map(r => r?.length ?? 0),
                        0,
                    ),
                    confidence: b.confidence ?? null,
                    cells: _blockToCells(b),
                    flags: b.flags ?? [],
                })),
        );
        pageCount = (gxDoc.meta?.pageCount ?? gxDoc.pages.length) || null;
    } else {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        tables = [...doc.querySelectorAll('table')].map(describeTable);

        const pageSections = new Set(
            [...doc.querySelectorAll('[data-page]')].map(el => el.getAttribute('data-page')),
        );
        const meta = pdf.extraction || null;
        pageCount = meta?.pageCount ?? (pageSections.size || null);
    }

    // Document confidence is the LOWEST table confidence — a document is only
    // as trustworthy as its weakest table. Null when no table measured one.
    const scored = tables.map(t => t.confidence).filter(c => c !== null);
    const confidence = scored.length ? Math.min(...scored) : null;

    const meta = pdf.extraction || null;
    const docFlags = [];
    // scanned-document: the pre-flight analyzer classified a majority of pages
    // as having no vector text substrate, which is what routed the document
    // through the OCR pipeline in the first place.
    if (meta?.isScanned) docFlags.push(FLAGS.SCANNED_DOCUMENT);

    // Lineage assembly is an optional host-provided capability. Presence-
    // guarded so a standalone build still answers, just without a lineage.
    const provenance = window.GxProvenance
        ? window.GxProvenance.build(
            'pdf-processor',
            window.CwsContracts?.PROVENANCE_STAGES?.EXTRACTION ?? 'extraction',
            {
                source: pdf.file?.name || null,
                // Only a measured document confidence is stamped on the lineage.
                ...(confidence !== null ? { score: confidence } : {}),
            },
        )
        : [];

    // Semantic self-check. Costs one pass over cells we already have and needs
    // neither a model nor the source PDF, so there is no reason to make the
    // caller ask for it separately — and every reason to report it: per-table
    // `confidence` says how sure the extractor was, which is not the same
    // question as whether the resulting columns hold coherent values.
    let tableSemantics = null;
    try {
        tableSemantics = scoreTables(tables);
    } catch (err) {
        // A scorer fault must never cost the caller the extraction. Report the
        // gap rather than a silent null that reads as "no tables".
        tableSemantics = {
            error: 'table-semantics-failed',
            detail: String(err?.message || err),
        };
    }

    return {
        ok: true,
        fileName: pdf.file?.name ?? null,
        pageCount,
        text,
        tables,
        confidence,
        flags: docFlags,
        provenance,
        tableSemantics,
    };
}

/**
 * Resolve a gx-doc table block to the contract's cells array (zero-based
 * grid, post-span positions) so consumers index it without replaying spans.
 */
function _blockToCells(block) {
    const cells = [];
    (block.headers || []).forEach((h, c) => {
        cells.push({ r: 0, c, rowSpan: 1, colSpan: 1, text: h, isHeader: true });
    });
    (block.rows || []).forEach((row, r) => {
        row.forEach((cell, c) => {
            cells.push({ r: r + 1, c, rowSpan: 1, colSpan: 1, text: cell, isHeader: false });
        });
    });
    return cells;
}
