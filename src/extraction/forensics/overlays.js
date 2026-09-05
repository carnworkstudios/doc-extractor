// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// overlays.js — suspicious paint over live text: white-box "redaction",
// occluding XObjects, and z-order anomalies.
//
// THE FAILURE THIS EXISTS TO CATCH
// --------------------------------
// The single most common real-world PDF disclosure accident is a filled
// rectangle painted over text that is still in the content stream. It looks
// redacted. It copies and pastes perfectly. Every text-extraction tool in
// existence, including this one's own vector path, reads straight through it.
//
// That is not a hypothetical about other people's documents: `pageAssembler`
// and `textRebuilder` will happily reconstruct the covered text into the output
// HTML, because nothing in the vector path has ever asked whether a glyph is
// visible. This module is the thing that asks.
//
// WHY IT REUSES ctmAdapter'S DISPLAY LIST AND DOES NOT PARSE ANYTHING
// -------------------------------------------------------------------
// `extractSubpaths()` already returns `filledRects`, `textPaintOps` and a
// unified `displayList` with `operatorIndex` on every record. That
// operatorIndex is exactly the z-order: PDF content streams paint in order, so
// a fill whose operatorIndex is GREATER than a text paint's is painted over it.
//
// Writing a second path extractor to answer that question would mean
// re-deriving the CTM stack, and a z-order test built on a second, subtly
// different notion of paint order is worse than no test — it would disagree
// with the renderer the user is actually looking at.
//
// So: no parsing here. Two arrays and an integer comparison.

import { observed, inferred, uncertain } from './findings.js';

const CHECK = 'suspicious-overlays';

// A fill must cover at least this share of a text run's box to be treated as
// obscuring it. Below it, the "overlay" is a highlight, an underline, a table
// cell shade or a rule that clips the descenders — all of which are ordinary
// typography and none of which hide anything.
const COVER_FRACTION = 0.80;

// Luminance at or above which a fill counts as "paper coloured". A redaction
// box is normally white or near-white precisely so it does not look like a
// redaction. Black boxes are also caught (see BLACK_MAX) — those are the honest
// kind, and they are equally a disclosure problem when the text survives.
const WHITE_MIN = 0.90;
const BLACK_MAX = 0.12;

function lum(rgb) {
    if (!rgb || rgb.length < 3) return 1;
    // ctmAdapter carries colour in 0..255 device components.
    const [r, g, b] = rgb;
    const s = (r > 1 || g > 1 || b > 1) ? 255 : 1;
    return (0.299 * r + 0.587 * g + 0.114 * b) / s;
}

/**
 * Axis-aligned viewport bbox of a text paint op.
 *
 * ctmAdapter gives every TEXT_PAINT a `viewportMatrix` = vp * ctm * Tm and the
 * glyph run's text and font size. The run's advance is not stored, so its width
 * is estimated from the glyph count — which is fine here because the test is a
 * COVERAGE FRACTION and an estimate that is 15% wide makes the test slightly
 * conservative (fewer reports), not wrong in the dangerous direction.
 */
function textBox(op) {
    const m = op.viewportMatrix;
    if (!m) return null;
    const n = (op.text || '').length;
    if (!n) return null;

    // `viewportMatrix` is vp * ctm * Tm. It does NOT contain the font size:
    // PDF carries the size as a separate parameter of `Tf`, and ctmAdapter
    // stores it separately as `op.fontSize`. A real pdf-lib page at viewport
    // scale 1.6 gives vm = [1.6, 0, 0, -1.6, x, y] with fontSize 11 — so the
    // matrix scale alone is 1.6 px, not an 11 pt em.
    //
    // Both of the obvious readings are wrong and both fail SILENTLY:
    //   * matrix scale alone  -> every run ~7x too small, nothing is ever
    //                            covered, the check reports nothing.
    //   * fontSize x both basis lengths -> every run ~10x too wide, coverage
    //                            never reaches threshold, same silence.
    // The em in viewport pixels is fontSize scaled by the matrix, once.
    const fs = op.fontSize || 10;
    const sy = Math.hypot(m[2], m[3]) || 1;
    const sx = Math.hypot(m[0], m[1]) || sy;
    const size = fs * sy;
    // 0.5 em per glyph is the usual mean advance for proportional Latin text.
    const w = n * 0.5 * fs * sx * ((op.horizontalScale || 100) / 100);
    const x = m[4], y = m[5];
    // Viewport y is flipped relative to the text baseline, so the run occupies
    // [y - ascent, y + descent]; 0.8/0.2 of the em is the standard split.
    return { x, y: y - size * 0.8, w: Math.max(w, size * 0.5), h: size };
}

/**
 * Every FILLED shape on the page, as a viewport bbox with a paint order.
 *
 * `filledRects` alone is not enough, and the gap is exactly the one a forensics
 * tool cannot have. ctmAdapter populates `filledRects` only from the `re`
 * operator; a rectangle drawn as four `l` segments and closed is visually
 * IDENTICAL and produces no entry at all. pdf-lib emits its rectangles that
 * way, so a white box drawn by the most common JS PDF library evaded this check
 * completely — verified against a real generated file, not reasoned about.
 *
 * So filled shapes are recovered from the subpaths, which ctmAdapter marks
 * `filled` at paint time and which carry their own `ctm`. Their segments are in
 * PDF space, so they are pushed through ctm and then the viewport transform —
 * the same two matrices ctmAdapter's own `toViewport` applies.
 *
 * The bbox of a non-rectangular filled shape over-claims. That is the safe
 * direction: the coverage test asks what fraction of a TEXT run is inside the
 * shape, and an over-large shape makes the check slightly more willing to
 * report. A missed shape makes it silent, which is what just happened.
 */
function filledShapes(extracted, viewport) {
    const out = [];
    for (const fr of extracted.filledRects || []) {
        const rect = rectOf(fr);
        if (rect) out.push({ rect, operatorIndex: fr.operatorIndex, fillColor: fr.fillColor,
                             source: 're' });
    }
    const vt = viewport && viewport.transform;
    if (!vt || !extracted.subpaths || !extracted.displayList) return out;

    // subpathId -> the paint that filled it, for z-order and colour.
    const paints = new Map();
    for (const d of extracted.displayList) {
        if (d.kind === 'PATH_PAINT' && d.fillColor && typeof d.subpathId === 'number') {
            if (!paints.has(d.subpathId)) paints.set(d.subpathId, d);
        }
    }

    for (const sp of extracted.subpaths) {
        if (!sp.filled || !sp.segs || !sp.segs.length) continue;
        // ONLY a solid axis-aligned quad. This restriction is the difference
        // between a working check and an unusable one.
        //
        // Taking the bbox of any filled subpath looked right and was badly
        // wrong on real documents: a table's rules are frequently constructed
        // as ONE path containing every horizontal and vertical line, and its
        // bounding box is the whole table. That box "covers" every text run
        // inside the table, so `sample-tables.pdf` produced 84 confident
        // "failed redaction" findings, all of them table borders.
        //
        // A redaction box is a solid quad. A grid, a frame, a rule and a glyph
        // outline are not, and none of them can hide anything by being filled.
        const quad = axisAlignedQuad(sp, ctmOf(sp), vt);
        if (!quad) continue;
        const paint = paints.get(sp.id);
        out.push({
            rect: quad,
            operatorIndex: paint ? paint.operatorIndex : undefined,
            fillColor: (paint && paint.fillColor) || sp.fillColor,
            source: 'subpath',
        });
    }

    // De-duplicate: a rect drawn with `re` appears in BOTH lists, and reporting
    // it twice would double every finding on an ordinary form.
    const seen = new Set();
    return out.filter((f) => {
        const k = [f.rect.x, f.rect.y, f.rect.w, f.rect.h].map((v) => Math.round(v)).join(',');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

function rectOf(fr) {
    // reconcile() normalises filledRects to {x, y, w, h} in viewport space.
    if (fr.bbox) return fr.bbox;
    if (typeof fr.x === 'number') return fr;
    return null;
}

function coverage(inner, outer) {
    const x1 = Math.max(inner.x, outer.x), y1 = Math.max(inner.y, outer.y);
    const x2 = Math.min(inner.x + inner.w, outer.x + outer.w);
    const y2 = Math.min(inner.y + inner.h, outer.y + outer.h);
    const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const a = inner.w * inner.h;
    return a > 0 ? i / a : 0;
}

/**
 * @param {object} extracted  the object `extractSubpaths()` returned
 * @param {Array}  extracted.filledRects   from reconcile(), viewport coords
 * @param {Array}  extracted.textPaintOps
 * @param {Array}  extracted.displayList
 * @param {Array}  [extracted.imageMeta]
 * @param {number} pageNo
 * @param {object} [opts]
 * @param {{w:number,h:number}} [opts.pageBox]  viewport size. When omitted it is
 *        derived from the content extent — see `fullBleedDenominator`.
 * @param {{transform:number[]}} [opts.viewport]  needed to recover filled shapes
 *        that were NOT drawn with the `re` operator. Without it this check sees
 *        only `re` rectangles and will miss a polygon redaction.
 */
export function analyseOverlays(extracted, pageNo = 1, opts = {}) {
    const pageBox = opts.pageBox || null;
    const out = [];
    const fills = filledShapes(extracted, opts.viewport)
        .map((f) => ({ raw: f, rect: f.rect }))
        .filter((f) => f.rect && f.rect.w > 2 && f.rect.h > 2);
    const texts = (extracted.textPaintOps || [])
        .map((op) => ({ op, box: textBox(op) }))
        .filter((t) => t.box && (t.op.text || '').trim().length);

    out.push(observed(CHECK, 'display list inspected for paint over text',
        { filledShapes: fills.length,
          fromRectOperator: fills.filter((f) => f.raw.source === 're').length,
          fromFilledSubpath: fills.filter((f) => f.raw.source === 'subpath').length,
          textPaintOps: texts.length,
          images: (extracted.imageMeta || []).length,
          // Without a viewport the polygon path is unavailable, and a report
          // that did not say so would look like a check that found nothing.
          subpathRecoveryAvailable: !!(opts.viewport && opts.viewport.transform) }));
    const baseId = out[0].id;

    // NOT an early return. Only the z-order test below needs `fills`; the
    // invisible-text check at the bottom of this function needs neither, and an
    // early return here meant a page with no filled rectangles was never
    // examined for hidden text at all — a whole check silently skipped on the
    // most common page shape there is.
    if (fills.length && texts.length) {

    // ── z-order test ────────────────────────────────────────────────────────
    // operatorIndex IS paint order. A fill with a higher index than a text run
    // it covers was painted after it, i.e. over it.
    const groups = new Map();      // fill -> covered text ops
    for (const f of fills) {
        const fi = f.raw.operatorIndex;
        for (const t of texts) {
            if (typeof fi === 'number' && typeof t.op.operatorIndex === 'number'
                && fi < t.op.operatorIndex) {
                // Painted BEFORE the text. This is a background — a table cell
                // shade, a highlight, a header band. Not an overlay.
                continue;
            }
            if (coverage(t.box, f.rect) < COVER_FRACTION) continue;
            if (!groups.has(f)) groups.set(f, []);
            groups.get(f).push(t);
        }
    }

    for (const [f, covered] of groups) {
        const L = lum(f.raw.fillColor || f.raw.color);
        const chars = covered.reduce((s, t) => s + (t.op.text || '').trim().length, 0);
        if (chars < 3) continue;

        const region = { page: pageNo, ...f.rect };
        const m = observed(CHECK,
            `a filled rectangle is painted over ${covered.length} text run(s) `
            + `totalling ${chars} characters`,
            { fillLuminance: +L.toFixed(3),
              operatorIndex: f.raw.operatorIndex ?? null,
              paintOrderKnown: typeof f.raw.operatorIndex === 'number',
              shapeSource: f.raw.source,
              coveredRuns: covered.length, coveredChars: chars,
              rect: [Math.round(f.rect.x), Math.round(f.rect.y),
                     Math.round(f.rect.w), Math.round(f.rect.h)],
              // The text itself is NOT recorded. provenance.js's rule — bytes
              // are never in the record — applies with double force to text
              // somebody tried to hide. A length and a location are enough to
              // act on; the content would turn the forensic log into the
              // disclosure it is reporting.
              sampleWithheld: true },
            { region, severity: 0.6 });
        out.push(m);

        // Z-ORDER MUST BE KNOWN before this is called an overlay.
        //
        // `operatorIndex` is recovered from the display list's PATH_PAINT
        // record, and ctmAdapter attaches that record to `currentSubpath` only —
        // so in a COMPOUND path (a table's rules, a glyph outline, a multi-part
        // shape) every subpath but the last has no paint record and no known
        // paint order.
        //
        // Treating unknown as "painted after" is what produced 116 confident
        // "failed redaction" findings on sample-tables.pdf, all of them table
        // cell shading painted BEFORE its text. The shape genuinely covers the
        // text; what is unknown is which was drawn first, and that is the entire
        // question. So an unknown order yields an `uncertain` finding that says
        // so, and never an `inferred` accusation.
        const zKnown = typeof f.raw.operatorIndex === 'number';
        const dark = L >= WHITE_MIN || L <= BLACK_MAX;

        if (dark && zKnown) {
            // The claim is CONCEALMENT, not intent.
            //
            // "This is a failed redaction" was the first wording and it is one
            // step too far: a solid black box painted over a label inside a
            // figure produces exactly this evidence, and it is a diagram, not a
            // cover-up. What is actually established is that the text is
            // invisible on the rendered page and still extractable from the
            // file — which is the fact a reader needs either way, and which is
            // true whatever the author meant.
            //
            // Redaction is named as the case that MATTERS, not asserted as the
            // case that occurred.
            out.push(inferred(CHECK,
                `${chars} characters are painted on this page and then covered by an `
                + `opaque ${L >= WHITE_MIN ? 'white' : 'black'} rectangle. They do not `
                + 'render, and they remain in the content stream where any text extractor '
                + 'will read them. If this was intended as a redaction, it did not redact '
                + 'anything.',
                [baseId, m.id],
                { region, severity: 0.95 }));
        } else if (dark) {
            out.push(uncertain(CHECK,
                `a ${L >= WHITE_MIN ? 'white' : 'black'} filled shape occupies the same `
                + `area as ${chars} characters, but its paint order could not be `
                + 'established (it belongs to a compound path), so whether it is painted '
                + 'over the text or behind it as a background is unknown',
                { region, severity: 0.3 }));
        } else {
            out.push(uncertain(CHECK,
                'a mid-tone fill covers text; this may be a design element rather than '
                + 'an attempt to conceal',
                { region, severity: 0.25 }));
        }
    }

    // ── occluding image XObjects ────────────────────────────────────────────
    // Same logic, different paint op. An image pasted over a text run hides it
    // just as effectively and is harder to spot by eye because it looks like
    // content.
    const imgPaints = (extracted.displayList || [])
        .filter((d) => d.kind === 'IMAGE_PAINT' && typeof d.operatorIndex === 'number');
    const byId = new Map((extracted.imageMeta || []).map((im) => [im.id, im]));
    for (const ip of imgPaints) {
        const im = byId.get(ip.imageId);
        if (!im || !im.bbox) continue;
        const covered = texts.filter(
            (t) => t.op.operatorIndex < ip.operatorIndex
                && coverage(t.box, im.bbox) >= COVER_FRACTION);
        const chars = covered.reduce((s, t) => s + (t.op.text || '').trim().length, 0);
        if (chars < 20) continue;      // a logo over a stray glyph is not news
        const region = { page: pageNo, ...im.bbox };
        const m = observed(CHECK,
            `an image XObject is painted over ${chars} characters of text`,
            { imageId: ip.imageId, operatorIndex: ip.operatorIndex,
              coveredRuns: covered.length, coveredChars: chars },
            { region, severity: 0.5 });
        out.push(m);
        out.push(inferred(CHECK,
            'text is present in the content stream beneath an image and will be '
            + 'extracted even though it is not visible on the rendered page',
            [baseId, m.id], { region, severity: 0.7 }));
    }

    }   // end of the fills-and-texts guard

    // ── invisible text ──────────────────────────────────────────────────────
    // Rendering mode 3 with no full-page image beneath it. On a scan this is an
    // OCR layer and entirely normal; on a born-digital page it is text that
    // someone chose to make unreadable while leaving it extractable.
    const invisible = texts.filter(
        (t) => (t.op.textRenderingMode === 3 || t.op.textRenderingMode === 7)
            && (t.op.text || '').trim().length);
    if (invisible.length) {
        const chars = invisible.reduce((s, t) => s + t.op.text.trim().length, 0);
        // "Full bleed" as a FRACTION of the page, never as a pixel area. A
        // hardcoded 0.6 megapixel threshold means one thing on a 150 dpi render
        // and something else on a 600 dpi one, and would classify the same
        // physical page differently depending on how it was rasterised — the
        // exact failure ocrScale.js's natural-unit doctrine exists to prevent.
        //
        // When the caller does not supply a page box, the content extent is the
        // best available estimate of it, and it is a conservative one: it can
        // only be SMALLER than the page, which makes an image look more
        // full-bleed rather than less, so the test errs toward "this is an
        // ordinary OCR layer" and away from raising an alarm.
        const pageArea = fullBleedDenominator(extracted, pageBox);
        const hasFullBleedImage = (extracted.imageMeta || []).some(
            (im) => im.bbox && pageArea > 0 && (im.bbox.w * im.bbox.h) > 0.6 * pageArea);
        const m = observed(CHECK, 'text painted in an invisible rendering mode',
            { runs: invisible.length, chars,
              modes: [...new Set(invisible.map((t) => t.op.textRenderingMode))] },
            { severity: 0.3 });
        out.push(m);
        if (!hasFullBleedImage) {
            out.push(inferred(CHECK,
                `${chars} characters are painted invisibly on a page with no underlying `
                + 'scan image, so they are not an OCR layer',
                [m.id], { severity: 0.55 }));
        } else {
            out.push(observed(CHECK,
                'invisible text sits over a full-page image — consistent with an ordinary '
                + 'OCR text layer',
                { chars, fullBleedImage: true }, { severity: 0 }));
        }
    }

    return out;
}


const ctmOf = (sp) => sp.ctm || [1, 0, 0, 1, 0, 0];

/**
 * The viewport rect of a filled subpath, but ONLY if the subpath really is a
 * solid axis-aligned rectangle.
 *
 * Returns null for anything else — a frame, a grid, a diagonal, a curve, a
 * hairline rule. Those cannot conceal text no matter what colour they are, and
 * admitting them is what turned this check into a table-border detector.
 *
 * "Axis aligned" is tested AFTER transformation, so a rectangle on a rotated
 * page is correctly rejected (it is no longer axis-aligned on screen, and the
 * bbox would over-claim badly).
 */
function axisAlignedQuad(sp, ctm, vt) {
    if (sp.curves && sp.curves.length) return null;
    const segs = sp.segs;
    // 4 for an explicit close, 5 when the writer repeats the first point.
    if (segs.length < 3 || segs.length > 5) return null;

    const pts = [];
    for (const g of segs) {
        for (const [px, py] of [[g.ax, g.ay], [g.bx, g.by]]) {
            const cx = ctm[0] * px + ctm[2] * py + ctm[4];
            const cy = ctm[1] * px + ctm[3] * py + ctm[5];
            pts.push([vt[0] * cx + vt[2] * cy + vt[4], vt[1] * cx + vt[3] * cy + vt[5]]);
        }
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const w = x1 - x0, h = y1 - y0;
    // A shape thinner than a couple of pixels on either axis is a rule.
    if (!(w > 3 && h > 3)) return null;

    // Every segment must run along one of the four edges of the hull. Tolerance
    // is a fraction of the shape's own size rather than a pixel constant, so
    // the test behaves identically at any render scale.
    const tol = Math.max(0.02 * Math.min(w, h), 0.5);
    for (const g of segs) {
        const a = xf(g.ax, g.ay, ctm, vt), b = xf(g.bx, g.by, ctm, vt);
        const horizontal = Math.abs(a[1] - b[1]) <= tol;
        const vertical = Math.abs(a[0] - b[0]) <= tol;
        if (!horizontal && !vertical) return null;
        if (horizontal && !(near(a[1], y0, tol) || near(a[1], y1, tol))) return null;
        if (vertical && !(near(a[0], x0, tol) || near(a[0], x1, tol))) return null;
    }
    return { x: x0, y: y0, w, h };
}

function xf(px, py, ctm, vt) {
    const cx = ctm[0] * px + ctm[2] * py + ctm[4];
    const cy = ctm[1] * px + ctm[3] * py + ctm[5];
    return [vt[0] * cx + vt[2] * cy + vt[4], vt[1] * cx + vt[3] * cy + vt[5]];
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/**
 * Page area to measure "full bleed" against.
 *
 * Prefers the caller's page box. Failing that, takes the bounding box of every
 * painted thing on the page — images, fills and text runs together. Using only
 * the images would make a page whose sole content IS one image trivially
 * full-bleed by construction.
 */
function fullBleedDenominator(extracted, pageBox) {
    if (pageBox && pageBox.w > 0 && pageBox.h > 0) return pageBox.w * pageBox.h;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const eat = (b) => {
        if (!b) return;
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    };
    for (const im of extracted.imageMeta || []) eat(im.bbox);
    for (const fr of extracted.filledRects || []) eat(rectOf(fr));
    for (const op of extracted.textPaintOps || []) eat(textBox(op));
    if (!Number.isFinite(x0)) return 0;
    return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

export const _internals = { textBox, coverage, lum, fullBleedDenominator,
                            filledShapes, axisAlignedQuad, COVER_FRACTION };
