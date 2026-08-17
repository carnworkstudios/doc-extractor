#!/usr/bin/env node
// ===================================================================================
// check-image-pipeline — a picture region must reach the page with its pixels
// ===================================================================================
// The regression this guards has two halves, and both were shipped and silent.
//
// 1. `assemblePage` renders an IMAGE region either as `<img src="data:…">` or,
//    when its crop is missing from `extractedImages`, as an empty dashed
//    PLACEHOLDER. A caller that passes `{}` therefore produces a document whose
//    pictures are all gone while every region, bbox and tag survives — nothing
//    throws, the region count is right, and the artifacts panel still lists an
//    image the page no longer shows. Two callers did exactly that: the local
//    OCR bridge and the scanned re-extract.
//
// 2. A picture region that is exactly one raster XObject takes that XObject's
//    id. The SAME XObject painted twice on a page (a repeated icon, a logo on
//    every panel) then yields several regions sharing ONE id — the same failure
//    as having no id, since a page-local id is half the cross-tool address.
//
// 3. The crop reaches the page as a REFERENCE into the blob store, never as
//    base64 in the markup. Inlining it put ~1.4 MB on a single line of the
//    document string — which is simultaneously the Monaco model, the
//    contenteditable surface, and the DOMParser input for every region lookup.
//    Monaco stops rendering a line at 10,000 characters, so an image opened in
//    the editor was a start tag that never closed. The rail has two ends and
//    both are guarded here: the producers must WRITE the pixels to the store,
//    and every surface that writes markup must HYDRATE it. A key with nothing
//    to resolve it is a blank figure, which is failure mode (1) again by
//    another route.
//
// Both are invisible to any runtime harness that loads one side only, which is
// why this check is static for (1) and (3) and behavioural for (2).
//
// Run: node src/extraction/check-image-pipeline.cjs
// ===================================================================================

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, label) {
    if (cond) { pass++; } else { fail++; fails.push(label); }
}

const SRC = path.join(__dirname, '..');

// Every file that calls assemblePage. Listed rather than globbed so a new
// caller has to be added here deliberately — which is the moment to ask whether
// it has crops to pass.
const CALLERS = [
    'workers/geometryWorker.js',
    'ui/fileUpload.js',
];

/** Split a call's argument list at top level, respecting nesting and strings. */
function splitArgs(src, openIdx) {
    const args = [];
    let depth = 0, start = openIdx + 1, quote = null;
    for (let i = openIdx + 1; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' && depth === 0) { args.push(src.slice(start, i)); return args; }
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ',' && depth === 0) { args.push(src.slice(start, i)); start = i + 1; }
    }
    return args;
}

(async () => {
    // ── 1. No caller may hand assemblePage an empty image map ────────────────
    for (const rel of CALLERS) {
        const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
        let idx = -1, calls = 0;
        while ((idx = src.indexOf('assemblePage(', idx + 1)) !== -1) {
            // Skip the import statement and the function's own definition.
            const before = src.slice(Math.max(0, idx - 40), idx);
            if (/import\s*\{[^}]*$/.test(before) || /function\s+$/.test(before)) continue;
            calls++;
            const args = splitArgs(src, idx + 'assemblePage'.length).map(a => a.trim());
            const imagesArg = args[8];
            ok(imagesArg !== undefined,
               `${rel}: assemblePage call #${calls} passes an extractedImages argument`);
            ok(imagesArg !== '{}',
               `${rel}: assemblePage call #${calls} passes real crops, not {} ` +
               `(an empty map renders every picture on the page as an empty placeholder)`);
        }
        ok(calls > 0, `${rel}: still calls assemblePage (list is not stale)`);
    }

    // ── 2. The placeholder branch is what an empty map produces ──────────────
    // Asserted directly so check 1's premise cannot rot: if the assembler ever
    // stops needing crops, this fails and check 1 can be retired on purpose.
    const { assemblePage, createFontRegistry } = await import('../extraction/vector/pageAssembler.js');
    const viewport = { width: 1224, height: 1584, transform: [2, 0, 0, -2, 0, 1584] };
    const region = {
        type: 'IMAGE', id: 'img_p0_1', bbox: { x: 100, y: 100, w: 400, h: 300 },
        yCenter: 250, textItemIndices: [], columnIndex: -1,
    };
    const bare = assemblePage([{ ...region }], [], [], viewport, 612, 1, createFontRegistry(), [], {}, null);
    ok(!/<img[^>]+src=/.test(bare.html),
       'an empty extractedImages map yields an img with NO src (the placeholder branch)');
    ok(bare.html.includes('data-region-id="img_p0_1"'),
       'the placeholder still carries the region id');

    const crop = { img_p0_1: { key: 'p1::img_p0_1', pw: 1600, ph: 1200, scale: 4 } };
    const withImg = assemblePage([{ ...region }], [], [], viewport, 612, 1, createFontRegistry(), [], crop, null);
    ok(/<img[^>]+data-img-id="p1::img_p0_1"/.test(withImg.html),
       'a supplied crop is referenced by its store key');
    ok(!/src="data:/.test(withImg.html),
       'the crop is NOT inlined as base64 — pixels belong in the blob store, not in the document string');
    ok(/width="400"/.test(withImg.html) && /height="300"/.test(withImg.html),
       'crop dimensions are divided by the entry\'s own scale, not a hardcoded 4');

    // A 2× crop (what the scanned bridge produces) must size at 2×, or every
    // picture it emits would be declared half its real size.
    const crop2x = { img_p0_1: { key: 'p1::img_p0_1', pw: 800, ph: 600, scale: 2 } };
    const at2x = assemblePage([{ ...region }], [], [], viewport, 612, 1, createFontRegistry(), [], crop2x, null);
    ok(/width="400"/.test(at2x.html) && /height="300"/.test(at2x.html),
       'a 2× crop is sized by scale 2, not by the geometry worker\'s 4');

    // ── 3. Carry-forward: the crop states the box it came from ──────────────
    // Re-extraction re-classifies a page; it does not repaint it. The worker
    // reuses a crop only when the region's box is unchanged, and it can only do
    // that if the emitted markup says which box the pixels came from.
    ok(/data-crop="100,100,400,300"/.test(withImg.html),
       'an inlined crop states its source box, so a re-extract can tell whether it still applies');
    ok(!/data-crop=/.test(bare.html),
       'a placeholder claims no source box — there are no pixels to carry');

    // A carried crop is already in CSS px, so scale 1 must reproduce the exact
    // markup the original render produced. If this drifts, a re-extract would
    // resize every untouched picture on the page.
    const carriedEntry = { img_p0_1: { key: 'p1::img_p0_1', pw: 400, ph: 300, scale: 1 } };
    const reused = assemblePage([{ ...region }], [], [], viewport, 612, 1, createFontRegistry(), [], carriedEntry, null);
    ok(/width="400"/.test(reused.html) && /height="300"/.test(reused.html),
       'a carried crop (already CSS px, scale 1) re-renders at its original size');

    // Both re-extract handlers must accept the carried crops. If one stops
    // destructuring them it silently falls back to rendering the whole page
    // again on every re-extract — no error, no visible difference, just the
    // cost this exists to avoid.
    const worker = fs.readFileSync(path.join(SRC, 'workers/geometryWorker.js'), 'utf8');
    for (const fn of ['_handleReprocess', '_handleScannedReprocess']) {
        const sig = new RegExp(`function ${fn}\\([^)]*carryImages`);
        ok(sig.test(worker), `${fn} accepts carryImages`);
    }
    ok((worker.match(/\} = _splitCarriedCrops\(/g) || []).length === 2,
       'both re-extract handlers split carried crops from the ones needing a render');
    ok(/const c = carryImages\?\.\[r\.id\];[\s\S]{0,120}c\?\.key/.test(worker),
       'a carried crop is identified by its store key — the pixels never travel');

    // ── 3b. The pixels go to the store, and the key is page-scoped ───────────
    //
    // Inlining a crop as `src="data:…"` put ~1.4 MB on ONE LINE of the document
    // string, and that string is the Monaco model, the contenteditable surface,
    // the DOMParser input for every region lookup and what "Edit Code" hands the
    // editor. Monaco stops rendering a line at 10,000 characters, so an image
    // opened there was a start tag that never closed. Both halves of that
    // regression are structural, so they are guarded structurally.
    const { cropKey, docPrefix, docOfKey } = await import('../utils/imageStore.js');
    ok(cropKey('A', 3, 'image_0') === 'dA::p3::image_0',
       'the store key is scoped by document AND page');
    ok(cropKey('A', 3, 'image_0') !== cropKey('A', 4, 'image_0'),
       'the same page-local region id on two pages gets two keys ' +
       '(a bare id would make one page overwrite the other in the store)');
    ok(cropKey('A', 1, 'picture_0') !== cropKey('B', 1, 'picture_0'),
       'two DOCUMENTS with a picture on page 1 get two keys — the batch pool runs ' +
       'several extractions concurrently into one store, so without this the ' +
       'document that happened to finish last would supply everyone\'s pictures');
    ok(docOfKey(cropKey('A', 1, 'x')) === 'A' && docOfKey('legacy_id') === null,
       'a key states which document it belongs to, so eviction can find it');
    ok(cropKey('A', 1, 'x').startsWith(docPrefix('A')),
       'every key of a document shares one prefix (eviction deletes by range, not by scan)');

    // ── 3c. The cache has a lifetime ─────────────────────────────────────────
    // A cache with no eviction is a leak with extra steps. Three rules, each
    // guarded because each failed silently in an obvious way: unbounded growth,
    // a quota error surfacing as blank pictures, and — the one that actually
    // shipped — `clearImages()` on load, which blanked every OTHER document the
    // session was holding.
    const store = fs.readFileSync(path.join(SRC, 'utils/imageStore.js'), 'utf8');
    for (const fn of ['deleteDoc', 'evictLRU', 'enforceBudget', 'touchDoc']) {
        ok(new RegExp(`export (async )?function ${fn}\\b`).test(store),
           `imageStore exports ${fn}`);
    }
    // Eviction's decision, exercised for real (no IndexedDB needed).
    const { pickVictims } = await import('../utils/imageStore.js');
    const MB = 1024 * 1024;
    const docs = [
        { id: 'old',    bytes: 40 * MB, lastUsed: 100 },
        { id: 'middle', bytes: 30 * MB, lastUsed: 200 },
        { id: 'recent', bytes: 50 * MB, lastUsed: 300 },
        { id: 'live',   bytes: 60 * MB, lastUsed: 50  },   // oldest, but in use
    ];
    const freeing = (v) => v.reduce((n, r) => n + r.bytes, 0);

    const v1 = pickVictims(docs, { keep: 'live', target: 10 * MB });
    ok(v1.length === 1 && v1[0].id === 'old',
       'evicts least-recently-used first, and only as much as the target needs');
    ok(!pickVictims(docs, { keep: 'live', target: Infinity }).some(v => v.id === 'live'),
       'never evicts the document in use — even when it is the oldest and the largest');
    const v2 = pickVictims(docs, { keep: 'live', target: 50 * MB });
    ok(freeing(v2) >= 50 * MB,
       'keeps taking documents until the target is actually met, not until it is nearly met');
    ok(v2.map(d => d.id).join() === 'old,middle',
       `evicts in strict LRU order (got ${v2.map(d => d.id).join() || 'nothing'})`);
    ok(pickVictims(docs, { keep: 'live', target: 0 }).length === 0,
       'frees nothing when nothing needs freeing');
    ok(pickVictims([], { target: 100 * MB }).length === 0 &&
       pickVictims(null, { target: 100 * MB }).length === 0,
       'an empty or absent cache evicts nothing rather than throwing');
    ok(/pickVictims\(/.test(store.slice(store.indexOf('export async function evictLRU'))),
       'evictLRU uses that decision rather than a second copy of it');

    ok(/QuotaExceededError/.test(store),
       'a full disk is handled (evict + retry), not thrown at the extraction');
    ok(/IDBKeyRange\.bound\(/.test(store),
       'a document is deleted by key range — never by loading its blobs to look at them');
    const loader = fs.readFileSync(path.join(SRC, 'ui/fileUpload.js'), 'utf8');
    // Comments stripped: this file explains WHY it must not call clearImages,
    // and the explanation must not read as the call it warns about.
    const loaderCode = loader.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    ok(!/\bclearImages\(/.test(loaderCode),
       'loading a file does NOT clear the whole store — a batch and the compare slot ' +
       'are live documents in it, and clearing on load blanks them');
    // Boot reclaim. Nothing persists extracted HTML across a reload, so every
    // blob alive at startup is unreferenced by construction — without this the
    // cache gains one dead document per session and only the byte budget, far
    // later, ever notices.
    const boot = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
    ok(/clearImages\(\)/.test(boot.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')),
       'the app reclaims the previous session\'s pictures at boot');

    ok(/deleteDoc\(previousDocId\)/.test(loader),
       'replacing a slot retires exactly that slot\'s previous document');
    ok(/docId: task\.id/.test(
           fs.readFileSync(path.join(SRC, '../../../assets/pdf-processor/batch/workerPool.js'), 'utf8')),
       'the batch pool tells each worker which document it is extracting');

    // Every producer of pixels must write them to the store. A producer that
    // stops doing so leaves the page referencing a key nothing can resolve —
    // silent blank figures, exactly the failure this pipeline keeps having.
    const PRODUCERS = [
        ['workers/geometryWorker.js', 'saveImages'],
        ['ui/fileUpload.js',          'saveImages'],
    ];
    for (const [rel, fn] of PRODUCERS) {
        const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
        ok(new RegExp(`import\\s*\\{[^}]*${fn}[^}]*\\}\\s*from\\s*['"][^'"]*imageStore`).test(src),
           `${rel}: imports ${fn} from the blob store`);
        ok(new RegExp(`cropKey\\(`).test(src),
           `${rel}: keys its crops with cropKey (page-scoped, not the bare region id)`);
        ok(!/dataUrl:\s*'data:image\/png;base64,'\s*\+/.test(src),
           `${rel}: no longer base64-encodes a crop into the document string`);
    }

    // The adapter is pure (no IndexedDB in a node check), so it must hand its
    // pictures to the caller rather than embedding them.
    const adapter = fs.readFileSync(path.join(SRC, 'extraction/doclingAdapter.js'), 'utf8');
    ok(/data-img-id="\$\{esc\(key\)\}"/.test(adapter),
       'doclingAdapter references its pictures by store key');
    ok(!/<img[^`]*src="\$\{esc\(pic\.image\)\}"/.test(adapter),
       'doclingAdapter no longer inlines the backend base64 into the page');

    // Hydration is the other half: a key with nothing to resolve it is a blank
    // figure. Every surface that writes markup has to hydrate what it wrote.
    const sync = fs.readFileSync(path.join(SRC, 'ui/htmlSync.js'), 'utf8');
    ok(/createObjectURL/.test(sync),
       'htmlSync resolves store keys to blob: object URLs');
    for (const writer of ['applyHtmlEverywhere', 'patchPageHtml', 'syncStateToDOMOnFocus']) {
        const body = sync.slice(sync.indexOf(`function ${writer}`));
        const end = body.indexOf('\nexport ', 1);
        ok(/hydrateImages\(/.test(end > 0 ? body.slice(0, end) : body),
           `${writer} hydrates the markup it just wrote`);
    }
    const virt = fs.readFileSync(path.join(SRC, 'ui/docVirtualizer.js'), 'utf8');
    ok(/hydrateImages/.test(virt),
       'a page brought back from the virtualizer is re-hydrated (its crop was never in the parked string)');

    // The export is the one place base64 SHOULD reappear: a downloaded file has
    // no IndexedDB and no session to resolve a blob URL against.
    const upload = fs.readFileSync(path.join(SRC, 'ui/fileUpload.js'), 'utf8');
    const dl = upload.slice(upload.indexOf('export async function downloadExtractedHTML'));
    ok(/img\[data-img-id\]/.test(dl) && /readAsDataURL/.test(dl),
       'downloadExtractedHTML re-inlines stored pixels so the exported file is standalone');

    // ── 4. One page-local id per region, even for a repeated XObject ─────────
    const { classifyPage } = await import('../extraction/vector/contextClassifier.js');
    const sameImage = id => ([
        { id, bbox: { x: 60,  y: 80,  w: 120, h: 120 }, axisAligned: true },
        { id, bbox: { x: 600, y: 900, w: 120, h: 120 }, axisAligned: true },
    ]);
    const { regions } = classifyPage([], [], viewport, 612, sameImage('img_p0_7'), {});
    const pics = regions.filter(r => r.type === 'IMAGE');
    ok(pics.length === 2, `two separated placements stay two regions (got ${pics.length})`);
    ok(new Set(pics.map(r => r.id)).size === pics.length,
       `each picture region has its own id (got ${pics.map(r => r.id).join(', ')})`);
    ok(pics.some(r => r.id === 'img_p0_7'),
       'the first placement keeps the XObject id, so the decoded-image fast path still resolves');

    // Ids stay unique across region TYPES too — the address is page-local, not
    // type-local, and every consumer looks a region up by id alone.
    const allIds = regions.map(r => r.id).filter(Boolean);
    ok(new Set(allIds).size === allIds.length, 'no two regions on a page share an id');

    console.log('\nimage pipeline:\n');
    if (fail) {
        console.log(`image pipeline checks: ${pass}/${pass + fail}`);
        fails.forEach(f => console.log('  FAIL — ' + f));
        process.exit(1);
    }
    console.log(`image pipeline checks: ${pass}/${pass + fail}`);
    console.log(`PASS — every assemblePage caller supplies real crops, the pixels
       go to the page-scoped blob store instead of into the document string,
       every surface that writes markup hydrates it, the export re-inlines, and
       a repeated XObject produces one addressable region per placement.`);
})();
