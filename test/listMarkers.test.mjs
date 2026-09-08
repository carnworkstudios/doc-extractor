import assert from 'node:assert/strict';
import { assemblePage, createFontRegistry } from '../src/extraction/vector/pageAssembler.js';
import { classifyList, orderedListMarker } from '../src/extraction/vector/classifiers/listDetector.js';
const viewport = { width: 400, height: 400, transform: [1, 0, 0, -1, 0, 400] };
for (const [markers, type, start] of [
    [['5.', '6.'], '1', 5], [['c)', 'd)'], 'a', 3], [['D.', 'E.'], 'A', 4],
    [['iv.', 'v.'], 'i', 4], [['IX)', 'X)'], 'I', 9], [['xl.', 'xli.'], 'i', 40],
    [['h.', 'i.', 'j.'], 'a', 8], [['i.', 'j.'], 'a', 9], [['i.', 'ii.'], 'i', 1],
]) {
    const items = markers.map((m, i) => ({ str: m + ' Example entry', width: 150,
        fontName: 'Helvetica', transform: [12, 0, 0, 12, 20, 370 - i * 20] }));
    const meta = items.map((t, i) => ({ idx: i, str: t.str, vx: 20, vy: 30 + i * 20,
        vWidth: 150, vFont: 12, fontSize: 12 }));
    assert.equal(classifyList({ items: [meta[0]] }).ordered, true);
    assert.deepEqual(orderedListMarker(items.map(t => t.str)), { type, start });
    const region = { id: 'list', type: 'LIST', bbox: { x: 20, y: 30, w: 150, h: markers.length * 20 },
        yCenter: 50, textItemIndices: items.map((_, i) => i), listOrdered: true, columnIndex: -1 };
    const page = assemblePage([region], meta, items, viewport, 400, 1, createFontRegistry());
    assert.match(page.html, new RegExp(`<ol[^>]*start="${start}" type="${type}"`));
    assert.equal((page.html.match(/<li>/g) || []).length, markers.length);
    assert.doesNotMatch(page.html, /<li>[^<]*[.)] Example/);
}
console.log('ok    ordered list type and start survive assembly for decimal, alphabetic and Roman markers');
