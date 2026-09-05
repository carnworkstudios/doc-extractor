import assert from 'node:assert/strict';
import {
    markdownToHtml, mimeForFile, parseFileBytes, routeFile,
} from '../src/import/parseFile.js';

assert.equal(routeFile('page.JPG'), 'image');
assert.equal(routeFile('notes.md'), 'md');
assert.equal(routeFile('report.html'), 'html');
assert.equal(routeFile('data.json'), 'json');
assert.equal(routeFile('scan.pdf'), 'pdf');
assert.equal(mimeForFile('scan.webp'), 'image/webp');

const table = markdownToHtml('| A | B |\n|---|---|\n| 1 | 2 |');
assert.match(table, /pdf-table--lattice/);
assert.match(table, /<td>1<\/td>/);

const png = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
));
const parsed = await parseFileBytes(png, { name: 'page.png', type: 'image/png' });
assert.equal(parsed.kind, 'pdf');
assert.equal(parsed.source, 'image');
assert.equal(new TextDecoder().decode(parsed.bytes.slice(0, 4)), '%PDF');

Object.defineProperty(globalThis, 'navigator', {
    value: { hardwareConcurrency: 2 }, configurable: true,
});
const { BatchQueueManager } = await import('../../../assets/pdf-processor/batch/batchQueue.js');
const queue = new BatchQueueManager();
assert.equal(queue._detectFormat('page.jpeg'), 'image');
assert.equal(queue._detectFormat('page.webp'), 'image');

console.log('ok    unified file parser');
