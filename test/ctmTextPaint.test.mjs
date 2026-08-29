import assert from 'node:assert/strict';
import { extractSubpaths, linkTextPaintOps } from '../src/extraction/vector/ctmAdapter.js';

const OPS = {
    beginText: 1, setFont: 2, setTextMatrix: 3, showText: 4,
    save: 5, restore: 6, transform: 7,
    constructPath: 8, fill: 9, paintImageXObject: 10, rectangle: 11,
};
const opList = {
    fnArray: [1, 2, 3, 4, 8, 9, 5, 7, 10, 6],
    argsArray: [[], ['g_font', 12], [1, 0, 0, 1, 20, 30],
        [[{ unicode: 'Hello', width: 500 }]],
        [[OPS.rectangle], [0, 0, 10, 10]], [], [], [10, 0, 0, 10, 40, 50], ['img_1'], []],
};
const viewport = { transform: [2, 0, 0, -2, 0, 200] };
const out = extractSubpaths(opList, viewport, OPS);

assert.equal(out.textPaintOps.length, 1);
assert.equal(out.textPaintOps[0].text, 'Hello');
assert.equal(out.textPaintOps[0].fontName, 'g_font');
assert.deepEqual(out.textPaintOps[0].viewportMatrix, [2, 0, 0, -2, 40, 140]);
assert.deepEqual(out.displayList.map(x => x.kind), ['TEXT_PAINT', 'PATH_PAINT', 'IMAGE_PAINT']);
assert.equal(out.subpaths.some(path => path.filled), true);

const linked = linkTextPaintOps([{ str: 'Hello' }], out.textPaintOps);
assert.equal(linked[0].paintOpId, 'textpaint_0');
assert.equal(linked[0].paintOperatorIndex, 3);
console.log('ok    operator-native text paint stream');
