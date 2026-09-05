// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// findings.js — the shared shape of every forensic claim, and the three-way
// epistemic split that the whole module (and the VLM report downstream) is
// built around.
//
// WHY A FINDING IS NOT JUST A STRING
// ----------------------------------
// A forensics report that says "this page was altered" is worse than useless in
// the one setting it matters — somebody is going to act on it. The distinction
// that has to survive from the measurement all the way to the sentence a human
// reads is:
//
//   observed   Something was MEASURED. The quantisation table changes at
//              x=412. The noise floor inside this rectangle is 0.004 and
//              outside it is 0.031. These are facts about the file; they are
//              true whether or not anything is wrong.
//
//   inferred   A reasoned conclusion FROM observations, with the observations
//              named. "A rectangular region with a different noise floor and a
//              broken resampling grid is consistent with a pasted patch."
//
//   uncertain  A guess. It may be a good guess. It is still a guess, and it is
//              labelled so nobody quotes it as a finding.
//
// This is the same distinction `pageAssembler` already draws when it typesets
// display math and keeps `data-math-suggested` on the block until a human
// confirms it, retaining the page's own glyphs in `data-math-source`. The
// vocabulary is reused deliberately: one epistemic discipline, applied in two
// places, is easier to hold than two.
//
// THE STRUCTURAL PART
// -------------------
// `tier` is a REQUIRED field on the constructor and there is no default. It is
// not possible to emit a finding without deciding what kind of claim it is.
// `observed()` additionally REQUIRES `measurements`, because an observation
// with nothing measured is an inference wearing a better hat — that is the
// exact failure the user asked to be prevented structurally rather than by
// asking the model nicely.

export const TIERS = Object.freeze(['observed', 'inferred', 'uncertain']);

/**
 * @typedef {object} Finding
 * @property {string} id            stable within a run; the VLM report cites it
 * @property {string} check         which analyser produced it
 * @property {'observed'|'inferred'|'uncertain'} tier
 * @property {string} summary       one line, no hedging language — the tier hedges
 * @property {object} measurements  the numbers. REQUIRED for `observed`.
 * @property {string[]} basis       ids of the findings this one reasons from
 * @property {object|null} region   {page, x, y, w, h} when it is localisable
 * @property {number} severity      0..1; how much it should move a reader
 */

let _seq = 0;

function make(check, tier, summary, opts = {}) {
    if (!TIERS.includes(tier)) throw new Error(`bad tier: ${tier}`);
    const measurements = opts.measurements || {};
    if (tier === 'observed' && Object.keys(measurements).length === 0) {
        // Hard failure, not a warning. An `observed` finding with no
        // measurements is the thing this file exists to make impossible.
        throw new Error(`observed finding "${summary}" carries no measurements`);
    }
    if (tier === 'inferred' && !(opts.basis || []).length) {
        throw new Error(`inferred finding "${summary}" cites no basis`);
    }
    return Object.freeze({
        id: `f_${String(++_seq).padStart(4, '0')}`,
        check,
        tier,
        summary,
        measurements,
        basis: Object.freeze([...(opts.basis || [])]),
        region: opts.region || null,
        severity: typeof opts.severity === 'number'
            ? Math.max(0, Math.min(1, opts.severity)) : 0,
    });
}

/** A direct measurement. `measurements` is mandatory. */
export const observed = (check, summary, measurements, opts = {}) =>
    make(check, 'observed', summary, { ...opts, measurements });

/** A conclusion drawn from named observations. `basis` is mandatory. */
export const inferred = (check, summary, basis, opts = {}) =>
    make(check, 'inferred', summary, { ...opts, basis });

/** A guess, flagged as one. */
export const uncertain = (check, summary, opts = {}) =>
    make(check, 'uncertain', summary, opts);

/** Reset the id counter. Test-only; ids must be stable within one report. */
export function _resetIds() { _seq = 0; }

/**
 * Collect findings into the object the VLM prompt and the JSON schema consume.
 *
 * Sorted by severity then tier, so a reader who stops after three lines has
 * read the three that matter — and so that an `observed` finding always
 * outranks an `uncertain` one of equal severity. A report that opens with a
 * guess trains the reader to discount the whole document.
 */
export function report(findings, meta = {}) {
    const rank = { observed: 0, inferred: 1, uncertain: 2 };
    const sorted = [...findings].sort(
        (a, b) => (b.severity - a.severity) || (rank[a.tier] - rank[b.tier]));
    const counts = { observed: 0, inferred: 0, uncertain: 0 };
    for (const f of sorted) counts[f.tier]++;
    return {
        v: 1,
        generatedAt: new Date().toISOString(),
        ...meta,
        counts,
        findings: sorted,
    };
}
