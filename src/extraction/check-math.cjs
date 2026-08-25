#!/usr/bin/env node
// ===================================================================================
// check-math — display-math reconstruction must produce renderable LaTeX
// ===================================================================================
// Guard for mathBuilder.js: multi-baseline math lines are converted to LaTeX
// (\frac, \sqrt, \sum\limits, ^{}/_{} scripts) before KaTeX rendering. These
// cases run on deterministic synthetic pdfjs items with realistic geometry —
// fraction rows ~1em apart, scripts small and tight, binop spaces ~0.35em —
// and compare against the expected TeX up to whitespace (TeX collapses math
// spaces, so 'x dx' and 'xdx' are the same rendering).
//
// Run: node src/extraction/check-math.cjs
// ===================================================================================

let pass = 0, fail = 0;
const fails = [];
function ok(got, want, label) {
    const norm = s => (s || '').replace(/\s+/g, '');
    if (norm(got) === norm(want)) pass++;
    else { fail++; fails.push(`${label}\n       got: ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`); }
}
function okTrue(cond, label) {
    if (cond) pass++;
    else { fail++; fails.push(label); }
}

function item(str, x, y, size = 12, opts = {}) {
    return {
        str, fontName: opts.fontName ?? 'ABCDEF+TimesNewRoman',
        transform: [1, 0, 0, size, x, y],
        width: opts.width ?? str.length * size * 0.55,
        italic: opts.italic ?? /^[a-z]$/.test(str),
    };
}
// num/den around a bar at barY, one char per side, ~0.45em off the bar.
function frac(str, x, barY, size = 12) {
    return [item(str[0], x, barY - size * 0.45, size), item(str[2], x, barY + size * 0.45, size)];
}
// A tight left-to-right run with realistic ~0.15em inter-glyph gaps.
function run(str, x0, y, size = 12, gap = 0.15 * size) {
    const out = [];
    let x = x0;
    for (const ch of str) {
        out.push(item(ch, x, y, size));
        x += out[out.length - 1].width + gap;
    }
    return out;
}

// ── Assembly-level harness (mirrors check-list-start) ─────────────────────────

const viewport = { width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] };

function makeMeta(items) {
    return items.map((it, idx) => ({
        str: it.str, fontName: it.fontName, fontSize: 10,
        vx: 50, vy: 100 - idx * 10, vWidth: 200, idx,
    }));
}

function makeRegion(items, type) {
    return {
        type,
        listOrdered: false,
        bbox: { x: 40, y: 70, w: 300, h: 40 },
        yCenter: 90,
        fontSize: 10,
        columnIndex: -1,
        textItemIndices: items.map((_, i) => i),
    };
}

(async () => {
    const { buildDisplayMath } = await import('../extraction/vector/mathBuilder.js');
    const { assemblePage, createFontRegistry } = await import('../extraction/vector/pageAssembler.js');

    ok(buildDisplayMath(frac('1/2', 60, 100)), '\\frac{1}{2}', 'fraction 1/2');
    ok(buildDisplayMath([
        item('\u2211', 60, 100, 16),
        item('n', 52, 112, 8, { italic: true }), item('=', 58, 112, 8), item('1', 64, 112, 8),
        item('\u221e', 52, 88, 8),
    ]), '\\sum\\limits_{n = 1}^{\\infty}', 'sum with limits above/below');
    ok(buildDisplayMath([
        item('\u2211', 60, 100, 14),
        item('n', 52, 112, 8, { italic: true }), item('=', 58, 112, 8), item('1', 64, 112, 8),
        item('\u221e', 52, 88, 8),
        item('1', 86, 94, 12), item('n', 86, 106, 12, { italic: true }),
    ]), '\\sum\\limits_{n = 1}^{\\infty}\\frac{1}{n}', 'infinite series of a fraction');
    ok(buildDisplayMath([item('x', 60, 100, 12, { italic: true }), ...frac('a/b', 72, 100)]),
       'x\\frac{a}{b}', 'operand followed by a fraction (implicit product)');
    ok(buildDisplayMath([item('n', 60, 100, 12, { italic: true }), item('!', 73, 100, 12)]),
       'n!', 'factorial');
    ok(buildDisplayMath([...run('5!', 60, 100), item('=', 92, 100), ...run('120', 108, 100)]),
       '5! = 120', 'factorial value');
    ok(buildDisplayMath([item('\u221a', 60, 100, 16), item('x', 84, 100, 12, { italic: true })]),
       '\\sqrt{x}', 'radical with a letter radicand');
    ok(buildDisplayMath([item('x', 60, 100, 12, { italic: true }), item('2', 72, 89, 8)]),
       'x^2', 'superscript');
    ok(buildDisplayMath([
        item('e', 40, 100, 12, { italic: true }), item('i', 58, 88, 8, { italic: true }),
        item('\u03c0', 66, 88, 8),
        item('+', 88, 100, 12), item('1', 102, 100, 12), item('=', 128, 100, 12), item('0', 142, 100, 12),
    ]), 'e^{i \\pi}+1 = 0', 'Euler identity');
    ok(buildDisplayMath([
        item('(', 60, 100, 12), item('n', 70, 100, 12, { italic: true }), item('-', 82, 100, 12),
        item('1', 92, 100, 12), item(')', 102, 100, 12), item('!', 116, 100, 12),
    ]), '(n-1)!', 'parenthesised factorial');
    ok(buildDisplayMath([
        item('\u222b', 60, 100, 14), item('0', 72, 112, 8), item('1', 72, 88, 8),
        ...run('xdx', 90, 100),
    ]), '\\int\\limits_{0}^{1}xdx', 'definite integral');
    ok(buildDisplayMath([
        item('\u2211', 60, 100, 14), item('n', 84, 100, 12, { italic: true }), item('2', 96, 89, 8),
    ]), '\\sum n^2', 'sum with a trailing square');
    ok(buildDisplayMath([
        item('a', 60, 94, 12, { italic: true }), item('b', 60, 106, 12, { italic: true }),
        item('c', 60, 118, 12, { italic: true }),
    ]), '\\frac{\\frac{a}{b}}{c}', 'nested fractions');
    ok(buildDisplayMath([
        item('h', 40, 100, 12, { italic: true }), item('=', 58, 100, 12),
        item('1', 78, 94, 12), item('2', 78, 106, 12),
        ...run('gt', 94, 100), item('2', 105, 89, 8),
    ]), 'h = \\frac{1}{2}gt^2', 'physics formula');
    ok(buildDisplayMath([
        item('S', 40, 100, 14, { italic: true }), item('=', 58, 100, 14),
        item('\u2211', 84, 100, 16),
        item('n', 76, 112, 8, { italic: true }), item('=', 82, 112, 8), item('1', 88, 112, 8),
        item('\u221e', 76, 88, 8),
        item('\u221a', 124, 100, 14), ...run('n-1', 142, 100, 12),
        item('2', 172, 89, 8),
    ]), 'S = \\sum\\limits_{n = 1}^{\\infty}\\sqrt{n - 1}^2', 'series with radical and outside exponent');
    ok(buildDisplayMath([
        item('12', 60, 94, 12), item('34', 60, 106, 12),
    ]), '\\frac{12}{34}', 'multi-digit numerator and denominator');
    ok(buildDisplayMath([
        item('a', 60, 94, 12, { italic: true }), item('b', 60, 106, 12, { italic: true }),
        item('x', 76, 100, 12, { italic: true }),
        item('c', 90, 94, 12, { italic: true }), item('d', 90, 106, 12, { italic: true }),
    ]), '\\frac{a}{b}x\\frac{c}{d}', 'two fractions separated by a factor');
    ok(buildDisplayMath([
        item('\u221a', 60, 100, 16), item('n', 82, 100, 12, { italic: true }), item('2', 87, 89, 8),
    ]), '\\sqrt{n^2}', 'script inside the radicand');
    ok(buildDisplayMath([
        item('\u221a', 60, 100, 16), ...run('n-1', 82, 100, 12),
    ]), '\\sqrt{n - 1}', 'binop inside the radicand');
    ok(buildDisplayMath([
        item('(', 60, 100, 12), item('n', 70, 94, 12, { italic: true }),
        item('k', 70, 106, 12, { italic: true }), item(')', 80, 100, 12),
    ]), '(\\frac{n}{k})', 'binomial coefficient renders as a stacked pair');
    ok(buildDisplayMath([
        item('x', 30, 100, 12, { italic: true }), item('=', 44, 100, 12),
        item('-', 60, 94, 12), item('b', 70, 94, 12, { italic: true }), item('\u00b1', 86, 94, 12),
        item('\u221a', 96, 94, 14), item('b', 112, 94, 12, { italic: true }), item('2', 119, 83, 8),
        item('-', 128, 94, 12), ...run('4ac', 136, 94, 12),
        item('2', 108, 106, 12), item('a', 118, 106, 12, { italic: true }),
    ]), 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', 'quadratic formula with full-size numerator rows');
    ok(buildDisplayMath([
        ...frac('a/b', 60, 100), item('+', 86, 100, 12), ...frac('c/d', 104, 100),
    ]), '\\frac{a}{b} + \\frac{c}{d}', 'two fractions separated by an operator');
    ok(buildDisplayMath([...run('y=mx+b', 30, 100, 12)]), 'y = mx + b',
       'a flat linear equation must NOT become a fraction');
    ok(buildDisplayMath([
        item('\u221a', 60, 100, 16), item('a', 80, 94, 12, { italic: true }),
        item('b', 80, 106, 12, { italic: true }),
    ]), '\\sqrt{\\frac{a}{b}}', 'radical over a fraction');
    ok(buildDisplayMath([
        item('(', 50, 100, 12), item('a', 58, 94, 12, { italic: true }),
        item('b', 58, 106, 12, { italic: true }), item(')', 68, 100, 12),
        item('(', 78, 100, 12), item('c', 86, 94, 12, { italic: true }),
        item('d', 86, 106, 12, { italic: true }), item(')', 96, 100, 12),
    ]), '(\\frac{a}{b})(\\frac{c}{d})', 'two parenthesised fractions');

    // ── Assembly: a fraction line becomes a KaTeX math block ──────────────
    const eqItems = [
        ...frac('1/2', 60, 100),
        item('=', 78, 100, 12),
        item('0', 92, 100, 12), item('.', 100, 100, 12), item('5', 106, 100, 12),
    ];
    const eqPage = assemblePage(
        [makeRegion(eqItems, 'PARAGRAPH')], makeMeta(eqItems), eqItems,
        viewport, 612, 1, createFontRegistry());
    okTrue(/pdf-math-block/.test(eqPage.html),
       'a fraction line assembles as a .pdf-math-block paragraph');
    okTrue(/data-latex="[^"]*\\frac\{1\}\{2\}[^"]*"/.test(eqPage.html),
       'the math block carries the reconstructed TeX in an escaped data-latex attribute');
    okTrue(/<span class="katex/.test(eqPage.html),
       'the math block body is rendered KaTeX HTML, not flattened text');
    // The extractor RENDERS but does not CONFIRM. `data-math` is an assertion
    // that a human approved this rendering, and only core.applyRegionLatex may
    // make it; the extractor's own reconstruction says it is unchecked.
    okTrue(/data-math-suggested=""/.test(eqPage.html) && !/data-math=""/.test(eqPage.html),
       'an extracted equation is marked suggested, never confirmed');
    // The evidence the render replaced. Without it there is no way back to what
    // the page actually said, and the IR would read KaTeX's glyph soup as the
    // equation's text.
    okTrue(/data-math-source="[^"]*1[^"]*2[^"]*"/.test(eqPage.html),
       'the page\'s own glyphs are kept in data-math-source');
    okTrue(!/1\/2/.test(eqPage.html.replace(/data-(latex|math-source)="[^"]*"/g, '')),
       'no flattened "1/2" text survives outside the data attributes');

    // TeX that will not typeset must fall back to the glyphs and SAY so. An
    // equation that vanishes because its reconstruction was malformed is the
    // one outcome worse than an ugly one.
    const { renderMath, mathMarker } = await import('../utils/mathRender.js');
    okTrue(renderMath('\\frac{1}{2}') !== null, 'valid TeX typesets');
    okTrue(renderMath('\\frac{1}{') === null, 'malformed TeX returns null rather than red error markup');
    okTrue(renderMath('') === null && renderMath(null) === null, 'empty TeX is not an equation');
    okTrue(mathMarker({ confirmed: true }) === 'data-math=""',
       'a confirmed block carries data-math');
    okTrue(mathMarker({ typeset: true }) === 'data-math-suggested=""',
       'a rendered but unchecked block carries data-math-suggested');
    okTrue(mathMarker({}) === 'data-math-unrendered=""',
       'a block whose TeX would not typeset says so, rather than looking merely unchecked');

    // ── Assembly: prose paragraphs are untouched ──────────────────────────
    const proseItems = run('The quick brown fox jumps over the lazy dog.', 40, 100, 10);
    const prosePage = assemblePage(
        [makeRegion(proseItems, 'PARAGRAPH')], makeMeta(proseItems), proseItems,
        viewport, 612, 1, createFontRegistry());
    okTrue(!/pdf-math-block/.test(prosePage.html) && !/katex/.test(prosePage.html),
       'a prose paragraph assembles as plain text, never as a math block');

    // ── Export CSS: the generated KaTeX export stylesheet is self-contained ──
    const { katexExportCss } = await import('./vector/katexExport.css.js');
    okTrue(typeof katexExportCss === 'string' && katexExportCss.length > 1000,
       'generated katexExport.css.js exports a non-trivial CSS string');
    okTrue(/@font-face/.test(katexExportCss) && /font-family:KaTeX_Main/.test(katexExportCss),
       'the export CSS carries the KaTeX @font-face rules');
    okTrue(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/.test(katexExportCss),
       'the export CSS inlines fonts as base64 woff2 data URIs');
    okTrue(!/url\(fonts\//.test(katexExportCss),
       'no unresolved url(fonts/...) references remain in the export CSS');

    console.log(`check-math: ${pass} passed, ${fail} failed`);
    if (fail) {
        console.log('FAILURES:');
        for (const f of fails) console.log('  - ' + f);
        process.exit(1);
    }
})();