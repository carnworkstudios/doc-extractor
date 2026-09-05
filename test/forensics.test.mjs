import assert from 'node:assert/strict';
import {
    observed, inferred, uncertain, report, _resetIds, TIERS,
} from '../src/extraction/forensics/findings.js';
import {
    LAYOUT_CLASSES, headAToRegionType, regionTypeToHeadA, confidenceTier,
} from '../src/extraction/forensics/regionMap.js';
import {
    SIGNAL_NAMES, MAP_NAMES, readSignals, readMaps, peakCell, notableSignals,
} from '../src/extraction/forensics/signals.js';
import { analyseOverlays, _internals as _overlayInternals }
    from '../src/extraction/forensics/overlays.js';
import { analyseMetadata, analyseFonts, analyseFontsAcrossPages, baseFontName }
    from '../src/extraction/forensics/metadataFonts.js';
import { inversionCount, analyseReadingOrder } from '../src/extraction/forensics/readingOrder.js';
import { confidenceMap, analyseOcrConfidence } from '../src/extraction/forensics/ocrConfidence.js';
import { hamming, structuralSimilarity } from '../src/extraction/forensics/duplicatePages.js';
import { validateReport, buildPrompt } from '../src/extraction/forensics/vlmReport.js';
import { analyseDocument, ANALYSERS } from '../src/extraction/forensics/index.js';
import {
    capForEvidence, capForCoverage, blurInS, BLUR_S_CEILING, SKEW_DEG_CEILING,
} from '../src/ui/ocr/ocrScale.js';
import {
    MODELS, DEFAULT_MODEL_ID, requestedModelId, manifestFor, assertSessionMatches,
} from '../src/workers/layoutModels.js';

// ── findings: the epistemic split is enforced, not requested ────────────────

_resetIds();
const o1 = observed('t', 'measured a thing', { value: 42 });
assert.equal(o1.tier, 'observed');
assert.equal(o1.id, 'f_0001', 'ids are stable within a run so the report can cite them');
assert.throws(() => observed('t', 'no numbers here', {}),
    /carries no measurements/,
    'an observed finding with nothing measured is an inference wearing a hat');
assert.throws(() => inferred('t', 'from nowhere', []),
    /cites no basis/,
    'an inference must name what it reasoned from');
assert.doesNotThrow(() => uncertain('t', 'a guess'), 'guesses need no basis — that is the point');
assert.deepEqual(TIERS, ['observed', 'inferred', 'uncertain']);

const rep = report([
    uncertain('t', 'low guess', { severity: 0.1 }),
    observed('t', 'big measurement', { v: 1 }, { severity: 0.9 }),
    inferred('t', 'mid conclusion', [o1.id], { severity: 0.9 }),
]);
assert.equal(rep.findings[0].tier, 'observed',
    'at equal severity an observation outranks an inference');
assert.deepEqual(rep.counts, { observed: 1, inferred: 1, uncertain: 1 });

// ── taxonomy: the mapping is total in one direction and honest in the other ──

assert.equal(LAYOUT_CLASSES.length, 15);
assert.equal(LAYOUT_CLASSES[10], 'seal');
assert.equal(LAYOUT_CLASSES.length, 15, 'form split: seal|form|field|checkbox|signature');
assert.equal(new Set(LAYOUT_CLASSES).size, 15, 'no duplicate class names');
for (const c of LAYOUT_CLASSES) {
    assert.ok(headAToRegionType(c), `every Head A class maps to a RegionType: ${c}`);
}
assert.equal(regionTypeToHeadA('LATTICE_TABLE'), LAYOUT_CLASSES.indexOf('table'));
assert.equal(regionTypeToHeadA('STREAM_TABLE'), LAYOUT_CLASSES.indexOf('table'),
    'both table flavours collapse onto one detector class; the lattice/stream split is decided downstream');
assert.equal(regionTypeToHeadA('BOX'), -1,
    'vector BOX must NOT feed seal — that would poison the only synthesised class');
assert.equal(regionTypeToHeadA('DIVIDER'), -1);
assert.equal(regionTypeToHeadA('REFERENCE'), -1);
assert.equal(headAToRegionType('seal').type, 'BOX');
assert.equal(headAToRegionType('seal').subtype, 'seal',
    'the forensic meaning survives the collapse onto BOX');
assert.equal(headAToRegionType('formula').type, 'MATH');

// Tier is relative to the page, not to an absolute number — a fixed 0.5 means
// different things at the incumbent's 0.25 threshold and the student's 0.18.
assert.equal(confidenceTier(0.9, 0.9), 'inferred');
assert.equal(confidenceTier(0.2, 0.9), 'uncertain');
assert.equal(confidenceTier(0.2, 0.3), 'inferred', 'same score, weaker page — still actionable');

// ── Head B contract ─────────────────────────────────────────────────────────

assert.deepEqual([...SIGNAL_NAMES],
    ['skew', 'blur', 'noise', 'bleed', 'warp', 'tears', 'handwriting', 'native'],
    'signal ORDER is load-bearing and must match degrade.py SIGNALS');
assert.deepEqual([...MAP_NAMES], ['blur', 'bleed', 'tears', 'handwriting']);

const phys = readSignals([0.5, 1.0, 0, 0, 0, 0, 0, 1], SIGNAL_NAMES);
assert.equal(phys.skew, 0, '0.5 is the no-skew midpoint, because a sigmoid cannot carry a sign');
assert.equal(phys.blur, 3.0);
assert.equal(phys.native, 1);
assert.equal(readSignals([1, 0, 0, 0, 0, 0, 0, 0]).skew, 8, 'skew unfolds to +full scale');
assert.equal(readSignals([0, 0, 0, 0, 0, 0, 0, 0]).skew, -8, 'and to -full scale');
assert.throws(() => readSignals([0, 0, 0]), /must have 8 entries/);
assert.throws(
    () => readSignals(new Array(8).fill(0.5),
        ['blur', 'skew', 'noise', 'bleed', 'warp', 'tears', 'handwriting', 'native']),
    /does not match signals\.js/,
    'a manifest that disagrees about signal order must fail LOUDLY, not be reordered silently');

const maps = readMaps(new Float32Array(4 * 400).fill(0.1));
assert.deepEqual(Object.keys(maps), ['blur', 'bleed', 'tears', 'handwriting']);
assert.equal(maps.blur.length, 400);
const withPeak = new Float32Array(400);
withPeak[7 * 20 + 3] = 0.9;
const pk = peakCell(withPeak, 640, 640);
assert.ok(Math.abs(pk.value - 0.9) < 1e-6, "peak value survives the Float32 round trip");
assert.equal(pk.x, 3 * 32);
assert.equal(pk.y, 7 * 32, 'the map can point at WHERE, not only report HOW MUCH');
assert.deepEqual(notableSignals({ skew: 0.1, blur: 0.1, noise: 0, bleed: 0, warp: 0,
                                  tears: 0, handwriting: 0, native: 1 }), [],
    'a clean page reports nothing notable');
assert.equal(notableSignals({ skew: -5, blur: 0.1, noise: 0, bleed: 0, warp: 0,
                              tears: 0, handwriting: 0, native: 1 })[0].signal, 'skew',
    'notability uses |skew| so a negative rotation is not silently ignored');

// ── overlays: concealed text, and the three ways not to cry wolf ────────────

// REALISTIC matrices. `viewportMatrix` is vp * ctm * Tm and does NOT carry the
// font size — a real pdf-lib page at viewport scale 1.6 gives
// [1.6, 0, 0, -1.6, x, y] with fontSize 11. The first version of this test used
// [size, 0, 0, size, x, y] with fontSize === size, which made the matrix scale
// and the point size indistinguishable and let a wrong textBox() formula pass.
// The bug it hid made every run ~7x too small and the whole check silent.
const VPS = 1.6;
const tp = (text, x, y, fontSize, opIdx, mode = 0) => ({
    id: `tp_${opIdx}`, kind: 'TEXT_PAINT', operatorIndex: opIdx, text,
    viewportMatrix: [VPS, 0, 0, -VPS, x, y], fontSize, textRenderingMode: mode,
    fontName: 'ABCDEF+Times', horizontalScale: 100,
});
// 22 chars at 11 pt, scale 1.6 => ~194 px wide, ~17.6 px tall.
const SECRET = 'ACCOUNT 4417 9930 2210';

const redacted = analyseOverlays({
    textPaintOps: [tp(SECRET, 100, 200, 11, 5)],
    // Painted AFTER the text (higher operatorIndex) and white.
    filledRects: [{ operatorIndex: 9, fillColor: [255, 255, 255],
                    x: 90, y: 180, w: 300, h: 40 }],
    displayList: [], imageMeta: [], subpaths: [],
}, 1);
const concealed = redacted.find(
    (f) => f.tier === 'inferred' && /remain in the content stream/.test(f.summary));
assert.ok(concealed, 'white box over later-painted text is reported');
assert.ok(concealed.severity > 0.9, 'and reported as serious');
assert.ok(redacted.some((f) => f.measurements && f.measurements.sampleWithheld === true),
    'the hidden text itself is NEVER copied into the finding');
assert.ok(!JSON.stringify(redacted).includes('4417'),
    'a forensic log must not become the disclosure it is reporting');
// The claim is concealment, not intent: a black box in a figure produces the
// same evidence and is not a cover-up.
assert.ok(/If this was intended as a redaction/.test(concealed.summary),
    'redaction is named as the case that matters, not asserted as the case that occurred');

const highlighted = analyseOverlays({
    // Painted BEFORE the text: this is a highlight, not an overlay.
    textPaintOps: [tp('ordinary prose here', 100, 200, 11, 20)],
    filledRects: [{ operatorIndex: 3, fillColor: [255, 255, 0],
                    x: 90, y: 180, w: 300, h: 40 }],
    displayList: [], imageMeta: [], subpaths: [],
}, 1);
assert.ok(!highlighted.some((f) => f.tier === 'inferred'),
    'a background painted before the text is not an overlay');

// Paint order UNKNOWN — a compound path, where ctmAdapter attaches the
// PATH_PAINT record only to the last subpath. Unknown must not read as
// "painted over": that produced 116 false accusations on a real table document.
const unknownOrder = analyseOverlays({
    textPaintOps: [tp('cell label', 100, 200, 11, 20)],
    filledRects: [{ fillColor: [0, 0, 0], x: 90, y: 180, w: 300, h: 40 }],
    displayList: [], imageMeta: [], subpaths: [],
}, 1);
assert.ok(!unknownOrder.some((f) => f.tier === 'inferred'),
    'an unestablished paint order must never yield an accusation');
assert.ok(unknownOrder.some(
    (f) => f.tier === 'uncertain' && /paint order could not be established/.test(f.summary)),
    'and must say so rather than staying silent');

// A filled COMPOUND path — a table grid — must not be read as one page-sized
// box that covers everything inside it.
const vt = [1, 0, 0, 1, 0, 0];
const gridSubpath = {
    id: 0, filled: true, curves: [], ctm: [1, 0, 0, 1, 0, 0],
    segs: [
        { ax: 0, ay: 0, bx: 400, by: 0 },        // outer edges ...
        { ax: 400, ay: 0, bx: 400, by: 300 },
        { ax: 400, ay: 300, bx: 0, by: 300 },
        { ax: 0, ay: 300, bx: 0, by: 0 },
        { ax: 0, ay: 150, bx: 400, by: 150 },    // ... plus an interior rule
        { ax: 200, ay: 0, bx: 200, by: 300 },
    ],
};
const gridShapes = _overlayInternals.filledShapes(
    { filledRects: [], displayList: [], subpaths: [gridSubpath] }, { transform: vt });
assert.equal(gridShapes.length, 0,
    'a filled path containing interior rules is a grid, not a redaction box');

const solidQuad = {
    id: 1, filled: true, curves: [], ctm: [1, 0, 0, 1, 0, 0],
    segs: [
        { ax: 10, ay: 10, bx: 110, by: 10 },
        { ax: 110, ay: 10, bx: 110, by: 60 },
        { ax: 110, ay: 60, bx: 10, by: 60 },
        { ax: 10, ay: 60, bx: 10, by: 10 },
    ],
};
const quadShapes = _overlayInternals.filledShapes(
    { filledRects: [], displayList: [], subpaths: [solidQuad] }, { transform: vt });
assert.equal(quadShapes.length, 1,
    'a solid axis-aligned quad IS recovered — pdf-lib draws rectangles this way, '
    + 'so relying on the `re` operator alone misses the commonest generated box');
assert.deepEqual(quadShapes[0].rect, { x: 10, y: 10, w: 100, h: 50 });

const diagonal = {
    id: 2, filled: true, curves: [], ctm: [1, 0, 0, 1, 0, 0],
    segs: [
        { ax: 10, ay: 10, bx: 110, by: 60 },
        { ax: 110, ay: 60, bx: 10, by: 60 },
        { ax: 10, ay: 60, bx: 10, by: 10 },
    ],
};
assert.equal(_overlayInternals.filledShapes(
    { filledRects: [], displayList: [], subpaths: [diagonal] }, { transform: vt }).length, 0,
    'a triangle cannot hide a rectangle of text and must not be treated as a box');

const ocrLayer = analyseOverlays({
    textPaintOps: [tp('scanned words', 100, 200, 11, 30, 3)],
    filledRects: [], displayList: [], subpaths: [],
    imageMeta: [{ id: 'im0', bbox: { x: 0, y: 0, w: 1200, h: 1600 } }],
}, 1, { pageBox: { w: 1240, h: 1650 } });
assert.ok(ocrLayer.some((f) => /ordinary OCR text layer/.test(f.summary)),
    'invisible text over a full-page scan is normal and must not be alarmed on');
const bornDigitalInvisible = analyseOverlays({
    textPaintOps: [tp('hidden clause', 100, 200, 11, 30, 3)],
    filledRects: [], displayList: [], imageMeta: [], subpaths: [],
}, 1);
assert.ok(bornDigitalInvisible.some((f) => f.tier === 'inferred' && /not an OCR layer/.test(f.summary)),
    'invisible text with no scan beneath it IS a finding');

// textBox must scale with the FONT SIZE, not only with the matrix.
const small = _overlayInternals.textBox(tp('x'.repeat(20), 0, 100, 6, 1));
const large = _overlayInternals.textBox(tp('x'.repeat(20), 0, 100, 24, 1));
assert.ok(large.h > small.h * 3.5 && large.w > small.w * 3.5,
    'a 24 pt run must measure ~4x a 6 pt run at the same viewport scale');
assert.ok(Math.abs(large.h - 24 * VPS) < 1e-6,
    'em height in viewport px is fontSize x matrix scale, applied exactly once');

// ── metadata + fonts ────────────────────────────────────────────────────────

assert.equal(baseFontName('ABCDEF+Times-Roman'), 'Times-Roman');
assert.equal(baseFontName('Helvetica'), 'Helvetica');

const backdated = analyseMetadata({
    Producer: 'X', CreationDate: 'D:20240101120000', ModDate: 'D:20230101120000',
});
assert.ok(backdated.some((f) => f.tier === 'inferred' && /ModDate precedes CreationDate/.test(f.summary)));
const ordinary = analyseMetadata({
    Producer: 'X', CreationDate: 'D:20240101120000', ModDate: 'D:20240101120000',
});
assert.ok(!ordinary.some((f) => f.tier === 'inferred'),
    'identical timestamps draw no inference');

const twoSubsets = analyseFonts([
    { fontName: 'AAAAAA+Times', text: 'original body text' },
    { fontName: 'BBBBBB+Times', text: 'inserted clause' },
], new Map([
    ['AAAAAA+Times', { name: 'AAAAAA+Times', missingFile: false }],
    ['BBBBBB+Times', { name: 'BBBBBB+Times', missingFile: false }],
]), 1);
assert.ok(twoSubsets.some((f) => f.tier === 'inferred' && /second source/.test(f.summary)),
    'two independently-computed subsets of one typeface on one page is a merge signal');

const acrossPages = analyseFontsAcrossPages([
    { page: 1, fonts: ['AAAAAA+Times'] },
    { page: 2, fonts: ['BBBBBB+Times'] },
    { page: 3, fonts: ['CCCCCC+Courier'] },
    { page: 4, fonts: ['DDDDDD+Times'] },
]);
assert.ok(acrossPages.some((f) => f.tier === 'inferred' && /page 3/.test(f.summary)),
    'the one page sharing no typeface with the majority is flagged');
assert.ok(!acrossPages.some((f) => f.tier === 'inferred' && /page 1/.test(f.summary)),
    'and the pages that DO share one are not');

// ── reading order ───────────────────────────────────────────────────────────

assert.deepEqual(inversionCount(['a', 'b', 'c'], ['a', 'b', 'c']),
    { inversions: 0, pairs: 3, normalised: 0 });
assert.equal(inversionCount(['c', 'b', 'a'], ['a', 'b', 'c']).normalised, 1,
    'exactly reversed normalises to 1, so pages of different sizes are comparable');
const half = inversionCount(['a', 'c', 'b', 'd'], ['a', 'b', 'c', 'd']);
assert.equal(half.inversions, 1);

const orderFindings = analyseReadingOrder([
    { page: 1, normalised: 0.02, inversions: 1, pairs: 50, regions: 10, method: 'xy-cut' },
    { page: 2, normalised: 0.02, inversions: 1, pairs: 50, regions: 10, method: 'xy-cut' },
    { page: 3, normalised: 0.03, inversions: 2, pairs: 50, regions: 10, method: 'xy-cut' },
    { page: 4, normalised: 0.02, inversions: 1, pairs: 50, regions: 10, method: 'xy-cut' },
    { page: 5, normalised: 0.55, inversions: 28, pairs: 50, regions: 10, method: 'xy-cut',
      worst: 'r7', worstDistance: 8 },
]);
assert.ok(orderFindings.some((f) => f.tier === 'inferred' && /page 5/.test(f.summary)),
    'the outlier page is flagged against the DOCUMENT\'s own distribution');

const uniformlyMessy = analyseReadingOrder(
    [1, 2, 3, 4, 5].map((p) => ({ page: p, normalised: 0.45, inversions: 22, pairs: 50,
                                  regions: 10, method: 'xy-cut' })));
assert.ok(uniformlyMessy.some((f) => /property of the producing tool/.test(f.summary)),
    'a writer that never emits in reading order is reported ONCE, not on every page');
assert.ok(!uniformlyMessy.some((f) => /departs from its layout order/.test(f.summary)),
    'and no individual page is accused');

// ── OCR confidence ──────────────────────────────────────────────────────────

const wordAt = (x, y, conf) => ({ text: 'w', confidence: conf,
                                  bbox: { x0: x, y0: y, x1: x + 30, y1: y + 12 } });
const goodWords = [];
for (let y = 0; y < 600; y += 40) for (let x = 0; x < 600; x += 40) goodWords.push(wordAt(x, y, 95));
const cm = confidenceMap(goodWords, 640, 640);
assert.ok(cm.coverage > 0.5);
assert.ok(Math.abs(cm.mean - 0.95) < 1e-6);

// One block reads badly. With no physical explanation, that is the interesting case.
const holed = goodWords.map((w) => (w.bbox.y0 >= 200 && w.bbox.y0 < 320 && w.bbox.x0 < 300
    ? { ...w, confidence: 22 } : w));
const cleanMaps = [0, 1, 2, 3].map(() => new Float32Array(400));
const unexplained = analyseOcrConfidence(
    { words: holed, w: 640, h: 640, forensicMaps: cleanMaps, pageNo: 1 });
assert.ok(unexplained.some((f) => f.tier === 'inferred' && /physically clean where the OCR failed/.test(f.summary)),
    'a confidence hole on a physically clean page is the finding worth having');

// Same hole, but the page is torn there. Now it is explained.
const tornMaps = [0, 1, 2, 3].map(() => new Float32Array(400));
for (let gy = 6; gy < 10; gy++) for (let gx = 0; gx < 9; gx++) tornMaps[2][gy * 20 + gx] = 0.9;
const explained = analyseOcrConfidence(
    { words: holed, w: 640, h: 640, forensicMaps: tornMaps, pageNo: 1 });
assert.ok(explained.some((f) => f.tier === 'inferred' && /explained by the condition of the page/.test(f.summary)),
    'the same hole over measured damage is explained, not alarming');
assert.ok(!explained.some((f) => /physically clean where the OCR failed/.test(f.summary)));

const noMaps = analyseOcrConfidence({ words: holed, w: 640, h: 640, pageNo: 1 });
assert.ok(noMaps.some((f) => f.tier === 'uncertain'),
    'without the forensic maps the module says it cannot tell — it does not guess');

// ── duplicate pages ─────────────────────────────────────────────────────────

const bitsA = Uint8Array.from({ length: 64 }, (_, i) => i % 2);
const bitsB = Uint8Array.from(bitsA); bitsB[0] ^= 1; bitsB[1] ^= 1;
assert.equal(hamming(bitsA, bitsA), 0);
assert.equal(hamming(bitsA, bitsB), 2);

const boxesA = [
    { label: 'heading', bbox: { x: 10, y: 10, w: 180, h: 20 } },
    { label: 'text', bbox: { x: 10, y: 40, w: 180, h: 100 } },
];
const same = structuralSimilarity(boxesA, 200, 260, boxesA, 200, 260);
assert.equal(same.matched, 2);
assert.ok(same.score > 0.95);
// Same page at a different DPI must still match: comparison is on NORMALISED boxes.
const scaled = boxesA.map((r) => ({ label: r.label,
    bbox: { x: r.bbox.x * 3, y: r.bbox.y * 3, w: r.bbox.w * 3, h: r.bbox.h * 3 } }));
assert.ok(structuralSimilarity(boxesA, 200, 260, scaled, 600, 780).score > 0.95,
    'a rescanned page is not a different page');
const substituted = structuralSimilarity(boxesA, 200, 260, [
    { label: 'heading', bbox: { x: 10, y: 10, w: 180, h: 20 } },
    { label: 'table', bbox: { x: 10, y: 40, w: 180, h: 100 } },
], 200, 260);
assert.ok(substituted.score < 0.6, 'a changed region breaks the structural match');

// ── VLM report: the epistemic rule is enforced structurally ─────────────────

_resetIds();
const detObserved = observed('altered-regions', 'noise floor differs', { noiseFloor: 0.0413 });
const detInferred = inferred('altered-regions', 'looks pasted', [detObserved.id]);
const det = report([detObserved, detInferred], { document: 'x.pdf', pages: 1, analysers: {} });

const prompt = buildPrompt(det, { blur: 1.2 });
assert.match(prompt.system, /Never write a conclusion tiered "observed" that you reasoned to/);
assert.match(prompt.prompt, /PREDICTIONS, not measurements/,
    'Head B values are presented to the model as predictions, never as measurements');

const { report: vlm, violations } = validateReport({
    conclusions: [
        // legitimate: restates an observation it cites, using that finding's own number
        { tier: 'observed', statement: 'The noise floor differs at 0.041.', basis: [detObserved.id] },
        // illegitimate: an "observation" grounded on an inference
        { tier: 'observed', statement: 'The region was pasted.', basis: [detInferred.id] },
        // illegitimate: an observation carrying a number nobody measured
        { tier: 'observed', statement: 'Compression drops to 0.9912 there.', basis: [detObserved.id] },
        // illegitimate: an observation with no basis at all
        { tier: 'observed', statement: 'The document is forged.', basis: [] },
        // illegitimate: an inference citing nothing
        { tier: 'inferred', statement: 'Someone edited this.', basis: [] },
        // legitimate: a guess, labelled as one
        { tier: 'uncertain', statement: 'Possibly a scanner artifact.', basis: [] },
    ],
    summary: 's', recommendedAction: 'r',
}, det);

assert.equal(vlm.conclusions[0].tier, 'observed', 'a faithful restatement survives');
assert.equal(vlm.conclusions[1].tier, 'inferred',
    'an "observation" resting on an inference is DOWNGRADED, not accepted');
assert.equal(vlm.conclusions[2].tier, 'inferred', 'an invented number costs the observed tier');
assert.equal(vlm.conclusions[3].tier, 'uncertain', 'an unfounded observation drops two tiers');
assert.equal(vlm.conclusions[4].tier, 'uncertain', 'an unfounded inference drops one');
assert.equal(vlm.conclusions[5].tier, 'uncertain');
assert.equal(violations.length, 4);
assert.ok(vlm.conclusions.every((c) => TIERS.includes(c.tier)),
    'every conclusion carries exactly one of the three labels');
assert.equal(vlm.integrity.clean, false,
    'the violation record ships WITH the report rather than being logged and forgotten');
assert.equal(vlm.integrity.usable, true,
    'this report has one surviving observed conclusion, so it is usable');

// A model that has lost the thread repeats itself until the budget runs out.
// Observed for real: deepseek-ocr emitted 12 copies of one sentence.
const degenerate = validateReport({
    summary: 'x', recommendedAction: '',
    conclusions: Array.from({ length: 12 }, () => ({
        tier: 'observed',
        statement: 'The document is a scanned document. It is not a born-digital document.',
        basis: ['observed', 'inferred'],       // tier NAMES, not finding ids
    })),
}, det);
assert.equal(degenerate.report.conclusions.length, 1,
    'twelve copies of one guess collapse to one');
assert.ok(degenerate.report.integrity.violations.some((v) => v.kind === 'degenerate-repetition'),
    'and the collapse is recorded rather than tidied away');
assert.ok(degenerate.report.integrity.violations.some((v) => v.kind === 'unknown-basis'),
    'hallucinated basis ids are caught');
assert.equal(degenerate.report.conclusions[0].tier, 'uncertain',
    'a claimed observation citing ids that do not exist is downgraded, not trusted');
assert.equal(degenerate.report.integrity.usable, false,
    'a report where nothing survived as observed or inferred is marked unusable');
assert.ok(vlm.conclusions[1].downgradedFrom === 'observed',
    'a reader is told where the writer overreached');

// ── the facade: unavailable must never render as clean ──────────────────────

const emptyRun = analyseDocument({ name: 'nothing.pdf', pages: [] });
assert.equal(Object.keys(emptyRun.analysers).length, ANALYSERS.length);
assert.ok(Object.values(emptyRun.analysers).every((s) => s === 'could-not-run'));
assert.equal(emptyRun.counts.observed, 0);
assert.ok(emptyRun.findings.every((f) => f.tier === 'uncertain'),
    'a document nothing could be measured on yields NO observations and NO clean bill');

const oneCheck = analyseDocument({
    name: 'x.pdf',
    info: { Producer: 'T', CreationDate: 'D:20240101120000', ModDate: 'D:20240101120000' },
    pages: [],
}, { only: ['metadata'] });
assert.equal(oneCheck.analysers.metadata, 'ran-and-found');
assert.equal(Object.keys(oneCheck.analysers).length, 1, '`only` really does restrict the run');

// ── ocrScale: forensic evidence gates the cap, never raises it ──────────────

assert.equal(blurInS(2.5, 10), 0.25, 'blur is expressed as a multiple of body-text height');
assert.equal(blurInS(2.5, 0), 0, 'and is undefined without an S, not guessed');
assert.equal(blurInS(0, 10), 0);

const sound = capForEvidence(960, 0.40, 10, { blur: 1.0, skew: 0.5, warp: 0.01 });
assert.equal(sound.blocked, false);
assert.equal(sound.cap, capForCoverage(960, 0.40).cap,
    'a starved but physically sound page gets exactly the cap coverage asked for');
assert.match(sound.reason, /resolution is the binding constraint/);

const tooBlurred = capForEvidence(960, 0.40, 10, { blur: 3.0, skew: 0.5, warp: 0.01 });
assert.equal(tooBlurred.blocked, true);
assert.equal(tooBlurred.cap, 960, 'no 4x detection cost buying a result no resolution recovers');
assert.equal(tooBlurred.starved, true, 'but the page is still REPORTED starved, not called fine');
assert.match(tooBlurred.reason, /point spread/);

const tooSkewed = capForEvidence(960, 0.40, 10, { blur: 0.1, skew: 7, warp: 0 });
assert.equal(tooSkewed.blocked, true);
assert.match(tooSkewed.reason, /skewed/);

const healthy = capForEvidence(960, 0.90, 10, { blur: 3.0, skew: 9, warp: 0.2 });
assert.equal(healthy.starved, false);
assert.equal(healthy.blocked, false,
    'forensic signals never block a page that coverage never flagged — they can only decline a request');

const legacy = capForEvidence(960, 0.40, 10, null);
assert.deepEqual(
    { cap: legacy.cap, starved: legacy.starved },
    { cap: capForCoverage(960, 0.40).cap, starved: true },
    'with no forensic head the behaviour is byte-for-byte the incumbent path');
assert.equal(legacy.blocked, false);

// Scale-freedom: the same physical page at 2x DPI must reach the same verdict.
const at1x = capForEvidence(960, 0.40, 10, { blur: 3.0, skew: 0, warp: 0 });
const at2x = capForEvidence(960, 0.40, 20, { blur: 6.0, skew: 0, warp: 0 });
assert.equal(at1x.blocked, at2x.blocked,
    'the doctrine holds: the decision is a dimensionless ratio, not a pixel count');

// ── the model flag defaults to DocForensics ─────────────────────────────────

assert.equal(DEFAULT_MODEL_ID, 'docforensics-layout-s',
    'normal extraction runs DocForensics without a YOLO fallback');
assert.equal(requestedModelId('', { getItem: () => null }), 'docforensics-layout-s');
assert.equal(requestedModelId('?layout=docforensics-layout-s', { getItem: () => null }),
    'docforensics-layout-s', 'URL param selects the student');
assert.equal(requestedModelId('', { getItem: () => 'docforensics-layout-s' }), 'docforensics-layout-s');
assert.equal(requestedModelId('?layout=docforensics-layout-s', { getItem: () => 'yolov8n-doclaynet' }),
    'docforensics-layout-s', 'URL beats localStorage, as in ocr/index.js');
assert.equal(requestedModelId('?layout=nonsense', { getItem: () => null }), 'docforensics-layout-s',
    'an unknown id falls back rather than throwing at worker start');

// The YOLOv8n-DocLayNet incumbent is retired: AGPL-encumbered weights, and the
// A/B that justified replacing it is finished. Its manifest, model file and
// bench harnesses moved to the pdf-training repo. Asserting it is GONE is the
// point — a stray re-registration would put the copyleft artifact back on the
// shipping path.
assert.equal(Object.keys(MODELS).length, 1, 'DocForensics is the only shipped detector');
assert.throws(() => manifestFor('yolov8n-doclaynet'), /unknown layout model/,
    'the AGPL incumbent must not be reachable from the shipped registry');
assert.equal(requestedModelId('?layout=yolov8n-doclaynet', { getItem: () => null }),
    'docforensics-layout-s', 'a stale YOLO flag falls back rather than resurrecting it');

const stu = manifestFor('docforensics-layout-s');
assert.equal(stu.defaultConfidence, 0.18,
    'the student operating point is lower than the retired incumbent\'s 0.25, affordable '
    + 'because ocrScale cross-checks ink coverage');
assert.deepEqual([...stu.forensics.signalOrder], [...SIGNAL_NAMES],
    'the manifest and signals.js must agree, or every forensic reading is mislabelled');
assert.deepEqual([...stu.classes], [...LAYOUT_CLASSES]);
assert.deepEqual([...stu.evidenceInput.order],
    ['is_form', 'is_geometry', 'is_clean', 'reserved'],
    'the conditional model input order is an explicit contract, never positional folklore');

assert.ok(assertSessionMatches(stu, 19, 3));
assert.throws(() => assertSessionMatches(stu, 18, 3), /Refusing to guess the class order/,
    'a channel count that disagrees with the declared class list must REFUSE, not relabel');
assert.throws(() => assertSessionMatches(stu, 19, 1), /outputs?\b/,
    'a model missing its forensic outputs is not the model the manifest describes');


console.log('ok    forensics + layout model flag');
