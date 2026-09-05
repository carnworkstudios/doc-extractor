// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// readingOrder.js — disagreement between the order text is PAINTED and the
// order the page's own layout says it should be READ.
//
// THE SIGNAL
// ----------
// A PDF's content stream has an order. A page's visual layout has an order.
// When a document is typeset in one pass they agree closely: a typesetter emits
// the first column top-to-bottom, then the second.
//
// They come apart for exactly three reasons, and separating them is this
// module's whole job:
//
//   1. The layout is genuinely complex — a sidebar, a pull quote, a figure
//      wrapped by text. Very common, completely innocent, and the reason a
//      naive "content order != visual order" alarm is useless.
//   2. The PDF writer emits by font or by graphics state rather than by
//      position. Some CAD and report generators do this for every page.
//      Innocent, and identifiable because it is uniform across the document.
//   3. Content was inserted. A run of text appended to the end of a content
//      stream but positioned in the middle of the page produces a LOCAL,
//      LARGE order inversion on ONE page of a document whose other pages agree.
//
// So the measurement is the inversion count, and the finding is about how that
// count compares to the rest of the document — never about its absolute value.
// This is the same doctrine as ocrScale.js: the threshold comes from the page's
// own distribution, not from a constant.
//
// THE REFERENCE ORDER IS layoutTreeBuilder's
// ------------------------------------------
// Not a hand-rolled top-to-bottom sort. `layoutTreeBuilder` performs a
// recursive XY-cut and already knows about columns, sidebars and nested
// clusters — a plain y-sort would report every two-column page as massively
// out of order, which is case 1 above and is exactly the false positive that
// makes such a check worthless. Reusing the repo's own tree means the reference
// order is the one the rest of the pipeline actually uses.

import { observed, inferred, uncertain } from './findings.js';
import { layoutTreeBuilder } from '../vector/layoutTreeBuilder.js';

const CHECK = 'reading-order';

/**
 * Flatten an LNode tree to the region ids in visual reading order.
 *
 * Depth-first, children in emission order. `layoutTreeBuilder` emits row splits
 * top-to-bottom and column splits left-to-right, so a depth-first walk IS the
 * reading order and nothing needs re-sorting here.
 */
export function flattenTree(node, acc = []) {
    if (!node) return acc;
    // A leaf carries its region id as `node.id`. This used to read `node.ids`
    // only — a field layoutTreeBuilder has never emitted — so the walk always
    // returned an empty list and every page scored `xycut:degenerate` with zero
    // inversions. The check reported nothing on any document.
    // `ids` is still honoured for any caller that supplies a grouped node.
    if (Array.isArray(node.ids) && node.ids.length) {
        for (const id of node.ids) acc.push(id);
    } else if (node.id) {
        acc.push(node.id);
    }
    const kids = node.children || node.cells || node.tracks || [];
    for (const k of kids) flattenTree(k, acc);
    return acc;
}

/**
 * Count inversions between two orderings of the same ids.
 *
 * Merge-sort inversion count, O(n log n). The naive O(n^2) version is fine at
 * 40 regions and not fine on a newspaper page with 400, and this runs over
 * every page of a document.
 *
 * @returns {{inversions:number, pairs:number, normalised:number}}
 *   `normalised` is inversions / (n choose 2): 0 = identical order,
 *   1 = exactly reversed. Dimensionless, so it is comparable across pages with
 *   very different region counts — which a raw count is not.
 */
export function inversionCount(order, reference) {
    const rank = new Map(reference.map((id, i) => [id, i]));
    const seq = order.filter((id) => rank.has(id)).map((id) => rank.get(id));
    const n = seq.length;
    if (n < 2) return { inversions: 0, pairs: 0, normalised: 0 };

    let inv = 0;
    const buf = new Array(n);
    const sort = (lo, hi) => {
        if (hi - lo < 2) return;
        const mid = (lo + hi) >> 1;
        sort(lo, mid); sort(mid, hi);
        let i = lo, j = mid, k = lo;
        while (i < mid && j < hi) {
            if (seq[i] <= seq[j]) buf[k++] = seq[i++];
            else { inv += mid - i; buf[k++] = seq[j++]; }
        }
        while (i < mid) buf[k++] = seq[i++];
        while (j < hi) buf[k++] = seq[j++];
        for (let t = lo; t < hi; t++) seq[t] = buf[t];
    };
    sort(0, n);
    const pairs = (n * (n - 1)) / 2;
    return { inversions: inv, pairs, normalised: pairs ? inv / pairs : 0 };
}

/**
 * Per-page measurement. Emits ONLY observations — the judgement needs the whole
 * document and is made in `analyseReadingOrder` below.
 *
 * @param {Array} regions   classified regions, each {id, type, bbox}
 * @param {Array<string>} paintOrder  region ids in content-stream paint order
 * @param {{x,y,w,h}} pageBox
 * @param {import('../vector/pageScale.js').PageScale} pageScale
 */
export function measurePageOrder(regions, paintOrder, pageBox, pageScale, pageNo = 1) {
    if (!regions || regions.length < 3) {
        return { page: pageNo, normalised: 0, inversions: 0, regions: regions?.length || 0,
                 method: 'skipped', worst: null };
    }
    let tree, method;
    try {
        ({ tree, method } = layoutTreeBuilder(regions, pageBox, pageScale));
    } catch {
        return { page: pageNo, normalised: 0, inversions: 0, regions: regions.length,
                 method: 'tree-failed', worst: null };
    }
    let visual = flattenTree(tree);
    if (visual.length < 3) {
        // The zones fallback did not produce a usable ordering. Reporting an
        // inversion count against a degenerate reference would be reporting
        // noise as a finding.
        return { page: pageNo, normalised: 0, inversions: 0, regions: regions.length,
                 method: `${method}:degenerate`, worst: null };
    }
    const { inversions, pairs, normalised } = inversionCount(paintOrder, visual);

    // The single region most out of place, for the region pointer on the
    // finding. Rank distance, not index distance: it is the one whose paint
    // position is furthest from its visual position.
    const vRank = new Map(visual.map((id, i) => [id, i]));
    let worst = null, worstD = 0;
    paintOrder.forEach((id, i) => {
        if (!vRank.has(id)) return;
        const d = Math.abs(vRank.get(id) - i);
        if (d > worstD) { worstD = d; worst = id; }
    });

    return { page: pageNo, normalised, inversions, pairs, regions: regions.length,
             method, worst, worstDistance: worstD };
}

/**
 * Document-level judgement.
 *
 * @param {Array} pageMeasurements  from measurePageOrder()
 */
export function analyseReadingOrder(pageMeasurements) {
    const out = [];
    const usable = pageMeasurements.filter((m) => m.pairs > 0);
    if (usable.length < 2) {
        return [observed(CHECK, 'not enough pages with a usable layout tree to compare',
            { pagesMeasured: pageMeasurements.length, usable: usable.length })];
    }

    const vals = usable.map((m) => m.normalised).sort((a, b) => a - b);
    const med = vals[vals.length >> 1];
    const devs = vals.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = (devs[devs.length >> 1] || 0) * 1.4826;

    const base = observed(CHECK, 'paint order compared against the layout tree on every page',
        { pages: usable.length,
          medianNormalisedInversions: +med.toFixed(4),
          mad: +mad.toFixed(4),
          perPage: usable.map((m) => ({ page: m.page, n: +m.normalised.toFixed(4),
                                        method: m.method })) });
    out.push(base);

    if (med > 0.25) {
        // Case 2: the writer does not emit in reading order at all. Saying so
        // once, at document level, is what stops every page being reported.
        out.push(inferred(CHECK,
            'this document\'s paint order does not follow reading order anywhere '
            + `(median ${(med * 100).toFixed(0)}% of region pairs inverted), which is a `
            + 'property of the producing tool rather than of any one page',
            [base.id], { severity: 0.1 }));
    }

    // Threshold from the document's own distribution. A page is anomalous when
    // it is far from ITS OWN document's median — never against a constant,
    // because 0.3 is unremarkable in a magazine and extraordinary in a report.
    const k = 4.0;
    const floor = 0.06;   // below this, inversions are a couple of swapped captions
    for (const m of usable) {
        if (m.normalised <= floor) continue;
        // MAD collapses to exactly zero whenever more than half the pages share
        // one value — which is the NORMAL case for a well-behaved document,
        // where most pages have identical (usually zero) inversion counts. The
        // first version returned early on mad == 0 and therefore flagged nothing
        // on precisely the documents where an outlier is most obvious.
        //
        // A perfectly uniform document is not a document with no scale; it is a
        // document whose scale is "no variation at all", and against that scale
        // any page above the floor is an outlier. Reporting madUnits as null
        // rather than as Infinity keeps the finding's measurements honest about
        // which regime produced it.
        const degenerate = mad <= 1e-6;
        const units = degenerate ? null : (m.normalised - med) / mad;
        if (!degenerate && units < k) continue;
        if (degenerate && m.normalised <= med) continue;
        const o = observed(CHECK,
            `page ${m.page} paint order departs from its layout order far more than the `
            + 'rest of the document',
            { page: m.page, normalisedInversions: +m.normalised.toFixed(4),
              documentMedian: +med.toFixed(4),
              madUnits: units === null ? null : +units.toFixed(2),
              documentSpread: degenerate ? 'uniform' : 'measured',
              regions: m.regions, worstRegion: m.worst, worstDistance: m.worstDistance },
            { severity: 0.5, region: { page: m.page, x: 0, y: 0, w: 0, h: 0 } });
        out.push(o);
        out.push(inferred(CHECK,
            `on page ${m.page} a block of content is painted at a point in the stream far `
            + 'from where it sits on the page, while the rest of the document is '
            + 'internally consistent — this is the shape of content appended to an '
            + 'existing page',
            [base.id, o.id], { severity: 0.7,
                               region: { page: m.page, x: 0, y: 0, w: 0, h: 0 } }));
    }

    if (out.length === 1) {
        out.push(observed(CHECK, 'no page departs from the document\'s own ordering pattern',
            { pages: usable.length, k, floor }));
    }
    return out;
}

export const _internals = { inversionCount, flattenTree };
