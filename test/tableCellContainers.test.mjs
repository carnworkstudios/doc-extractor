import assert from 'node:assert/strict';
import { assemblePage, createFontRegistry } from '../src/extraction/vector/pageAssembler.js';

const viewport = { width: 200, height: 200, transform: [1, 0, 0, -1, 0, 200] };
const items = [
    { str: 'Section', fontName: 'Helvetica', transform: [1, 0, 0, 12, 10, 180], width: 42 },
    { str: 'Body text', fontName: 'Helvetica', transform: [1, 0, 0, 10, 10, 160], width: 48 },
];
const meta = [
    { idx: 0, str: 'Section', vx: 10, vy: 20, vWidth: 42, vFont: 12, fontSize: 12 },
    { idx: 1, str: 'Body text', vx: 10, vy: 40, vWidth: 48, vFont: 10, fontSize: 10 },
];
const heading = { type: 'HEADING', id: 'cell_heading', bbox: {x:10,y:15,w:50,h:14},
    yCenter: 22, fontSize: 12, columnIndex: -1, textItemIndices: [0] };
const paragraph = { type: 'PARAGRAPH', id: 'cell_paragraph', bbox: {x:10,y:35,w:60,h:14},
    yCenter: 42, fontSize: 10, columnIndex: -1, textItemIndices: [1] };
const box = { type: 'BOX', id: 'cell_box', bbox: {x:5,y:30,w:80,h:30}, yCenter:45,
    columnIndex:-1, boxRole:'note', textItemIndices:[1], children:[paragraph] };
const table = {
    type: 'LATTICE_TABLE', id: 'table_0', bbox: {x:0,y:0,w:100,h:100}, yCenter: 50,
    columnIndex: -1, proximityPx: 15, textItemIndices: [0, 1],
    lattice: { rows:[0,100], cols:[0,100], hLines:[{y:0,xMin:0,xMax:100},{y:100,xMin:0,xMax:100}],
        vLines:[{x:0,yMin:0,yMax:100},{x:100,yMin:0,yMax:100}], clusterEps: 4 },
    cellChildren: { '0:0': [heading, box] },
};

const page = assemblePage([table], meta, items, viewport, 200, 1, createFontRegistry());
assert.equal(page.tableCount, 1);
assert.match(page.html, /<td|<th/);
assert.match(page.html, /pdf-table-cell-block/);
assert.match(page.html, /<h[1-6][^>]*>.*Section/s);
assert.match(page.html, /<p[^>]*>.*Body text/s);
assert.match(page.html, /<aside class="pdf-box/);
assert.ok(page.html.indexOf('cell_heading') > page.html.indexOf('<table'));
assert.ok(page.html.indexOf('cell_paragraph') < page.html.indexOf('</table>'));
console.log('ok    table cells render semantic child regions');
