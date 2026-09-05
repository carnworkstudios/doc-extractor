// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// duplicatePages.js — finds pages that are copies of one another.
//
// WHAT THIS IS ACTUALLY LOOKING FOR
// ---------------------------------
// Not "the same page scanned twice", which is a scanner-feeder artifact and
// boring. The interesting case is a page substituted from elsewhere in the same
// document — a signature page reused under a different cover sheet, an invoice
// page duplicated with one figure changed, a re-scanned insert. Those are
// NEARLY identical, and the near-miss is the finding.
//
// WHY TWO INDEPENDENT SIGNALS
// ---------------------------
// A perceptual hash alone is not enough, in both directions:
//
//   * FALSE POSITIVES. Two blank-ish pages of the same template — a form's
//     continuation sheets, a run of mostly-empty appendix pages — have almost
//     identical DCT low-frequency content and collide at any useful Hamming
//     threshold. A pHash-only detector reports every long form as riddled with
//     duplicates and is switched off within a day.
//   * FALSE NEGATIVES. Two scans of the SAME sheet differ in skew, exposure and
//     crop. Their pHashes can differ by 12+ bits while a human sees one page.
//
// So the hash is used only as a CANDIDATE FILTER — cheap, O(n^2) over 64-bit
// integers — and every candidate is then confirmed by a structural comparison
// of the layout regions, which is invariant to exposure and tolerant of skew
// because it compares normalised box geometry rather than pixels.
//
// The two signals disagree in useful ways, and that disagreement is reported
// rather than resolved: "visually similar, structurally different" is exactly
// what a substituted page looks like.

import { observed, inferred, uncertain } from './findings.js';

const CHECK = 'duplicate-pages';

// 8x8 DCT low-frequency block over a 32x32 grey reduction. 64 bits.
const HASH_SIDE = 32;
const DCT_KEEP = 8;

/**
 * Perceptual hash of a canvas, as a 64-element Uint8Array of bits.
 *
 * A DCT hash rather than an average hash. aHash thresholds against the page
 * mean, and a document page is ~90% white, so the mean sits in the paper and
 * the hash becomes a coarse map of where the ink is — which is nearly the same
 * for every page of a book. The DCT's low-frequency coefficients describe the
 * ink's DISTRIBUTION instead, and are what actually separates two text pages.
 */
export function pHash(canvas) {
    const N = HASH_SIDE;
    const c = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(N, N)
        : Object.assign(document.createElement('canvas'), { width: N, height: N });
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, N, N);
    const px = ctx.getImageData(0, 0, N, N).data;

    const g = new Float64Array(N * N);
    for (let i = 0, p = 0; i < px.length; i += 4, p++) {
        g[p] = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
    }

    // Separable 2-D DCT-II, only the DCT_KEEP x DCT_KEEP corner. Computing the
    // full 32x32 transform and discarding 93% of it costs 16x more for the same
    // answer.
    const cosTab = new Float64Array(N * DCT_KEEP);
    for (let u = 0; u < DCT_KEEP; u++) {
        for (let x = 0; x < N; x++) {
            cosTab[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
        }
    }
    const rows = new Float64Array(DCT_KEEP * N);
    for (let y = 0; y < N; y++) {
        for (let u = 0; u < DCT_KEEP; u++) {
            let s = 0;
            for (let x = 0; x < N; x++) s += g[y * N + x] * cosTab[u * N + x];
            rows[u * N + y] = s;
        }
    }
    const coef = new Float64Array(DCT_KEEP * DCT_KEEP);
    for (let u = 0; u < DCT_KEEP; u++) {
        for (let v = 0; v < DCT_KEEP; v++) {
            let s = 0;
            for (let y = 0; y < N; y++) s += rows[u * N + y] * cosTab[v * N + y];
            coef[v * DCT_KEEP + u] = s;
        }
    }

    // The DC term is total page brightness. Including it would make an
    // over-exposed copy of a page hash differently from the page, which is the
    // opposite of what a perceptual hash is for.
    const ac = Array.from(coef).slice(1);
    const sorted = [...ac].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const bits = new Uint8Array(64);
    bits[0] = 0;
    for (let i = 0; i < ac.length; i++) bits[i + 1] = ac[i] > median ? 1 : 0;
    return bits;
}

export function hamming(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d;
}

/**
 * Structural similarity of two pages' region sets.
 *
 * Boxes are normalised to the page box first, so a page scanned at a different
 * DPI or cropped slightly differently still matches. Matching is greedy by IoU
 * within the same class — a caption that became a paragraph is a difference we
 * want to see, not one to match through.
 *
 * @returns {{ score:number, matched:number, total:number, unmatched:Array }}
 */
export function structuralSimilarity(regionsA, wA, hA, regionsB, wB, hB) {
    const norm = (rs, w, h) => rs.map((r) => ({
        label: r.label,
        x: r.bbox.x / w, y: r.bbox.y / h,
        w: r.bbox.w / w, h: r.bbox.h / h,
    }));
    const A = norm(regionsA, wA, hA);
    const B = norm(regionsB, wB, hB);
    if (!A.length && !B.length) return { score: 1, matched: 0, total: 0, unmatched: [] };

    const used = new Set();
    let matched = 0;
    let iouSum = 0;
    const unmatched = [];
    for (const a of A) {
        let best = -1, bestIou = 0;
        for (let j = 0; j < B.length; j++) {
            if (used.has(j) || B[j].label !== a.label) continue;
            const i = iou(a, B[j]);
            if (i > bestIou) { bestIou = i; best = j; }
        }
        // 0.5 IoU on NORMALISED boxes. Two scans of one sheet with 2 degrees of
        // relative skew still land well above it; a region that moved to a
        // different part of the page does not.
        if (best >= 0 && bestIou >= 0.5) {
            used.add(best); matched++; iouSum += bestIou;
        } else {
            unmatched.push(a);
        }
    }
    const total = Math.max(A.length, B.length);
    return {
        score: total ? (matched / total) * (matched ? iouSum / matched : 0) : 1,
        matched, total, unmatched,
    };
}

function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const u = a.w * a.h + b.w * b.h - i;
    return u > 0 ? i / u : 0;
}

/** Below this many differing bits, two pHashes are candidates. */
export const HASH_CANDIDATE_BITS = 10;
/** At or above this structural score, a candidate is confirmed a duplicate. */
export const STRUCTURAL_CONFIRM = 0.82;

/**
 * @param {Array<{page:number, canvas:*, regions:Array, w:number, h:number}>} pages
 * @returns {Array<import('./findings.js').Finding>}
 */
export function analyseDuplicates(pages) {
    const out = [];
    if (pages.length < 2) return out;

    const hashes = pages.map((p) => p.hash || pHash(p.canvas));

    for (let i = 0; i < pages.length; i++) {
        for (let j = i + 1; j < pages.length; j++) {
            const bits = hamming(hashes[i], hashes[j]);
            if (bits > HASH_CANDIDATE_BITS) continue;

            const st = structuralSimilarity(
                pages[i].regions || [], pages[i].w, pages[i].h,
                pages[j].regions || [], pages[j].w, pages[j].h);

            const m = observed(CHECK,
                `pages ${pages[i].page} and ${pages[j].page} compared`,
                { hammingBits: bits, structuralScore: +st.score.toFixed(3),
                  regionsMatched: st.matched, regionsTotal: st.total });
            out.push(m);

            if (st.score >= STRUCTURAL_CONFIRM) {
                out.push(inferred(CHECK,
                    `page ${pages[j].page} is a duplicate of page ${pages[i].page}`,
                    [m.id],
                    { severity: 0.45,
                      region: { page: pages[j].page, x: 0, y: 0, w: pages[j].w, h: pages[j].h } }));
            } else if (st.total > 0) {
                // The interesting case. Visually near-identical, structurally
                // divergent: something on the page changed while the template
                // did not. This is what a substituted or edited page looks like,
                // and it is the reason the two signals are kept separate rather
                // than combined into one score.
                out.push(inferred(CHECK,
                    `pages ${pages[i].page} and ${pages[j].page} look alike but their `
                    + `region structure differs (${st.total - st.matched} of ${st.total} `
                    + 'regions do not correspond)',
                    [m.id],
                    { severity: 0.7,
                      region: st.unmatched.length
                          ? denorm(st.unmatched[0], pages[j])
                          : null }));
            }
        }
    }
    if (!out.length) {
        out.push(observed(CHECK, 'no page pair fell within the perceptual-hash threshold',
            { pages: pages.length, thresholdBits: HASH_CANDIDATE_BITS }));
    }
    return out;
}

function denorm(r, page) {
    return { page: page.page, x: r.x * page.w, y: r.y * page.h,
             w: r.w * page.w, h: r.h * page.h };
}
