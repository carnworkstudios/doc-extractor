/**
 * exportPdf.js
 * Vector PDF export of the SPATIAL document: the original PDF pages plus the
 * annotation layer, drawn as vector graphics via pdf-lib.
 *
 * The original pages are copied with pdf-lib's copyPages, so the output keeps
 * the native text layer and page structure. copyPages does NOT carry the
 * outline, so bookmarks are rebuilt from gxDoc.bookmarks. Annotations are drawn on
 * top in PDF user space (bottom-left origin, y up). Annotation coordinates
 * are stored in display space (top-left, y down), so every point is mapped
 * through geometry.viewportToUserSpace, which is rotation-aware and verified
 * against pdf.js.
 *
 * Offline, deterministic, no print dialog.
 */

import { PDFDocument, rgb, StandardFonts, BlendMode, PDFString, PDFName } from 'pdf-lib';
import { viewportToUserSpace } from './geometry.js';
import { annotationsFromGxDoc } from './annotations.js';

/**
 * Write gxDoc.bookmarks as a real PDF outline (/Outlines tree).
 *
 * pdf-lib's copyPages copies PAGE objects. It does NOT carry the source
 * document's outline, and it has no outline API, so the tree is built by hand
 * from the gx-doc bookmarks — which is the right source anyway, since the user
 * edits those in the Bookmarks panel.
 *
 * Each entry is a /GoTo destination onto the page it names: [pageRef /XYZ 0 h 0]
 * (top-left of the page, inherit zoom).
 */
function embedOutline(out, bookmarks, pages) {
    const entries = bookmarks
        .map(bm => ({
            title: String(bm.label || `Page ${bm.page || 1}`),
            pageIndex: Math.max(0, Math.min(pages.length - 1, (bm.page || 1) - 1)),
        }))
        .filter(e => pages[e.pageIndex]);
    if (!entries.length) return;

    const rootRef = out.context.nextRef();
    const itemRefs = entries.map(() => out.context.nextRef());

    entries.forEach((entry, i) => {
        const page = pages[entry.pageIndex];
        const { height } = page.getSize();
        const dict = {
            Title: PDFString.of(entry.title),
            Parent: rootRef,
            Dest: out.context.obj([page.ref, 'XYZ', 0, height, 0]),
        };
        if (i > 0) dict.Prev = itemRefs[i - 1];
        if (i < entries.length - 1) dict.Next = itemRefs[i + 1];
        out.context.assign(itemRefs[i], out.context.obj(dict));
    });

    out.context.assign(rootRef, out.context.obj({
        Type: 'Outlines',
        First: itemRefs[0],
        Last: itemRefs[itemRefs.length - 1],
        Count: itemRefs.length,
    }));
    out.catalog.set(PDFName.of('Outlines'), rootRef);
    // Ask viewers to open with the bookmark pane showing — otherwise a user who
    // exported bookmarks sees no evidence they survived.
    out.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

/** Embed a native PDF link annotation (/Subtype /Link) via pdf-lib */
function embedLinkAnnotation(out, outPage, link, rotation, mediaW, mediaH) {
    if (!link.rect) return;
    const r = rectToUser(link.rect, rotation, mediaW, mediaH);

    let actionObj = null;
    const href = String(link.href || '').trim();

    if (link.isExternal || href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
        actionObj = out.context.obj({
            Type: 'Action',
            S: 'URI',
            URI: PDFString.of(href),
        });
    } else {
        const match = href.match(/page[=\-]?(\d+)/i) || href.match(/(\d+)/);
        const targetPageNum = match ? parseInt(match[1], 10) : 1;
        actionObj = out.context.obj({
            Type: 'Action',
            S: 'GoTo',
            D: PDFString.of(`page_${targetPageNum}`),
        });
    }

    const linkAnnot = out.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [r.x, r.y, r.x + r.w, r.y + r.h],
        Border: [0, 0, 0],
        A: actionObj,
    });

    const linkAnnotRef = out.context.register(linkAnnot);
    outPage.node.addAnnot(linkAnnotRef);
}

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
            // Baseline offset applied in display space (y-down) BEFORE the
            // coordinate transform, so the y-flip handles direction correctly
            // regardless of page rotation.
            const baselineY = ann.rect.y + fs * 0.8;
            const anchor = toUser({ x: ann.rect.x, y: baselineY });
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
 * Replay one text edit from the edit-text surface.
 *
 * pdf-lib cannot rewrite a glyph run in place, so an edit is cover-then-draw:
 * paint the original box out in the page background colour, then draw the new
 * string at the original baseline. The box comes from pdf.js's own text-item
 * geometry (see pdfTextEdit.js), so it covers exactly what was there.
 *
 * `to === ''` is a deletion — cover only, draw nothing.
 */
function drawTextEdit(page, edit, rotation, mediaW, mediaH, font, bg) {
    const fs = edit.fontSize || edit.h || 12;
    const pad = fs * 0.25;
    const box = {
        x: edit.x - pad,
        y: edit.y - pad,
        w: Math.max(edit.w, fs * 0.5) + pad * 2,
        h: (edit.h || fs) + pad * 2,
    };
    const r = rectToUser(box, rotation, mediaW, mediaH);
    page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: bg });

    const text = String(edit.to ?? '');
    if (!text) return;

    // Baseline offset applied in display space (y-down) BEFORE the transform,
    // so the y-flip handles direction correctly under any page rotation.
    const anchor = viewportToUserSpace(
        { x: edit.x, y: edit.y + fs * 0.8 }, rotation, mediaW, mediaH,
    );
    page.drawText(text, { x: anchor.x, y: anchor.y, size: fs, font, color: rgb(0, 0, 0) });
}

/**
 * Export the annotated spatial document as a new PDF.
 * @param {object} opts
 *   bytes — Uint8Array of the original PDF file
 *   gxDoc — gx-doc/1 document carrying `annotations` and `textEdits`
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

    // Text edits are replayed BEFORE annotations so a highlight drawn over an
    // edited word still lands on top of the replacement, not under the cover.
    const editsByPage = new Map();
    if (Array.isArray(gxDoc?.textEdits)) {
        for (const edit of gxDoc.textEdits) {
            const p = edit.page || 1;
            if (!editsByPage.has(p)) editsByPage.set(p, []);
            editsByPage.get(p).push(edit);
        }
    }
    const editBg = rgb(1, 1, 1);

    const linksByPage = new Map();
    if (Array.isArray(gxDoc?.links)) {
        for (const link of gxDoc.links) {
            const p = link.page || 1;
            if (!linksByPage.has(p)) linksByPage.set(p, []);
            linksByPage.get(p).push(link);
        }
    }

    for (let i = 0; i < src.getPageCount(); i++) {
        if (onPage) onPage(i + 1, src.getPageCount());
        const [page] = await out.copyPages(src, [i]);
        const outPage = out.addPage(page);

        const pageEdits = editsByPage.get(i + 1);
        if (pageEdits && pageEdits.length) {
            const size = outPage.getSize();
            const rotation = outPage.getRotation().angle;
            for (const edit of pageEdits) {
                try {
                    drawTextEdit(outPage, edit, rotation, size.width, size.height, font, editBg);
                } catch (err) {
                    console.warn('[exportPdf] skipped text edit', edit.from, err.message);
                }
            }
        }

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

        const pageLinks = linksByPage.get(i + 1);
        if (pageLinks && pageLinks.length) {
            const size = outPage.getSize();
            const rotation = outPage.getRotation().angle;
            for (const link of pageLinks) {
                try {
                    embedLinkAnnotation(out, outPage, link, rotation, size.width, size.height);
                } catch (err) {
                    console.warn('[exportPdf] skipped link annotation', link.id, err.message);
                }
            }
        }
    }

    if (Array.isArray(gxDoc?.bookmarks) && gxDoc.bookmarks.length) {
        try {
            embedOutline(out, gxDoc.bookmarks, out.getPages());
        } catch (err) {
            console.warn('[exportPdf] outline not written:', err.message);
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
