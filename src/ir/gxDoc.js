/**
 * gxDoc.js
 * Core `gx-doc/1` intermediate representation.
 *
 * The IR is the typed, serializable pivot every importer produces and every
 * exporter consumes (see architecture/import-export-gateway.md). It is
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

const BLOCK_TYPES = new Set([
    'heading', 'paragraph', 'table', 'list', 'image', 'callout', 'divider',
]);

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
                }
            });
        });
    }

    return { ok: errors.length === 0, errors };
}
