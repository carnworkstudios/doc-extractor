// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// referenceDetector.js — promotes bibliography blocks to RegionType.REFERENCE.
//
// WHY THIS IS NOT GEOMETRIC ───────────────────────────────────────────────────
// A reference list is, to every geometric test in the classifier, a paragraph:
// same font, same measure, same column, no rules around it. The one signal that
// separates it from prose is TEXTUAL — it is a run of entries that each open
// with an author name ("Surname, A. B.,") or a bracketed number ("[12]"), and
// prose never opens that way twice in a row.
//
// The gate is deliberately two-sided, because an in-text citation cluster
// ("(Gao et al., 2011; White et al., 2015)") carries the same author-year
// tokens as the bibliography and must NOT be promoted:
//   • an entry opener has to sit at a sentence boundary, not mid-clause, and
//   • either the block carries two of them, or the page has already been
//     established as a bibliography page by a heading or by another block.
//
// Entry boundaries are recorded on the region (`entryOffsets`) so the assembler
// can emit one <li> per entry instead of one wall of text — the block is one
// region because the classifier gave it one bbox, but a reference list that
// cannot be addressed per entry is not usable as an artifact.

import { RegionType } from './regionTypes.js';

/** A heading that opens a bibliography. */
const REF_HEADING_RE =
    /^\s*(?:\d+\.?\s*|[IVXLC]+\.?\s*)?(references|bibliography|works\s+cited|literature\s+cited)\s*$/i;

// "Surname, A." / "Surname, A. B." / "van der Waals, J." — the opener of a
// name-year or name-first entry in every major style (APA, AIP, ACS, Chicago).
const AUTHOR_OPENER = String.raw`(?:[A-Z][\w’'À-ɏ-]+|van|von|de|der|den|di|da|del|la|le)` +
    String.raw`(?:\s+(?:[a-z]{2,4}\s+)?[A-Z][\w’'À-ɏ-]+)*,\s*[A-Z]\.`;

// A numeric-style entry label: "[12]". Vancouver/IEEE styles put it in front
// of an initials-first name ("[1] B. Stott, Review of…"), which no surname-
// first pattern can match — so the label alone is a sufficient opener.
const NUMERIC_OPENER = String.raw`\[\d{1,3}\]`;

// An opener only counts at a sentence boundary: block start, or after a
// terminator that closed the previous entry. Without this every mid-sentence
// "…, as shown by Gao, J." in prose read as a new bibliography entry, and
// every array subscript in an equation ("V_k[0] = C_k") read as a numeric
// entry label — which is exactly what promoted a page of algebra to a
// bibliography. A numeric label must also be followed by a name, not by an
// operator, for the same reason.
const ENTRY_START_RE = new RegExp(
    String.raw`(?:^|(?<=[.)\]”"]\s)|(?<=[.)\]”"]\s\s))` +
    String.raw`(?:(?:${NUMERIC_OPENER})\s+(?=[A-Z])|(?:${AUTHOR_OPENER}))`,
    'g',
);

// Chrome that a bibliography block may be sitting inside: the bottom-band
// footer detector claims the last reference lines on a page whose real footer
// is in the same band, and chrome is dropped from the output entirely — the
// entries would vanish rather than be misfiled. Reclaimed only on a leading
// numeric label, which a running footer never carries.
const NUMERIC_START_RE = new RegExp(String.raw`^\s*${NUMERIC_OPENER}\s+[A-Z]`);

// Prose that merely cites is dense with connective words a bibliography has
// almost none of. Used only to veto, never to promote.
const PROSE_VETO_RE =
    /\b(?:we|our|this paper|this section|therefore|however|figure|table|shown in|as (?:a|the) result)\b/i;

/** Character offsets at which a new reference entry begins. */
export function entryOffsets(text) {
    const out = [];
    ENTRY_START_RE.lastIndex = 0;
    let m;
    while ((m = ENTRY_START_RE.exec(text)) !== null) {
        out.push(m.index);
        // A zero-width step is impossible here (every alternative consumes),
        // but guard anyway so a future pattern edit cannot hang the worker.
        if (ENTRY_START_RE.lastIndex === m.index) ENTRY_START_RE.lastIndex++;
    }
    return out;
}

function _regionText(region, textMeta) {
    return (region.textItemIndices || [])
        .map(i => textMeta[i]?.str ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Promote bibliography blocks on a page, in place.
 *
 * @param {Array}  regions   — the page's regions, already typed
 * @param {Array}  textMeta  — per-item text metadata (index-aligned)
 * @returns {number} how many regions were promoted
 */
export function detectReferences(regions, textMeta) {
    const candidates = [];
    let headingSeen = false;
    let headingY = Infinity;

    for (const r of regions) {
        if (!r || !r.type) continue;
        const text = _regionText(r, textMeta);
        if (!text) continue;

        if ((r.type === RegionType.HEADING || r.type === RegionType.LIST ||
             r.type === RegionType.PARAGRAPH) && REF_HEADING_RE.test(text)) {
            headingSeen = true;
            headingY = Math.min(headingY, r.yCenter ?? 0);
            continue;
        }

        const numbered = NUMERIC_START_RE.test(text);
        const isChrome = r.type === RegionType.HEADER || r.type === RegionType.FOOTER;
        if (isChrome && !numbered) continue;
        if (!isChrome && r.type !== RegionType.PARAGRAPH && r.type !== RegionType.LIST) continue;
        // Too short to be a reference list, whatever it opens with — unless it
        // carries a numeric label, which is unambiguous on its own.
        if (text.length < (numbered ? 25 : 60)) continue;
        if (!numbered && PROSE_VETO_RE.test(text)) continue;

        const offs = entryOffsets(text);
        if (!offs.length) continue;
        candidates.push({ region: r, text, offs, numbered });
    }

    // Two openers in one block is self-evidence. One opener is only trusted
    // once the page is known to be a bibliography — by its heading, or by
    // another block on the page that carried two.
    // A numbered entry is self-evident on its own; a name-first entry needs a
    // second one in the same block before it counts as a bibliography.
    const strong = candidates.filter(c => c.offs.length >= 2 || c.numbered);
    const pageIsBibliography = headingSeen || strong.length >= 1;
    if (!pageIsBibliography) return 0;

    // Where the bibliography starts on this page. A single-opener block is a
    // hanging-indent continuation of the list — real reference material — but
    // only once the list has begun; the same block ABOVE the first entry is
    // ordinary prose that happened to name an author.
    const bibStartY = Math.min(
        headingY,
        ...strong.map(c => c.region.yCenter ?? 0),
    );

    let promoted = 0;
    for (const c of candidates) {
        if (c.offs.length < 2 && !c.numbered && (c.region.yCenter ?? 0) < bibStartY) continue;
        c.region.type = RegionType.REFERENCE;
        c.region.entryOffsets = c.offs;
        c.region.entryCount = c.offs.length;
        c.region.algorithm = 'reference-block';
        // The detector read a textual signature, not a measurement. Two openers
        // is a strong read; one-plus-a-bibliography-page is an inference.
        c.region.confidence = (c.offs.length >= 2 || c.numbered) ? 0.9 : 0.65;
        promoted++;
    }
    if (!promoted) return 0;

    // Hanging-indent continuations. A numbered bibliography wraps onto lines
    // that carry no label at all — no opener, therefore never a candidate above
    // — and they were being left as prose (or worse, as bottom-band chrome, and
    // dropped). They are recognisable structurally instead: indented past the
    // entry they follow, immediately below it, and never wider than it.
    const ordered = regions
        .filter(r => r && r.bbox && Number.isFinite(r.yCenter))
        .sort((a, b) => a.yCenter - b.yCenter);
    let lastEntry = null;
    for (const r of ordered) {
        if (r.type === RegionType.REFERENCE) { lastEntry = r; continue; }
        if (!lastEntry) continue;
        if (r.type !== RegionType.PARAGRAPH && r.type !== RegionType.LIST &&
            r.type !== RegionType.FOOTER) { lastEntry = null; continue; }
        const gap = (r.bbox.y ?? 0) - ((lastEntry.bbox.y ?? 0) + (lastEntry.bbox.h ?? 0));
        const indent = (r.bbox.x ?? 0) - (lastEntry.bbox.x ?? 0);
        const lineH = lastEntry.bbox.h || 16;
        if (gap > lineH * 1.5 || indent < lineH * 0.5) { lastEntry = null; continue; }
        r.type = RegionType.REFERENCE;
        r.algorithm = 'reference-continuation';
        r.confidence = 0.7;
        r.continuationOf = lastEntry.id ?? null;
        promoted++;
    }
    return promoted;
}
