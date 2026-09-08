// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// columnBands.js
// The measure a geometric region should be judged against.
//
// The lattice and box detectors predate the multi-column pass. They ask
// "is this region wide?" and answer it against `viewport.width`, which is the
// right question against the wrong ruler the moment a page has more than one
// column: on 59MN7C-03SI.pdf pp.16/22 the columns run x=36-297 and x=315-576,
// and a callout panel filling ONE column measures 0.42 of the page while being
// 1.00 of its actual measure. Every `w > viewport.width * 0.65` gate therefore
// passes a region that is, in the only sense that matters, full width.
//
// So the fix is not a new rejection test — nothing on those pages crosses a
// gutter, and a crossing test would fire on none of them. It is a denominator.
// This module owns that denominator, once, for every detector that needs it.
//
// Degenerate by construction: with no splits there is one band spanning the
// page, `measureOf` returns `viewport.width`, and every caller reduces exactly
// to its previous arithmetic. Single-column pages cannot change behaviour.

/**
 * Build column bands from the split x-positions the column detector produced.
 *
 * @param {number[]} splitXs  gutter centres, ascending; [] on a single-column page
 * @param {{width:number}} viewport
 * @returns {{lo:number, hi:number, width:number}[]} bands, left to right
 */
export function buildColumnBands(splitXs, viewport) {
    const vpW = viewport?.width || 0;
    if (!vpW) return [];
    const xs = [...new Set((splitXs || []).filter(x => Number.isFinite(x) && x > 0 && x < vpW))]
        .sort((a, b) => a - b);
    const edges = [0, ...xs, vpW];
    const bands = [];
    for (let i = 0; i + 1 < edges.length; i++) {
        bands.push({ lo: edges[i], hi: edges[i + 1], width: edges[i + 1] - edges[i] });
    }
    return bands;
}

/**
 * The band a region belongs to, by centre point.
 *
 * Centre rather than overlap: a bbox carries border and pad slack that can
 * reach a few px past a gutter, and an overlap test would hand such a region
 * the whole page as its measure — reintroducing the bug this module exists to
 * remove. A region whose centre is in a band is being read as that column's.
 *
 * @returns {{lo,hi,width}|null} null when there are no bands, or when the
 *          region genuinely spans more than one (a real full-width element).
 */
export function bandOf(bbox, bands) {
    if (!bands?.length || !bbox) return null;
    if (bands.length === 1) return bands[0];
    const cx = bbox.x + bbox.w / 2;
    const band = bands.find(b => cx >= b.lo && cx < b.hi) || null;
    if (!band) return null;
    // A region wider than its own band is not that column's — it is a
    // full-width element that happens to be centred there (a page-spanning
    // table, a masthead). Judge those against the page, as before.
    if (bbox.w > band.width * 1.15) return null;
    return band;
}

/**
 * The width a region's own gates should be denominated by.
 *
 * This is the single call sites should use. Falls back to page width whenever
 * there is no meaningful column band, which is what makes the change inert on
 * single-column pages.
 */
export function measureOf(bbox, bands, viewport) {
    const band = bandOf(bbox, bands);
    return band ? band.width : (viewport?.width || 0);
}
