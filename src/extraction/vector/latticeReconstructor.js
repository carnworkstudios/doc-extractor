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
    minLines: 3,   // minimum merged lines in each direction to form a grid (raised from 2)
    pageWidthFraction: 0.85, // lines wider than this fraction of viewport are likely decorative
};

export class LatticeReconstructor {
    constructor(segments, opts = {}) {
        this.segments = segments;
        this.eps = opts.eps ?? DEFAULT_OPTS.eps;
        this.minLen = opts.minLen ?? DEFAULT_OPTS.minLen;
        this.minLines = opts.minLines ?? DEFAULT_OPTS.minLines;
        this.pageWidthFraction = opts.pageWidthFraction ?? DEFAULT_OPTS.pageWidthFraction;
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
        for (const cluster of clusters) {
            const lattice = this._reconstructFromSegments(cluster);
            if (lattice) results.push(lattice);
        }
        if (results.length) return results;

        // Fallback: try full set
        const full = this._reconstructFromSegments(this.segments);
        if (full) return [full];

        return [];
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
                // Horizontal — skip full-page-width separators
                if (dx > this._pageWidth * this.pageWidthFraction) continue;

                const xMin = Math.min(s.x1, s.x2);
                const xMax = Math.max(s.x1, s.x2);
                hRaw.push({ y: (s.y1 + s.y2) / 2, xMin, xMax });
            } else if (dx <= eps && dy > eps) {
                // Vertical
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

        } else if (hMerged.length >= minLines && vMerged.length < minLines) {
            // Horizontal slat table
            filteredRows = this._clusterValues(hMerged.map(p => p.y), clusterEps);
            if (filteredRows.length < 2) return null;
            filteredCols = this._inferColsFromText(filteredRows, hMerged);
            if (!filteredCols || filteredCols.length < 2) return null;

        } else if (vMerged.length >= minLines && hMerged.length < minLines) {
            // Vertical slat table
            filteredCols = this._clusterValues(vMerged.map(p => p.x), clusterEps);
            if (filteredCols.length < 2) return null;
            filteredRows = this._inferRowsFromText(filteredCols, vMerged);
            if (!filteredRows || filteredRows.length < 2) return null;
            
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

    _inferColsFromText(rows, hMerged) {
        if (!this.textMeta || !this.textMeta.length) return null;
        
        const yMin = rows[0] - 10;
        const yMax = rows[rows.length - 1] + 10;
        const xMin = Math.min(...hMerged.map(h => h.xMin));
        const xMax = Math.max(...hMerged.map(h => h.xMax));
        
        const items = this.textMeta.filter(tm => 
            tm.vy >= yMin && tm.vy <= yMax && tm.vx >= xMin && tm.vx <= xMax && tm.str.trim()
        );
        
        if (items.length < 2) return null;
        
        const colTol = this.scale ? this.scale.colTolPx : 10;
        
        const sorted = [...items].sort((a, b) => a.vx - b.vx);
        const clusters = [];
        for (const item of sorted) {
            let placed = false;
            for (const cluster of clusters) {
                const meanX = cluster.reduce((s, i) => s + i.vx, 0) / cluster.length;
                if (Math.abs(item.vx - meanX) <= colTol) {
                    cluster.push(item);
                    placed = true;
                    break;
                }
            }
            if (!placed) clusters.push([item]);
        }
        
        if (clusters.length < 2) return null;
        
        clusters.sort((a, b) => a[0].vx - b[0].vx);
        
        const pad = this.scale ? this.scale.S * 0.3 : 4;
        const cols = [Math.max(xMin, clusters[0][0].vx - pad)];
        
        for (let i = 1; i < clusters.length; i++) {
            const maxRight = Math.max(...clusters[i-1].map(tm => tm.vx + (tm.vWidth||0)));
            const minLeft = Math.min(...clusters[i].map(tm => tm.vx));
            const gap = minLeft - maxRight;
            if (gap > 0) {
                cols.push((maxRight + minLeft) / 2);
            } else {
                const mean1 = clusters[i-1].reduce((s, tm) => s + tm.vx, 0) / clusters[i-1].length;
                const mean2 = clusters[i].reduce((s, tm) => s + tm.vx, 0) / clusters[i].length;
                cols.push((mean1 + mean2) / 2);
            }
        }
        
        const lastCluster = clusters[clusters.length - 1];
        const lastMaxRight = Math.max(...lastCluster.map(tm => tm.vx + (tm.vWidth||0)));
        cols.push(Math.min(xMax, lastMaxRight + pad));
        
        return cols;
    }

    _inferRowsFromText(cols, vMerged) {
        if (!this.textMeta || !this.textMeta.length) return null;
        
        const xMin = cols[0] - 10;
        const xMax = cols[cols.length - 1] + 10;
        const yMin = Math.min(...vMerged.map(v => v.yMin));
        const yMax = Math.max(...vMerged.map(v => v.yMax));
        
        const items = this.textMeta.filter(tm => 
            tm.vx >= xMin && tm.vx <= xMax && tm.vy >= yMin && tm.vy <= yMax && tm.str.trim()
        );
        
        if (items.length < 2) return null;
        
        const rowTol = this.scale ? this.scale.yBandTolPx : 5;
        
        const sorted = [...items].sort((a, b) => a.vy - b.vy);
        const clusters = [];
        for (const item of sorted) {
            let placed = false;
            for (const cluster of clusters) {
                const meanY = cluster.reduce((s, i) => s + i.vy, 0) / cluster.length;
                if (Math.abs(item.vy - meanY) <= rowTol) {
                    cluster.push(item);
                    placed = true;
                    break;
                }
            }
            if (!placed) clusters.push([item]);
        }
        
        if (clusters.length < 2) return null;
        
        clusters.sort((a, b) => a[0].vy - b[0].vy);
        
        const pad = this.scale ? this.scale.S * 0.6 : 8;
        const rows = [Math.max(yMin, clusters[0][0].vy - pad)];
        
        for (let i = 1; i < clusters.length; i++) {
            const mean1 = clusters[i-1].reduce((s, tm) => s + tm.vy, 0) / clusters[i-1].length;
            const mean2 = clusters[i].reduce((s, tm) => s + tm.vy, 0) / clusters[i].length;
            rows.push((mean1 + mean2) / 2);
        }
        
        const lastMean = clusters[clusters.length - 1].reduce((s, tm) => s + tm.vy, 0) / clusters[clusters.length - 1].length;
        rows.push(Math.min(yMax, lastMean + pad));
        
        return rows;
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
            const key = Math.round(xc / 5) * 5; // 5px buckets
            xBuckets.set(key, (xBuckets.get(key) || 0) + 1);
        }
        const sortedX = [...xBuckets.keys()].sort((a, b) => a - b);

        const gapThreshold = this.scale ? this.scale.clusterXGap(xRange) : Math.max(40, xRange * 0.08);
        const splitPoints = [];

        for (let i = 1; i < sortedX.length; i++) {
            if (sortedX[i] - sortedX[i - 1] > gapThreshold) {
                splitPoints.push((sortedX[i] + sortedX[i - 1]) / 2);
            }
        }

        if (!splitPoints.length) return [segments];

        const boundaries = [-Infinity, ...splitPoints, Infinity];
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
