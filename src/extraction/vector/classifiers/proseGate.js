// proseGate.js
// Content-level discriminator: does a candidate region hold FLOWING TEXT
// (paragraphs, bulleted or numbered lists) rather than tabular data?
//
// Ruling geometry proves a rectangle exists. It does not prove the rectangle is
// a table. A safety admonition, a notice panel and a bordered table are drawn
// with the same four segments, and a hanging-indent list produces the same
// two-x-anchor signature as a two-column grid. Geometry cannot tell them apart;
// the text inside can.
//
// The verdict is deliberately one-sided. Callers use it to DEMOTE a table
// candidate, so an inconclusive block must return prose:false and leave the
// existing table path untouched. Only confident flowing text returns true.

import { BULLET_RE, ORDERED_RE } from './listDetector.js';

// Standalone list marker occupying its own run — the hanging-indent case, where
// the bullet or number sits in its own x-column far left of the text it labels.
// BULLET_RE/ORDERED_RE match a marker glued to the line text and require the
// trailing space; this matches the marker alone.
const MARKER_RE = /^(?:[•‣◦▪▫–—―·○◉*-]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\(?[ivxIVX]+[.)])$/;

const MIN_ITEMS = 4;
const MIN_BANDS = 3;
// Fraction of row bands an x-position must recur in to count as a real column.
// Justified prose scatters wide word gaps at arbitrary x; a column anchor lands
// at the same x line after line.
const ANCHOR_SUPPORT = 0.6;
// Average characters per row band above which a block reads as running text.
// Measured per BAND, not per run: with the split gap set narrow enough to
// expose tight numeric columns, justified prose also splits into several runs,
// so run length no longer distinguishes a sentence from a cell. Line length
// still does.
const MIN_LINE_CHARS = 45;

function groupBands(items, tol) {
    const sorted = [...items].sort((a, b) => a.vy - b.vy);
    const bands = [];
    let cur = null;
    for (const tm of sorted) {
        if (!cur || Math.abs(tm.vy - cur.y) > tol) {
            cur = { y: tm.vy, items: [tm] };
            bands.push(cur);
        } else {
            cur.items.push(tm);
        }
    }
    return bands;
}

// Merge horizontally adjacent items into runs. The split gap is set wider than
// justified word spacing but narrower than a typical column gutter, so a
// stretched space inside a paragraph does not read as a column break.
function buildRuns(items, gap) {
    const sorted = [...items].sort((a, b) => a.vx - b.vx);
    const runs = [];
    let cur = null;
    for (const tm of sorted) {
        const w = tm.vWidth || 0;
        const text = tm.str.trim();
        if (cur && tm.vx - cur.end <= gap) {
            cur.end = Math.max(cur.end, tm.vx + w);
            cur.text = cur.text ? `${cur.text} ${text}` : text;
        } else {
            cur = { x: tm.vx, end: tm.vx + w, text };
            runs.push(cur);
        }
    }
    return runs;
}

function clusterX(xs, tol) {
    const sorted = [...xs].sort((a, b) => a - b);
    const out = [];
    let cur = null;
    for (const x of sorted) {
        if (cur && x - cur[cur.length - 1] <= tol) cur.push(x);
        else { cur = [x]; out.push(cur); }
    }
    return out;
}

/**
 * Analyze a block of text items for tabular vs. flowing structure.
 *
 * @param {number[]} textIndices  indices into textMeta
 * @param {Array}    textMeta     viewport-enriched text items
 * @param {object}   bbox         {x,y,w,h} of the candidate region
 * @param {PageScale} scale
 * @returns {{prose:boolean, anchors:number, bands:number, avgLineChars:number,
 *           listRatio:number, columnXs:number[], reason:string}}
 */
export function analyzeBlock(textIndices, textMeta, bbox, scale) {
    const base = {
        prose: false, anchors: 0, bands: 0, avgLineChars: 0,
        listRatio: 0, columnXs: [], reason: '',
    };

    const items = textIndices
        .map(i => textMeta[i])
        .filter(tm => tm && tm.str && tm.str.trim());
    if (items.length < MIN_ITEMS) return { ...base, reason: 'too-few-items' };

    const bands = groupBands(items, scale.yBandTolPx);
    if (bands.length < MIN_BANDS) {
        return { ...base, bands: bands.length, reason: 'too-few-bands' };
    }

    // Split gap: a little wider than a single space, so a multi-word cell stays
    // one run while a column gutter breaks. It must NOT be set to a full column
    // gutter width — a dense numeric table's gutters are only a space or two,
    // and merging its cells into one run per row hides the columns entirely.
    const runGap = scale.S * 0.7;

    let listLed = 0, lineChars = 0;
    const interiorStarts = [];

    for (const band of bands) {
        let runs = buildRuns(band.items, runGap);
        if (!runs.length) continue;

        // Strip a leading list marker before counting columns. A hanging-indent
        // bullet is a marker column, not a data column: leaving it in makes
        // every bulleted list look like a two-column table.
        if (runs.length >= 2 && MARKER_RE.test(runs[0].text)) {
            listLed++;
            runs = runs.slice(1);
        } else if (BULLET_RE.test(runs[0].text) || ORDERED_RE.test(runs[0].text)) {
            listLed++;
        }
        if (!runs.length) continue;

        for (let k = 1; k < runs.length; k++) interiorStarts.push(runs[k].x);
        for (const run of runs) lineChars += run.text.length;
    }

    const clusters = clusterX(interiorStarts, scale.colTolPx);
    const minSupport = Math.max(2, Math.ceil(bands.length * ANCHOR_SUPPORT));
    const anchorClusters = clusters.filter(c => c.length >= minSupport);

    const avgLineChars = lineChars / bands.length;
    const listRatio = listLed / bands.length;
    const columnXs = anchorClusters.map(c => c.reduce((a, b) => a + b, 0) / c.length);

    const stats = {
        anchors: anchorClusters.length,
        bands: bands.length,
        avgLineChars, listRatio, columnXs,
    };

    // An interior x that recurs line after line IS a second column. Whatever
    // else the block looks like, it has a grid — never call it prose.
    if (anchorClusters.length > 0) {
        return { ...stats, prose: false, reason: 'column-anchors' };
    }

    // No grid found. Prose still needs positive evidence of running text, not
    // merely the absence of columns: line-length text, or a consistent
    // list-marker column. Short-celled data whose gutters this pass missed
    // stays inconclusive and keeps its table path.
    //
    // Deliberately NOT a signal: lines reaching the region's right edge. Nearly
    // every table right-aligns its last column at the table edge, so "reaches
    // the right margin" fires on data rows just as hard as on justified prose.
    const prose = avgLineChars >= MIN_LINE_CHARS || listRatio >= 0.5;

    return { ...stats, prose, reason: prose ? 'flowing-text' : 'inconclusive' };
}

export function isProseBlock(textIndices, textMeta, bbox, scale) {
    return analyzeBlock(textIndices, textMeta, bbox, scale).prose;
}
