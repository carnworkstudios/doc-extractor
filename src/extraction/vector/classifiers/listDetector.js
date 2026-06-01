// listDetector.js
// List type classification for a single Y-band line.
// Checks for bullet or numbered-list patterns at the start of the line string.

import { RegionType } from './regionTypes.js';

const BULLET_RE = /^[•‣◦▪▫–—―•–—·○◦◉▪▫-]\s/;
const ORDERED_RE = /^(?:\d{1,3}[.)]\s|[a-zA-Z][.)]\s|[ivxIVX]+[.)]\s)/;

export function classifyList(line, bodyFontSizePt, scale) {
    const lineStr = line.items.map(tm => tm.str.trim()).join(' ').trim();
    if (!lineStr) return null;

    if (BULLET_RE.test(lineStr)) return { type: RegionType.LIST, ordered: false };
    if (ORDERED_RE.test(lineStr)) return { type: RegionType.LIST, ordered: true };

    return null;
}

export { BULLET_RE, ORDERED_RE };
