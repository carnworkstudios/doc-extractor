// headingDetector.js
// Heading type classification for a single Y-band line.
// A line is a heading when its font size exceeds body average * HEADING_SCALE.
// Includes dropcap guard: single-character items are never headings.

import { RegionType } from './regionTypes.js';

export function classifyHeading(line, bodyFontSizePt, scale) {
    const lineFontSize = line.items.reduce((s, tm) => s + tm.fontSize, 0) / line.items.length;

    if (lineFontSize > bodyFontSizePt * scale.HEADING_SCALE) {
        // Dropcap guard: single char items are not headings
        if (line.items.length === 1 && line.items[0].str.trim().length <= 2) {
            return null;
        }
        return RegionType.HEADING;
    }
    return null;
}
