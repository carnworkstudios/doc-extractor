/**
 * geometry.js
 * Pure math for the PDF annotation layer — no DOM, no dependencies.
 *
 * All annotation coordinates live in page "display space": the PDF page as
 * the user sees it, in PDF points, origin top-left, y down. That is exactly
 * the space of a pdf.js viewport at scale 1, and the space of the annotation
 * SVG viewBox. Export converts display space to PDF user space (y up, bottom-
 * left origin) via viewportToUserSpace, which is the only rotation-aware code
 * in the module (and is unit-tested against pdf.js's own convertToPdfPoint).
 */

export function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
}

export function dist(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Normalize two free points into a {x,y,w,h} rect with w,h >= 0. */
export function rectFromPoints(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** Point-inside-rect test with an optional tolerance (hit padding). */
export function pointInRect(p, r, tol = 0) {
    return p.x >= r.x - tol && p.x <= r.x + r.w + tol
        && p.y >= r.y - tol && p.y <= r.y + r.h + tol;
}

/** True when rect b is fully inside rect a (with a tolerance). */
export function rectContainsRect(a, b, tol = 0) {
    return b.x >= a.x - tol && b.y >= a.y - tol
        && b.x + b.w <= a.x + a.w + tol
        && b.y + b.h <= a.y + a.h + tol;
}

export function expandRect(r, pad) {
    return { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
}

/** 8 selection handles (4 corners + 4 edge midpoints) in reading order. */
export function rectHandles(r) {
    const x0 = r.x, x1 = r.x + r.w, xm = r.x + r.w / 2;
    const y0 = r.y, y1 = r.y + r.h, ym = r.y + r.h / 2;
    return {
        nw: { x: x0, y: y0 }, n: { x: xm, y: y0 }, ne: { x: x1, y: y0 },
        e: { x: x1, y: ym }, se: { x: x1, y: y1 }, s: { x: xm, y: y1 },
        sw: { x: x0, y: y1 }, w: { x: x0, y: ym },
    };
}

const HANDLE_KEYS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Which handle of `r` is within tol of p (resolved nw/e/se/sw first)? null if none. */
export function handleAtPoint(p, r, tol) {
    const handles = rectHandles(r);
    // Corner handles win over edge handles at the same position.
    for (const key of ['nw', 'ne', 'se', 'sw']) {
        if (dist(p, handles[key]) <= tol) return key;
    }
    for (const key of ['n', 'e', 's', 'w']) {
        if (dist(p, handles[key]) <= tol) return key;
    }
    return null;
}

/** Closest point on segment ab to p; returns {t, point, dist}. */
export function closestPointOnSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return { t: 0, point: { x: a.x, y: a.y }, dist: dist(p, a) };
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = clamp(t, 0, 1);
    const point = { x: a.x + t * dx, y: a.y + t * dy };
    return { t, point, dist: dist(p, point) };
}

/** Minimum distance from p to a polyline (the "ink" hit test). */
export function distToPolyline(p, points) {
    let best = Infinity;
    for (let i = 1; i < points.length; i++) {
        const d = closestPointOnSegment(p, points[i - 1], points[i]).dist;
        if (d < best) best = d;
    }
    return best;
}

export function polylineLength(points) {
    let len = 0;
    for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
    return len;
}

export function polylineBBox(points) {
    if (!points.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Ramer-Douglas-Peucker polyline simplification. */
export function simplifyPolyline(points, epsilon) {
    if (points.length < 3) return points.slice();
    let maxDist = 0, index = 0;
    const first = points[0], last = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) {
        const d = closestPointOnSegment(points[i], first, last).dist;
        if (d > maxDist) { maxDist = d; index = i; }
    }
    if (maxDist > epsilon) {
        const left = simplifyPolyline(points.slice(0, index + 1), epsilon);
        const right = simplifyPolyline(points.slice(index), epsilon);
        return left.slice(0, -1).concat(right);
    }
    return [first, last];
}

/**
 * Catmull-Rom smoothing. Returns a denser point list that passes through the
 * original points. `tension` in [0,1]; 0 = classic Catmull-Rom (curvy),
 * 1 = chordal (tight). Used for freehand ink on release.
 */
export function smoothPolyline(points, samplesPerSeg = 8, tension = 0.5) {
    if (points.length < 3) return points.slice();
    const out = [points[0]];
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] || points[i];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] || p2;
        for (let s = 1; s <= samplesPerSeg; s++) {
            const t = s / samplesPerSeg;
            const t2 = t * t, t3 = t2 * t;
            const cx = tension * (p2.x - p0.x) * 0.5;
            const cy = tension * (p2.y - p0.y) * 0.5;
            const cx2 = tension * (p3.x - p1.x) * 0.5;
            const cy2 = tension * (p3.y - p1.y) * 0.5;
            out.push({
                x: 0.5 * (2 * p1.x + t * (p2.x - p1.x) + t2 * (cx + cx2)
                        + t3 * (p2.x - p1.x - cx - cx2)),
                y: 0.5 * (2 * p1.y + t * (p2.y - p1.y) + t2 * (cy + cy2)
                        + t3 * (p2.y - p1.y - cy - cy2)),
            });
        }
    }
    out.push(points[points.length - 1]);
    return out;
}

/**
 * Arrow head triangle for a line from `from` to `to`.
 * Returns the two points behind `to` that form the head with `to` as the tip.
 */
export function arrowHeadPoints(from, to, headLen = 10, headAngle = Math.PI / 6) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const a1 = angle + Math.PI - headAngle;
    const a2 = angle + Math.PI + headAngle;
    return [
        { x: to.x + headLen * Math.cos(a1), y: to.y + headLen * Math.sin(a1) },
        { x: to.x + headLen * Math.cos(a2), y: to.y + headLen * Math.sin(a2) },
    ];
}

/**
 * Map a display-space point (top-left origin, y down — the SVG viewBox space)
 * to PDF user space (bottom-left origin, y up) for a page of the given media
 * box (unrotated MediaBox dims). Handles /Rotate: rotation 0/90/180/270
 * clockwise per the PDF spec. Verified against pdf.js's own
 * Viewport.convertToPdfPoint for all four rotations (test-out harness).
 */
export function viewportToUserSpace(p, rotation, mediaW, mediaH) {
    const r = ((rotation % 360) + 360) % 360;
    switch (r) {
        case 0:
            return { x: p.x, y: mediaH - p.y };
        case 90:
            return { x: p.y, y: p.x };
        case 180:
            return { x: mediaW - p.x, y: p.y };
        case 270:
            return { x: mediaW - p.y, y: mediaH - p.x };
        default:
            return { x: p.x, y: mediaH - p.y };
    }
}
