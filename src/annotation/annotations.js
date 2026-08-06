/**
 * annotations.js
 * The annotation IR — a typed, serializable collection that rides along with
 * gx-doc/1 at the top level (`doc.annotations`). Pure data, no DOM.
 *
 * An annotation is a user-authored, page-anchored edit on the SPATIAL
 * document (the PDF). Coordinates are in page display space (PDF points,
 * top-left origin, y down — the SVG viewBox space). Because they live in the
 * IR, they survive JSON export/import and re-extraction: extraction only
 * regenerates pages/blocks and never touches the annotations array.
 */

export const ANNOTATION_KINDS = ['highlight', 'ink', 'rect', 'ellipse', 'arrow', 'text', 'measure'];

// Default style per kind. All are pure data — never mutated in place.
const KIND_DEFAULT_STYLE = {
    highlight: { color: '#ffeb3b', opacity: 0.4 },
    ink:       { color: '#e11d48', strokeWidth: 2 },
    rect:      { color: '#1565c0', strokeWidth: 2 },
    ellipse:   { color: '#1565c0', strokeWidth: 2 },
    arrow:     { color: '#e11d48', strokeWidth: 2 },
    text:      { color: '#111111', fontSize: 14 },
    measure:   { color: '#7b1fa2', strokeWidth: 1.5 },
};

let _idSeq = 0;

/** Create a fresh annotation with defaults filled in. */
export function createAnnotation({ kind, page, rect = null, points = null, text = '', style = {}, label = '' }) {
    const id = `ann_${Date.now().toString(36)}_${(++_idSeq).toString(36)}`;
    const now = new Date().toISOString();
    const base = {
        id,
        page,
        kind,
        style: { ...KIND_DEFAULT_STYLE[kind] || {}, ...style },
        provenance: {
            kind: 'annotation',
            value: 1,
            score: 1,
            source: 'pdf-processor',
            tool: 'pdf-processor',
            stage: 'annotation',
        },
        created: now,
        edited: now,
    };
    if (rect) base.rect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    if (points && points.length) {
        base.points = points.map(p => Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]);
    }
    if (text) base.text = String(text);
    if (label) base.label = String(label);
    return base;
}

/** Deep clone a list of annotations (used to stash across re-extraction). */
export function cloneAnnotations(list) {
    return Array.isArray(list) ? JSON.parse(JSON.stringify(list)) : [];
}

/** The annotation bbox used for selection/hit-testing. */
export function annotationBBox(ann) {
    if (ann.rect) return { x: ann.rect.x, y: ann.rect.y, w: ann.rect.w, h: ann.rect.h };
    if (Array.isArray(ann.points)) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of ann.points) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
        if (Number.isFinite(minX)) return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    if (ann.kind === 'text' && ann.rect) {
        return { x: ann.rect.x, y: ann.rect.y, w: ann.rect.w || 40, h: ann.rect.h || (ann.style?.fontSize || 14) * 1.4 };
    }
    return { x: 0, y: 0, w: 0, h: 0 };
}

/** Text annotation compat: keep legacy x/y/w fields if present. */
export function annotationAnchor(ann) {
    if (ann.kind === 'text' && ann.rect) return { x: ann.rect.x, y: ann.rect.y };
    return { x: 0, y: 0 };
}

const isFiniteNum = v => typeof v === 'number' && Number.isFinite(v);

/** Structural validation of a single annotation. Returns error strings (empty = ok). */
export function validateAnnotation(ann, index = 0) {
    const errors = [];
    if (!ann || typeof ann !== 'object') return [`annotations[${index}] is not an object`];
    if (!Number.isInteger(ann.page) || ann.page < 1) errors.push(`annotations[${index}].page must be a positive integer`);
    if (!ANNOTATION_KINDS.includes(ann.kind)) errors.push(`annotations[${index}].kind is unknown: "${ann.kind}"`);
    if (ann.rect) {
        if (!isFiniteNum(ann.rect.x) || !isFiniteNum(ann.rect.y)
            || !isFiniteNum(ann.rect.w) || !isFiniteNum(ann.rect.h)) {
            errors.push(`annotations[${index}].rect must be {x,y,w,h} finite numbers`);
        }
    }
    if (ann.points != null) {
        if (!Array.isArray(ann.points) || ann.points.length === 0
            || !ann.points.every(p => Array.isArray(p) && p.length === 2 && isFiniteNum(p[0]) && isFiniteNum(p[1]))) {
            errors.push(`annotations[${index}].points must be an array of [x,y] pairs`);
        }
    }
    if (ann.style != null && typeof ann.style !== 'object') {
        errors.push(`annotations[${index}].style must be an object`);
    }
    return errors;
}

/**
 * Normalize an annotations array coming from an imported gx-doc: drop entries
 * that fail validation (they are unknown/future kinds and must not brick the
 * round-trip), keep the rest as-is. Pure.
 */
export function normalizeAnnotations(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((ann, i) => validateAnnotation(ann, i).length === 0);
}

/** Ensure a gx-doc object has a valid annotations array (mutates doc). */
export function ensureGxDocAnnotations(doc) {
    if (!doc || typeof doc !== 'object') return;
    if (!Array.isArray(doc.annotations)) doc.annotations = [];
}

export function annotationsFromGxDoc(doc) {
    if (!doc || !Array.isArray(doc.annotations)) return [];
    return normalizeAnnotations(doc.annotations);
}
