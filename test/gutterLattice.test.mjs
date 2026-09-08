// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
//
// Two side-by-side bordered boxes are two boxes, not one table.
//
// User report, with a screenshot: page 7 of 59MN7C-03SI.pdf rendered as a
// single blue grid wrapping the whole page — a narrow squeezed middle column,
// and a bullet list flattened to "Commercial buildings Buildings with indoor
// pools". The page holds a WARNING box in the right column and a CAUTION box
// in the left; the extractor reconstructed both into one 5x3 LATTICE_TABLE
// (x=37 w=539) whose MIDDLE COLUMN WAS THE GUTTER.
//
// Three things had to be true at once for that to happen:
//
//   1. `_xSplitCluster` bucketed segments by MIDPOINT. A rule from x=35.8 to
//      x=297.2 fills the left column but registers only at its centre, 165 —
//      so the candidate splits came out at 102.5 / 230 / 380 / 510, every one
//      interior to a column, and never one at the real gutter near 306. The
//      spanning-H test then correctly rejected all four, leaving no split.
//      Fixed by also proposing a split where many rules END just left of a
//      position and many START just right of it: the ink signature of a gutter,
//      invisible to any statistic over centres.
//
//   2. Once split, each half held 7 segments against a `>= 8` floor, so both
//      were discarded and the unsplit set was used. A validated split has
//      already proved the halves are separate structures; a minimal bordered
//      box is four segments, not eight.
//
//   3. Both halves then correctly reconstructed to `null` (they are boxes, not
//      grids) — and `reconstructAll`'s "try the full set" fallback rebuilt the
//      exact cross-gutter lattice the split had just prevented.
//
// The edge rule needs a width floor or it shreds real tables: many PDFs draw
// row rules PER CELL (sample-tables.pdf p1: 84.8-232.0, 232.4-379.6,
// 380.0-527.2), so every cell boundary is also an "ends here, starts there"
// pair. Those gaps are sub-point; a gutter is tens of points. Without the floor
// this cost 11 real tables in sample-tables.pdf alone — both cases pinned here.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyPage } from '../src/extraction/vector/contextClassifier.js';
import { RegionType } from '../src/extraction/vector/classifiers/regionTypes.js';

let checks = 0;
const check = (cond, msg) => { checks++; assert.ok(cond, msg); };

const fx = JSON.parse(readFileSync(
    new URL('./fixtures/59mn7c-callout-pages.json', import.meta.url), 'utf8'));

// ── the reported page ───────────────────────────────────────────────────────
{
    const { viewport, segments, textItems } = fx['7'];
    const { regions, textMeta } = classifyPage(
        segments, textItems, viewport, viewport.width, [], {});

    const gutter = 306;   // measured: left column ends 296.8, right starts 314.8

    // Nothing may straddle the gutter. That single assertion is the bug.
    const straddling = regions.filter(r =>
        r.bbox && r.bbox.x < gutter - 5 && r.bbox.x + r.bbox.w > gutter + 5 &&
        r.type !== RegionType.DIVIDER && r.type !== RegionType.HEADER &&
        r.type !== RegionType.FOOTER);
    check(straddling.length === 0,
        `p7: no content region spans the gutter (${straddling.map(r => r.type).join(',')})`);

    // Specifically: no table. The page has none — it has two callout boxes.
    const tables = regions.filter(r =>
        r.type === RegionType.LATTICE_TABLE || r.type === RegionType.STREAM_TABLE);
    check(!tables.some(t => t.bbox.w > viewport.width * 0.7),
        'p7: no page-spanning table is invented from two side-by-side boxes');

    // And the two callouts ARE found, each in its own column.
    const boxes = regions.filter(r => r.type === RegionType.BOX && r.bannerText);
    check(boxes.length === 2, `p7: both callout boxes are found (got ${boxes.length})`);
    check(boxes.some(b => b.bannerText === 'WARNING' && b.bbox.x > gutter),
        'p7: the WARNING box is in the right column');
    check(boxes.some(b => b.bannerText === 'CAUTION' && b.bbox.x < gutter),
        'p7: the CAUTION box is in the left column');
    for (const b of boxes) {
        check((b.textItemIndices || []).length > 10,
            `p7 ${b.bannerText}: the box carries its body text`);
    }

    // The bullet list must not be flattened into a table cell.
    const lists = regions.filter(r => r.type === RegionType.LIST);
    check(lists.length > 0, 'p7: the bullet lists survive as lists');

    // Nothing falls off the page.
    const owned = new Set();
    const visit = (r) => {
        for (const i of r?.textItemIndices || []) owned.add(i);
        for (const i of r?.bannerTextIndices || []) owned.add(i);
        for (const c of r?.children || []) visit(c);
        for (const cs of Object.values(r?.cellChildren || {})) for (const c of cs) visit(c);
    };
    regions.forEach(visit);
    const missing = textMeta.filter(m => m.str.trim() && !owned.has(m.idx));
    check(missing.length === 0, `p7: every text item is owned (${missing.length} unowned)`);
}

// ── the guard against over-splitting ────────────────────────────────────────
// A table whose row rules are drawn per cell must NOT be split at every cell
// boundary. Geometry below is sample-tables.pdf p1: three per-cell rules per
// row, joined at 232.0/232.4 and 379.6/380.0 — sub-point gaps.
{
    const VP = { width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] };
    let id = 0;
    const segments = [];
    for (const y of [203.5, 220.6, 237.5, 254.6, 271.5]) {
        segments.push({ id: id++, x1: 84.8, y1: y, x2: 232.0, y2: y });
        segments.push({ id: id++, x1: 232.4, y1: y, x2: 379.6, y2: y });
        segments.push({ id: id++, x1: 380.0, y1: y, x2: 527.2, y2: y });
    }
    for (const x of [84.8, 232.2, 379.8, 527.2]) {
        segments.push({ id: id++, x1: x, y1: 203.5, x2: x, y2: 271.5 });
    }
    const textItems = [];
    let n = 0;
    for (const y of [212, 229, 246, 263]) {
        for (const x of [90, 238, 386]) {
            textItems.push({
                str: `cell ${++n}`, width: 40, height: 9,
                transform: [9, 0, 0, 9, x, 792 - y],
            });
        }
    }
    const { regions } = classifyPage(segments, textItems, VP, VP.width, [], {});
    const tables = regions.filter(r => r.type === RegionType.LATTICE_TABLE);
    check(tables.length === 1,
        `a per-cell-ruled table stays ONE table, not one per column (got ${tables.length})`);
    if (tables[0]) {
        check((tables[0].lattice?.cols?.length ?? 0) >= 4,
            'and keeps all three of its columns');
    }
}

console.log(`gutterLattice: ${checks}/${checks} checks passed`);
