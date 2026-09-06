// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// boxDetector.js
// Detects isolated-rectangle BOX regions (note/warning/caution/tip containers)
// by pairing H and V segments that form closed rectangles.
// Extracted from contextClassifier.js lines 366-482.

import { RegionType } from './regionTypes.js';
import { analyzeBlock } from './proseGate.js';

function insideBBox(px, py, bbox, pad = 0) {
    return px >= bbox.x - pad && px <= bbox.x + bbox.w + pad &&
        py >= bbox.y - pad && py <= bbox.y + bbox.h + pad;
}

// ── Shared box construction ──────────────────────────────────────────────────
// The lattice detector also emits BOX regions, for rectangles whose interior
// ruling turned out not to be a grid. Both paths build the region here so the
// role vocabulary and fill lookup can never drift apart.

/**
 * Classify an admonition role from the opening words of a box, in reading order.
 * @returns {'warning'|'caution'|'note'|'tip'|'generic'}
 */
export function classifyBoxRole(textIndices, textMeta) {
    const sampleText = textIndices
        .map(i => textMeta[i])
        .filter(Boolean)
        .sort((a, b) => a.vy - b.vy || a.vx - b.vx)
        .slice(0, 8)
        .map(tm => tm.str)
        .join(' ')
        .trim()
        .slice(0, 60)
        .toUpperCase();

    if (/\bWARNING\b|\bDANGER\b|\bCRITICAL\b/.test(sampleText)) return 'warning';
    if (/\bCAUTION\b|\bATTENTION\b/.test(sampleText)) return 'caution';
    if (/\bNOTE\b|\bINFO\b|\bINFORMATION\b|\bIMPORTANT\b|\bNOTICE\b/.test(sampleText)) return 'note';
    if (/\bTIP\b|\bHINT\b|\bEXAMPLE\b/.test(sampleText)) return 'tip';
    return 'generic';
}

/** First filled rect overlapping the bbox — the box's background swatch. */
export function findFillColor(bbox, filledRects) {
    for (const fr of filledRects) {
        const overlaps = fr.x < bbox.x + bbox.w && fr.x + fr.w > bbox.x &&
            fr.y < bbox.y + bbox.h && fr.y + fr.h > bbox.y;
        if (overlaps) return fr.fillColor;
    }
    return null;
}

/** Build a BOX region from a bbox and the text items it encloses. */
export function buildBoxRegion(bbox, textIndices, textMeta, filledRects) {
    return {
        type: RegionType.BOX,
        bbox,
        yCenter: bbox.y + bbox.h / 2,
        textItemIndices: textIndices,
        columnIndex: -1,
        boxRole: classifyBoxRole(textIndices, textMeta),
        fillColor: findFillColor(bbox, filledRects),
        algorithm: 'lattice-box-fallback',
    };
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

            // A container box is an EMPTY rectangle: four edges, nothing ruled
            // inside. A bordered table has the same four edges PLUS interior
            // ruling — and because every pair of its row rules spans the same
            // left/right borders, each pair forms another perfectly valid
            // rectangle. Running this pass first without a structure check
            // shreds a table into one "box" per row pair. Reject interior
            // structure geometrically, before the text is even looked at.
            const interiorV = freeV.some(s => {
                const sx = (s.x1 + s.x2) / 2;
                if (sx <= x1 + eps6 || sx >= x2 - eps6) return false;
                const sTop = Math.min(s.y1, s.y2), sBot = Math.max(s.y1, s.y2);
                return Math.min(sBot, y2) - Math.max(sTop, y1) >= (y2 - y1) * 0.6;
            });
            if (interiorV) continue;

            // Interior horizontal rules spanning the rectangle: row separators.
            // A banner-topped admonition has exactly one (the bar's lower
            // edge), so two or more means a ruled grid. Counted as distinct Y
            // clusters, not raw segments — a filled bar reconciles into several
            // near-coincident edges a few px apart, and counting those would
            // reject every admonition on the page.
            const innerYs = [];
            for (const s of freeH) {
                const y = (s.y1 + s.y2) / 2;
                if (y <= y1 + eps6 || y >= y2 - eps6) continue;
                const a = Math.min(s.x1, s.x2), b = Math.max(s.x1, s.x2);
                if (Math.min(b, x2) - Math.max(a, x1) < (x2 - x1) * 0.8) continue;
                if (!innerYs.some(r => Math.abs(r - y) <= eps6)) innerYs.push(y);
            }
            if (innerYs.length >= 2) continue;

            const boxTextIndices = [];
            for (const tm of textMeta) {
                if (!tm.str.trim() || assignedTextIndices.has(tm.idx)) continue;
                if (insideBBox(tm.vx, tm.vy, bbox, tablePad)) {
                    boxTextIndices.push(tm.idx);
                }
            }
            if (boxTextIndices.length === 0) continue;

            const boxRole = classifyBoxRole(boxTextIndices, textMeta);
            const boxFillColor = findFillColor(bbox, filledRects);

            // Banner detection: a short box whose text is dominated by a single
            // role keyword in a large font (the black "! WARNING" / "! CAUTION"
            // bar atop a safety admonition). Flagged so it can be merged with the
            // bordered body box directly below and rendered as a styled header.
            //
            // The label is read from the largest-font items only. A banner bar
            // is barely taller than its own text, so the tablePad used to
            // collect text reaches past the bar and picks up the tail of the
            // paragraph above it — enough to push the label past the length
            // limit and silently disable the merge.
            const maxFont = boxTextIndices.reduce((m, i) =>
                Math.max(m, textMeta[i].vFont || 0), 0);
            const labelIndices = boxTextIndices.filter(
                i => (textMeta[i].vFont || 0) >= maxFont - 0.5);
            const bannerText = labelIndices
                .map(i => textMeta[i].str.trim())
                .filter(s => /^[A-Za-z]/.test(s))
                .join(' ')
                .toUpperCase();
            // Bar height is measured against the label's OWN font, not the page
            // body size. On a figure-heavy page the mode font is the callout
            // labels rather than the body text, so page S can land at half its
            // true value and a fixed multiple of it rejects every banner on the
            // page. A banner bar is always just slightly taller than the word
            // printed in it, whatever the rest of the page is doing.
            const isBanner = boxRole !== 'generic'
                && bannerText.length <= 12
                && maxFont >= scale.S * 1.5
                && bbox.h <= maxFont * 2.2;

            // A banner claims only its label. Text the pad reached into belongs
            // to the neighbouring paragraph, and the merge below discards the
            // banner region entirely — claiming it here would delete it.
            const claimIndices = isBanner ? labelIndices : boxTextIndices;

            // Content gate. This detector runs BEFORE the lattice detector, so
            // it sees every closed rectangle on the page — including real
            // bordered tables, which are drawn with the same four segments as a
            // notice panel. Claim only on positive evidence of a container:
            //   - a banner bar (the styled "! WARNING" header), or
            //   - a role keyword in the opening text, or
            //   - contents that read as flowing text.
            // A recurring interior column anchor overrides all three: that is a
            // grid, and it belongs to the lattice detector.
            const verdict = analyzeBlock(boxTextIndices, textMeta, bbox, scale);
            const admonition = boxRole !== 'generic';
            if (verdict.anchors > 0) continue;
            if (!admonition && bbox.w > viewport.width * 0.65) continue;
            if (!isBanner && !admonition && !verdict.prose) continue;

            for (const idx of claimIndices) assignedTextIndices.add(idx);
            boxRegions.push({
                type: RegionType.BOX,
                bbox,
                yCenter: cy,
                textItemIndices: claimIndices,
                columnIndex: -1,
                boxRole,
                fillColor: boxFillColor,
                isBanner,
                bannerText: isBanner ? bannerText : null,
                algorithm: 'closed-rectangle-container',
            });
            break;
        }
    }

    _mergeBannersIntoBodies(boxRegions, scale);
    _dedupeOverlapping(boxRegions, assignedTextIndices);
    return boxRegions;
}

// Collapse boxes that cover substantially the same area. Admonition panels are
// routinely drawn with a double rule, an outer and an inner rectangle a few px
// apart; both close into valid boxes, so both get emitted and the text lands in
// whichever one the pad reached first — leaving a near-duplicate holding one
// stray item beside the real region.
//
// Neither "keep the outer" nor "keep the inner" is right: which rectangle wins
// the text depends only on rounding. Keep whichever actually holds the content.
function _dedupeOverlapping(boxRegions, assignedTextIndices) {
    for (let i = boxRegions.length - 1; i >= 0; i--) {
        const a = boxRegions[i];
        for (let j = 0; j < boxRegions.length; j++) {
            if (i === j) continue;
            const b = boxRegions[j];
            const iw = Math.min(a.bbox.x + a.bbox.w, b.bbox.x + b.bbox.w) - Math.max(a.bbox.x, b.bbox.x);
            const ih = Math.min(a.bbox.y + a.bbox.h, b.bbox.y + b.bbox.h) - Math.max(a.bbox.y, b.bbox.y);
            if (iw <= 0 || ih <= 0) continue;
            const smaller = Math.min(a.bbox.w * a.bbox.h, b.bbox.w * b.bbox.h) || 1;
            if ((iw * ih) / smaller < 0.8) continue;

            // Loser is the one holding less text; ties go to the smaller box so
            // a wrapper never survives over the panel it wraps.
            const aLoses = a.textItemIndices.length < b.textItemIndices.length ||
                (a.textItemIndices.length === b.textItemIndices.length &&
                    a.bbox.w * a.bbox.h > b.bbox.w * b.bbox.h);
            if (!aLoses) continue;

            // Hand the stray items to the survivor rather than dropping them.
            for (const idx of a.textItemIndices) {
                if (!b.textItemIndices.includes(idx)) b.textItemIndices.push(idx);
                assignedTextIndices.add(idx);
            }
            boxRegions.splice(i, 1);
            break;
        }
    }
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
