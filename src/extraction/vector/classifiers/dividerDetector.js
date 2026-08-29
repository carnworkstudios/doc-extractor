// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 carnworkstudios
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

    // Page-margin threshold: skip segments within ~1.5 lines of text from the
    // top or bottom edge. Genuine section dividers appear between content blocks,
    // never at the absolute page edge. Segments at y≈0 are typically page-frame
    // lines (header rules, form field borders, background-rect edges), not
    // meaningful content separators.
    const marginPx = scale ? scale.S * 1.5 : 15;

    // Build a quick lookup: for each region, the set of hSeg midpoints that fall
    // within its bbox (with a generous pad). This catches segments that "belong"
    // to a table/box but whose midpoint is just outside the bbox due to sub-px
    // coordinate differences between the grid reconstruction and raw paths.
    const consumedSegIds = new Set();
    for (const s of hSegs) {
        if (underlineSegIds.has(s.id)) continue;
        const midY = (s.y1 + s.y2) / 2;
        const xMin = Math.min(s.x1, s.x2);
        const xMax = Math.max(s.x1, s.x2);
        for (const r of regions) {
            if (!r.bbox) continue;
            // Check if segment overlaps region in both axes:
            //   - Y: falls within region's vertical range (±3px tolerance)
            //   - X: segment's X span intersects region's X span
            if (midY >= r.bbox.y - 3 && midY <= r.bbox.y + r.bbox.h + 3 &&
                xMin < r.bbox.x + r.bbox.w + 3 &&
                xMax > r.bbox.x - 3) {
                consumedSegIds.add(s.id);
                break;
            }
        }
    }

    for (const s of hSegs) {
        if (underlineSegIds.has(s.id)) continue;
        // Skip segments consumed by another classifier (part of a table/box frame)
        if (consumedSegIds.has(s.id)) continue;

        const segLen = Math.abs(s.x2 - s.x1);
        if (segLen < dividerMinLen) continue;
        const midX = (s.x1 + s.x2) / 2;
        const midY = (s.y1 + s.y2) / 2;

        // Skip page-margin segments — these are page-frame artifacts, not content dividers
        if (midY < marginPx) continue;
        if (midY > viewport.height - marginPx) continue;

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
