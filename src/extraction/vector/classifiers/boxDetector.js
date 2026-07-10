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

            // Banner detection: a short box whose text is dominated by a single
            // role keyword in a large font (the black "! WARNING" / "! CAUTION"
            // bar atop a safety admonition). Flagged so it can be merged with the
            // bordered body box directly below and rendered as a styled header.
            const bannerText = boxTextIndices
                .map(i => textMeta[i].str.trim())
                .filter(s => /^[A-Za-z]/.test(s))
                .join(' ')
                .toUpperCase();
            const maxFont = boxTextIndices.reduce((m, i) =>
                Math.max(m, textMeta[i].vFont || 0), 0);
            const isBanner = boxRole !== 'generic'
                && bannerText.length <= 12
                && maxFont >= scale.S * 1.5
                && bbox.h <= scale.S * 5;

            for (const idx of boxTextIndices) assignedTextIndices.add(idx);
            boxRegions.push({
                type: RegionType.BOX,
                bbox,
                yCenter: cy,
                textItemIndices: boxTextIndices,
                columnIndex: -1,
                boxRole,
                fillColor: boxFillColor,
                isBanner,
                bannerText: isBanner ? bannerText : null,
            });
            break;
        }
    }

    _mergeBannersIntoBodies(boxRegions, scale);
    return boxRegions;
}

// Merge each banner box ("! WARNING" bar) into the bordered body box directly
// below it: same X extent, adjacent Y. The merged region keeps the banner's
// role, records bannerText for the styled header, and spans both bboxes. This
// reunites the safety-admonition header with its content so it renders as one
// unit instead of an orphaned bar over a role-less body.
function _mergeBannersIntoBodies(boxRegions, scale) {
    const xTol = scale.S * 1.5;
    const yGapMax = scale.S * 2.5;
    for (let i = boxRegions.length - 1; i >= 0; i--) {
        const banner = boxRegions[i];
        if (!banner.isBanner) continue;
        const bx = banner.bbox, bBottom = bx.y + bx.h;
        // Find the nearest body box directly below, X-aligned.
        let best = null, bestGap = Infinity;
        for (const body of boxRegions) {
            if (body === banner || body.isBanner) continue;
            const cb = body.bbox;
            if (Math.abs(cb.x - bx.x) > xTol) continue;
            if (Math.abs((cb.x + cb.w) - (bx.x + bx.w)) > xTol) continue;
            const gap = cb.y - bBottom;
            if (gap < -scale.S || gap > yGapMax) continue;
            if (gap < bestGap) { bestGap = gap; best = body; }
        }
        if (!best) continue;
        // Merge: body absorbs the banner header.
        best.bannerText = banner.bannerText;
        best.boxRole = banner.boxRole;
        best.isBanner = false;
        best.bbox = {
            x: Math.min(best.bbox.x, bx.x),
            y: Math.min(best.bbox.y, bx.y),
            w: Math.max(best.bbox.x + best.bbox.w, bx.x + bx.w) - Math.min(best.bbox.x, bx.x),
            h: (best.bbox.y + best.bbox.h) - Math.min(best.bbox.y, bx.y),
        };
        best.yCenter = best.bbox.y + best.bbox.h / 2;
        // Do NOT fold the banner's text items into the body: the banner label is
        // rendered from bannerText, not the body flow. Drop the banner region.
        boxRegions.splice(i, 1);
    }
}
