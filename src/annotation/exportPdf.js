/**
 * exportPdf.js
 * Vector PDF export of the SPATIAL document: the original PDF pages plus the
 * annotation layer, drawn as vector graphics via pdf-lib.
 *
 * The original pages are copied with pdf-lib's copyPages, so the output keeps
 * the native text layer, bookmarks and structure. Annotations are drawn on
 * top in PDF user space (bottom-left origin, y up). Annotation coordinates
 * are stored in display space (top-left, y down), so every point is mapped
 * through geometry.viewportToUserSpace, which is rotation-aware and verified
 * against pdf.js.
 *
 * Offline, deterministic, no print dialog.
 */

import { PDFDocument, rgb, StandardFonts, BlendMode } from 'pdf-lib';
import { viewportToUserSpace } from './geometry.js';
import { annotationsFromGxDoc } from './annotations.js';

/** '#rrggbb' → {r,g,b} in [0,1]. Unknown/empty → black. */
function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return { r: 0, g: 0, b: 0 };
    const n = parseInt(m[1], 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function color(hex, opacity = 1) {
    const { r, g, b } = hexToRgb(hex);
    const col = rgb(r, g, b);
    return { col, opacity: Math.max(0, Math.min(1, opacity)) };
}

/** Map a display-space rect to an axis-aligned user-space rect. */
function rectToUser(rect, rotation, mediaW, mediaH) {
    const a = viewportToUserSpace({ x: rect.x, y: rect.y }, rotation, mediaW, mediaH);
    const b = viewportToUserSpace({ x: rect.x + rect.w, y: rect.y + rect.h }, rotation, mediaW, mediaH);
    return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x),
        h: Math.abs(b.y - a.y),
    };
}

function pointsToUser(pts, rotation, mediaW, mediaH) {
    return pts.map(p => viewportToUserSpace({ x: p[0], y: p[1] }, rotation, mediaW, mediaH));
}

/** Build a pdf-lib SVG path string for a stroke (or fill) polyline. */
function polylinePath(userPts, close = false) {
    if (!userPts.length) return '';
    const d = userPts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' ');
    return close ? `${d} Z` : d;
}

const SMOOTH_TOL = 0.5; // points; ink points already smoothed at draw time

/** Draw a single annotation onto a copied pdf-lib page. */
function drawAnnotation(page, ann, rotation, mediaW, mediaH, font) {
    const st = ann.style || {};
    const toUser = p => viewportToUserSpace(p, rotation, mediaW, mediaH);

    switch (ann.kind) {
        case 'highlight': {
            const { col, opacity } = color(st.color || '#ffeb3b', st.opacity ?? 0.4);
            if (ann.rect) {
                const r = rectToUser(ann.rect, rotation, mediaW, mediaH);
                page.drawRectangle({
                    x: r.x, y: r.y, width: r.w, height: r.h,
                    color: col, opacity, blendMode: BlendMode.Multiply,
                });
            } else if (ann.points?.length) {
                const pts = pointsToUser(ann.points, rotation, mediaW, mediaH);
                page.drawSvgPath(polylinePath(pts, true), {
                    color: col, opacity, blendMode: BlendMode.Multiply,
                });
            }
            break;
        }
        case 'rect': {
            const { col, opacity } = color(st.color || '#1565c0', st.opacity ?? 1);
            const r = rectToUser(ann.rect, rotation, mediaW, mediaH);
            page.drawRectangle({
                x: r.x, y: r.y, width: r.w, height: r.h,
                borderColor: col, borderWidth: st.strokeWidth || 2, opacity,
            });
            break;
        }
        case 'ellipse': {
            const { col, opacity } = color(st.color || '#1565c0', st.opacity ?? 1);
            const r = rectToUser(ann.rect, rotation, mediaW, mediaH);
            page.drawEllipse({
                x: r.x + r.w / 2, y: r.y + r.h / 2, xScale: r.w / 2, yScale: r.h / 2,
                borderColor: col, borderWidth: st.strokeWidth || 2, opacity,
            });
            break;
        }
        case 'arrow': {
            const { col, opacity } = color(st.color || '#e11d48', st.opacity ?? 1);
            const from = toUser({ x: ann.rect.x, y: ann.rect.y });
            const to = toUser({ x: ann.rect.x + ann.rect.w, y: ann.rect.y + ann.rect.h });
            const lw = st.strokeWidth || 2;
            page.drawLine({ start: from, end: to, thickness: lw, color: col, opacity });
            // Arrow head: two short lines converging at `to`.
            const ang = Math.atan2(to.y - from.y, to.x - from.x);
            const hl = Math.max(6, lw * 4);
            const a = Math.PI / 6;
            const h1 = { x: to.x - hl * Math.cos(ang - a), y: to.y - hl * Math.sin(ang - a) };
            const h2 = { x: to.x - hl * Math.cos(ang + a), y: to.y - hl * Math.sin(ang + a) };
            page.drawLine({ start: to, end: h1, thickness: lw, color: col, opacity });
            page.drawLine({ start: to, end: h2, thickness: lw, color: col, opacity });
            break;
        }
        case 'ink': {
            if (!ann.points?.length) break;
            const { col, opacity } = color(st.color || '#e11d48', st.opacity ?? 1);
            const pts = pointsToUser(ann.points, rotation, mediaW, mediaH);
            page.drawSvgPath(polylinePath(pts, false), {
                borderColor: col, borderWidth: st.strokeWidth || 2, opacity,
            });
            break;
        }
        case 'text': {
            const { col, opacity } = color(st.color || '#111111', st.opacity ?? 1);
            const fs = st.fontSize || 14;
            const anchor = toUser({ x: ann.rect.x, y: ann.rect.y + fs * 0.8 });
            page.drawText(String(ann.text || ''), {
                x: anchor.x, y: anchor.y, size: fs, font, color: col, opacity,
            });
            break;
        }
        case 'measure': {
            const { col, opacity } = color(st.color || '#7b1fa2', st.opacity ?? 1);
            const from = toUser({ x: ann.rect.x, y: ann.rect.y });
            const to = toUser({ x: ann.rect.x + ann.rect.w, y: ann.rect.y + ann.rect.h });
            const lw = st.strokeWidth || 1.5;
            page.drawLine({ start: from, end: to, thickness: lw, color: col, opacity });
            if (ann.label) {
                const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
                page.drawText(String(ann.label), {
                    x: mid.x, y: mid.y + 4, size: Math.max(8, (st.fontSize || 12)), font, color: col, opacity,
                });
            }
            break;
        }
    }
}

/**
 * Export the annotated spatial document as a new PDF.
 * @param {object} opts
 *   bytes — Uint8Array of the original PDF file
 *   gxDoc — gx-doc/1 document carrying `annotations`
 *   fileName — download name
 * @returns {Promise<Uint8Array>} the exported PDF bytes
 */
export async function buildAnnotatedPdf({ bytes, gxDoc, onPage }) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const font = await out.embedFont(StandardFonts.Helvetica);
    const annotations = annotationsFromGxDoc(gxDoc);
    const byPage = new Map();
    for (const ann of annotations) {
        if (!byPage.has(ann.page)) byPage.set(ann.page, []);
        byPage.get(ann.page).push(ann);
    }

    for (let i = 0; i < src.getPageCount(); i++) {
        if (onPage) onPage(i + 1, src.getPageCount());
        const [page] = await out.copyPages(src, [i]);
        const outPage = out.addPage(page);
        const list = byPage.get(i + 1);
        if (list && list.length) {
            const size = outPage.getSize();       // unrotated MediaBox dims
            const rotation = outPage.getRotation().angle; // 0/90/180/270
            for (const ann of list) {
                try {
                    drawAnnotation(outPage, ann, rotation, size.width, size.height, font);
                } catch (err) {
                    console.warn('[exportPdf] skipped annotation', ann.id, err.message);
                }
            }
        }
    }
    return out.save();
}

/** Convenience: build + trigger a browser download. */
export async function exportAnnotatedPdf({ bytes, gxDoc, fileName, onStatus }) {
    const out = await buildAnnotatedPdf({ bytes, gxDoc, onPage: (p, n) => {
        if (onStatus && p % 5 === 0) onStatus(`Building PDF… page ${p}/${n}`);
    } });
    const blob = new Blob([out], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
    return out;
}
