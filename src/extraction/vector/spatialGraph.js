// spatialGraph.js
// Coordinate-space content graph for a single PDF page.
//
// All content atoms (text items, path segments, image regions) are placed in
// viewport space. The graph exposes spatial queries — containment, proximity,
// density, alignment — so every classifier (lattice, stream, paragraph) can
// draw on a shared spatial context instead of recomputing spatial relationships
// independently.
//
// Design:
//   Nodes  — text items (vx,vy,vWidth,vFont,str), segments (x1,y1,x2,y2),
//             border boxes (closed rects from H+V segments), image regions
//   Edges  — implicit, returned by query methods (yNeighbors, xNeighbors,
//             containers, alignedWith). No explicit adjacency list is stored;
//             queries run over bucket-indexed atoms at O(k) where k is the
//             local bucket population.
//
// Coordinate system: viewport pixels, origin top-left, same as ctmAdapter.
//
// Safe to run inside a Web Worker.

// ── Grid-bucket spatial index ─────────────────────────────────────────────────

const BUCKET_SIZE = 40; // px per bucket cell

function _bucketKey(x, y) {
    return `${Math.floor(x / BUCKET_SIZE)},${Math.floor(y / BUCKET_SIZE)}`;
}

class SpatialIndex {
    constructor() {
        this._map = new Map();
    }

    insert(item, x, y) {
        const k = _bucketKey(x, y);
        if (!this._map.has(k)) this._map.set(k, []);
        this._map.get(k).push(item);
    }

    // Return all items in buckets overlapping the query rectangle
    query(x, y, w, h) {
        const x0 = Math.floor(x / BUCKET_SIZE);
        const y0 = Math.floor(y / BUCKET_SIZE);
        const x1 = Math.floor((x + w) / BUCKET_SIZE);
        const y1 = Math.floor((y + h) / BUCKET_SIZE);
        const seen = new Set();
        const results = [];
        for (let bx = x0; bx <= x1; bx++) {
            for (let by = y0; by <= y1; by++) {
                const k = `${bx},${by}`;
                const bucket = this._map.get(k);
                if (!bucket) continue;
                for (const item of bucket) {
                    if (!seen.has(item)) { seen.add(item); results.push(item); }
                }
            }
        }
        return results;
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _bboxOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
}

function _bboxContains(outer, px, py) {
    return px >= outer.x && px <= outer.x + outer.w &&
           py >= outer.y && py <= outer.y + outer.h;
}

function _segCenter(s) {
    return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
}

// ── Border-box detection ──────────────────────────────────────────────────────

/**
 * Find closed rectangular regions formed by H and V segments.
 * Returns { x, y, w, h, thick } bboxes.
 * `thick` = true when the enclosing stroke width suggests a caution/warning box.
 */
function _detectBorderBoxes(hSegs, vSegs, eps = 8) {
    const boxes = [];
    for (const h1 of hSegs) {
        for (const h2 of hSegs) {
            if (h2 === h1) continue;
            if (Math.abs(h1.x1 - h2.x1) > eps || Math.abs(h1.x2 - h2.x2) > eps) continue;

            const yTop = Math.min(h1.y1, h2.y1);
            const yBot = Math.max(h1.y1, h2.y1);
            if (yBot - yTop < 4) continue;

            const hasLeft = vSegs.some(v =>
                Math.abs((v.x1 + v.x2) / 2 - h1.x1) <= eps &&
                Math.min(v.y1, v.y2) <= yTop + eps &&
                Math.max(v.y1, v.y2) >= yBot - eps,
            );
            const hasRight = vSegs.some(v =>
                Math.abs((v.x1 + v.x2) / 2 - h1.x2) <= eps &&
                Math.min(v.y1, v.y2) <= yTop + eps &&
                Math.max(v.y1, v.y2) >= yBot - eps,
            );

            if (hasLeft && hasRight) {
                const avgSW = (h1.strokeWidth + h2.strokeWidth) / 2;
                boxes.push({
                    x: h1.x1, y: yTop,
                    w: h1.x2 - h1.x1,
                    h: yBot - yTop,
                    thick: avgSW >= 1.5,   // thick border → caution box / section frame
                });
            }
        }
    }
    return boxes;
}

// ── Public class ──────────────────────────────────────────────────────────────

export class PageGraph {
    /**
     * @param {PathSegment[]}  hSegs     — horizontal segments (post underline-removal)
     * @param {PathSegment[]}  vSegs     — vertical segments
     * @param {TextMetaItem[]} textMeta  — viewport-space text items from contextClassifier
     * @param {object[]}       imageRegions — { x, y, w, h } image bboxes
     * @param {object}         viewport  — PDF.js viewport
     */
    constructor(hSegs, vSegs, textMeta, imageRegions = [], viewport = null) {
        this._hSegs       = hSegs;
        this._vSegs       = vSegs;
        this._textMeta    = textMeta;
        this._imageRegions = imageRegions;
        this._viewport    = viewport;

        this._borderBoxes = null; // lazy

        // Index text items by their center point
        this._textIndex = new SpatialIndex();
        for (const tm of textMeta) {
            this._textIndex.insert(tm, tm.vx + (tm.vWidth || 0) / 2, tm.vy);
        }

        // Index segments by their midpoint
        this._segIndex = new SpatialIndex();
        for (const s of [...hSegs, ...vSegs]) {
            const c = _segCenter(s);
            this._segIndex.insert(s, c.x, c.y);
        }
    }

    /**
     * Convenience factory: classify segments then build the graph.
     * Mirrors contextClassifier's segment classification logic.
     */
    static build(allSegments, textMeta, viewport, imageRegions = [], underlineIds = new Set()) {
        const eps = 4;
        const hSegs = [], vSegs = [];
        for (const s of allSegments) {
            if (underlineIds.has(s.id)) continue;
            const dx = Math.abs(s.x2 - s.x1);
            const dy = Math.abs(s.y2 - s.y1);
            if (dy <= eps && dx > eps) hSegs.push(s);
            else if (dx <= eps && dy > eps) vSegs.push(s);
        }
        return new PageGraph(hSegs, vSegs, textMeta, imageRegions, viewport);
    }

    // ── Structural signals ────────────────────────────────────────────────────

    /** Total H + V segment count (structural signal: pages with few segs are pure text). */
    get structuralSegCount() {
        return this._hSegs.length + this._vSegs.length;
    }

    /**
     * Structural segment density inside a bounding box.
     * Returns segments per 10 000 px². High density → bordered region (table/caution box).
     */
    segmentDensityIn(bbox) {
        const area = bbox.w * bbox.h;
        if (area < 1) return 0;
        const nearby = this._segIndex.query(bbox.x, bbox.y, bbox.w, bbox.h);
        let count = 0;
        for (const s of nearby) {
            const c = _segCenter(s);
            if (_bboxContains(bbox, c.x, c.y)) count++;
        }
        return (count / area) * 10000;
    }

    /**
     * True when the given bbox has enclosing H lines at top + bottom,
     * or V lines at left + right, within eps pixels.
     * Caution boxes and table frames satisfy this; open text regions do not.
     */
    isBorderedRegion(bbox, eps = 10) {
        const hasTop = this._hSegs.some(s =>
            Math.abs((s.y1 + s.y2) / 2 - bbox.y) <= eps &&
            Math.min(s.x1, s.x2) <= bbox.x + bbox.w &&
            Math.max(s.x1, s.x2) >= bbox.x,
        );
        const hasBot = this._hSegs.some(s =>
            Math.abs((s.y1 + s.y2) / 2 - (bbox.y + bbox.h)) <= eps &&
            Math.min(s.x1, s.x2) <= bbox.x + bbox.w &&
            Math.max(s.x1, s.x2) >= bbox.x,
        );
        const hasLeft = this._vSegs.some(s =>
            Math.abs((s.x1 + s.x2) / 2 - bbox.x) <= eps &&
            Math.min(s.y1, s.y2) <= bbox.y + bbox.h &&
            Math.max(s.y1, s.y2) >= bbox.y,
        );
        const hasRight = this._vSegs.some(s =>
            Math.abs((s.x1 + s.x2) / 2 - (bbox.x + bbox.w)) <= eps &&
            Math.min(s.y1, s.y2) <= bbox.y + bbox.h &&
            Math.max(s.y1, s.y2) >= bbox.y,
        );
        return (hasTop && hasBot) || (hasLeft && hasRight);
    }

    /**
     * Detect closed rectangular border boxes — caution boxes, table frames,
     * section sidebars. Cached after first call.
     * Returns { x, y, w, h, thick }[] where thick=true for heavy-border boxes.
     */
    getBorderBoxes(eps = 8) {
        if (!this._borderBoxes) {
            this._borderBoxes = _detectBorderBoxes(this._hSegs, this._vSegs, eps);
        }
        return this._borderBoxes;
    }

    /**
     * Which border box (if any) contains the given point?
     * Returns the box object or null.
     */
    containerBox(vx, vy) {
        for (const box of this.getBorderBoxes()) {
            if (_bboxContains(box, vx, vy)) return box;
        }
        return null;
    }

    // ── Region typing ─────────────────────────────────────────────────────────

    /**
     * Classify what kind of region this bbox occupies:
     *   'lattice'      — overlaps a known lattice region
     *   'bordered-box' — enclosed by segment-formed borders (caution box etc.)
     *   'near-table'   — adjacent to a lattice but not inside it
     *   'open-text'    — no structural context; pure text
     *
     * @param {object}   bbox          — { x, y, w, h }
     * @param {object[]} latticeRegions — regions from contextClassifier (TABLE type)
     * @returns {string}
     */
    regionType(bbox, latticeRegions = []) {
        for (const r of latticeRegions) {
            if (r.bbox && _bboxOverlap(bbox, r.bbox)) return 'lattice';
        }
        if (this.isBorderedRegion(bbox)) return 'bordered-box';
        const PROXIMITY = 60; // px
        const expanded = { x: bbox.x - PROXIMITY, y: bbox.y - PROXIMITY,
                           w: bbox.w + PROXIMITY * 2, h: bbox.h + PROXIMITY * 2 };
        for (const r of latticeRegions) {
            if (r.bbox && _bboxOverlap(expanded, r.bbox)) return 'near-table';
        }
        return 'open-text';
    }

    // ── Tabular signature ─────────────────────────────────────────────────────

    /**
     * Analyse text items for a tabular vs. flowing-text signature.
     *
     * Three discriminants:
     *   fillRate   — items / (bands × cols). Low fill → sparse layout, possibly prose.
     *   avgLen     — average text item char length. Long items → prose phrases, not cell values.
     *   colBalance — fraction of items in the busiest column. High → one dominant column
     *                (like a TOC's title column), not balanced tabular data.
     *
     * @param {TextMetaItem[]} items       — items in the candidate region
     * @param {object[]}       colAnchors  — { x } objects from _buildCandidate
     * @param {number}         colTol      — X tolerance for column membership (px)
     * @param {object}         thresholds  — override defaults from PageScale
     * @returns {{ isTabular, fillRate, avgLen, colBalance, reason }}
     */
    tabularSignature(items, colAnchors, colTol = 10, thresholds = {}) {
        const minFill    = thresholds.minFill    ?? 0.30;
        const maxAvgLen  = thresholds.maxAvgLen  ?? 20;
        const maxColBal  = thresholds.maxColBal  ?? 0.65;

        if (!items.length || !colAnchors.length) {
            return { isTabular: false, fillRate: 0, avgLen: 0, colBalance: 1, reason: 'empty' };
        }

        // Approximate band count from unique Y positions
        const uniqueYs  = new Set(items.map(i => Math.round(i.vy)));
        const bandCount = Math.max(1, uniqueYs.size);
        const fillRate  = items.length / (bandCount * colAnchors.length);

        const avgLen = items.reduce((s, i) => s + (i.str?.trim().length || 0), 0) / items.length;

        // Column balance: fraction of items in the most-loaded column
        const colCounts = colAnchors.map(a =>
            items.filter(i => Math.abs(i.vx - a.x) <= colTol).length,
        );
        const maxCol    = Math.max(...colCounts);
        const colBalance = maxCol / (items.length || 1);

        let reason = 'ok';
        let isTabular = true;
        if (fillRate  < minFill)   { isTabular = false; reason = 'low-fill'; }
        else if (avgLen > maxAvgLen){ isTabular = false; reason = 'long-text'; }
        else if (colBalance > maxColBal){ isTabular = false; reason = 'unbalanced-cols'; }

        return { isTabular, fillRate, avgLen, colBalance, reason };
    }

    // ── Proximity queries ─────────────────────────────────────────────────────

    /**
     * Text items whose Y center is within yTol of the given Y position.
     * Sorted left-to-right.
     */
    textInYBand(y, yTol = 8) {
        const candidates = this._textIndex.query(0, y - yTol, 9999, yTol * 2);
        return candidates
            .filter(tm => Math.abs(tm.vy - y) <= yTol)
            .sort((a, b) => a.vx - b.vx);
    }

    /**
     * Text items whose X center is within xTol of the given X (same column).
     * Sorted top-to-bottom.
     */
    textInXColumn(x, xTol = 10) {
        const candidates = this._textIndex.query(x - xTol, 0, xTol * 2, 9999);
        return candidates
            .filter(tm => Math.abs(tm.vx - x) <= xTol)
            .sort((a, b) => a.vy - b.vy);
    }
}
