// headerFooterDetector.js
// Reclassifies regions in the top/bottom margin as HEADER or FOOTER
// based on font size, pattern matching, and background color bands.
// Extracted from contextClassifier.js lines 689-747.

import { RegionType } from './regionTypes.js';

const HDR_FOOTER_RE = /^\d+$|page\s*\d+|\bof\s+\d+\b|©|\bCopyright\b|\bConfidential\b|\bAll Rights Reserved\b/i;

export function detectHeadersFooters(regions, textMeta, viewport, scale, filledRects) {
    const topThreshold    = viewport.height * 0.12;
    const bottomThreshold = viewport.height * 0.88;

    const headerBands = filledRects.filter(fr =>
        fr.w >= viewport.width * 0.80 && fr.y < topThreshold
    );
    const footerBands = filledRects.filter(fr =>
        fr.w >= viewport.width * 0.80 && (fr.y + fr.h) > bottomThreshold
    );

    for (const r of regions) {
        if (r.type === RegionType.LATTICE_TABLE || r.type === RegionType.STREAM_TABLE ||
            r.type === RegionType.TABLE  || r.type === RegionType.BOX    ||
            r.type === RegionType.IMAGE  || r.type === RegionType.DIVIDER) continue;
        if (r.type === RegionType.HEADER || r.type === RegionType.FOOTER) continue;

        const inTop = r.yCenter < topThreshold;
        const inBot = r.yCenter > bottomThreshold;
        if (!inTop && !inBot) continue;

        const regionMeta = (r.textItemIndices || []).map(i => textMeta[i]).filter(Boolean);
        const avgFont = regionMeta.length
            ? regionMeta.reduce((s, tm) => s + tm.vFont, 0) / regionMeta.length
            : scale.S;
        const smallFont = avgFont < scale.S * 0.85;

        const regionText = regionMeta.map(tm => tm.str).join(' ');
        const patternMatch = HDR_FOOTER_RE.test(regionText);

        const nonSpaceLen = regionText.replace(/\s/g, '').length;
        if (nonSpaceLen < 2 && !patternMatch) continue;

        const inColoredBand = inTop
            ? headerBands.some(fr => r.bbox && r.bbox.y >= fr.y && r.bbox.y <= fr.y + fr.h)
            : footerBands.some(fr => r.bbox && (r.bbox.y + r.bbox.h) <= fr.y + fr.h && r.bbox.y >= fr.y);

        if (smallFont || patternMatch || inColoredBand) {
            r.type = inTop ? RegionType.HEADER : RegionType.FOOTER;
            r.columnIndex = -1;
        }
    }

    return regions;
}
