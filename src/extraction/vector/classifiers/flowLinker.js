// flowLinker.js — paragraph continuation chains across column/zone seams.
//
// A PDF column boundary is a rendering artifact, not a semantic one: a
// paragraph that ends mid-sentence at the bottom of column N continues at the
// top of column N+1. This module finds those seams and records them as LINKS
// on the region objects (flowId / flowNext / flowPrev / flowJoin). It never
// merges regions — the spatial view keeps every fragment in its column; the
// semantic surfaces (plain text, future Markdown/DocTags) walk the chain.
//
// Merge verdict at a seam requires the punctuation signal (previous fragment
// does not end a sentence) corroborated by geometry:
//   merge = punct && (lastLineFullWidth || (notIndented && fontContinuity))
// This is stricter than "punct + any one signal": notIndented alone is
// trivially true for single-line fragments, so it only counts alongside font
// continuity. A trailing hyphen is conclusive on its own (blockers still apply).
//
// See the layout-tree notes in layoutTreeBuilder.js.

import { RegionType } from './regionTypes.js';
import { BULLET_RE, ORDERED_RE } from './listDetector.js';

// Types that flow passes around (figures/tables float in the text stream).
// HEADING / LIST / DIVIDER are deliberate breakers: they terminate chains.
const TRANSPARENT_TYPES = new Set([
    RegionType.IMAGE,
    RegionType.TABLE,
    RegionType.LATTICE_TABLE,
    RegionType.STREAM_TABLE,
    RegionType.BOX,
]);

// Terminal punctuation, allowing trailing closing quotes/brackets after it.
const CLOSERS_RE = /["'”’»›)\]\}]+$/;
const TERMINAL_RE = /[.!?:…]$/;
// ASCII hyphen, unicode hyphens, soft hyphen.
const HYPHEN_END_RE = /[-‐‑­]$/;

/**
 * Group a region's textMeta items into visual lines (by vy proximity),
 * returning lines sorted top→bottom, items within a line sorted by vx.
 */
function _regionLines(region, textMeta, yTol) {
    const items = (region.textItemIndices || [])
        .map(i => textMeta[i])
        .filter(tm => tm && tm.str && tm.str.trim());
    if (!items.length) return [];

    const sorted = [...items].sort((a, b) => a.vy - b.vy);
    const lines = [];
    for (const tm of sorted) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.y - tm.vy) <= yTol) {
            last.items.push(tm);
            last.y = (last.y * (last.items.length - 1) + tm.vy) / last.items.length;
        } else {
            lines.push({ y: tm.vy, items: [tm] });
        }
    }
    for (const l of lines) l.items.sort((a, b) => a.vx - b.vx);
    return lines;
}

function _lineText(line) {
    return line.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
}

// Running-text test: enough letters, and letters dominate the non-space mass.
function _isProse(text) {
    const letters = (text.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
    if (letters < 3) return false;
    const nonSpace = text.replace(/\s+/g, '').length || 1;
    return letters / nonSpace >= 0.35;
}

// Whole-fragment digit dominance test over grouped lines.
function _digitHeavy(lines) {
    const text = lines.map(_lineText).join(' ');
    const digits = (text.match(/[0-9]/g) || []).length;
    const letters = (text.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
    return digits > letters * 0.5;
}

function _lineRight(line) {
    return Math.max(...line.items.map(i => i.vx + (i.vWidth || 0)));
}

function _lineLeft(line) {
    return Math.min(...line.items.map(i => i.vx));
}

function _dominantFont(region, textMeta) {
    const counts = new Map();
    let sizeSum = 0, n = 0;
    for (const i of (region.textItemIndices || [])) {
        const tm = textMeta[i];
        if (!tm || !tm.str?.trim()) continue;
        counts.set(tm.fontName || '', (counts.get(tm.fontName || '') || 0) + 1);
        sizeSum += tm.fontSize || 0;
        n++;
    }
    let name = '', best = 0;
    for (const [k, c] of counts) if (c > best) { best = c; name = k; }
    return { name, avgSize: n ? sizeSum / n : 0 };
}

/**
 * Evaluate one seam candidate pair. Returns a link record or null.
 */
function _evaluateSeam(a, b, textMeta, scale) {
    const yTol = scale.yBandTolPx;
    const aLines = _regionLines(a, textMeta, yTol);
    const bLines = _regionLines(b, textMeta, yTol);
    if (!aLines.length || !bLines.length) return null;

    const aLast = aLines[aLines.length - 1];
    const bFirst = bLines[0];
    const aLastText = _lineText(aLast);
    const bFirstText = _lineText(bFirst);
    if (!aLastText || !bFirstText) return null;

    // ── Blockers ──────────────────────────────────────────────────────────
    if (BULLET_RE.test(bFirstText) || ORDERED_RE.test(bFirstText)) return null;

    // Prose gate: both seam sides must read like running text. Numeric rows,
    // axis ticks, and rule lines ("____") are table/figure debris the
    // structural detectors did not claim — never chain them.
    if (!_isProse(aLastText) || !_isProse(bFirstText)) return null;

    // Digit gates, line-level then region-level: a seam line or fragment whose
    // digits rival its letters is a stream-table remnant even when part of it
    // reads as prose ("Consolidated 10 14 11 12"). Prose keeps digits well
    // under half.
    const lineDigitHeavy = (t) => {
        const d = (t.match(/[0-9]/g) || []).length;
        const l = (t.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
        return d > l * 0.5;
    };
    if (lineDigitHeavy(aLastText) || lineDigitHeavy(bFirstText)) return null;
    if (_digitHeavy(aLines) || _digitHeavy(bLines)) return null;

    // A lone TitleCase word on the B side is almost always a missed heading
    // ("Abstract", "References"), not a continuation.
    if (/^[A-Z][a-z]+$/.test(bFirstText)) return null;

    const stripped = aLastText.replace(CLOSERS_RE, '');
    const endsTerminal = TERMINAL_RE.test(stripped);
    const endsHyphen = HYPHEN_END_RE.test(aLastText);

    // ── Signals ───────────────────────────────────────────────────────────
    // Full-width last line: compare against the region's own widest extent.
    // Needs ≥2 lines — a single line is trivially its own right edge.
    const charTol = Math.max(6, scale.S * 0.75);
    const regionRight = a.bbox ? a.bbox.x + a.bbox.w
        : Math.max(...aLines.map(_lineRight));
    const lastLineFullWidth = aLines.length >= 2 &&
        _lineRight(aLast) >= regionRight - charTol;

    // No paragraph-start indent on the continuation's first line.
    const bLeft = b.bbox ? b.bbox.x : Math.min(...bLines.map(_lineLeft));
    const notIndented = (_lineLeft(bFirst) - bLeft) < charTol;

    const fA = _dominantFont(a, textMeta);
    const fB = _dominantFont(b, textMeta);
    const fontContinuity = fA.name === fB.name &&
        Math.abs(fA.avgSize - fB.avgSize) <= 0.5;

    let merge = false;
    if (endsHyphen) {
        merge = true;
    } else if (!endsTerminal) {
        merge = lastLineFullWidth || (notIndented && fontContinuity);
    }
    if (!merge) return null;

    let join = 'space';
    if (endsHyphen) {
        join = /^[a-zà-öø-ÿ]/.test(bFirstText)
            ? 'dehyphenate' : 'hyphen-keep';
    }

    return {
        join,
        signals: {
            endsHyphen,
            noTerminalPunct: !endsTerminal,
            lastLineFullWidth,
            notIndented,
            fontContinuity,
        },
    };
}

/**
 * Boundary flow region of a block: last (dir=-1) or first (dir=+1) region,
 * skipping transparent types at the boundary. Returns null when the boundary
 * region is a breaker (HEADING/LIST/DIVIDER/…) or the block has no flow text.
 */
function _boundaryFlowRegion(block, dir) {
    const seq = dir === 1 ? block : [...block].reverse();
    for (const r of seq) {
        if (TRANSPARENT_TYPES.has(r.type)) continue;
        return r.type === RegionType.PARAGRAPH ? r : null;
    }
    return null;
}

/**
 * Link paragraph continuation chains across column and zone seams on one page.
 *
 * Mutates PARAGRAPH regions in place with flowId / flowNext / flowPrev /
 * flowJoin. Returns the link records for diagnostics/manifest.
 *
 * @param {PageRegion[]} regions      — classified regions (post caption-merge)
 * @param {TextMetaItem[]} textMeta   — viewport-enriched text items
 * @param {object[]} autoZones        — from _detectAutoZones (y0/y1/cols/_zoneSplits)
 * @param {object[]} columnSplits     — normalized [{x, leftFraction}]
 * @param {PageScale} scale           — page-adaptive thresholds
 * @param {number} pageWidth          — viewport width px
 * @param {number} pageNum            — 1-based page number
 */
export function linkFlows(regions, textMeta, autoZones, columnSplits, scale, pageWidth, pageNum) {
    // Build reading-order blocks: zones top→bottom, columns left→right.
    const blocks = [];
    for (const zone of autoZones) {
        const cols = Math.max(1, zone.cols || 1);
        const zoneRegions = regions.filter(r => {
            if (r.type === RegionType.HEADER || r.type === RegionType.FOOTER) return false;
            const ry = r.yCenter ?? 0;
            return ry >= zone.y0 && ry < zone.y1;
        });
        if (!zoneRegions.length) continue;

        if (cols === 1) {
            blocks.push([...zoneRegions].sort((x, y) => (x.yCenter ?? 0) - (y.yCenter ?? 0)));
            continue;
        }
        // Mirror the render loop's bucketing exactly (pageAssembler zone loop).
        const groups = Array.from({ length: cols }, () => []);
        for (const r of zoneRegions) {
            const rx = r.bbox?.x ?? 0;
            const ci = (r.columnIndex >= 0 && r.columnIndex < cols)
                ? r.columnIndex
                : Math.min(Math.floor(rx / pageWidth * cols), cols - 1);
            groups[ci].push(r);
        }
        for (const g of groups) {
            if (g.length) blocks.push(g.sort((x, y) => (x.yCenter ?? 0) - (y.yCenter ?? 0)));
        }
    }

    // Blocks made only of transparent regions are skipped by the seam walk:
    // flow passes around a full-width figure/table band.
    const seamBlocks = blocks.filter(b => b.some(r => !TRANSPARENT_TYPES.has(r.type)));

    const links = [];
    let seq = 0;
    const idFor = (r) => {
        if (!r.flowId) r.flowId = `p${pageNum}-f${seq++}`;
        return r.flowId;
    };

    for (let i = 0; i + 1 < seamBlocks.length; i++) {
        const a = _boundaryFlowRegion(seamBlocks[i], -1);
        const b = _boundaryFlowRegion(seamBlocks[i + 1], 1);
        if (!a || !b || a === b) continue;
        if (a.flowNext || b.flowPrev) continue; // already linked

        const verdict = _evaluateSeam(a, b, textMeta, scale);
        if (!verdict) continue;

        a.flowNext = idFor(b); // assign b first so a.flowNext resolves
        idFor(a);
        b.flowPrev = a.flowId;
        b.flowJoin = verdict.join;
        links.push({ from: a.flowId, to: b.flowId, join: verdict.join, signals: verdict.signals });
    }

    return links;
}
