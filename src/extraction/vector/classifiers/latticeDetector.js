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

export function detectLatticeTables(tableSegs, textMeta, scale, viewport, filledRects, assignedTextIndices, opts = {}, boxRegions = []) {
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

        const enclosing = findEnclosingBox(bbox, boxRegions, scale);
        if (enclosing?.relation === 'same') continue;

        // A grid drawn across two already-claimed boxes — two admonitions side
        // by side in a two-column spread reconstruct into one rectangle
        // enclosing both. The boxes are the real regions; the wrapper is an
        // artifact of reading their borders as one lattice.
        const pad = scale.proximityPx ?? 4;
        if (boxRegions.some(b => b.bbox &&
            bboxContains(bbox, b.bbox, pad) &&
            b.bbox.w * b.bbox.h < bbox.w * bbox.h * 0.9)) continue;
        const parentBox = enclosing?.relation === 'nested' ? enclosing.box : null;
        const parentClaimed = parentBox ? new Set(parentBox.textItemIndices) : null;

        // Text inside the bbox. A table nested in a box reclaims the items its
        // parent swallowed; everything else respects existing claims.
        const collect = () => {
            const out = [];
            for (const tm of textMeta) {
                if (!tm.str.trim()) continue;
                if (assignedTextIndices.has(tm.idx) && !parentClaimed?.has(tm.idx)) continue;
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
