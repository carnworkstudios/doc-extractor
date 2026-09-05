// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
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

// Big operators whose limits are drawn ABOVE/BELOW the glyph (centred over it
// for ∑/∏, trailing it for ∫), not as trailing scripts. They are absorbed as a
// unit before the linear left-to-right pass so the limit atoms — which are
// centred and therefore can extend LEFT of the operator in x — cannot be
// emitted before it.
const BIG_OPERATORS = { '∑': '\\sum', '∏': '\\prod', '∫': '\\int' };

// Tight postfixes: factorial and prime marks attach to the preceding operand
// with no gap, whatever the run boundary or font style says.
const TIGHT_POSTFIX_RE = /^[!′']$/;

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

// A display equation is a short, compact stack: a nested fraction is four rows
// at the very most. A prose paragraph arrives as ONE region carrying a dozen
// baselines, and every row other than the axis row reads as "structure" — which
// is how whole paragraphs were being rendered as a single giant \frac.
const MAX_MATH_ROWS = 4;

// Prose is measured by CHARACTER mass, not atom count. Counting atoms let a
// units-heavy engineering line ("(1 SQ. IN./4,000 BTUH)") pass the density gate
// on its parentheses and digits while reading as text to every human.
const MAX_PROSE_MASS = 0.35;

// A structure-only seed (no math glyph anywhere — a bare `1/2` or `x²`) is
// only trusted for a SHORT, compact, letter-free group. Without that bound any
// numeric table row that happened to sit on two baselines qualified.
const STRUCTURE_SEED_MAX_ATOMS = 12;
const STRUCTURE_SEED_MAX_ROWS = 3;

/**
 * The group's body size: the largest atom that is not a radical or a stretch
 * delimiter. Glyphs that are tall by design have no business defining what
 * ordinary is — the same discipline the fraction gate uses.
 */
export function bodySize(atoms, medSize) {
    return atoms.reduce((m, a) =>
        (a.str === '√' || _isStretchDelim(a, medSize)) ? m : Math.max(m, a.size), 0) || medSize;
}

/**
 * Number of distinct full-size baselines in the group.
 *
 * Measured against the BODY size, not the median: a sum's small limit atoms
 * drag the median down, and every one of them would then count as its own
 * full-size row.
 */
export function baselineRowCount(atoms, base) {
    const body = bodySize(atoms, base);
    const ys = atoms.filter(a => a.size >= 0.85 * body && !_isStretchDelim(a, body))
        .map(a => a.y)
        .sort((x, y) => x - y);
    if (!ys.length) return 0;
    let rows = 1;
    for (let i = 1; i < ys.length; i++) {
        if (ys[i] - ys[i - 1] > 0.5 * body) rows++;
    }
    return rows;
}

/**
 * True when this atom set is a display-math candidate.
 *
 * Three things must hold, and the gate is deliberately conservative: a false
 * positive rewrites a readable paragraph as LaTeX, which is far worse than a
 * missed equation that stays as text (and the user can still tag the region
 * MATH by hand).
 *
 *   1. It is a compact stack — at most MAX_MATH_ROWS baselines.
 *   2. Prose does not dominate it — full-size alphabetic runs of two or more
 *      letters carry under MAX_PROSE_MASS of the characters.
 *   3. It carries a seed: a hard symbol (math glyph, Greek letter, relation,
 *      stretch delimiter, factorial/prime mark), or — for a short, letter-free
 *      group only — a vertical structure, which is what a plain `1/2` or `x²`
 *      consists of.
 *
 * `base` is the local body size.
 */
export function isDisplayMath(atoms, base) {
    if (atoms.length < 2) return false;
    if (baselineRowCount(atoms, base) > MAX_MATH_ROWS) return false;

    let seed = false, structure = 0, proseChars = 0, totalChars = 0, wordChars = 0;
    const axis = mathAxis(atoms);
    for (let i = 0; i < atoms.length; i++) {
        const a = atoms[i];
        if (MATH_SYMBOL_RE.test(a.str) || GREEK_RE.test(a.str) ||
            RELATION_RE.test(a.str) || _isStretchDelim(a, base)) {
            seed = true;
        }
        // A factorial or prime attaches to an OPERAND. Seeding on the glyph
        // alone made every "NOTICE!" and "…in Canada.!" heading an equation.
        if (TIGHT_POSTFIX_RE.test(a.str)) {
            const prev = atoms[i - 1];
            if (prev && (/^[A-Za-z0-9]$/.test(prev.str) || /^[)\]}]$/.test(prev.str))) seed = true;
        }
        const offAxis = Math.abs(a.y - axis);
        if (a.size < 0.85 * base && offAxis > 0.15 * base) {
            structure++;   // a script drawn off the baseline
        } else if (a.size >= 0.85 * base && offAxis > 0.30 * base) {
            structure++;   // a full-size fraction numerator/denominator
        }
        totalChars += a.str.length;
        // A multi-letter word set at body size is prose unless it is one of
        // TeX's upright function names (max, lim, sin…).
        const isWord = /^[A-Za-z]{2,}$/.test(a.str) && a.size >= 0.85 * base;
        if (isWord) {
            wordChars += a.str.length;
            if (!OPERATOR_MACROS.has(a.str.toLowerCase())) proseChars += a.str.length;
        }
    }
    if (!totalChars || proseChars / totalChars > MAX_PROSE_MASS) return false;

    if (seed) return true;
    return structure >= 1 &&
        wordChars === 0 &&
        atoms.length <= STRUCTURE_SEED_MAX_ATOMS &&
        baselineRowCount(atoms, base) <= STRUCTURE_SEED_MAX_ROWS;
}

// ── LaTeX reconstruction ──────────────────────────────────────────────────────

// The dominant baseline of an atom set. Full-size atoms (stretch delimiters
// and small scripts do not define it) are clustered by baseline; the axis is
// the median of the cluster means. A single row yields that row's baseline; a
// fraction stack (two full-size rows) yields the bar between them; a
// "body row + fraction rows" layout (x = \frac{...}{...}) yields the middle
// row even when one side has far more atoms than the other.
export function mathAxis(atoms) {
    let base = 0;
    for (const a of atoms) if (!/^[()[\]{}|]$/.test(a.str)) base = Math.max(base, a.size);
    if (base <= 0) base = atoms[0]?.size || 10;
    const rowAtoms = atoms.filter(a => a.size >= 0.8 * base && !_isStretchDelim(a, base * 0.66));
    const ys = rowAtoms.map(a => a.y);
    if (ys.length) {
        const sorted = [...ys].sort((a, b) => a - b);
        const clusters = [];
        let cur = [sorted[0]];
        const tol = 0.35 * base;
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] - cur[cur.length - 1] <= tol) cur.push(sorted[i]);
            else { clusters.push(cur); cur = [sorted[i]]; }
        }
        clusters.push(cur);
        if (clusters.length >= 2) {
            const means = clusters.map(c => c.reduce((s, v) => s + v, 0) / c.length);
            return _median(means);
        }
        return cur[0];
    }
    return _median(atoms.map(a => a.y));
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
 * Absorb a big operator's limit atoms (∑/∏/∫) out of the linear stream.
 *
 * Limits are small off-axis atoms drawn immediately around the operator — above
 * and below, horizontally centred over it (or trailing it for ∫). Because they
 * are centred they can extend LEFT of the operator, which the sorted x-order
 * would otherwise emit before the operator. Absorption keys the operator atom
 * to { subs, sups } and removes the limit atoms from the stream.
 *
 * The scan in each direction stops at the first full-size ON-AXIS atom: that is
 * the next real operand, and anything past it belongs to it (a following
 * operand's superscript is NOT this operator's limit).
 */
function _absorbBigOpLimits(gl, base) {
    const absorbed = new Map();
    for (let k = 0; k < gl.length; k++) {
        const a = gl[k];
        if (!BIG_OPERATORS[a.str]) continue;
        // ∫ draws its limits to the right of the glyph, ∑/∏ centre them.
        const reach = a.str === '∫' ? 1.6 : 0.9;
        const lo = a.left - 1.0 * base;
        const hi = a.right + reach * base;

        const candidates = [];
        for (let m = k - 1; m >= 0 && gl[m].left >= lo; m--) {
            const b = gl[m];
            if (b.size >= 0.85 * base && Math.abs(b.y - a.y) < 0.25 * base) break;
            candidates.push(b);
        }
        for (let m = k + 1; m < gl.length && gl[m].left <= hi; m++) {
            const b = gl[m];
            if (b.size >= 0.85 * base && Math.abs(b.y - a.y) < 0.25 * base) break;
            candidates.push(b);
        }

        const subs = [], sups = [];
        for (const b of candidates) {
            if (b.size >= 0.85 * base) continue;               // not a limit
            if (Math.abs(b.y - a.y) < 0.12 * base) continue;   // on-axis, not a limit
            const c = (b.left + b.right) / 2;
            if (c < lo || c > hi) continue;
            (b.y < a.y ? sups : subs).push(b);                 // smaller y = above
        }
        if (subs.length || sups.length) absorbed.set(a, { subs, sups });
    }
    return absorbed;
}

/**
 * Collapse fraction stacks in a single pass before linear reconstruction.
 *
 * Fraction rows are matched ROW-to-ROW, never atom-to-atom: full-size atoms
 * are clustered into baselines (split at real word gaps so two side-by-side
 * fractions `\frac{a}{b}\frac{c}{d}` stay apart) and two rows separated by
 * ~1em whose x-extents overlap become a fraction — regardless of how many
 * atoms each row carries (x = \frac{-b ± √(b²-4ac)}{2a} has a 10-atom
 * numerator and a 2-atom denominator). Greedily collapsing the tightest pair
 * first recovers nesting: \frac{\frac{a}{b}}{c} — the inner a/b pair is
 * tighter, so it collapses first and the resulting super-atom becomes the
 * next numerator. An atom sitting in the gap between two rows inside the
 * overlap (a `+` between two fractions) blocks the pair — that is two
 * structures, not one.
 */
function _collapseFractions(atoms, base) {
    let list = [...atoms];
    let changed = true;
    while (changed) {
        changed = false;
        // Every full-size body atom participates in rows — radicals and big
        // operators sit ON a numerator row too (\frac{\sqrt{x}}{y},
        // \frac{\sum x}{n}). Only stretch delimiters are exempt: they span
        // the whole stack and would cluster into their own bogus row.
        const full = list.filter(a => a.size >= 0.7 * base && !_isStretchDelim(a, base));
        if (full.length < 2) break;
        const byY = [...full].sort((a, b) => a.y - b.y);
        const tol = 0.3 * base;
        const rows = [];
        let cur = [byY[0]];
        for (let i = 1; i < byY.length; i++) {
            if (byY[i].y - cur[cur.length - 1].y <= tol) cur.push(byY[i]);
            else { rows.push(cur); cur = [byY[i]]; }
        }
        rows.push(cur);
        // Split each baseline at real x-gaps. The gap is measured against the
        // FURTHEST atom in between — a superscript's overhang (b² then `-`)
        // keeps its numerator row contiguous — while a genuinely wide hole
        // (two side-by-side fractions sharing the baseline) splits the row.
        const split = [];
        for (const row of rows) {
            const sx = [...row].sort((a, b) => a.left - b.left);
            let run = [sx[0]];
            for (let i = 1; i < sx.length; i++) {
                const cover = Math.max(0, ...list
                    .filter(t => t.left >= sx[i - 1].left && t.left <= sx[i].left)
                    .map(t => t.right));
                if (sx[i].left - cover > 0.8 * base) {
                    split.push(run); run = [sx[i]];
                } else run.push(sx[i]);
            }
            split.push(run);
        }
        if (split.length < 2) break;
        let best = null, bestDy = Infinity;
        for (let i = 0; i < split.length; i++) {
            for (let j = i + 1; j < split.length; j++) {
                const upMean = split[i].reduce((s, a) => s + a.y, 0) / split[i].length;
                const dnMean = split[j].reduce((s, a) => s + a.y, 0) / split[j].length;
                const above = upMean < dnMean ? split[i] : split[j];
                const below = upMean < dnMean ? split[j] : split[i];
                const dy = Math.abs(dnMean - upMean);
                if (dy < 0.8 * base || dy > 1.8 * base) continue;
                const aL = Math.min(...above.map(a => a.left));
                const aR = Math.max(...above.map(a => a.right));
                const bL = Math.min(...below.map(a => a.left));
                const bR = Math.max(...below.map(a => a.right));
                const ovL = Math.max(aL, bL), ovR = Math.min(aR, bR);
                if (ovR - ovL < 0.4 * Math.min(aR - aL, bR - bL)) continue;
                // Blocked when some atom sits in the gap between the two rows
                // with its center inside the overlap — e.g. the `+` between
                // `\frac{a}{b} + \frac{c}{d}`.
                const loY = Math.max(...above.map(a => a.y)) - 0.2 * base;
                const hiY = Math.min(...below.map(a => a.y)) + 0.2 * base;
                let blocked = false;
                for (const t of list) {
                    if (above.includes(t) || below.includes(t)) continue;
                    const cx = (t.left + t.right) / 2;
                    if (cx < ovL || cx > ovR) continue;
                    if (t.y >= loY && t.y <= hiY) { blocked = true; break; }
                }
                if (blocked) continue;
                if (dy < bestDy) { bestDy = dy; best = { above, below }; }
            }
        }
        if (!best) break;
        const { above, below } = best;
        const mid = (above.reduce((s, a) => s + a.y, 0) / above.length +
                     below.reduce((s, a) => s + a.y, 0) / below.length) / 2;
        const xLo = Math.min(...above.map(a => a.left), ...below.map(a => a.left)) - 0.4 * base;
        const xHi = Math.max(...above.map(a => a.right), ...below.map(a => a.right)) + 0.4 * base;
        const inWindow = t => {
            const c = (t.left + t.right) / 2;
            return c >= xLo && c <= xHi;
        };
        // Numerator/denominator: the pair's OWN rows plus small scripts riding
        // them — never other full-size rows that fall inside the x-window
        // (that would swallow the outer rows of a deeper stack).
        const num = [...above, ...list.filter(t => t.size < 0.7 * base && t.y < mid && inWindow(t))];
        const den = [...below, ...list.filter(t => t.size < 0.7 * base && t.y > mid && inWindow(t))];
        if (!num.length || !den.length) break;
        const superAtom = {
            str: '',
            left: Math.min(...num.map(a => a.left), ...den.map(a => a.left)),
            right: Math.max(...num.map(a => a.right), ...den.map(a => a.right)),
            y: mid,
            size: Math.max(...num.map(a => a.size), ...den.map(a => a.size)),
            bold: num[0].bold, italic: num[0].italic,
            frac: { num, den },
            fracHeight: mid,
            spaceBefore: false,
        };
        const gone = new Set([...num, ...den]);
        list = list.filter(t => !gone.has(t));
        list.push(superAtom);
        changed = true;
    }
    return list;
}

/**
 * Recursive 2-D resolution: stacked numerator/denominator runs → \frac,
 * radicals swallow the next factor → \sqrt, stretch delimiters → \left/\right,
 * diagonal small atoms attach as scripts, big-operator limits → \sum\limits.
 * `axis` is this level's reference baseline; recursion re-derives it per
 * nested group.
 *
 * Coordinates are the page's own (pdfjs text items, y increasing DOWNWARD), so
 * "above" is the SMALLER y — the convention every other module in the tool
 * uses for text baselines.
 */
export function mathToLatex(atoms, axis, topLevel = true, depth = 0) {
    let gl = [...atoms].sort((a, b) => a.left - b.left);
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

    // Pull each big operator's limits out of the x-ordered stream. The map
    // keys are the OPERATORS and the values are the limit atoms — it is the
    // VALUES that must leave the stream, not the operators.
    const absorbed = _absorbBigOpLimits(gl, base);
    if (absorbed.size) {
        const limitAtoms = new Set();
        for (const { subs, sups } of absorbed.values()) {
            for (const t of subs) limitAtoms.add(t);
            for (const t of sups) limitAtoms.add(t);
        }
        gl = gl.filter(a => !limitAtoms.has(a));
    }

    // +1 numerator (well above axis), -1 denominator (well below), 0 on-axis.
    const fracLevel = a => {
        if (_isStretchDelim(a, medSize)) return 0;
        const dy = a.y - axis;
        if (dy < -0.34 * base) return 1;
        if (dy > 0.30 * base) return -1;
        return 0;
    };
    const small = a => a.size < 0.85 * base;
    // Diagonal script: a small atom nudged off the axis — gentler thresholds
    // than a fraction, which sits a full half-line away.
    const scriptLevel = a => {
        if (!small(a)) return 0;
        const dy = a.y - axis;
        if (dy < -0.10 * base) return 1;
        if (dy > 0.05 * base) return -1;
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
            // A variable directly after a scripted base or a \frac closes up:
            // it is an implicit product (x_i y_j, \frac{1}{2}g t²), not a word.
            const implicitProduct = topLevel && (prevScripted || prevStr === '') &&
                /^[A-Za-z0-9]/.test(cur);
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

        // (0.4) A pre-collapsed fraction super-atom (nested fractions).
        if (a.frac) {
            sepBefore(a, a.spaceBefore);
            out += '\\frac{' + mathToLatex(a.frac.num, mathAxis(a.frac.num), false, depth + 1) + '}' +
                   '{' + mathToLatex(a.frac.den, mathAxis(a.frac.den), false, depth + 1) + '}';
            prevRight = a.right;
            prevStr = '';
            prevScripted = false;
            i++;
            continue;
        }

        // (0.5) A big operator with absorbed limits: \sum\limits_{sub}^{sup}.
        if (BIG_OPERATORS[a.str] && absorbed.has(a)) {
            const { subs, sups } = absorbed.get(a);
            sepBefore(a, a.spaceBefore);
            let body = BIG_OPERATORS[a.str] + '\\limits';
            if (subs.length) body += '_{' + mathToLatex(subs, mathAxis(subs), false, depth + 1) + '}';
            if (sups.length) body += '^{' + mathToLatex(sups, mathAxis(sups), false, depth + 1) + '}';
            out += body;
            prevRight = Math.max(a.right, ...(subs.concat(sups).map(t => t.right)));
            prevStr = a.str;
            prevScripted = true;
            i++;
            continue;
        }

        // (1) A fraction stack: consecutive off-axis atoms carrying both a
        // numerator and a denominator.
        if (fracLevel(a) !== 0) {
            let j = i, hasUp = false, hasDown = false;
            while (j < n && fracLevel(gl[j]) !== 0 && !_isStretchDelim(gl[j], medSize)) {
                if (fracLevel(gl[j]) > 0) hasUp = true; else hasDown = true;
                j++;
            }
            const run = gl.slice(i, j);
            const allSmall = run.every(t => small(t));
            let scripted = false;
            if (hasUp && hasDown) {
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
                       a.left >= prevRight - a.size &&
                       a.left <= prevRight + 0.6 * base) {
                // Small atoms ADJACENT to the previous operand but farther
                // off-axis than the script band — an exponent riding a tall
                // \right paren. Attach as ordinary scripts.
                const sups = run.filter(t => t.y < axis);
                const subs = run.filter(t => t.y > axis);
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
                // digits with no real gap), plus any scripts riding it —
                // interleaved (b^2 - 4ac: row, script, row, ...). Gaps are
                // measured from the FURTHEST atom absorbed so far; a binop
                // like `-` sits slightly further out than a product.
                rad.push(gl[i]);
                i++;
                let rowLeft = rad[0].left;
                let rowRight = rad[0].right;
                while (i < n) {
                    const next = gl[i];
                    if (fracLevel(next) === 0 && scriptLevel(next) === 0) {
                        const isBinop = /^[-+\u00b1=]$/.test(next.str);
                        if (!isBinop && !/^[A-Za-z0-9]/.test(next.str)) break;
                        const gate = isBinop ? 0.45 * base : 0.2 * base;
                        if (next.left - rowRight > gate) break;
                        rad.push(next);
                        rowRight = Math.max(rowRight, next.right);
                        i++;
                    } else if (scriptLevel(next) !== 0) {
                        // Scripts only join the radicand when their center
                        // still sits over it (\sqrt{n^2}); a script riding the
                        // radical's top-right corner is an OUTSIDE exponent
                        // left for branch (4) — \sqrt{n-1}^2.
                        const cx = (next.left + next.right) / 2;
                        if (cx < rowLeft || cx > rowRight + 0.25 * base) break;
                        rad.push(next);
                        rowRight = Math.max(rowRight, next.right);
                        i++;
                    } else break;
                }
            }
            // Radicand row sits on the math axis of the current frame.
            out += `\\sqrt{${mathToLatex(rad, axis, false, depth + 1)}}`;
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

        // Tight postfix: a factorial/prime mark attaches to the preceding
        // operand whatever its run, style, or the gap says.
        if (i < n && TIGHT_POSTFIX_RE.test(gl[i].str) &&
            Math.abs(gl[i].y - axis) < 0.25 * base) {
            out = out.replace(/ +$/, '');
            out += latexOf(gl[i].str);
            prevRight = Math.max(prevRight, gl[i].right);
            prevStr = gl[i].str;
            i++;
        }

        // (4) Diagonal sub/superscripts trailing this operand; recurse so a
        // script can itself carry structure. Scripts TRAIL their base — an
        // atom that starts well inside the operand's x-range is drawn over it
        // (an overset annotation) and is left for branch (1). They must also be
        // SMALL and horizontally NEAR the base: a following \frac's full-size
        // numerator, or a fraction starting a body-width away, is the next
        // operand, not a script.
        const subs = [], sups = [];
        while (i < n && scriptLevel(gl[i]) !== 0 && !_isStretchDelim(gl[i], medSize) &&
               small(gl[i]) &&
               gl[i].left - prevRight < 1.6 * base &&
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
 *
 * `opts.force` skips the detection gate — the caller has already decided this
 * region is an equation (the user tagged it MATH by hand). Reconstruction can
 * still fail, in which case this returns null and the caller renders prose.
 */
export function buildDisplayMath(items, opts = {}) {
    const atoms = atomsFromItems(items);
    if (!atoms.length) return null;
    const medSize = _median(atoms.map(a => a.size));
    if (!opts.force && !isDisplayMath(atoms, medSize)) return null;
    // Body size mirrors mathToLatex's: the largest NON-radical, non-stretch
    // atom. A √ or \left( sized to the whole stack would inflate every dy/size
    // threshold below and starve genuine fraction rows.
    const body = bodySize(atoms, medSize);
    // Collapse fraction stacks (incl. nesting) before the linear pass. The
    // gate size is the BODY size (largest atom) — scripts and sum limits are
    // smaller and must stay out of fraction pairing.
    const collapsed = _collapseFractions(atoms, body);
    const latex = mathToLatex(collapsed, mathAxis(collapsed), true, 0);
    return latex ? latex : null;
}
