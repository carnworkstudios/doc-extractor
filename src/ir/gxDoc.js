/**
 * gxDoc.js
 * Core `gx-doc/1` intermediate representation.
 *
 * The IR is the typed, serializable pivot every importer produces and every
 * exporter consumes. It is
 * zone-aware: it preserves the multi-column layout, alignment, typography, and
 * spatial metadata from the original extraction so gxDocToHtml() can rebuild
 * the CSS Grid layout.
 *
 * Pure data — no DOM, no imports, no dependencies.
 */

export const GX_DOC_SCHEMA = 'gx-doc/1';

/**
 * Factory for a blank gx-doc.
 * @param {object} [meta] — { source, title, pageCount }
 */
export function createDoc(meta = {}) {
    return {
        schema: GX_DOC_SCHEMA,
        meta: {
            source: meta.source ?? null,
            title: meta.title ?? null,
            pageCount: meta.pageCount ?? null,
        },
        pages: [],
        links: [],
        bookmarks: [],
        annotations: [],
    };
}

/**
 * Append a page shell. Returns the new page so callers can fill zones/blocks.
 */
export function addPage(doc, pageNum) {
    const page = {
        page: pageNum,
        width: 0,
        zones: [],
        blocks: [],
    };
    doc.pages.push(page);
    return page;
}

/** Push a typed block onto a page. */
export function addBlock(page, block) {
    page.blocks.push(block);
    return block;
}

/**
 * Stamp a stable id onto every block that lacks one, in place.
 *
 * The id is the join between two renderings of the same document: the
 * `data-region-id` gxDocToHtml() writes into the markup, and the `id` on the
 * region gxDocToRegions() derives. Both read block.id, so they agree by
 * construction rather than by two functions independently computing the same
 * string and drifting apart.
 *
 * Importers do not have to set ids. Any they DO set (docx image blocks carry
 * one) are preserved, because those ids are already referenced elsewhere.
 *
 * Returns the same doc for chaining.
 */
export function ensureBlockIds(doc) {
    const pages = (doc && Array.isArray(doc.pages)) ? doc.pages : [];
    for (const page of pages) {
        const pageNum = page.page ?? 1;
        const blocks = Array.isArray(page.blocks) ? page.blocks : [];
        const seen = new Set();
        // Nested blocks — a callout's classified contents — are stamped by the
        // same walk. They are addressed exactly like top-level ones, so leaving
        // them unstamped would give the markup no `data-region-id` while
        // gxDocToRegions invented a positional one, and the two renderings of
        // the same block would no longer resolve to each other.
        const stamp = (block, key) => {
            if (!block) return;
            let id = block.id;
            // A duplicate is as bad as a missing one: two blocks with the same
            // id make getRegionHtml resolve both to whichever comes first.
            if (!id || seen.has(id)) id = `${block.type || 'block'}_${pageNum}_${key}`;
            block.id = id;
            seen.add(id);
            const kids = Array.isArray(block.blocks) ? block.blocks : [];
            kids.forEach((kid, ki) => stamp(kid, `${key}_${ki}`));
        };
        blocks.forEach((block, i) => stamp(block, i));
    }
    return doc;
}

// The block types the IR can carry. These are the region legends the whole
// platform is addressed through — every artifact tab, every tag kind and every
// cross-tool handoff is one of these, so a legend that is not here is a legend
// that silently becomes a paragraph on the way in and is lost on the way out.
//
//   equation  — display math. Carries `latex`, which is the content; the
//               rendered markup is a view of it and is re-derivable.
//   reference — a bibliography block. Carries `entries`, because "the wall of
//               text on page 21" is not something anyone can cite or export.
//
// A paragraph additionally carries `role` ('header' | 'body' | 'footer'), which
// is what makes running heads and page furniture separable from body prose
// instead of all three arriving as the same untyped paragraph.
const BLOCK_TYPES = new Set([
    'heading', 'paragraph', 'table', 'list', 'image', 'callout', 'divider',
    'equation', 'reference',
]);

/** Valid values for a text block's `role`. */
export const TEXT_ROLES = new Set(['header', 'body', 'footer']);

/**
 * Assert the document is a structurally valid gx-doc/1.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDoc(doc) {
    const errors = [];

    if (!doc || typeof doc !== 'object') {
        return { ok: false, errors: ['gx-doc is not an object'] };
    }
    if (doc.schema !== GX_DOC_SCHEMA) {
        errors.push(`schema must be "${GX_DOC_SCHEMA}"`);
    }
    // Optional top-level collections (annotations, bookmarks, links).
    if (doc.annotations != null && !Array.isArray(doc.annotations)) {
        errors.push('annotations must be an array');
    }
    if (doc.bookmarks != null && !Array.isArray(doc.bookmarks)) {
        errors.push('bookmarks must be an array');
    }
    if (doc.links != null && !Array.isArray(doc.links)) {
        errors.push('links must be an array');
    }
    if (!Array.isArray(doc.pages)) {
        errors.push('pages must be an array');
    } else {
        doc.pages.forEach((page, pi) => {
            if (!page || typeof page !== 'object') {
                errors.push(`pages[${pi}] is not an object`);
                return;
            }
            if (!Array.isArray(page.blocks)) errors.push(`pages[${pi}].blocks must be an array`);
            if (!Array.isArray(page.zones)) errors.push(`pages[${pi}].zones must be an array`);
            (page.blocks || []).forEach((block, bi) => {
                if (!block || !BLOCK_TYPES.has(block.type)) {
                    errors.push(`pages[${pi}].blocks[${bi}] has unknown type`);
                    return;
                }
                if (block.role != null && !TEXT_ROLES.has(block.role)) {
                    errors.push(`pages[${pi}].blocks[${bi}] has unknown role "${block.role}"`);
                }
                if (block.type === 'equation' && !String(block.latex || block.text || '').trim()) {
                    errors.push(`pages[${pi}].blocks[${bi}] is an equation with no latex or text`);
                }
                if (block.type === 'reference' && !(block.entries || []).length) {
                    errors.push(`pages[${pi}].blocks[${bi}] is a reference block with no entries`);
                }
                // A callout carries its classified contents as nested blocks.
                // They are validated as blocks — an unknown type inside a box
                // is exactly as broken as one at the top level, and validating
                // only the outer list would let it through unseen.
                if (block.blocks != null) {
                    if (!Array.isArray(block.blocks)) {
                        errors.push(`pages[${pi}].blocks[${bi}].blocks must be an array`);
                    } else {
                        block.blocks.forEach((kid, ki) => {
                            if (!kid || !BLOCK_TYPES.has(kid.type)) {
                                errors.push(`pages[${pi}].blocks[${bi}].blocks[${ki}] has unknown type`);
                            }
                        });
                    }
                }
            });
        });
    }

    return { ok: errors.length === 0, errors };
}
