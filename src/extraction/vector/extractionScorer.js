// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// extractionScorer.js — checker v0: deterministic verification of a page extraction.
//
// Pure function, no DOM, no AI. Grades what the pipeline produced so that
// re-extraction attempts (human sliders or AI-proposed parameters) can be
// compared objectively. This is the verifier the AI tune loop is scored
// against — the AI never grades its own output.
//
// All metrics are computed from data the worker already has: regions
// (type/bbox/confidence) and textMeta (baseline positions). No rendering.

const TABLE_TYPES = new Set(['LATTICE_TABLE', 'STREAM_TABLE', 'TABLE']);
// Chrome regions — expected to hold little body text
const CHROME_TYPES = new Set(['HEADER', 'FOOTER', 'DIVIDER']);

function _inside(x, y, b, pad = 0) {
    return x >= b.x - pad && x <= b.x + b.w + pad &&
           y >= b.y - pad && y <= b.y + b.h + pad;
}

function _overlapArea(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Score one page's extraction result.
 *
 * @param {Array}  regions  — classifier output: {type, bbox, confidence, algorithm}
 * @param {Array}  textMeta — viewport text items: {str, vx, vy, vWidth, vFont}
 * @param {object} viewport — {width, height}
 * @returns verification report (plain JSON, structured-clone safe)
 */
export function scoreExtraction(regions, textMeta, viewport) {
    const boxed = (regions || []).filter(r => r.bbox && !r.skip);
    const text  = (textMeta || []).filter(t => t.str?.trim());

    // ── Text coverage: every text item should land in some region ────────────
    let covered = 0;
    for (const t of text) {
        const cx = t.vx + (t.vWidth || 0) / 2;
        if (boxed.some(r => _inside(cx, t.vy, r.bbox, 2))) covered++;
    }
    const textCoverage = text.length ? covered / text.length : 1;

    // ── Region overlap: same-area double claims signal misclassification ─────
    // Pairwise overlap between non-chrome regions, normalized by total area.
    let overlapArea = 0, totalArea = 0;
    const solid = boxed.filter(r => !CHROME_TYPES.has(r.type));
    for (let i = 0; i < solid.length; i++) {
        const a = solid[i].bbox;
        totalArea += a.w * a.h;
        for (let j = i + 1; j < solid.length; j++) {
            overlapArea += _overlapArea(a, solid[j].bbox);
        }
    }
    const overlapRatio = totalArea ? Math.min(1, overlapArea / totalArea) : 0;

    // ── Confidence distribution ───────────────────────────────────────────────
    const confs = boxed.map(r => r.confidence ?? 1);
    const meanConfidence = confs.length
        ? confs.reduce((s, c) => s + c, 0) / confs.length : 1;
    const lowConfidenceCount = confs.filter(c => c < 0.6).length;

    // ── Table integrity ───────────────────────────────────────────────────────
    const tables = boxed.filter(r => TABLE_TYPES.has(r.type));
    const weakTables = tables.filter(r => (r.confidence ?? 1) < 0.6).length;

    // ── Fragmentation: many tiny regions on a text-bearing page suggests the
    // classifier shattered coherent blocks (bad Y-band / para-gap fit) ────────
    const pageArea = (viewport?.width || 1) * (viewport?.height || 1);
    const tinyCount = solid.filter(r => (r.bbox.w * r.bbox.h) / pageArea < 0.001).length;
    const fragmentation = solid.length ? tinyCount / solid.length : 0;

    // ── Composite score — weights favor coverage (lost text is the worst
    // failure), then structural cleanliness ──────────────────────────────────
    const score =
        0.45 * textCoverage +
        0.20 * (1 - overlapRatio) +
        0.20 * meanConfidence +
        0.15 * (1 - fragmentation);

    return {
        score: Math.round(score * 1000) / 1000,
        textCoverage: Math.round(textCoverage * 1000) / 1000,
        uncoveredTextCount: text.length - covered,
        overlapRatio: Math.round(overlapRatio * 1000) / 1000,
        meanConfidence: Math.round(meanConfidence * 1000) / 1000,
        lowConfidenceCount,
        regionCount: boxed.length,
        tableCount: tables.length,
        weakTableCount: weakTables,
        fragmentation: Math.round(fragmentation * 1000) / 1000,
    };
}
