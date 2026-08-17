#!/usr/bin/env node
// ===================================================================================
// check-pane-sync — the panes agree on where they are, and the document's CSS
//                   survives being a document
// ===================================================================================
// Two things shipped broken here, and both were invisible to anything that only
// looked at one side.
//
// 1. GEOMETRY UNITS. The paper pane fits pages to the pane with CSS `zoom`
//    (0.61 at a typical window). Unlike `transform`, zoom changes LAYOUT: a page
//    wrapper reports offsetHeight 1188 and a bounding rect of 727, and scroll
//    offsets move in the second. Mixing the two put the paper a fixed
//    0.29 × (source y) too far down every page — the two panes still agreed with
//    each OTHER (both used the same wrong unit), so a round-trip test passed
//    while the panes visibly disagreed on screen. Only a measurement against the
//    page itself catches that, so the unit rule is enforced statically here.
//
// 2. THE DOCUMENT'S OWN CSS. `generateDocumentStyles` output used to be
//    prepended to the document string as a <style> block. A fragment that STARTS
//    with <style> is parked in <head> by the HTML parser, so every reader that
//    takes body.innerHTML dropped it — the fonts silently reverted, and the
//    string changed shape on every round trip. It now lives in the app's own
//    stylesheet (ui/docStyles.js) and is re-inlined only on export.
//
// The interpolation itself is exercised for real: it is pure, and its awkward
// case — a column break, where source y steps BACKWARDS as the flow advances —
// is the one place the arithmetic can be quietly wrong.
//
// Run: node src/ui/check-pane-sync.cjs
// ===================================================================================

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, label) {
    if (cond) { pass++; } else { fail++; fails.push(label); }
}

const SRC = path.join(__dirname, '..');

(async () => {
    const sync = fs.readFileSync(path.join(SRC, 'ui/scrollSync.js'), 'utf8');
    const code = sync.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');   // comments explain the trap; they are not the trap

    // ── 1. Geometry is measured in scroll units, never layout units ──────────
    for (const banned of ['offsetHeight', 'offsetTop']) {
        ok(!new RegExp(`\\.${banned}\\b`).test(code),
           `scrollSync does not use ${banned} — CSS zoom on the page wrappers makes it a `
           + `different unit from scrollTop, and mixing them drifts by 0.29 of a page`);
    }
    ok(/getBoundingClientRect\(\)/.test(code),
       'scrollSync measures with bounding rects, which are in the same space as scrollTop');
    ok(/function _boxIn\(/.test(code),
       'one helper owns the measurement, so the unit rule holds in one place');

    // ── 2. The shared coordinate is page-based, not percentage-based ─────────
    ok(/data-page/.test(code) && /page-wrapper/.test(code) && /pdf-page-content/.test(code),
       'both panes are addressed by their page structures');
    ok(/data-ry/.test(code),
       'within a page the mapping uses region anchors (data-ry), not a page-height ratio');

    // ── 3. The interpolation, including the column break ─────────────────────
    const { _interpFlow, _inverseFlow } = await import('../ui/scrollSync.js');

    // Plain ascending run: exact at the control points, linear between them.
    const xs = [0, 100, 200], ys = [0, 500, 1000];
    ok(_interpFlow(xs, ys, 0) === 0 && _interpFlow(xs, ys, 100) === 500,
       'interpolation is exact at every anchor');
    ok(_interpFlow(xs, ys, 50) === 250, 'interpolation is linear between anchors');
    ok(_interpFlow(xs, ys, -10) === 0 && _interpFlow(xs, ys, 999) === 1000,
       'positions outside the page clamp to it rather than running off');

    // A column break: flow advances (x up) while the page goes back up (y down).
    // Averaging across it would answer 800 in the middle — a place on the paper
    // the reader never passes through, and the source of the original drift.
    const cx = [0, 100, 110, 200], cy = [0, 1500, 100, 1500];
    ok(_interpFlow(cx, cy, 101) === 1500 && _interpFlow(cx, cy, 109) === 100,
       'a descending segment (column break) snaps to an end, never averages across');
    ok(_interpFlow(cx, cy, 150) > 100 && _interpFlow(cx, cy, 150) < 1500,
       'the column that follows the break still interpolates normally');

    // The inverse is ambiguous by construction on a multi-column page: one y is
    // two places in the flow. It must resolve by continuity, or the prose pane
    // teleports between columns while the paper is dragged smoothly.
    const near1 = _inverseFlow(cx, cy, 800, 40);
    const near2 = _inverseFlow(cx, cy, 800, 180);
    ok(near1 < 100 && near2 > 110,
       `the inverse picks the occurrence nearest where the pane already is `
       + `(got ${near1.toFixed(1)} and ${near2.toFixed(1)})`);
    ok(_inverseFlow([0, 100], [0, 1000], 500, 0) === 50,
       'with no ambiguity the inverse is the plain inverse');

    // ── 4. Feedback control ──────────────────────────────────────────────────
    // Two panes that echo each other walk the document. Whoever moves first owns
    // the gesture until it stops.
    ok(/_driver/.test(code) && /_driver !== el/.test(code),
       'the pane being driven does not drive back');
    ok(/requestAnimationFrame/.test(code),
       'scroll handling is coalesced to a frame rather than run per event');

    // ── 5. Anchors are invalidated when the layout they describe changes ─────
    const htmlSync = fs.readFileSync(path.join(SRC, 'ui/htmlSync.js'), 'utf8');
    ok(/refreshScrollSync\(\)/.test(htmlSync),
       'replacing the whole document clears every cached anchor');
    ok(/invalidatePageAnchors\(pageNum\)/.test(htmlSync),
       're-extracting ONE page invalidates that page only, not the whole cache');

    // ── 6. The document's CSS is not in the document ─────────────────────────
    const styles = fs.readFileSync(path.join(SRC, 'ui/docStyles.js'), 'utf8');
    for (const fn of ['setDocumentStyles', 'getDocumentStyles', 'splitLeadingStyles']) {
        ok(new RegExp(`export function ${fn}\\b`).test(styles), `docStyles exports ${fn}`);
    }

    const producers = [
        ['ui/fileUpload.js', path.join(SRC, 'ui/fileUpload.js')],
        ['batch/workerPool.js', path.join(SRC, '../../../assets/pdf-processor/batch/workerPool.js')],
    ];
    for (const [label, file] of producers) {
        const src = fs.readFileSync(file, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
        ok(!/`<style>\\n\$\{[^}]*styles\}/.test(src),
           `${label}: does not prepend a <style> block to the document string ` +
           `(a leading <style> is parked in <head> and lost by every body.innerHTML reader)`);
        ok(/styles/.test(src), `${label}: still carries the styles alongside the markup`);
    }

    const upload = fs.readFileSync(path.join(SRC, 'ui/fileUpload.js'), 'utf8');
    ok(/setDocumentStyles\(/.test(upload),
       'an extraction installs its stylesheet in the app');
    const dl = upload.slice(upload.indexOf('export async function downloadExtractedHTML'));
    ok(/getDocumentStyles\(\)/.test(dl),
       'the export re-attaches the stylesheet — a downloaded file has no app around it');
    ok(/splitLeadingStyles\(/.test(upload),
       'a document mounted from an older cache still has its leading <style> lifted out ' +
       'rather than handed to a parser that will drop it');

    console.log('\npane sync:\n');
    if (fail) {
        console.log(`pane sync checks: ${pass}/${pass + fail}`);
        fails.forEach(f => console.log('  FAIL — ' + f));
        process.exit(1);
    }
    console.log(`pane sync checks: ${pass}/${pass + fail}`);
    console.log(`PASS — panes are tied by document position measured in one unit,
       a column break neither averages nor teleports, anchors are invalidated
       when the layout changes, and the document's CSS lives where a round trip
       cannot drop it.`);
})();
