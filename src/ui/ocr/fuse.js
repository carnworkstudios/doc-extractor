// fuse.js — join YOLO layout regions with PP-OCR text lines.
//
// The two models answer different questions and neither can answer the other's.
// PP-OCR returns text with geometry but has no notion that a run of boxes IS a
// table (`rasterSynth.js:37` makes the same point about Tesseract). YOLO/
// DocLayNet returns `table` / `picture` / `section-heading` regions but no
// characters. Fusion is what turns "88 correct lines" into "a 10x4 grid".
//
// Authority is split and never overridden: YOLO decides WHAT a region is,
// PP-OCR decides WHAT IT SAYS. A disagreement is recorded, not resolved.

/**
 * @param {Array} regions  YOLO regions in page space (see layout.js)
 * @param {Array} lines    PP-OCR lines: { text, bbox:{x0,y0,x1,y1}, confidence }
 */
export function fuse(regions, lines) {
    const used = new Set();
    const out = [];

    // Largest-area-first so a caption inside a picture binds to the caption,
    // not the picture — smaller regions get the last word on their own lines.
    const ordered = [...regions].sort((a, b) => (b.bbox.w * b.bbox.h) - (a.bbox.w * a.bbox.h));

    for (const r of ordered) {
        const mine = [];
        for (let i = 0; i < lines.length; i++) {
            if (used.has(i)) continue;
            if (centerIn(lines[i].bbox, r.bbox)) { mine.push(lines[i]); used.add(i); }
        }
        if (!mine.length) continue;
        const region = { label: r.label, confidence: r.confidence, bbox: r.bbox, lines: mine };
        if (r.label === 'table') region.grid = buildGrid(mine, r.bbox);
        out.push(region);
    }

    // Lines YOLO never covered. Reported, not discarded — a silent drop here
    // would lose text that OCR actually read correctly.
    const orphans = lines.filter((_, i) => !used.has(i));
    return { regions: out, orphans };
}

function centerIn(b, r) {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
}

/**
 * Reconstruct a grid from loose line boxes — no ruling lines required.
 *
 * Rows come from vertical overlap (cells on one row share a y-band). Columns
 * come from an x-occupancy histogram over the region: a run of empty bins is a
 * column separator, the same gutter-finding idea `orderForReading` uses for
 * page columns. Both are derived from the data; nothing is assumed about
 * column count, which is why a 4-column table and a 2-column table need no
 * different handling.
 */
export function buildGrid(lines, box) {
    if (lines.length < 4) return null;

    // ── columns first ───────────────────────────────────────────────────────
    // Rows need column assignment to test for continuations, so columns are
    // derived before rows. They do not depend on row grouping either way.
    const BINS = 200;
    const occ = new Uint16Array(BINS);
    const toBin = (x) => Math.max(0, Math.min(BINS - 1, Math.floor(((x - box.x) / box.w) * BINS)));
    for (const l of lines) {
        for (let b = toBin(l.bbox.x0); b <= toBin(l.bbox.x1); b++) occ[b]++;
    }
    const MIN_GAP = 3;                       // bins; ~1.5% of table width
    const bounds = [0];
    let run = 0;
    for (let b = 0; b < BINS; b++) {
        if (occ[b] === 0) { run++; continue; }
        if (run >= MIN_GAP) bounds.push(b - Math.floor(run / 2));
        run = 0;
    }
    bounds.push(BINS);
    const nCols = Math.max(1, bounds.length - 1);
    const colOf = (l) => {
        const c = toBin((l.bbox.x0 + l.bbox.x1) / 2);
        for (let i = bounds.length - 1; i >= 0; i--) if (c >= bounds[i]) return Math.min(nCols - 1, i);
        return 0;
    };

    // ── rows ────────────────────────────────────────────────────────────────
    const sorted = [...lines].sort((a, b) => midY(a) - midY(b));
    const rows = [];
    for (const l of sorted) {
        const last = rows[rows.length - 1];
        if (last && overlapY(last.probe, l.bbox) > 0.4) last.cells.push(l);
        else rows.push({ probe: { ...l.bbox }, cells: [l] });
    }

    // ── place ───────────────────────────────────────────────────────────────
    const gaps = [];
    for (let i = 1; i < rows.length; i++) gaps.push(topOf(rows[i]) - bottomOf(rows[i - 1]));
    const leading = median(gaps.filter((g) => g > 0)) || Infinity;

    let placed = rows.map((r) => {
        const cells = new Array(nCols).fill('');
        for (const l of r.cells) {
            const c = colOf(l);
            cells[c] = cells[c] ? `${cells[c]} ${l.text}` : l.text;
        }
        return { cells, top: topOf(r), bottom: bottomOf(r) };
    });

    // ── continuation merge ──────────────────────────────────────────────────
    // A wrapped row label starts its own y-band and becomes a spurious row: the
    // chemistry table's "Full CI - MP4" / "(kcal-mol^-1)" split in two while
    // Docling kept one.
    //
    // The discriminator is NOT "the label column is empty" — for a wrapped
    // LABEL, column 0 is exactly the column that is occupied and the data
    // columns are the empty ones. It is also not safe to merge any row missing
    // a label: MP7's label was simply misread, and merging it doubled MP6's
    // values. So the test is specifically a LABEL-ONLY row — column 0 filled,
    // every data column empty — which cannot be a real row of a table that has
    // data columns at all. It merges FORWARD into the row it labels.
    let mergedCount = 0;
    if (nCols > 1) {
        const out = [];
        for (let i = 0; i < placed.length; i++) {
            const r = placed[i];
            const labelOnly = r.cells[0] && r.cells.slice(1).every((c) => !c);
            const next = placed[i + 1];
            if (labelOnly && next && next.top - r.bottom <= leading * 1.5) {
                next.cells[0] = next.cells[0] ? `${r.cells[0]} ${next.cells[0]}` : r.cells[0];
                next.top = r.top;
                mergedCount++;
                continue;
            }
            out.push(r);
        }
        placed = out;
    }

    const grid = placed.map((r) => r.cells);
    return { rows: grid.length, cols: nCols, cells: grid, mergedRows: mergedCount };
}

const topOf = (r) => Math.min(...r.cells.map((l) => l.bbox.y0));
const bottomOf = (r) => Math.max(...r.cells.map((l) => l.bbox.y1));
function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
}

const midY = (l) => (l.bbox.y0 + l.bbox.y1) / 2;

function overlapY(a, b) {
    const lo = Math.max(a.y0, b.y0), hi = Math.min(a.y1, b.y1);
    const inter = Math.max(0, hi - lo);
    return inter / Math.max(1, Math.min(a.y1 - a.y0, b.y1 - b.y0));
}
