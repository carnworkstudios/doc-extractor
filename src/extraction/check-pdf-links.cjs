#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// ===================================================================================
// check-pdf-links — LinkAnnotations must survive extraction as <a href>
// ===================================================================================
// Guards the link retention path end to end:
//
//   1. linkExtractor pure functions: url sanitization (javascript:/data: must
//      never become an href), PDF user space → viewport rect mapping (the
//      bottom-left flip is the classic silent failure), item association, and
//      internal dest → page resolution.
//   2. assemblePage integration: an item under a LinkAnnotation becomes an
//      <a href> with data-link-source/data-link-page; page sections carry the
//      id="page-N" anchors internal links point at; a link over a textless
//      region (figure/table) surfaces as data-link on the .pdf-region wrapper.
//   3. The Docling adapter: linked text blocks wrap their anchored text in
//      <a>, and links over pictures/tables ride on the region wrapper.
//
// Run: node src/extraction/check-pdf-links.cjs
// ===================================================================================

let pass = 0, fail = 0;
const fails = [];
function ok(cond, label) {
    if (cond) pass++;
    else { fail++; fails.push(label); }
}

const viewport = { width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] };

function item(str, x, y, size = 10, opts = {}) {
    return {
        str, fontName: opts.fontName ?? 'ABCDEF+TimesNewRoman',
        transform: [1, 0, 0, size, x, y],
        width: opts.width ?? str.length * size * 0.5,
    };
}

function meta(items, overrides = []) {
    return items.map((it, idx) => ({
        str: it.str, fontName: it.fontName, fontSize: it.transform[3],
        vx: it.transform[4], vy: it.transform[5],
        vWidth: it.width, vFont: it.transform[3], idx,
        ...(overrides[idx] || {}),
    }));
}

function region(items, type, bbox) {
    return {
        type, listOrdered: false, bbox, yCenter: (bbox.y + bbox.h / 2),
        fontSize: 10, columnIndex: -1,
        textItemIndices: items.map((_, i) => i),
    };
}

(async () => {
    const linkExtractor = await import('./vector/linkExtractor.js');
    const { sanitizeLinkUrl, annotationRectToViewport, associateLinks, finalizeLinks } = linkExtractor;
    const { assemblePage, createFontRegistry } = await import('./vector/pageAssembler.js');
    const { doclingToRegionHtml } = await import('./doclingAdapter.js');

    // ── 1a. URL sanitization ──────────────────────────────────────────────────
    ok(sanitizeLinkUrl('https://example.com/a?b=c') === 'https://example.com/a?b=c', 'https urls survive');
    ok(sanitizeLinkUrl('mailto:someone@example.com') === 'mailto:someone@example.com', 'mailto urls survive');
    ok(sanitizeLinkUrl('javascript:alert(1)') === null, 'javascript: is dropped');
    ok(sanitizeLinkUrl('  javascript:alert(1)  ') === null, 'whitespace-padded javascript: is dropped');
    ok(sanitizeLinkUrl('data:text/html;base64,PHNjcmlwdD4=') === null, 'data: is dropped');
    ok(sanitizeLinkUrl('vbscript:msgbox(1)') === null, 'vbscript: is dropped');
    ok(sanitizeLinkUrl('file:///etc/passwd') === null, 'file: is dropped');
    ok(sanitizeLinkUrl('') === null && sanitizeLinkUrl(null) === null, 'empty / null urls are dropped');
    ok(sanitizeLinkUrl('https://x.com/' + 'a'.repeat(3000)) === null, 'overlong urls are dropped');

    // ── 1b. Annotation rect → viewport (bottom-left flip) ────────────────────
    // rect [x1,y1,x2,y2] in PDF user space (y up). On a 792pt page this must
    // land y at 142 (bottom edge 650 → 792-650) with height 50.
    const r = annotationRectToViewport([100, 600, 200, 650], viewport);
    ok(r && r.x === 100 && r.y === 142 && r.w === 100 && r.h === 50,
        `a bottom-left rect maps to top-left viewport space (got ${JSON.stringify(r)})`);
    ok(annotationRectToViewport(null, viewport) === null, 'null rect is refused');
    ok(annotationRectToViewport([1, 2, NaN, 4], viewport) === null, 'a NaN rect is refused');

    // ── 1c. Association: link rect → covered textMeta indices ────────────────
    const linkedItems = item('Click here', 50, 100, 10);
    const linkedMeta = meta([linkedItems], [{ vx: 50, vy: 100, vWidth: 90, vFont: 10 }]);
    const assoc = associateLinks(
        [{ href: 'https://example.com', page: 1, kind: 'external', rect: { x: 48, y: 88, w: 95, h: 26 }, itemIndices: [] }],
        linkedMeta,
    );
    ok(assoc[0].itemIndices.length === 1 && assoc[0].itemIndices[0] === 0, 'a rect over an item associates that item');
    ok(assoc[0].text === 'Click here', `associated text is joined from covered items (got "${assoc[0].text}")`);

    const noText = associateLinks(
        [{ href: 'https://example.com', page: 1, kind: 'external', rect: { x: 500, y: 500, w: 20, h: 20 }, itemIndices: [] }],
        linkedMeta,
    );
    ok(noText[0].itemIndices.length === 0, 'a rect over empty space associates nothing (textless link)');

    // ── 1d. finalizeLinks: external sanitized, internal dest resolved ────────
    // Real pdf.js shape: LINK is annotationType 2 and subtype 'Link'.
    // annotationType 1 is TEXT (a sticky note) — testing against 1 was the bug
    // that made every link in every document disappear.
    const annotations = [
        { annotationType: 2, subtype: 'Link', rect: [100, 600, 200, 650], url: 'javascript:alert(1)' },
        { annotationType: 2, subtype: 'Link', rect: [300, 600, 400, 650], url: 'https://example.com' },
        { annotationType: 2, subtype: 'Link', rect: [500, 600, 550, 650], dest: 'namedTarget' },
        { annotationType: 2, subtype: 'Link', rect: [100, 700, 200, 750], dest: 'missingTarget' },
        { annotationType: 1, subtype: 'Text', rect: [100, 100, 200, 150] },
        { annotationType: 20, subtype: 'Widget', rect: [100, 100, 200, 150] },
    ];
    // The DOCUMENT proxy owns getDestination/getPageIndex. A page handle has
    // neither, and passing one resolved every internal link to null.
    const stubDoc = {
        getDestination: async (d) => (d === 'namedTarget' ? [{ num: 43, gen: 0 }, { name: 'XYZ' }, 36, 76, null] : null),
        getPageIndex: async (ref) => (ref && ref.num === 43 ? 5 : -1),
    };
    const links = await finalizeLinks(annotations, viewport, 1, stubDoc);
    ok(links.length === 2, `finalizeLinks keeps only usable links (got ${links.length})`);
    ok(links.some(l => l.kind === 'external' && l.href === 'https://example.com'), 'the safe external link survives');
    ok(!links.some(l => /javascript/i.test(l.href || '')), 'no javascript: href ever reaches a link');
    const internal = links.find(l => l.kind === 'internal');
    ok(internal && internal.href === '#page-6' && internal.destPage === 6,
        `internal dest resolves to a page anchor (got ${internal && internal.href})`);
    ok(links.every(l => l.itemIndices && Array.isArray(l.itemIndices)), 'every link carries an itemIndices array');

    // A named destination resolving through a raw PDF ref must go through the
    // document's getPageIndex (0-based) and come back 1-based.
    ok(internal && internal.destPage === 6, `a ref destination resolves via getPageIndex (got ${internal && internal.destPage})`);
    // The link reader must not depend on the numeric code alone.
    const { readLinkAnnotations, isLinkAnnotation } = linkExtractor;
    ok(isLinkAnnotation({ subtype: 'Link' }) === true, 'subtype Link is a link');
    ok(isLinkAnnotation({ annotationType: 2 }) === true, 'annotationType 2 is a link');
    ok(isLinkAnnotation({ annotationType: 1, subtype: 'Text' }) === false, 'a Text annotation is not a link');
    // Four Link annotations in, minus the javascript: one the sanitizer voids.
    ok(readLinkAnnotations(annotations, viewport, 1).length === 3,
        'Link annotations are read and non-Link annotations are skipped');

    // ── 1e. Baseline vs glyph box ────────────────────────────────────────────
    // vy is the BASELINE. A box hung downwards from it sits in the gap below
    // the line, so a link over line 2 used to associate line 1 instead.
    const twoLineMeta = [
        { str: 'line one text', vx: 50, vy: 100, vWidth: 100, vFont: 10 },
        { str: 'line two text', vx: 50, vy: 115, vWidth: 100, vFont: 10 },
    ];
    const secondLine = associateLinks(
        [{ href: 'https://example.com', page: 1, kind: 'external', rect: { x: 50, y: 107, w: 100, h: 10 }, itemIndices: [] }],
        twoLineMeta,
    );
    ok(secondLine[0].itemIndices.length === 1 && secondLine[0].itemIndices[0] === 1,
        `a link over the second line associates the second line (got ${JSON.stringify(secondLine[0].itemIndices)})`);

    // ── 1f. Sub-item spans ───────────────────────────────────────────────────
    // pdf.js emits a whole line as one item. A link over two words must not
    // claim the sentence.
    const lineMeta = [{ str: 'Refer to Fig. 8 for the trap conversion.', vx: 0, vy: 100, vWidth: 400, vFont: 10 }];
    const partial = associateLinks(
        [{ href: '#page-11', page: 1, kind: 'internal', rect: { x: 90, y: 92, w: 60, h: 10 }, itemIndices: [] }],
        lineMeta,
    );
    ok(partial[0].text === 'Fig. 8', `a partial rect yields only the covered words (got "${partial[0].text}")`);
    ok(partial[0].spans.length === 1 && partial[0].spans[0].index === 0,
        'the span records which item it cuts');

    // ── 2. assemblePage integration ──────────────────────────────────────────
    const paraItems = [
        ...item('Click here', 50, 100, 10).str.split(' ').map((w, i) => item(w, 50 + i * 50, 100, 10)),
        ...item('for details.', 200, 100, 10).str.split(' ').map((w, i) => item(w, 200 + i * 50, 100, 10)),
    ];
    const paraMeta = meta(paraItems);
    // First two words are under the link rect.
    const linkedPara = associateLinks(
        [{ href: 'https://example.com', page: 1, kind: 'external', rect: { x: 45, y: 88, w: 110, h: 26 }, itemIndices: [] }],
        paraMeta,
    );
    const paraPage = assemblePage(
        [region(paraItems, 'PARAGRAPH', { x: 40, y: 88, w: 330, h: 26 })], paraMeta, paraItems,
        viewport, 612, 1, createFontRegistry(), [], {}, null, linkedPara,
    );
    // textRebuilder breaks the synthetic words into separate sentence-paragraphs,
    // so assert per-item wrapping rather than a merged run.
    ok(/<a href="https:\/\/example\.com" data-link-source="pdf" data-link-page="1">Click<\/a>/.test(paraPage.html),
        'a paragraph item under a LinkAnnotation is wrapped in <a href>');
    ok(/<a href="https:\/\/example\.com" data-link-source="pdf" data-link-page="1">here<\/a>/.test(paraPage.html),
        'every covered item on the line is wrapped');
    ok(paraPage.html.includes('>for</p>') && paraPage.html.includes('>details.</p>'),
        'text outside the link rect stays outside any <a>');
    ok(!/details\.<\/a>/.test(paraPage.html), 'the trailing word is not pulled into a link');
    ok(/<section class="pdf-page-content" id="page-1"/.test(paraPage.html),
        'page sections carry the id="page-N" anchors internal links point at');

    // Two different hrefs on one line must NOT merge into one <a>.
    const twoLinkItems = item('A B', 50, 100, 10).str.split(' ').map((w, i) => item(w, 50 + i * 30, 100, 10));
    const twoLinkMeta = meta(twoLinkItems);
    const twoLinks = associateLinks([
        { href: 'https://a.example.com', page: 1, kind: 'external', rect: { x: 45, y: 88, w: 32, h: 26 }, itemIndices: [] },
        { href: 'https://b.example.com', page: 1, kind: 'external', rect: { x: 80, y: 88, w: 32, h: 26 }, itemIndices: [] },
    ], twoLinkMeta);
    const twoLinkPage = assemblePage(
        [region(twoLinkItems, 'PARAGRAPH', { x: 40, y: 88, w: 120, h: 26 })], twoLinkMeta, twoLinkItems,
        viewport, 612, 1, createFontRegistry(), [], {}, null, twoLinks,
    );
    const aCount = (twoLinkPage.html.match(/<a href="https:\/\/a\.example\.com"/g) || []).length;
    const bCount = (twoLinkPage.html.match(/<a href="https:\/\/b\.example\.com"/g) || []).length;
    ok(aCount === 1 && bCount === 1, `distinct hrefs emit distinct <a> tags (a:${aCount}, b:${bCount})`);

    // A whole line as ONE item (what pdf.js actually hands us) with a link over
    // two words: only those words become the <a>.
    const oneLine = [item('Refer to Fig. 8 for the trap conversion.', 0, 100, 10, { width: 400 })];
    const oneLineMeta = meta(oneLine, [{ vx: 0, vy: 100, vWidth: 400, vFont: 10 }]);
    const oneLineLinks = associateLinks(
        [{ href: '#page-11', page: 1, kind: 'internal', rect: { x: 90, y: 92, w: 60, h: 10 }, itemIndices: [] }],
        oneLineMeta,
    );
    const oneLinePage = assemblePage(
        [region(oneLine, 'PARAGRAPH', { x: 0, y: 88, w: 420, h: 26 })], oneLineMeta, oneLine,
        viewport, 612, 1, createFontRegistry(), [], {}, null, oneLineLinks,
    );
    ok(/<a href="#page-11"[^>]*>Fig\. 8<\/a>/.test(oneLinePage.html),
        `only the covered words of a one-item line become the link (got ${oneLinePage.html.slice(0, 400)})`);
    ok(/Refer to\s*<a /.test(oneLinePage.html) && /<\/a>\s*for the trap conversion\./.test(oneLinePage.html),
        'the rest of the line survives outside the <a>');

    // Textless link over a figure → data-link on the region wrapper.
    const figItems = [item('Caption', 50, 300, 10)];
    const figMeta = meta(figItems);
    const figLink = associateLinks(
        [{ href: 'https://fig.example.com', page: 1, kind: 'external', rect: { x: 40, y: 220, w: 200, h: 100 }, itemIndices: [] }],
        figMeta,
    );
    const figPage = assemblePage(
        [region(figItems, 'IMAGE', { x: 40, y: 210, w: 200, h: 110 })], figMeta, figItems,
        viewport, 612, 1, createFontRegistry(), [], {}, null, figLink,
    );
    ok(/<div class="pdf-region"[^>]*data-link="https:\/\/fig\.example\.com"/.test(figPage.html),
        'a textless link over a figure rides on the .pdf-region wrapper as data-link');

    // ── 3. Docling adapter ────────────────────────────────────────────────────
    const docling = doclingToRegionHtml({
        page_sizes: { '1': { width: 600, height: 800 } },
        order: [{ kind: 'texts', index: 0 }, { kind: 'pictures', index: 0 }],
        texts: [{
            index: 0, label: 'text', text: 'Read the docs here.', page_no: 1,
            bbox: { l: 50, r: 540, t: 700, b: 660, coord_origin: 'BOTTOMLEFT' },
            links: [{
                href: 'https://docs.example.com', text: 'docs', page_no: 1,
                bbox: { l: 100, r: 145, t: 690, b: 670, coord_origin: 'BOTTOMLEFT' },
            }],
        }],
        pictures: [
            { index: 0, label: 'picture', page_no: 1, bbox: { l: 50, r: 250, t: 500, b: 300, coord_origin: 'BOTTOMLEFT' } },
        ],
        links: [
            {
                href: 'https://fig.example.com', text: '', page_no: 1,
                bbox: { l: 50, r: 250, t: 500, b: 300, coord_origin: 'BOTTOMLEFT' },
            },
        ],
    });
    ok(/<a href="https:\/\/docs\.example\.com" data-link-source="docling"[^>]*>docs<\/a>/.test(docling.html),
        'docling linked text is wrapped in <a href> with data-link-source="docling"');
    ok(/Read the /.test(docling.html) && / here\./.test(docling.html),
        'docling link text is wrapped in place, neighbours preserved');
    ok(/<div class="pdf-region"[^>]*data-link="https:\/\/fig\.example\.com"/.test(docling.html),
        'a docling link over a picture rides on the region wrapper as data-link');

    console.log(`check-pdf-links: ${pass} passed, ${fail} failed`);
    if (fail) {
        console.log('FAILURES:');
        for (const f of fails) console.log('  - ' + f);
        process.exit(1);
    }
    console.log('PASS — LinkAnnotations survive as <a href>, page anchors, and data-link regions; Docling links ride the same rails.');
})();
