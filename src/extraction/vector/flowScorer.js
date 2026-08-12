// flowScorer.js — grade an extractor's READING ORDER against the source PDF.
//
// `externalScorer.js` answers "did you find the text?". This answers "did you
// read it in the right order?", and the two are genuinely independent: an
// extractor can put every character inside some region — scoring 1.000 on
// structure — while emitting a two-column page as left-line, right-line,
// left-line, which is unusable prose and the single most common way a PDF
// extraction is wrong.
//
// Nothing here is semantic and nothing here needs a model. Reading order is a
// permutation, and a permutation can be measured.
//
// ── The three measurements ───────────────────────────────────────────────────
//
//   columnFlow    — the interleaving check. Assign every output line a column,
//                   count maximal same-column runs. A correctly-flowed
//                   two-column page has 2 runs; a line-by-line interleave has
//                   ~2 per line. This is the specific failure named above.
//
//   sequenceFlow  — the general check. Count inversions between the output
//                   order and the reference order (normalised Kendall tau).
//                   Catches what runs miss: a footnote hoisted mid-paragraph, a
//                   running header dropped into the body, blocks transposed
//                   within one column.
//
//   contiguity    — did each source paragraph survive as ONE span, or get
//                   shredded and scattered? A high tau with low contiguity means
//                   the text is roughly in order but chopped.
//
// ── Why lines, not tokens ────────────────────────────────────────────────────
// Matching output tokens back to source items is ambiguous — "the" appears
// everywhere — and the obvious fix, an LCS alignment, is disqualified by
// construction: LCS returns an increasing subsequence in both sequences, so it
// literally cannot represent an inversion. It would report a perfectly
// interleaved page as a clean partial match.
//
// Lines are distinctive enough to match on normalised text, and they are the
// unit the failure actually occurs at.

/** Two text items are on the same line when their baselines are within this × font size. */
const LINE_TOLERANCE = 0.6;

/** Below this, a page has no column structure and columnFlow measures nothing. */
const MIN_COLUMN_LINES = 4;

/** Normalise for matching: case, whitespace, and the punctuation extractors disagree about. */
function norm(s) {
    return (s || '')
        .toLowerCase()
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[‐-―]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Column index for an x position, given gutter x's. */
function columnOf(x, gutters) {
    let col = 0;
    for (const g of gutters) { if (x >= g) col++; else break; }
    return col;
}

/**
 * Group text items into lines, in the given order.
 *
 * ── Why columns are needed BEFORE lines ──────────────────────────────────────
 * A shared baseline does not mean a shared line. On a two-column page, the first
 * line of column 1 and the first line of column 2 sit at exactly the same y —
 * that is what a column layout *is*. Grouping on baseline alone therefore
 * welds them into one line, and the first version of this did: on the two-column
 * fixture it produced 13 merged lines, of which only the title (alone on its
 * baseline) matched anything. The order score came back "not measurable" for
 * both a correctly-flowed and a fully interleaved extractor — the two cases it
 * exists to tell apart.
 *
 * So a line break happens on a baseline change OR a column change.
 *
 * @param {Array}    textMeta — viewport-space items {vx, vy, vWidth, vFont, str}
 * @param {number[]} order    — item indices, in reference reading order
 * @param {number[]} gutters  — gutter x positions (see detectGutters)
 * @returns {Array} lines: {text, norm, x0, x1, y, column, itemIndices, refIndex}
 */
export function groupLines(textMeta, order, gutters = []) {
    const lines = [];
    let current = null;

    for (const idx of order) {
        const t = textMeta[idx];
        if (!t || !t.str?.trim()) continue;
        const tol = Math.max(2, (t.vFont || 12) * LINE_TOLERANCE);
        const col = columnOf(t.vx, gutters);

        const sameLine = current
            && col === current.column
            && Math.abs(t.vy - current.y) <= tol
            // Not a backwards jump: within a column, x only advances along a line.
            && t.vx >= current.x0 - tol;

        if (sameLine) {
            current.text += ' ' + t.str;
            current.x1 = Math.max(current.x1, t.vx + (t.vWidth || 0));
            current.itemIndices.push(idx);
        } else {
            if (current) lines.push(current);
            current = {
                text: t.str,
                x0: t.vx,
                x1: t.vx + (t.vWidth || 0),
                y: t.vy,
                column: col,
                itemIndices: [idx],
            };
        }
    }
    if (current) lines.push(current);

    return lines.map((l, i) => ({ ...l, norm: norm(l.text), refIndex: i }));
}

/**
 * Gutters from raw item extents, before any line grouping exists.
 *
 * Grouping needs columns and columns need geometry, so this reads the items
 * directly rather than the lines — otherwise the two are mutually recursive and
 * the version that resolved it by grouping first produced the merge bug above.
 */
export function detectGuttersFromItems(textMeta, pageWidth) {
    const spans = textMeta
        .filter(t => t?.str?.trim())
        .map(t => ({ x0: t.vx, x1: t.vx + (t.vWidth || 0) }));
    return gutterScan(spans, pageWidth);
}

/**
 * Assign each line a column index from the page's column boundaries.
 *
 * Boundaries are x positions; a line belongs to the column its LEFT EDGE falls
 * in. Left edge rather than centre because a line that spans a column gap — a
 * full-width heading over two columns — should read as belonging to the first,
 * not float ambiguously between them.
 */
export function assignColumns(lines, columnSplits) {
    const sorted = [...(columnSplits ?? [])].sort((a, b) => a - b);
    return lines.map(l => ({ ...l, column: columnOf(l.x0, sorted) }));
}

/**
 * Detect column boundaries from line geometry alone.
 *
 * Deliberately independent of `columnSplitDetector`: that module feeds our own
 * extraction, and grading a foreign extractor against the same detector that
 * drives ours would make the score partly a measure of agreement with us.
 * This looks only for a vertical band that no line's horizontal extent crosses
 * — a gutter is a gutter regardless of whose pipeline is looking.
 *
 * @returns {number[]} x positions of gutters, or [] when the page is one column
 */
export function detectGutters(lines, pageWidth) {
    return gutterScan(lines, pageWidth);
}

/** Shared implementation: works on anything with {x0, x1}. */
function gutterScan(spans, pageWidth) {
    if (spans.length < MIN_COLUMN_LINES * 2 || !(pageWidth > 0)) return [];

    // Sample the page width; a column is a run of x where few spans overlap.
    const BUCKETS = 100;
    const bucketW = pageWidth / BUCKETS;
    const hits = new Array(BUCKETS).fill(0);
    for (const l of spans) {
        const a = Math.max(0, Math.floor(l.x0 / bucketW));
        const b = Math.min(BUCKETS - 1, Math.ceil(l.x1 / bucketW));
        for (let i = a; i <= b; i++) hits[i]++;
    }

    // Ignore the page margins: an empty band at the edges is not a gutter.
    let first = hits.findIndex(h => h > 0);
    let last = hits.length - 1;
    while (last > 0 && hits[last] === 0) last--;
    if (first < 0 || last <= first) return [];

    // A gutter is a LOW-density band, not an empty one.
    //
    // Requiring zero hits fails on the most ordinary two-column page there is:
    // a full-width heading spans the gutter, and one such line is enough to put
    // a non-zero count in every bucket across it. Measured on the two-column
    // fixture — a 24-clause page with one title — the true gutter showed as just
    // two empty buckets against a three-bucket minimum, so no column was
    // detected and the interleaving check silently never ran.
    //
    // 10% of the busiest bucket admits the occasional spanning heading while
    // still excluding anything a column of body text passes through.
    const maxHits = Math.max(...hits);
    const lowThreshold = Math.max(1, Math.ceil(maxHits * 0.1));

    // 3% of page width ≈ 18pt on A4 — wider than any word space.
    const MIN_GUTTER_BUCKETS = Math.max(2, Math.round(BUCKETS * 0.03));
    const gutters = [];
    let runStart = -1;
    for (let i = first; i <= last + 1; i++) {
        const low = i > last || hits[i] <= lowThreshold;
        if (low && runStart < 0) runStart = i;
        if (!low && runStart >= 0) {
            if (i - runStart >= MIN_GUTTER_BUCKETS) {
                // Both sides must carry real content. Without this, the ragged
                // right edge of a single-column page — where line lengths vary
                // and density tails off — reads as a gutter, and every page
                // acquires a phantom second column that nothing ever occupies.
                const leftMass = hits.slice(first, runStart).reduce((s, h) => s + h, 0);
                const rightMass = hits.slice(i, last + 1).reduce((s, h) => s + h, 0);
                const total = leftMass + rightMass;
                if (total && leftMass / total >= 0.15 && rightMass / total >= 0.15) {
                    gutters.push(((runStart + i) / 2) * bucketW);
                }
            }
            runStart = -1;
        }
    }
    return gutters;
}

/**
 * Reference reading order derived from GEOMETRY, for untagged documents.
 *
 * Column-aware: all of column 0 top-to-bottom, then all of column 1. That is
 * the order a human reads and the order the interleaving failure violates.
 *
 * ── The circularity, stated ──────────────────────────────────────────────────
 * This is an inference, not the author's declaration. If our gutter detection
 * is wrong we will confidently mark a correct extractor as wrong. Two things
 * keep that honest and neither is optional:
 *   1. The caller reports `referenceSource: 'geometric'` alongside every score,
 *      so nobody mistakes it for the struct tree's authority.
 *   2. Our OWN extractor is never graded against this — only against
 *      'struct-tree'. Scoring ourselves against our own geometry would produce
 *      a number that means nothing and looks excellent.
 *
 * @returns {number[]} item indices in inferred reading order
 */
export function geometricOrder(textMeta, pageWidth) {
    const gutters = detectGuttersFromItems(textMeta, pageWidth);
    const contentOrder = textMeta.map((_, i) => i);
    const withCols = groupLines(textMeta, contentOrder, gutters);

    const sorted = [...withCols].sort((a, b) => {
        if (a.column !== b.column) return a.column - b.column;
        if (Math.abs(a.y - b.y) > 1) return a.y - b.y;   // viewport space: y grows downward
        return a.x0 - b.x0;
    });

    return sorted.flatMap(l => l.itemIndices);
}

/** Count maximal runs of consecutive equal values. */
function countRuns(values) {
    let runs = 0;
    for (let i = 0; i < values.length; i++) {
        if (i === 0 || values[i] !== values[i - 1]) runs++;
    }
    return runs;
}

/** Inversions via merge sort — O(n log n), because a 2000-line page is real. */
function countInversions(arr) {
    const buf = new Array(arr.length);
    let count = 0;
    const sort = (lo, hi) => {
        if (hi - lo < 2) return;
        const mid = (lo + hi) >> 1;
        sort(lo, mid); sort(mid, hi);
        let i = lo, j = mid, k = lo;
        while (i < mid && j < hi) {
            if (arr[i] <= arr[j]) buf[k++] = arr[i++];
            else { count += mid - i; buf[k++] = arr[j++]; }
        }
        while (i < mid) buf[k++] = arr[i++];
        while (j < hi) buf[k++] = arr[j++];
        for (let x = lo; x < hi; x++) arr[x] = buf[x];
    };
    sort(0, arr.length);
    return count;
}

/**
 * Match the extractor's output lines to reference lines.
 *
 * Greedy nearest-unused on normalised text. Nearest-to-previous rather than
 * first-unused so that a page with a repeated line ("Page 1 of 12", a repeated
 * table header) attaches each occurrence to the one it is actually near,
 * instead of consuming them front-to-back and manufacturing inversions that the
 * extractor never made.
 *
 * @returns {{ refIndices: number[], matched: number, unmatched: string[] }}
 */
export function matchLines(outputLines, refLines) {
    const byText = new Map();
    refLines.forEach((l, i) => {
        if (!l.norm) return;
        if (!byText.has(l.norm)) byText.set(l.norm, []);
        byText.get(l.norm).push(i);
    });

    const used = new Set();
    const refIndices = [];
    const unmatched = [];
    let last = 0;

    for (const raw of outputLines) {
        const n = norm(raw);
        if (!n) continue;
        const candidates = byText.get(n);
        if (!candidates) { unmatched.push(raw); continue; }

        let best = -1, bestDist = Infinity;
        for (const c of candidates) {
            if (used.has(c)) continue;
            const d = Math.abs(c - last);
            if (d < bestDist) { bestDist = d; best = c; }
        }
        if (best < 0) { unmatched.push(raw); continue; }
        used.add(best);
        refIndices.push(best);
        last = best;
    }

    return { refIndices, matched: refIndices.length, unmatched };
}

/**
 * Score one page's reading order.
 *
 * @param {string[]} outputLines — the extractor's output for this page, in ITS order
 * @param {Array}    textMeta    — source items, viewport space
 * @param {number[]} refOrder    — reference reading order (item indices)
 * @param {string}   refSource   — 'struct-tree' | 'geometric'
 * @param {number}   pageWidth   — viewport width
 */
export function scoreFlow(outputLines, textMeta, refOrder, refSource, pageWidth, opts = {}) {
    const gutters = detectGuttersFromItems(textMeta, pageWidth);
    const refLines = groupLines(textMeta, refOrder, gutters);
    const columnCount = new Set(refLines.map(l => l.column)).size;

    const { refIndices, matched, unmatched } = matchLines(outputLines, refLines);

    // Below a floor, every ratio below is noise. Report that rather than a
    // number: a page where 3 of 4 lines matched can only produce 0, 0.5 or 1,
    // and averaging those into a document score is how a metric starts lying.
    if (matched < MIN_COLUMN_LINES) {
        return {
            referenceSource: refSource,
            columnCount,
            matchedLines: matched,
            outputLines: outputLines.length,
            unmatchedLines: unmatched.length,
            discriminating: false,
            reason: matched === 0
                ? 'No output line matched any source line. Either the text belongs to a '
                  + 'different document, or the extractor reflows lines so aggressively that '
                  + 'line-level matching cannot align them.'
                : `Only ${matched} line(s) matched — too few for a meaningful order score.`,
            columnFlow: null,
            sequenceFlow: null,
            contiguity: null,
        };
    }

    // ── columnFlow ───────────────────────────────────────────────────────────
    // Ideal runs = number of columns actually used. Anything above that is the
    // extractor crossing the gutter more often than the layout requires.
    const cols = refIndices.map(i => refLines[i].column);
    const usedColumns = new Set(cols).size;
    const actualRuns = countRuns(cols);
    const columnFlow = columnCount < 2 || usedColumns < 2
        ? null                                    // single column: nothing to interleave
        : Math.min(1, usedColumns / actualRuns);

    // ── sequenceFlow ─────────────────────────────────────────────────────────
    // Normalised Kendall tau distance, inverted so 1 = perfect order.
    const n = refIndices.length;
    const maxInversions = (n * (n - 1)) / 2;
    const inversions = countInversions([...refIndices]);
    const sequenceFlow = maxInversions ? 1 - inversions / maxInversions : 1;

    // ── contiguity ───────────────────────────────────────────────────────────
    // Fraction of adjacent output pairs that are also adjacent in the reference.
    // Measures shredding directly: text can be in near-perfect order (high tau)
    // and still be chopped into interleaved fragments.
    let adjacent = 0;
    for (let i = 1; i < refIndices.length; i++) {
        if (refIndices[i] === refIndices[i - 1] + 1) adjacent++;
    }
    const contiguity = refIndices.length > 1 ? adjacent / (refIndices.length - 1) : 1;

    return {
        referenceSource: refSource,
        columnCount,
        matchedLines: matched,
        outputLines: outputLines.length,
        unmatchedLines: unmatched.length,
        discriminating: true,
        columnFlow: columnFlow === null ? null : Math.round(columnFlow * 1000) / 1000,
        columnRuns: actualRuns,
        idealColumnRuns: usedColumns,
        sequenceFlow: Math.round(sequenceFlow * 1000) / 1000,
        inversions,
        contiguity: Math.round(contiguity * 1000) / 1000,
        // Only meaningful where columnFlow is: on a single-column page it would
        // be sequenceFlow renamed, and publishing it as a combined score would
        // imply the interleaving check ran when it did not.
        flowScore: columnFlow === null
            ? Math.round(sequenceFlow * 1000) / 1000
            : Math.round(Math.min(columnFlow, sequenceFlow) * 1000) / 1000,

        // ── Chunks for the semantic check ────────────────────────────────────
        // Only the MATCHED lines, and the same set in both orders. That
        // identity is the whole basis of the semantic comparison: the backend
        // refuses a request whose two orderings differ in content, because a
        // difference in coherence between two different texts says nothing
        // about the extractor. Off by default — this is bulk that most callers
        // never use.
        ...(opts.includeChunks ? {
            chunks: {
                reference: [...refIndices].sort((a, b) => a - b).map(i => refLines[i].text),
                candidate: refIndices.map(i => refLines[i].text),
            },
        } : {}),
    };
}
