// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// headingDetector.js
// Heading classification for a single Y-band line.
//
// Size alone is not enough. The original rule was `size > body * 1.25`, which
// misses the most common heading in technical and government documents: a short
// BOLD line at or barely above body size. "FOREWORD" set 12pt bold over 11pt
// body is 1.09x — centered, alone on its line, all-caps — and was emitted as a
// paragraph. On an NTRS sample, 217 body lines produced ZERO headings.
//
// So this reads the signals a person uses. Size still wins outright when it is
// decisive; otherwise a line must be SHORT and carry at least two weaker
// signals. Requiring corroboration is what keeps a bold inline phrase or a
// one-line paragraph from being promoted.
//
// Everything here is already on the line: `bold` comes from fontStyleMap, and
// x-extent from vx/vWidth. No new inputs, no model.

import { RegionType } from './regionTypes.js';

/** Longer than this and it reads as prose no matter how it is styled. */
const MAX_HEADING_CHARS = 90;
/** A heading rarely runs the full measure; this is the fraction it stays under. */
const MAX_WIDTH_RATIO = 0.72;
/**
 * Below this ratio a line is genuinely smaller than the body and no amount of
 * styling makes it a heading (captions, footnotes, sidenotes are all bold-ish).
 *
 * NOT 0.98. `bodyFontSizePt` is a MEAN over the band, so a title page whose
 * body mean is pulled up by a larger display font leaves a legitimate 10.9pt
 * bold all-caps title at ratio 0.95 — which rejected "TELEMETRY DATA
 * PROCESSING" while accepting the second line of the same title, splitting one
 * heading in half. 0.9 keeps real footnotes out while letting a same-size
 * heading be promoted on its style signals, which is the whole point of them.
 */
const MIN_SIZE_RATIO = 0.9;

export function classifyHeading(line, bodyFontSizePt, scale, ctx = {}) {
    const items = line.items || [];
    if (!items.length) return null;

    const text = items.map(t => (t.str || '').trim()).join(' ').trim();
    if (!text) return null;

    const size = items.reduce((s, tm) => s + tm.fontSize, 0) / items.length;
    const ratio = bodyFontSizePt > 0 ? size / bodyFontSizePt : 1;

    // Dropcap guard, unchanged: a single glyph is decoration, not a heading.
    if (items.length === 1 && (items[0].str || '').trim().length <= 2) return null;

    // 1. Decisive size — the original rule, kept intact so nothing that used to
    //    be a heading stops being one.
    if (ratio > scale.HEADING_SCALE) return RegionType.HEADING;

    // A heading is short. This is the one hard gate below the size rule: it is
    // what separates "a bold line" from "a bold sentence".
    if (text.length > MAX_HEADING_CHARS) return null;
    if (ratio < MIN_SIZE_RATIO) return null;

    // 2. Corroborating signals. Any two promote; one alone never does.
    let signals = 0;

    // Bold. The strongest cue at body size in principle, but CURRENTLY DEAD on
    // the geometry path: PDF.js resolves fonts during RENDERING, and this
    // pipeline only calls getTextContent(), so `commonObjs` is empty and
    // `textContent.styles` reports a generic family ("serif") rather than
    // "TimesNewRomanPS-BoldMT". Every item therefore arrives with bold:false.
    // `fontExtraProperties: true` is set and is not sufficient on its own.
    // Left in place because it costs nothing and starts working the moment the
    // font objects are available; the other signals carry the decision today.
    const boldChars = items.reduce((n, t) => n + (t.bold ? (t.str || '').length : 0), 0);
    const allChars = items.reduce((n, t) => n + (t.str || '').length, 0);
    if (allChars && boldChars / allChars >= 0.8) signals++;

    // Slightly larger, but under the decisive threshold.
    if (ratio >= 1.05) signals++;

    // ALL CAPS or Title Case, ignoring digits and punctuation.
    const letters = text.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 3) {
        const upper = text.replace(/[^A-Z]/g, '').length;
        if (upper / letters.length >= 0.9) signals++;
    }

    // Narrow: a heading does not fill the text measure. Uses the line's own
    // x-extent against the body width the caller measured; skipped when the
    // caller does not supply one rather than guessing a page width.
    const bodyWidth = ctx.bodyWidthPx ?? scale.bodyWidthPx ?? null;
    if (bodyWidth) {
        const x0 = Math.min(...items.map(t => t.vx));
        const x1 = Math.max(...items.map(t => t.vx + (t.vWidth || 0)));
        if ((x1 - x0) / bodyWidth <= MAX_WIDTH_RATIO) signals++;
    }

    // A trailing sentence period is prose. Checked last so it can veto a line
    // that otherwise looks like a heading ("This is bold. " is not one).
    if (/[.,;:]$/.test(text) && !/^\d/.test(text)) signals--;

    return signals >= 2 ? RegionType.HEADING : null;
}
