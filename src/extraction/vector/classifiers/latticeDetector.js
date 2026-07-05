// latticeDetector.js
// Detects bordered table regions using LatticeReconstructor.
// Also handles single-column lattice → BOX classification (notes/warnings/cautions).
// Extracted from contextClassifier.js lines 238-324.

import { LatticeReconstructor } from '../latticeReconstructor.js';
import { RegionType } from './regionTypes.js';

function insideBBox(px, py, bbox, pad = 0) {
    return px >= bbox.x - pad && px <= bbox.x + bbox.w + pad &&
        py >= bbox.y - pad && py <= bbox.y + bbox.h + pad;
}

export function detectLatticeTables(tableSegs, textMeta, scale, viewport, filledRects, assignedTextIndices, opts = {}) {
    const reconstructor = new LatticeReconstructor(tableSegs, {
        eps: 5, scale, textMeta, pageHeight: viewport.height,
    });
    const lattices = reconstructor.reconstructAll();
    const regions = [];

    for (const lattice of lattices) {
        if (!lattice?.bbox) continue;

        if ((lattice.cols?.length ?? 0) <= 2) {
            const bbox = lattice.bbox;
            if (!bbox) continue;

            if (bbox.x < viewport.width * 0.04 && bbox.w > viewport.width * 0.65) continue;
            if (bbox.w > viewport.width * 0.88) continue;

            const boxTextIndices = [];
            let maxItemWidth = 0;
            for (const tm of textMeta) {
                if (!tm.str.trim() || assignedTextIndices.has(tm.idx)) continue;
                if (insideBBox(tm.vx, tm.vy, bbox, scale.tablePadPx)) {
                    boxTextIndices.push(tm.idx);
                    if (tm.vWidth > maxItemWidth) maxItemWidth = tm.vWidth;
                }
            }

            if (maxItemWidth < bbox.w * 0.30 || boxTextIndices.length === 0) continue;

            const sortedItems = boxTextIndices
                .map(i => textMeta[i])
                .sort((a, b) => a.vy - b.vy || a.vx - b.vx);
            const sampleText = sortedItems.slice(0, 8).map(tm => tm.str).join(' ').trim().slice(0, 60).toUpperCase();
            let boxRole = 'generic';
            if (/\bWARNING\b|\bDANGER\b|\bCRITICAL\b/.test(sampleText)) boxRole = 'warning';
            else if (/\bCAUTION\b|\bATTENTION\b/.test(sampleText)) boxRole = 'caution';
            else if (/\bNOTE\b|\bINFO\b|\bINFORMATION\b|\bIMPORTANT\b|\bNOTICE\b/.test(sampleText)) boxRole = 'note';
            else if (/\bTIP\b|\bHINT\b|\bEXAMPLE\b/.test(sampleText)) boxRole = 'tip';

            let boxFillColor = null;
            for (const fr of filledRects) {
                const overlaps = fr.x < bbox.x + bbox.w && fr.x + fr.w > bbox.x &&
                                 fr.y < bbox.y + bbox.h && fr.y + fr.h > bbox.y;
                if (overlaps) { boxFillColor = fr.fillColor; break; }
            }

            for (const idx of boxTextIndices) assignedTextIndices.add(idx);
            regions.push({
                type: RegionType.BOX,
                bbox,
                yCenter: bbox.y + bbox.h / 2,
                textItemIndices: boxTextIndices,
                columnIndex: -1,
                boxRole,
                fillColor: boxFillColor,
            });
            continue;
        }

        const bbox = lattice.bbox;
        const tableTextIndices = [];
        for (const tm of textMeta) {
            if (!tm.str.trim()) continue;
            if (assignedTextIndices.has(tm.idx)) continue;
            if (insideBBox(tm.vx, tm.vy, bbox, scale.tablePadPx)) {
                tableTextIndices.push(tm.idx);
            }
        }

        // Occupancy validation: a real table has text in most of its cells.
        // Measured on reference PDFs: real tables 0.58–0.96, spurious grids
        // (title boxes, decorative frames) 0.00–0.33. Sparse grids with text
        // are bordered content boxes; sparse grids without text are dropped.
        const occ = _cellOccupancy(lattice, tableTextIndices, textMeta);
        if (occ < 0.5) {
            if (tableTextIndices.length > 0) {
                for (const idx of tableTextIndices) assignedTextIndices.add(idx);
                regions.push(_asBox(bbox, tableTextIndices, textMeta, filledRects));
            }
            continue;
        }

        for (const idx of tableTextIndices) assignedTextIndices.add(idx);
        regions.push({
            type: RegionType.LATTICE_TABLE,
            bbox,
            yCenter: bbox.y + bbox.h / 2,
            lattice,
            textItemIndices: tableTextIndices,
            columnIndex: -1,
            proximityPx: scale.proximityPx,
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

function _asBox(bbox, boxTextIndices, textMeta, filledRects) {
    const sortedItems = boxTextIndices
        .map(i => textMeta[i])
        .sort((a, b) => a.vy - b.vy || a.vx - b.vx);
    const sampleText = sortedItems.slice(0, 8).map(tm => tm.str).join(' ').trim().slice(0, 60).toUpperCase();
    let boxRole = 'generic';
    if (/\bWARNING\b|\bDANGER\b|\bCRITICAL\b/.test(sampleText)) boxRole = 'warning';
    else if (/\bCAUTION\b|\bATTENTION\b/.test(sampleText)) boxRole = 'caution';
    else if (/\bNOTE\b|\bINFO\b|\bINFORMATION\b|\bIMPORTANT\b|\bNOTICE\b/.test(sampleText)) boxRole = 'note';
    else if (/\bTIP\b|\bHINT\b|\bEXAMPLE\b/.test(sampleText)) boxRole = 'tip';

    let boxFillColor = null;
    for (const fr of filledRects) {
        const overlaps = fr.x < bbox.x + bbox.w && fr.x + fr.w > bbox.x &&
                         fr.y < bbox.y + bbox.h && fr.y + fr.h > bbox.y;
        if (overlaps) { boxFillColor = fr.fillColor; break; }
    }

    return {
        type: RegionType.BOX,
        bbox,
        yCenter: bbox.y + bbox.h / 2,
        textItemIndices: boxTextIndices,
        columnIndex: -1,
        boxRole,
        fillColor: boxFillColor,
    };
}
