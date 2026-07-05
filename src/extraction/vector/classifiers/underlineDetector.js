// underlineDetector.js
// Detects horizontal path segments that align with text baselines → underlines.
//
// A segment is an underline when:
//   - it sits just below the baseline of one or more text items (within tol)
//   - its length matches the X-union of those items (a table row-rule extends
//     well beyond the text by cell padding, an underline does not)
//   - the matched items cover most of the segment's length
//
// All matched items are flagged, so a multi-word underlined phrase renders
// every word underlined (the old first-match-and-break version flagged only
// the first item and missed phrases wider than a single item).

export function detectUnderlines(hSegs, textMeta, scale, opts = {}) {
    const underlineSegIds = new Set();

    for (const h of hSegs) {
        const hY = (h.y1 + h.y2) / 2;
        const hXMin = Math.min(h.x1, h.x2);
        const hXMax = Math.max(h.x1, h.x2);
        const hLen = hXMax - hXMin;
        if (hLen < 2) continue;

        const matched = [];
        let coverage = 0;
        for (const tm of textMeta) {
            if (!tm.str.trim()) continue;
            const yDist = hY - tm.vy;
            const itemTol = opts.underlineTol ?? (tm.vFont * scale.R_UNDERLINE);
            if (yDist < -1 || yDist > itemTol) continue;

            const lo = Math.max(hXMin, tm.vx);
            const hi = Math.min(hXMax, tm.vx + tm.vWidth);
            if (hi <= lo) continue;
            matched.push(tm);
            coverage += hi - lo;
        }
        if (!matched.length) continue;

        const unionLo = Math.min(...matched.map(t => t.vx));
        const unionHi = Math.max(...matched.map(t => t.vx + t.vWidth));
        const unionW = unionHi - unionLo;

        if (hLen <= unionW * 1.15 + 4 && coverage >= hLen * 0.6) {
            underlineSegIds.add(h.id);
            for (const tm of matched) tm.underlined = true;
        }
    }

    return underlineSegIds;
}
