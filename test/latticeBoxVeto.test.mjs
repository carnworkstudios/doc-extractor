// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
//
// A stack of admonitions must not be reconstructed into one region.
//
// REGRESSION. 0.3.1 (submodule dda8615) vetoed any lattice candidate that
// enclosed already-claimed boxes, with this comment:
//
//     "A grid drawn across two already-claimed boxes — two admonitions side
//      by side in a two-column spread reconstruct into one rectangle
//      enclosing both. The boxes are the real regions; the wrapper is an
//      artifact of reading their borders as one lattice."
//
// `cef8980` removed that veto wholesale to fix a different, real problem:
// a prose-heavy table's description cell is itself a closed prose rectangle,
// the box pass necessarily runs first, and the blanket veto was therefore
// discarding genuine tables. The fix was right about the cause and too broad
// in the remedy.
//
// Measured cost of the removal on 59MN7C-03SI.pdf: 17 / 21 / 33 candidate
// wrappers survive on pp.11/16/22 respectively, the worst enclosing seven
// stacked callouts. On p16 the observable result was a single BOX
// x=316 y=59 w=260 h=591 holding 82 text items — the whole right column,
// swallowing three separate CAUTION/WARNING panels. That is the user report:
// "there could be 3-4 boxes and box will try and group all the boxes in one
// box".
//
// The discriminator is WIDTH, not containment. A description cell occupies one
// column of a row, so it sits inside a single column span. A stacked callout is
// drawn between the grid's own left/right borders, so it spans the full
// rectangle. Both cases are pinned below; neither may regress into the other.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectLatticeTables } from '../src/extraction/vector/classifiers/latticeDetector.js';
import { detectBoxRegions } from '../src/extraction/vector/classifiers/boxDetector.js';
import { RegionType } from '../src/extraction/vector/classifiers/regionTypes.js';
import { PageScale } from '../src/extraction/vector/pageScale.js';

let checks = 0;
const check = (cond, msg) => { checks++; assert.ok(cond, msg); };

const VP = { width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] };

const mkText = (rows) => rows.map((r, i) => ({
    idx: i, str: r.s, vx: r.x, vy: r.y, vWidth: r.w ?? 60, vFont: r.f ?? 9,
}));

// ── Case 1: the real page (the regression) ─────────────────────────────────
// Fixture is the RIGHT COLUMN of 59MN7C-03SI.pdf p16, captured verbatim from
// the PDF: 21 H-segments, 12 V-segments, 120 text items. A synthetic stack does
// NOT reproduce this — the existing interior guards reject a clean one — so the
// only honest fixture is the ink that actually failed.
{
    const fx = JSON.parse(readFileSync(
        new URL('./fixtures/59mn7c-p16-rightcol.json', import.meta.url), 'utf8'));
    const { viewport, hSegs, vSegs, textMeta } = fx;
    const scale = new PageScale(textMeta, viewport);

    const regions = [];
    const assigned = new Set();
    const boxes = detectBoxRegions(
        hSegs, vSegs, new Set(), textMeta, scale, viewport, regions, [], assigned, []);
    for (const b of boxes) regions.push(b);

    // The box pass alone is correct here and always was: separate panels.
    check(boxes.length >= 3, 'the box pass finds the separate admonition panels');

    const lat = detectLatticeTables(
        [...hSegs, ...vSegs], textMeta, scale, viewport, [], assigned, {}, boxes, [], []);

    // The regression: a single BOX x=316 y=59 w=260 h=591 holding 82 items,
    // swallowing three CAUTION/WARNING panels into one region.
    const swallowing = lat.filter(r => r.bbox.h > 300);
    check(swallowing.length === 0,
        'no lattice region may span the whole column and swallow the panel stack');

    const bigClaim = lat.filter(r => (r.textItemIndices || []).length > 40);
    check(bigClaim.length === 0,
        'no lattice region may claim 40+ items across separate admonitions');
}

// ── Case 2: a prose-heavy table must still be found ─────────────────────────
// This is what `cef8980` was fixing, and it must not regress. The inner boxes
// are CELL-sized — they sit inside one column span, not across the grid — so
// the veto above must leave them alone.
{
    let id = 0;
    // 3 rows x 2 cols: interior V at x=430 is what makes it a grid, not a stack.
    const H = [80, 120, 160, 200].map(y => ({ id: `h${id++}`, x1: 315, x2: 576, y1: y, y2: y }));
    const V = [315, 430, 576].map(x => ({ id: `v${id++}`, x1: x, x2: x, y1: 80, y2: 200 }));
    const textMeta = mkText([
        { s: 'Model', x: 320, y: 95, w: 40 }, { s: 'Capacity', x: 435, y: 95, w: 50 },
        { s: '58MVC', x: 320, y: 135, w: 40 }, { s: 'Rated for continuous duty', x: 435, y: 135, w: 120 },
        { s: '59MN7C', x: 320, y: 175, w: 45 }, { s: 'Rated for intermittent duty', x: 435, y: 175, w: 120 },
    ]);
    const scale = new PageScale(textMeta, VP);

    // A description cell the box pass claimed as a prose rectangle: it is
    // inside ONE column (x 430-576), not spanning the grid.
    const boxRegions = [{
        type: RegionType.BOX,
        bbox: { x: 430, y: 120, w: 146, h: 40 },
        textItemIndices: [3],
        boxRole: 'generic',
    }];

    const assigned = new Set([3]);
    const out = detectLatticeTables(
        [...H, ...V], textMeta, scale, VP, [], assigned, {}, boxRegions, [], []);

    check(out.some(r => r.type === RegionType.LATTICE_TABLE),
        'a real grid containing a cell-sized prose box is still a table (cef8980 must not regress)');
}

console.log(`latticeBoxVeto: ${checks}/${checks} checks passed`);
