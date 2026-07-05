// latticeReconstructor.js
// Takes raw PathSegment[] from ctmAdapter and reconstructs table cell grids.
//
// Pipeline:
//   1. Filter to axis-aligned segments (horizontal / vertical only)
//   2. Filter out full-page-width separator lines (decorative, not table borders)
//   3. Merge collinear fragments (same axis band, overlapping range)
//   4. Find intersections between horizontal and vertical lines
//   5. Cluster intersection coordinates into discrete row Y values and column X values
//   6. Validate grid quality (intersection density, minimum grid size)
//   7. Return { rows, cols, hLines, vLines } or null if no grid detected
//
// hLines and vLines are the merged line sets retained so tableBuilder can
// check whether an interior boundary between two cells actually exists —
// enabling correct colspan/rowspan inference for merged cells.
//
// Multi-table support: when the full segment set fails to form a grid,
// reconstructAll() tries spatial clustering to find disjoint tables.

const DEFAULT_OPTS = {
    eps: 4,        // px tolerance for axis-aligned test and clustering
    minLen: 12,    // minimum segment length to consider
    minLines: 3,   // minimum merged lines in each direction to form a grid
};

export class LatticeReconstructor {
    constructor(segments, opts = {}) {
        this.segments = segments;
        this.eps = opts.eps ?? DEFAULT_OPTS.eps;
        this.minLen = opts.minLen ?? DEFAULT_OPTS.minLen;
        this.minLines = opts.minLines ?? DEFAULT_OPTS.minLines;
        this.pageHeight = opts.pageHeight ?? 0; // viewport height; filters multi-page V lines
        this.scale = opts.scale;
        this.textMeta = opts.textMeta || [];

        // Estimate page width from segment extents
        if (segments.length) {
            let minX = Infinity, maxX = -Infinity;
            for (const s of segments) {
                if (s.x1 < minX) minX = s.x1;
                if (s.x2 < minX) minX = s.x2;
                if (s.x1 > maxX) maxX = s.x1;
                if (s.x2 > maxX) maxX = s.x2;
            }
            this._pageWidth = maxX - minX;
        } else {
            this._pageWidth = 1000;
        }
    }

    /**
     * Attempt to reconstruct a single table lattice from the segment set.
     * @returns {{
     *   rows:   number[],
     *   cols:   number[],
     *   hLines: Array<{y, xMin, xMax}>,
     *   vLines: Array<{x, yMin, yMax}>,
     * } | null}
     */
    reconstruct() {
        return this._reconstructFromSegments(this.segments);
    }

    /**
     * Reconstruct all spatially disjoint table lattices from the segment set.
     * Useful for pages with multiple separate tables.
     * @returns {Array<{rows, cols, hLines, vLines}>}
     */
    reconstructAll() {
        // First try spatial clustering to find disjoint table regions
        const clusters = this._spatialCluster(this.segments);
        const results = [];
        const queue = [...clusters];
        let guard = 0;
        while (queue.length && guard++ < 40) {
            const cluster = queue.shift();
            const lattice = this._reconstructFromSegments(cluster);
            if (!lattice) continue;

            // Vertical-continuity check: in a real table, every band between two
            // consecutive row lines is spanned by at least one vertical line (the
            // outer border at minimum). A band no V line crosses means the grid is
            // actually two stacked structures (stacked tables, or a table with an
            // unrelated bordered box below) — split the cluster there and redo each
            // half so rows AND columns are recomputed per structure.
            const splitY = this._findRowDiscontinuity(lattice);
            if (splitY !== null) {
                const above = cluster.filter(s => (s.y1 + s.y2) / 2 < splitY);
                const below = cluster.filter(s => (s.y1 + s.y2) / 2 >= splitY);
                if (above.length >= 6 && below.length >= 6 &&
                    above.length < cluster.length && below.length < cluster.length) {
                    queue.push(above, below);
                    continue;
                }
            }
            results.push(lattice);
        }
        if (results.length) return results;

        // Fallback: try full set
        const full = this._reconstructFromSegments(this.segments);
        if (full) return [full];

        return [];
    }

    // Returns the Y midpoint of the first inter-row band not spanned by any
    // merged vertical line, or null if the grid is vertically continuous.
    // Page-frame / crop-mark lines (near-full page height) are excluded: they
    // "span" every band and would mask every real structural break.
    _findRowDiscontinuity(lattice) {
        const { rows, vLines } = lattice;
        if (!rows || rows.length < 3 || !vLines?.length) return null;
        const eps = lattice.clusterEps ?? this.eps * 3;
        const structural = this.pageHeight > 0
            ? vLines.filter(v => (v.yMax - v.yMin) < this.pageHeight * 0.9)
            : vLines;
        if (!structural.length) return null;

        // A break must be an OUTLIER gap, not just an unspanned band: zebra-striped
        // borderless tables have no V line between any two stripe rows, but their
        // row pitch is uniform. Only a band much taller than the table's own median
        // row gap separates two independent structures.
        const gaps = [];
        for (let i = 0; i + 1 < rows.length; i++) gaps.push(rows[i + 1] - rows[i]);
        const sortedGaps = [...gaps].sort((a, b) => a - b);
        const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)] || 0;
        const minBreak = Math.max(medianGap * 2, eps * 2);

        for (let i = 0; i + 1 < rows.length; i++) {
            const y0 = rows[i], y1 = rows[i + 1];
            if (y1 - y0 <= minBreak) continue;
            const spanned = structural.some(v => v.yMin <= y0 + eps && v.yMax >= y1 - eps);
            if (!spanned) return (y0 + y1) / 2;
        }
        return null;
    }

    _reconstructFromSegments(segments) {
        const { eps, minLen, minLines } = this;

        // 1. Classify axis-aligned segments
        const hRaw = [], vRaw = [];
        for (const s of segments) {
            const dx = Math.abs(s.x2 - s.x1);
            const dy = Math.abs(s.y2 - s.y1);
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len < minLen) continue;

            if (dy <= eps && dx > eps) {
                // Horizontal — no width pre-filter. Full-page-width H lines are
                // legitimate row separators in wide financial tables. Spurious
                // grids built from decorative rules are rejected downstream by
                // the density check, _filterGridLines, and the page-frame guard
                // in contextClassifier.
                const xMin = Math.min(s.x1, s.x2);
                const xMax = Math.max(s.x1, s.x2);
                hRaw.push({ y: (s.y1 + s.y2) / 2, xMin, xMax });
            } else if (dx <= eps && dy > eps) {
                // Vertical — only skip lines that physically cannot be table
                // cell borders because they span multiple pages (> 3× viewport
                // height). Everything else is validated downstream.
                if (this.pageHeight > 0 && dy > this.pageHeight * 3) continue;
                const yMin = Math.min(s.y1, s.y2);
                const yMax = Math.max(s.y1, s.y2);
                vRaw.push({ x: (s.x1 + s.x2) / 2, yMin, yMax });
            }
        }

        // 2. Merge collinear fragments
        const hMerged = this._mergeH(hRaw, eps);
        const vMerged = this._mergeV(vRaw, eps);

        if (hMerged.length < minLines && vMerged.length < minLines) return null;

        let filteredRows = [];
        let filteredCols = [];
        const clusterEps = eps * 3;

        if (hMerged.length >= minLines && vMerged.length >= minLines) {
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

            // 4. Cluster into grid lines with adaptive tolerance
            const rows = this._clusterValues(intersections.map(p => p.y), clusterEps);
            const cols = this._clusterValues(intersections.map(p => p.x), clusterEps);

            if (rows.length < 2 || cols.length < 2) return null;

            // 5. Validate grid quality
            const gridCells = (rows.length - 1) * (cols.length - 1);
            if (gridCells < 2) return null;

            filteredRows = this._filterGridLines(rows, cols, intersections, 'y', 'x', clusterEps);
            filteredCols = this._filterGridLines(cols, rows, intersections, 'x', 'y', clusterEps);

            if (filteredRows.length < 2 || filteredCols.length < 2) return null;

            const gridPoints = filteredRows.length * filteredCols.length;
            if (intersections.length / gridPoints < 0.25) return null;

        } else {
            return null;
        }

        return {
            rows: filteredRows,
            cols: filteredCols,
            hLines: hMerged,
            vLines: vMerged,
            // Pass the cluster tolerance downstream so tableBuilder uses the same
            // tolerance for hLinePresent/vLinePresent that was used to build rows/cols.
            clusterEps,
            bbox: {
                x: filteredCols[0],
                y: filteredRows[0],
                w: filteredCols[filteredCols.length - 1] - filteredCols[0],
                h: filteredRows[filteredRows.length - 1] - filteredRows[0],
            },
        };
    }

    /**
     * Filter grid lines to keep only those that participate in enough intersections.
     * A valid grid line should intersect with at least 30% of the perpendicular lines.
     */
    _filterGridLines(lines, perpLines, intersections, lineAxis, perpAxis, eps) {
        return lines.filter(lineVal => {
            const hits = intersections.filter(p => Math.abs(p[lineAxis] - lineVal) <= eps);
            const uniquePerps = new Set(hits.map(p => {
                // Find which perp line this hit belongs to
                return perpLines.findIndex(pl => Math.abs(pl - p[perpAxis]) <= eps);
            }));
            return uniquePerps.size >= Math.max(2, perpLines.length * 0.3);
        });
    }

    // ── Merge horizontal segments that share the same Y band ────────────────

    _mergeH(segs, eps) {
        if (!segs.length) return [];
        const groups = this._groupByKey(segs, s => s.y, eps);
        const merged = [];
        for (const g of groups) {
            const avgY = g.reduce((a, s) => a + s.y, 0) / g.length;
            g.sort((a, b) => a.xMin - b.xMin);
            let cur = null;
            for (const s of g) {
                if (!cur) { cur = { y: avgY, xMin: s.xMin, xMax: s.xMax }; continue; }
                if (s.xMin <= cur.xMax + eps * 2) { cur.xMax = Math.max(cur.xMax, s.xMax); }
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
                if (s.yMin <= cur.yMax + eps * 2) { cur.yMax = Math.max(cur.yMax, s.yMax); }
                else { merged.push(cur); cur = { x: avgX, yMin: s.yMin, yMax: s.yMax }; }
            }
            if (cur) merged.push(cur);
        }
        return merged;
    }

    // ── Group an array of items by a numeric key with tolerance ─────────────

    _groupByKey(items, keyFn, eps) {
        const sorted = [...items].sort((a, b) => keyFn(a) - keyFn(b));
        const groups = [];
        for (const item of sorted) {
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
            const mean = last.reduce((a, b) => a + b, 0) / last.length;
            if (sorted[i] - mean <= eps) {
                last.push(sorted[i]);
            } else {
                clusters.push([sorted[i]]);
            }
        }
        return clusters.map(c => c.reduce((a, b) => a + b, 0) / c.length);
    }

    // ── Spatial clustering for multi-table detection ────────────────────────

    _spatialCluster(segments) {
        if (segments.length < 4) return [];

        // Use iterative min/max to avoid call stack overflow on large arrays
        let yMin = Infinity, yMax = -Infinity;
        for (const s of segments) {
            const yc = (s.y1 + s.y2) / 2;
            if (yc < yMin) yMin = yc;
            if (yc > yMax) yMax = yc;
        }
        const yRange = yMax - yMin;

        if (yRange < 50) return [segments];

        // Find large Y gaps between sorted unique Y centers
        const yBuckets = new Map();
        for (const s of segments) {
            const yc = (s.y1 + s.y2) / 2;
            const key = Math.round(yc / 5) * 5; // 5px buckets
            yBuckets.set(key, (yBuckets.get(key) || 0) + 1);
        }
        const sortedY = [...yBuckets.keys()].sort((a, b) => a - b);

        // Gap must be significant
        const gapThreshold = this.scale ? this.scale.clusterYGap(yRange) : Math.max(40, yRange * 0.10);
        const splitPoints = [];

        for (let i = 1; i < sortedY.length; i++) {
            if (sortedY[i] - sortedY[i - 1] > gapThreshold) {
                splitPoints.push((sortedY[i] + sortedY[i - 1]) / 2);
            }
        }

        if (!splitPoints.length) return [segments];

        const boundaries = [-Infinity, ...splitPoints, Infinity];
        const clusters = [];
        for (let i = 0; i < boundaries.length - 1; i++) {
            const lo = boundaries[i], hi = boundaries[i + 1];
            const cluster = segments.filter(s => {
                const yc = (s.y1 + s.y2) / 2;
                return yc > lo && yc < hi;
            });
            if (cluster.length >= 8) clusters.push(cluster); // need enough segs for a table
        }

        const finalClusters = [];
        for (const cluster of clusters.length ? clusters : [segments]) {
            const xSubs = this._xSplitCluster(cluster);
            finalClusters.push(...xSubs);
        }

        return finalClusters;
    }

    _xSplitCluster(segments) {
        if (segments.length < 4) return [segments];

        let xMin = Infinity, xMax = -Infinity;
        for (const s of segments) {
            const xc = (s.x1 + s.x2) / 2;
            if (xc < xMin) xMin = xc;
            if (xc > xMax) xMax = xc;
        }
        const xRange = xMax - xMin;

        if (xRange < 50) return [segments];

        const xBuckets = new Map();
        for (const s of segments) {
            const xc = (s.x1 + s.x2) / 2;
            const key = Math.round(xc / 5) * 5;
            xBuckets.set(key, (xBuckets.get(key) || 0) + 1);
        }
        const sortedX = [...xBuckets.keys()].sort((a, b) => a - b);

        const gapThreshold = this.scale ? this.scale.clusterXGap(xRange) : Math.max(40, xRange * 0.08);
        const rawSplits = [];
        for (let i = 1; i < sortedX.length; i++) {
            if (sortedX[i] - sortedX[i - 1] > gapThreshold) {
                rawSplits.push((sortedX[i] + sortedX[i - 1]) / 2);
            }
        }

        if (!rawSplits.length) return [segments];

        // Reject splits where ≥3 H segments span across the gap.
        // If multiple row-separator H lines cross a candidate split point, the
        // gap is a column boundary within one table — not a boundary between
        // two separate tables. Only gaps with no spanning H lines are real
        // table-to-table boundaries.
        const eps = this.eps;
        const hSegs = segments.filter(s =>
            Math.abs(s.y2 - s.y1) <= eps * 2 && Math.abs(s.x2 - s.x1) > eps * 2
        );
        const validSplits = rawSplits.filter(sx => {
            const spanning = hSegs.filter(h => {
                const hx1 = Math.min(h.x1, h.x2);
                const hx2 = Math.max(h.x1, h.x2);
                return hx1 < sx && hx2 > sx;
            }).length;
            return spanning < 3;
        });

        if (!validSplits.length) return [segments];

        const boundaries = [-Infinity, ...validSplits, Infinity];
        const clusters = [];
        for (let i = 0; i < boundaries.length - 1; i++) {
            const lo = boundaries[i], hi = boundaries[i + 1];
            const cluster = segments.filter(s => {
                const xc = (s.x1 + s.x2) / 2;
                return xc > lo && xc < hi;
            });
            if (cluster.length >= 8) clusters.push(cluster);
        }

        return clusters.length ? clusters : [segments];
    }
}
