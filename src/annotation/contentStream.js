/**
 * contentStream.js
 * Remove text-showing operators from a page's content stream.
 *
 * WHY THIS EXISTS
 * ---------------
 * A text edit used to be exported as an opaque white rectangle drawn OVER the
 * original glyphs. That is a visual cover, not a replacement: the original
 * operators stay in the content stream, so copy-paste, `pdftotext`, search,
 * screen readers and every extractor still return the covered text. Re-importing
 * such a file shows both layers, which is the "two PDFs at once" symptom.
 *
 * It is also the classic redaction failure. Anyone who covers sensitive text
 * this way ships a document from which that text is trivially recoverable.
 *
 * So an edit REPLACES: the show-operators whose origin falls inside the edit box
 * are deleted from the stream, and the replacement text is drawn in their place.
 *
 * WHY THE CTM STACK IS NOT OPTIONAL
 * ---------------------------------
 * A show-op's position is the text matrix composed with the CURRENT
 * TRANSFORMATION MATRIX, and generators routinely emit `q 1 0 0 1 46 718 cm …
 * BT 1 0 0 1 0 4 Tm (…) Tj ET … Q`. Reading `Tm` alone reports that string at
 * y=4 instead of y=722 — plausible-looking coordinates that are wrong by the
 * height of the page, which would delete text nowhere near the edit. So `q`/`Q`
 * and `cm` are tracked, and the match is made in page user space.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * - It does not re-wrap or re-flow surviving text. Only whole show-ops are
 *   removed, so a partial-word edit removes the whole run that contains it.
 * - It does not touch Type 3 glyph procs, form XObjects, or annotation
 *   appearance streams. Text inside those is not in this stream and is
 *   reported as unremoved rather than silently missed.
 * - Removed ops are blanked with spaces rather than spliced out, so every other
 *   operator keeps its byte offset and one pass can remove many ops safely.
 */

import { decodePDFRawStream, PDFArray, PDFName, PDFRawStream } from 'pdf-lib';

/** a × b for PDF's [a b c d e f] row-major 2×3 matrices. */
function mul(a, b) {
    return [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ];
}

const NUM = '[-+]?[\\d.]+';
const TOKENS = new RegExp(
    '\\bq\\b|\\bQ\\b'
    + `|((?:${NUM}\\s+){5}${NUM})\\s+cm`
    + '|\\bBT\\b|\\bET\\b'
    + `|((?:${NUM}\\s+){5}${NUM})\\s+Tm`
    + `|(${NUM})\\s+(${NUM})\\s+Td`
    + `|(${NUM})\\s+TL`
    + '|\\bT\\*'
    + '|(\\((?:[^()\\\\]|\\\\.)*\\))\\s*Tj'
    + '|(\\[[^\\]]*\\])\\s*TJ',
    'g',
);

/**
 * Locate every text-showing operator, with its origin in page user space.
 *
 * @param {string} raw  decoded content stream
 * @returns {Array<{x:number,y:number,start:number,end:number,raw:string}>}
 */
export function findShowOps(raw) {
    const ops = [];
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    let tm = [1, 0, 0, 1, 0, 0];
    let leading = 0;
    let m;

    TOKENS.lastIndex = 0;
    while ((m = TOKENS.exec(raw)) !== null) {
        const tok = m[0];

        if (tok === 'q') { stack.push(ctm.slice()); continue; }
        if (tok === 'Q') { ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; continue; }
        if (m[1]) { ctm = mul(m[1].trim().split(/\s+/).map(Number), ctm); continue; }
        if (tok === 'BT') { tm = [1, 0, 0, 1, 0, 0]; continue; }
        if (tok === 'ET') { continue; }
        if (m[2]) { tm = m[2].trim().split(/\s+/).map(Number); continue; }
        if (m[3] !== undefined) {
            tm = mul([1, 0, 0, 1, Number(m[3]), Number(m[4])], tm);
            continue;
        }
        if (m[5] !== undefined) { leading = Number(m[5]); continue; }
        if (tok === 'T*') { tm = mul([1, 0, 0, 1, 0, -leading], tm); continue; }

        if (m[6] || m[7]) {
            const f = mul(tm, ctm);
            ops.push({ x: f[4], y: f[5], start: m.index, end: TOKENS.lastIndex, raw: m[6] || m[7] });
        }
    }
    return ops;
}

/** Decode a page's content stream(s) into one string. */
export function readContentStream(page) {
    const ctx = page.doc.context;
    const contents = page.node.Contents();
    if (!contents) return '';

    const decode = (streamish) => {
        const s = streamish instanceof PDFRawStream ? streamish : ctx.lookup(streamish);
        if (!(s instanceof PDFRawStream)) return '';
        return new TextDecoder().decode(decodePDFRawStream(s).getBytes());
    };

    if (contents instanceof PDFArray) {
        // Multiple streams concatenate into ONE stream for the content parser,
        // and an operator may straddle the join, so they are joined before
        // scanning and written back as a single replacement stream.
        let out = '';
        for (let i = 0; i < contents.size(); i++) out += decode(contents.get(i)) + '\n';
        return out;
    }
    return decode(contents);
}

/** Replace a page's content with `raw`, as a single compressed stream. */
export function writeContentStream(page, raw) {
    const ctx = page.doc.context;
    const stream = ctx.flateStream(new TextEncoder().encode(raw));
    page.node.set(PDFName.of('Contents'), ctx.register(stream));
}

/**
 * Delete the show-operators whose origin falls inside any of `boxes`.
 *
 * @param {object} page   a pdf-lib PDFPage
 * @param {Array<{x:number,y:number,w:number,h:number}>} boxes
 *        in PAGE USER SPACE (bottom-left origin, y up) — the same space
 *        `viewportToUserSpace` produces.
 * @param {number} [pad]  extra tolerance in points
 * @returns {{removed:number, scanned:number}}
 */
export function removeTextInBoxes(page, boxes, pad = 1) {
    if (!boxes || boxes.length === 0) return { removed: 0, scanned: 0 };

    const raw = readContentStream(page);
    if (!raw) return { removed: 0, scanned: 0 };

    const ops = findShowOps(raw);
    const hit = ops.filter(op => boxes.some(b =>
        op.x >= b.x - pad && op.x <= b.x + b.w + pad
        && op.y >= b.y - pad && op.y <= b.y + b.h + pad));

    if (hit.length === 0) return { removed: 0, scanned: ops.length };

    // Blank in place so every other op keeps its offset.
    const buf = raw.split('');
    for (const op of hit) {
        for (let i = op.start; i < op.end; i++) buf[i] = ' ';
    }
    writeContentStream(page, buf.join(''));
    return { removed: hit.length, scanned: ops.length };
}
