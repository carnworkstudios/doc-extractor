// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 carnworkstudios
// latticeDetector.js
// Detects bordered table regions using LatticeReconstructor.
// Runs AFTER boxDetector: container rectangles (notices, warnings, callout
// panels) are already claimed, so anything reaching here is either a grid or a
// bordered block the box pass declined. A lattice found strictly inside a
// claimed box is a real table nested in that box and reclaims its own text.

import { LatticeReconstructor } from '../latticeReconstructor.js';
import { RegionType } from './regionTypes.js';
import { buildBoxRegion } from './boxDetector.js';

function insideBBox(px, py, bbox, pad = 0) {
    return px >= bbox.x - pad && px <= bbox.x + bbox.w + pad &&
        py >= bbox.y - pad && py <= bbox.y + bbox.h + pad;
}

function bboxContains(outer, inner, pad = 0) {
    return inner.x >= outer.x - pad && inner.y >= outer.y - pad &&
        inner.x + inner.w <= outer.x + outer.w + pad &&
        inner.y + inner.h <= outer.y + outer.h + pad;
}

// Locate the claimed BOX enclosing a lattice, if any.
//   'same'   — the box IS this rectangle; the box pass already won, skip it
//   'nested' — a genuinely smaller table sitting inside the box
function findEnclosingBox(bbox, boxRegions, scale) {
    const pad = scale.proximityPx ?? 4;
    for (const box of boxRegions) {
        if (!box.bbox || !bboxContains(box.bbox, bbox, pad)) continue;
        const boxArea = box.bbox.w * box.bbox.h;
        const area = bbox.w * bbox.h;
        if (!boxArea) continue;
        return { box, relation: area / boxArea > 0.85 ? 'same' : 'nested' };
    }
    return null;
}

function overlapFrac(a, b) {
    const iw = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const ih = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (iw <= 0 || ih <= 0) return 0;
    return (iw * ih) / (a.w * a.h || 1);
}

function fitsSingleCell(regionBBox, lattice, pad = 0) {
    if (!regionBBox || !lattice?.rows || !lattice?.cols) return false;
    for (let r = 0; r + 1 < lattice.rows.length; r++) {
        for (let c = 0; c + 1 < lattice.cols.length; c++) {
            const cell = {
                x: lattice.cols[c], y: lattice.rows[r],
                w: lattice.cols[c + 1] - lattice.cols[c],
                h: lattice.rows[r + 1] - lattice.rows[r],
            };
            if (bboxContains(cell, regionBBox, pad)) return true;
        }
    }
    return false;
}

export function detectLatticeTables(tableSegs, textMeta, scale, viewport, filledRects, assignedTextIndices, opts = {}, boxRegions = [], imageRegions = []) {
    const reconstructor = new LatticeReconstructor(tableSegs, {
        eps: 5, scale, textMeta, pageHeight: viewport.height,
    });
    const lattices = reconstructor.reconstructAll();
    const regions = [];

    for (const lattice of lattices) {
        if (!lattice?.bbox) continue;
        const bbox = lattice.bbox;

        // Container arbitration. boxDetector ran first and already claimed the
        // page's notice/warning panels, so a lattice covering the same
        // rectangle is that panel's border, not a table.
        // Page chrome. The header rule, footer rule and margin rules close into
        // a rectangle the size of the page; with enough interior text bands it
        // clears the occupancy check and swallows the entire page as one table.
        // Nothing that covers the whole sheet is a table.
        if (bbox.w > viewport.width * 0.80 && bbox.h > viewport.height * 0.80) continue;

        // Pictures are containers too. A diagram's leader lines and frame are
        // clean H/V strokes, so whatever the picture pass did not enclose can
        // still reconstruct into a grid sitting on top of the drawing. A table
        // does not overlap a figure; if it does, it is the figure.
        // Two directions, because a drawing can be bigger or smaller than the
        // grid its own rectangles reconstruct into:
        //   - the grid sits on a picture, or
        //   - the grid CONTAINS picture fragments. A box drawing is built from
        //     clean H/V rectangles, which trace a convincing lattice while the
        //     picture pass only catches the diagonals as separate blobs. A real
        //     table does not have figures inside it.
        const cellImages = imageRegions.filter(ir => ir.bbox &&
            bboxContains(bbox, ir.bbox, scale.proximityPx ?? 4) &&
            fitsSingleCell(ir.bbox, lattice, scale.proximityPx ?? 4));
        const cellImageSet = new Set(cellImages);
        if (imageRegions.some(ir => !cellImageSet.has(ir) && ir.bbox && overlapFrac(bbox, ir.bbox) > 0.5)) continue;
        if (imageRegions.some(ir => {
            if (cellImageSet.has(ir)) return false;
            if (!ir.bbox) return false;
            const irArea = ir.bbox.w * ir.bbox.h;
            if (!irArea || irArea < bbox.w * bbox.h * 0.05) return false;
            return overlapFrac(ir.bbox, bbox) > 0.7;
        })) continue;

        const enclosing = findEnclosingBox(bbox, boxRegions, scale);
        if (enclosing?.relation === 'same') continue;

        // Boxes wholly inside a convincing grid may be CELL CONTENT, not rival
        // containers. Keep their claims available to occupancy validation and
        // let the table-interior pass adopt them into the appropriate cell.
        // The old blanket veto here discarded real prose-heavy tables because
        // an individual description cell is itself a perfectly closed prose
        // rectangle and the box detector necessarily runs first.
        const pad = scale.proximityPx ?? 4;
        const containedBoxes = boxRegions.filter(b => b.bbox &&
            bboxContains(bbox, b.bbox, pad) &&
            b.bbox.w * b.bbox.h < bbox.w * bbox.h * 0.9);
        const containedClaims = new Set(containedBoxes.flatMap(b => b.textItemIndices || []));
        const parentBox = enclosing?.relation === 'nested' ? enclosing.box : null;
        const parentClaimed = parentBox ? new Set(parentBox.textItemIndices) : null;

        // Text inside the bbox. A table nested in a box reclaims the items its
        // parent swallowed; everything else respects existing claims.
        const collect = () => {
            const out = [];
            for (const tm of textMeta) {
                if (!tm.str.trim()) continue;
                if (assignedTextIndices.has(tm.idx) &&
                    !parentClaimed?.has(tm.idx) && !containedClaims.has(tm.idx)) continue;
                if (insideBBox(tm.vx, tm.vy, bbox, scale.tablePadPx)) out.push(tm.idx);
            }
            return out;
        };

        const claim = (indices) => {
            for (const idx of indices) assignedTextIndices.add(idx);
            if (parentBox) {
                const taken = new Set(indices);
                parentBox.textItemIndices =
                    parentBox.textItemIndices.filter(i => !taken.has(i));
            }
        };

        // Single-column bordered block: cols holds only the outer edges, so
        // there is no interior column and no grid to build. It is a box.
        if ((lattice.cols?.length ?? 0) <= 2) {
            if (bbox.x < viewport.width * 0.04 && bbox.w > viewport.width * 0.65) continue;
            if (bbox.w > viewport.width * 0.88) continue;

            const boxTextIndices = collect();
            if (!boxTextIndices.length) continue;
            claim(boxTextIndices);
            regions.push(buildBoxRegion(bbox, boxTextIndices, textMeta, filledRects));
            continue;
        }

        const tableTextIndices = collect();

        // Occupancy validation: a real table has text in most of its cells.
        // Measured on reference PDFs: real tables 0.58–0.96, spurious grids
        // (title boxes, decorative frames) 0.00–0.33. Sparse grids with text
        // are bordered content boxes; sparse grids without text are dropped.
        const occ = _cellOccupancy(lattice, tableTextIndices, textMeta);
        if (occ < 0.5) {
            // A page-width sparse pseudo-grid is usually a borderless table
            // whose zebra fills and short total/header rules happened to make
            // intersections. Do not turn it into a BOX and claim all of its
            // text: leaving it unclaimed lets the stream/alignment pass recover
            // the semantic rows and columns. Real prose callouts are narrower
            // and still take the bordered-container fallback below.
            if (bbox.w > viewport.width * 0.80) continue;
            if (tableTextIndices.length > 0) {
                claim(tableTextIndices);
                regions.push(buildBoxRegion(bbox, tableTextIndices, textMeta, filledRects));
            }
            continue;
        }

        claim(tableTextIndices);
        regions.push({
            type: RegionType.LATTICE_TABLE,
            bbox,
            yCenter: bbox.y + bbox.h / 2,
            lattice,
            textItemIndices: tableTextIndices,
            columnIndex: -1,
            proximityPx: scale.proximityPx,
            parentRegionType: parentBox ? RegionType.BOX : null,
            embeddedRegions: [...containedBoxes, ...cellImages],
        });
    }

    return regions;
}

function _cellOccupancy(lattice, textIndices, textMeta) {
    const { rows, cols } = lattice;
    if (!rows || !cols || rows.length < 2 || cols.length < 2) return 0;
    const nCells = (rows.length - 1) * (cols.length - 1);
    if (!nCells) return 0;
    const occupied = new Set();
    for (const ti of textIndices) {
        const tm = textMeta[ti];
        if (!tm) continue;
        let ri = -1, ci = -1;
        for (let r = 0; r + 1 < rows.length; r++) {
            if (tm.vy >= rows[r] - 3 && tm.vy <= rows[r + 1] + 3) { ri = r; break; }
        }
        for (let c = 0; c + 1 < cols.length; c++) {
            if (tm.vx >= cols[c] - 3 && tm.vx < cols[c + 1]) { ci = c; break; }
        }
        if (ri >= 0 && ci >= 0) occupied.add(ri * (cols.length - 1) + ci);
    }
    return occupied.size / nCells;
}
