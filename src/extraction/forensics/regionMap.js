// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// regionMap.js — the contract between the layout detector's classes and the
// RegionType vocabulary that classifiers/, pageAssembler and tableBuilder speak.
//
// WHY THIS FILE EXISTS AT ALL
// ---------------------------
// The detector and the assembler were trained/written against two different
// vocabularies, and until now the seam between them was a string comparison
// scattered across call sites — `r.label === 'table'` in one file, a
// TABLE_LABELS set in another. That is how the class-permutation bug in
// layoutWorker.js survived: nothing named the mapping in one place, so nothing
// could be wrong in one place either.
//
// Everything that crosses the seam goes through here.
//
// THE DETECTOR'S 11 CLASSES are NOT stock DocLayNet. DocLayNet ships
// {Caption, Footnote, Formula, List-item, Page-footer, Page-header, Picture,
//  Section-header, Table, Text, Title}. This project collapses Section-header
// and Title into one `heading` — they are the same thing to `pageAssembler`,
// which picks <h3>/<h4> from measured font size, not from the detector's guess
// — and spends the freed slot on `seal/form`, which has no DocLayNet analogue
// and is the class the forensics work actually needs.

/** Head A class names, in the model's own index order. Index IS the class id. */
export const LAYOUT_CLASSES = [
    'text',      // 0
    'heading',   // 1  <- DocLayNet Section-header + Title, merged
    'list',      // 2  <- DocLayNet List-item
    'table',     // 3
    'picture',   // 4
    'caption',   // 5
    'formula',   // 6
    'header',    // 7  <- DocLayNet Page-header
    'footer',    // 8  <- DocLayNet Page-footer
    'footnote',  // 9
    'seal',      // 10 <- stamps/emblems only. Synthesised; no public labels.
    'form',      // 11 <- PARENT region. Real labels from AcroForm widgets.
    'field',     // 12 <- child of form
    'checkbox',  // 13 <- child of form
    'signature', // 14 <- child of form
];

/**
 * Head A class -> RegionType.
 *
 * WHERE THIS IS LOSSY, AND WHY THAT IS THE RIGHT CALL
 * ---------------------------------------------------
 * `table` -> TABLE, not LATTICE_TABLE or STREAM_TABLE. The detector cannot see
 * the difference and should not try: whether a table has ruled borders is a
 * fact about its path segments, and latticeReconstructor/streamDetector already
 * decide it from the segments themselves with far better evidence than a 640 px
 * bitmap carries. Making the detector guess would put a low-confidence guess
 * upstream of a high-confidence measurement — the wrong way round. TABLE is the
 * "a table is here, you work out which kind" signal, which is exactly what the
 * downstream pass wants.
 *
 * `formula` -> MATH, but note MATH is normally a PROMOTION: the assembler
 * promotes a PARAGRAPH to MATH when its glyphs reconstruct to LaTeX. On the
 * scanned path there are no glyphs to reconstruct, so the detector's `formula`
 * is the only evidence available. It therefore arrives as `suggested` (see
 * `confidenceTier` below) and carries the same data-math-suggested treatment
 * pageAssembler already applies — an unconfirmed reconstruction, not a claim.
 *
 * `seal/form` -> BOX. Considered and rejected: a new RegionType. BOX already
 * means "a bounded region whose interior is not flowing prose", which is what a
 * rubber stamp, an official seal, a signature block and a ruled form-field
 * region all are, and every consumer of RegionType already has a BOX branch. A
 * twelfth type would need a branch added in pageAssembler, contextClassifier,
 * flowLinker and layoutTreeBuilder to avoid falling through to a default —
 * four places to get wrong for a distinction the HTML output does not make.
 * The forensic meaning is not lost: it is carried in `subtype`, below, which is
 * what the forensics module and the VLM report read.
 *
 * `text` -> PARAGRAPH. REFERENCE is deliberately unreachable from here: a
 * bibliography is prose to every geometric test there is, and referenceDetector
 * promotes it from the TEXT of the region. A detector that guessed REFERENCE
 * from pixels would be overriding a text-based decision with an image-based one.
 */
const TO_REGION_TYPE = {
    'text':      { type: 'PARAGRAPH', subtype: null },
    'heading':   { type: 'HEADING',   subtype: null },
    'list':      { type: 'LIST',      subtype: null },
    'table':     { type: 'TABLE',     subtype: null },
    'picture':   { type: 'IMAGE',     subtype: null },
    'caption':   { type: 'PARAGRAPH', subtype: 'caption' },
    'formula':   { type: 'MATH',      subtype: null },
    'header':    { type: 'HEADER',    subtype: null },
    'footer':    { type: 'FOOTER',    subtype: null },
    'footnote':  { type: 'PARAGRAPH', subtype: 'footnote' },
    'seal':      { type: 'BOX',       subtype: 'seal' },

    // ── Form taxonomy ───────────────────────────────────────────────
    // These ARE Head A classes now (ids 11-14). Two sources produce them and
    // they must agree: `widgetRouter.js` reads them from AcroForm geometry on a
    // born-digital page, and the detector predicts them on a SCANNED form where
    // no widgets exist. Same labels, same RegionTypes, different evidence —
    // which is what `provenance` on each region distinguishes.
    //
    // `field` gets its own RegionType rather than BOX. The argument that kept
    // `seal/form` as BOX — that a twelfth type needs a branch in four consumers
    // — holds for a stamp, which has no interior structure. It does not hold
    // for a form field, which has a LABEL and a VALUE: that key-value pair is
    // the entire point of extracting a form, and BOX cannot express it.
    'form':      { type: 'FORM',       subtype: 'acroform' },
    'field':     { type: 'FORM_FIELD', subtype: null },
    'checkbox':  { type: 'FORM_FIELD', subtype: 'checkbox' },
    'signature': { type: 'FORM_FIELD', subtype: 'signature' },
};

/**
 * The reverse map, used by the corpus auto-labeler: the repo's own vector
 * pipeline emits RegionType, and training needs a Head A class id.
 *
 * Not a mechanical inversion of TO_REGION_TYPE. LATTICE_TABLE and STREAM_TABLE
 * both collapse onto `table` (the forward map cannot express that), and three
 * RegionTypes have NO detector class:
 *
 *   DIVIDER   — a horizontal rule. A 1200x3 px box is below the smallest
 *               anchor the detector can regress and would only ever be noise in
 *               the loss. Dividers are recovered from path segments downstream.
 *   REFERENCE — see above: a text-derived promotion, not a visual class.
 *   BOX       — genuinely ambiguous. A BOX from the vector path is any framed
 *               region; a BOX from the detector means specifically seal/form.
 *               Mapping vector BOX -> seal/form would poison the one class that
 *               has no real labels with a pile of callout panels and sidebars.
 *               Vector BOXes are dropped from training instead.
 */
const FROM_REGION_TYPE = {
    PARAGRAPH: 'text',
    HEADING: 'heading',
    LIST: 'list',
    TABLE: 'table',
    LATTICE_TABLE: 'table',
    STREAM_TABLE: 'table',
    IMAGE: 'picture',
    MATH: 'formula',
    HEADER: 'header',
    FOOTER: 'footer',
    // Deliberately absent: DIVIDER, REFERENCE, BOX. See the note above.
};

/** @returns {{type:string, subtype:string|null}|null} */
export function headAToRegionType(label) {
    return TO_REGION_TYPE[label] || null;
}

/** @returns {number} Head A class index, or -1 when the type has no class. */
export function regionTypeToHeadA(type) {
    const name = FROM_REGION_TYPE[type];
    return name === undefined ? -1 : LAYOUT_CLASSES.indexOf(name);
}

/**
 * Observed / inferred / uncertain — the same three-way epistemic split
 * pageAssembler already uses for display math (`data-math-suggested` vs a
 * confirmed reconstruction), applied to detector output and reused verbatim by
 * the forensic report schema so one vocabulary covers both.
 *
 * The tier is NOT a relabelling of the confidence number. It answers a
 * different question: what KIND of claim is this?
 *
 *   observed  — a direct measurement. Never produced here; the detector never
 *               observes, it predicts. Reserved for the deterministic module.
 *   inferred  — a prediction the pipeline will act on.
 *   uncertain — a prediction recorded but not acted on without corroboration.
 *
 * The threshold is expressed against the run's own confidence distribution
 * rather than as a fixed number, for the reason ocrScale.js gives about px
 * magic constants: a fixed 0.5 means one thing at the incumbent's operating
 * point and something else at the lower threshold this model is run at.
 *
 * @param {number} confidence      this region's score
 * @param {number} medianConfidence median over the page's detections
 */
export function confidenceTier(confidence, medianConfidence) {
    if (!(medianConfidence > 0)) return 'uncertain';
    // Half the page's own median is the floor: a detection carrying less than
    // half the evidence of a typical detection on THIS page is not something to
    // act on, whatever its absolute value happens to be.
    if (confidence >= medianConfidence) return 'inferred';
    if (confidence >= 0.5 * medianConfidence) return 'inferred';
    return 'uncertain';
}
