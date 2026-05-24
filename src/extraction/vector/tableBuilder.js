// tableBuilder.js
// Converts a LatticeReconstructor result + PDF.js text items → an HTML <table>
// with correct colspan/rowspan by checking whether interior grid boundaries are present.
//
// After the table is injected into the DOM, the VisualGridMapper in tableLogic.js
// (already wired via initTableFeatures) handles interactive crosshair/column features.
//
// COORDINATE NOTE: Both the lattice grid coordinates and the text positions
// must be in the same coordinate system (viewport space). The lattice comes
// from ctmAdapter which outputs viewport-space segments. Text items arrive
// in PDF user-space and are transformed here using viewport.transform.

import { rebuildText } from './textRebuilder.js';

function esc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Check whether a horizontal boundary line covering [xA, xB] at Y position y
 * actually exists in the merged hLines set.
 *
 * An interior horizontal line between row r and r+1 spanning [cols[c], cols[c+span]]
 * is "present" if there is a merged line at that Y that covers the full span.
 * Its absence means the rows are merged (rowspan).
 */
function hLinePresent(hLines, y, xA, xB, eps) {
    return hLines.some(l =>
        Math.abs(l.y - y) <= eps &&
        l.xMin <= xA + eps &&
        l.xMax >= xB - eps,
    );
}

/**
 * Check whether a vertical boundary line covering [yA, yB] at X position x
 * actually exists in the merged vLines set.
 */
function vLinePresent(vLines, x, yA, yB, eps) {
    return vLines.some(l =>
        Math.abs(l.x - x) <= eps &&
        l.yMin <= yA + eps &&
        l.yMax >= yB - eps,
    );
}

/**
 * Transform a PDF user-space point to viewport space using the viewport transform matrix.
 * This is equivalent to viewport.convertToViewportPoint() but works in workers
 * where the viewport object may have been serialized without its methods.
 *
 * @param {number[]} vpTransform  — viewport.transform [a, b, c, d, e, f]
 * @param {number} pdfX  — X in PDF user-space
 * @param {number} pdfY  — Y in PDF user-space
 * @returns {[number, number]}  — [x, y] in viewport space
 */
function toViewportPoint(vpTransform, pdfX, pdfY) {
    return [
        vpTransform[0] * pdfX + vpTransform[2] * pdfY + vpTransform[4],
        vpTransform[1] * pdfX + vpTransform[3] * pdfY + vpTransform[5],
    ];
}

/**
 * Build an HTML <table> from a lattice and PDF.js text content.
 *
 * @param {{ rows, cols, hLines, vLines }} lattice  — from LatticeReconstructor
 * @param {Array<{ str, transform }>} textItems     — PDF.js textContent.items
 * @param {{ transform: number[] }} viewport         — viewport with .transform matrix
 * @param {number} [eps=6]  — boundary-presence tolerance in px (increased for jitter)
 * @returns {string}  — HTML string; empty string if lattice is degenerate
 */
export function buildTable(lattice, textItems, viewport, assignedItems = new Set(), proximityPx = 15) {
    const { rows, cols, hLines, vLines } = lattice;
    const numRows = rows.length - 1;
    const numCols = cols.length - 1;

    if (numRows < 1 || numCols < 1) return '';

    // Use the same cluster tolerance that built the rows/cols arrays.
    // The old hardcoded 6px was half of clusterEps (12px), so valid interior
    // hLines/vLines up to 12px from a clustered row/col value were silently missed,
    // causing rowspan and colspan to expand to the full grid size.
    const eps = lattice.clusterEps ?? 12;

    const vpTransform = viewport.transform;

    // ── 1. Assign text items to cells ───────────────────────────────────────
    // Each cell holds an array of full text items with _x for sorting
    const cells = Array.from({ length: numRows }, () =>
        Array.from({ length: numCols }, () => []),
    );

    for (let idx = 0; idx < textItems.length; idx++) {
        const item = textItems[idx];
        if (!item.str?.trim()) continue;

        // Transform text position from PDF user-space to viewport space
        // item.transform is [scaleX, shearX, shearY, scaleY, translateX, translateY]
        const [sx, sy] = toViewportPoint(vpTransform, item.transform[4], item.transform[5]);

        // Find the nearest cell for this point
        let bestR = -1, bestC = -1;
        let minDist = Infinity;

        for (let ri = 0; ri < numRows; ri++) {
            for (let ci = 0; ci < numCols; ci++) {
                const xMin = cols[ci];
                const xMax = cols[ci + 1];
                const yMin = rows[ri];
                const yMax = rows[ri + 1];

                // Distance from point to rectangle (0 if inside)
                const dx = Math.max(xMin - sx, 0, sx - xMax);
                const dy = Math.max(yMin - sy, 0, sy - yMax);
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < minDist) {
                    minDist = dist;
                    bestR = ri;
                    bestC = ci;
                }
            }
        }

        // Assign to the closest cell if it's within a reasonable threshold (e.g., 15px)
        // This acts as our "KD-tree" proximity lookup without the heavy data structure
        if (bestR !== -1 && bestC !== -1 && minDist < proximityPx && !assignedItems.has(idx)) {
            assignedItems.add(idx);
            cells[bestR][bestC].push({ ...item, _x: sx });
        }
    }

    // Degenerate table safety net.
    // If every text item landed in cells[0][0] and nowhere else, this lattice is
    // a phantom (outer-frame border or TOC decoration) that slipped through the
    // density check. Returning '' lets the content fall through to paragraph extraction.
    const hasSpread = cells.some((row, ri) =>
        row.some((cell, ci) => (ri > 0 || ci > 0) && cell.length > 0),
    );
    if (!hasSpread && numRows > 2 && numCols > 2 && cells[0][0].length > 0) return '';

    // Sort items within each cell by X position (left-to-right reading order)
    for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < numCols; c++) {
            cells[r][c].sort((a, b) => a._x - b._x);
        }
    }

    // ── 2. Build cell grid with colspan/rowspan ──────────────────────────────
    // visited[r][c] = true once that slot is consumed by a spanning cell origin
    const visited = Array.from({ length: numRows }, () => new Uint8Array(numCols));

    // Borderless (stream-detected) tables carry no physical line data.
    // Without hLines or vLines, every colspan/rowspan expansion loop runs to
    // the grid edge, collapsing all 87+ items into a single <th colspan=N rowspan=M>.
    // Borderless cells are always standalone — spanning is inferred from geometry,
    // not from lines that don't exist.
    const isBorderless = hLines.length === 0 && vLines.length === 0;

    let html = '<div class="panel" style="display: block; overflow: auto;">\n';
    html += isBorderless
        ? '<table class="tablecoil borderless">\n<tbody>\n'
        : '<table class="tablecoil">\n<tbody>\n';

    for (let r = 0; r < numRows; r++) {
        html += '<tr>';

        for (let c = 0; c < numCols; c++) {
            if (visited[r][c]) continue;

            let colspan = 1;
            const hasVLines = vLines.length > 0;
            const hasHLines = hLines.length > 0;

            if (hasVLines) {
                while (c + colspan < numCols) {
                    if (vLinePresent(vLines, cols[c + colspan], rows[r], rows[r + 1], eps)) break;
                    colspan++;
                }
            } else {
                // Borderless table or horizontal slat table: consume subsequent empty cells
                while (c + colspan < numCols && cells[r][c + colspan].length === 0) {
                    colspan++;
                }
            }

            // ── Determine rowspan ────────────────────────────────────────────
            let rowspan = 1;
            if (hasHLines) {
                while (r + rowspan < numRows) {
                    if (hLinePresent(hLines, rows[r + rowspan], cols[c], cols[c + colspan], eps)) break;
                    rowspan++;
                }
            }

            // ── Re-verify colspan for spanned rows ───────────────────────────
            let effectiveColspan = colspan;
            if (hasVLines && rowspan > 1) {
                for (let dr = 1; dr < rowspan; dr++) {
                    let narrowed = 1;
                    while (narrowed < effectiveColspan) {
                        if (vLinePresent(vLines, cols[c + narrowed], rows[r + dr], rows[r + dr + 1], eps)) break;
                        narrowed++;
                    }
                    effectiveColspan = Math.min(effectiveColspan, narrowed);
                }
            }

            // ── Accumulate content from all spanned sub-cells ────────────────
            const allItems = [];
            for (let dr = 0; dr < rowspan; dr++) {
                for (let dc = 0; dc < effectiveColspan; dc++) {
                    const cellItems = cells[r + dr]?.[c + dc];
                    if (cellItems?.length) {
                        allItems.push(...cellItems);
                    }
                    visited[r + dr][c + dc] = 1;
                }
            }

            const cellContent = rebuildText(allItems, 0, { format: 'inline-html' }) || '&nbsp;';
            const tag = r === 0 ? 'th' : 'td';
            const colAttr = effectiveColspan > 1 ? ` colspan="${effectiveColspan}"` : '';
            const rowAttr = rowspan > 1 ? ` rowspan="${rowspan}"` : '';
            html += `<${tag}${colAttr}${rowAttr}>${cellContent}</${tag}>`;
        }

        html += '</tr>\n';
    }

    html += '</tbody>\n</table>\n</div>';
    return html;
}
