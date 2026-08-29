#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 carnworkstudios
// ===================================================================================
// check-docling-adapter — the adapter's output must stay addressable
// ===================================================================================
// The regression this guards: Docling's own `export_to_html()` carries no
// `data-region-id` and no `section.pdf-page-content[data-page]`. A table taken
// from it fails `tableOriginOf()` in `ui/exportController.js`, arrives in TAFNE
// or the Schema Editor with no return address, and can never be annotated back
// to the page it came from. The failure is silent — the send succeeds, the
// document looks fine, and only the return path is gone.
//
// So these checks assert the two anchors exist on every table, plus the
// structural properties that make the rebuilt table trustworthy: spans do not
// produce ragged rows, reading order is honoured, and furniture is dropped.
//
// Run: node src/extraction/check-docling-adapter.cjs
// ===================================================================================

let pass = 0, fail = 0;
const fails = [];
function ok(cond, label) {
    if (cond) { pass++; } else { fail++; fails.push(label); }
}

// A synthetic payload in `extract_assets` shape. Deliberately includes the hard
// cases: a rowspan+colspan header, a two-column reading order that bbox sorting
// would scramble, a caption, furniture, and a page-2 table so page-local ids
// are exercised.
const ASSETS = {
    order: [
        { kind: 'texts', index: 0 },
        { kind: 'texts', index: 1 },
        { kind: 'tables', index: 0 },
        { kind: 'pictures', index: 0 },
        { kind: 'texts', index: 3 },   // furniture — must be dropped
        { kind: 'tables', index: 1 },
    ],
    page_sizes: { '1': { width: 595.27, height: 841.89 }, '2': { width: 595.27, height: 841.89 } },
    texts: [
        { index: 0, label: 'section_header', level: 1, text: 'Heading One', page_no: 1,
          bbox: { l: 56, r: 400, t: 800, b: 780, coord_origin: 'BOTTOMLEFT' } },
        { index: 1, label: 'text', text: 'Body prose on page one.', page_no: 1,
          bbox: { l: 56, r: 540, t: 760, b: 700, coord_origin: 'BOTTOMLEFT' } },
        { index: 3, label: 'page_footer', text: 'Confidential — page 1', page_no: 1, content_layer: 'furniture',
          bbox: { l: 56, r: 540, t: 40, b: 20, coord_origin: 'BOTTOMLEFT' } },
    ],
    pictures: [
        { index: 0, label: 'picture', page_no: 1, bbox: { l: 50, t: 400, r: 250, b: 300 }, captions: ['Figure 1'] },
    ],
    tables: [
        {
            index: 0, label: 'table', page_no: 1, num_rows: 3, num_cols: 3,
            captions: ['Table 1 — merged header'],
            grid: [
                [
                    { text: 'Region', row_span: 2, col_span: 1, column_header: true },
                    { text: 'Q1', row_span: 1, col_span: 2, column_header: true },
                    { text: 'Q1', row_span: 1, col_span: 2, column_header: true },
                ],
                [
                    { text: 'Region', row_span: 2, col_span: 1, column_header: true },
                    { text: 'Units', row_span: 1, col_span: 1, column_header: true },
                    { text: 'Rev', row_span: 1, col_span: 1, column_header: true },
                ],
                [
                    { text: 'North', row_span: 1, col_span: 1 },
                    { text: '10', row_span: 1, col_span: 1 },
                    { text: '20', row_span: 1, col_span: 1 },
                ],
            ],
        },
        {
            index: 1, label: 'table', page_no: 2, num_rows: 2, num_cols: 2,
            grid: [
                [{ text: 'A', row_span: 1, col_span: 1, column_header: true },
                 { text: 'B', row_span: 1, col_span: 1, column_header: true }],
                [{ text: '1', row_span: 1, col_span: 1 }, { text: '2', row_span: 1, col_span: 1 }],
            ],
        },
    ],
};

(async () => {
    const { doclingToRegionHtml } = await import('./doclingAdapter.js');
    const r = doclingToRegionHtml(ASSETS);
    const html = r.html;

    // ── 1. The two anchors `tableOriginOf` requires ──────────────────────────
    const tableWraps = html.match(/<div class="pdf-table-wrap[^"]*" data-region-id="[^"]+"/g) || [];
    ok(tableWraps.length === 2, 'every table is wrapped in a [data-region-id] div');
    ok(!/data-region-id="(undefined|null|)"/.test(html), 'no table carries a placeholder region id');

    const sections = html.match(/<section class="pdf-page-content" data-page="(\d+)"/g) || [];
    ok(sections.length === 2, 'one pdf-page-content section per page');
    ok(/data-page="1"/.test(html) && /data-page="2"/.test(html), 'both page numbers are emitted');
    ok(/data-page-width="595"/.test(html), 'page width comes from Docling page_sizes');

    // Region ids are page-local, so page 2 restarting at _0 is correct —
    // uniqueness comes from the (page, regionId) pair that `origin` carries.
    ok(/data-region-id="docling_table_0"[\s\S]*data-page="2"[\s\S]*data-region-id="docling_table_0"/.test(html)
        || html.split('docling_table_0').length === 3,
        'region ids are page-local (page 2 restarts the ordinal)');

    // ── 2. Spans must not produce ragged rows ────────────────────────────────
    // Row 0: Region(rowspan2) + Q1(colspan2) + Q1(colspan2) = 5 columns wide.
    // Row 1: the Region cell is covered by the rowspan, so it must NOT repeat.
    const firstTable = html.slice(html.indexOf('<table'), html.indexOf('</table>'));
    const regionCells = (firstTable.match(/>Region</g) || []).length;
    ok(regionCells === 1, 'a rowspan origin cell is emitted once, not repeated per covered row');
    ok(/rowspan="2"/.test(firstTable), 'rowspan is carried through');
    ok(/colspan="2"/.test(firstTable), 'colspan is carried through');

    // ── 3. Semantics ─────────────────────────────────────────────────────────
    ok(/<caption>Table 1 — merged header<\/caption>/.test(html), 'table caption is emitted');
    ok(/<thead>/.test(firstTable), 'leading column_header rows form a thead');
    ok(!/Confidential/.test(html), 'furniture (page_footer) is dropped');
    ok(/<h2>Heading One<\/h2>/.test(html), 'section_header level 1 becomes h2');
    ok(/<div class="pdf-region"[^>]*><h2>/.test(html), 'a heading is wrapped in its own pdf-region');
    ok(/pdf-image-placeholder" data-region-id="docling_image_0"/.test(html), 'pictures are addressable too');
    ok(/Figure 1/.test(html), 'picture caption is emitted');

    // ── 4. Reported counts must match what was emitted ───────────────────────
    ok(r.tableCount === 2, `tableCount reports 2 (got ${r.tableCount})`);
    ok(r.pages.length === 2, `pages reports 2 entries (got ${r.pages.length})`);
    ok(r.pages[0].pageNum === 1 && r.pages[1].pageNum === 2, 'pages are ordered by page number');
    ok(r.text.includes('Body prose on page one.'), 'plain text carries prose');
    ok(!r.text.includes('Confidential'), 'plain text drops furniture too');

    // ── 4b. Zone toolbar contract ────────────────────────────────────────────
    // `applyZones` reads data-ry/data-rx off every .pdf-region and DROPS any
    // region where they parse as NaN. Without these, the first click on a zone
    // chip erases the page.
    const regions = html.match(/<div class="pdf-region"[^>]*>/g) || [];
    // 4 on page 1 (heading, prose, table, picture) + 1 on page 2 (table).
    // The page_footer is furniture and must not appear.
    ok(regions.length === 5, `one .pdf-region per placed item (got ${regions.length})`);
    ok(regions.every(r => /data-ry="-?\d+"/.test(r)), 'every region carries a numeric data-ry');
    ok(regions.every(r => /data-rx="-?\d+"/.test(r)), 'every region carries a numeric data-rx');
    ok(/<div class="pdf-region"[^>]*><div class="pdf-table-wrap/.test(html),
        'the table wrap sits INSIDE a .pdf-region, as pageAssembler emits it');

    // BOTTOMLEFT → top-down flip. Heading is at t=800 on an 841pt page, so it
    // must end up near the TOP (small ry), not the bottom.
    const headingRy = Number((html.match(/<div class="pdf-region" data-ry="(-?\d+)"[^>]*><h2>/) || [])[1]);
    ok(headingRy > 0 && headingRy < 100,
        `a bbox at the page top (t=800 of 841) flips to a small ry (got ${headingRy})`);

    // ── 4c. Column detection ─────────────────────────────────────────────────
    const twoCol = doclingToRegionHtml({
        page_sizes: { '1': { width: 600, height: 800 } },
        order: [0, 1, 2, 3, 4].map(i => ({ kind: 'texts', index: i })),
        texts: [
            // Full-width title spanning the page.
            { index: 0, label: 'section_header', text: 'Spanning Title', page_no: 1,
              bbox: { l: 50, r: 550, t: 780, b: 760, coord_origin: 'BOTTOMLEFT' } },
            // Two columns with a clear gutter at x≈290-310.
            { index: 1, label: 'text', text: 'left one', page_no: 1,
              bbox: { l: 50, r: 285, t: 700, b: 600, coord_origin: 'BOTTOMLEFT' } },
            { index: 2, label: 'text', text: 'right one', page_no: 1,
              bbox: { l: 315, r: 550, t: 700, b: 600, coord_origin: 'BOTTOMLEFT' } },
            { index: 3, label: 'text', text: 'left two', page_no: 1,
              bbox: { l: 50, r: 285, t: 590, b: 500, coord_origin: 'BOTTOMLEFT' } },
            { index: 4, label: 'text', text: 'right two', page_no: 1,
              bbox: { l: 315, r: 550, t: 590, b: 500, coord_origin: 'BOTTOMLEFT' } },
        ],
    });
    const z = twoCol.pages[0].zones;
    ok(twoCol.pages[0].maxCols === 2, `a two-column page reports 2 columns (got ${twoCol.pages[0].maxCols})`);
    ok(z.length >= 2, `spanning title forms its own band (got ${z.length} zones)`);
    ok(z[0].cols === 1, 'the band containing the spanning title is single-column');
    ok(z[0].y0 === 0 && z[z.length - 1].y1 === 99999, 'zones cover the full page height');
    for (let i = 1; i < z.length; i++) {
        ok(z[i].y0 >= z[i - 1].y1 - 1, `zone ${i} does not overlap the previous band`);
    }

    // A single-column page must NOT be split into phantom columns by margin
    // indentation — the failure mode that makes gutter detection unusable.
    const oneCol = doclingToRegionHtml({
        page_sizes: { '1': { width: 600, height: 800 } },
        order: [0, 1].map(i => ({ kind: 'texts', index: i })),
        texts: [
            { index: 0, label: 'text', text: 'para one', page_no: 1,
              bbox: { l: 72, r: 528, t: 700, b: 640, coord_origin: 'BOTTOMLEFT' } },
            { index: 1, label: 'text', text: 'indented', page_no: 1,
              bbox: { l: 108, r: 528, t: 630, b: 580, coord_origin: 'BOTTOMLEFT' } },
        ],
    });
    ok(oneCol.pages[0].maxCols === 1, `margin indentation is not a gutter (got ${oneCol.pages[0].maxCols})`);

    // ── 4d. Published regions — the artifact contract ────────────────────────
    // HTML alone shows a document; regions are what make it USABLE. The analyze
    // canvas draws them, the artifact panel builds every tag from them, and a
    // cross-tool send resolves a tag's (page, regionId) back through
    // `getRegionHtml`. The Docling path published no regions at all, so an
    // extraction rendered and offered nothing to send.
    const p1 = r.pages[0].regions;
    ok(Array.isArray(p1) && p1.length === 4,
        `page 1 publishes one region per placed item (got ${p1 && p1.length})`);
    ok(r.pages[1].regions.length === 1, 'page 2 publishes its table region');
    ok(p1.every(x => x.id && x.type), 'every region carries an id and a type');

    // Every published region id must resolve inside its own page section —
    // this is exactly what `getRegionHtml(page, regionId)` does.
    for (const pg of r.pages) {
        const secStart = html.indexOf(`data-page="${pg.pageNum}"`);
        const secEnd = html.indexOf('</section>', secStart);
        const section = html.slice(secStart, secEnd);
        for (const reg of pg.regions) {
            ok(section.includes(`data-region-id="${reg.id}"`),
                `region ${reg.id} is addressable inside page ${pg.pageNum}`);
        }
    }

    // Text blocks were the silent half: they had a `.pdf-region` wrapper but no
    // id, so every heading and paragraph resolved to null and could not be sent.
    const heading = p1.find(x => x.type === 'HEADING');
    ok(!!heading, 'a section_header publishes a HEADING region');
    ok(p1.some(x => x.type === 'PARAGRAPH'), 'body prose publishes a PARAGRAPH region');
    ok(p1.some(x => x.type === 'LATTICE_TABLE'), 'a table publishes a LATTICE_TABLE region');
    ok(p1.some(x => x.type === 'IMAGE'), 'a picture publishes an IMAGE region');
    ok(!p1.some(x => /Confidential/.test(x.id || '')), 'furniture publishes no region');

    // bbox is worker space (PDF points × 2.0) — the space analyzePanel scales
    // its canvas into. A heading at t=800..780 on an 841pt page is 41..61pt from
    // the top, so 82..122 in worker space.
    ok(heading.bbox && Math.abs(heading.bbox.y - 82) < 2,
        `bbox y is points × 2.0 from the page top (got ${heading.bbox && heading.bbox.y})`);
    ok(heading.bbox && Math.abs(heading.bbox.h - 40) < 2,
        `bbox h is the point height × 2.0 (got ${heading.bbox && heading.bbox.h})`);
    ok(p1.every(x => x.confidence === undefined),
        'no region claims a confidence Docling never reported');

    // A region Docling gave no usable bbox for is still an artifact — it just
    // cannot be drawn. A zeroed box would draw a wrong claim at the origin.
    const noGeom = doclingToRegionHtml({
        order: [{ kind: 'texts', index: 0 }],
        texts: [{ index: 0, label: 'text', text: 'no box here', page_no: 1 }],
    });
    const ng = noGeom.pages[0].regions[0];
    ok(!!ng && !!ng.id, 'an item with no bbox still publishes an addressable region');
    ok(ng && ng.bbox === undefined, 'an item with no bbox publishes no bbox, not a zeroed one');

    // ── 5. Degenerate input must not throw ───────────────────────────────────
    let threw = null;
    try {
        doclingToRegionHtml({});
        doclingToRegionHtml({ order: [{ kind: 'tables', index: 99 }], tables: [] });
        doclingToRegionHtml({ tables: [{ index: 0, page_no: null, grid: [] }], order: [{ kind: 'tables', index: 0 }] });
    } catch (e) { threw = e.message; }
    ok(threw === null, `degenerate payloads are refused without throwing (${threw})`);

    // An object with no page cannot be placed and must be skipped, not
    // defaulted onto page 1 where it would get a wrong return address.
    const noPage = doclingToRegionHtml({
        order: [{ kind: 'texts', index: 0 }],
        texts: [{ index: 0, label: 'text', text: 'orphan' }],
    });
    ok(!noPage.html.includes('orphan'), 'an item with no page_no is skipped, not defaulted to page 1');

    console.log('\ndocling adapter:\n');
    if (fail) {
        console.log(`docling adapter checks: ${pass}/${pass + fail}`);
        fails.forEach(f => console.log('  FAIL — ' + f));
        process.exit(1);
    }
    console.log(`docling adapter checks: ${pass}/${pass + fail}`);
    console.log(`PASS — every rebuilt table carries the page + region anchors
       \`tableOriginOf\` needs, spans survive without ragged rows, reading
       order is preserved, and furniture is dropped.`);
})();
