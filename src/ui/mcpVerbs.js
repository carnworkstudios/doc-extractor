/**
 * mcpVerbs.js — headless request handlers beyond text/structured extraction.
 *
 * `fileUpload.js` answers `ginexys:mcp-extract-text` and
 * `ginexys:mcp-extract-structured` because those are read-outs of the load it
 * just performed. Everything here is a separate capability an agent can ask
 * for, so it lives in its own module rather than growing the loader:
 *
 *   ginexys:mcp-convert         {format}                  → rendered bytes
 *   ginexys:mcp-get-gxdoc       {}                        → the gx-doc/1 IR
 *   ginexys:mcp-merge-export    {docs, format, title}     → N gx-docs → one file
 *   ginexys:mcp-verify-external {pages, space}            → grade a FOREIGN extractor
 *
 * ── IP boundary ──────────────────────────────────────────────────────────────
 * All four are PUBLIC contract: a data SHAPE and a deterministic transform over
 * it. None of them assemble policy, so none of them belong in the root-injected
 * layer (see .ai/AGENTS.md §IP-BOUNDARY STANDARD). The tune loop, which IS
 * policy, stays in analyzePanel.js where it already is.
 *
 * ── Why every reply is base64 ────────────────────────────────────────────────
 * These cross a postMessage bridge and then a JSON transport to a Node host.
 * `renderGxDocAs` returns strings today, but 'doc' is an Office MHTML envelope
 * and a future format will be genuinely binary. Encoding uniformly means the
 * transport never has to know which is which, and a caller that writes
 * `Buffer.from(data, 'base64')` to disk is correct for all of them forever.
 */

import { state } from '../state.js';
import { renderGxDocAs } from './exportController.js';
import { mergeGxDocs } from '../ir/mergeGxDocs.js';
import { GX_DOC_SCHEMA } from '../ir/gxDoc.js';
import { scoreTables } from '../extraction/vector/tableSemantics.js';

/** Formats `renderGxDocAs` can produce. Kept here so the refusal can name them. */
const CONVERT_FORMATS = ['markdown', 'html', 'json', 'xml', 'doc'];

/** UTF-8 safe base64 — btoa() alone throws on any non-Latin-1 character. */
function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    // Chunked: String.fromCharCode.apply with a 10 MB spread blows the call
    // stack, and a large HTML export reaches that easily.
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return { base64: btoa(binary), byteLength: bytes.length };
}

function failure(reason, detail) {
    return { ok: false, reason, detail };
}

/** Shared shape for anything that produces a file. */
function rendered(format, { content, mime, ext }) {
    const { base64, byteLength } = toBase64(content);
    return {
        ok: true,
        format,
        mimeType: mime,
        extension: ext,
        encoding: 'base64',
        data: base64,
        byteLength,
    };
}

// ── ginexys:mcp-convert ───────────────────────────────────────────────────────

export function handleConvert(params) {
    const format = params?.format;
    if (!CONVERT_FORMATS.includes(format)) {
        return failure(
            'unsupported-format',
            `convert supports ${CONVERT_FORMATS.join(', ')}; got "${format ?? 'nothing'}". ` +
            // 'pdf' is a real menu item in the UI and the obvious thing to ask
            // for, so refuse it by name rather than letting it read as a typo.
            (format === 'pdf'
                ? 'PDF is not a conversion target: the tool\'s PDF export copies the ' +
                  'ORIGINAL pages and overlays annotations, so it would hand you back ' +
                  'the file you supplied. Use the source PDF instead.'
                : ''),
        );
    }

    const gxDoc = state.pdf1?.gxDoc;
    if (!gxDoc) {
        // Every format below is gx-doc-first. Without the IR there is an
        // HTML-scraping fallback in the interactive exporter, but it loses the
        // per-table confidence and page structure that make this product worth
        // calling — so refuse and say which, rather than quietly downgrading.
        return failure(
            'no-structured-document',
            state.pdf1?.extractedHTML
                ? 'This document was extracted without the gx-doc/1 IR, so conversion ' +
                  'would run off scraped HTML and lose page structure and per-table ' +
                  'confidence. Re-extract with the current pipeline first.'
                : 'No document has been extracted in this session. Send ginexys:pdf-bytes first.',
        );
    }

    const name = state.pdf1?.file?.name?.replace(/\.[^.]+$/, '') || 'document';
    try {
        return rendered(format, renderGxDocAs(format, gxDoc, name));
    } catch (err) {
        return failure('convert-failed', String(err?.message || err));
    }
}

// ── ginexys:mcp-get-gxdoc ─────────────────────────────────────────────────────

export function handleGetGxDoc() {
    const gxDoc = state.pdf1?.gxDoc;
    if (!gxDoc) {
        return failure(
            'no-structured-document',
            'No gx-doc/1 IR in this session. Send ginexys:pdf-bytes and let extraction finish.',
        );
    }
    return { ok: true, schema: gxDoc.schema ?? GX_DOC_SCHEMA, gxDoc };
}

// ── ginexys:mcp-merge-export ──────────────────────────────────────────────────

export function handleMergeExport(params) {
    const docs = params?.docs;
    if (!Array.isArray(docs) || docs.length < 2) {
        return failure(
            'not-enough-documents',
            `merge needs at least two documents; got ${Array.isArray(docs) ? docs.length : 0}.`,
        );
    }
    const format = params?.format ?? 'markdown';
    if (!CONVERT_FORMATS.includes(format)) {
        return failure(
            'unsupported-format',
            `merge supports ${CONVERT_FORMATS.join(', ')}; got "${format}".`,
        );
    }

    const sources = [];
    for (const [i, d] of docs.entries()) {
        if (!d?.gxDoc?.pages) {
            return failure(
                'invalid-document',
                `docs[${i}] ("${d?.name ?? 'unnamed'}") carries no gx-doc/1 pages. ` +
                'Each entry must be { name, gxDoc } as returned by ginexys:mcp-get-gxdoc.',
            );
        }
        sources.push({ name: d.name || `document-${i + 1}`, gxDoc: d.gxDoc });
    }

    try {
        const merged = mergeGxDocs(sources, {
            title: params?.title || 'Combined document',
            separatorHeading: params?.separatorHeading !== false,
            bookmarkPerDoc: params?.bookmarkPerDoc !== false,
        });
        const out = rendered(format, renderGxDocAs(format, merged, params?.title || 'combined'));
        return {
            ...out,
            // mergeGxDocs renumbers pages into one sequence and stamps every page
            // with sourceDoc/sourcePage. Surfacing the manifest means a caller
            // reading only the merged file can still map any page back.
            sources: sources.map((s, i) => ({ index: i, name: s.name, pages: s.gxDoc.pages.length })),
            pageCount: merged.pages.length,
        };
    } catch (err) {
        return failure('merge-failed', String(err?.message || err));
    }
}

// ── ginexys:mcp-score-tables ──────────────────────────────────────────────────

/**
 * Grade table grids for semantic integrity — coherent column types, consistent
 * formats, a real header row, a grid the spans actually tile.
 *
 * Unlike every other verify path this needs NO source document: a column that
 * has stopped being one type is visible in the grid alone. That makes it usable
 * on a foreign extractor's output with nothing but the tables, and it is why
 * `buildStructuredPayload` runs the same function over our own tables for free.
 */
export function handleScoreTables(params) {
    const tables = params?.tables;
    if (!Array.isArray(tables) || !tables.length) {
        return failure(
            'no-tables',
            'score-tables needs tables: [{ page, rows, cols, cells: [{r, c, text, rowSpan, colSpan}] }]. ' +
            'Cells must address a zero-based grid with spans already resolved — the same shape ' +
            'ginexys:mcp-extract-structured returns.',
        );
    }
    try {
        return { ok: true, ...scoreTables(tables) };
    } catch (err) {
        return failure('score-tables-failed', String(err?.message || err));
    }
}

// ── ginexys:mcp-verify-external ───────────────────────────────────────────────

/**
 * @param {object} params — { pages: [{page, regions: [{type, bbox, confidence}]}], space }
 * @param {function} requestWorker — round-trips one message to the geometry worker
 */
export async function handleVerifyExternal(params, requestWorker) {
    if (!Array.isArray(params?.pages) || !params.pages.length) {
        return failure(
            'no-regions',
            'verify needs pages: [{ page, regions: [{ type, bbox }] }]. ' +
            'bbox defaults to fractions of the page with a top-left origin; pass ' +
            'space: "pdf-points" for Docling\'s native bottom-left points.',
        );
    }
    if (typeof requestWorker !== 'function') {
        return failure(
            'worker-unavailable',
            'The geometry worker is not running in this session, so there is no ' +
            'source text to score against.',
        );
    }
    try {
        return await requestWorker({
            type: 'score-external',
            space: params.space || 'fraction',
            pages: params.pages,
            includeChunks: !!params.includeChunks,
        });
    } catch (err) {
        return failure('verify-failed', String(err?.message || err));
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

const HANDLERS = {
    'ginexys:mcp-convert':         (p) => handleConvert(p),
    'ginexys:mcp-get-gxdoc':       () => handleGetGxDoc(),
    'ginexys:mcp-merge-export':    (p) => handleMergeExport(p),
    'ginexys:mcp-score-tables':    (p) => handleScoreTables(p),
};

/**
 * Listen for the headless verbs above.
 *
 * @param {object} deps
 *   requestWorker — (msg) => Promise<reply>, a round trip to the geometry worker
 *   whenLoaded    — Promise that settles once any in-flight document load is done
 */
export function initMcpVerbs({ requestWorker, whenLoaded } = {}) {
    if (!window.CwsBridge?.isEmbedded) return;

    window.addEventListener('message', (e) => {
        const msg = e.data;
        if (!msg?.__ginexys) return;

        const requestId = msg.requestId;
        // Await any in-flight load first. An agent sends bytes and the follow-up
        // request back-to-back; without this, convert answers "no document" for
        // a file that was three hundred milliseconds from being ready.
        const ready = typeof whenLoaded === 'function'
            ? Promise.resolve(whenLoaded()).catch(() => {})
            : Promise.resolve();

        if (msg.type === 'ginexys:mcp-verify-external') {
            ready.then(() => handleVerifyExternal(msg.payload || {}, requestWorker))
                .then(payload => window.CwsBridge.reply(requestId, payload))
                .catch(err => window.CwsBridge.reply(requestId,
                    failure('verify-failed', String(err?.message || err))));
            return;
        }

        const handler = HANDLERS[msg.type];
        if (!handler) return;

        ready.then(() => {
            let payload;
            try {
                payload = handler(msg.payload || {});
            } catch (err) {
                payload = failure('handler-threw', String(err?.message || err));
            }
            window.CwsBridge.reply(requestId, payload);
        });
    });
}
