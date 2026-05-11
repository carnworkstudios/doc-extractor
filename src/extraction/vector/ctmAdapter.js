// ctmAdapter.js
// Converts a PDF.js operator list into normalized line segments in viewport coordinates.
//
// Output: PathSegment[]
// { id: string, x1, y1, x2, y2, strokeWidth: number }
// Horizontal segments guaranteed x1 <= x2; vertical segments guaranteed y1 <= y2.
//
// Coordinate pipeline:
//   PDF user-space → CTM bake → viewport transform (scale + Y-flip)
//
// Key design decisions:
//   - Thin filled rectangles (w<3 or h<3 in viewport px) are emitted as a single
//     center-line segment rather than 4 edges. This handles the very common pattern
//     where table borders are drawn as filled hairline rectangles.
//   - closePath emits a segment back to the subpath start point (many PDF generators
//     draw table cells as moveTo→lineTo→lineTo→lineTo→closePath polygons).
//   - Both fill and stroke paths are captured — table grids use both rendering modes.

// Multiply two CTM matrices (PDF format: [a, b, c, d, e, f])
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

/**
 * Extract line segments from a PDF.js operator list.
 *
 * @param {{ fnArray: Uint8Array, argsArray: Array }} opList
 * @param {{ height: number, width: number, transform: number[] }} viewport
 * @param {object} OPS  — pdfjsLib.OPS passed in from the caller
 * @returns {Array<{id, x1, y1, x2, y2, strokeWidth}>}
 */
export function extractPaths(opList, viewport, OPS) {
    const { fnArray, argsArray } = opList;

    // The viewport.transform matrix converts PDF user-space → viewport (screen) space.
    // It handles scaling AND the Y-flip (PDF origin bottom-left → screen origin top-left).
    const vpTransform = viewport.transform; // [scaleX, 0, 0, -scaleY, offsetX, offsetY]

    const identity = [1, 0, 0, 1, 0, 0];
    const ctmStack = [identity.slice()];
    let ctm = identity.slice();

    // Subpath tracking for closePath
    let pendingX = 0, pendingY = 0;
    let subpathStartX = 0, subpathStartY = 0;
    let strokeWidth = 1;
    let id = 0;

    // Threshold for "thin rect → single line" conversion (in viewport px)
    const THIN_RECT_THRESHOLD = 3;

    const segments = [];
    const imageMeta = [];

    const addSeg = (ax, ay, bx, by, sw) => {
        const dx = Math.abs(bx - ax);
        const dy = Math.abs(by - ay);
        if (dx < 0.5 && dy < 0.5) return; // degenerate
        // Normalize direction
        const isHoriz = dy <= dx;
        let x1 = ax, y1 = ay, x2 = bx, y2 = by;
        if (isHoriz && x1 > x2) { x1 = bx; x2 = ax; y1 = by; y2 = ay; }
        if (!isHoriz && y1 > y2) { y1 = by; y2 = ay; x1 = bx; x2 = ax; }
        segments.push({ id: `s${id++}`, x1, y1, x2, y2, strokeWidth: sw ?? strokeWidth });
    };

    // Transform a PDF user-space point through CTM then viewport transform
    const toViewport = (pdfX, pdfY) => {
        // Step 1: CTM bake (PDF internal transforms)
        const [cx, cy] = applyMatrix(ctm, pdfX, pdfY);
        // Step 2: Viewport transform (scale + Y-flip)
        return [
            vpTransform[0] * cx + vpTransform[2] * cy + vpTransform[4],
            vpTransform[1] * cx + vpTransform[3] * cy + vpTransform[5],
        ];
    };

    const addRect = (rx, ry, rw, rh) => {
        const [x1, y1] = toViewport(rx, ry);
        const [x2, y2] = toViewport(rx + rw, ry + rh);

        const left = Math.min(x1, x2), right = Math.max(x1, x2);
        const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
        const w = right - left;
        const h = bottom - top;

        if (w < THIN_RECT_THRESHOLD && h >= THIN_RECT_THRESHOLD) {
            // Thin vertical rect → single vertical center-line
            const cx = (left + right) / 2;
            addSeg(cx, top, cx, bottom, w);
        } else if (h < THIN_RECT_THRESHOLD && w >= THIN_RECT_THRESHOLD) {
            // Thin horizontal rect → single horizontal center-line
            const cy = (top + bottom) / 2;
            addSeg(left, cy, right, cy, h);
        } else if (w >= THIN_RECT_THRESHOLD && h >= THIN_RECT_THRESHOLD) {
            // Normal rectangle → 4 edge segments
            addSeg(left, top, right, top);
            addSeg(right, top, right, bottom);
            addSeg(right, bottom, left, bottom);
            addSeg(left, bottom, left, top);
        }
        // else: degenerate (both dimensions tiny) → skip
    };

    const processSubOps = (subOps, subArgs) => {
        let ai = 0;
        for (let j = 0; j < subOps.length; j++) {
            const sf = subOps[j];
            if (sf === OPS.moveTo) {
                const [x, y] = toViewport(subArgs[ai], subArgs[ai + 1]);
                pendingX = x; pendingY = y;
                subpathStartX = x; subpathStartY = y;
                ai += 2;
            } else if (sf === OPS.lineTo) {
                const [x, y] = toViewport(subArgs[ai], subArgs[ai + 1]);
                addSeg(pendingX, pendingY, x, y);
                pendingX = x; pendingY = y;
                ai += 2;
            } else if (sf === OPS.rectangle) {
                addRect(subArgs[ai], subArgs[ai + 1], subArgs[ai + 2], subArgs[ai + 3]);
                ai += 4;
            } else if (sf === OPS.curveTo) {
                // TODO: Opt-in flattenCurves for SchemaPipeline. Currently skips cubic and advances to endpoint.
                const [x, y] = toViewport(subArgs[ai + 4], subArgs[ai + 5]);
                pendingX = x; pendingY = y;
                ai += 6;
            } else if (sf === OPS.curveTo2 || sf === OPS.curveTo3) {
                const [x, y] = toViewport(subArgs[ai + 2], subArgs[ai + 3]);
                pendingX = x; pendingY = y;
                ai += 4;
            } else if (sf === OPS.closePath) {
                // Emit closing segment back to subpath start
                addSeg(pendingX, pendingY, subpathStartX, subpathStartY);
                pendingX = subpathStartX;
                pendingY = subpathStartY;
            }
        }
    };

    for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i];
        const args = argsArray[i];

        switch (fn) {
            case OPS.save:
                ctmStack.push(ctm.slice());
                break;
            case OPS.restore:
                ctm = ctmStack.length > 1 ? ctmStack.pop() : identity.slice();
                break;
            case OPS.transform:
                ctm = mulMatrix(ctm, args);
                break;
            case OPS.setLineWidth:
                strokeWidth = args[0];
                break;
            case OPS.moveTo: {
                const [x, y] = toViewport(args[0], args[1]);
                pendingX = x; pendingY = y;
                subpathStartX = x; subpathStartY = y;
                break;
            }
            case OPS.lineTo: {
                const [x, y] = toViewport(args[0], args[1]);
                addSeg(pendingX, pendingY, x, y);
                pendingX = x; pendingY = y;
                break;
            }
            case OPS.rectangle:
                addRect(args[0], args[1], args[2], args[3]);
                break;
            case OPS.constructPath:
                // args = [subOpArray, subArgArray, minX, minY, maxX, maxY]
                processSubOps(args[0], args[1]);
                break;
            case OPS.closePath:
                // Emit closing segment back to subpath start
                addSeg(pendingX, pendingY, subpathStartX, subpathStartY);
                pendingX = subpathStartX;
                pendingY = subpathStartY;
                break;
            case OPS.paintImageXObject:
            case OPS.paintImageMaskXObject:
            case OPS.paintJpegXObject: {
                const imgId = args[0];
                const [x1, y1] = toViewport(0, 0);
                const [x2, y2] = toViewport(1, 1);
                
                const left = Math.min(x1, x2), right = Math.max(x1, x2);
                const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
                
                imageMeta.push({
                    id: imgId,
                    bbox: { x: left, y: top, w: right - left, h: bottom - top }
                });
                break;
            }
            // Strokes/fills don't affect segment extraction — we capture on moveTo/lineTo
            default:
                break;
        }
    }

    return { segments, imageMeta };
}
