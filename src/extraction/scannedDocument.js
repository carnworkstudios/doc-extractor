// scannedDocument.js — neutral document intelligence IR for raster pages.
//
// OCR evidence must not masquerade as PDF.js text items. This module keeps the
// raster facts in their native top-left pixel space, joins them with semantic
// layout regions, reconstructs tables, and records reading order explicitly.
// Rendering into gx-doc is a separate, lossless projection at the bottom.

import { buildGrid } from '../ui/ocr/fuse.js';
import { createDoc, addPage, addBlock, ensureBlockIds } from '../ir/gxDoc.js';

export const SCANNED_DOCUMENT_SCHEMA = 'gx-scanned-document/1';

const LABEL_KIND = {
    title: 'heading',
    'section-header': 'heading',
    'section-heading': 'heading',
    text: 'paragraph',
    caption: 'paragraph',
    footnote: 'paragraph',
    'list-item': 'list',
    table: 'table',
    picture: 'image',
    formula: 'equation',
    'page-header': 'paragraph',
    'page-footer': 'paragraph',
};

export function createScannedDocument(meta = {}) {
    return {
        schema: SCANNED_DOCUMENT_SCHEMA,
        meta: { source: meta.source || 'ocr', title: meta.title || null },
        pages: [],
    };
}

/**
 * Build one neutral page. OCR boxes are render pixels; layout boxes are
 * fractional page coordinates. No PDF coordinate conversion occurs here.
 */
export function buildScannedPage({ page, width, height, ocr, layoutRegions = [] }) {
    const lines = (ocr?.lines || []).filter(validTextBox).map((line, i) => ({
        id: `p${page}-line-${i}`,
        text: String(line.text || '').trim(),
        bbox: cleanBox(line.bbox),
        confidence: finite(line.confidence, null),
        tokenIds: [],
    }));
    const tokens = (ocr?.words || []).filter(validTextBox).map((word, i) => ({
        id: `p${page}-token-${i}`,
        text: String(word.text || '').trim(),
        bbox: cleanBox(word.bbox),
        confidence: finite(word.confidence, null),
        approximate: !!word.approx,
    }));

    // Preserve token→line evidence without rewriting either geometry.
    for (const token of tokens) {
        const line = bestContainer(token.bbox, lines);
        if (line) line.tokenIds.push(token.id);
    }

    const regions = layoutRegions.map((region, i) => ({
        id: `p${page}-layout-${i}`,
        label: normalizeLabel(region.label),
        confidence: finite(region.confidence, null),
        bbox: fracToPixels(region.bbox, width, height),
    })).filter(r => boxArea(r.bbox) > 4);

    const assigned = new Set();
    const blocks = [];
    for (const region of [...regions].sort((a, b) => regionPriority(b) - regionPriority(a) || boxArea(a.bbox) - boxArea(b.bbox))) {
        const mine = lines.filter(line => !assigned.has(line.id) && centerIn(line.bbox, region.bbox));
        // Images remain meaningful without OCR. Other empty detector boxes are
        // evidence, but not renderable document blocks.
        if (!mine.length && region.label !== 'picture') continue;
        mine.forEach(line => assigned.add(line.id));
        blocks.push(makeBlock(page, blocks.length, region, mine));
    }

    // OCR text not covered by the semantic detector is retained as honest
    // paragraph evidence. A missed layout box must never become dropped text.
    for (const line of lines) {
        if (assigned.has(line.id)) continue;
        blocks.push(makeBlock(page, blocks.length, {
            label: 'text', confidence: null, bbox: line.bbox,
        }, [line], 'ocr-orphan'));
    }

    const ordered = orderBlocks(blocks, width);
    const readingOrder = ordered.slice(1).map((block, i) => ({
        from: ordered[i].id,
        to: block.id,
        relation: 'precedes',
    }));

    return {
        page,
        width,
        height,
        coordinateSpace: 'render-pixels-top-left',
        tokens,
        lines,
        layoutRegions: regions,
        blocks: ordered,
        tables: ordered.filter(b => b.kind === 'table').map(b => ({
            blockId: b.id,
            rows: b.table?.rows || 0,
            cols: b.table?.cols || 0,
            cells: b.table?.cells || [],
        })),
        readingOrder,
    };
}

function makeBlock(page, index, region, lines, provenance = 'layout+ocr') {
    const kind = LABEL_KIND[region.label] || 'paragraph';
    const sorted = [...lines].sort((a, b) => midY(a.bbox) - midY(b.bbox) || a.bbox.x0 - b.bbox.x0);
    const text = sorted.map(l => l.text).join(kind === 'paragraph' ? ' ' : '\n').trim();
    const id = `ocr-${kind}-${page}-${index}`;
    const block = {
        id,
        kind,
        label: region.label,
        bbox: cleanBox(region.bbox),
        confidence: mean(sorted.map(l => l.confidence).filter(Number.isFinite)),
        layoutConfidence: region.confidence,
        lineIds: sorted.map(l => l.id),
        text,
        provenance,
    };
    if (kind === 'table') block.table = buildGrid(sorted, block.bbox);
    if (kind === 'paragraph' && region.label === 'page-header') block.role = 'header';
    if (kind === 'paragraph' && region.label === 'page-footer') block.role = 'footer';
    return block;
}

/** Convert the neutral raster IR into the platform document IR. */
export function scannedDocumentToGxDoc(scanned, { imageKeys = {} } = {}) {
    const doc = createDoc({
        source: 'pdf-scanned',
        title: scanned?.meta?.title || null,
        pageCount: scanned?.pages?.length || 0,
    });
    for (const sourcePage of scanned?.pages || []) {
        const page = addPage(doc, sourcePage.page);
        page.width = sourcePage.width;
        page.height = sourcePage.height;
        page.coordinateSpace = sourcePage.coordinateSpace;
        page.readingOrder = sourcePage.readingOrder.map(edge => ({ ...edge }));
        page.zones = inferZones(sourcePage.blocks, sourcePage.width, sourcePage.height);
        for (const source of sourcePage.blocks) addBlock(page, blockToGx(source, imageKeys));
    }
    return ensureBlockIds(doc);
}

function blockToGx(source, imageKeys) {
    const common = {
        id: source.id,
        text: source.text,
        ry: source.bbox.y0,
        bbox: { ...source.bbox },
        colIdx: Number.isFinite(source.columnIndex) ? source.columnIndex : -1,
        confidence: source.confidence,
        provenance: source.provenance,
        sourceLineIds: [...source.lineIds],
    };
    if (source.kind === 'heading') return { ...common, type: 'heading', level: source.label === 'title' ? 1 : 2 };
    if (source.kind === 'list') return { ...common, type: 'list', items: source.text.split(/\n+/).filter(Boolean), ordered: false };
    if (source.kind === 'equation') return { ...common, type: 'equation', latex: '', confirmed: false };
    if (source.kind === 'image') return {
        ...common, type: 'image', imageId: imageKeys[source.id] || source.id, alt: source.text || 'Extracted figure',
    };
    if (source.kind === 'table') {
        const cells = source.table?.cells || [];
        return {
            ...common,
            type: 'table',
            headers: [],
            rows: cells,
            borderless: false,
            grid: { rows: source.table?.rows || cells.length, cols: source.table?.cols || 0 },
        };
    }
    return { ...common, type: 'paragraph', role: source.role || 'body' };
}

/** Regions used by overlays/cropping; derived from semantics, not classifiers. */
export function scannedPageToRegions(page, viewportWidth, viewportHeight, verification = null) {
    const sx = viewportWidth / page.width;
    const sy = viewportHeight / page.height;
    const claims = new Map((verification?.claims || [])
        .filter(claim => claim.subjectId)
        .map(claim => [claim.subjectId, claim]));
    return page.blocks.map(block => ({
        id: block.id,
        type: block.kind === 'image' ? 'IMAGE'
            : block.kind === 'table' ? 'LATTICE_TABLE'
            : block.kind === 'heading' ? 'HEADING'
            : block.kind === 'list' ? 'LIST'
            : block.kind === 'equation' ? 'MATH' : 'PARAGRAPH',
        bbox: {
            x: block.bbox.x0 * sx,
            y: block.bbox.y0 * sy,
            w: (block.bbox.x1 - block.bbox.x0) * sx,
            h: (block.bbox.y1 - block.bbox.y0) * sy,
        },
        yCenter: midY(block.bbox) * sy,
        confidence: block.confidence ?? block.layoutConfidence ?? 0,
        verification: claims.get(block.id) || null,
        algorithm: 'ocr-semantic-ir',
        columnIndex: -1,
    }));
}

function inferZones(blocks, width, height) {
    if (blocks.length < 4) return [{ y0: 0, y1: height, cols: 1 }];
    const mid = width / 2;
    const crosses = blocks.some(b => b.bbox.x0 < mid && b.bbox.x1 > mid);
    const left = blocks.filter(b => b.bbox.x1 <= mid).length;
    const right = blocks.filter(b => b.bbox.x0 >= mid).length;
    return !crosses && left > 1 && right > 1
        ? [{ y0: 0, y1: height, cols: 2, leftFraction: 0.5 }]
        : [{ y0: 0, y1: height, cols: 1 }];
}

function orderBlocks(blocks, width) {
    const mid = width / 2;
    const spanning = blocks.filter(b => b.bbox.x0 < mid && b.bbox.x1 > mid);
    const columnsExist = blocks.filter(b => b.bbox.x1 <= mid).length > 1 &&
        blocks.filter(b => b.bbox.x0 >= mid).length > 1;
    if (!columnsExist) return [...blocks].sort(byPosition);
    // Keep top/bottom spanning furniture in position, while a body spread reads
    // the complete left column before the right column.
    const body = blocks.filter(b => !spanning.includes(b));
    const top = spanning.filter(b => b.bbox.y1 <= Math.min(...body.map(x => x.bbox.y0)));
    const bottom = spanning.filter(b => !top.includes(b));
    const left = body.filter(b => midX(b.bbox) < mid).sort(byPosition);
    const right = body.filter(b => midX(b.bbox) >= mid).sort(byPosition);
    left.forEach(b => { b.columnIndex = 0; });
    right.forEach(b => { b.columnIndex = 1; });
    return [...top.sort(byPosition),
        ...left,
        ...right,
        ...bottom.sort(byPosition)];
}

const byPosition = (a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0;
const midX = b => (b.x0 + b.x1) / 2;
const midY = b => (b.y0 + b.y1) / 2;
const boxArea = b => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const normalizeLabel = s => String(s || 'text').toLowerCase().replace(/_/g, '-');
const regionPriority = r => ({ table: 5, picture: 5, formula: 5, title: 4, 'section-header': 4, 'section-heading': 4, caption: 3, 'list-item': 3, text: 1 }[r.label] || 2);
const finite = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const cleanBox = b => ({ x0: finite(b?.x0, 0), y0: finite(b?.y0, 0), x1: finite(b?.x1, 0), y1: finite(b?.y1, 0) });
const fracToPixels = (b, w, h) => ({ x0: finite(b?.x, 0) * w, y0: finite(b?.y, 0) * h, x1: (finite(b?.x, 0) + finite(b?.w, 0)) * w, y1: (finite(b?.y, 0) + finite(b?.h, 0)) * h });
const centerIn = (b, r) => midX(b) >= r.x0 && midX(b) <= r.x1 && midY(b) >= r.y0 && midY(b) <= r.y1;
const validTextBox = x => String(x?.text || '').trim() && x?.bbox && [x.bbox.x0, x.bbox.y0, x.bbox.x1, x.bbox.y1].every(Number.isFinite);
function bestContainer(box, lines) {
    const candidates = lines.filter(line => centerIn(box, line.bbox));
    return candidates.sort((a, b) => boxArea(a.bbox) - boxArea(b.bbox))[0] || null;
}
