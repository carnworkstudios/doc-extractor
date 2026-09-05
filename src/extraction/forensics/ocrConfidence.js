// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// ocrConfidence.js — a spatial map of where the OCR engine was unsure, and what
// that says about the page.
//
// WHY A HEATMAP AND NOT A MEAN
// ----------------------------
// A page-mean OCR confidence is very nearly useless. Every scanned page has
// some low-confidence words; a mean of 84 tells you nothing about whether the
// page is uniformly mediocre or excellent everywhere except one block. Those
// two pages need completely different responses — the first needs a rescan, the
// second needs somebody to look at one paragraph — and the mean cannot tell
// them apart.
//
// The heatmap can, and it is cheap: the words already carry per-word confidence
// and a bbox.
//
// THE FORENSIC READING
// --------------------
// A confidence hole is not by itself suspicious; it usually means the scan is
// bad there. It becomes interesting when it does NOT line up with a physical
// explanation. That is why this module takes Head B's forensic maps as an
// optional input:
//
//   low confidence  +  high blur/tears/bleed at the same cell
//       -> explained. The page is damaged there. Observed, low severity.
//   low confidence  +  the page is clean at that cell
//       -> unexplained. Something is wrong with the CONTENT rather than with
//          the capture: a pasted region at a different resolution, text
//          rendered by a different process, a substituted block.
//
// That correlation is the entire value of having Head B and the deterministic
// module in the same report, and it is the one place where a learned signal is
// allowed to inform a deterministic finding — as corroboration, never as the
// sole basis.

import { observed, inferred, uncertain } from './findings.js';

const CHECK = 'ocr-confidence';

// Matches degrade.py's GRID and the model's map head. Keeping them equal is
// what makes cell-by-cell correlation possible without resampling.
export const GRID = 20;

/**
 * Confidence heatmap over a GRID x GRID lattice.
 *
 * Each word contributes to every cell its bbox touches, weighted by the area of
 * the overlap. Assigning a word to the single cell containing its centre would
 * make a full-width heading contribute to one cell and leave the nineteen it
 * actually spans empty.
 *
 * @param {Array<{bbox:{x0,y0,x1,y1}, confidence:number}>} words
 * @param {number} w  page width in the same units as the word boxes
 * @param {number} h
 * @returns {{conf:Float32Array, weight:Float32Array, coverage:number, mean:number}}
 *   `conf` cells are NaN where no word landed — distinct from 0, which would
 *   read as "the OCR was certain it was wrong there".
 */
export function confidenceMap(words, w, h) {
    const acc = new Float64Array(GRID * GRID);
    const wt = new Float64Array(GRID * GRID);
    const cw = w / GRID, ch = h / GRID;
    let total = 0, n = 0;

    for (const word of words || []) {
        const b = word.bbox;
        if (!b) continue;
        const c = typeof word.confidence === 'number' ? word.confidence : null;
        if (c === null) continue;
        // Confidence arrives 0..100 from both engines (see ocr/index.js).
        const cn = Math.max(0, Math.min(1, c / 100));
        total += cn; n++;

        const gx0 = Math.max(0, Math.floor(b.x0 / cw));
        const gx1 = Math.min(GRID - 1, Math.floor((b.x1 - 1e-6) / cw));
        const gy0 = Math.max(0, Math.floor(b.y0 / ch));
        const gy1 = Math.min(GRID - 1, Math.floor((b.y1 - 1e-6) / ch));
        for (let gy = gy0; gy <= gy1; gy++) {
            for (let gx = gx0; gx <= gx1; gx++) {
                const ox = Math.min(b.x1, (gx + 1) * cw) - Math.max(b.x0, gx * cw);
                const oy = Math.min(b.y1, (gy + 1) * ch) - Math.max(b.y0, gy * ch);
                const a = Math.max(0, ox) * Math.max(0, oy);
                if (a <= 0) continue;
                acc[gy * GRID + gx] += cn * a;
                wt[gy * GRID + gx] += a;
            }
        }
    }

    const conf = new Float32Array(GRID * GRID);
    let covered = 0;
    for (let i = 0; i < conf.length; i++) {
        if (wt[i] > 0) { conf[i] = acc[i] / wt[i]; covered++; }
        else conf[i] = NaN;
    }
    return { conf, weight: Float32Array.from(wt), coverage: covered / (GRID * GRID),
             mean: n ? total / n : NaN };
}

/**
 * @param {object} args
 * @param {Array} args.words           OCR words for the page
 * @param {number} args.w @param {number} args.h
 * @param {Float32Array|null} [args.forensicMaps]  Head B maps, [4][GRID*GRID],
 *        channel order blur, bleed, tears, handwriting. Optional.
 * @param {number} [args.pageNo]
 */
export function analyseOcrConfidence({ words, w, h, forensicMaps = null, pageNo = 1 }) {
    const out = [];
    const { conf, weight, coverage, mean } = confidenceMap(words, w, h);
    const vals = [...conf].filter((v) => !Number.isNaN(v));
    if (vals.length < 8) {
        return [observed(CHECK, 'too few OCR words to build a confidence map',
            { page: pageNo, words: (words || []).length, cellsWithText: vals.length })];
    }
    const sorted = [...vals].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const p10 = sorted[Math.floor(sorted.length * 0.10)];
    const devs = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = (devs[devs.length >> 1] || 0) * 1.4826;

    const base = observed(CHECK, 'OCR confidence heatmap built',
        { page: pageNo, grid: GRID, cellsWithText: vals.length,
          textCoverage: +coverage.toFixed(3),
          meanWordConfidence: +(mean * 100).toFixed(1),
          medianCell: +med.toFixed(3), p10Cell: +p10.toFixed(3),
          mad: +mad.toFixed(4) });
    out.push(base);

    // Cells that are outliers DOWNWARD against this page's own distribution.
    // A fixed "confidence below 60" cut would fire on every cell of a poor scan
    // and no cell of a good one, which is the opposite of informative.
    const k = 3.0;
    const holes = [];
    for (let i = 0; i < conf.length; i++) {
        if (Number.isNaN(conf[i])) continue;
        if (mad > 1e-6 ? (med - conf[i]) > k * mad : conf[i] < med - 0.25) holes.push(i);
    }
    if (!holes.length) {
        out.push(observed(CHECK, 'no cell falls significantly below the page\'s own '
            + 'confidence distribution', { page: pageNo, k }));
        return out;
    }

    const cw = w / GRID, ch = h / GRID;
    const region = cellsBbox(holes, cw, ch, pageNo);
    const hole = observed(CHECK,
        `${holes.length} grid cells read with confidence well below the rest of the page`,
        { page: pageNo, cells: holes.length,
          meanHoleConfidence: +(holes.reduce((s, i) => s + conf[i], 0) / holes.length).toFixed(3),
          pageMedian: +med.toFixed(3), madUnits: +k.toFixed(1) },
        { region, severity: 0.35 });
    out.push(hole);

    if (!forensicMaps) {
        out.push(uncertain(CHECK,
            'without the forensic head\'s maps there is no way to tell whether these '
            + 'cells are hard to read because the page is damaged there or for some '
            + 'other reason',
            { region, severity: 0.2 }));
        return out;
    }

    // ── correlation with the physical explanation ───────────────────────────
    // A hole is "explained" when at least one damage channel is elevated in the
    // same cell, relative to that channel's own page median. Comparing channels
    // to each other would be meaningless — blur and tears are not in the same
    // units — so each is normalised against itself.
    const chanNames = ['blur', 'bleed', 'tears', 'handwriting'];
    const chanMed = chanNames.map((_, c) => {
        const s = [...forensicMaps[c]].sort((a, b) => a - b);
        return s[s.length >> 1] || 0;
    });

    let explained = 0;
    const byChannel = { blur: 0, bleed: 0, tears: 0, handwriting: 0 };
    for (const i of holes) {
        let any = false;
        for (let c = 0; c < 4; c++) {
            // Twice the page's own median for that channel, floored so a page
            // with a near-zero median does not treat any speck as elevated.
            if (forensicMaps[c][i] > Math.max(2 * chanMed[c], 0.15)) {
                any = true; byChannel[chanNames[c]]++;
            }
        }
        if (any) explained++;
    }
    const frac = explained / holes.length;
    const corr = observed(CHECK,
        'low-confidence cells cross-referenced against the forensic damage maps',
        { page: pageNo, holeCells: holes.length, explainedCells: explained,
          explainedFraction: +frac.toFixed(3), byChannel,
          channelMedians: Object.fromEntries(chanNames.map((n, c) =>
              [n, +chanMed[c].toFixed(4)])) },
        { region, severity: 0.2 });
    out.push(corr);

    if (frac >= 0.6) {
        out.push(inferred(CHECK,
            'the low-confidence region coincides with measured physical damage, so poor '
            + 'recognition there is explained by the condition of the page rather than by '
            + 'its content',
            [base.id, hole.id, corr.id], { region, severity: 0.2 }));
    } else if (frac <= 0.2) {
        out.push(inferred(CHECK,
            `${holes.length - explained} of ${holes.length} low-confidence cells show no `
            + 'blur, bleed-through, tearing or overlay that would account for them — the '
            + 'page is physically clean where the OCR failed',
            [base.id, hole.id, corr.id], { region, severity: 0.6 }));
        out.push(uncertain(CHECK,
            'unexplained recognition failure is consistent with content that was rendered '
            + 'or inserted by a different process from the rest of the page, but it is '
            + 'also what an unusual typeface or a dense table produces',
            { region, severity: 0.3 }));
    }
    return out;
}

function cellsBbox(cells, cw, ch, pageNo) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of cells) {
        const gx = i % GRID, gy = (i / GRID) | 0;
        x0 = Math.min(x0, gx); y0 = Math.min(y0, gy);
        x1 = Math.max(x1, gx); y1 = Math.max(y1, gy);
    }
    return { page: pageNo, x: x0 * cw, y: y0 * ch,
             w: (x1 - x0 + 1) * cw, h: (y1 - y0 + 1) * ch };
}
