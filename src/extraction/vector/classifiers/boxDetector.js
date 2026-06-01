// boxDetector.js
// Detects isolated-rectangle BOX regions (note/warning/caution/tip containers)
// by pairing H and V segments that form closed rectangles.
// Extracted from contextClassifier.js lines 366-482.

import { RegionType } from './regionTypes.js';

function insideBBox(px, py, bbox, pad = 0) {
    return px >= bbox.x - pad && px <= bbox.x + bbox.w + pad &&
        py >= bbox.y - pad && py <= bbox.y + bbox.h + pad;
}

export function detectBoxRegions(hSegs, vSegs, underlineSegIds, textMeta, scale, viewport, regions, filledRects, assignedTextIndices) {
    const eps6 = (scale.proximityPx ?? 6) * 1.5;
    const vpW  = viewport.width;
    const tablePad = scale.tablePadPx;

    const _isPageFrame = (bx, bw) =>
        (bx < vpW * 0.04 && bw > vpW * 0.65) ||
        bw > vpW * 0.88;

    const claimedByRegion = (cx, cy) =>
        regions.some(r => r.bbox && insideBBox(cx, cy, r.bbox, 2));

    const freeH = hSegs.filter(s => !underlineSegIds.has(s.id));
    const freeV = vSegs;

    const boxRegions = [];

    for (let i = 0; i < freeH.length; i++) {
        const th = freeH[i];
        const tY  = (th.y1 + th.y2) / 2;
        const tX1 = Math.min(th.x1, th.x2);
        const tX2 = Math.max(th.x1, th.x2);

        for (let j = i + 1; j < freeH.length; j++) {
            const bh = freeH[j];
            const bY  = (bh.y1 + bh.y2) / 2;
            const bX1 = Math.min(bh.x1, bh.x2);
            const bX2 = Math.max(bh.x1, bh.x2);

            if (Math.abs(tX1 - bX1) > eps6 || Math.abs(tX2 - bX2) > eps6) continue;
            const rectH = Math.abs(bY - tY);
            if (rectH < 20) continue;

            const x1 = (tX1 + bX1) / 2, x2 = (tX2 + bX2) / 2;
            const y1 = Math.min(tY, bY),  y2 = Math.max(tY, bY);
            const cx = (x1 + x2) / 2,     cy = (y1 + y2) / 2;

            if (claimedByRegion(cx, cy)) continue;

            const lV = freeV.find(s =>
                Math.abs((s.x1 + s.x2) / 2 - x1) <= eps6 &&
                Math.min(s.y1, s.y2) <= y1 + eps6 &&
                Math.max(s.y1, s.y2) >= y2 - eps6
            );
            const rV = freeV.find(s =>
                Math.abs((s.x1 + s.x2) / 2 - x2) <= eps6 &&
                Math.min(s.y1, s.y2) <= y1 + eps6 &&
                Math.max(s.y1, s.y2) >= y2 - eps6
            );
            if (!lV || !rV) continue;

            const bbox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };

            if (_isPageFrame(x1, x2 - x1)) continue;

            const boxTextIndices = [];
            let maxItemWidth = 0;
            for (const tm of textMeta) {
                if (!tm.str.trim() || assignedTextIndices.has(tm.idx)) continue;
                if (insideBBox(tm.vx, tm.vy, bbox, tablePad)) {
                    boxTextIndices.push(tm.idx);
                    if (tm.vWidth > maxItemWidth) maxItemWidth = tm.vWidth;
                }
            }
            if (maxItemWidth < bbox.w * 0.25 || boxTextIndices.length === 0) continue;

            const sampleText = boxTextIndices.slice(0, 8)
                .map(i => textMeta[i].str).join(' ').toUpperCase().slice(0, 60);
            let boxRole = 'generic';
            if (/\bWARNING\b|\bDANGER\b|\bCRITICAL\b/.test(sampleText)) boxRole = 'warning';
            else if (/\bCAUTION\b|\bATTENTION\b/.test(sampleText)) boxRole = 'caution';
            else if (/\bNOTE\b|\bINFO\b|\bINFORMATION\b|\bIMPORTANT\b|\bNOTICE\b/.test(sampleText)) boxRole = 'note';
            else if (/\bTIP\b|\bHINT\b|\bEXAMPLE\b/.test(sampleText)) boxRole = 'tip';

            let boxFillColor = null;
            for (const fr of filledRects) {
                if (fr.x < x2 && fr.x + fr.w > x1 && fr.y < y2 && fr.y + fr.h > y1) {
                    boxFillColor = fr.fillColor; break;
                }
            }

            for (const idx of boxTextIndices) assignedTextIndices.add(idx);
            boxRegions.push({
                type: RegionType.BOX,
                bbox,
                yCenter: cy,
                textItemIndices: boxTextIndices,
                columnIndex: -1,
                boxRole,
                fillColor: boxFillColor,
            });
            break;
        }
    }

    return boxRegions;
}
