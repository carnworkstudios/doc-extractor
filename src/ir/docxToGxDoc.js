/**
 * docxToGxDoc.js
 * .docx (Office Open XML) → gx-doc/1 IR. Zero dependencies.
 *
 * A .docx is a ZIP archive; this module reads `word/document.xml` (and
 * optionally `word/numbering.xml`) with a minimal ZIP reader built on
 * DataView + DecompressionStream, then maps WordprocessingML to typed blocks.
 *
 * Binary `.doc` (Word 97-2003 CFB) is a different format and NOT supported —
 * see architecture/import-export-gateway.md.
 *
 * DOCX has no multi-column geometry, so every block gets colIdx: -1 (a single
 * full-width column). Merged table cells (w:vMerge / w:gridSpan) are flattened
 * to simple grids and flagged `column-boundary-ambiguous`.
 */

import { createDoc, addPage, addBlock } from './gxDoc.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/**
 * @param {ArrayBuffer|Uint8Array} arrayBuffer — the .docx file bytes
 * @param {object} [meta] — { source: 'docx', title }
 * @returns {Promise<object>} gxDoc
 */
export async function docxToGxDoc(arrayBuffer, meta = {}) {
    const bytes = arrayBuffer instanceof Uint8Array
        ? arrayBuffer
        : new Uint8Array(arrayBuffer instanceof ArrayBuffer ? arrayBuffer : await new Blob([arrayBuffer]).arrayBuffer());

    const documentXml = await _unzipEntry(bytes, 'word/document.xml');
    const xml = new TextDecoder().decode(documentXml);

    let numberingXml = null;
    try {
        const entry = await _unzipEntry(bytes, 'word/numbering.xml');
        numberingXml = new TextDecoder().decode(entry);
    } catch (_) { /* numbering optional — lists fall back to unordered */ }

    const blocks = _wordXmlToBlocks(xml, numberingXml);

    const gxDoc = createDoc({
        source: 'docx',
        title: meta.title || blocks.find(b => b.type === 'heading')?.text || 'Untitled',
        pageCount: 1,
    });
    const page = addPage(gxDoc, 1);
    page.width = _readPageWidth(xml);
    for (const block of blocks) addBlock(page, { ...block, colIdx: -1, ry: block.ry ?? 0 });
    return gxDoc;
}

// ── Minimal ZIP reader ────────────────────────────────────────────────────────

/**
 * Extract one entry from a ZIP archive by scanning local file headers.
 * Supports stored (0) and deflate (8) entries. Throws a descriptive error for
 * anything else (encryption, ZIP64 — none of which .docx normally uses).
 */
async function _unzipEntry(bytes, wantedName) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder();
    let offset = 0;

    while (offset + 30 <= bytes.length) {
        if (dv.getUint32(offset, true) !== 0x04034b50) {
            // Central directory / end-of-central-directory — entry not found.
            break;
        }
        const flags = dv.getUint16(offset + 6, true);
        const method = dv.getUint16(offset + 8, true);
        const compSize = dv.getUint32(offset + 18, true);
        const nameLen = dv.getUint16(offset + 26, true);
        const extraLen = dv.getUint16(offset + 28, true);
        const dataStart = offset + 30 + nameLen + extraLen;

        const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLen));
        if (name === wantedName) {
            const data = bytes.subarray(dataStart, dataStart + compSize);
            if (method === 0) return data;
            if (method === 8) return _inflateRaw(data);
            throw new Error(`Unsupported .docx compression method ${method} for "${name}"`);
        }

        offset = dataStart + compSize;
        // Streaming entry (flag bit 3): sizes live in a trailing data descriptor.
        if (flags & 0x0008) {
            // Next local header or central directory immediately follows; the
            // descriptor is 12 bytes (or 16 with 64-bit sizes).
            offset += 16;
        }
    }

    throw new Error(`"${wantedName}" not found in .docx archive`);
}

/** Deflate raw (RFC 1951) via the platform's native decompressor. */
async function _inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('DecompressionStream is not available in this browser');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ── WordprocessingML → blocks ─────────────────────────────────────────────────

function _child(el, localName) {
    if (!el) return null;
    for (const c of el.children) if (c.localName === localName) return c;
    return null;
}

/** Map numId → ilvl → ordered (true unless the format is a bullet). */
function _readNumbering(xml) {
    const byAbstract = new Map();
    for (const m of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
        const levels = new Map();
        for (const lvl of m[2].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
            const fmt = lvl[2].match(/<w:numFmt\b[^>]*w:val="([^"]+)"/);
            levels.set(parseInt(lvl[1], 10), !fmt || fmt[1] !== 'bullet');
        }
        byAbstract.set(m[1], levels);
    }
    const byNum = new Map();
    for (const m of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
        const abs = m[2].match(/<w:abstractNumId\b[^>]*w:val="(\d+)"/);
        const levels = abs && byAbstract.get(abs[1]);
        if (levels) byNum.set(parseInt(m[1], 10), levels);
    }
    return byNum;
}

/** Parse a w:body's children into a flat list of block descriptors. */
function _wordXmlToBlocks(xmlString, numberingXml) {
    const parsed = new DOMParser().parseFromString(xmlString, 'application/xml');
    if (parsed.getElementsByTagName('parsererror').length) {
        throw new Error('Invalid WordprocessingML document.xml');
    }
    const body = _child(parsed.documentElement, 'body');
    if (!body) throw new Error('No w:body found in document.xml');

    const numFmt = numberingXml ? _readNumbering(numberingXml) : new Map();
    const blocks = [];
    let ry = 0;
    let currentList = null;

    const flushList = () => {
        if (currentList) {
            blocks.push({ ...currentList, ry: ry++ });
            currentList = null;
        }
    };

    for (const el of body.children) {
        if (el.localName === 'tbl') {
            flushList();
            const table = _readTable(el);
            if (table) blocks.push({ ...table, ry: ry++ });
            continue;
        }
        if (el.localName !== 'p') continue; // sectPr, bookmarks, comment refs…

        const p = _readParagraph(el, numFmt);

        if (p.type === 'list-item') {
            if (!currentList) currentList = { type: 'list', ordered: p.ordered, items: [] };
            currentList.ordered = currentList.ordered && p.ordered;
            currentList.items.push(p.text);
            continue;
        }

        flushList();
        if (p.images && p.images.length) {
            for (const img of p.images) blocks.push({ ...img, ry: ry++ });
        }
        if (p.type === 'paragraph' || p.type === 'heading') {
            blocks.push({ type: p.type, ...(p.type === 'heading' ? { level: p.level } : {}), text: p.text, ...(p.runs ? { runs: p.runs } : {}), ry: ry++ });
        }
    }
    flushList();
    return blocks;
}

function _readParagraph(pEl, numFmt) {
    const pPr = _child(pEl, 'pPr');

    let headingLevel = 0;
    const pStyle = pPr && _child(pPr, 'pStyle');
    if (pStyle) {
        const val = pStyle.getAttributeNS(W, 'val') || '';
        const m = val.match(/^[Hh]eading\s*([1-6])$/);
        if (m) headingLevel = parseInt(m[1], 10);
    }

    let numId = null;
    let ilvl = 0;
    if (pPr) {
        const numPr = _child(pPr, 'numPr');
        if (numPr) {
            const nid = _child(numPr, 'numId');
            const ilvlEl = _child(numPr, 'ilvl');
            if (nid) numId = parseInt(nid.getAttributeNS(W, 'val') || '0', 10);
            if (ilvlEl) ilvl = parseInt(ilvlEl.getAttributeNS(W, 'val') || '0', 10);
        }
    }

    const runs = [];
    const images = [];
    let text = '';

    const visitRun = (rEl) => {
        const rPr = _child(rEl, 'rPr');
        const isOff = v => v === '0' || v === 'false';
        const bEl = rPr && _child(rPr, 'b');
        const iEl = rPr && _child(rPr, 'i');
        const bold = !!bEl && !isOff(bEl.getAttributeNS(W, 'val'));
        const italic = !!iEl && !isOff(iEl.getAttributeNS(W, 'val'));
        let superscript = false;
        let subscript = false;
        const va = rPr && _child(rPr, 'vertAlign');
        const vaVal = va && (va.getAttributeNS(W, 'val') || '');
        if (vaVal === 'superscript') superscript = true;
        else if (vaVal === 'subscript') subscript = true;

        for (const child of rEl.children) {
            if (child.localName === 't') {
                const t = child.textContent || '';
                text += t;
                runs.push({ text: t, ...(bold ? { bold: true } : {}), ...(italic ? { italic: true } : {}), ...(superscript ? { superscript: true } : {}), ...(subscript ? { subscript: true } : {}) });
            } else if (child.localName === 'tab') {
                text += '\t';
                runs.push({ text: '\t' });
            } else if (child.localName === 'br') {
                text += '\n';
                runs.push({ text: '\n' });
            } else if (child.localName === 'drawing' || child.localName === 'pict') {
                images.push({ type: 'image', id: `embedded-${images.length + 1}`, alt: '' });
            }
        }
    };

    for (const child of pEl.children) {
        if (child.localName === 'r') visitRun(child);
        else if (child.localName === 'hyperlink' || child.localName === 'fldSimple') {
            for (const r of child.children) if (r.localName === 'r') visitRun(r);
        }
    }

    const trimmed = text.replace(/\s+/g, ' ').trim();
    const normRuns = _normalizeRuns(runs);

    if (headingLevel) {
        return { type: 'heading', level: headingLevel, text: trimmed, runs: normRuns, images };
    }
    if (numId != null) {
        const ordered = numFmt.get(numId)?.get(ilvl) ?? false;
        return { type: 'list-item', ordered, text: trimmed, images };
    }
    if (!trimmed) return { type: 'empty', images };
    return { type: 'paragraph', text: trimmed, runs: normRuns, images };
}

/** Merge adjacent runs with identical styling and drop empties. */
function _normalizeRuns(runs) {
    const out = [];
    for (const r of runs) {
        if (!r.text) continue;
        const last = out[out.length - 1];
        const same = last && last.bold === r.bold && last.italic === r.italic
            && last.superscript === r.superscript && last.subscript === r.subscript;
        if (same) last.text += r.text;
        else out.push({ ...r });
    }
    return out.length ? out : undefined;
}

function _readTable(tblEl) {
    const rows = [];
    let ambiguous = false;

    for (const tr of [...tblEl.children].filter(c => c.localName === 'tr')) {
        const row = [];
        for (const tc of [...tr.children].filter(c => c.localName === 'tc')) {
            const tcPr = _child(tc, 'tcPr');
            if (tcPr) {
                if (_child(tcPr, 'vMerge')) ambiguous = true;
                const gs = _child(tcPr, 'gridSpan');
                if (gs && (parseInt(gs.getAttributeNS(W, 'val') || '1', 10) || 1) > 1) ambiguous = true;
            }
            const text = (tc.textContent || '').replace(/\s+/g, ' ').trim();
            row.push(text);
        }
        rows.push(row);
    }

    if (!rows.length) return null;
    return {
        type: 'table',
        caption: null,
        borderless: false,
        confidence: null,
        flags: ambiguous ? ['column-boundary-ambiguous'] : [],
        headers: rows[0] || [],
        rows: rows.slice(1),
    };
}

/** Page width from w:sectPr/w:pgSz (twips → px @ 96dpi). */
function _readPageWidth(xml) {
    const m = xml.match(/<w:pgSz\b[^>]*w:w="(\d+)"/);
    return m ? Math.round(parseInt(m[1], 10) / 20) : 0;
}
