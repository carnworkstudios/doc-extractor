// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// alteredRegions.js — looks for places where one part of a raster page has a
// different processing history from the rest of it.
//
// THE PRINCIPLE
// -------------
// A page that came off a scanner in one pass is homogeneous in ways that have
// nothing to do with its content. Every square inch went through the same
// sensor, the same demosaic, the same resample and the same JPEG encoder, so
// the *statistics of the noise* and the *periodicity of the compression grid*
// are constant across it even though the picture is not.
//
// Paste a region in from another source and you cannot easily fix that. The
// pasted pixels carry their own noise floor, their own resampling phase and
// their own quantisation history. None of it is visible; all of it is
// measurable.
//
// FOUR INDEPENDENT TESTS, DELIBERATELY NOT COMBINED INTO A SCORE
// --------------------------------------------------------------
//   1. noise-floor mismatch     — local high-frequency residual energy
//   2. resampling-grid breaks   — 8-px periodicity of the second difference
//   3. compression-level islands— local blockiness at the JPEG grid
//   4. quantisation discontinuity — blockiness PHASE, not magnitude
//
// They are reported separately because they fail separately. Test 1 fires on a
// large flat photograph. Test 2 fires on a page that was legitimately
// upsampled. Test 3 fires on a region that is genuinely smoother than its
// surroundings. Any single one alone is a false-positive machine; the finding
// worth reading is a region where SEVERAL disagree with the page, and the
// module says which — it does not blend them into one number that hides which
// evidence is actually present.
//
// EVERY THRESHOLD IS RELATIVE TO THE PAGE'S OWN DISTRIBUTION
// ----------------------------------------------------------
// This follows the same doctrine as ocrScale.js and streamDetector.js. There is
// no "noise floor above 0.03 is suspicious" constant, because 0.03 means one
// thing on a 600-dpi archival scan and something else on a phone photo. A tile
// is anomalous when it is a stated number of robust deviations from the median
// of the OTHER tiles on the same page. The unit is dimensionless.

import { observed, inferred, uncertain } from './findings.js';

const CHECK = 'altered-regions';

// Analysis tile. 64 px is 8 JPEG blocks on a side, which is the smallest tile
// on which the 8-px periodicity tests have enough periods to be stable, and
// small enough that a pasted signature or a changed figure occupies several.
const TILE = 64;

// How many robust deviations from the page median makes a tile anomalous.
// Expressed in MAD units, not standard deviations: a page containing one large
// pasted region would inflate its own standard deviation enough to hide the
// paste, which is precisely the case that matters. The median absolute
// deviation does not move.
const MAD_K = 3.5;

// A single odd tile is noise. Findings are only raised for connected groups.
const MIN_CLUSTER_TILES = 4;

function grey(canvas) {
    const w = canvas.width, h = canvas.height;
    const c = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0);
    const px = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0, p = 0; i < px.length; i += 4, p++) {
        g[p] = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
    }
    return { g, w, h };
}

/**
 * Noise floor of a tile: the median absolute Laplacian residual.
 *
 * MEDIAN, not mean. A tile containing text has a handful of very large
 * residuals at the glyph edges, and a mean absolute residual is dominated by
 * them — so the measurement would be reporting "how much text is here", which
 * correlates with content and is therefore useless for finding a paste. The
 * median sits in the paper between the strokes, which is where the sensor noise
 * actually lives.
 */
function noiseFloor(g, w, x0, y0, size) {
    const vals = [];
    for (let y = y0 + 1; y < y0 + size - 1; y++) {
        for (let x = x0 + 1; x < x0 + size - 1; x++) {
            const i = y * w + x;
            const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
            vals.push(Math.abs(lap));
        }
    }
    if (!vals.length) return 0;
    vals.sort((a, b) => a - b);
    return vals[vals.length >> 1];
}

/**
 * Blockiness at the JPEG 8x8 grid, and its PHASE.
 *
 * `energy` is how much stronger the second difference is at multiples of 8 than
 * between them — the classic blocking measure. `phase` is WHICH offset within
 * the period carries that peak.
 *
 * The phase is the sharper instrument and the reason this is not just a
 * "compression level" test. Two regions can be compressed to the same quality
 * and still have their block grids offset from each other, because the pasted
 * region was cropped from its source at an offset that was not a multiple of 8.
 * A phase discontinuity is very hard to produce accidentally and very easy to
 * produce by pasting.
 */
function blockiness(g, w, x0, y0, size) {
    const acc = new Float64Array(8);
    const cnt = new Float64Array(8);
    for (let y = y0; y < y0 + size; y++) {
        for (let x = x0 + 1; x < x0 + size - 1; x++) {
            const i = y * w + x;
            const d2 = Math.abs(2 * g[i] - g[i - 1] - g[i + 1]);
            const ph = x & 7;
            acc[ph] += d2; cnt[ph]++;
        }
    }
    let best = 0, bestV = -1, sum = 0;
    for (let p = 0; p < 8; p++) {
        const v = cnt[p] ? acc[p] / cnt[p] : 0;
        acc[p] = v; sum += v;
        if (v > bestV) { bestV = v; best = p; }
    }
    const mean = sum / 8;
    return { energy: mean > 0 ? (bestV - mean) / mean : 0, phase: best, mean };
}

/**
 * Resampling signature: periodicity of the second difference's variance.
 *
 * An image that has been scaled by a non-integer factor has a periodic
 * correlation between neighbouring pixels' second differences, because the
 * interpolator reuses the same weights every 1/frac samples. Content does not
 * produce that; only a resample does. A region that has been resampled a
 * different number of times from the page around it will disagree here.
 */
function resampleScore(g, w, x0, y0, size) {
    const row = new Float64Array(size);
    for (let y = y0 + 1; y < y0 + size - 1; y++) {
        for (let x = x0 + 1; x < x0 + size - 1; x++) {
            const i = y * w + x;
            row[x - x0] += Math.abs(2 * g[i] - g[i - 1] - g[i + 1]);
        }
    }
    // Autocorrelation at lags 2..8, normalised by lag 0. A flat spectrum means
    // no resampling signature; a peak means one.
    let z = 0, n = 0;
    for (let i = 0; i < size; i++) { z += row[i]; n++; }
    const mu = z / Math.max(n, 1);
    let denom = 0;
    for (let i = 0; i < size; i++) denom += (row[i] - mu) ** 2;
    if (denom <= 0) return 0;
    let peak = 0;
    for (let lag = 2; lag <= 8; lag++) {
        let s = 0;
        for (let i = 0; i + lag < size; i++) s += (row[i] - mu) * (row[i + lag] - mu);
        peak = Math.max(peak, Math.abs(s) / denom);
    }
    return peak;
}

function medianAndMad(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const med = s.length ? s[s.length >> 1] : 0;
    const dev = s.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    // 1.4826 makes the MAD a consistent estimator of sigma for a normal
    // distribution, so MAD_K is interpretable in the usual units even though
    // the estimator is robust.
    return { med, mad: (dev.length ? dev[dev.length >> 1] : 0) * 1.4826 };
}

/** Connected components over the anomaly grid, 4-connectivity. */
function cluster(flags, cols, rows) {
    const seen = new Uint8Array(cols * rows);
    const out = [];
    for (let i = 0; i < flags.length; i++) {
        if (!flags[i] || seen[i]) continue;
        const stack = [i]; seen[i] = 1;
        const cells = [];
        while (stack.length) {
            const k = stack.pop();
            cells.push(k);
            const cx = k % cols, cy = (k / cols) | 0;
            const nb = [];
            if (cx > 0) nb.push(k - 1);
            if (cx < cols - 1) nb.push(k + 1);
            if (cy > 0) nb.push(k - cols);
            if (cy < rows - 1) nb.push(k + cols);
            for (const m of nb) if (flags[m] && !seen[m]) { seen[m] = 1; stack.push(m); }
        }
        out.push(cells);
    }
    return out;
}

/**
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas  the page raster
 * @param {number} pageNo
 * @returns {Array<import('./findings.js').Finding>}
 */
export function analyseAlteredRegions(canvas, pageNo = 1) {
    const out = [];
    const { g, w, h } = grey(canvas);
    const cols = Math.floor(w / TILE), rows = Math.floor(h / TILE);
    if (cols < 3 || rows < 3) {
        return [observed(CHECK, 'page too small for tile analysis',
            { width: w, height: h, tile: TILE })];
    }

    const noise = [], blockE = [], phase = [], resamp = [];
    for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) {
            const x0 = tx * TILE, y0 = ty * TILE;
            noise.push(noiseFloor(g, w, x0, y0, TILE));
            const b = blockiness(g, w, x0, y0, TILE);
            blockE.push(b.energy); phase.push(b.phase);
            resamp.push(resampleScore(g, w, x0, y0, TILE));
        }
    }

    // A tile whose ink coverage is negligible carries no measurable signal in
    // any of the four tests — an empty margin has no noise floor worth the name
    // and no blocking artifacts to phase-align. Including such tiles in the
    // page statistics drags the median toward "blank" and makes every tile
    // containing content look anomalous.
    const inked = noise.map((v) => v > 1e-4);
    const sel = (arr) => arr.filter((_, i) => inked[i]);

    const nStat = medianAndMad(sel(noise));
    const bStat = medianAndMad(sel(blockE));
    const rStat = medianAndMad(sel(resamp));

    const phaseCount = new Array(8).fill(0);
    for (let i = 0; i < phase.length; i++) if (inked[i]) phaseCount[phase[i]]++;
    const dominantPhase = phaseCount.indexOf(Math.max(...phaseCount));

    out.push(observed(CHECK, 'page-level processing statistics measured',
        { tiles: cols * rows, inkedTiles: sel(noise).length,
          noiseFloorMedian: +nStat.med.toFixed(5), noiseFloorMad: +nStat.mad.toFixed(5),
          blockinessMedian: +bStat.med.toFixed(4),
          resampleMedian: +rStat.med.toFixed(4),
          dominantJpegPhase: dominantPhase,
          phaseHistogram: phaseCount }));
    const baseId = out[0].id;

    const tests = [
        { key: 'noise floor', arr: noise, stat: nStat, sev: 0.5 },
        { key: 'compression level', arr: blockE, stat: bStat, sev: 0.45 },
        { key: 'resampling signature', arr: resamp, stat: rStat, sev: 0.5 },
    ];

    const anomalyCount = new Uint8Array(cols * rows);
    const perTest = [];

    for (const t of tests) {
        const flags = new Uint8Array(cols * rows);
        if (t.stat.mad > 1e-9) {
            for (let i = 0; i < flags.length; i++) {
                if (!inked[i]) continue;
                if (Math.abs(t.arr[i] - t.stat.med) > MAD_K * t.stat.mad) {
                    flags[i] = 1; anomalyCount[i]++;
                }
            }
        }
        perTest.push({ ...t, flags });
    }

    // Phase discontinuity is handled apart from the MAD tests because phase is
    // categorical, not continuous — "3.5 deviations from the median phase" is
    // meaningless when phase 7 and phase 0 are adjacent.
    const phaseFlags = new Uint8Array(cols * rows);
    for (let i = 0; i < phase.length; i++) {
        // Only trust the phase where there is enough blocking energy for the
        // peak to mean anything. On a tile with no compression artifacts the
        // argmax over eight near-equal numbers is pure noise.
        if (inked[i] && blockE[i] > Math.max(bStat.med, 0.05) && phase[i] !== dominantPhase) {
            phaseFlags[i] = 1; anomalyCount[i]++;
        }
    }
    perTest.push({ key: 'JPEG block phase', flags: phaseFlags, sev: 0.75 });

    for (const t of perTest) {
        for (const cells of cluster(t.flags, cols, rows)) {
            if (cells.length < MIN_CLUSTER_TILES) continue;
            const region = bbox(cells, cols, pageNo);
            const m = observed(CHECK,
                `${cells.length} contiguous tiles disagree with the page on ${t.key}`,
                { test: t.key, tiles: cells.length,
                  ...(t.stat ? { pageMedian: +t.stat.med.toFixed(5),
                                 clusterMean: +mean(cells.map((c) => t.arr[c])).toFixed(5),
                                 madUnits: +(Math.abs(mean(cells.map((c) => t.arr[c])) - t.stat.med)
                                             / Math.max(t.stat.mad, 1e-9)).toFixed(2) }
                              : { dominantPhase }) },
                { region, severity: t.sev * 0.6 });
            out.push(m);
        }
    }

    // The corroborated finding: tiles that more than one INDEPENDENT test
    // flagged. This is where an inference is warranted, and it is the only
    // place in this module where one is drawn.
    const corroborated = new Uint8Array(cols * rows);
    for (let i = 0; i < anomalyCount.length; i++) corroborated[i] = anomalyCount[i] >= 2 ? 1 : 0;
    const strong = cluster(corroborated, cols, rows)
        .filter((c) => c.length >= MIN_CLUSTER_TILES);

    for (const cells of strong) {
        const region = bbox(cells, cols, pageNo);
        const which = perTest.filter((t) => cells.some((c) => t.flags[c])).map((t) => t.key);
        const m = observed(CHECK,
            `${cells.length} tiles flagged by ${which.length} independent tests`,
            { tiles: cells.length, tests: which,
              areaFraction: +(cells.length / (cols * rows)).toFixed(4) },
            { region, severity: 0.8 });
        out.push(m);
        out.push(inferred(CHECK,
            `region at (${Math.round(region.x)}, ${Math.round(region.y)}) has a processing `
            + `history inconsistent with the rest of the page — ${which.join(', ')} all differ. `
            + 'This is what a pasted or re-encoded region looks like.',
            [baseId, m.id],
            { region, severity: 0.85 }));
    }

    if (!strong.length) {
        out.push(observed(CHECK,
            'no region was flagged by two or more independent tests',
            { tests: perTest.length, madK: MAD_K, minClusterTiles: MIN_CLUSTER_TILES }));
        // Explicitly NOT "the page is unaltered". Absence of this evidence is
        // not evidence of absence: a well-executed edit re-encoded at the same
        // quality with an aligned crop leaves nothing for these tests to find,
        // and a report that said "clean" would be overclaiming.
        out.push(uncertain(CHECK,
            'these tests found nothing; that is not evidence the page is unaltered — '
            + 'a paste that was re-encoded with the page and crop-aligned to the block '
            + 'grid leaves no signature any of them can see',
            { severity: 0 }));
    }
    return out;
}

function bbox(cells, cols, pageNo) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of cells) {
        const cx = c % cols, cy = (c / cols) | 0;
        x0 = Math.min(x0, cx); y0 = Math.min(y0, cy);
        x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
    }
    return { page: pageNo, x: x0 * TILE, y: y0 * TILE,
             w: (x1 - x0 + 1) * TILE, h: (y1 - y0 + 1) * TILE };
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export const _internals = { noiseFloor, blockiness, resampleScore, medianAndMad, cluster, TILE };
