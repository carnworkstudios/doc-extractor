// tableBuilder.js
// Converts a LatticeReconstructor result + PDF.js text items → an HTML <table>
// with correct colspan/rowspan by checking whether interior grid boundaries are present.
//
// After the table is injected into the DOM, the VisualGridMapper in tableLogic.js
// (already wired via initTableFeatures) handles interactive crosshair/column features.

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
 * Build an HTML <table> from a lattice and PDF.js text content.
 *
 * @param {{ rows, cols, hLines, vLines }} lattice  — from LatticeReconstructor
 * @param {Array<{ str, transform }>} textItems     — PDF.js textContent.items
 * @param {{ convertToViewportPoint }} viewport
 * @param {number} [eps=4]  — boundary-presence tolerance in px
 * @returns {string}  — HTML string; empty string if lattice is degenerate
 */
export function buildTable(lattice, textItems, viewport, eps = 4) {
    const { rows, cols, hLines, vLines } = lattice;
    const numRows = rows.length - 1;
    const numCols = cols.length - 1;

    if (numRows < 1 || numCols < 1) return '';

    // ── 1. Assign text items to cells ───────────────────────────────────────
    const cells = Array.from({ length: numRows }, () => Array(numCols).fill(''));

    for (const item of textItems) {
        if (!item.str?.trim()) continue;
        const [sx, sy] = viewport.convertToViewportPoint(
            item.transform[4],
            item.transform[5],
        );
        let r = -1, c = -1;
        for (let ri = 0; ri < numRows; ri++) {
            if (sy >= rows[ri] - eps && sy < rows[ri + 1] + eps) { r = ri; break; }
        }
        for (let ci = 0; ci < numCols; ci++) {
            if (sx >= cols[ci] - eps && sx < cols[ci + 1] + eps) { c = ci; break; }
        }
        if (r !== -1 && c !== -1) {
            cells[r][c] += (cells[r][c] ? ' ' : '') + item.str.trim();
        }
    }

    // ── 2. Build cell grid with colspan/rowspan ──────────────────────────────
    // visited[r][c] = true once that slot is consumed by a spanning cell origin
    const visited = Array.from({ length: numRows }, () => new Uint8Array(numCols));

    let html = '<table class="tablecoil">\n<tbody>\n';

    for (let r = 0; r < numRows; r++) {
        html += '<tr>';

        for (let c = 0; c < numCols; c++) {
            if (visited[r][c]) continue;

            // ── Determine colspan ────────────────────────────────────────────
            // Extend right while the vertical line separating col c+span from c+span+1
            // at Y band [rows[r], rows[r+1]] is absent.
            let colspan = 1;
            while (c + colspan < numCols) {
                if (vLinePresent(vLines, cols[c + colspan], rows[r], rows[r + 1], eps)) break;
                colspan++;
            }

            // ── Determine rowspan ────────────────────────────────────────────
            // Extend down while the horizontal line at rows[r+rowspan]
            // covering [cols[c], cols[c+colspan]] is absent.
            let rowspan = 1;
            while (r + rowspan < numRows) {
                if (hLinePresent(hLines, rows[r + rowspan], cols[c], cols[c + colspan], eps)) break;
                rowspan++;
            }

            // ── Accumulate content from all spanned sub-cells ────────────────
            let content = '';
            for (let dr = 0; dr < rowspan; dr++) {
                for (let dc = 0; dc < colspan; dc++) {
                    if (dr === 0 && dc === 0) continue; // origin cell content already in cells[r][c]
                    if (cells[r + dr]?.[c + dc]) {
                        content += (content ? ' ' : '') + cells[r + dr][c + dc];
                    }
                    visited[r + dr][c + dc] = 1;
                }
            }
            visited[r][c] = 1;

            const cellContent = esc((cells[r][c] + (content ? ' ' + content : '')).trim());
            const tag = r === 0 ? 'th' : 'td';
            const colAttr = colspan > 1 ? ` colspan="${colspan}"` : '';
            const rowAttr = rowspan > 1 ? ` rowspan="${rowspan}"` : '';
            html += `<${tag}${colAttr}${rowAttr}>${cellContent}</${tag}>`;
        }

        html += '</tr>\n';
    }

    html += '</tbody>\n</table>';
    return html;
}
