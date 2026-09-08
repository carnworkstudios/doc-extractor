// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
//
// Column-aware measure for the geometric detectors.
//
// Every number in the multi-column cases is measured from
// 59MN7C-03SI.pdf pp.16/22 (the user-reported pages), not invented:
// left column x=36-297, right column x=315-576, gutter 297->315 on a
// 612pt page, callout panels 257-262pt wide.
//
// The load-bearing assertion is the LAST group: with no column splits the
// measure is the page width, so the detectors' arithmetic is unchanged on
// single-column pages. That identity is what makes this change safe.

import assert from 'node:assert/strict';
import { buildColumnBands, bandOf, measureOf }
    from '../src/extraction/vector/classifiers/columnBands.js';

let checks = 0;
const check = (cond, msg) => { checks++; assert.ok(cond, msg); };

const VP = { width: 612, height: 792 };
const GUTTER = 306;                       // centre of the measured 297->315 gutter
const bands = buildColumnBands([GUTTER], VP);

// ── the bands themselves ────────────────────────────────────────────────────
check(bands.length === 2, 'one split yields two bands');
check(bands[0].lo === 0 && bands[0].hi === GUTTER, 'left band runs page edge to gutter');
check(bands[1].hi === 612, 'right band runs gutter to page edge');
check(Math.abs(bands[0].width - 306) < 1, 'left band is half the sheet');

// ── the bug this exists to fix ──────────────────────────────────────────────
// p22 right-column callout: x=315 w=262. Against the page that is 0.43 and
// walks through `> 0.65`; against its own column it is >0.65 and is caught.
const calloutR = { x: 315, y: 78, w: 262, h: 136 };
check(calloutR.w / VP.width < 0.65,
    'PREMISE: a full-column callout reads as under 0.65 of PAGE width');
check(calloutR.w / measureOf(calloutR, bands, VP) > 0.65,
    'a full-column callout exceeds 0.65 of its COLUMN — the gate now fires');

// p22 left-column callout: x=36 w=261, same story on the other side.
const calloutL = { x: 36, y: 36, w: 261, h: 93 };
check(calloutL.w / VP.width < 0.65, 'PREMISE: left callout also under 0.65 of page');
check(calloutL.w / measureOf(calloutL, bands, VP) > 0.65, 'left callout exceeds its column');

// ── a genuinely page-spanning region keeps the page as its measure ──────────
// Judging a full-width table against one column would make every wide table
// look impossibly wide; `bandOf` returns null and the measure falls back.
const wide = { x: 36, y: 300, w: 540, h: 120 };
check(bandOf(wide, bands) === null, 'a page-spanning region belongs to no single column');
check(measureOf(wide, bands, VP) === VP.width, 'a page-spanning region is judged against the page');

// ── centre-assignment, not overlap ──────────────────────────────────────────
// A bbox carries border/pad slack that can reach past the gutter. Overlap
// would hand it the whole page and reintroduce the bug; centre does not.
const slopped = { x: 315, y: 78, w: 262, h: 136 };
check(bandOf({ ...slopped, x: 303 }, bands) !== null,
    'a few px of slack across the gutter does not forfeit the column measure');

// ── the safety property: single-column pages are untouched ──────────────────
const none = buildColumnBands([], VP);
check(none.length === 1, 'no splits yields a single page-wide band');
check(measureOf(calloutR, none, VP) === VP.width, 'with no splits the measure IS the page width');
check(measureOf(calloutL, none, VP) === VP.width, 'with no splits every region measures against the page');
check(measureOf(wide, none, VP) === VP.width, 'with no splits a wide region measures against the page');
// and with no bands at all (detector skipped / not threaded through)
check(measureOf(calloutR, [], VP) === VP.width, 'with no bands the measure falls back to the page');

// ── malformed input cannot produce a nonsense denominator ───────────────────
check(buildColumnBands([-5, 0, 612, 9999], VP).length === 1,
    'splits outside the sheet are discarded, leaving one band');
check(buildColumnBands([GUTTER, GUTTER], VP).length === 2, 'duplicate splits collapse');

console.log(`columnBands: ${checks}/${checks} checks passed`);
