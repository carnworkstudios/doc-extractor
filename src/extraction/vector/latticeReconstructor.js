// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
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

            // Horizontal-continuity check: symmetric to the vertical one. A real
            // table's every inter-column band is crossed by at least one
            // horizontal line (the top/bottom border). A column band that no H
            // line crosses is the empty page gutter between two side-by-side
            // structures (e.g. two bordered admonition boxes in a two-column
            // layout whose borders weave into a phantom grid). Split by X and
            // redo each side so the gutter is never a table column.
            const splitX = this._findColDiscontinuity(lattice);
            if (splitX !== null) {
                const left = cluster.filter(s => (s.x1 + s.x2) / 2 < splitX);
                const right = cluster.filter(s => (s.x1 + s.x2) / 2 >= splitX);
                if (left.length >= 6 && right.length >= 6 &&
                    left.length < cluster.length && right.length < cluster.length) {
                    queue.push(left, right);
                    continue;
                }
            }
            results.push(this._extendTrailingUnruledRow(lattice));
        }
        if (results.length) return results;

        // Fallback: try full set
        const full = this._reconstructFromSegments(this.segments);
        if (full) return [this._extendTrailingUnruledRow(full)];

        return [];
    }

    /**
     * Extend a lattice by exactly one trailing unruled row when a single band
     * of text sits immediately below the last detected row line, still inside
     * the table's column span. This covers the common "ruled header, one
     * unruled data row underneath" pattern (e.g. a single-line-item invoice)
     * without attempting general partial-lattice detection: it only ever adds
     * ONE row, and only when that row's items land inside the already-
     * established column boundaries across at least 40% of them. A table
     * missing MULTIPLE consecutive row rulings, or unruled in the middle, is
     * NOT handled here — that needs row-extent-from-text-continuity as a real
     * capability (like the stream detector's Y-banding), not a bounded patch.
     *
     * The new row boundary must be backed by a synthetic hLine/vLine entry,
     * not just a `rows`/`cols` value. tableBuilder's rowspan/colspan inference
     * treats "no line at this boundary" as "these cells are merged" — without
     * a synthetic line here, the header would silently absorb this row into
     * one big rowspan, or this row's own columns would collapse into one
     * colspan. Both defeat the entire point of extending the grid in the
     * first place.
     */
    _extendTrailingUnruledRow(lattice) {
        if (!lattice) return lattice;
        const { rows, cols, hLines, vLines } = lattice;
        if (!rows || rows.length < 2 || !cols || cols.length < 2 || !this.textMeta.length) return lattice;

        const lastRowY = rows[rows.length - 1];
        const rowHeights = [];
        for (let i = 1; i < rows.length; i++) rowHeights.push(rows[i] - rows[i - 1]);
        const medianRowH = [...rowHeights].sort((a, b) => a - b)[Math.floor(rowHeights.length / 2)] || 20;

        const xMin = cols[0] - this.eps * 2;
        const xMax = cols[cols.length - 1] + this.eps * 2;
        // Search window: from just below the last row line to 1.6x the median
        // row height further down — enough room for one real data row, not a
        // whole page of unrelated content below the table.
        const bandTop = lastRowY + this.eps;
        const bandBottom = lastRowY + medianRowH * 1.6;

        const candidates = this.textMeta.filter(tm =>
            tm.str?.trim() &&
            tm.vy > bandTop && tm.vy <= bandBottom &&
            tm.vx >= xMin && tm.vx <= xMax
        );
        if (!candidates.length) return lattice;

        // Require the candidate band to actually spread across most of the
        // table's columns — a single stray caption or footnote word landing
        // in this Y range should not trigger an extension.
        const touchedCols = new Set();
        for (const tm of candidates) {
            for (let c = 0; c + 1 < cols.length; c++) {
                if (tm.vx >= cols[c] - this.eps && tm.vx < cols[c + 1] + this.eps) { touchedCols.add(c); break; }
            }
        }
        if (touchedCols.size < Math.max(2, Math.ceil((cols.length - 1) * 0.4))) return lattice;

        const maxY = Math.max(...candidates.map(tm => tm.vy));
        const newLastRow = maxY + medianRowH * 0.25; // small pad below the text baseline

        const newHLine = { y: newLastRow, xMin: cols[0], xMax: cols[cols.length - 1] };
        const newVLines = cols.map(x => ({ x, yMin: lastRowY, yMax: newLastRow }));

        return {
            ...lattice,
            rows: [...rows, newLastRow],
            hLines: [...hLines, newHLine],
            vLines: [...vLines, ...newVLines],
            bbox: { ...lattice.bbox, h: newLastRow - rows[0] },
        };
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

    // Returns the X midpoint of the first inter-column band not spanned by any
    // merged horizontal line, or null if the grid is horizontally continuous.
    // Page-frame vertical rules and near-full-width H lines are excluded so a
    // legitimate wide table (whose top/bottom border crosses every column) is
    // never split. Only an OUTLIER column gap that no H line bridges — the empty
    // page gutter between two side-by-side bordered structures — triggers a split.
    _findColDiscontinuity(lattice) {
        const { cols, hLines } = lattice;
        if (!cols || cols.length < 3 || !hLines?.length) return null;
        const eps = lattice.clusterEps ?? this.eps * 3;
        // Keep only H lines wide enough to be a real table border, not tiny
        // cell rules. A genuine table's top/bottom border crosses every interior
        // column band; two side-by-side boxes have borders that each stop at the
        // gutter, leaving the gutter band uncrossed. Unlike the row check, gutter
        // width is NOT a reliable signal (the gutter is often the narrowest gap),
        // so we test every interior band for an uncrossed span directly.
        const structural = this._pageWidth > 0
            ? hLines.filter(h => (h.xMax - h.xMin) < this._pageWidth * 0.95)
            : hLines;
        if (!structural.length) return null;

        // Require at least one H line on EACH side of a candidate gutter, so we
        // only split when there really are two bordered structures (not a single
        // table with a wide unruled column).
        for (let i = 0; i + 1 < cols.length; i++) {
            const x0 = cols[i], x1 = cols[i + 1];
            const spanned = structural.some(h => h.xMin <= x0 + eps && h.xMax >= x1 - eps);
            if (spanned) continue;
            const leftBounded  = structural.some(h => Math.abs(h.xMax - x0) <= eps * 2);
            const rightBounded = structural.some(h => Math.abs(h.xMin - x1) <= eps * 2);
            if (leftBounded && rightBounded) return (x0 + x1) / 2;
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

            filteredRows = this._filterGridLines(rows, cols, intersections, 'y', 'x', clusterEps, hMerged, [cols[0], cols[cols.length - 1]]);
            filteredCols = this._filterGridLines(cols, rows, intersections, 'x', 'y', clusterEps, vMerged, [rows[0], rows[rows.length - 1]]);

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
     *
     * Exception: a line whose ORIGINAL merged segment spans nearly the full
     * table width (for a row line) or height (for a column line) is kept
     * regardless of intersection count. A full-width banner row above a table
     * whose body has many columns — e.g. a single-cell section header row
     * sitting over a 7-column detail grid — only touches the two outermost
     * verticals, so it can never clear a density threshold sized for a row
     * that shares the same column count as the rest of the table. That is a
     * real structural border, not sparse noise; the 30% rule was tuned for
     * uniform-column tables and doesn't generalize to a row/column count that
     * legitimately changes partway through one table.
     */
    _filterGridLines(lines, perpLines, intersections, lineAxis, perpAxis, eps, fullSpanLines = null, fullSpanRange = null) {
        const rangeSpan = fullSpanRange ? fullSpanRange[1] - fullSpanRange[0] : 0;
        return lines.filter(lineVal => {
            const hits = intersections.filter(p => Math.abs(p[lineAxis] - lineVal) <= eps);
            const uniquePerps = new Set(hits.map(p => {
                // Find which perp line this hit belongs to
                return perpLines.findIndex(pl => Math.abs(pl - p[perpAxis]) <= eps);
            }));
            if (uniquePerps.size >= Math.max(2, perpLines.length * 0.3)) return true;

            if (fullSpanLines && rangeSpan > 0) {
                const match = fullSpanLines.find(l => Math.abs(l[lineAxis] - lineVal) <= eps);
                if (match) {
                    const lo = lineAxis === 'y' ? match.xMin : match.yMin;
                    const hi = lineAxis === 'y' ? match.xMax : match.yMax;
                    if ((hi - lo) / rangeSpan >= 0.9) return true;
                }
            }
            return false;
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
