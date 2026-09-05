// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// ctmAdapter.js
// Converts a PDF.js operator list into SubpathRecords for the pathReconciler.
//
// Output also carries operator-native text paints so paths, images and text
// retain one PDF.js display-list provenance chain.

function mulMatrix(a, b) {
    return [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ];
}

function applyMatrix(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function extractSubpaths(opList, viewport, OPS) {
    const { fnArray, argsArray } = opList;
    const vpTransform = viewport.transform;
    const identity = [1, 0, 0, 1, 0, 0];
    const ctmStack = [identity.slice()];
    let ctm = identity.slice();

    let subpathIdCounter = 0;
    let constructPathIdCounter = 0;

    let strokeWidth = 1;
    let fillColor = [0, 0, 0];
    let strokeColor = [0, 0, 0];
    const colorStateStack = [{ fill: fillColor.slice(), stroke: strokeColor.slice() }];

    let currentSubpath = { segs: [], curves: [] };
    const pendingPaintSubpaths = new Set();

    const subpaths = [];
    const imageMeta = [];
    const filledRects = [];
    const textPaintOps = [];
    const displayList = [];
    let fontName = null, fontSize = 0, textRenderingMode = 0;
    let charSpacing = 0, wordSpacing = 0, horizontalScale = 100, textRise = 0;
    let textMatrix = identity.slice();
    const textStateStack = [];

    const glyphText = glyphs => (glyphs || []).map(g =>
        typeof g === 'string' ? g : (g?.unicode || (g?.isSpace ? ' ' : ''))
    ).join('');
    const recordText = (operatorIndex, glyphs) => {
        const record = {
            id: `textpaint_${textPaintOps.length}`,
            kind: 'TEXT_PAINT', operatorIndex,
            text: glyphText(glyphs), glyphs,
            ctm: ctm.slice(), textMatrix: textMatrix.slice(),
            viewportMatrix: mulMatrix(vpTransform, mulMatrix(ctm, textMatrix)),
            fontName, fontSize, textRenderingMode,
            charSpacing, wordSpacing, horizontalScale, textRise,
            fillColor: fillColor.slice(), strokeColor: strokeColor.slice(),
        };
        textPaintOps.push(record);
        displayList.push(record);
    };

    const openSubpath = (constructPathId) => {
        if (currentSubpath.segs.length > 0 || currentSubpath.curves.length > 0) {
            subpaths.push(currentSubpath);
        }
        currentSubpath = {
            segs: [],
            curves: [],
            closed: false,
            filled: false,
            strokeWidth,
            strokeColor: strokeColor.slice(),
            fillColor: fillColor.slice(),
            constructPathId,
            ctm: ctm.slice(), // Capture CTM for the reconciler
            id: subpathIdCounter++
        };
        pendingPaintSubpaths.add(currentSubpath);
    };

    // Open the first initial subpath
    openSubpath(null);

    let pendingX = 0, pendingY = 0; // viewport space for closePath correctness
    let rawPendingX = 0, rawPendingY = 0; // pdf space for segment buffering
    let subpathStartX = 0, subpathStartY = 0; // pdf space
    let pendingRect = null;

    const bufferSeg = (ax, ay, bx, by) => {
        currentSubpath.segs.push({ ax, ay, bx, by });
    };

    const toViewport = (pdfX, pdfY) => {
        const [cx, cy] = applyMatrix(ctm, pdfX, pdfY);
        return [
            vpTransform[0] * cx + vpTransform[2] * cy + vpTransform[4],
            vpTransform[1] * cx + vpTransform[3] * cy + vpTransform[5],
        ];
    };

    const addRect = (rx, ry, rw, rh, constructPathId = null) => {
        openSubpath(constructPathId);
        bufferSeg(rx, ry, rx + rw, ry);
        bufferSeg(rx + rw, ry, rx + rw, ry + rh);
        bufferSeg(rx + rw, ry + rh, rx, ry + rh);
        bufferSeg(rx, ry + rh, rx, ry);
        
        const [x1, y1] = toViewport(rx, ry);
        const [x2, y2] = toViewport(rx + rw, ry + rh);
        const left = Math.min(x1, x2), right = Math.max(x1, x2);
        const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
        
        pendingRect = { x: left, y: top, w: right - left, h: bottom - top, fillColor: fillColor.slice() };

        rawPendingX = rx; rawPendingY = ry;
        const [vx, vy] = toViewport(rx, ry);
        pendingX = vx; pendingY = vy;
    };

    const processSubOps = (subOps, subArgs, constructPathId) => {
        let ai = 0;
        for (let j = 0; j < subOps.length; j++) {
            const sf = subOps[j];
            if (sf === OPS.moveTo) {
                openSubpath(constructPathId);
                rawPendingX = subArgs[ai]; rawPendingY = subArgs[ai + 1];
                subpathStartX = rawPendingX; subpathStartY = rawPendingY;
                const [x, y] = toViewport(rawPendingX, rawPendingY);
                pendingX = x; pendingY = y;
                ai += 2;
            } else if (sf === OPS.lineTo) {
                bufferSeg(rawPendingX, rawPendingY, subArgs[ai], subArgs[ai + 1]);
                rawPendingX = subArgs[ai]; rawPendingY = subArgs[ai + 1];
                const [x, y] = toViewport(rawPendingX, rawPendingY);
                pendingX = x; pendingY = y;
                ai += 2;
            } else if (sf === OPS.rectangle) {
                addRect(subArgs[ai], subArgs[ai + 1], subArgs[ai + 2], subArgs[ai + 3], constructPathId);
                ai += 4;
            } else if (sf === OPS.curveTo) {
                currentSubpath.curves.push({
                    p0: [rawPendingX, rawPendingY],
                    p1: [subArgs[ai], subArgs[ai+1]],
                    p2: [subArgs[ai+2], subArgs[ai+3]],
                    p3: [subArgs[ai+4], subArgs[ai+5]]
                });
                rawPendingX = subArgs[ai+4]; rawPendingY = subArgs[ai+5];
                const [x, y] = toViewport(rawPendingX, rawPendingY);
                pendingX = x; pendingY = y;
                ai += 6;
            } else if (sf === OPS.curveTo2) {
                currentSubpath.curves.push({
                    p0: [rawPendingX, rawPendingY],
                    p1: [rawPendingX, rawPendingY],
                    p2: [subArgs[ai], subArgs[ai+1]],
                    p3: [subArgs[ai+2], subArgs[ai+3]]
                });
                rawPendingX = subArgs[ai+2]; rawPendingY = subArgs[ai+3];
                const [x, y] = toViewport(rawPendingX, rawPendingY);
                pendingX = x; pendingY = y;
                ai += 4;
            } else if (sf === OPS.curveTo3) {
                currentSubpath.curves.push({
                    p0: [rawPendingX, rawPendingY],
                    p1: [subArgs[ai], subArgs[ai+1]],
                    p2: [subArgs[ai+2], subArgs[ai+3]],
                    p3: [subArgs[ai+2], subArgs[ai+3]]
                });
                rawPendingX = subArgs[ai+2]; rawPendingY = subArgs[ai+3];
                const [x, y] = toViewport(rawPendingX, rawPendingY);
                pendingX = x; pendingY = y;
                ai += 4;
            } else if (sf === OPS.closePath) {
                bufferSeg(rawPendingX, rawPendingY, subpathStartX, subpathStartY);
                rawPendingX = subpathStartX; rawPendingY = subpathStartY;
                const [x, y] = toViewport(subpathStartX, subpathStartY);
                pendingX = x; pendingY = y;
                currentSubpath.closed = true;
            }
        }
    };

    for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i];
        const args = argsArray[i];

        switch (fn) {
            case OPS.save:
                ctmStack.push(ctm.slice());
                colorStateStack.push({ fill: fillColor.slice(), stroke: strokeColor.slice() });
                textStateStack.push({ fontName, fontSize, textRenderingMode, charSpacing, wordSpacing, horizontalScale, textRise, textMatrix: textMatrix.slice() });
                break;
            case OPS.restore:
                ctm = ctmStack.length > 1 ? ctmStack.pop() : identity.slice();
                if (colorStateStack.length > 1) {
                    const cs = colorStateStack.pop();
                    fillColor = cs.fill; strokeColor = cs.stroke;
                }
                if (textStateStack.length) {
                    const ts = textStateStack.pop();
                    ({ fontName, fontSize, textRenderingMode, charSpacing, wordSpacing, horizontalScale, textRise } = ts);
                    textMatrix = ts.textMatrix;
                }
                break;
            case OPS.transform:
                ctm = mulMatrix(ctm, args);
                break;
            case OPS.beginText: textMatrix = identity.slice(); break;
            case OPS.setFont: fontName = args[0]; fontSize = args[1]; break;
            case OPS.setCharSpacing: charSpacing = args[0]; break;
            case OPS.setWordSpacing: wordSpacing = args[0]; break;
            case OPS.setHScale: horizontalScale = args[0]; break;
            case OPS.setTextRise: textRise = args[0]; break;
            case OPS.setTextRenderingMode: textRenderingMode = args[0]; break;
            case OPS.setTextMatrix: textMatrix = args.slice(0, 6); break;
            case OPS.moveText:
            case OPS.setLeadingMoveText:
                textMatrix = mulMatrix(textMatrix, [1, 0, 0, 1, args[0], args[1]]);
                break;
            case OPS.showText:
            case OPS.showSpacedText:
            case OPS.nextLineShowText:
            case OPS.nextLineSetSpacingShowText:
                recordText(i, [...args].reverse().find(Array.isArray) || args);
                break;
            case OPS.setLineWidth:
                strokeWidth = args[0];
                break;
            case OPS.setFillGray:
                fillColor = [args[0], args[0], args[0]];
                break;
            case OPS.setFillRGBColor:
                fillColor = [args[0], args[1], args[2]];
                break;
            case OPS.setFillCMYKColor: {
                const [c, m, y, k] = args;
                fillColor = [(1-c)*(1-k), (1-m)*(1-k), (1-y)*(1-k)];
                break;
            }
            case OPS.setFillColor:
            case OPS.setFillColorN:
                if (args.length === 1) fillColor = [args[0], args[0], args[0]];
                else if (args.length >= 3) fillColor = [args[0], args[1], args[2]];
                break;
            case OPS.setStrokeGray:
                strokeColor = [args[0], args[0], args[0]];
                break;
            case OPS.setStrokeRGBColor:
                strokeColor = [args[0], args[1], args[2]];
                break;
            case OPS.setStrokeCMYKColor: {
                const [c, m, y, k] = args;
                strokeColor = [(1-c)*(1-k), (1-m)*(1-k), (1-y)*(1-k)];
                break;
            }
            case OPS.setStrokeColor:
            case OPS.setStrokeColorN:
                if (args.length === 1) strokeColor = [args[0], args[0], args[0]];
                else if (args.length >= 3) strokeColor = [args[0], args[1], args[2]];
                break;
            case OPS.fill:
            case OPS.eoFill:
            case OPS.fillStroke:
            case OPS.eoFillStroke:
            case OPS.closeFillStroke:
            case OPS.closeEOFillStroke:
                for (const path of pendingPaintSubpaths) path.filled = true;
                // `operatorIndex` is the rect's Z-ORDER. PDF content streams paint
                // in operator order, so a fill whose index is greater than a text
                // paint's was painted OVER that text. Without it a consumer cannot
                // tell a redaction box from a table-cell shade — they are the same
                // rectangle, distinguished only by when they were drawn.
                // (forensics/overlays.js is the consumer; every other field here
                // was already present and nothing reads a positional index.)
                if (pendingRect) { filledRects.push({ ...pendingRect, operatorIndex: i }); }
                displayList.push({ kind: 'PATH_PAINT', operatorIndex: i, paintOperator: fn,
                    subpathId: currentSubpath.id, ctm: ctm.slice(), fillColor: fillColor.slice(),
                    strokeColor: strokeColor.slice(), strokeWidth });
                pendingRect = null;
                pendingPaintSubpaths.clear();
                break;
            case OPS.stroke:
            case OPS.closeStrokePath:
                displayList.push({ kind: 'PATH_PAINT', operatorIndex: i, paintOperator: fn,
                    subpathId: currentSubpath.id, ctm: ctm.slice(), fillColor: null,
                    strokeColor: strokeColor.slice(), strokeWidth });
                pendingRect = null;
                pendingPaintSubpaths.clear();
                break;
            case OPS.moveTo: {
                openSubpath(null);
                rawPendingX = args[0]; rawPendingY = args[1];
                subpathStartX = rawPendingX; subpathStartY = rawPendingY;
                const [x, y] = toViewport(rawPendingX, rawPendingY);
                pendingX = x; pendingY = y;
                break;
            }
            case OPS.lineTo: {
                bufferSeg(rawPendingX, rawPendingY, args[0], args[1]);
                rawPendingX = args[0]; rawPendingY = args[1];
                const [x, y] = toViewport(rawPendingX, rawPendingY);
                pendingX = x; pendingY = y;
                break;
            }
            case OPS.rectangle:
                addRect(args[0], args[1], args[2], args[3]);
                break;
            case OPS.constructPath:
                processSubOps(args[0], args[1], constructPathIdCounter++);
                break;
            case OPS.closePath: {
                bufferSeg(rawPendingX, rawPendingY, subpathStartX, subpathStartY);
                rawPendingX = subpathStartX; rawPendingY = subpathStartY;
                const [cpx, cpy] = toViewport(subpathStartX, subpathStartY);
                pendingX = cpx; pendingY = cpy;
                currentSubpath.closed = true;
                break;
            }
            case OPS.paintImageXObject:
            case OPS.paintJpegXObject: {
                // args[0] is the XObject name string (e.g. "img_p2_7")
                const imgId = args[0];
                if (typeof imgId !== 'string') break;
                const [x1, y1] = toViewport(0, 0);
                const [x2, y2] = toViewport(1, 1);
                const left = Math.min(x1, x2), right = Math.max(x1, x2);
                const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
                // Record whether the placement is axis-aligned (no rotation or
                // skew: b and c of the CTM are zero). The bbox derived from the
                // unit-square corners is only meaningful when it is, and a
                // consumer that wants to substitute the DECODED image for a
                // rendered crop must not do so for a rotated placement — the
                // decoded pixels carry no rotation.
                const axisAligned = Math.abs(ctm[1]) < 1e-6 && Math.abs(ctm[2]) < 1e-6;
                imageMeta.push({
                    id: imgId,
                    bbox: { x: left, y: top, w: right - left, h: bottom - top },
                    inline: false,
                    axisAligned,
                });
                displayList.push({ kind: 'IMAGE_PAINT', operatorIndex: i, imageId: imgId, ctm: ctm.slice() });
                break;
            }
            case OPS.paintImageMaskXObject: {
                // args[0] is an image dict object { data, count }, not an ID string.
                // Treat like inline — assign a synthetic ID and crop from canvas.
                const [x1, y1] = toViewport(0, 0);
                const [x2, y2] = toViewport(1, 1);
                const left = Math.min(x1, x2), right = Math.max(x1, x2);
                const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
                if (right - left > 8 && bottom - top > 8) {
                    imageMeta.push({
                        id: `mask_${imageMeta.length}`,
                        bbox: { x: left, y: top, w: right - left, h: bottom - top },
                        inline: true,
                    });
                }
                break;
            }
            case OPS.paintInlineImageXObject: {
                // Inline images live in the op-list, not in page.objs.
                // Assign a synthetic ID; the geometry worker will crop the bbox from the rendered canvas.
                const [x1, y1] = toViewport(0, 0);
                const [x2, y2] = toViewport(1, 1);
                const left = Math.min(x1, x2), right = Math.max(x1, x2);
                const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
                if (right - left > 8 && bottom - top > 8) {
                    imageMeta.push({
                        id: `inline_${imageMeta.length}`,
                        bbox: { x: left, y: top, w: right - left, h: bottom - top },
                        inline: true,
                    });
                }
                break;
            }
            default:
                break;
        }
    }

    if (currentSubpath.segs.length > 0 || currentSubpath.curves.length > 0) {
        subpaths.push(currentSubpath);
    }

    return { subpaths, imageMeta, filledRects, textPaintOps, displayList };
}

export function linkTextPaintOps(textItems, textPaintOps) {
    let cursor = 0;
    return (textItems || []).map(item => {
        const wanted = (item.str || '').replace(/\s+/g, ' ').trim();
        let match = null;
        for (let i = cursor; i < (textPaintOps || []).length; i++) {
            const got = (textPaintOps[i].text || '').replace(/\s+/g, ' ').trim();
            if (!wanted || !got || got === wanted || got.includes(wanted) || wanted.includes(got)) {
                match = textPaintOps[i]; cursor = i + 1; break;
            }
        }
        return match ? { ...item, paintOpId: match.id, paintOperatorIndex: match.operatorIndex } : item;
    });
}

/** Project operator-native paths into one detected figure's viewport box. */
export function vectorPathsForRegion(subpaths, viewport, bbox, textMeta = []) {
    if (!bbox) return [];
    const vp = viewport.transform;
    const project = (sp, p) => {
        const q = applyMatrix(sp.ctm, p[0], p[1]);
        return applyMatrix(vp, q[0], q[1]);
    };
    const bounds = pts => {
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    };
    const out = [];
    for (const sp of subpaths || []) {
        const commands = [];
        const points = [];
        for (const s of sp.segs || []) {
            const a = project(sp, [s.ax, s.ay]), b = project(sp, [s.bx, s.by]);
            points.push(a, b);
            commands.push(['M', a[0] - bbox.x, a[1] - bbox.y], ['L', b[0] - bbox.x, b[1] - bbox.y]);
        }
        for (const c of sp.curves || []) {
            const p0 = project(sp, c.p0), p1 = project(sp, c.p1);
            const p2 = project(sp, c.p2), p3 = project(sp, c.p3);
            points.push(p0, p1, p2, p3);
            commands.push(['M', p0[0] - bbox.x, p0[1] - bbox.y],
                ['C', p1[0] - bbox.x, p1[1] - bbox.y, p2[0] - bbox.x, p2[1] - bbox.y, p3[0] - bbox.x, p3[1] - bbox.y]);
        }
        if (!points.length) continue;
        const pb = bounds(points);
        // Do not admit a page rule merely because it crosses the figure box.
        if (pb.x0 < bbox.x - 4 || pb.y0 < bbox.y - 4 ||
            pb.x1 > bbox.x + bbox.w + 4 || pb.y1 > bbox.y + bbox.h + 4) continue;
        // Type3/custom glyphs may be emitted as path outlines as well as text.
        // The linked semantic run owns that small area, so retaining both would
        // draw duplicate labels.
        const isGlyphOutline = textMeta.some(tm => {
            if (!tm.str?.trim()) return false;
            const tx0 = tm.vx - 2, tx1 = tm.vx + (tm.vWidth || 0) + 2;
            const vf = tm.vFont || 10;
            const ty0 = tm.vy - vf * 1.5 - 2, ty1 = tm.vy + vf * 0.7 + 2;
            return pb.x0 >= tx0 && pb.x1 <= tx1 && pb.y0 >= ty0 && pb.y1 <= ty1;
        });
        if (isGlyphOutline) continue;
        if (sp.closed) commands.push(['Z']);
        out.push({
            commands, filled: !!sp.filled, closed: !!sp.closed,
            fillColor: sp.fillColor, strokeColor: sp.strokeColor,
            strokeWidth: sp.strokeWidth || 1,
        });
    }
    return out;
}
