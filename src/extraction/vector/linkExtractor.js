/**
 * Link annotation extraction helpers.
 *
 * Pure, deterministic, framework-free: geometry-only in, geometry-only out.
 * The two entry points a worker uses are
 *
 *   readLinkAnnotations(annotations, viewport, pageNum)
 *     -> normalized link list (external url + internal dest→page resolution is
 *        done in the caller, which owns the pdf.js DOCUMENT object)
 *   associateLinks(links, textMeta)
 *     -> same list with `itemIndices` (textMeta positions) and `text` filled in
 *
 * The PDF → viewport mapping reuses the same corner-transform discipline as
 * externalScorer.bboxToViewport ('pdf-points'): a LinkAnnotation rect is two
 * opposite corners in PDF user space (y up, bottom-left origin), so mapping
 * both corners through the real viewport transform and renormalising is what
 * keeps the box on the right spot for a rotated page.
 */

import { bboxToViewport } from './externalScorer.js';

/** Drop anything a browser would execute or a scraper would trip over. */
export function sanitizeLinkUrl(url) {
    if (typeof url !== 'string' || !url.trim()) return null;
    const trimmed = url.trim();
    if (trimmed.length > 2048) return null;
    if (/^(javascript|vbscript|data|file):/i.test(trimmed)) return null;
    return trimmed;
}

/**
 * Map a pdf.js LinkAnnotation `rect` ([x1,y1,x2,y2], PDF user space) into
 * viewport space. Returns {x, y, w, h} or null for a degenerate rect.
 */
export function annotationRectToViewport(rect, viewport) {
    if (!Array.isArray(rect) || rect.length < 4) return null;
    const [x1, y1, x2, y2] = rect.map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    return bboxToViewport(
        { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) },
        'pdf-points',
        {
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
            vpTransform: viewport.transform,
        },
    );
}

/**
 * Resolve a pdf.js named/explicit destination to a 1-based page number.
 *
 * `doc` is the pdf.js DOCUMENT proxy, not a page: `getDestination` and
 * `getPageIndex` live on PDFDocumentProxy only. A page handle has neither, so
 * passing one silently resolved every internal link to null and dropped it.
 *
 * `dest` is whatever the annotation carried — a name ("G1509406"), an explicit
 * destination array ([ref, {name:'XYZ'}, x, y, z]), a bare page index, or an
 * object carrying pageNumber. Unresolvable destinations return null: a link
 * that cannot point at a page is useless.
 */
export async function resolveDestPage(doc, dest) {
    if (dest == null) return null;
    try {
        if (typeof dest === 'number') return dest;
        // Named destination: resolve through the document to the destination
        // array, then re-run against that array.
        if (typeof dest === 'string') {
            const resolved = doc && typeof doc.getDestination === 'function'
                ? await doc.getDestination(dest)
                : null;
            return resolved ? resolveDestPage(doc, resolved) : null;
        }
        if (typeof dest === 'object') {
            if (dest.pageNumber) return dest.pageNumber;
            if (dest[0] != null) {
                const ref = dest[0];
                // An explicit destination may store the target as a 0-based
                // page INDEX rather than a ref.
                if (typeof ref === 'number') return ref + 1;
                if (ref && typeof ref === 'object') {
                    // An already-resolved page reference carries its page number
                    // directly; a raw PDF ref needs the document to look it up.
                    if (ref.pageNumber) return ref.pageNumber;
                    if (ref.num != null && doc && typeof doc.getPageIndex === 'function') {
                        const idx = await doc.getPageIndex(ref);
                        return (Number.isFinite(idx) ? idx : -1) + 1;
                    }
                }
            }
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * pdf.js `AnnotationType.LINK` is **2**, not 1 (1 is TEXT — a sticky note).
 * Testing against 1 rejects every real link in the document, so the subtype
 * string is checked first and the numeric code is only the fallback for
 * annotation objects that carry no subtype.
 */
export const ANNOTATION_TYPE_LINK = 2;

export function isLinkAnnotation(ann) {
    if (!ann) return false;
    if (typeof ann.subtype === 'string') return ann.subtype === 'Link';
    return ann.annotationType === ANNOTATION_TYPE_LINK;
}

/**
 * Build the normalized link list from a page's annotations.
 *
 * @param {Array} annotations — result of page.getAnnotations({intent:'display'})
 * @param {object} viewport   — the same viewport text/regions were built with
 * @param {number} pageNum    — 1-based page number (for the message + anchors)
 * @returns {Array<object>} normalized links; the caller still needs to run
 *   associateLinks() against textMeta to attach covered items.
 */
export function readLinkAnnotations(annotations, viewport, pageNum) {
    const out = [];
    const seen = new Set();
    for (const ann of annotations || []) {
        if (!isLinkAnnotation(ann)) continue;
        const rect = annotationRectToViewport(ann.rect, viewport);
        if (!rect) continue;
        const url = typeof ann.url === 'string' && ann.url ? sanitizeLinkUrl(ann.url) : null;
        if (url) {
            const dedupe = `url:${url}:${rect.x}:${rect.y}`;
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);
            out.push({
                id: `link_${out.length}`,
                page: pageNum,
                kind: 'external',
                href: url,
                url,
                rect,
                itemIndices: [],
                text: '',
            });
        } else if (ann.dest != null) {
            // Internal destinations are resolved by the caller (needs the pdf.js
            // page/pdf handles), which sets href + destPage and pushes the link.
            out.push({
                id: `link_${out.length}`,
                page: pageNum,
                kind: 'internal',
                href: null,
                destPage: null,
                dest: ann.dest,
                rect,
                itemIndices: [],
                text: '',
            });
        }
    }
    return out;
}

function _intersects(a, b, slack) {
    return a.x - slack < b.x + b.w && a.x + a.w + slack > b.x &&
           a.y - slack < b.y + b.h && a.y + a.h + slack > b.y;
}

/**
 * The glyph box of a text item in viewport space.
 *
 * `vy` is the BASELINE, not the top of the box. A box hung downwards from the
 * baseline sits almost entirely in the gap below the line, so it hit-tests
 * against the line BELOW the one the reader sees — which is how a link over
 * "Fig. 8" ended up wrapping the previous line. Ascent is ~0.8em and descent
 * ~0.2em for the fonts these documents use.
 */
function _glyphBox(tm) {
    const font = tm.vFont || 12;
    return { x: tm.vx, y: tm.vy - 0.8 * font, w: tm.vWidth || 0, h: font };
}

/**
 * Character range of `tm.str` that a link rect covers horizontally.
 *
 * pdf.js frequently emits a whole line as ONE text item, so an item-level
 * match would turn a 70-character sentence into one giant <a> for a link that
 * only sits over "Fig. 8". The x range is converted to character offsets by
 * proportional interpolation, then snapped OUTWARD to word boundaries so a
 * partially covered word is fully linked.
 *
 * Returns null when the rect covers nothing of this item.
 */
export function linkCharRange(link, tm) {
    const str = tm.str || '';
    const w = tm.vWidth || 0;
    if (!str.length || w <= 0) return null;

    const r = link.rect;
    const relStart = (r.x - tm.vx) / w;
    const relEnd   = (r.x + r.w - tm.vx) / w;
    if (relEnd <= 0 || relStart >= 1) return null;

    // Floor/ceil rather than round: character widths are not uniform, so the
    // proportional estimate drifts by up to a character over a long line. One
    // character of slack on each side, then whitespace trimming, recovers the
    // real word boundaries — rounding tightly loses the "8" of "Fig. 8".
    let start = Math.max(0, Math.floor(relStart * str.length));
    let end   = Math.min(str.length, Math.ceil(relEnd * str.length));
    if (end <= start) return null;

    // Trim inward off whitespace FIRST, then grow outward through word
    // characters. Growing first would jump the space the rect stopped on and
    // swallow the neighbouring word.
    while (start < end && /\s/.test(str[start])) start++;
    while (end > start && /\s/.test(str[end - 1])) end--;
    if (end <= start) return null;
    while (start > 0 && !/\s/.test(str[start - 1])) start--;
    while (end < str.length && !/\s/.test(str[end])) end++;

    return { start, end };
}

/**
 * Attach the textMeta indices each link rect covers, plus the character span
 * inside each of those items. A link that sits over a region with no text (a
 * figure, a table) simply ends up with no itemIndices — the assembler falls
 * back to a data-link attribute on the region wrapper.
 */
export function associateLinks(links, textMeta) {
    const slack = 2;
    return (links || []).map(link => {
        const indices = [];
        const spans = [];
        for (let i = 0; i < textMeta.length; i++) {
            const tm = textMeta[i];
            if (!tm || !tm.str || !tm.str.trim()) continue;
            if (!_intersects(link.rect, _glyphBox(tm), slack)) continue;
            const range = linkCharRange(link, tm);
            if (!range) continue;
            indices.push(i);
            spans.push({ index: i, start: range.start, end: range.end });
        }
        const text = spans
            .map(s => textMeta[s.index].str.slice(s.start, s.end))
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        return { ...link, itemIndices: indices, spans, text };
    });
}

/**
 * Resolve internal links to their target page (worker-side, pdf.js in hand),
 * sanitize external urls, and drop whatever cannot be rendered. Returns a
 * fully normalized list ready for associateLinks().
 *
 * `doc` is the pdf.js DOCUMENT proxy — named destinations cannot be resolved
 * from a page handle.
 */
export async function finalizeLinks(annotations, viewport, pageNum, doc) {
    const links = readLinkAnnotations(annotations, viewport, pageNum);
    const out = [];
    for (const link of links) {
        if (link.kind === 'external') { out.push(link); continue; }
        const destPage = await resolveDestPage(doc, link.dest);
        if (destPage == null) continue;
        out.push({ ...link, href: `#page-${destPage}`, destPage });
    }
    return out;
}