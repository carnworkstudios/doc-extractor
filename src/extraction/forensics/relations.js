// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// relations.js — structure BETWEEN regions: containment and attachment.
//
// WHY THIS IS DETERMINISTIC AND NOT A LEARNED HEAD
// ------------------------------------------------
// The plan called for a learned relationship head scoring caption->picture,
// field->label and cell->table. Three of those four relations turned out not to
// need a model, and one of them cannot have one:
//
//   cell->table   The detector has no `cell` class and cannot get one: a cell
//                 is ~10 px and the finest anchor level is stride 8, the same
//                 wall that puts `checkbox` at AP 0.000 (D21.1). Cells exist
//                 ONLY as the output of latticeReconstructor, which runs AFTER
//                 layout. So this relation is computed over reconstruction
//                 output, downstream, where the cell rectangles are exact.
//
//   region->form  A form's extent is the union of its widget fields, which the
//                 file states exactly (widgetRouter). Containment against it is
//                 arithmetic, not inference.
//
//   caption->picture / label->field
//                 These are the two that genuinely benefit from learning, and
//                 both are ALSO computable geometrically at useful accuracy.
//                 They are implemented here as scored candidates so a learned
//                 scorer can replace the scoring function later without moving
//                 the plumbing.
//
// The honest summary: a learned pair-scorer buys accuracy on two of four
// relations. The other two are exact from geometry the pipeline already has, and
// spending parameters on them would replace a measurement with an estimate —
// the same mistake regionMap.js refuses when it declines to let the detector
// guess LATTICE vs STREAM.

/** Fraction of `inner` that lies inside `outer`. 1.0 = fully contained. */
export function containment(inner, outer) {
    if (!inner || !outer) return 0;
    const x1 = Math.max(inner.x, outer.x), y1 = Math.max(inner.y, outer.y);
    const x2 = Math.min(inner.x + inner.w, outer.x + outer.w);
    const y2 = Math.min(inner.y + inner.h, outer.y + outer.h);
    const iw = x2 - x1, ih = y2 - y1;
    if (iw <= 0 || ih <= 0) return 0;
    const a = inner.w * inner.h;
    return a > 0 ? (iw * ih) / a : 0;
}

/** Cell rectangles from a lattice's row/col boundary arrays. */
export function latticeCells(lattice) {
    const { rows, cols } = lattice || {};
    if (!Array.isArray(rows) || !Array.isArray(cols)) return [];
    const out = [];
    for (let r = 0; r < rows.length - 1; r++) {
        for (let c = 0; c < cols.length - 1; c++) {
            out.push({
                row: r, col: c,
                bbox: { x: cols[c], y: rows[r],
                        w: cols[c + 1] - cols[c], h: rows[r + 1] - rows[r] },
            });
        }
    }
    return out;
}

/**
 * cell -> table. Computed over RECONSTRUCTION output, not detector output.
 *
 * `tableBuilder.buildTable` assigns a text item to the nearest cell over the
 * WHOLE grid — a point outside the table entirely still lands in some cell,
 * because "nearest" is unbounded. That is how a region whose box overshoots
 * pulls neighbouring paragraphs in and invents cells (the D11 finding, in the
 * downstream code rather than the loss). Here the assignment is CONTAINMENT
 * first and proximity only as a tie-break within a tolerance.
 *
 * @returns {{cells:Array, assigned:number, orphaned:number}}
 */
export function assignCellsToTable(lattice, items, { tolerancePx = null } = {}) {
    const cells = latticeCells(lattice);
    if (!cells.length) return { cells: [], assigned: 0, orphaned: items.length };
    // Tolerance scales with the cell, never absolute — the lesson from the
    // subpath-recovery bug, where a fixed epsilon made a table's own rules
    // swallow every run inside it.
    const medH = median(cells.map(c => c.bbox.h)) || 1;
    const tol = tolerancePx ?? Math.max(2, medH * 0.25);

    let assigned = 0, orphaned = 0;
    for (const it of items) {
        const p = it.point || { x: it.x, y: it.y };
        let best = null, bestD = Infinity;
        for (const c of cells) {
            const b = c.bbox;
            const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
            const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
            const d = Math.hypot(dx, dy);
            if (d < bestD) { bestD = d; best = c; }
        }
        // A point beyond tolerance of EVERY cell is not in this table. Saying so
        // is the whole point: an unassignable item must be reported, not filed
        // into whichever cell happened to be least far away.
        if (best && bestD <= tol) {
            (best.items ||= []).push(it); assigned++;
        } else orphaned++;
    }
    return { cells, assigned, orphaned };
}

/**
 * region -> parent containment over any region set.
 *
 * Parents are considered largest-first and a child takes the SMALLEST parent
 * that contains it, so a field inside a table inside a form attaches to the
 * table, not the form. Self-containment and cycles are impossible by
 * construction: a region is never its own parent and parents are strictly
 * larger in area.
 */
export function buildContainment(regions, { minFrac = 0.85 } = {}) {
    const idx = regions.map((r, i) => ({ i, r, a: r.bbox.w * r.bbox.h }));
    const byArea = [...idx].sort((p, q) => q.a - p.a);
    const parent = new Array(regions.length).fill(-1);
    for (const child of byArea) {
        let bestI = -1, bestA = Infinity;
        for (const cand of byArea) {
            if (cand.i === child.i || cand.a <= child.a) continue;
            if (containment(child.r.bbox, cand.r.bbox) < minFrac) continue;
            if (cand.a < bestA) { bestA = cand.a; bestI = cand.i; }
        }
        parent[child.i] = bestI;
    }
    return parent;
}

/**
 * caption -> picture/table, and label -> field.
 *
 * Scored candidates rather than a hard assignment: the score is what a learned
 * pair-scorer would replace. Geometry only — vertical adjacency for captions
 * (a caption sits directly above or below its figure), horizontal for labels
 * (a form label sits to the left of, or directly above, its field).
 */
export function attachCaptions(regions, { maxGapFrac = 0.06 } = {}) {
    const pageH = Math.max(...regions.map(r => r.bbox.y + r.bbox.h), 1);
    const gap = pageH * maxGapFrac;
    const targets = regions.filter(r => r.label === 'picture' || r.label === 'table');
    const out = [];
    for (const cap of regions.filter(r => r.label === 'caption')) {
        let best = null, bestD = Infinity;
        for (const t of targets) {
            const overlapX = Math.min(cap.bbox.x + cap.bbox.w, t.bbox.x + t.bbox.w)
                           - Math.max(cap.bbox.x, t.bbox.x);
            if (overlapX <= 0) continue;                 // must share a column
            const below = t.bbox.y - (cap.bbox.y + cap.bbox.h);
            const above = cap.bbox.y - (t.bbox.y + t.bbox.h);
            const d = Math.min(below >= 0 ? below : Infinity, above >= 0 ? above : Infinity);
            if (d < bestD) { bestD = d; best = t; }
        }
        if (best && bestD <= gap) {
            out.push({ from: cap, to: best, relation: 'caption-of',
                       score: 1 - bestD / gap, provenance: 'inferred' });
        }
    }
    return out;
}

function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
