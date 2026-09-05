// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// signals.js — the Head B contract: names, order, and de-normalisation.
//
// WHY THIS FILE IS SO SMALL AND SO IMPORTANT
// ------------------------------------------
// Head B emits eight numbers in [0,1] and four 20x20 maps. Nothing in the
// tensor says which number is which. The order is defined in ONE place on the
// training side (`.training/scripts/degrade.py`, `SIGNALS`) and has to be
// mirrored here exactly.
//
// A mismatch is completely silent. Swap `blur` and `noise` and the pipeline
// still runs, ocrScale still makes a decision, the report still reads fluently
// — it is simply wrong about every page, forever. This is the same class of bug
// as the permuted `CLASS_LABELS` array that shipped in layoutWorker.js, where
// the geometry stayed right and only the names were shuffled, so nothing looked
// broken.
//
// The defence is that the order lives in the model MANIFEST as well, and
// `readSignals()` refuses to interpret a vector whose manifest order does not
// match this file. A model trained with a different order cannot be silently
// consumed by this code; it fails loudly at load.
//
// THE DE-NORMALISERS ARE PHYSICAL UNITS
// -------------------------------------
// The head regresses [0,1] because a network that must emit "sigma = 1.4" and
// "tears = 0.082" in one vector spends capacity on the scale difference rather
// than on the image. Callers want the physical quantity, so it is restored
// here, once, rather than by every caller with its own copy of the constant.

/** Head B scalar names, in channel order. MUST match degrade.py `SIGNALS`. */
export const SIGNAL_NAMES = Object.freeze([
    'skew', 'blur', 'noise', 'bleed', 'warp', 'tears', 'handwriting', 'native',
]);

/** Spatial map channel names, in channel order. MUST match `MAP_SIGNALS`. */
export const MAP_NAMES = Object.freeze(['blur', 'bleed', 'tears', 'handwriting']);

export const MAP_GRID = 20;

/**
 * Full-scale value of each normalised signal. MUST match degrade.py `NORM`.
 * These are the physical units the head was supervised in.
 */
export const SIGNAL_SCALE = Object.freeze({
    skew: 8.0,          // degrees
    blur: 3.0,          // gaussian sigma at the 640 px working size
    noise: 0.14,        // additive sigma, intensity units
    bleed: 0.45,        // alpha of the reverse-side composite
    warp: 0.14,         // corner displacement as a fraction of the page side
    tears: 0.30,        // damaged area fraction
    handwriting: 0.30,  // stamp/signature area fraction
    native: 1.0,        // already a probability
});

/** Physical units, for the report. */
export const SIGNAL_UNITS = Object.freeze({
    skew: 'deg', blur: 'sigma_px', noise: 'sigma', bleed: 'alpha',
    warp: 'fraction_of_page', tears: 'area_fraction', handwriting: 'area_fraction',
    native: 'probability',
});

/**
 * Turn the raw [0,1] vector into named physical quantities.
 *
 * `skew` is the only signed signal, and it is stored with 0.5 as "no skew" —
 * a head that must regress a signed quantity through a sigmoid cannot represent
 * the sign at all, so the training side folds it and this unfolds it.
 *
 * @param {ArrayLike<number>} vec  length 8, each in [0,1]
 * @param {string[]} [manifestOrder]  the order recorded in the model manifest.
 *        When given it is CHECKED, not trusted: a mismatch throws.
 * @returns {Record<string, number>} physical values
 */
export function readSignals(vec, manifestOrder = null) {
    if (!vec || vec.length !== SIGNAL_NAMES.length) {
        throw new Error(`forensic vector must have ${SIGNAL_NAMES.length} entries, got ${vec?.length}`);
    }
    if (manifestOrder) {
        const same = manifestOrder.length === SIGNAL_NAMES.length
            && manifestOrder.every((n, i) => n === SIGNAL_NAMES[i]);
        if (!same) {
            // Loud, not lenient. Re-ordering here to match the manifest would
            // "work" and would mean this file no longer describes the contract.
            throw new Error(
                'model manifest forensic signal order does not match signals.js\n'
                + `  manifest: ${manifestOrder.join(', ')}\n`
                + `  expected: ${SIGNAL_NAMES.join(', ')}`);
        }
    }
    const out = {};
    for (let i = 0; i < SIGNAL_NAMES.length; i++) {
        const name = SIGNAL_NAMES[i];
        const v = Math.max(0, Math.min(1, vec[i]));
        out[name] = name === 'skew'
            ? (v - 0.5) * 2 * SIGNAL_SCALE.skew
            : v * SIGNAL_SCALE[name];
    }
    return out;
}

/**
 * Reshape the flat map tensor into named GRID x GRID arrays.
 * @param {ArrayLike<number>} flat  length 4 * GRID * GRID
 */
export function readMaps(flat, grid = MAP_GRID) {
    const n = grid * grid;
    if (!flat || flat.length !== MAP_NAMES.length * n) {
        throw new Error(`forensic maps must have ${MAP_NAMES.length * n} entries, got ${flat?.length}`);
    }
    const out = {};
    MAP_NAMES.forEach((name, c) => {
        out[name] = Float32Array.from(flat.slice(c * n, (c + 1) * n));
    });
    return out;
}

/**
 * The cell of a map with the strongest response, as a page-space rectangle.
 * This is what lets a report say WHERE rather than only HOW MUCH.
 */
export function peakCell(map, pageW, pageH, grid = MAP_GRID) {
    let best = 0, bi = 0;
    for (let i = 0; i < map.length; i++) if (map[i] > best) { best = map[i]; bi = i; }
    const gx = bi % grid, gy = (bi / grid) | 0;
    return { value: best,
             x: (gx * pageW) / grid, y: (gy * pageH) / grid,
             w: pageW / grid, h: pageH / grid };
}

/**
 * A one-line human summary of which signals are actually elevated.
 *
 * The thresholds below are the only fixed numbers in this file, and they are
 * defensible because they are in PHYSICAL units with a physical meaning, not in
 * pixels: 1 degree of skew is 1 degree at any DPI, and 0.8 sigma of blur is
 * roughly the point where a 10 px body glyph starts losing its counters. They
 * are the "is this worth mentioning" line, not a decision threshold — the
 * decisions in ocrScale.js scale continuously off the values themselves.
 */
export const NOTABLE = Object.freeze({
    skew: 1.0, blur: 0.8, noise: 0.03, bleed: 0.08,
    warp: 0.02, tears: 0.02, handwriting: 0.02,
});

export function notableSignals(physical) {
    const hits = [];
    for (const [k, thr] of Object.entries(NOTABLE)) {
        const v = k === 'skew' ? Math.abs(physical[k]) : physical[k];
        if (v >= thr) hits.push({ signal: k, value: physical[k], unit: SIGNAL_UNITS[k] });
    }
    return hits.sort((a, b) =>
        Math.abs(b.value) / NOTABLE[b.signal] - Math.abs(a.value) / NOTABLE[a.signal]);
}
