#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 carnworkstudios
// ===================================================================================
// check-box-interior — a callout's contents are BLOCKS, not a string
// ===================================================================================
// The bug this guards: a BOX region claimed every text item inside its border in
// one flat `textItemIndices`, and every later classifier pass skips claimed
// items. So the headings, bullets and paragraph breaks inside a callout were
// never classified at all — the renderer had a bag of runs and emitted the panel
// as one undifferentiated block, whatever the source had set inside it.
//
// The rule, in one line: extract what is in the box exactly as if the box were
// not there, THEN wrap the box around the result. A border decides where the
// container is, never what the contents are.
//
// Run: node src/extraction/check-box-interior.cjs
// ===================================================================================

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, label) {
    if (cond) { pass++; } else { fail++; fails.push(label); }
}

const SRC = __dirname;
const viewport = { width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] };

function item(str, x, y, size = 10) {
    return { str, fontName: 'Helvetica', transform: [1, 0, 0, size, x, y], width: str.length * size * 0.5 };
}

// textMeta in viewport space, laid out top-down in the order given.
function meta(items, opts = {}) {
    const x = opts.x ?? 60;
    const y0 = opts.y0 ?? 120;
    const step = opts.step ?? 14;
    return items.map((it, idx) => ({
        idx,
        str: it.str,
        fontName: it.fontName,
        fontSize: 10,
        vx: x,
        vy: y0 + idx * step,
        vWidth: it.width,
        vFont: opts.fonts?.[idx] ?? 10,
        bold: false,
        italic: false,
        underlined: false,
    }));
}

(async () => {
    const { assemblePage, createFontRegistry } =
        await import('./vector/pageAssembler.js');

    // ── 1. A box with children renders them, structured ──────────────────────
    // Two children of different types. If the renderer flattened them the
    // heading and the list would come out as two more paragraphs, which is
    // exactly the shipped bug.
    const items = [
        item('Before you begin', 60, 700, 13),
        item('Disconnect the supply', 60, 686),
        item('Wait sixty seconds', 60, 672),
    ];
    const m = meta(items, { fonts: [13, 10, 10] });

    const kidHeading = {
        type: 'HEADING', id: 'heading_k', bbox: { x: 60, y: 118, w: 200, h: 14 },
        yCenter: 125, fontSize: 13, columnIndex: -1, textItemIndices: [0],
    };
    const kidList = {
        type: 'LIST', id: 'list_k', listOrdered: false,
        bbox: { x: 60, y: 132, w: 220, h: 28 },
        yCenter: 146, fontSize: 10, columnIndex: -1, textItemIndices: [1, 2],
    };
    const box = {
        type: 'BOX', id: 'box_0', boxRole: 'note',
        bbox: { x: 50, y: 110, w: 300, h: 70 },
        yCenter: 145, columnIndex: -1,
        textItemIndices: [0, 1, 2],
        children: [kidHeading, kidList],
    };

    const page = assemblePage([box], m, items, viewport, 612, 1, createFontRegistry());
    const html = page.html;

    ok(/<aside class="pdf-box[^"]*"/.test(html),
       'the panel still renders as an <aside class="pdf-box"> — the box is preserved');
    ok(/<div class="pdf-box-block"/.test(html),
       'each child is wrapped in .pdf-box-block, the element that carries its address');
    ok(/<h[1-6][^>]*>[\s\S]*Before you begin/.test(html),
       'a heading inside the box assembles as a heading, not as a paragraph');
    ok(/<ul|<ol/.test(html),
       'a list inside the box assembles as a list, not as flattened text');
    ok(/data-region-id="heading_k"/.test(html) && /data-region-id="list_k"/.test(html),
       'every child carries its own region id — a box is not an opaque wrapper');

    // Structure, not just presence: both children must be INSIDE the aside.
    const aside = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
    ok(aside.includes('heading_k') && aside.includes('list_k'),
       'the children render inside the box, not beside it');

    // ── 2. A box with no children still renders (no regression) ──────────────
    const bare = { ...box, children: undefined };
    delete bare.children;
    const barePage = assemblePage([bare], m, items, viewport, 612, 1, createFontRegistry());
    ok(/<aside class="pdf-box/.test(barePage.html) && /Disconnect the supply/.test(barePage.html),
       'a box with no classified children falls back to the flat rebuild rather than rendering empty');
    ok(!/pdf-box-block/.test(barePage.html),
       'the fallback emits no child wrappers — an empty wrapper would be a lie about structure');

    // ── 3. The banner is a header, never the first line of the body ──────────
    const banners = { ...box, bannerText: 'WARNING' };
    const bannerPage = assemblePage([banners], m, items, viewport, 612, 1, createFontRegistry());
    const bannerCount = (bannerPage.html.match(/pdf-box-banner/g) || []).length;
    ok(bannerCount === 1, 'the banner renders exactly once');
    ok(bannerPage.text.startsWith('WARNING'),
       'the plain-text rendering leads with the banner label');
    ok(/Disconnect the supply/.test(bannerPage.text),
       'the plain-text rendering of a structured box carries its children, not an empty string');

    // ── 4. The IR carries the interior as blocks ─────────────────────────────
    // gxDoc and gxDocToRegions are pure data and import directly. The two DOM
    // halves of the round trip (htmlToGxDoc, gxDocToHtml) reach exportController
    // and through it the batch alias, so they are asserted at the source the way
    // check-image-pipeline asserts them — the same convention, same reason.
    const { ensureBlockIds, validateDoc } = await import('./../ir/gxDoc.js');
    const { gxDocToRegions } = await import('./../ir/gxDocToRegions.js');

    const doc = {
        schema: 'gx-doc/1',
        meta: { source: 'check', title: null, pageCount: 1 },
        pages: [{
            page: 1, width: 612, zones: [],
            blocks: [{
                type: 'callout', kind: 'note', banner: 'NOTE',
                text: 'Before you begin Disconnect the supply',
                blocks: [
                    { type: 'heading', level: 3, text: 'Before you begin' },
                    { type: 'list', ordered: false, items: ['Disconnect the supply', 'Wait sixty seconds'] },
                ],
            }],
        }],
        links: [], bookmarks: [], annotations: [],
    };

    const v = validateDoc(doc);
    ok(v.ok, `a callout carrying nested blocks is a valid gx-doc: ${v.errors.join('; ')}`);

    const bad = JSON.parse(JSON.stringify(doc));
    bad.pages[0].blocks[0].blocks[0].type = 'sparkle';
    ok(!validateDoc(bad).ok,
       'an unknown type INSIDE a box is rejected — validating only the outer list would let it through');

    ensureBlockIds(doc);
    const callout = doc.pages[0].blocks[0];
    ok(!!callout.id && callout.blocks.every(b => b.id),
       'every nested block is stamped with an id — the join between markup and regions');
    ok(new Set([callout.id, ...callout.blocks.map(b => b.id)]).size === 3,
       'nested ids are unique — two blocks sharing one is the same failure as having none');

    const flat = gxDocToRegions(doc)[0].regions;
    const boxRegion = flat.find(r => r.type === 'BOX');
    const nested = flat.filter(r => r.parentId);
    ok(!!boxRegion, 'the callout emits a BOX region');
    ok(nested.length === 2,
       "a callout's children emit regions of their own — a nested table has to be sendable");
    ok(nested.every(r => r.parentId === boxRegion.id),
       'each child region names the box it sits in');
    ok(nested.some(r => r.type === 'HEADING') && nested.some(r => r.type === 'LIST'),
       'the children keep their own region types rather than inheriting BOX');
    ok(nested.every(r => r.id && flat.filter(x => x.id === r.id).length === 1),
       'child region ids are unique across the page');

    // The two DOM halves, at the source.
    const toIr = fs.readFileSync(path.join(SRC, '../ir/htmlToGxDoc.js'), 'utf8');
    ok(/type: 'callout'[\s\S]{0,400}?blocks: inner\.blocks/.test(toIr),
       'htmlToGxDoc walks a callout\'s contents into nested blocks instead of flattening them to runs');
    ok(/pdf-box-banner'\)\) return;/.test(toIr),
       'the banner is not emitted a second time as the box\'s first paragraph');
    const fromIr = fs.readFileSync(path.join(SRC, '../ir/gxDocToHtml.js'), 'utf8');
    ok(/case 'callout'[\s\S]{0,1500}?pdf-box-block/.test(fromIr),
       'gxDocToHtml re-emits a structured callout as blocks, so the round trip does not re-flatten it');

    // ── 5. The classifier gives a box children, and the pipeline order holds ─
    const cc = fs.readFileSync(path.join(SRC, 'vector/contextClassifier.js'), 'utf8');
    ok(/_classifyBoxInteriors\(/.test(cc),
       'classifyPage runs a box-interior pass');
    // Order is load-bearing: a grid nested in a panel must have reclaimed its
    // own cells before the prose pass looks at what is left, or the table's
    // cells get bucketed as paragraphs.
    const iTables = cc.indexOf('detectLatticeTables(');
    const iStream = cc.indexOf('detectStreamTableRegions(');
    const iBoxes = cc.indexOf('_classifyBoxInteriors(');
    ok(iTables > 0 && iBoxes > iTables,
       'the box-interior pass runs AFTER lattice detection, so a nested grid keeps its cells');
    ok(iStream > 0 && iBoxes > iStream,
       'the box-interior pass runs AFTER stream detection too');
    ok(/regions\.filter\(r => r && r\.type === RegionType\.BOX\)/.test(cc),
       'the pass covers every BOX on the page — the lattice detector emits them too, and ' +
       'scoping it to the box detector\'s own output would leave those flat');
    ok(/_classifyBucket\(children,/.test(cc),
       'box contents go through the same bucket classifier the page body uses — not a second, ' +
       'divergent set of rules');
    ok(/_ensureRegionIds\(regions\)[\s\S]{0,600}?r\.children/.test(cc),
       '_ensureRegionIds walks children, so a nested region is addressable');

    // The renderer must not reach for the flat rebuild when children exist.
    const pa = fs.readFileSync(path.join(SRC, 'vector/pageAssembler.js'), 'utf8');
    const boxCase = pa.slice(pa.indexOf('case RegionType.BOX:'));
    ok(/region\.children/.test(boxCase.slice(0, 3000)),
       'the BOX renderer reads region.children');

    console.log(`\ncheck-box-interior: ${pass} passed, ${fail} failed`);
    if (fail) {
        console.log('FAILURES:');
        for (const f of fails) console.log('  - ' + f);
        process.exit(1);
    }
    console.log('PASS — a callout is a container, not a blob: its contents are classified\n' +
                '       as if the border were not there and the box is wrapped around the\n' +
                '       result, the children stay addressable, and the IR round trip keeps\n' +
                '       the structure instead of flattening it back into runs.');
})();
