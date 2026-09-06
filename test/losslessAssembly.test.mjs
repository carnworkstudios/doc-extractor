import assert from 'node:assert/strict';
import { assemblePage, createFontRegistry } from '../src/extraction/vector/pageAssembler.js';

const viewport = { width: 200, height: 200, transform: [1, 0, 0, -1, 0, 200] };
const items = [
    { str: 'Evidence survives', fontName: 'Helvetica', transform: [1, 0, 0, 10, 10, 180], width: 80 },
];
const meta = [
    { idx: 0, str: 'Evidence survives', vx: 10, vy: 20, vWidth: 80, vFont: 10, fontSize: 10 },
];
const phantomTable = {
    type: 'LATTICE_TABLE', id: 'phantom', bbox: { x: 0, y: 0, w: 160, h: 160 },
    yCenter: 80, columnIndex: -1, proximityPx: 4, textItemIndices: [0],
    lattice: {
        rows: [0, 40, 80, 120, 160], cols: [0, 40, 80, 120, 160],
        hLines: [], vLines: [], clusterEps: 4,
    },
};

const page = assemblePage(
    [phantomTable], meta, items, viewport, 200, 1, createFontRegistry(),
);

assert.equal(page.tableCount, 0, 'a degenerate grid must not be reported as a table');
assert.match(page.html, /Evidence survives/, 'claimed source text must survive table-render failure');
assert.match(page.text, /Evidence survives/, 'plain-text output must preserve the same evidence');
console.log('ok    failed structural rendering degrades to source text');
