/**
 * tableLogic.js (rewritten; vanilla ESM, no jQuery)
 *
 * Post-extraction DOM utilities for rendered HTML tables:
 *   - VisualGridMapper ; maps <td>/<th> cells to a 2D grid (handles rowspan/colspan)
 *   - Crosshair highlight; row + column highlight on hover
 *   - Accordion toggles
 *   - Column sp-option visibility toggles
 *   - Table transpose
 *
 * Call initTableFeatures(root) after inserting extracted HTML into the DOM.
 * root defaults to document.body.
 */

// ── 1. VISUAL GRID MAPPER ──────────────────────────────────────────────────

export class VisualGridMapper {
    constructor(table) {
        this.table = table;
        this.grid = [];
        this.cellMap = new Map();
        this.maxCols = 0;
        this.maxRows = 0;
        this._build();
    }

    _build() {
        const rows = Array.from(this.table.querySelectorAll('tr'));

        rows.forEach((_row, rowIndex) => {
            this.grid[rowIndex] = this.grid[rowIndex] || [];
        });

        rows.forEach((row, rowIndex) => {
            let colIndex = 0;
            Array.from(row.querySelectorAll('td, th')).forEach(cell => {
                const colspan = parseInt(cell.getAttribute('colspan') || 1, 10);
                const rowspan = parseInt(cell.getAttribute('rowspan') || 1, 10);

                // Skip already-occupied cells
                while (this.grid[rowIndex][colIndex] !== undefined) colIndex++;

                this.cellMap.set(cell, {
                    rowspan, colspan,
                    content: cell.innerHTML,
                    isHeader: cell.tagName === 'TH',
                    startRow: rowIndex,
                    startCol: colIndex,
                });

                for (let r = 0; r < rowspan; r++) {
                    this.grid[rowIndex + r] = this.grid[rowIndex + r] || [];
                    for (let c = 0; c < colspan; c++) {
                        this.grid[rowIndex + r][colIndex + c] = {
                            element: cell,
                            isOrigin: (r === 0 && c === 0),
                        };
                    }
                }
                colIndex += colspan;
            });
            this.maxCols = Math.max(this.maxCols, colIndex);
        });

        this.maxRows = this.grid.length;
    }

    getCellsInRow(rowIndex) {
        const cells = new Set();
        (this.grid[rowIndex] || []).forEach(gc => { if (gc) cells.add(gc.element); });
        return [...cells];
    }

    getCellsInColumn(colIndex) {
        const cells = new Set();
        this.grid.forEach(row => { if (row?.[colIndex]) cells.add(row[colIndex].element); });
        return [...cells];
    }

    getVisualPosition(cell) { return this.cellMap.get(cell); }
}

// ── 2. CROSSHAIR HIGHLIGHT ─────────────────────────────────────────────────

function initCrosshair(root) {
    root.querySelectorAll('table').forEach(table => {
        if (table.dataset.crosshairInit) return;
        table.dataset.crosshairInit = '1';
        table.classList.add('crosshair-table');

        const mapper = new VisualGridMapper(table);

        table.addEventListener('mouseover', e => {
            const cell = e.target.closest('td, th');
            if (!cell || !table.contains(cell)) return;
            const pos = mapper.cellMap.get(cell);
            if (!pos) return;

            table.querySelectorAll('.highlight-row, .highlight-col').forEach(el => {
                el.classList.remove('highlight-row', 'highlight-col');
            });

            const rowCells = new Set(), colCells = new Set();
            for (let r = 0; r < pos.rowspan; r++) {
                mapper.getCellsInRow(pos.startRow + r).forEach(c => rowCells.add(c));
            }
            for (let c = 0; c < pos.colspan; c++) {
                mapper.getCellsInColumn(pos.startCol + c).forEach(c => colCells.add(c));
            }
            rowCells.forEach(c => c.classList.add('highlight-row'));
            colCells.forEach(c => c.classList.add('highlight-col'));
        });

        table.addEventListener('mouseleave', () => {
            table.querySelectorAll('.highlight-row, .highlight-col').forEach(el => {
                el.classList.remove('highlight-row', 'highlight-col');
            });
        });
    });
}

// ── 3. ACCORDION ───────────────────────────────────────────────────────────

function initAccordions(root) {
    root.querySelectorAll('.accordion-header').forEach(header => {
        if (header.dataset.accInit) return;
        header.dataset.accInit = '1';
        window.GxPointer.onPress(header, () => {
            header.classList.toggle('actives');
            let next = header.closest('tr')?.nextElementSibling;
            while (next && !next.classList.contains('accordion-header')) {
                next.style.display = next.style.display === 'none' ? '' : 'none';
                next = next.nextElementSibling;
            }
        });
    });

    root.querySelectorAll('.accordion').forEach(btn => {
        if (btn.dataset.accInit) return;
        btn.dataset.accInit = '1';
        window.GxPointer.onPress(btn, () => {
            btn.classList.toggle('active');
            const panel = btn.nextElementSibling;
            if (panel?.classList.contains('panel')) {
                panel.style.display = panel.style.display === 'none' ? '' : 'none';
            }
        });
    });
}

// ── 4. SP-OPTION COLUMN VISIBILITY ────────────────────────────────────────

function initSpSelectors(root) {
    root.querySelectorAll('.sp-option').forEach(opt => {
        if (opt.dataset.spInit) return;
        opt.dataset.spInit = '1';
        window.GxPointer.onPress(opt, () => {
            const panel = opt.closest('.panel');
            if (!panel) return;
            const table = panel.querySelector('.tablecoil');
            if (!table) return;
            const val = opt.dataset.value;
            panel.querySelectorAll('.sp-option').forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
            table.querySelectorAll('[class*="sp-"]').forEach(el => el.classList.remove('active'));
            table.querySelectorAll(`.sp-${val}`).forEach(el => el.classList.add('active'));
        });
    });
}

// ── 5. TABLE TRANSPOSE ─────────────────────────────────────────────────────

export function transposeTable(table) {
    const mapper = new VisualGridMapper(table);
    const { grid, cellMap, maxCols, maxRows } = mapper;

    const transposed = [];
    for (let c = 0; c < maxCols; c++) {
        transposed[c] = [];
        for (let r = 0; r < maxRows; r++) {
            transposed[c][r] = grid[r]?.[c] ?? null;
        }
    }

    const newTable = document.createElement('table');
    newTable.className = table.className;
    newTable.id = table.id;

    const visited = new Set();
    transposed.forEach((row, ri) => {
        const tr = document.createElement('tr');
        row.forEach((gc, ci) => {
            const key = `${ri},${ci}`;
            if (visited.has(key)) return;
            if (!gc?.isOrigin) { tr.appendChild(document.createElement('td')); return; }
            const info = cellMap.get(gc.element);
            const cell = document.createElement(info.isHeader ? 'th' : 'td');
            cell.className = gc.element.className;
            cell.innerHTML = info.content;
            if (info.colspan > 1) cell.setAttribute('rowspan', info.colspan);
            if (info.rowspan > 1) cell.setAttribute('colspan', info.rowspan);
            tr.appendChild(cell);
            for (let r = 0; r < (info.colspan || 1); r++) {
                for (let c = 0; c < (info.rowspan || 1); c++) {
                    visited.add(`${ri + r},${ci + c}`);
                }
            }
        });
        newTable.appendChild(tr);
    });

    table.replaceWith(newTable);
    initTableFeatures(newTable.parentElement || document.body);
    return newTable;
}

// ── 6. MASTER INIT ─────────────────────────────────────────────────────────

/**
 * Wire up all table features within a root element.
 * Call after inserting extracted HTML into the DOM.
 * @param {HTMLElement} [root=document.body]
 */
export function initTableFeatures(root = document.body) {
    initCrosshair(root);
    initAccordions(root);
    initSpSelectors(root);
}
