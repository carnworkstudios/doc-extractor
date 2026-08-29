// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 carnworkstudios
// mathRegionMerger.js — rejoins a display equation that the line grouper split.
//
// THE FAILURE THIS FIXES ──────────────────────────────────────────────────────
// The text grouper cuts a new region wherever the vertical gap between lines
// exceeds the paragraph gap. That is right for prose and wrong for an equation,
// because an equation IS a vertical stack: a summation's limits sit a full line
// above and below the operator, a fraction's numerator and denominator sit on
// their own baselines, and the equation number sits on the axis at the margin.
// Each of those lands in its own region, so one equation arrives as three or
// four, and the LaTeX builder — which resolves structure from the geometry of
// the atoms it is given — sees a numerator with no denominator and emits
// `\frac{\ldots}{\frac{N}{k=1}}` for what is a sum's limits.
//
// A fragment is also not a usable artifact: an Equations tab listing four rows
// per equation, three of which are "N" and "k=1", is a list nobody can act on.
//
// THE RULE ────────────────────────────────────────────────────────────────────
// Merge two vertically adjacent regions in the same column when the COMBINED
// atom set reads as display math and neither part is prose. The combined test
// is what keeps this safe: isDisplayMath() caps a group at four baselines and
// rejects anything alphabetic-heavy, so a runaway merge fails its own gate
// rather than swallowing the paragraph underneath.
//
// This only rejoins regions. Whether the result becomes MATH is still the
// assembler's decision, made by the same gate on the same atoms — one detector,
// not two that can disagree.

import { RegionType } from './regionTypes.js';
import { atomsFromItems, isDisplayMath, bodySize } from '../mathBuilder.js';

// Only text regions can be fragments of an equation. A table or a picture that
// happens to sit under one is a different artifact.
const MERGEABLE = new Set([RegionType.PARAGRAPH, RegionType.MATH]);

// How far apart two fragments of one equation can sit, in body-size units. A
// stacked limit clears the operator by about one line; two full paragraphs are
// separated by the paragraph gap, which is larger and column-wide.
const MAX_GAP_FACTOR = 1.4;

// A lone equation number — "(12)", "(12)," — is the one fragment that carries
// no math at all and still belongs to the equation beside it.
const TAG_ONLY_RE = /^\(?\d{1,3}[a-z]?\)?[.,]?$/;

function _text(region, textMeta) {
    return (region.textItemIndices || [])
        .map(i => textMeta[i]?.str ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function _atoms(region, textItems) {
    return atomsFromItems((region.textItemIndices || []).map(i => textItems[i]).filter(Boolean));
}

/**
 * Is this fragment plausibly part of an equation on its own?
 *
 * Deliberately weaker than isDisplayMath: a summation's limit row ("k=1") is
 * not display math by itself and is exactly what has to be rejoined. What it
 * must NOT be is a sentence.
 */
function _isFragment(region, textMeta, atoms, base) {
    const text = _text(region, textMeta);
    if (!text) return false;
    if (TAG_ONLY_RE.test(text)) return true;
    if (isDisplayMath(atoms, base)) return true;
    // Words at body size are prose; symbols, digits and single letters are not.
    const words = (text.match(/[A-Za-z]{3,}/g) || []).join('').length;
    return words / text.length < 0.3;
}

/**
 * Can these two regions be parts of one equation, spatially?
 *
 * Column index alone is the wrong test, and getting it wrong is what left every
 * summation split: the equation BODY spans the measure and is filed full-width
 * (-1), while its limit stack is narrow and gets a real column index. Bucketing
 * by column therefore put the two halves of one equation in different buckets
 * and they could never meet.
 *
 * What actually has to hold is that they are not on opposite sides of a gutter,
 * and horizontal overlap says that directly.
 */
function _sameFlow(a, b) {
    const ca = a.columnIndex ?? -1, cb = b.columnIndex ?? -1;
    if (ca !== cb && ca !== -1 && cb !== -1) return false;
    const left = Math.max(a.bbox.x, b.bbox.x);
    const right = Math.min(a.bbox.x + a.bbox.w, b.bbox.x + b.bbox.w);
    return right > left;
}

/**
 * Rejoin split display equations, in place.
 *
 * @param {Array} regions   — the page's typed regions
 * @param {Array} textItems — raw pdfjs text items (index-aligned with textMeta)
 * @param {Array} textMeta  — per-item metadata
 * @param {object} scale    — PageScale; `S` is the body font size in viewport px
 * @returns {Array} the surviving regions
 */
export function mergeMathRegions(regions, textItems, textMeta, scale) {
    const S = scale?.S || 16;
    const list = regions
        .filter(r => r && r.bbox && MERGEABLE.has(r.type))
        .sort((a, b) => a.bbox.y - b.bbox.y);

    const absorbed = new Set();

    function _absorb(head, next) {
        head.textItemIndices = (head.textItemIndices || []).concat(next.textItemIndices || []);
        const x0 = Math.min(head.bbox.x, next.bbox.x);
        const y0 = Math.min(head.bbox.y, next.bbox.y);
        const x1 = Math.max(head.bbox.x + head.bbox.w, next.bbox.x + next.bbox.w);
        const y1 = Math.max(head.bbox.y + head.bbox.h, next.bbox.y + next.bbox.h);
        head.bbox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        head.yCenter = y0 + (y1 - y0) / 2;
        head.mathMerged = (head.mathMerged || 1) + 1;
        absorbed.add(next);
    }

    function _pass() {
        let changed = false;
        for (let i = 0; i < list.length - 1; i++) {
            const head = list[i];
            if (absorbed.has(head)) continue;

            for (let j = i + 1; j < list.length; j++) {
                const next = list[j];
                if (absorbed.has(next)) continue;

                const gap = next.bbox.y - (head.bbox.y + head.bbox.h);
                if (gap > S * MAX_GAP_FACTOR) break;
                // Not a reason to stop scanning: a full-width caption can sit
                // between an equation's two halves in y without being part of
                // either, and stopping there would strand them.
                if (!_sameFlow(head, next)) continue;

                const headAtoms = _atoms(head, textItems);
                const nextAtoms = _atoms(next, textItems);
                if (!headAtoms.length || !nextAtoms.length) break;

                const merged = headAtoms.concat(nextAtoms);
                const base = bodySize(merged, S);
                if (!isDisplayMath(merged, base)) break;
                if (!_isFragment(head, textMeta, headAtoms, base)) break;
                if (!_isFragment(next, textMeta, nextAtoms, base)) break;

                _absorb(head, next);
                changed = true;
            }
        }
        return changed;
    }

    // Repeat until nothing more absorbs. One pass is not enough because a
    // fragment can only become mergeable AFTER its own pieces have joined: a
    // summation's upper and lower limits are two regions straddling the
    // operator row, and neither reads as math alone — the pair does, and only
    // then does the pair merge with the operator.
    while (_pass()) { /* until fixpoint */ }

    if (!absorbed.size) return regions;
    // Reading order must follow the merged geometry, not the pre-merge one.
    const kept = regions.filter(r => !absorbed.has(r));
    kept.sort((a, b) => (a.yCenter ?? 0) - (b.yCenter ?? 0));
    return kept;
}
