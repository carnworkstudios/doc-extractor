/**
 * gxDocToRegions.js
 * gx-doc/1 → the same per-page region array the geometry pipeline emits.
 *
 * WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * A PDF goes through the classifier, which produces regions, and regions are
 * what everything downstream is built on: the analyze canvas, the artifact/tag
 * panel, and every cross-tool handoff. An imported DOCX, HTML, Markdown or JSON
 * document never touches the classifier, so it produced NO regions at all.
 * The document rendered fine and was, as far as the rest of the platform was
 * concerned, empty: no tags, therefore no artifacts, therefore nothing to send
 * anywhere. An import that cannot participate in the pipeline is not an import.
 *
 * The IR already carries the structure the classifier would have had to infer.
 * A DOCX table is a table because the file says so, not because a lattice
 * reconstructed. So this is a direct mapping, and its regions are honest about
 * that: confidence is 1.0 and `algorithm` names the importer, because the
 * source declared the structure rather than a detector guessing at it.
 *
 * IDS ─────────────────────────────────────────────────────────────────────────
 * Region ids come from `block.id`, which ensureBlockIds() stamps onto the IR
 * before either this or gxDocToHtml() runs. Both read the same field, so the
 * `data-region-id` in the rendered HTML and the `id` on the region are the same
 * string, which is what makes getRegionHtml(page, regionId) resolve.
 *
 * Pure data — no DOM, no global state.
 */

/** gx-doc block type → the RegionType the classifier would have assigned. */
const BLOCK_TYPE_TO_REGION = {
    heading:   'HEADING',
    paragraph: 'PARAGRAPH',
    list:      'LIST',
    image:     'IMAGE',
    callout:   'BOX',
    divider:   'DIVIDER',
    equation:  'MATH',
    reference: 'REFERENCE',
    // `table` is resolved per block: a borderless table is a stream table.
};

/** A text block's role is what separates page furniture from body prose. */
const ROLE_TO_REGION = { header: 'HEADER', footer: 'FOOTER' };

function _regionType(block) {
    if (block.type === 'table') {
        return block.borderless ? 'STREAM_TABLE' : 'LATTICE_TABLE';
    }
    if (block.role && ROLE_TO_REGION[block.role]) return ROLE_TO_REGION[block.role];
    return BLOCK_TYPE_TO_REGION[block.type] || 'PARAGRAPH';
}

/**
 * Per-page regions for a gx-doc.
 *
 * @param {object} gxDoc
 * @param {object} [opts]
 * @param {string} [opts.algorithm] — the importer that produced the IR
 *        ('docx-import', 'html-import', 'json-import'). Surfaces in the tag's
 *        artifact ref so a receiver can tell a declared structure from a
 *        detected one.
 * @returns {Array<{page:number, regions:Array}>}
 */
export function gxDocToRegions(gxDoc, opts = {}) {
    const algorithm = opts.algorithm || 'document-import';
    const pages = (gxDoc && Array.isArray(gxDoc.pages)) ? gxDoc.pages : [];
    const out = [];

    for (const page of pages) {
        const pageNum = page.page ?? 1;
        const blocks = Array.isArray(page.blocks) ? page.blocks : [];
        const regions = [];

        blocks.forEach((block, i) => {
            if (!block || !block.type) return;
            // An empty paragraph is whitespace in the source document, not an
            // artifact. Emitting it would put blank tags in the panel.
            if (_isEmpty(block)) return;

            regions.push({
                id: block.id || `${_regionType(block).toLowerCase()}_${pageNum}_${i}`,
                type: _regionType(block),
                // The importer read this structure off the file. There is no
                // detector to be uncertain, so the score is not a guess.
                confidence: 1.0,
                algorithm,
                // Reading order is all the geometry an imported document has.
                // yCenter keeps the panel's ordering stable; bbox is genuinely
                // absent and is left absent rather than faked, so anything that
                // needs real geometry (vector resolution) can tell.
                yCenter: Number.isFinite(block.ry) ? block.ry : i,
                columnIndex: Number.isFinite(block.colIdx) ? block.colIdx : -1,
                // The content that makes an equation or a bibliography worth
                // tagging. Without it the tag is a pointer to a page number and
                // the panel has nothing to show or send.
                ...(block.latex ? { latex: block.latex } : {}),
                ...(block.entries?.length ? { entryCount: block.entries.length } : {}),
            });
        });

        out.push({ page: pageNum, regions });
    }

    return out;
}

function _isEmpty(block) {
    switch (block.type) {
        case 'divider':
            return false;
        case 'image':
            return false;
        case 'table':
            return !(block.rows?.length || block.headers?.length);
        case 'equation':
            return !String(block.latex || block.text || '').trim();
        case 'reference':
            return !(block.entries || []).some(t => String(t || '').trim());
        case 'list':
            return !(block.items || []).some(t => String(t || '').trim());
        default: {
            if (String(block.text || '').trim()) return false;
            return !(block.runs || []).some(r => String(r?.text || '').trim());
        }
    }
}
