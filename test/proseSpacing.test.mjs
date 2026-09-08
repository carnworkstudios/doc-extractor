import assert from 'node:assert/strict';
import { measureProseSpacing } from '../src/extraction/vector/classifiers/proseSpacing.js';
import { classifyPage } from '../src/extraction/vector/contextClassifier.js';
const text = 'An ordinary prose line with enough characters to measure its spacing.';
const line = (y, font = 18, str = text) => ({ y, items: [{ vx: 30, vy: y, vFont: font, vWidth: 700, str }] });
const lines = [0, 21.6, 43.2, 75.6, 97.2, 118.8].map(y => line(y));
assert.ok(Math.abs(measureProseSpacing(lines).gapFor(lines[0]) - 30.24) < 0.001);
assert.equal(measureProseSpacing(lines.slice(0, 2)).gapFor(lines[0]), null);
const labels = Array.from({ length: 30 }, (_, i) => line(200 + i * 6, 5, 'axis label'));
assert.equal(measureProseSpacing([...lines, ...labels]).gapFor(labels[0]), null);
assert.ok(measureProseSpacing([...lines, ...labels]).gapFor(lines[0]) > 30);
const viewport = { width: 1000, height: 1000, transform: [1, 0, 0, -1, 0, 1000] };
const items = [0, 21.6, 43.2, 75.6, 97.2, 118.8].map((y, i) => ({
    str: i === 2 ? 'A short final line.' : text, width: i === 2 ? 150 : 700,
    transform: [18, 0, 0, 18, 30, 900 - y], fontName: 'body',
}));
const result = classifyPage([], items, viewport, 1000, [], {
    docScale: { calibrated: true, leadingPx: 23 },
});
assert.equal(result.columnSplits.length, 0);
const first = result.regions.find(r => r.textItemIndices.includes(0));
assert.ok(first.textItemIndices.includes(2), 'short final line stays with its paragraph');
assert.ok(!first.textItemIndices.includes(3), 'measured paragraph boundary splits the next paragraph');
console.log('ok    prose spacing, sparse fallback, label exclusion and short-line continuity');

const { assemblePage, createFontRegistry } = await import('../src/extraction/vector/pageAssembler.js');
const region = { id: 'left-heading', type: 'HEADING', bbox: { x: 30, y: 100, w: 180, h: 18 },
    yCenter: 109, fontSize: 18, textItemIndices: [0], columnIndex: -1 };
const headingItem = { str: 'A left heading', width: 180, fontName: 'body', transform: [18, 0, 0, 18, 30, 900] };
const meta = { idx: 0, str: headingItem.str, vx: 30, vy: 100, vWidth: 180, vFont: 18, fontSize: 18 };
const assembled = assemblePage([region], [meta], [headingItem], viewport, 1000, 1, createFontRegistry());
assert.doesNotMatch(assembled.html, /justify-self: center/, 'an exact leaf box does not establish centered alignment');
console.log('ok    exact leaf bounds do not invent centering');

const centered = { ...region, id: 'center-heading', bbox: { ...region.bbox, x: 410 } };
const centeredPage = assemblePage([centered], [{ ...meta, vx: 410 }],
    [{ ...headingItem, transform: [18, 0, 0, 18, 410, 900] }], viewport, 1000, 1, createFontRegistry());
assert.match(centeredPage.html, /justify-self: center/, 'source centering within the page survives');
