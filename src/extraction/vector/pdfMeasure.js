// pdfMeasure.js — deterministic text measure hook from pdf.js source data.
//
// Boxwood's resolveLayout needs a Measure function to size text content.
// The defaultMeasure uses a crude char-width estimate; pdfMeasure derives
// per-font average glyph widths from the actual PDF text content, giving
// accurate, deterministic, DOM-free measurement in the worker.
//
// Usage:
//   const measure = createPdfMeasure(textContentItems, fontRegistry);
//   const result = resolveLayout(tree, pageBox, { measure });

export function createPdfMeasure(textItems, fontRegistry) {
    // Build a per-font average glyph width map from actual rendered text
    const fontWidths = new Map();
    for (const item of textItems) {
        if (!item.str || !item.fontName) continue;
        const fn = (item.fontName || '').replace(/^[A-Z]{6}\+/, '');
        const w = item.width || 0;
        const len = item.str.length;
        if (len > 0 && w > 0) {
            const avgCharW = w / len;
            if (!fontWidths.has(fn)) fontWidths.set(fn, []);
            fontWidths.get(fn).push(avgCharW);
        }
    }

    // Compute average char width per font name
    const fontAvgW = new Map();
    for (const [fn, widths] of fontWidths) {
        const sum = widths.reduce((a, b) => a + b, 0);
        fontAvgW.set(fn, sum / widths.length);
    }

    // Global fallback: average across all fonts
    let globalAvgW = 0;
    if (fontAvgW.size > 0) {
        const all = [...fontAvgW.values()];
        globalAvgW = all.reduce((a, b) => a + b, 0) / all.length;
    }
    if (globalAvgW <= 0) globalAvgW = 0.5; // conservative fallback

    const LINE_HEIGHT_RATIO = 1.35;
    const DESCENT_RATIO = 0.2;

    function wrapText(text, maxW, charW, fontSize) {
        if (maxW <= 0 || !text) return { lines: [''], w: 0, h: 0 };
        const scale = fontSize / 14;
        const avgW = charW * scale;
        const words = text.split(/(\s+)/);
        const lines = [];
        let cur = '';
        let curW = 0;
        for (const word of words) {
            const wordW = word.length * avgW;
            if (cur && curW + wordW > maxW) {
                if (cur.trim()) lines.push(cur.trim());
                cur = word;
                curW = wordW;
            } else {
                cur += word;
                curW += wordW;
            }
        }
        if (cur.trim()) lines.push(cur.trim());
        if (lines.length === 0) lines.push('');

        const maxLineW = Math.max(...lines.map(l => l.length * avgW));
        return {
            lines,
            w: Math.min(maxW, maxLineW),
            h: lines.length * fontSize * LINE_HEIGHT_RATIO,
        };
    }

    return function pdfMeasure(text, style, maxW) {
        const fontSize = style.fontSize || 14;
        // Try font-specific average width, then fallback to global
        const fn = (style.fontFamily || '').replace(/^[A-Z]{6}\+/, '');
        let charW = globalAvgW;
        if (fontAvgW.has(fn)) {
            charW = fontAvgW.get(fn);
        } else {
            // Try matching by base family name
            for (const [fname, widths] of fontAvgW) {
                if (fname.includes(fn) || fn.includes(fname)) {
                    charW = widths;
                    break;
                }
            }
        }

        const { lines, w, h } = wrapText(text, maxW, charW, fontSize);
        const ascent = fontSize * (1 - DESCENT_RATIO);
        const descent = fontSize * DESCENT_RATIO;

        return { lines, w, h, ascent, descent };
    };
}
