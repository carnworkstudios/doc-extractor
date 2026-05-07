// ctmAdapter.js
// Converts a PDF.js operator list into normalized line segments in screen-space coordinates.
//
// Output: PathSegment[]
// { id: string, x1, y1, x2, y2, strokeWidth: number }
// Horizontal segments guaranteed x1 <= x2; vertical segments guaranteed y1 <= y2.

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
 * @param {{ height: number, convertToViewportPoint: function }} viewport
 * @param {object} OPS  — pdfjsLib.OPS passed in from the caller
 * @returns {Array<{id, x1, y1, x2, y2, strokeWidth}>}
 */
export function extractPaths(opList, viewport, OPS) {
    const { fnArray, argsArray } = opList;
    const pageHeight = viewport.height;

    // Y-flip: PDF origin is bottom-left; screen origin is top-left
    const flipY = (y) => pageHeight - y;

    const identity = [1, 0, 0, 1, 0, 0];
    const ctmStack = [identity.slice()];
    let ctm = identity.slice();

    let pendingX = 0, pendingY = 0;
    let strokeWidth = 1;
    let id = 0;

    const segments = [];

    const addSeg = (ax, ay, bx, by) => {
        const dx = Math.abs(bx - ax);
        const dy = Math.abs(by - ay);
        if (dx < 0.5 && dy < 0.5) return; // degenerate
        // Normalize direction
        const isHoriz = dy <= dx;
        let x1 = ax, y1 = ay, x2 = bx, y2 = by;
        if (isHoriz && x1 > x2) { x1 = bx; x2 = ax; }
        if (!isHoriz && y1 > y2) { y1 = by; y2 = ay; x1 = bx; x2 = ax; }
        segments.push({ id: `s${id++}`, x1, y1, x2, y2, strokeWidth });
    };

    const toScreen = (pdfX, pdfY) => {
        const [px, py] = applyMatrix(ctm, pdfX, pdfY);
        return [px, flipY(py)];
    };

    const addRect = (rx, ry, rw, rh) => {
        const [x1, y1] = toScreen(rx, ry);
        const [x2, y2] = toScreen(rx + rw, ry + rh);
        // 4 edges (Y is flipped so y1 > y2 in screen space when rh > 0)
        const top = Math.min(y1, y2), bot = Math.max(y1, y2);
        const lft = Math.min(x1, x2), rgt = Math.max(x1, x2);
        addSeg(lft, top, rgt, top);
        addSeg(rgt, top, rgt, bot);
        addSeg(rgt, bot, lft, bot);
        addSeg(lft, bot, lft, top);
    };

    const processSubOps = (subOps, subArgs) => {
        let ai = 0;
        for (let j = 0; j < subOps.length; j++) {
            const sf = subOps[j];
            if (sf === OPS.moveTo) {
                const [x, y] = toScreen(subArgs[ai], subArgs[ai + 1]);
                pendingX = x; pendingY = y; ai += 2;
            } else if (sf === OPS.lineTo) {
                const [x, y] = toScreen(subArgs[ai], subArgs[ai + 1]);
                addSeg(pendingX, pendingY, x, y);
                pendingX = x; pendingY = y; ai += 2;
            } else if (sf === OPS.rectangle) {
                addRect(subArgs[ai], subArgs[ai + 1], subArgs[ai + 2], subArgs[ai + 3]);
                ai += 4;
            } else if (sf === OPS.curveTo) {
                // Skip cubic — advance to endpoint
                const [x, y] = toScreen(subArgs[ai + 4], subArgs[ai + 5]);
                pendingX = x; pendingY = y; ai += 6;
            } else if (sf === OPS.curveTo2 || sf === OPS.curveTo3) {
                const [x, y] = toScreen(subArgs[ai + 2], subArgs[ai + 3]);
                pendingX = x; pendingY = y; ai += 4;
            } else if (sf === OPS.closePath) {
                // no-op for segment extraction
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
                const [x, y] = toScreen(args[0], args[1]);
                pendingX = x; pendingY = y;
                break;
            }
            case OPS.lineTo: {
                const [x, y] = toScreen(args[0], args[1]);
                addSeg(pendingX, pendingY, x, y);
                pendingX = x; pendingY = y;
                break;
            }
            case OPS.rectangle:
                addRect(args[0], args[1], args[2], args[3]);
                break;
            case OPS.constructPath:
                // args = [subOpArray, subArgArray, ...extra]
                processSubOps(args[0], args[1]);
                break;
            // Strokes/fills don't affect segment extraction — we capture on moveTo/lineTo
            default:
                break;
        }
    }

    return segments;
}
