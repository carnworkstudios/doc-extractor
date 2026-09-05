// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// vlmReport.js — turns the deterministic findings plus Head B's signals into
// prose, using a local vision model through ollama.
//
// THE HARD REQUIREMENT, AND WHY ASKING NICELY IS NOT ENOUGH
// ---------------------------------------------------------
// Every conclusion in the output must be labelled `observed`, `inferred` or
// `uncertain`, and the model must never present an inference as an observation.
//
// A prompt cannot enforce that. Language models are extremely good at writing
// the word "observed" next to something they reasoned their way to, and the
// failure is invisible in the output — a fluent, confident, well-structured
// report that quietly promotes a guess to a measurement is worse than no report,
// because it is more persuasive.
//
// So the enforcement is structural, in three layers, and the model can only
// lose:
//
//   1. It is given ONLY the deterministic findings, each already tiered and
//      carrying a stable id, and Head B's signal values. It is given no image
//      it can measure and no numbers it can derive. There is nothing in its
//      context it could honestly call an observation of its own.
//
//   2. It must answer in a JSON schema where every conclusion carries `tier`
//      and `basis` (an array of finding ids). `validateReport()` then checks —
//      not the prose, the STRUCTURE:
//        * every cited id exists;
//        * a conclusion tiered `observed` cites ONLY findings that were
//          themselves `observed`, and adds no numbers that are not in those
//          findings' `measurements`;
//        * a conclusion tiered `inferred` cites at least one finding.
//      A conclusion that fails is DOWNGRADED, not dropped — silently deleting
//      it would hide that the model overreached, and that is itself a finding
//      about the report.
//
//   3. Numbers in the prose are checked against the numbers in the cited
//      findings. A figure the model invented does not appear in any
//      `measurements` object and the conclusion carrying it is downgraded.
//
// The model is therefore a WRITER, not an analyst. Everything it can say is
// already true before it says it; its job is to say it in an order a human can
// read.
//
// WHY THE VLM IS ALLOWED NEAR THIS AT ALL
// ---------------------------------------
// The licensing rules bar the local models from producing anything that trains
// shipped weights, because their provenance is not verifiable. Narrative
// generation at runtime is a different thing entirely: nothing it emits is
// redistributed and nothing it emits is a fact. Region crops are passed so the
// prose can describe what a flagged area LOOKS like, which is genuinely useful
// and is exactly the kind of claim that belongs in the `uncertain` tier.

const DEFAULT_MODEL = 'qwen3.6:35b-mlx';
const DEFAULT_HOST = 'http://127.0.0.1:11434';

/**
 * The schema the model must fill. Sent verbatim as ollama's `format`, which
 * constrains decoding rather than merely requesting a shape — a model that
 * would have emitted prose cannot.
 */
export const REPORT_SCHEMA = {
    type: 'object',
    required: ['summary', 'conclusions'],
    properties: {
        summary: { type: 'string', maxLength: 600 },
        conclusions: {
            type: 'array',
            // BOUNDED, and every bound here is load-bearing.
            //
            // An unbounded array plus an unbounded string is an invitation to a
            // degenerate loop, and constrained decoding does not prevent one —
            // it only guarantees the output is well-formed UNTIL the token
            // budget runs out, at which point you get a truncated string and a
            // JSON parse error. Measured: `glm-ocr` emitted 60,807 characters
            // and `deepseek-ocr` 21,281 before both were cut off mid-string.
            //
            // OCR-specialised models are especially prone to it — they are
            // trained to transcribe, so given a wall of text they keep going —
            // but the schema was the defect, not the model.
            maxItems: 12,
            items: {
                type: 'object',
                required: ['tier', 'statement', 'basis'],
                properties: {
                    tier: { type: 'string', enum: ['observed', 'inferred', 'uncertain'] },
                    statement: { type: 'string', maxLength: 400 },
                    basis: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 12 } },
                    page: { type: ['integer', 'null'] },
                },
            },
        },
        recommendedAction: { type: 'string', maxLength: 400 },
    },
};

const SYSTEM = `You write forensic summaries of scanned and born-digital documents.

You have NOT seen the document. You are given findings that other tools measured, and
signal values that a model predicted. You may only write about those.

Every conclusion you write carries exactly one tier:

  observed   The thing was directly MEASURED by one of the findings you were given.
             You may only use this tier when you are restating a finding that is
             itself marked "observed", and you must cite its id in basis[].
             You may not state a number that is not in that finding's measurements.

  inferred   A conclusion you reasoned to from findings you were given. Cite every
             finding you reasoned from in basis[]. Say what follows from what.

  uncertain  A guess, a possible explanation, or anything you cannot ground in a
             cited finding. Use this tier freely — it is not a failure to use it.
             It is a failure to avoid it by mislabelling a guess as inferred.

Never write a conclusion tiered "observed" that you reasoned to. Restating a
measurement is observed. Concluding anything from it is inferred. If you are
unsure which, use the weaker tier.

Do not hedge inside the statement text. The tier does the hedging. Write plainly.`;

/**
 * Build the prompt payload. Exported separately from `generateReport` so the
 * tests can assert on what the model is told without needing ollama running.
 */
export function buildPrompt(det, signals = null, opts = {}) {
    const facts = det.findings.map((f) => ({
        id: f.id,
        tier: f.tier,
        check: f.check,
        statement: f.summary,
        measurements: f.measurements,
        page: f.region ? f.region.page : null,
        severity: f.severity,
    }));

    const lines = [
        `Document: ${det.document || '(unnamed)'} — ${det.pages} page(s).`,
        '',
        'Checks that ran, and their state:',
        ...Object.entries(det.analysers || {}).map(([k, v]) => `  ${k}: ${v}`),
        '',
        'A check marked could-not-run found NOTHING BECAUSE IT DID NOT RUN. Never',
        'describe such a check as having found the document clean.',
        '',
        'FINDINGS (these are the only facts you have):',
        JSON.stringify(facts, null, 1),
    ];

    if (signals) {
        lines.push('',
            'Page-level forensic signals, predicted by a learned model (these are',
            'PREDICTIONS, not measurements — any conclusion resting on them alone is at',
            'best "inferred", and describing one as "observed" is wrong):',
            JSON.stringify(signals, null, 1));
    }
    if (opts.cropNote) lines.push('', opts.cropNote);

    return { system: SYSTEM, prompt: lines.join('\n') };
}

/**
 * Structural validation. This is the enforcement; the prompt is only guidance.
 *
 * @param {object} parsed        what the model returned
 * @param {object} det           the deterministic report it was given
 * @returns {{report:object, violations:Array}}
 */
export function validateReport(parsed, det) {
    const byId = new Map(det.findings.map((f) => [f.id, f]));
    const violations = [];
    const conclusions = [];

    for (const [i, c] of (parsed.conclusions || []).entries()) {
        let tier = ['observed', 'inferred', 'uncertain'].includes(c.tier) ? c.tier : 'uncertain';
        const basis = (c.basis || []).filter((b) => byId.has(b));
        const dropped = (c.basis || []).filter((b) => !byId.has(b));
        if (dropped.length) {
            violations.push({ index: i, kind: 'unknown-basis', ids: dropped });
            tier = downgrade(tier);
        }

        if (tier === 'observed') {
            const nonObserved = basis.filter((b) => byId.get(b).tier !== 'observed');
            if (!basis.length) {
                violations.push({ index: i, kind: 'observed-without-basis' });
                tier = 'uncertain';
            } else if (nonObserved.length) {
                // Citing an inference as the basis for an observation is the
                // exact move the user asked to be made impossible.
                violations.push({ index: i, kind: 'observed-cites-non-observed',
                                  ids: nonObserved });
                tier = 'inferred';
            } else {
                // Number check: every figure in the statement must appear in
                // the cited findings' measurements.
                const allowed = new Set();
                for (const b of basis) collectNumbers(byId.get(b).measurements, allowed);
                const invented = numbersIn(c.statement).filter(
                    (n) => !nearAny(n, allowed));
                if (invented.length) {
                    violations.push({ index: i, kind: 'invented-number', values: invented });
                    tier = 'inferred';
                }
            }
        } else if (tier === 'inferred' && !basis.length) {
            violations.push({ index: i, kind: 'inferred-without-basis' });
            tier = 'uncertain';
        }

        conclusions.push({
            tier,
            statement: String(c.statement || '').trim(),
            basis,
            page: Number.isInteger(c.page) ? c.page : null,
            // When a tier was lowered, say so on the conclusion itself. A reader
            // is entitled to know the writer overreached here.
            downgradedFrom: tier !== c.tier ? c.tier : undefined,
        });
    }

    // ── degenerate repetition ───────────────────────────────────────────────
    //
    // A model that has lost the thread does not emit ONE bad conclusion, it
    // emits the same bad conclusion until it runs out of budget. Measured:
    // `deepseek-ocr` produced 12 conclusions that were all the sentence "The
    // document is a scanned document. It is not a born-digital document."
    //
    // Every one was correctly downgraded to `uncertain`, so nothing false
    // reached the reader labelled as fact — but twelve copies of a guess still
    // read as twelve findings. Duplicates are collapsed to the first, and the
    // collapse is RECORDED, because "the writer repeated itself twelve times"
    // is a fact about the report worth surfacing rather than tidying away.
    const seen = new Map();
    const deduped = [];
    let repeats = 0;
    for (const c of conclusions) {
        const key = c.statement.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
        if (key && seen.has(key)) {
            seen.set(key, seen.get(key) + 1);
            repeats++;
            continue;
        }
        if (key) seen.set(key, 1);
        deduped.push(c);
    }
    if (repeats) {
        violations.push({
            kind: 'degenerate-repetition',
            removed: repeats,
            worst: [...seen.entries()].sort((a, b) => b[1] - a[1])[0],
        });
    }

    return {
        report: {
            v: 1,
            model: parsed._model || null,
            summary: String(parsed.summary || '').trim(),
            recommendedAction: String(parsed.recommendedAction || '').trim() || null,
            conclusions: deduped,
            counts: deduped.reduce((a, c) => ({ ...a, [c.tier]: (a[c.tier] || 0) + 1 }),
                                   { observed: 0, inferred: 0, uncertain: 0 }),
            // The violation list ships WITH the report rather than being logged
            // and forgotten. A report whose writer had to be corrected eleven
            // times is a report to read more carefully.
            integrity: {
                violations,
                clean: violations.length === 0,
                // A report in which nothing survived validation as `observed` or
                // `inferred` is a report the model failed to write. Saying so
                // explicitly saves every caller from re-deriving it, and stops a
                // wall of `uncertain` lines being mistaken for cautious analysis.
                usable: deduped.some((c) => c.tier !== 'uncertain'),
            },
        },
        violations,
    };
}

const downgrade = (t) => (t === 'observed' ? 'inferred' : 'uncertain');

function collectNumbers(obj, into, depth = 0) {
    if (depth > 4 || obj == null) return;
    if (typeof obj === 'number') { into.add(obj); return; }
    if (Array.isArray(obj)) { for (const v of obj) collectNumbers(v, into, depth + 1); return; }
    if (typeof obj === 'object') {
        for (const v of Object.values(obj)) collectNumbers(v, into, depth + 1);
    }
}

function numbersIn(s) {
    return [...String(s).matchAll(/-?\d+(?:\.\d+)?/g)]
        .map((m) => Number(m[0]))
        .filter((n) => Number.isFinite(n)
            // Small integers are page numbers, counts and ordinals that appear
            // in every sentence. Policing them would reject correct prose and
            // teach nobody anything; the numbers worth checking are the
            // measured ones.
            && !(Number.isInteger(n) && Math.abs(n) <= 20));
}

function nearAny(n, allowed) {
    for (const a of allowed) {
        if (a === n) return true;
        // The model will legitimately round 0.0413 to 0.04 and 84.2 to 84.
        const tol = Math.max(Math.abs(a) * 0.06, 1e-4);
        if (Math.abs(a - n) <= tol) return true;
        if (Math.abs(a * 100 - n) <= Math.max(Math.abs(a * 100) * 0.06, 0.5)) return true;
    }
    return false;
}

/**
 * Run the model. Node or browser; uses fetch against the ollama HTTP API so
 * there is no ollama SDK dependency.
 *
 * @param {object} det        deterministic report from analyseDocument()
 * @param {object|null} signals  physical Head B values from readSignals()
 * @param {object} [opts]  { model, host, crops: [dataUrl], timeoutMs }
 */
export async function generateReport(det, signals = null, opts = {}) {
    const model = opts.model || DEFAULT_MODEL;
    const host = opts.host || DEFAULT_HOST;
    const crops = opts.crops || [];
    const { system, prompt } = buildPrompt(det, signals, {
        cropNote: crops.length
            ? `${crops.length} crop(s) of flagged regions are attached. You may describe `
              + 'what they look like, but a visual impression is never "observed" — it is '
              + 'at best "uncertain", because you are looking at a picture, not measuring it.'
            : '',
    });

    const body = {
        model,
        stream: false,
        format: REPORT_SCHEMA,
        // Thinking OFF by default.
        //
        // `qwen3.6:35b-mlx` is a reasoning model: given a schema and a budget it
        // spends the budget on thinking tokens and emits NOTHING. Measured
        // exactly that — `done_reason: "length"` with a 0-character content
        // field, which then surfaced as "truncated at 0 chars".
        //
        // Thinking buys nothing here anyway. Every fact is supplied, the tiers
        // are validated afterwards by validateReport(), and the model's job is
        // to order and phrase — not to work anything out. Callers who want it
        // can pass `think: true`.
        think: opts.think === true,
        // Low temperature: this is a formatting task over supplied facts, and
        // sampling diversity here only buys more chances to invent a number.
        //
        // `num_predict` is a HARD stop, belt to the schema's braces. A model
        // that ignores `maxItems` still cannot spend more than this, so a
        // runaway costs seconds instead of minutes. 1500 tokens is roughly
        // three times the longest well-formed report observed.
        options: { temperature: 0.15, num_ctx: opts.numCtx || 16384, num_predict: opts.numPredict || 2000 },
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt,
              ...(crops.length ? { images: crops.map(stripDataUrl) } : {}) },
        ],
    };

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 300000);
    let raw;
    try {
        const res = await fetch(`${host}/api/chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
        raw = await res.json();
    } finally {
        clearTimeout(timer);
    }

    let parsed;
    const content = raw.message?.content ?? '{}';
    try {
        parsed = JSON.parse(content);
    } catch (e) {
        // A model that could not produce the schema does not get to produce a
        // report at all. Salvaging prose out of a malformed response would mean
        // shipping text that never went through validateReport(), which is the
        // only thing standing between a guess and an "observation".
        //
        // Truncation is called out separately because it is a DIFFERENT problem
        // with a different fix: the model did not fail to understand the task,
        // it ran out of budget mid-sentence, and the answer is a tighter bound
        // rather than a different model.
        const truncated = raw.done_reason === 'length'
            || /Unterminated|Unexpected end of (JSON|input)/i.test(e.message);
        throw new Error(
            (truncated
                ? `model output was TRUNCATED at ${content.length} chars `
                  + `(done_reason=${raw.done_reason}); it exceeded the token budget `
                  + 'before closing the JSON'
                : 'model did not return valid JSON for the report schema')
            + `: ${e.message}`);
    }
    parsed._model = model;
    const { report, violations } = validateReport(parsed, det);
    return { ...report, generatedAt: new Date().toISOString(), violationCount: violations.length };
}

function stripDataUrl(s) {
    const i = String(s).indexOf('base64,');
    return i >= 0 ? String(s).slice(i + 7) : s;
}

export const _internals = { numbersIn, nearAny, collectNumbers, downgrade, SYSTEM };
