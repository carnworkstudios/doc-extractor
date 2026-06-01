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
                assignedTextIndices.add(tm.idx);
            }
        }
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
