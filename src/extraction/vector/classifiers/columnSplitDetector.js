// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 carnworkstudios
// columnSplitDetector.js
// Page-level column split detection using bipartite text-gap inference.
//
// Extracted from contextClassifier.js _detectPageColumns + _splitByColumns.
// No logic changes — pure extraction.
//
// Exports:
//   detectPageColumns(textMeta, viewport, scale, opts = {})
//   splitByColumns(textMeta, splits)

const _PAGE_NUM_RE = /^\d{1,3}$/;

export function detectPageColumns(textMeta, viewport, scale, { dropGate3 = false } = {}) {
    if (!textMeta.length || !viewport?.width) {
        return { splits: [], fullWidthIndices: new Set() };
    }

    const vpWidth = viewport.width;

    const sorted = [...textMeta].sort((a, b) => a.vy - b.vy);
    const bands = [];
    for (const tm of sorted) {
        let placed = false;
        for (const band of bands) {
            if (Math.abs(band.y - tm.vy) <= scale.yBandTolPx) {
                band.y = (band.y * band.items.length + tm.vy) / (band.items.length + 1);
                band.items.push(tm);
                placed = true;
                break;
            }
        }
        if (!placed) bands.push({ y: tm.vy, items: [tm] });
    }

    const WIDE_BAND_FRAC   = 0.55;
    const fullWidthIndices = new Set();
    for (const band of bands) {
        const minX = Math.min(...band.items.map(i => i.vx));
        const maxX = Math.max(...band.items.map(i => i.vx + (i.vWidth || 0)));
        if (maxX - minX > vpWidth * WIDE_BAND_FRAC) {
            for (const tm of band.items) fullWidthIndices.add(tm.idx);
        }
    }

    const WIDE_ITEM   = vpWidth * WIDE_BAND_FRAC;
    const MERGE_ITEM  = vpWidth * 0.40;
    const NOISE_FLOOR = scale.S * 0.5;
    const tol         = Math.max(4, scale.colGapMinPx * 0.5);

    const structItems = textMeta.filter(i => {
        const w = i.vWidth || 0;
        if (w <= NOISE_FLOOR) return false;
        if (w > MERGE_ITEM)   return false;
        if (_PAGE_NUM_RE.test(i.str.trim()) && w < scale.S * 2) return false;
        return true;
    });

    const sortedItems = [...structItems].sort((a, b) => a.vx - b.vx);
    const spans = [];
    for (const tm of sortedItems) {
        const lo = tm.vx, hi = tm.vx + (tm.vWidth || 0);
        if (spans.length && lo <= spans.at(-1).hi + 2) {
            spans.at(-1).hi = Math.max(spans.at(-1).hi, hi);
        } else {
            spans.push({ lo, hi });
        }
    }

    const rawCandidates = [];
    for (let i = 0; i + 1 < spans.length; i++) {
        const gap    = spans[i + 1].lo - spans[i].hi;
        const center = (spans[i].hi + spans[i + 1].lo) / 2;
        if (gap >= scale.colGapMinPx && center >= vpWidth * 0.10 && center <= vpWidth * 0.90) {
            rawCandidates.push(center);
        }
    }

    // Span projection found nothing: try the two fallbacks. They are ADDITIVE,
    // not exclusive — the bimodal start-gap detector can fire on a gap inside a
    // column (N19-1423 p2: 188px start-gap at x=912 deep in the right column),
    // and when its wrong candidate later fails the gates, the true gutter must
    // still be on the candidate list. The gates arbitrate.
    const spanStageEmpty = rawCandidates.length === 0;

    if (spanStageEmpty && structItems.length >= 10) {
        const binned = [...new Set(sortedItems.map(i => Math.round(i.vx / 2) * 2))].sort((a,b)=>a-b);
        const gaps = [];
        for (let i = 1; i < binned.length; i++) gaps.push({ g: binned[i]-binned[i-1], x: (binned[i-1]+binned[i])/2 });
        gaps.sort((a,b) => b.g - a.g);
        if (gaps.length >= 2) {
            const best = gaps[0], second = gaps[1];
            if (best.g >= scale.colGapMinPx * 1.5
                && best.g >= second.g * 2.0
                && best.x >= vpWidth * 0.15 && best.x <= vpWidth * 0.85) {
                rawCandidates.push(best.x);
            }
        }
    }

    if (spanStageEmpty && structItems.length >= 6) {
        const itemVxMin = Math.min(...structItems.map(i => i.vx));
        const itemVxMax = Math.max(...structItems.map(i => i.vx));
        const scanLo = Math.max(vpWidth * 0.15, itemVxMin + scale.colGapMinPx);
        const scanHi = Math.min(vpWidth * 0.85, itemVxMax - scale.colGapMinPx);

        if (scanLo < scanHi) {
            const scanStep = Math.max(4, scale.colGapMinPx / 4);
            let minCross = Infinity, bestX = -1;
            for (let X = scanLo; X <= scanHi; X += scanStep) {
                const left  = structItems.filter(i => i.vx < X - tol).length;
                const right = structItems.filter(i => i.vx >= X + tol).length;
                if (left < 3 || right < 3) continue;
                const crossing = structItems.filter(i => {
                    const lo = i.vx, hi = i.vx + (i.vWidth || 0);
                    return lo < X - tol && hi > X + tol;
                }).length;
                if (crossing < minCross) { minCross = crossing; bestX = X; }
            }
            if (bestX > 0) {
                const scanCross = structItems.filter(i => {
                    const lo = i.vx, hi = i.vx + (i.vWidth || 0);
                    return lo < bestX - tol && hi > bestX + tol;
                }).length;
                const MAX_CROSS = Math.max(1, Math.ceil(structItems.length * 0.06));
                if (scanCross <= MAX_CROSS) {
                    const leftEnd = structItems
                        .filter(i => (i.vx + (i.vWidth || 0)) <= bestX + tol)
                        .reduce((m, i) => Math.max(m, i.vx + (i.vWidth || 0)), -Infinity);
                    const rightStart = structItems
                        .filter(i => i.vx > bestX)
                        .reduce((m, i) => Math.min(m, i.vx), Infinity);

                    let candidate = bestX;
                    if (leftEnd > -Infinity && rightStart < Infinity && rightStart > leftEnd) {
                        candidate = (leftEnd + rightStart) / 2;
                    }
                    if (candidate >= vpWidth * 0.15 && candidate <= vpWidth * 0.85) {
                        rawCandidates.push(candidate);
                    }
                    // The midpoint adjustment trusts leftEnd/rightStart as column
                    // edges; a single outlier item (figure label) can drag the
                    // candidate into a false micro-gutter. Offer the raw scan
                    // position too — the gates arbitrate, dedup collapses.
                    if (Math.abs(candidate - bestX) > tol &&
                        bestX >= vpWidth * 0.15 && bestX <= vpWidth * 0.85) {
                        rawCandidates.push(bestX);
                    }
                }
            }
        }
    }

    if (typeof process !== 'undefined' && process.env?.GX_DEBUG_COLS) {
        console.log(`[cols] items=${textMeta.length} struct=${structItems.length} spans=${spans.length} candidates=[${rawCandidates.map(x => Math.round(x)).join(',')}]`);
    }

    if (!rawCandidates.length) return { splits: [], fullWidthIndices };

    const PERSIST_FRAC  = 0.20;
    const contentTop    = Math.min(...bands.map(b => b.y));
    const contentBottom = Math.max(...bands.map(b => b.y));
    const persistThresh = contentTop + (contentBottom - contentTop || 1) * PERSIST_FRAC;

    const MIN_SIDE       = 3;
    const MIN_COMMITMENT = 0.40;
    const validSplits    = [];
    const _dbg = (typeof process !== 'undefined' && process.env?.GX_DEBUG_COLS)
        ? (m) => console.log(`[cols] ${m}`) : () => {};

    for (const X of rawCandidates) {
        // ── Phase A: whole-band gates (original algorithm, unchanged) ────────
        // A Phase A failure does NOT veto the candidate — it falls through to
        // Phase B, which re-validates everything with per-band partitioning.
        // Baseline-aligned templates dilute Phase A's denominators with shared
        // bands (N19-1423 p10 commitment 0.39 vs the 0.40 threshold).
        const leftOnly  = bands.filter(b => b.items.every(i => (i.vx + (i.vWidth || 0)) <= X - tol));
        const rightOnly = bands.filter(b => b.items.every(i => i.vx >= X + tol));

        const phaseAValid = (() => {
            if (leftOnly.length < MIN_SIDE || rightOnly.length < MIN_SIDE) return false;
            const coexistTop    = Math.max(Math.min(...leftOnly.map(b => b.y)), Math.min(...rightOnly.map(b => b.y)));
            const coexistBottom = Math.min(Math.max(...leftOnly.map(b => b.y)), Math.max(...rightOnly.map(b => b.y)));
            if (coexistBottom < coexistTop) { _dbg(`A@${Math.round(X)} coexist fail`); return false; }
            const localBands = bands.filter(b => b.y >= coexistTop && b.y <= coexistBottom);
            if (!localBands.length || (leftOnly.length + rightOnly.length) / localBands.length < MIN_COMMITMENT) { _dbg(`A@${Math.round(X)} commitment=${((leftOnly.length + rightOnly.length) / (localBands.length || 1)).toFixed(2)} fail`); return false; }

            if (!dropGate3 &&
                leftOnly.every(b => b.y <= persistThresh) &&
                rightOnly.every(b => b.y <= persistThresh)) { _dbg(`A@${Math.round(X)} persistence fail`); return false; }

            const leftMarginX    = Math.min(...bands.flatMap(b => b.items.map(i => i.vx)));
            const leftAnchorTol  = scale.colGapMinPx * 2;
            const leftMinStart   = Math.min(...leftOnly.flatMap(b => b.items.map(i => i.vx)));
            if (leftMinStart > leftMarginX + leftAnchorTol) { _dbg(`A@${Math.round(X)} leftAnchor fail`); return false; }
            return true;
        })();

        if (phaseAValid) {
            validSplits.push(X);
            continue;
        }

        // ── Phase B: baseline-aligned rescue ─────────────────────────────────
        // Templates with identical leading in both columns (ACL/NAACL) put the
        // left and right lines of a row in the SAME Y-band, so the whole-band
        // sets above collapse below MIN_SIDE and a geometrically perfect gutter
        // gets vetoed (N19-1423 pages 2-13). Only when that specific failure
        // occurs, re-evaluate with per-band partitioning under stricter gates.
        const GUTTER_INTEGRITY = 0.80;
        const RIGHT_FLUSH_FRAC = 0.60;
        const MIN_SHARED_ROWS  = 8;

        const leftLines = [], rightLines = [];
        let bothTotal = 0, bothGapOk = 0;
        for (const b of bands) {
            const L = b.items.filter(i => (i.vx + (i.vWidth || 0)) <= X - tol);
            const R = b.items.filter(i => i.vx >= X + tol);
            if (L.length) leftLines.push({ y: b.y, minVx: Math.min(...L.map(i => i.vx)) });
            if (R.length) rightLines.push({
                y: b.y,
                minVx: Math.min(...R.map(i => i.vx)),
                text: R.map(i => i.str || '').join(' '),
            });
            if (L.length && R.length) {
                bothTotal++;
                const gap = Math.min(...R.map(i => i.vx))
                          - Math.max(...L.map(i => i.vx + (i.vWidth || 0)));
                if (gap >= scale.colGapMinPx) bothGapOk++;
            }
        }

        // A real 2-col page shares many rows across the gutter; sparse pages
        // (contact blocks, footers) never reach this count.
        if (bothTotal < MIN_SHARED_ROWS) continue;
        if (leftLines.length < MIN_SIDE || rightLines.length < MIN_SIDE) continue;

        // Gutter integrity: rows with text on both sides must show a real
        // channel at X. Word gaps in running text are far narrower.
        if (bothGapOk / bothTotal < GUTTER_INTEGRITY) continue;

        // The right side must be a flush-left text column, not a ragged
        // right-aligned amount column.
        const rStarts = rightLines.map(l => l.minVx).sort((a, b) => a - b);
        const rMedian = rStarts[Math.floor(rStarts.length / 2)];
        const rFlush  = rStarts.filter(v => Math.abs(v - rMedian) <= scale.colGapMinPx).length;
        if (rFlush / rStarts.length < RIGHT_FLUSH_FRAC) continue;

        // A right side that is mostly digits is a value column, never text.
        const digitHeavyLines = rightLines.filter(l => {
            const d = (l.text.match(/[0-9]/g) || []).length;
            const a = (l.text.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
            return d > a;
        }).length;
        if (digitHeavyLines / rightLines.length > 0.5) continue;

        if (!dropGate3 &&
            leftLines.every(l => l.y <= persistThresh) &&
            rightLines.every(l => l.y <= persistThresh)) continue;

        const leftMarginX    = Math.min(...bands.flatMap(b => b.items.map(i => i.vx)));
        const leftAnchorTol  = scale.colGapMinPx * 2;
        const leftMinStart   = Math.min(...leftLines.map(l => l.minVx));
        if (leftMinStart > leftMarginX + leftAnchorTol) continue;

        validSplits.push(X);
    }

    function _commitRatio(X, allBands, tolerance) {
        const left  = allBands.filter(b => b.items.every(i => (i.vx + (i.vWidth || 0)) <= X - tolerance));
        const right = allBands.filter(b => b.items.every(i => i.vx >= X + tolerance));
        if (!left.length || !right.length) return 0;
        const cTop = Math.max(Math.min(...left.map(b => b.y)),  Math.min(...right.map(b => b.y)));
        const cBot = Math.min(Math.max(...left.map(b => b.y)),  Math.max(...right.map(b => b.y)));
        if (cBot < cTop) return 0;
        const local = allBands.filter(b => b.y >= cTop && b.y <= cBot);
        return local.length ? (left.length + right.length) / local.length : 0;
    }

    const deduplicated = [];
    for (const X of validSplits) {
        const prev = deduplicated.at(-1);
        if (prev !== undefined && X - prev < scale.colGapMinPx) {
            if (_commitRatio(X, bands, tol) > _commitRatio(prev, bands, tol)) {
                deduplicated[deduplicated.length - 1] = X;
            }
        } else {
            deduplicated.push(X);
        }
    }

    return {
        splits: deduplicated.map(sx => ({
            x: sx,
            leftFraction:  sx / vpWidth,
            rightFraction: 1 - (sx / vpWidth),
        })),
        fullWidthIndices,
    };
}

export function splitByColumns(textMeta, splits) {
    if (!splits.length) return [textMeta];

    const boundaries = [-Infinity, ...splits, Infinity];
    const buckets = boundaries.slice(0, -1).map(() => []);

    for (const tm of textMeta) {
        for (let ci = 0; ci < buckets.length; ci++) {
            if (tm.vx >= boundaries[ci] && tm.vx < boundaries[ci + 1]) {
                buckets[ci].push(tm);
                break;
            }
        }
    }

    // Keep empty buckets: the caller uses the bucket's array position as the
    // columnIndex, so filtering empties would shift every later column left.
    return buckets;
}
