// underlineDetector.js
// Detects horizontal path segments that align with text baselines → underlines.
// Extracted from contextClassifier.js lines 154-177.

export function detectUnderlines(hSegs, textMeta, scale, opts = {}) {
    const underlineSegIds = new Set();

    for (const h of hSegs) {
        const hY = (h.y1 + h.y2) / 2;
        const hXMin = Math.min(h.x1, h.x2);
        const hXMax = Math.max(h.x1, h.x2);
        const hLen = hXMax - hXMin;

        for (const tm of textMeta) {
            if (!tm.str.trim()) continue;
            const textBottom = tm.vy;
            const textXEnd = tm.vx + tm.vWidth;
            const yDist = hY - textBottom;

            const itemUnderlineTol = opts.underlineTol ?? (tm.vFont * scale.R_UNDERLINE);
            if (yDist >= -1 && yDist <= itemUnderlineTol &&
                tm.vx <= hXMax + 2 && textXEnd >= hXMin - 2 &&
                hLen < tm.vWidth * 1.2) {
                underlineSegIds.add(h.id);
                tm.underlined = true;
                break;
            }
        }
    }

    return underlineSegIds;
}
