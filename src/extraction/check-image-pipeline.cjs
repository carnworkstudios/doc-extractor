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

    // ── 3b. The semantic walkers must reach a picture wherever it is wrapped ──
    // A picture that recovered its own labels is wrapped in .pdf-image-stack,
    // and one paired with a caption is wrapped in <figure class="pdf-figure">.
    // Neither is the bare .pdf-image-placeholder. Matching only the bare class
    // made the markdown/XML/IR walkers stop ON the wrapper and fall through to
    // the paragraph branch, which emitted the figure's axis labels as prose and
    // dropped the image from every semantic export.
    const exporter = fs.readFileSync(path.join(SRC, 'ui/exportController.js'), 'utf8');
    ok(/export const IMAGE_BLOCK_RE = [^\n]*placeholder\|stack/.test(exporter),
       'IMAGE_BLOCK_RE matches both the bare placeholder and the labelled image stack');
    ok(/export const FLOW_WRAPPER_RE = [^\n]*\bfigure\b[^\n]*\//.test(exporter),
       'FLOW_WRAPPER_RE descends into a captioned <figure> instead of stopping on it');
    // Same rule for a callout's classified children: `.pdf-box-block` carries a
    // child's address, it is not a leaf. Stopping on it would emit a nested
    // table or bullet list as one run of prose — the flattening the box-interior
    // pass exists to remove, reintroduced on the way OUT.
    ok(/export const FLOW_WRAPPER_RE = [^\n]*\bbox-block\b/.test(exporter),
       'FLOW_WRAPPER_RE descends into a callout child instead of stopping on it');
    ok((exporter.match(/IMAGE_BLOCK_RE\.test\(cls\)/g) || []).length === 2,
       'both semantic exporters (markdown, XML) route pictures through IMAGE_BLOCK_RE');
    ok(!/cls\.includes\('pdf-image-placeholder'\)/.test(exporter),
       'no walker still tests the bare placeholder class by substring');

    const toIr = fs.readFileSync(path.join(SRC, 'ir/htmlToGxDoc.js'), 'utf8');
    ok(/IMAGE_BLOCK_RE\.test\(cls\)/.test(toIr),
       'htmlToGxDoc routes pictures through IMAGE_BLOCK_RE');
    ok(/pdf-image-textlayer/.test(toIr) && /labelBox/.test(toIr),
       'htmlToGxDoc carries a figure\'s own labels — and their viewBox — into the image block');
    const fromIr = fs.readFileSync(path.join(SRC, 'ir/gxDocToHtml.js'), 'utf8');
    ok(/pdf-image-textlayer/.test(fromIr) && /viewBox/.test(fromIr),
       'gxDocToHtml re-emits the label layer, so the IR round trip is lossless');

    // ── 3c. The label overlay must never re-introduce a container query ──────
    // `container-type: inline-size` makes a box compute its inline size as if
    // it had no contents. The image stack is shrink-to-fit, so it resolved to
    // ZERO and took the picture with it: every labelled figure rendered 0×0 in
    // exported HTML. The overlay is an SVG viewBox now — it scales with the
    // image on its own and needs no container to query.
    for (const [rel, label] of [
        ['extraction/vector/pageAssembler.js', 'the assembler'],
        ['ir/gxDocToHtml.js', 'the IR renderer'],
    ]) {
        const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
        // Scoped to the stack's own emission — both files discuss the property
        // in comments, and an unrelated block-level grid may legitimately use it
        // (only a SHRINK-TO-FIT box collapses under inline-size containment).
        const stackDecls = [];
        for (let i = src.indexOf('pdf-image-stack'); i !== -1; i = src.indexOf('pdf-image-stack', i + 1)) {
            stackDecls.push(src.slice(i, i + 260));
        }
        ok(stackDecls.length > 0, `${label} still emits a pdf-image-stack (this check is not stale)`);
        ok(stackDecls.every(d => !/container-type/.test(d)),
           `${label} puts no container-type on the image stack (it collapses a shrink-to-fit box to 0)`);
        ok(!/cqw\s*;/.test(src),
           `${label} does not size labels in cqw (the unit that needed the container)`);
    }
    const asm = fs.readFileSync(path.join(SRC, 'extraction/vector/pageAssembler.js'), 'utf8');
    ok(/<svg class="pdf-image-textlayer" viewBox=/.test(asm),
       'the label overlay is an SVG viewBox, so it scales with the picture');
    ok(/y="\$\{y\.toFixed\(2\)\}"/.test(asm),
       'SVG text is placed on the measured BASELINE — no cap-height guess');

    // The overlay's units are the CROP'S OWN PIXEL GRID, not the region bbox.
    // Deriving the mapping from the bbox re-reads it through `width`/`height`
    // attributes, which are INTEGERS — a 97-viewport-px crop declares 48 where
    // it is really 48.5, and that half pixel became a 1.46% scale MISMATCH
    // between the two axes that skewed every label further out the further it
    // sat from the origin. Measured 1.464% → 0.022% by using pw/ph.
    ok(/const vbW = imgPixels\?\.pw \|\| bbox\.w/.test(asm),
       'the viewBox is the crop pixel grid, falling back to the bbox only when there is no crop');
    ok(/_imageTextLayer\(region, textMeta, imgEntry/.test(asm),
       'the assembler hands the crop entry to the label layer');
    // The overlay is not drawn in the document's embedded font, so an
    // unconstrained run drifts from its raster twin as it gets longer.
    ok(/textLength=/.test(asm) && /lengthAdjust="spacingAndGlyphs"/.test(asm),
       'each run declares the advance width the PDF measured');
    ok(/tm\.str\.length > 1/.test(asm),
       'a single glyph is left unconstrained — it has no spacing to redistribute');
    ok(/transform="rotate\(/.test(asm),
       'a rotated run (a chart y-axis label) is rotated about its own baseline origin');

    // Rotation and em height must come off the text matrix, not off |d|.
    const cls = fs.readFileSync(path.join(SRC, 'extraction/vector/contextClassifier.js'), 'utf8');
    ok(/Math\.hypot\(t\[2\], t\[3\]\)/.test(cls),
       'em height is the LENGTH of the matrix y basis (|d| is 0 on a 90° run, which fell through to 12pt)');
    ok(/Math\.atan2\(ay - vy, ax - vx\)/.test(cls),
       'baseline direction is measured from the mapped advance vector, not inferred from the flip');

    // ── 6b. A label is placed by its MATRIX, not by three scalars ────────────
    // vx/vy, rot and vFont are each a reduction of the run's own text matrix,
    // and each one loses something: a sheared run keeps no shear, a
    // non-uniformly scaled run keeps one scale. The schema editor's PDF import
    // already solved this — compose the item transform with the viewport
    // transform and place the run with the result whole. Ported here.
    ok(/vm: mulMatrix\(vpT, t\)/.test(cls),
       'textMeta carries the run\'s viewport-space text matrix, not only scalars read off it');
    ok(/transform="matrix\(/.test(asm) && /scale\(1,-1\)/.test(asm),
       'the label overlay places a run by its matrix, un-flipping the glyphs with scale(1,-1) ' +
       'rather than by negating the coordinates (which moves the baseline, not the glyphs)');
    ok(/m\[0\] \/ fs, m\[1\] \/ fs, m\[2\] \/ fs, m\[3\] \/ fs/.test(asm),
       'the basis is normalised out before font-size is set — a text matrix already carries the ' +
       'em size, and setting font-size beside an un-normalised matrix multiplies the two');

    // Behaviour, not just source. A 90°-rotated label must come out placed by a
    // matrix at the size the matrix states.
    const vpm = { width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] };
    const labelRegion = {
        type: 'IMAGE', id: 'img_m0', bbox: { x: 100, y: 100, w: 200, h: 100 },
        yCenter: 150, textItemIndices: [0], columnIndex: -1,
    };
    // A run rotated 90°: its viewport matrix has a zero a/d and a live b/c.
    const labelMeta = [{
        idx: 0, str: 'Voltage (V)', fontName: 'Helvetica', fontSize: 8,
        vx: 120, vy: 180, vWidth: 40, vFont: 8,
        vm: [0, -8, 8, 0, 120, 180],
    }];
    const labelItems = [{ str: 'Voltage (V)', fontName: 'Helvetica', transform: [0, 8, -8, 0, 120, 612] }];
    const labelled = assemblePage([labelRegion], labelMeta, labelItems, vpm, 612, 1,
        createFontRegistry(), [], {}, null);
    const textEl = (labelled.html.match(/<text class="pdf-img-label"[^>]*>/) || [])[0] || '';
    ok(/transform="matrix\(/.test(textEl),
       'a run carrying a matrix is emitted with a matrix transform');
    ok(/font-size="8\.00"/.test(textEl),
       'the em size is the length of the matrix y basis (8), not a scalar guess');
    ok(!/transform="rotate\(/.test(textEl),
       'the matrix carries the rotation — no separate rotate() that could disagree with it');

    // The scalar path must survive for meta built without a matrix, or an
    // older cached extraction would render every label at the origin.
    const scalarMeta = [{ ...labelMeta[0] }];
    delete scalarMeta[0].vm;
    scalarMeta[0].rot = Math.PI / 2;
    const scalarPage = assemblePage([labelRegion], scalarMeta, labelItems, vpm, 612, 1,
        createFontRegistry(), [], {}, null);
    ok(/<text class="pdf-img-label" x="[\d.]+" y="[\d.]+"/.test(scalarPage.html),
       'meta with no matrix still places by x/y — the fallback is not dead');

    ok(/!rotated && Math\.abs\(t\[2\]\) > 0\.05/.test(cls),
       'shear reads as italic only on an upright run — c is the ROTATION on a rotated one');

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
