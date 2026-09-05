// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// regionArbiter.js — who owns a region when several sources claim it.
//
// THE PROBLEM THIS SOLVES
// -----------------------
// Four sources now produce region claims over the same pixels:
//
//   widgetRouter    exact field rects read out of the PDF's AcroForm
//   latticeReconstructor  cell grid derived from ruled lines
//   decompose       ink-grouped blocks and column gutters (raster)
//   the detector    learned boxes with a confidence
//
// The wrong model is "table vs form, one wins". A table INSIDE a form is both,
// and neither claim is false. What actually needs resolving is narrower:
//
//   1. containment    -> not a conflict. Record parent/child and keep both.
//   2. same region,
//      different source -> the stronger EVIDENCE TYPE wins, not the higher
//                          confidence. A 0.31 widget rect beats a 0.94
//                          detector box, because one is read and one is guessed.
//   3. same region,
//      same evidence type -> only then does confidence arbitrate.
//
// EVIDENCE OUTRANKS CONFIDENCE, and that ordering is the whole point. A model's
// confidence is calibrated against its own training distribution; it says
// nothing about whether a measurement disagrees with it. `regionMap.js` already
// refuses to let the detector guess LATTICE vs STREAM for exactly this reason.
//
// ON RESOLUTION
// -------------
// 640 px vs 1280 px does not change what is true on the page, only how well a
// claimant can see it. So resolution belongs INSIDE a claim's confidence
// (`decompose` at 640 px on 2 px glyphs is a weak claimant, at 1280 px a strong
// one) rather than being a separate axis. `sourceConfidence` carries it.

/**
 * Evidence rank. LOWER IS STRONGER. Not a confidence — a statement about how
 * the claim was arrived at.
 */
export const EVIDENCE_RANK = Object.freeze({
    widget: 0,    // the file states it: AcroForm rect
    lattice: 1,   // ruled lines measured from path segments
    geometry: 2,  // ink grouping / column gutters measured from pixels
    detector: 3,  // a learned estimate
});

/** Classes whose claim is about CONTAINING other regions, not excluding them. */
const CONTAINER = new Set(['form', 'table', 'picture']);

function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const iw = x2 - x1, ih = y2 - y1;
    if (iw <= 0 || ih <= 0) return 0;
    const i = iw * ih;
    return i / (a.w * a.h + b.w * b.h - i);
}

function containedIn(inner, outer, frac = 0.80) {
    const x1 = Math.max(inner.x, outer.x), y1 = Math.max(inner.y, outer.y);
    const x2 = Math.min(inner.x + inner.w, outer.x + outer.w);
    const y2 = Math.min(inner.y + inner.h, outer.y + outer.h);
    const iw = x2 - x1, ih = y2 - y1;
    if (iw <= 0 || ih <= 0) return false;
    const a = inner.w * inner.h;
    return a > 0 && (iw * ih) / a >= frac;
}

/**
 * Arbitrate a set of claims into a region tree.
 *
 * @param {Array<{label,bbox,confidence,source}>} claims  `source` keys EVIDENCE_RANK
 * @param {object} [opts]
 * @param {number} [opts.dupIou=0.55]  above this two claims are the SAME region
 * @returns {{regions:Array, dropped:Array}}
 */
export function arbitrate(claims, { dupIou = 0.55 } = {}) {
    const items = (claims || [])
        .filter(c => c?.bbox && c.bbox.w > 0 && c.bbox.h > 0)
        .map((c, i) => ({
            ...c,
            _i: i,
            _rank: EVIDENCE_RANK[c.source] ?? EVIDENCE_RANK.detector,
            _area: c.bbox.w * c.bbox.h,
        }));

    // Strongest evidence first; within a rank, larger area first so a container
    // is seen before the things it contains.
    items.sort((a, b) => (a._rank - b._rank) || (b._area - a._area));

    const kept = [];
    const dropped = [];
    for (const c of items) {
        const rival = kept.find(k => iou(k.bbox, c.bbox) >= dupIou);
        if (rival) {
            // Same region, two claimants. Evidence rank already decided it —
            // `rival` was placed first — UNLESS the ranks tie, in which case
            // confidence arbitrates and the incumbent only loses if clearly beaten.
            if (rival._rank === c._rank && (c.confidence ?? 0) > (rival.confidence ?? 0) + 0.05) {
                dropped.push({ ...rival, reason: `lower confidence than ${c.source}` });
                kept[kept.indexOf(rival)] = c;
            } else {
                dropped.push({ ...c, reason: `same region already claimed by ${rival.source}` });
            }
            continue;
        }
        kept.push(c);
    }

    // Containment. NOT a conflict: a table inside a form is both, and a field
    // inside a table inside a form attaches to the table — the smallest
    // container that holds it, so the tree reflects real nesting rather than
    // collapsing everything onto the outermost box.
    for (const c of kept) {
        let best = null;
        for (const p of kept) {
            if (p === c || !CONTAINER.has(p.label)) continue;
            if (p._area <= c._area) continue;
            if (!containedIn(c.bbox, p.bbox)) continue;
            if (!best || p._area < best._area) best = p;
        }
        c.parent = best ? best._i : null;
        c.parentLabel = best ? best.label : null;
    }

    return {
        regions: kept.map(({ _i, _rank, _area, ...r }) => r),
        dropped: dropped.map(({ _i, _rank, _area, ...r }) => r),
    };
}
