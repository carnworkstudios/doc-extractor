// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
//
// A callout's header is printed once.
//
// User report: "caution and warning boxes, box already claim the design in it,
// why does it reprint the header separately after the box has already style
// them" — on 59MN7C-03SI.pdf pp.11, 16, 22.
//
// Mechanism. `boxDetector._mergeBannersIntoBodies` folds a standalone banner
// bar into the bordered body box beneath it and drops the label items as it
// goes, so `bannerText` is set and the body no longer holds the word. But that
// merge only fires when a BODY BOX exists to merge into. On p11 the callout
// bodies classify as HEADING regions rather than boxes, so all three banner
// bars are left standing alone at h=26 — `bannerText` set AND the 18pt label
// still in `textItemIndices`. The assembler then draws the styled header from
// `bannerText` and prints the same word again from the body flow.
//
// Two distinct failures, both now pinned:
//
//   1. The label re-emitted OUTSIDE the box. Items rendered from `bannerText`
//      are deliberately absent from `textItemIndices`, so `_recoverUnownedText`
//      ("lossless-recovery") saw them as unowned and re-emitted them as a
//      standalone HEADING beside the panel — the giant "! CAUTION" above a box
//      that already draws its own header. Fixed by recording the consumed
//      indices on `bannerTextIndices` and teaching the coverage walk about it.
//
//   2. An unmerged banner BAR. `_mergeBannersIntoBodies` needs a body BOX to
//      merge into; where the body classifies as prose the bar stands alone
//      holding `bannerText` AND the label, printing the word twice.
//
// The first was caused by the width gate rejecting the full banner+body
// rectangle, which ALSO spilled the body out of the box entirely — the user's
// second complaint ("most of the images that are supposed to be in the box do
// not even get in the box"). Both symptoms, one cause.
//
// Fixture is pp.11/16/22 captured verbatim (segments + text items) and driven
// through the real `classifyPage`, because the failure only appears once the
// body has been classified as something other than a box. Partial calls into
// `detectBoxRegions` do NOT reproduce it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyPage } from '../src/extraction/vector/contextClassifier.js';
import { RegionType } from '../src/extraction/vector/classifiers/regionTypes.js';

let checks = 0;
const check = (cond, msg) => { checks++; assert.ok(cond, msg); };

const fx = JSON.parse(readFileSync(
    new URL('./fixtures/59mn7c-callout-pages.json', import.meta.url), 'utf8'));

let totalBoxes = 0;

for (const pn of ['11', '16', '22']) {
    const { viewport, segments, textItems } = fx[pn];
    const { regions, textMeta } = classifyPage(
        segments, textItems, viewport, viewport.width, [], {});

    const boxes = regions.filter(r => r.type === RegionType.BOX && r.bannerText);
    check(boxes.length > 0, `p${pn}: the page has banner-carrying callout boxes`);
    totalBoxes += boxes.length;

    for (const box of boxes) {
        const label = box.bannerText.replace(/[^A-Z]/g, '');
        const items = (box.textItemIndices || [])
            .map(i => textMeta[i]).filter(Boolean)
            .sort((a, b) => a.vy - b.vy || a.vx - b.vx);

        // The defect, stated exactly: the body's first item is the label word
        // itself, at banner size, while `bannerText` already renders it.
        const first = items[0];
        const firstWord = first
            ? first.str.trim().toUpperCase().replace(/[^A-Z]/g, '') : '';
        check(!(firstWord && firstWord === label),
            `p${pn} ${box.bannerText}: body must not begin with the banner word`);

        // Nor may it survive anywhere in the flow at banner font size.
        const bannerSized = items.filter(m =>
            m.str.trim().toUpperCase().replace(/[^A-Z]/g, '') === label);
        check(bannerSized.length === 0,
            `p${pn} ${box.bannerText}: the label appears nowhere in the body flow`);
    }
}

check(totalBoxes >= 10,
    'all three pages together contribute their callouts (guards a silently empty fixture)');

// ── the body must not be collateral damage ──────────────────────────────────
// Removing the label must not remove the prose that merely mentions it —
// "Failure to follow this caution may result in..." is body text, not a header.
{
    const { viewport, segments, textItems } = fx['16'];
    const { regions, textMeta } = classifyPage(
        segments, textItems, viewport, viewport.width, [], {});
    const withBody = regions.filter(r =>
        r.type === RegionType.BOX && r.bannerText && r.bbox.h > 60);
    check(withBody.length > 0, 'p16 has full callouts with body text');
    for (const box of withBody) {
        const text = (box.textItemIndices || [])
            .map(i => textMeta[i]).filter(Boolean)
            .map(m => m.str).join(' ');
        check(/failure to follow/i.test(text),
            'the body prose survives the label removal');
        check(/hazard/i.test(text), 'the hazard line survives the label removal');
    }
}

// ── the body belongs INSIDE the box ─────────────────────────────────────────
// The width gate had been rejecting the full banner+body rectangle, leaving a
// 26px bar and the body loose on the page. A callout with prose must be tall
// enough to hold it, and every text item on the page must be owned by someone.
for (const pn of ['11', '16', '22']) {
    const { viewport, segments, textItems } = fx[pn];
    const { regions, textMeta } = classifyPage(
        segments, textItems, viewport, viewport.width, [], {});

    const withProse = regions.filter(r =>
        r.type === RegionType.BOX && r.bannerText &&
        (r.textItemIndices || []).length > 2);
    check(withProse.length > 0, `p${pn}: callouts carry their body text`);
    for (const box of withProse) {
        check(box.bbox.h > 40,
            `p${pn} ${box.bannerText}: a callout with body text is taller than a bare bar`);
    }

    // THE ORPHAN: no region outside a callout may consist solely of the label.
    // This is what the screenshot showed — a giant "! CAUTION" heading sitting
    // above the box that already draws its own styled header.
    const labelOnly = regions.filter(r => {
        if (r.type === RegionType.BOX) return false;
        const t = (r.textItemIndices || [])
            .map(i => textMeta[i]).filter(Boolean)
            .map(m => m.str.trim()).join(' ').trim();
        return /^!?\s*(CAUTION|WARNING|NOTICE|NOTE|DANGER)\s*!?$/i.test(t);
    });
    check(labelOnly.length === 0,
        `p${pn}: no stray region is just the callout label (${labelOnly.length} found)`);

    // Nothing may fall off the page. `bannerTextIndices` counts as owned:
    // those items ARE rendered, by the header.
    const owned = new Set();
    const visit = (r) => {
        for (const i of r?.textItemIndices || []) owned.add(i);
        for (const i of r?.bannerTextIndices || []) owned.add(i);
        for (const c of r?.children || []) visit(c);
        for (const cs of Object.values(r?.cellChildren || {})) for (const c of cs) visit(c);
    };
    regions.forEach(visit);
    const missing = textMeta.filter(m => m.str.trim() && !owned.has(m.idx));
    check(missing.length === 0,
        `p${pn}: every text item is owned by a region (${missing.length} unowned)`);
}

console.log(`calloutBanner: ${checks}/${checks} checks passed`);
