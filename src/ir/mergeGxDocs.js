/**
 * mergeGxDocs.js
 * Combine N gx-doc/1 documents into one.
 *
 * This is what makes batch export work in every format instead of only as a
 * JSON manifest. The exporters (Markdown / XML / DOC / HTML / JSON) are already
 * gx-doc-first, so once several documents are ONE gx-doc, every existing
 * exporter produces a combined file with no format-specific merge code.
 *
 * Three things have to be reconciled, and all three are page-numbering problems:
 *
 *   1. Page numbers collide. Each source starts at 1. Pages are renumbered into
 *      a single continuous sequence, and every page keeps `sourceDoc` +
 *      `sourcePage` so the origin of any page is still recoverable — that is the
 *      provenance requirement, not a nicety.
 *   2. Links, bookmarks and annotations are keyed by page number, so each one is
 *      rewritten through the same offset. A bookmark that still pointed at
 *      "page 3" would silently land in a different document.
 *   3. IDs collide across documents. Each is namespaced with its document index.
 *
 * Pure data — no DOM, no imports.
 */

import { GX_DOC_SCHEMA } from './gxDoc.js';

/**
 * @param {Array<{name:string, gxDoc:object}>} sources — in output order
 * @param {object} [opts]
 *   title           — meta.title for the merged doc
 *   separatorHeading — insert an H1 naming each source before its first page
 *                      (default true; the only cue in a flat format like
 *                      Markdown that a new document started)
 *   bookmarkPerDoc  — add a bookmark at each document's first page (default true)
 * @returns {object} a gx-doc/1 document
 */
export function mergeGxDocs(sources, opts = {}) {
    const {
        title = 'Combined document',
        separatorHeading = true,
        bookmarkPerDoc = true,
    } = opts;

    const merged = {
        schema: GX_DOC_SCHEMA,
        meta: {
            source: 'batch-merge',
            title,
            pageCount: 0,
            // The manifest of what went in, in order. A consumer reading only
            // the merged file can still tell which documents produced it.
            documents: [],
        },
        pages: [],
        links: [],
        bookmarks: [],
        annotations: [],
        // Edits made on the PDF text surface. Page-keyed like the rest, so it
        // goes through the same offset — otherwise every edit from the second
        // document onward lands on the wrong page or is dropped entirely.
        textEdits: [],
    };

    let pageOffset = 0;

    sources.forEach((src, docIndex) => {
        const doc = src.gxDoc;
        const name = src.name || doc?.meta?.title || `Document ${docIndex + 1}`;
        if (!doc || !Array.isArray(doc.pages) || doc.pages.length === 0) {
            merged.meta.documents.push({ name, index: docIndex, firstPage: null, pageCount: 0, skipped: 'no pages' });
            return;
        }

        const firstPage = pageOffset + 1;

        doc.pages.forEach((page, pi) => {
            const newPageNum = pageOffset + pi + 1;
            const blocks = (page.blocks || []).map(b => _nsBlock(b, docIndex));

            // The document title as an H1 on its first page. Without it a
            // combined Markdown file is an undifferentiated wall of text.
            if (separatorHeading && pi === 0) {
                blocks.unshift({
                    type: 'heading',
                    level: 1,
                    text: name,
                    runs: [{ text: name }],
                    _batchSeparator: true,
                });
            }

            merged.pages.push({
                ...page,
                page: newPageNum,
                blocks,
                sourceDoc: name,
                sourceDocIndex: docIndex,
                sourcePage: page.page ?? pi + 1,
            });
        });

        _remapPaged(doc.links, pageOffset, docIndex).forEach(l => merged.links.push(l));
        _remapPaged(doc.bookmarks, pageOffset, docIndex).forEach(b => merged.bookmarks.push(b));
        _remapPaged(doc.annotations, pageOffset, docIndex).forEach(a => merged.annotations.push(a));
        _remapPaged(doc.textEdits, pageOffset, docIndex).forEach(t => merged.textEdits.push(t));

        if (bookmarkPerDoc) {
            // Prepend rather than append so the per-document entry sorts above
            // that document's own bookmarks in the outline.
            merged.bookmarks.push({
                id: `bm_doc_${docIndex}`,
                page: firstPage,
                label: name,
                created: new Date().toISOString(),
                _batchDocEntry: true,
            });
        }

        pageOffset += doc.pages.length;
        merged.meta.documents.push({
            name,
            index: docIndex,
            firstPage,
            pageCount: doc.pages.length,
        });
    });

    merged.meta.pageCount = merged.pages.length;
    if (!merged.textEdits.length) delete merged.textEdits;
    // Outline order should follow page order, not insertion order.
    merged.bookmarks.sort((a, b) => (a.page || 0) - (b.page || 0));
    return merged;
}

/** Namespace a block's id so two documents cannot claim the same one. */
function _nsBlock(block, docIndex) {
    if (!block || typeof block !== 'object') return block;
    if (block.id == null) return block;
    return { ...block, id: `d${docIndex}_${block.id}` };
}

/** Shift a page-keyed collection by the running page offset. */
function _remapPaged(list, pageOffset, docIndex) {
    if (!Array.isArray(list)) return [];
    return list.map(entry => ({
        ...entry,
        id: entry.id != null ? `d${docIndex}_${entry.id}` : entry.id,
        page: (entry.page || 1) + pageOffset,
        sourceDocIndex: docIndex,
    }));
}
