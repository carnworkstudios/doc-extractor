// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// widgetRouter.js — form structure read from the PDF's AcroForm widgets.
//
// WHY THIS IS NOT A MODEL
// -----------------------
// The layout detector cannot see form fields. `seal/form` is its only form-ish
// class, it is 100% synthetic (pasted stamp/box artifacts during degradation),
// and on a real IRS f1040 it fires zero times: the detector returns 3 regions
// for the whole page and leaves the entire form body — 128 widgets spanning
// y=48..762 — undetected. An empty region set is worse than a wrong label,
// because the OCR path downstream then has nothing to attach its lines to.
//
// But on a born-digital form the answer is already IN THE FILE. Every field
// carries an exact rectangle, a type, and a name. There is nothing to infer and
// therefore nothing to learn: reading them is strictly better than any
// prediction, at zero parameters and zero inference cost.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// ----------------------------------
// Widgets are authoritative ONLY where they exist. Flattened forms (printed to
// PDF), hybrid forms (some fields as widgets, the rest drawn), and scans carry
// visual fields with no widget behind them. So this module NEVER suppresses a
// detector region for lacking a widget — it only ADDS what the file states.
// Reconciliation is the caller's job, and the provenance below is what lets it
// tell the two apart.
//
// Every region is tagged `established` (RFC-style: asserted by the document
// itself), never `inferred`. That distinction is the same one the overlay
// checks in this directory already make, and for the same reason: a claim the
// file makes and a claim we computed must never be presented as equal evidence.

/** Widget fieldType -> our region label + RegionType. */
function classify(a) {
    if (a.fieldType === 'Tx') return { label: 'field', subtype: 'text' };
    if (a.fieldType === 'Ch') return { label: 'field', subtype: 'choice' };
    if (a.fieldType === 'Sig') return { label: 'signature', subtype: null };
    if (a.fieldType === 'Btn') {
        // Explicit booleans from pdf.js rather than fieldFlags bit-twiddling:
        // the flags are position-dependent and a misread bit silently turns a
        // radio group into a pushbutton.
        if (a.checkBox) return { label: 'checkbox', subtype: 'check' };
        if (a.radioButton) return { label: 'checkbox', subtype: 'radio' };
        return null;               // pushbutton: an action, not a data field
    }
    return null;
}

/**
 * Convert a widget's PDF-space rect to viewport space.
 *
 * `rect` is bottom-left origin and the two corners are not guaranteed ordered,
 * so both are converted and then min/max'd. Doing the y-flip by hand
 * (height - y) is the classic way to get this subtly wrong on a rotated page;
 * `convertToViewportPoint` already carries the rotation.
 */
function toViewportBox(rect, viewport) {
    const [ax, ay] = viewport.convertToViewportPoint(rect[0], rect[1]);
    const [bx, by] = viewport.convertToViewportPoint(rect[2], rect[3]);
    const x = Math.min(ax, bx), y = Math.min(ay, by);
    return { x, y, w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

/**
 * Extract form regions from a page's annotations.
 *
 * @param {Array} annotations  from `page.getAnnotations({intent:'display'})`
 * @param {object} viewport    the SAME viewport the layout boxes are in
 * @returns {{hasAcroForm:boolean, regions:Array, fields:number, page:object|null}}
 */
export function widgetRegions(annotations, viewport) {
    const widgets = (annotations || []).filter(a => a.subtype === 'Widget');
    if (!widgets.length) {
        return { hasAcroForm: false, regions: [], fields: 0, page: null };
    }

    const regions = [];
    for (const a of widgets) {
        // A hidden widget is not on the page. Including it would put a region
        // over blank paper and pull unrelated OCR lines into a field.
        if (a.hidden) continue;
        const kind = classify(a);
        if (!kind) continue;
        const bbox = toViewportBox(a.rect, viewport);
        // Degenerate rects exist in the wild (zero-height signature stubs).
        if (!(bbox.w > 0.5 && bbox.h > 0.5)) continue;

        regions.push({
            label: kind.label,
            subtype: kind.subtype,
            bbox,
            confidence: 1.0,          // stated by the file, not estimated
            provenance: 'established',
            source: 'acroform-widget',
            fieldName: a.fieldName || null,
            readOnly: !!a.readOnly,
            required: !!a.required,
        });
    }

    // The form's own extent: the union of its fields, which is what makes
    // `form` a PARENT region rather than a twelfth leaf class. Tables and text
    // inside it stay themselves — containment, not an exclusive choice.
    let page = null;
    if (regions.length) {
        const x0 = Math.min(...regions.map(r => r.bbox.x));
        const y0 = Math.min(...regions.map(r => r.bbox.y));
        const x1 = Math.max(...regions.map(r => r.bbox.x + r.bbox.w));
        const y1 = Math.max(...regions.map(r => r.bbox.y + r.bbox.h));
        page = {
            label: 'form',
            subtype: 'acroform',
            bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
            confidence: 1.0,
            provenance: 'established',
            source: 'acroform-widget',
            childCount: regions.length,
        };
    }

    return { hasAcroForm: true, regions, fields: regions.length, page };
}

/**
 * Merge widget regions with detector regions.
 *
 * Rules, highest evidence first:
 *   1. A widget region is never dropped and never overridden.
 *   2. A DETECTOR region that duplicates a widget (IoU >= `iou`) is dropped —
 *      the file's rectangle is exact and the model's is an estimate of the
 *      same thing, so keeping both would double-claim the area.
 *   3. Everything else the detector found is KEPT, including things that look
 *      like fields but have no widget. Flattened and hybrid forms are real and
 *      suppressing their visual fields would silently delete content.
 */
export function mergeWidgetRegions(detectorRegions, widget, { iou = 0.5 } = {}) {
    if (!widget?.hasAcroForm) return { regions: detectorRegions || [], replaced: 0 };
    const wr = widget.regions;
    const kept = [];
    let replaced = 0;
    for (const d of (detectorRegions || [])) {
        const dup = wr.some(w => boxIoU(w.bbox, d.bbox) >= iou);
        if (dup) { replaced++; continue; }
        kept.push(d);
    }
    const out = [...wr, ...kept];
    if (widget.page) out.unshift(widget.page);
    return { regions: out, replaced };
}

function boxIoU(a, b) {
    if (!a || !b) return 0;
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const iw = x2 - x1, ih = y2 - y1;
    if (iw <= 0 || ih <= 0) return 0;
    const inter = iw * ih;
    return inter / (a.w * a.h + b.w * b.h - inter);
}
