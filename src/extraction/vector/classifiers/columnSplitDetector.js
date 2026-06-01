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

    if (!rawCandidates.length && structItems.length >= 10) {
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

    if (!rawCandidates.length && structItems.length >= 6) {
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
                }
            }
        }
    }

    if (!rawCandidates.length) return { splits: [], fullWidthIndices };

    const PERSIST_FRAC  = 0.20;
    const contentTop    = Math.min(...bands.map(b => b.y));
    const contentBottom = Math.max(...bands.map(b => b.y));
    const persistThresh = contentTop + (contentBottom - contentTop || 1) * PERSIST_FRAC;

    const MIN_SIDE       = 3;
    const MIN_COMMITMENT = 0.40;
    const validSplits    = [];

    for (const X of rawCandidates) {
        const leftOnly  = bands.filter(b => b.items.every(i => (i.vx + (i.vWidth || 0)) <= X - tol));
        const rightOnly = bands.filter(b => b.items.every(i => i.vx >= X + tol));

        if (leftOnly.length < MIN_SIDE || rightOnly.length < MIN_SIDE) continue;

        const coexistTop    = Math.max(Math.min(...leftOnly.map(b => b.y)), Math.min(...rightOnly.map(b => b.y)));
        const coexistBottom = Math.min(Math.max(...leftOnly.map(b => b.y)), Math.max(...rightOnly.map(b => b.y)));
        if (coexistBottom < coexistTop) continue;
        const localBands = bands.filter(b => b.y >= coexistTop && b.y <= coexistBottom);
        if (!localBands.length || (leftOnly.length + rightOnly.length) / localBands.length < MIN_COMMITMENT) continue;

        if (!dropGate3 &&
            leftOnly.every(b => b.y <= persistThresh) &&
            rightOnly.every(b => b.y <= persistThresh)) continue;

        const leftMarginX    = Math.min(...bands.flatMap(b => b.items.map(i => i.vx)));
        const leftAnchorTol  = scale.colGapMinPx * 2;
        const leftMinStart   = Math.min(...leftOnly.flatMap(b => b.items.map(i => i.vx)));
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

    return buckets.filter(b => b.length > 0);
}
