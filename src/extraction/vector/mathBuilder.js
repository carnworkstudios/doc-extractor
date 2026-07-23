// mathBuilder.js
// Reconstructs display math from multi-baseline pdfjs text items into LaTeX.
//
// Ported from pdf_md (github.com/MasakatsuFunaki/pdf_md, MIT) layout_math.cpp,
// adapted from per-glyph PDFium records to pdfjs per-run granularity: items are
// exploded into atoms (letter runs / numbers / single symbols) with x positions
// interpolated inside the run, then the same recursive resolution applies —
// stacked numerator/denominator pairs become \frac, a radical swallows its
// radicand into \sqrt, oversized stretch delimiters become \left(..\right),
// and small off-axis atoms attach to their base as _{}/^{}. The vector-drawn
// fraction bar never appears in the text layer, so structure is recovered from
// glyph geometry alone, exactly as pdf_md does.
//
// Scope: DISPLAY math only — a line cluster is converted when it is dominated
// by math atoms and carries an unambiguous seed (a math symbol, Greek letter,
// or stretch delimiter). Inline scripts in prose stay with textRebuilder's
// <sub>/<sup> handling; prose sentences that merely mention an arrow are kept
// out by the density gate.

// ── Symbol tables ─────────────────────────────────────────────────────────────

const LATEX_SYMBOL = {
    'α': '\\alpha ',  'β': '\\beta ',   'γ': '\\gamma ',  'δ': '\\delta ',
    'ε': '\\epsilon ', 'ϵ': '\\epsilon ', 'ζ': '\\zeta ', 'η': '\\eta ',
    'θ': '\\theta ',  'κ': '\\kappa ',  'λ': '\\lambda ', 'μ': '\\mu ',
    'ν': '\\nu ',     'ξ': '\\xi ',     'π': '\\pi ',     'ρ': '\\rho ',
    'σ': '\\sigma ',  'τ': '\\tau ',    'χ': '\\chi ',    'ψ': '\\psi ',
    'ω': '\\omega ',  'φ': '\\phi ',    'ϕ': '\\phi ',
    'Γ': '\\Gamma ',  'Δ': '\\Delta ',  'Θ': '\\Theta ',  'Λ': '\\Lambda ',
    'Π': '\\Pi ',     'Σ': '\\Sigma ',  'Φ': '\\Phi ',    'Ψ': '\\Psi ',
    'Ω': '\\Omega ',
    '√': '\\surd ',   '∞': '\\infty ',  '∑': '\\sum ',    '∏': '\\prod ',
    '∫': '\\int ',    '∂': '\\partial ', '∇': '\\nabla ', '∈': '\\in ',
    '∉': '\\notin ',  '×': '\\times ',  '·': '\\cdot ',   '⋅': '\\cdot ',
    '≤': '\\leq ',    '≥': '\\geq ',    '≠': '\\neq ',    '≈': '\\approx ',
    '≡': '\\equiv ',  '±': '\\pm ',     '÷': '\\div ',
    '→': '\\rightarrow ', '←': '\\leftarrow ',
    '⇒': '\\Rightarrow ', '⇐': '\\Leftarrow ',
    '−': '-',         '⊆': '\\subseteq ', '⊇': '\\supseteq ',
    '⊕': '\\oplus ',  '⊗': '\\otimes ',  '⊙': '\\odot ',
    '∘': '\\circ ',   '…': '\\ldots ',   '′': "'",
    '%': '\\%', '#': '\\#', '&': '\\&', '$': '\\$',
    '_': '\\_', '{': '\\{', '}': '\\}',
};

const GREEK_RE = /[Α-Ωα-ωϑϕϖϱϵ]/;
const MATH_SYMBOL_RE = /[−∞×÷±∈∉≤≥≠≈≡√∑∏∫∂∇→←⇒⇐⊆⊇⊕⊗⊙∘]/;
const RELATION_RE = /^[=<>≤≥≈≠≡→←⇒⇐]$/;
const ARITH_RE = /^[+\-/*−]$/;

// TeX sets standard function names upright with their own macro.
const OPERATOR_MACROS = new Set([
    'max', 'min', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log',
    'ln', 'exp', 'lim', 'det', 'gcd', 'tanh', 'sinh', 'cosh',
]);

function latexOf(str) {
    let out = '';
    for (const ch of str) out += LATEX_SYMBOL[ch] ?? ch;
    return out;
}

function _median(values) {
    if (!values.length) return 0;
    const v = [...values].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// ── Atom extraction ───────────────────────────────────────────────────────────

// Explode pdfjs items into math atoms: maximal letter runs, numbers (with
// internal decimal separators), or single symbol glyphs. Each atom gets its x
// range by proportional interpolation inside its item — coarse, but the
// resolution only ever compares atoms against thresholds of ~0.3 × font size.
const ATOM_RE = /[A-Za-z]+|\d+(?:[.,]\d+)*|\S/g;

export function atomsFromItems(items) {
    const atoms = [];
    for (const item of items) {
        const str = item.str || '';
        if (!str.trim()) continue;
        const size = Math.abs(item.transform?.[3] || item.height || 10);
        const x = item.transform[4];
        const y = item.transform[5];
        const w = item.width || 0;
        const perChar = w / Math.max(str.length, 1);
        const name = (item.fontName || '').replace(/^[A-Z]{6}\+/, '');
        const bold   = item.bold   ?? /bold|heavy|black/i.test(name);
        const italic = item.italic ?? /italic|oblique|slanted/i.test(name);

        let m;
        let prevEnd = 0;
        ATOM_RE.lastIndex = 0;
        while ((m = ATOM_RE.exec(str)) !== null) {
            atoms.push({
                str: m[0],
                left:  x + perChar * m.index,
                right: x + perChar * (m.index + m[0].length),
                y, size, bold, italic,
                spaceBefore: m.index > prevEnd, // whitespace was skipped over
            });
            prevEnd = m.index + m[0].length;
        }
    }
    return atoms;
}

// ── Math-line detection ───────────────────────────────────────────────────────

// A stretch delimiter: a lone bracket glyph drawn well above the local body
// size ("\left(" material). Its baseline is typographically meaningless.
function _isStretchDelim(a, base) {
    return /^[()[\]{}|]$/.test(a.str) && a.size >= 1.5 * base;
}

/**
 * True when this atom set is a display-math candidate: it carries a hard seed
 * (math symbol, Greek letter, or stretch delimiter) AND is dominated by
 * math-shaped atoms rather than prose words. `base` is the local body size.
 */
export function isDisplayMath(atoms, base) {
    if (atoms.length < 3) return false;
    let seed = false, mathy = 0;
    for (const a of atoms) {
        if (MATH_SYMBOL_RE.test(a.str) || GREEK_RE.test(a.str) || _isStretchDelim(a, base)) {
            seed = true;
        }
        // Math-shaped: symbols, digits, short identifiers, connectors, scripts.
        const prose = /^[A-Za-z]{3,}$/.test(a.str) && a.size >= 0.85 * base;
        if (!prose) mathy++;
    }
    return seed && mathy / atoms.length >= 0.6;
}

// ── LaTeX reconstruction ──────────────────────────────────────────────────────

// The dominant baseline of an atom set: median y of the full-size atoms
// (stretch delimiters and small scripts do not define it).
export function mathAxis(atoms) {
    let base = 0;
    for (const a of atoms) if (!/^[()[\]{}|]$/.test(a.str)) base = Math.max(base, a.size);
    if (base <= 0) base = atoms[0]?.size || 10;
    const ys = atoms.filter(a => a.size >= 0.8 * base && !_isStretchDelim(a, base * 0.66))
        .map(a => a.y);
    return _median(ys.length ? ys : atoms.map(a => a.y));
}

function _wrapScript(inner) {
    return inner.length <= 1 ? inner : `{${inner}}`;
}

// One operand — a same-style letter run, a number, or a single symbol/Greek
// glyph — to LaTeX. Bold letters become \mathbf, known function names their
// upright macro, other upright multi-letter names \text{...} (so `d_model`
// reads d_\text{model}, not a product), italic letters stay bare math italic.
function _emitOperand(op) {
    const s = op.map(a => latexOf(a.str)).join('');
    const first = op[0];
    if (!/^[A-Za-z]/.test(first.str)) return s;
    if (first.bold) return `\\mathbf{${s}}`;
    if (OPERATOR_MACROS.has(s)) return `\\${s} `;
    if (!first.italic && s.length >= 2 && /^[A-Za-z]+$/.test(s)) return `\\text{${s}}`;
    return s;
}

/**
 * Recursive 2-D resolution: stacked numerator/denominator runs → \frac,
 * radicals swallow the next factor → \sqrt, stretch delimiters → \left/\right,
 * diagonal small atoms attach as scripts. `axis` is this level's reference
 * baseline; recursion re-derives it per nested group.
 */
export function mathToLatex(atoms, axis, topLevel = true, depth = 0) {
    const gl = [...atoms].sort((a, b) => a.left - b.left);
    if (!gl.length) return '';
    if (depth > 24) return gl.map(a => latexOf(a.str)).join('');

    // Body size: largest non-delimiter, non-radical atom. Stretch parens are
    // sized to the whole stack and would wreck every threshold below.
    const medSize = _median(gl.map(a => a.size));
    let base = 0;
    for (const a of gl) {
        if (a.str === '√' || _isStretchDelim(a, medSize)) continue;
        base = Math.max(base, a.size);
    }
    if (base <= 0) base = gl[0].size || 10;

    // +1 numerator (well above axis), -1 denominator (well below), 0 on-axis.
    const fracLevel = a => {
        if (_isStretchDelim(a, medSize)) return 0;
        const dy = a.y - axis;
        if (dy > 0.34 * base) return 1;
        if (dy < -0.30 * base) return -1;
        return 0;
    };
    const small = a => a.size < 0.85 * base;
    // Diagonal script: a small atom nudged off the axis — gentler thresholds
    // than a fraction, which sits a full half-line away.
    const scriptLevel = a => {
        if (!small(a)) return 0;
        const dy = a.y - axis;
        if (dy > 0.10 * base) return 1;
        if (dy < -0.05 * base) return -1;
        return 0;
    };

    let out = '';
    let prevRight = -Infinity;
    let prevStr = '';
    let prevScripted = false;

    // Math-typesetting spacing: relations always spaced (top level), brackets
    // and arithmetic tight, otherwise space on a real word gap.
    const sepBefore = (a, wordBreak) => {
        if (!out || out.endsWith(' ') || prevRight === -Infinity) return;
        const cur = a.str[0] || '';
        let space;
        if (topLevel && (RELATION_RE.test(cur) || RELATION_RE.test(prevStr))) space = true;
        else if (/^[([]/.test(prevStr) || /^[)\]]/.test(cur)) space = false;
        else if (ARITH_RE.test(cur) || ARITH_RE.test(prevStr)) space = false;
        else if (cur === ',' || cur === ';') space = false;
        else if (topLevel && (prevStr === ',' || prevStr === ';')) space = true;
        else {
            const implicitProduct = topLevel && prevScripted && /^[A-Za-z0-9]/.test(cur);
            space = wordBreak || implicitProduct || a.left - prevRight > 0.25 * base;
        }
        if (space) out += ' ';
    };

    let i = 0;
    const n = gl.length;
    while (i < n) {
        const a = gl[i];

        // (0) Stretch delimiters render as \left( / \right).
        if (_isStretchDelim(a, medSize)) {
            sepBefore(a, a.spaceBefore);
            out += (/^[([{]/.test(a.str) ? '\\left' : '\\right') + latexOf(a.str);
            prevRight = a.right;
            prevStr = a.str;
            prevScripted = false;
            i++;
            continue;
        }

        // (1) A fraction stack: consecutive off-axis atoms carrying both a
        // numerator and a denominator, at least one full size (so a pair of
        // small scripts on a base never reads as a fraction).
        if (fracLevel(a) !== 0) {
            let j = i, hasUp = false, hasDown = false, hasBig = false;
            while (j < n && fracLevel(gl[j]) !== 0 && !_isStretchDelim(gl[j], medSize)) {
                if (fracLevel(gl[j]) > 0) hasUp = true; else hasDown = true;
                if (!small(gl[j])) hasBig = true;
                j++;
            }
            const run = gl.slice(i, j);
            const allSmall = run.every(t => small(t));
            let scripted = false;
            if (hasUp && hasDown && hasBig) {
                const up = run.filter(t => fracLevel(t) > 0);
                const down = run.filter(t => fracLevel(t) < 0);
                sepBefore(a, a.spaceBefore);
                out += `\\frac{${mathToLatex(up, mathAxis(up), false, depth + 1)}}` +
                       `{${mathToLatex(down, mathAxis(down), false, depth + 1)}}`;
            } else if (allSmall && fracLevel(a) > 0 && prevStr && /^[A-Za-z]/.test(a.str) &&
                       a.left < prevRight - 0.5 * a.size) {
                // An annotation drawn OVER the previous operator (MathML overset,
                // e.g. "maps to" above an arrow): \overset{\text{..}}{prev}.
                const label = run.map(t => t.str).join(' ');
                const prevTex = latexOf(prevStr).trim();
                const cut = out.lastIndexOf(prevTex);
                if (cut >= 0) {
                    out = out.slice(0, cut) +
                        `\\overset{\\text{${label}}}{${prevTex}} ` +
                        out.slice(cut + prevTex.length).trimStart();
                }
            } else if (allSmall && prevRight > -Infinity &&
                       a.left >= prevRight - 0.5 * a.size &&
                       a.left <= prevRight + 0.6 * base) {
                // Small atoms ADJACENT to the previous operand but farther
                // off-axis than the script band — an exponent riding a tall
                // \right paren. Attach as ordinary scripts.
                const sups = run.filter(t => t.y > axis);
                const subs = run.filter(t => t.y < axis);
                out = out.replace(/ +$/, '');
                if (subs.length) out += '_' + _wrapScript(mathToLatex(subs, mathAxis(subs), false, depth + 1));
                if (sups.length) out += '^' + _wrapScript(mathToLatex(sups, mathAxis(sups), false, depth + 1));
                scripted = true;
            } else {
                // One-sided off-axis run with no base: render level at its own axis.
                sepBefore(a, a.spaceBefore);
                out += mathToLatex(run, mathAxis(run), false, depth + 1);
            }
            prevRight = Math.max(...run.map(t => t.right));
            prevStr = '';
            prevScripted = scripted;
            i = j;
            continue;
        }

        // (2) A radical swallows the following factor as its radicand.
        if (a.str === '√') {
            sepBefore(a, a.spaceBefore);
            i++;
            const rad = [];
            if (i < n && fracLevel(gl[i]) === 0) {
                // The radicand is a tight run of identifier atoms (letters and
                // digits with no real gap), plus any scripts riding it.
                rad.push(gl[i]);
                i++;
                while (i < n && fracLevel(gl[i]) === 0 && scriptLevel(gl[i]) === 0 &&
                       /^[A-Za-z0-9]/.test(gl[i].str) &&
                       gl[i].left - rad[rad.length - 1].right <= 0.2 * base) {
                    rad.push(gl[i]);
                    i++;
                }
                while (i < n && scriptLevel(gl[i]) !== 0) { rad.push(gl[i]); i++; }
            }
            out += `\\sqrt{${mathToLatex(rad, mathAxis(rad), false, depth + 1)}}`;
            if (rad.length) prevRight = rad[rad.length - 1].right;
            prevStr = '';
            prevScripted = false;
            continue;
        }

        // (3) An operand at axis level: same-style letter run, number, or a
        // single symbol/Greek glyph.
        sepBefore(a, a.spaceBefore);
        const op = [a];
        i++;
        if (/^[A-Za-z]/.test(a.str)) {
            while (i < n && fracLevel(gl[i]) === 0 && scriptLevel(gl[i]) === 0 &&
                   /^[A-Za-z]/.test(gl[i].str) &&
                   gl[i].bold === a.bold && gl[i].italic === a.italic &&
                   gl[i].left - op[op.length - 1].right <= 0.28 * base) {
                op.push(gl[i]);
                i++;
            }
        }
        out += _emitOperand(op);
        prevRight = op[op.length - 1].right;
        prevStr = op[op.length - 1].str;

        // (4) Diagonal sub/superscripts trailing this operand; recurse so a
        // script can itself carry structure. Scripts TRAIL their base — an
        // atom that starts well inside the operand's x-range is drawn over it
        // (an overset annotation) and is left for branch (1).
        const subs = [], sups = [];
        while (i < n && scriptLevel(gl[i]) !== 0 && !_isStretchDelim(gl[i], medSize) &&
               gl[i].left >= op[op.length - 1].right - 0.5 * gl[i].size) {
            (scriptLevel(gl[i]) === 1 ? sups : subs).push(gl[i]);
            prevRight = Math.max(prevRight, gl[i].right);
            i++;
        }
        if (subs.length || sups.length) {
            out = out.replace(/ +$/, '');
            if (subs.length) out += '_' + _wrapScript(mathToLatex(subs, mathAxis(subs), false, depth + 1));
            if (sups.length) out += '^' + _wrapScript(mathToLatex(sups, mathAxis(sups), false, depth + 1));
        }
        prevScripted = subs.length > 0 || sups.length > 0;
    }
    return out.trim();
}

/**
 * Full pipeline for one merged line group: items → atoms → LaTeX.
 * Returns null when the group does not qualify as display math.
 */
export function buildDisplayMath(items) {
    const atoms = atomsFromItems(items);
    if (!atoms.length) return null;
    const medSize = _median(atoms.map(a => a.size));
    if (!isDisplayMath(atoms, medSize)) return null;
    const latex = mathToLatex(atoms, mathAxis(atoms), true, 0);
    return latex ? latex : null;
}
