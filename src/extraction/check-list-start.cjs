#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 carnworkstudios
// ===================================================================================
// check-list-start — an ordered list must assemble as <ol start="N">
// ===================================================================================
// The start number was lost before this guard existed. `_buildList` strips the
// "5." marker from the first <li> text, so a later attempt to re-detect the
// start from the stripped text always fell back to 1 and every ordered list
// assembled as <ol class="f1"> — a source that continued from item 5 restarted
// at item 1. The number has to be captured BEFORE the marker is stripped and
// carried onto the <ol start="N"> attribute.
//
// Run: node src/extraction/check-list-start.cjs
// ===================================================================================

let pass = 0, fail = 0;
const fails = [];
function ok(cond, label) {
    if (cond) { pass++; } else { fail++; fails.push(label); }
}

const viewport = { width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] };

function makeItem(str, x, y, size = 10) {
    return { str, fontName: 'Helvetica', transform: [1, 0, 0, size, x, y] };
}

function makeMeta(items) {
    return items.map((it, idx) => ({
        str: it.str, fontName: it.fontName, fontSize: 10,
        vx: 50, vy: 100 - idx * 10, vWidth: 200, idx,
    }));
}

function makeListRegion(items, ordered) {
    return {
        type: 'LIST',
        listOrdered: ordered,
        bbox: { x: 40, y: 70, w: 300, h: 40 },
        yCenter: 90,
        fontSize: 10,
        columnIndex: -1,
        textItemIndices: items.map((_, i) => i),
    };
}

(async () => {
    const { assemblePage, createFontRegistry } = await import('../extraction/vector/pageAssembler.js');

    // ── A list that begins at 5 must not restart at 1 ───────────────────────
    const five = [
        makeItem('5. First item', 50, 100),
        makeItem('6. Second item', 50, 90),
        makeItem('7. Third item', 50, 80),
    ];
    const pageFive = assemblePage(
        [makeListRegion(five, true)], makeMeta(five), five,
        viewport, 612, 1, createFontRegistry());
    ok(/<ol class="f\d+" start="5">/.test(pageFive.html),
       'an ordered list whose first marker is "5." assembles as <ol start="5">');
    ok(!/<li>5\./.test(pageFive.html) && !/First item.*5\./.test(pageFive.html),
       'the "5." marker is stripped from the <li> text, not duplicated');
    ok((pageFive.html.match(/<li>/g) || []).length === 3,
       'all three items survive the assembly');

    // ── A list that begins at 1 explicitly carries start="1" ────────────────
    const one = [
        makeItem('1. Alpha', 50, 100),
        makeItem('2. Beta', 50, 90),
    ];
    const pageOne = assemblePage(
        [makeListRegion(one, true)], makeMeta(one), one,
        viewport, 612, 1, createFontRegistry());
    ok(/<ol class="f\d+" start="1">/.test(pageOne.html),
       'an ordered list that starts at 1 assembles as <ol start="1">');

    // ── A source continuing mid-list (listOrdered but first marker absent) ──
    // If the classifier marks the region ordered but no numeric marker is
    // present on the first item, the default is 1 — never NaN, never start=NaN.
    const noMarker = [
        makeItem('Untitled intro', 50, 100),
        makeItem('Continuation', 50, 90),
    ];
    const pageNoMarker = assemblePage(
        [makeListRegion(noMarker, true)], makeMeta(noMarker), noMarker,
        viewport, 612, 1, createFontRegistry());
    ok(/<ol class="f\d+" start="1">/.test(pageNoMarker.html),
       'an ordered region with no numeric marker defaults to start="1"');
    ok(!/start="NaN"/.test(pageNoMarker.html),
       'no start=NaN is ever emitted');

    // ── Unordered lists never gain a start attribute ────────────────────────
    const bullets = [
        makeItem('• A bullet', 50, 100),
        makeItem('• Another', 50, 90),
    ];
    const pageUl = assemblePage(
        [makeListRegion(bullets, false)], makeMeta(bullets), bullets,
        viewport, 612, 1, createFontRegistry());
    ok(/<ul class="f\d+">/.test(pageUl.html) && !/<ul[^>]* start=/.test(pageUl.html),
       'an unordered list is <ul> with no start attribute');

    console.log(`check-list-start: ${pass} passed, ${fail} failed`);
    if (fail) {
        console.log('FAILURES:');
        for (const f of fails) console.log('  - ' + f);
        process.exit(1);
    }
})();