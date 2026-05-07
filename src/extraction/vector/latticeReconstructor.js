// latticeReconstructor.js
// Takes raw PathSegment[] from ctmAdapter and reconstructs table cell grids.
//
// Pipeline:
//   1. Filter to axis-aligned segments (horizontal / vertical only)
//   2. Merge collinear fragments (same axis band, overlapping range)
//   3. Find intersections between horizontal and vertical lines
//   4. Cluster intersection coordinates into discrete row Y values and column X values
//   5. Return { rows, cols, hLines, vLines } or null if no grid detected
//
// hLines and vLines are the merged line sets retained so tableBuilder can
// check whether an interior boundary between two cells actually exists —
// enabling correct colspan/rowspan inference for merged cells.

const DEFAULT_OPTS = {
    eps: 4,        // px tolerance for axis-aligned test and clustering
    minLen: 15,    // minimum segment length to consider
    minLines: 2,   // minimum merged lines in each direction to form a grid
};

export class LatticeReconstructor {
    constructor(segments, opts = {}) {
        this.segments = segments;
        this.eps = opts.eps ?? DEFAULT_OPTS.eps;
        this.minLen = opts.minLen ?? DEFAULT_OPTS.minLen;
        this.minLines = opts.minLines ?? DEFAULT_OPTS.minLines;
    }

    /**
     * Attempt to reconstruct a table lattice from the segment set.
     * @returns {{
     *   rows:   number[],                            // Y coords of horizontal grid lines
     *   cols:   number[],                            // X coords of vertical grid lines
     *   hLines: Array<{y, xMin, xMax}>,             // merged horizontal lines
     *   vLines: Array<{x, yMin, yMax}>,             // merged vertical lines
     * } | null}
     */
    reconstruct() {
        const { eps, minLen, minLines } = this;

        // 1. Classify axis-aligned segments
        const hRaw = [], vRaw = [];
        for (const s of this.segments) {
            const dx = Math.abs(s.x2 - s.x1);
            const dy = Math.abs(s.y2 - s.y1);
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len < minLen) continue;

            if (dy <= eps && dx > eps) {
                // Horizontal — represent as { y, xMin, xMax }
                hRaw.push({ y: (s.y1 + s.y2) / 2, xMin: s.x1, xMax: s.x2 });
            } else if (dx <= eps && dy > eps) {
                // Vertical — represent as { x, yMin, yMax }
                vRaw.push({ x: (s.x1 + s.x2) / 2, yMin: s.y1, yMax: s.y2 });
            }
        }

        // 2. Merge collinear fragments
        const hMerged = this._mergeH(hRaw, eps);
        const vMerged = this._mergeV(vRaw, eps);

        if (hMerged.length < minLines || vMerged.length < minLines) return null;

        // 3. Find intersections
        const intersections = [];
        for (const h of hMerged) {
            for (const v of vMerged) {
                if (v.x >= h.xMin - eps && v.x <= h.xMax + eps &&
                    h.y >= v.yMin - eps && h.y <= v.yMax + eps) {
                    intersections.push({ x: v.x, y: h.y });
                }
            }
        }

        if (intersections.length < 4) return null;

        // 4. Cluster into grid lines
        const rows = this._clusterValues(intersections.map(p => p.y), eps * 2);
        const cols = this._clusterValues(intersections.map(p => p.x), eps * 2);

        if (rows.length < 2 || cols.length < 2) return null;

        return { rows, cols, hLines: hMerged, vLines: vMerged };
    }

    // ── Merge horizontal segments that share the same Y band ────────────────

    _mergeH(segs, eps) {
        if (!segs.length) return [];
        // Group by Y band
        const groups = this._groupByKey(segs, s => s.y, eps);
        const merged = [];
        for (const g of groups) {
            const avgY = g.reduce((a, s) => a + s.y, 0) / g.length;
            g.sort((a, b) => a.xMin - b.xMin);
            let cur = null;
            for (const s of g) {
                if (!cur) { cur = { y: avgY, xMin: s.xMin, xMax: s.xMax }; continue; }
                if (s.xMin <= cur.xMax + eps) { cur.xMax = Math.max(cur.xMax, s.xMax); }
                else { merged.push(cur); cur = { y: avgY, xMin: s.xMin, xMax: s.xMax }; }
            }
            if (cur) merged.push(cur);
        }
        return merged;
    }

    // ── Merge vertical segments that share the same X band ──────────────────

    _mergeV(segs, eps) {
        if (!segs.length) return [];
        const groups = this._groupByKey(segs, s => s.x, eps);
        const merged = [];
        for (const g of groups) {
            const avgX = g.reduce((a, s) => a + s.x, 0) / g.length;
            g.sort((a, b) => a.yMin - b.yMin);
            let cur = null;
            for (const s of g) {
                if (!cur) { cur = { x: avgX, yMin: s.yMin, yMax: s.yMax }; continue; }
                if (s.yMin <= cur.yMax + eps) { cur.yMax = Math.max(cur.yMax, s.yMax); }
                else { merged.push(cur); cur = { x: avgX, yMin: s.yMin, yMax: s.yMax }; }
            }
            if (cur) merged.push(cur);
        }
        return merged;
    }

    // ── Group an array of items by a numeric key with tolerance ─────────────

    _groupByKey(items, keyFn, eps) {
        const groups = [];
        for (const item of items) {
            const k = keyFn(item);
            const g = groups.find(gr => Math.abs(keyFn(gr[0]) - k) <= eps);
            if (g) g.push(item);
            else groups.push([item]);
        }
        return groups;
    }

    // ── Cluster numeric values with tolerance, return sorted representative ─

    _clusterValues(values, eps) {
        if (!values.length) return [];
        const sorted = [...values].sort((a, b) => a - b);
        const clusters = [[sorted[0]]];
        for (let i = 1; i < sorted.length; i++) {
            const last = clusters[clusters.length - 1];
            if (sorted[i] - last[last.length - 1] <= eps) {
                last.push(sorted[i]);
            } else {
                clusters.push([sorted[i]]);
            }
        }
        return clusters.map(c => c.reduce((a, b) => a + b, 0) / c.length);
    }
}
