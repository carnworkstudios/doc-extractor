// db-postprocess.js
//
// Differentiable-Binarization (DB) detection post-processing, in plain JS.
//
// This is the part of a PP-OCR port that actually costs something. The ONNX
// session is ten lines; turning the model's probability map into rotated text
// boxes is connected components -> convex hull -> minimum-area rectangle ->
// polygon unclip, which upstream does with cv2 + pyclipper. We have neither in
// the browser and opencv.js is an ~8 MB wasm payload that would defeat the
// point of shipping a 5 MB detector, so it is implemented here.
//
// Two simplifications, both exact rather than approximate, because PP-OCR's
// default det_box_type is 'quad' (rectangles, not free polygons):
//
//   * Minimum-area rect comes from rotating calipers over the convex hull, so
//     no contour tracing is needed — the hull of the component's pixels is
//     enough, and it is cheaper than marching squares.
//   * Unclip for a RECTANGLE is a pure outward offset: the Vatti polygon
//     offset that pyclipper computes reduces to growing width and height by
//     2*d about the same centre at the same angle. Exact for this shape; the
//     general clipper is only needed for free polygons we do not emit.
//
// Everything here is deterministic. No model, no network, no randomness.

/**
 * @typedef {{ x: number, y: number }} Pt
 * @typedef {{ cx:number, cy:number, w:number, h:number, angle:number }} RotRect
 */

/**
 * Turn a DB probability map into rotated boxes in ORIGINAL image coordinates.
 *
 * @param {Float32Array} prob      probability map, row-major, length mapW*mapH
 * @param {number} mapW            probability map width  (the RESIZED width)
 * @param {number} mapH            probability map height (the RESIZED height)
 * @param {object} [opts]
 * @param {number} [opts.binaryThreshold=0.3]  pixel is "text" above this
 * @param {number} [opts.boxThreshold=0.6]     drop boxes whose MEAN prob is below this
 * @param {number} [opts.unclipRatio=1.5]      polygon expansion, upstream default
 * @param {number} [opts.minSide=3]            drop boxes thinner than this (resized px)
 * @param {number} [opts.maxCandidates=1000]   guard against a pathological map
 * @param {number} [opts.scaleX=1]             multiply x by this to reach original coords
 * @param {number} [opts.scaleY=1]
 * @returns {Array<{ quad: Pt[], rect: RotRect, score: number }>} boxes, unordered
 */
export function dbPostprocess(prob, mapW, mapH, opts = {}) {
    const {
        binaryThreshold = 0.3,
        boxThreshold = 0.6,
        unclipRatio = 1.5,
        minSide = 3,
        maxCandidates = 1000,
        scaleX = 1,
        scaleY = 1,
    } = opts;

    const components = connectedComponents(prob, mapW, mapH, binaryThreshold, maxCandidates);
    const out = [];

    for (const pts of components) {
        // A component needs 3 points before a hull means anything.
        if (pts.length < 3) continue;

        const hull = convexHull(pts);
        if (hull.length < 3) continue;

        const rect = minAreaRect(hull);
        if (Math.min(rect.w, rect.h) < minSide) continue;

        // Score BEFORE unclipping: the mean probability over the tight box is
        // what upstream thresholds on, and the expanded box deliberately
        // includes background that would drag the mean down.
        const score = meanProbInRect(prob, mapW, mapH, rect);
        if (score < boxThreshold) continue;

        const expanded = unclipRect(rect, unclipRatio);
        if (Math.min(expanded.w, expanded.h) < minSide) continue;

        out.push({
            rect: scaleRect(expanded, scaleX, scaleY),
            quad: rectCorners(scaleRect(expanded, scaleX, scaleY)),
            score,
        });
    }

    return out;
}

// ── Connected components ────────────────────────────────────────────────────
//
// 8-connectivity, iterative flood fill with an explicit stack. Recursion would
// blow the JS stack on a full-width paragraph, which is the common case rather
// than the pathological one.

/**
 * @returns {Array<Pt[]>} one array of member pixels per component
 */
function connectedComponents(prob, w, h, threshold, maxCandidates) {
    const seen = new Uint8Array(w * h);
    /** @type {Array<Pt[]>} */
    const comps = [];
    const stack = new Int32Array(w * h);

    for (let start = 0; start < prob.length; start++) {
        if (seen[start] || prob[start] < threshold) continue;

        let sp = 0;
        stack[sp++] = start;
        seen[start] = 1;
        /** @type {Pt[]} */
        const pts = [];

        while (sp > 0) {
            const idx = stack[--sp];
            const x = idx % w;
            const y = (idx - x) / w;
            pts.push({ x, y });

            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx;
                    if (nx < 0 || nx >= w) continue;
                    const nIdx = ny * w + nx;
                    if (seen[nIdx] || prob[nIdx] < threshold) continue;
                    seen[nIdx] = 1;
                    stack[sp++] = nIdx;
                }
            }
        }

        comps.push(pts);
        // A map yielding this many components is not a page of text; it is a
        // texture. Stop rather than spend a minute proving it.
        if (comps.length >= maxCandidates) break;
    }

    return comps;
}

// ── Convex hull (Andrew's monotone chain) ───────────────────────────────────

/**
 * @param {Pt[]} pts
 * @returns {Pt[]} hull in counter-clockwise order, no repeated endpoint
 */
export function convexHull(pts) {
    const p = pts.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
    if (p.length < 3) return p;

    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

    const lower = [];
    for (const pt of p) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
        lower.push(pt);
    }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) {
        const pt = p[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
        upper.push(pt);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

// ── Minimum-area rectangle (rotating calipers) ──────────────────────────────

/**
 * The minimum-area enclosing rectangle of a convex polygon shares an edge with
 * it, so testing every edge's orientation is exhaustive rather than heuristic.
 *
 * @param {Pt[]} hull convex, counter-clockwise
 * @returns {RotRect} angle in radians
 */
export function minAreaRect(hull) {
    let best = null;

    for (let i = 0; i < hull.length; i++) {
        const a = hull[i];
        const b = hull[(i + 1) % hull.length];
        const ex = b.x - a.x;
        const ey = b.y - a.y;
        const len = Math.hypot(ex, ey);
        if (len < 1e-9) continue;

        // Unit edge vector and its normal — the axes of the candidate box.
        const ux = ex / len;
        const uy = ey / len;
        const vx = -uy;
        const vy = ux;

        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
        for (const p of hull) {
            const pu = p.x * ux + p.y * uy;
            const pv = p.x * vx + p.y * vy;
            if (pu < minU) minU = pu;
            if (pu > maxU) maxU = pu;
            if (pv < minV) minV = pv;
            if (pv > maxV) maxV = pv;
        }

        const w = maxU - minU;
        const h = maxV - minV;
        const area = w * h;
        if (best === null || area < best.area) {
            const midU = (minU + maxU) / 2;
            const midV = (minV + maxV) / 2;
            best = {
                area,
                cx: midU * ux + midV * vx,
                cy: midU * uy + midV * vy,
                w, h,
                angle: Math.atan2(uy, ux),
            };
        }
    }

    if (!best) return { cx: 0, cy: 0, w: 0, h: 0, angle: 0 };
    const { cx, cy, w, h, angle } = best;
    return { cx, cy, w, h, angle };
}

// ── Unclip ──────────────────────────────────────────────────────────────────

/**
 * Upstream: distance = area * unclip_ratio / perimeter, then a Vatti offset.
 * For a rectangle the offset is exact and closed-form — grow both extents by
 * 2*distance about the same centre, angle unchanged.
 */
export function unclipRect(rect, unclipRatio) {
    const area = rect.w * rect.h;
    const perimeter = 2 * (rect.w + rect.h);
    if (perimeter < 1e-9) return rect;
    const d = (area * unclipRatio) / perimeter;
    return { ...rect, w: rect.w + 2 * d, h: rect.h + 2 * d };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Mean probability inside the rect. Walks the rect's axis-aligned bounds and
 * tests membership in the rotated box, which is cheaper than rasterising a
 * polygon and is exact for a rectangle.
 */
function meanProbInRect(prob, w, h, rect) {
    const corners = rectCorners(rect);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of corners) {
        if (c.x < minX) minX = c.x;
        if (c.x > maxX) maxX = c.x;
        if (c.y < minY) minY = c.y;
        if (c.y > maxY) maxY = c.y;
    }
    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(w - 1, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(h - 1, Math.ceil(maxY));
    if (x1 < x0 || y1 < y0) return 0;

    const cos = Math.cos(-rect.angle);
    const sin = Math.sin(-rect.angle);
    const halfW = rect.w / 2;
    const halfH = rect.h / 2;

    let sum = 0;
    let count = 0;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dx = x - rect.cx;
            const dy = y - rect.cy;
            // Rotate the point into the rect's own frame.
            const lx = dx * cos - dy * sin;
            const ly = dx * sin + dy * cos;
            if (Math.abs(lx) > halfW || Math.abs(ly) > halfH) continue;
            sum += prob[y * w + x];
            count++;
        }
    }
    return count === 0 ? 0 : sum / count;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Four corners, counter-clockwise from the rect's local (-w/2, -h/2). */
export function rectCorners(rect) {
    const cos = Math.cos(rect.angle);
    const sin = Math.sin(rect.angle);
    const hw = rect.w / 2;
    const hh = rect.h / 2;
    return [
        [-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh],
    ].map(([lx, ly]) => ({
        x: rect.cx + lx * cos - ly * sin,
        y: rect.cy + lx * sin + ly * cos,
    }));
}

/**
 * Scale a rect from map coordinates back to original-image coordinates.
 *
 * NOTE: this is only correct while scaleX === scaleY, which the detector's
 * aspect-preserving resize guarantees. A non-uniform scale would shear a
 * rotated rect into a parallelogram, which a RotRect cannot represent — so it
 * is asserted rather than silently approximated.
 */
function scaleRect(rect, scaleX, scaleY) {
    if (Math.abs(scaleX - scaleY) > 1e-6) {
        throw new Error(
            'db-postprocess: non-uniform scale would shear rotated boxes. ' +
            'Resize must preserve aspect ratio.'
        );
    }
    return {
        cx: rect.cx * scaleX,
        cy: rect.cy * scaleY,
        w: rect.w * scaleX,
        h: rect.h * scaleY,
        angle: rect.angle,
    };
}
