// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// listDetector.js
// List type classification for a single Y-band line.
// Checks for bullet or numbered-list patterns at the start of the line string.

import { RegionType } from './regionTypes.js';

const BULLET_RE = /^[•‣◦▪▫–—―•–—·○◦◉▪▫-]\s/;
const ORDERED_RE = /^(?:\d{1,3}[.)]\s|[a-zA-Z][.)]\s|[ivxlcdmIVXLCDM]+[.)]\s)/;

export function classifyList(line, bodyFontSizePt, scale) {
    const lineStr = line.items.map(tm => tm.str.trim()).join(' ').trim();
    if (!lineStr) return null;

    if (BULLET_RE.test(lineStr)) return { type: RegionType.LIST, ordered: false };
    if (ORDERED_RE.test(lineStr)) return { type: RegionType.LIST, ordered: true };

    return null;
}

export { BULLET_RE, ORDERED_RE };

// Resolve ambiguous single letters from the sequence when possible (h, i, j
// is alphabetic; i, ii, iii is Roman). An isolated i/v/x defaults to Roman.
export function orderedListMarker(markers) {
    const tokens = markers.map(s => /^(\d{1,3}|[a-zA-Z]+)[.)](?!\d)/.exec(s.trim())?.[1]).filter(Boolean);
    if (!tokens.length) return { type: '1', start: 1 };
    const first = tokens[0];
    if (/^\d+$/.test(first)) return { type: '1', start: Number(first) };
    const romanValue = token => {
        if (!/^(?=[MDCLXVI]+$)M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i.test(token)) return null;
        const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
        const letters = token.toUpperCase().split('');
        return letters.reduce((n, c, i) => n + (values[c] < (values[letters[i + 1]] || 0) ? -values[c] : values[c]), 0);
    };
    const alphabeticSequence = tokens.length > 1 && tokens.every((t, i) =>
        /^[a-z]$/i.test(t) && (!i || t.charCodeAt(0) === tokens[i - 1].charCodeAt(0) + 1));
    const roman = !alphabeticSequence && tokens.every(t => romanValue(t) !== null) &&
        (tokens.some(t => t.length > 1) || /^[ivx]$/i.test(first));
    const upper = first === first.toUpperCase();
    return { type: roman ? (upper ? 'I' : 'i') : (upper ? 'A' : 'a'),
        start: roman ? romanValue(first) : first.toLowerCase().charCodeAt(0) - 96 };
}
