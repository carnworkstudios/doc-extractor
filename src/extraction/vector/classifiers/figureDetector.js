// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// figureDetector.js
// Detects vector line-art figures (wiring diagrams, dimensional drawings,
// decorative art) that PDF.js reports as raw path segments, not image XObjects.
//
// Why this exists: LatticeReconstructor sees a wiring diagram's H/V wire runs
// as table borders and reconstructs a bogus grid over the figure. The
// discriminating signal is the diagonal/curve content: real tables are almost
// pure axis-aligned segments (measured stray fraction 0.00–0.03 on reference
// PDFs), while flattened curves and slanted strokes in diagrams produce
// thousands of diagonal micro-segments (stray fraction 0.72–0.99).
//
// Algorithm:
//   1. Mark coarse grid cells containing midpoints of figure strokes
//      (multi-segment subpath, not clean H/V — see _isFigureStroke).
//   2. Connected-component the marked cells (8-connectivity, 1-cell dilation).
//   3. For each component, expand to the extents of ALL segments whose
//      midpoint falls inside, gather stats, and gate:
//        - enough segments to be a drawing, not an icon
//        - meaningful diagonal fraction
//        - low text-area coverage (a bordered text box is not a figure)
//   4. Merge overlapping/adjacent accepted bboxes.
//
// The caller removes all segments inside accepted figure bboxes from the
// table-segment pool and claims the text items inside (figure labels).

import { RegionType } from './regionTypes.js';

const CELL_PX        = 16;   // coarse grid resolution
const MIN_SEGS       = 30;   // minimum segments inside bbox to call it a figure
const MIN_DIM_PX     = 40;   // minimum bbox width AND height
const MIN_DIAG_FRAC  = 0.25; // figure-stroke fraction of segments inside bbox
const MAX_TEXT_COVER = 0.35; // text-area / bbox-area above this → text box, not figure
const MERGE_GAP_PX   = 24;   // merge accepted bboxes closer than this

// Figure evidence = a stroke from a multi-segment subpath (free path, polygon,
// flattened curve) that is neither a clean horizontal nor a clean vertical.
// Measured: financial/table pages emit exclusively RECT and DASH_RUN segments
// (0 matches), while line-art pages emit thousands of these. Requiring the
// multi-seg source excludes single tiny fragments (underline end caps, stripe
// corners) that painted false figures over table number columns.
export function isFigureStroke(s, eps = 4) { return _isFigureStroke(s, eps); }

function _isFigureStroke(s, eps = 4) {
    if (!(s.srcSegCount > 1)) return false;
    const dx = Math.abs(s.x2 - s.x1);
    const dy = Math.abs(s.y2 - s.y1);
    const cleanH = dy <= eps && dx > eps;
    const cleanV = dx <= eps && dy > eps;
    return !cleanH && !cleanV;
}

export function detectVectorFigures(segments, textMeta, viewport, scale, isInsideImage) {
    if (!segments.length) return [];

    const W = Math.max(1, Math.ceil(viewport.width / CELL_PX));
    const H = Math.max(1, Math.ceil(viewport.height / CELL_PX));
    const marked = new Uint8Array(W * H);
    let anyMark = false;

    for (const s of segments) {
        if (!_isFigureStroke(s)) continue;
        const mx = (s.x1 + s.x2) / 2;
        const my = (s.y1 + s.y2) / 2;
        if (isInsideImage && isInsideImage(mx, my)) continue; // raster content already handled
        const cx = Math.min(W - 1, Math.max(0, Math.floor(mx / CELL_PX)));
        const cy = Math.min(H - 1, Math.max(0, Math.floor(my / CELL_PX)));
        marked[cy * W + cx] = 1;
        anyMark = true;
    }
    if (!anyMark) return [];

    // 1-cell dilation so nearly-touching strokes join one component
    const dilated = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (!marked[y * W + x]) continue;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx, ny = y + dy;
                    if (nx >= 0 && nx < W && ny >= 0 && ny < H) dilated[ny * W + nx] = 1;
                }
            }
        }
    }

    // Connected components over dilated cells (iterative flood fill)
    const compId = new Int32Array(W * H).fill(-1);
    const comps = [];
    for (let i = 0; i < W * H; i++) {
        if (!dilated[i] || compId[i] !== -1) continue;
        const id = comps.length;
        const comp = { x0: W, y0: H, x1: 0, y1: 0, cells: 0 };
        const stack = [i];
        compId[i] = id;
        while (stack.length) {
            const c = stack.pop();
            const cy = Math.floor(c / W), cx = c % W;
            comp.cells++;
            if (cx < comp.x0) comp.x0 = cx;
            if (cy < comp.y0) comp.y0 = cy;
            if (cx > comp.x1) comp.x1 = cx;
            if (cy > comp.y1) comp.y1 = cy;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = cx + dx, ny = cy + dy;
                    if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                    const n = ny * W + nx;
                    if (dilated[n] && compId[n] === -1) { compId[n] = id; stack.push(n); }
                }
            }
        }
        comps.push(comp);
    }

    // Evaluate each component against gates
    const accepted = [];
    for (const comp of comps) {
        // Un-dilate the bbox by one cell, then convert to px
        let bx0 = (comp.x0 + 1) * CELL_PX - CELL_PX;
        let by0 = (comp.y0 + 1) * CELL_PX - CELL_PX;
        let bx1 = comp.x1 * CELL_PX + CELL_PX;
        let by1 = comp.y1 * CELL_PX + CELL_PX;

        // Expand to true extents of member segments (midpoint inside cell bbox)
        let segCount = 0, diagCount = 0;
        let ex0 = Infinity, ey0 = Infinity, ex1 = -Infinity, ey1 = -Infinity;
        for (const s of segments) {
            const mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2;
            if (mx < bx0 || mx > bx1 || my < by0 || my > by1) continue;
            segCount++;
            if (_isFigureStroke(s)) diagCount++;
            ex0 = Math.min(ex0, s.x1, s.x2);
            ey0 = Math.min(ey0, s.y1, s.y2);
            ex1 = Math.max(ex1, s.x1, s.x2);
            ey1 = Math.max(ey1, s.y1, s.y2);
        }
        if (segCount < MIN_SEGS) continue;
        if (diagCount / segCount < MIN_DIAG_FRAC) continue;

        const bbox = {
            x: Math.max(0, ex0),
            y: Math.max(0, ey0),
            w: Math.min(viewport.width, ex1) - Math.max(0, ex0),
            h: Math.min(viewport.height, ey1) - Math.max(0, ey0),
        };
        if (bbox.w < MIN_DIM_PX || bbox.h < MIN_DIM_PX) continue;

        // Text coverage gate: a bordered box full of prose is not a figure
        let textArea = 0;
        for (const tm of textMeta) {
            if (!tm.str?.trim()) continue;
            const cx = tm.vx + (tm.vWidth || 0) / 2;
            if (cx >= bbox.x && cx <= bbox.x + bbox.w &&
                tm.vy >= bbox.y && tm.vy <= bbox.y + bbox.h) {
                textArea += (tm.vWidth || 0) * (tm.vFont || scale.S);
            }
        }
        if (textArea / (bbox.w * bbox.h) > MAX_TEXT_COVER) continue;

        accepted.push(bbox);
    }

    // Merge overlapping / near-adjacent figure bboxes
    let merged = accepted;
    let changed = true;
    while (changed) {
        changed = false;
        const out = [];
        for (const b of merged) {
            const hit = out.find(o =>
                b.x <= o.x + o.w + MERGE_GAP_PX && b.x + b.w >= o.x - MERGE_GAP_PX &&
                b.y <= o.y + o.h + MERGE_GAP_PX && b.y + b.h >= o.y - MERGE_GAP_PX
            );
            if (hit) {
                const nx0 = Math.min(hit.x, b.x), ny0 = Math.min(hit.y, b.y);
                const nx1 = Math.max(hit.x + hit.w, b.x + b.w);
                const ny1 = Math.max(hit.y + hit.h, b.y + b.h);
                hit.x = nx0; hit.y = ny0; hit.w = nx1 - nx0; hit.h = ny1 - ny0;
                changed = true;
            } else {
                out.push({ ...b });
            }
        }
        merged = out;
    }

    return merged.map((bbox, i) => ({
        type: RegionType.IMAGE,
        id: `vecfig_${i}`,
        bbox,
        yCenter: bbox.y + bbox.h / 2,
        textItemIndices: [],
        columnIndex: -1,
        vectorFigure: true,
        algorithm: 'vector-figure',
    }));
}
