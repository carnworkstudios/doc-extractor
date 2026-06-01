// dividerDetector.js
// Detects standalone horizontal rules (DIVIDER regions) from H-segments
// that are not underlines, not inside any known region, with no nearby text.
// Extracted from contextClassifier.js lines 484-511.

import { RegionType } from './regionTypes.js';

function insideBBox(px, py, bbox, pad = 0) {
    return px >= bbox.x - pad && px <= bbox.x + bbox.w + pad &&
        py >= bbox.y - pad && py <= bbox.y + bbox.h + pad;
}

export function detectDividers(hSegs, underlineSegIds, textMeta, scale, viewport, regions) {
    const dividerMinLen = viewport.width * 0.15;
    const dividers = [];

    for (const s of hSegs) {
        if (underlineSegIds.has(s.id)) continue;
        const segLen = Math.abs(s.x2 - s.x1);
        if (segLen < dividerMinLen) continue;
        const midX = (s.x1 + s.x2) / 2;
        const midY = (s.y1 + s.y2) / 2;
        if (regions.some(r => r.bbox && insideBBox(midX, midY, r.bbox, 5))) continue;
        const nearText = textMeta.some(tm =>
            Math.abs(tm.vy - midY) < scale.S * 0.8 &&
            tm.vx < Math.max(s.x1, s.x2) + 4 &&
            (tm.vx + tm.vWidth) > Math.min(s.x1, s.x2) - 4
        );
        if (nearText) continue;
        dividers.push({
            type: RegionType.DIVIDER,
            bbox: { x: Math.min(s.x1, s.x2), y: midY - 1, w: segLen, h: 2 },
            yCenter: midY,
            textItemIndices: [],
            columnIndex: -1,
        });
    }

    return dividers;
}
