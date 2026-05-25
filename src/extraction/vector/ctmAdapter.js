// ctmAdapter.js
// Converts a PDF.js operator list into SubpathRecords for the pathReconciler.
//
// Output: { subpaths: SubpathRecord[], imageMeta: ImageMeta[], filledRects: FilledRect[] }

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

    const subpaths = [];
    const imageMeta = [];
    const filledRects = [];

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
                break;
            case OPS.restore:
                ctm = ctmStack.length > 1 ? ctmStack.pop() : identity.slice();
                if (colorStateStack.length > 1) {
                    const cs = colorStateStack.pop();
                    fillColor = cs.fill; strokeColor = cs.stroke;
                }
                break;
            case OPS.transform:
                ctm = mulMatrix(ctm, args);
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
                currentSubpath.filled = true;
                if (pendingRect) { filledRects.push({ ...pendingRect }); }
                pendingRect = null;
                break;
            case OPS.stroke:
            case OPS.closeStrokePath:
                pendingRect = null;
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
                imageMeta.push({ id: imgId, bbox: { x: left, y: top, w: right - left, h: bottom - top }, inline: false });
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

    return { subpaths, imageMeta, filledRects };
}
