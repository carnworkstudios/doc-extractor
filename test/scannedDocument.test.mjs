import assert from 'node:assert/strict';
import {
    createScannedDocument,
    buildScannedPage,
    scannedDocumentToGxDoc,
    scannedPageToRegions,
} from '../src/extraction/scannedDocument.js';
import { validateDoc } from '../src/ir/gxDoc.js';
import { gxDocToHtml } from '../src/ir/gxDocToHtml.js';
import { verifyScannedPage } from '../src/extraction/ocrVerifier.js';
import { createLineage, hashCanonical } from '../src/ui/ocr/provenance.js';

const line = (text, x0, y0, x1, y1, confidence = 95) => ({ text, bbox: { x0, y0, x1, y1 }, confidence });
const words = [
    line('Energy', 10, 10, 80, 25),
    line('A', 20, 60, 30, 72), line('1.0', 90, 60, 120, 72),
    line('B', 20, 90, 30, 102), line('2.0', 90, 90, 120, 102),
    line('After', 10, 150, 55, 164),
];
const page = buildScannedPage({
    page: 1, width: 200, height: 250,
    ocr: { words, lines: words },
    layoutRegions: [
        { label: 'section-header', confidence: .98, bbox: { x: .02, y: .02, w: .45, h: .1 } },
        { label: 'table', confidence: .97, bbox: { x: .05, y: .2, w: .7, h: .25 } },
    ],
});

assert.equal(page.tokens.length, 6, 'keeps OCR tokens');
assert.equal(page.lines.length, 6, 'keeps OCR lines');
assert.equal(page.tables.length, 1, 'creates a semantic table');
assert.ok(page.readingOrder.length > 0, 'records explicit reading-order edges');
assert.ok(page.blocks.some(b => b.provenance === 'ocr-orphan' && b.text === 'After'), 'retains uncovered OCR');
const verification = verifyScannedPage(page);
assert.equal(verification.schema, 'gx-verification/1');
assert.equal(verification.status, 'disputed', 'ambiguous small table is not promoted to verified');
assert.equal(verification.counts.unsupported, 0);
assert.ok(verification.claims.every(claim => claim.evidence.length), 'grounds every claim in source evidence');

const cleanPage = buildScannedPage({
    page: 2, width: 200, height: 250,
    ocr: { words: [line('Grounded prose', 10, 20, 110, 35)], lines: [line('Grounded prose', 10, 20, 110, 35)] },
    layoutRegions: [{ label: 'text', confidence: .99, bbox: { x: .02, y: .04, w: .65, h: .15 } }],
});
assert.equal(verifyScannedPage(cleanPage).status, 'verified');

const damaged = structuredClone(page);
damaged.blocks[0].text = 'text invented after OCR';
damaged.lines.push(line('Dropped evidence', 10, 210, 100, 225));
damaged.lines[damaged.lines.length - 1].id = 'unclaimed-line';
const damagedVerification = verifyScannedPage(damaged);
assert.equal(damagedVerification.status, 'unsupported');
assert.equal(damagedVerification.counts.unsupported, 1);
assert.equal(damagedVerification.counts.missing, 1);

const scanned = createScannedDocument({ title: 'fixture' });
scanned.pages.push(page);
const gxDoc = scannedDocumentToGxDoc(scanned);
assert.deepEqual(validateDoc(gxDoc), { ok: true, errors: [] });
assert.equal(gxDoc.pages[0].readingOrder.length, page.readingOrder.length, 'preserves reading order');
const html = gxDocToHtml(gxDoc);
assert.match(html, /data-region-id="ocr-table-1-/);
assert.match(html, /<table/);

const regions = scannedPageToRegions(page, 400, 500);
assert.ok(regions.some(r => r.type === 'LATTICE_TABLE'));
assert.ok(regions.every(r => r.algorithm === 'ocr-semantic-ir'));

const lineage = createLineage('ses_test');
const sourceHash = await hashCanonical(page);
const recognized = await lineage.emit({ op: 'recognize_page' }, {
    subject: { pointer: { page: 1 }, sha256: sourceHash, parent_sha256: null },
});
await lineage.emit({ op: 'verify_extraction', outcome: verification.status }, {
    parents: [recognized.id], score: verification.score,
    subject: { pointer: { page: 1 }, sha256: await hashCanonical(verification), parent_sha256: sourceHash },
});
assert.equal(await lineage.verify(), -1, 'verification events keep an intact hash chain');
assert.deepEqual(lineage.events[1].parents, [recognized.id], 'verification points to recognition evidence');

console.log('ok    scanned document IR');
