// =============================================================================
// mathRender.js — the ONE place TeX becomes typeset HTML.
//
// Three surfaces produce display math and all three must agree, or the same
// equation renders differently depending on which one built the page:
//
//   pageAssembler.js   extraction (both the worker and the synthetic path)
//   gxDocToHtml.js     the IR render path (imports, exports, the Doc view)
//   app.js             core.applyRegionLatex, when a human confirms a
//                      correction in TAFNE
//
// ── WHY throwOnError IS ON ───────────────────────────────────────────────────
// KaTeX's default is to render an offending command in red inside otherwise
// normal output. That produces an equation which LOOKS typeset and is wrong in
// a way nothing downstream can detect — no exception, no flag, just a document
// asserting something the source never said. Throwing instead makes the failure
// legible: the caller falls back to the page's own glyphs and marks the block.
//
// ── WHY strict IS OFF ────────────────────────────────────────────────────────
// The TeX handed to this function is usually RECONSTRUCTED from glyph positions
// by mathBuilder, not authored. It routinely contains unicode operators and
// spacing that strict mode warns about and that are not errors.
//
// `renderToString` touches no DOM, so this runs unchanged inside the geometry
// worker.
// =============================================================================

import katex from 'katex';

/**
 * Typeset display math.
 *
 * @param {string} tex
 * @returns {string|null} the KaTeX HTML, or null if the TeX will not render —
 *          never a partial or error-marked rendering. A null is the caller's
 *          signal to show the document's own glyphs instead, which is why it is
 *          a return value rather than a throw: an equation that vanishes
 *          because its reconstruction was malformed is the one outcome worse
 *          than an ugly one.
 */
export function renderMath(tex) {
    const src = String(tex == null ? '' : tex).trim();
    if (!src) return null;
    try {
        return katex.renderToString(src, {
            displayMode: true,
            output: 'html',
            throwOnError: true,
            strict: false,
        });
    } catch (_) {
        return null;
    }
}

/**
 * Which marker a math block carries, given whether it typeset and whether a
 * human has confirmed it.
 *
 *   data-math             a rendering a human approved — an assertion.
 *   data-math-suggested   the extractor's reconstruction, rendered but
 *                         unchecked. The styling marks it and the page's own
 *                         glyphs are kept in `data-math-source`.
 *   data-math-unrendered  the TeX would not typeset; the body is the glyphs.
 *
 * Centralised because three call sites write these attributes and a fourth
 * (htmlToGxDoc) reads them. A block that carried the wrong one would either
 * launder a guess into a fact or hide work someone already did.
 */
export function mathMarker({ confirmed = false, typeset = false } = {}) {
    if (confirmed) return 'data-math=""';
    return typeset ? 'data-math-suggested=""' : 'data-math-unrendered=""';
}
