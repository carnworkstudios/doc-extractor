// structTreeReader.js
// Tier 1 extractor: joins the PDF structure tree with text items via MCID.
//
// PDF structure trees encode semantic roles (Table, TR, TD, P, H, Figure)
// directly in the file. Each leaf node carries an MCID that links it to paint
// operations in the operator list wrapped in BMC/BDC…EMC brackets.
//
// Output contract:
//   { structRegions: StructRegion[], hasTable: boolean, columnHint: number|null }
//
// StructRegion is shaped like a contextClassifier region so pageAssembler
// consumes it unchanged. The caller (classifyPage) merges these regions with
// any Tier 2/3 regions that cover content the struct tree left untagged.
//
// What this module does NOT do:
//   - Emit coordinates: regions carry textItemIndices only; coordinates come
//     from the textMeta array built in classifyPage (standard contract).
//   - Produce column splits: the struct tree has no <Column> element.
//     The column hint (Y-jump detection) is passed up to seed Tier 2 vSeg search.
//   - Trust P/H roles: only Table/TR/TD are authoritative. Paragraph and heading
//     roles from the struct tree are ignored; Tier 3 handles those.

import { RegionType } from './classifiers/regionTypes.js';

// Recognized role strings from PDF 1.7 / PDF 2.0 standard structure types.
const ROLE_TABLE   = new Set(['Table']);
const ROLE_TR      = new Set(['TR', 'THead', 'TBody', 'TFoot']);
const ROLE_TD      = new Set(['TD', 'TH']);
const ROLE_FIGURE  = new Set(['Figure', 'Formula', 'Artifact']);

// OPS constants needed for the MCID walk.
// Loaded from the OPS object passed in — avoids a hard pdfjs-dist import.
const TEXT_OPS = new Set([44, 45, 46, 47]); // showText showSpacedText nextLine*
const BMC_OP   = 69;  // beginMarkedContent
const BDC_OP   = 70;  // beginMarkedContentProps
const EMC_OP   = 71;  // endMarkedContent

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read the struct tree and join it with textMeta via operator list MCIDs.
 *
 * @param {object}   structTree  — from page.getStructTree()
 * @param {object}   opList      — from page.getOperatorList()
 * @param {Array}    textMeta    — viewport-enriched text items (built by classifyPage)
 * @param {object}   OPS         — pdfjsLib.OPS (passed through from worker)
 * @returns {{ structRegions: Array, hasTable: boolean, columnHint: number|null }}
 */
export function readStructTree(structTree, opList, textMeta, OPS) {
    // Guard: empty or trivially unpopulated trees exit immediately.
    if (!structTree || !structTree.children?.length) {
        return { structRegions: [], hasTable: false, columnHint: null };
    }
    if (!_hasRelevantRoles(structTree)) {
        return { structRegions: [], hasTable: false, columnHint: null };
    }

    // ── Step 1: Build MCID → textMeta index map ───────────────────────────────
    // Walk the operator list once, maintaining a MCID stack at each BMC/BDC.
    // Every text paint operator encountered while a MCID is active records its
    // position in the textMeta array under that MCID.
    //
    // textMeta items are ordered exactly as textContent.items — same array index.
    // The operator list text items interleave with other operators; we match them
    // by tracking how many text-paint ops we've seen (= textMeta index).
    const mcidToItemIndices = _buildMcidMap(opList, OPS);

    if (mcidToItemIndices.size === 0) {
        return { structRegions: [], hasTable: false, columnHint: null };
    }

    // ── Step 2: Walk the struct tree, aggregate item indices per leaf ─────────
    const tableNodes = [];
    _walkTree(structTree, null, mcidToItemIndices, tableNodes);

    if (tableNodes.length === 0) {
        // No trusted Table/TR/TD nodes found → Tier 1 contributes nothing.
        // Column hint is still derived from P/H reading order if available.
        const colHint = _detectColumnHint(structTree, mcidToItemIndices, textMeta);
        return { structRegions: [], hasTable: false, columnHint: colHint };
    }

    // ── Step 3: Convert table nodes → StructRegion[] ─────────────────────────
    const structRegions = [];
    let regionId = 0;
    for (const tableNode of tableNodes) {
        _emitTableRegions(tableNode, textMeta, structRegions, regionId);
        regionId += tableNode.rows.length * 10;
    }

    const colHint = _detectColumnHint(structTree, mcidToItemIndices, textMeta);
    return { structRegions, hasTable: structRegions.length > 0, columnHint: colHint };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _hasRelevantRoles(node) {
    if (!node) return false;
    const role = node.role;
    if (ROLE_TABLE.has(role) || ROLE_TR.has(role) || ROLE_TD.has(role)) return true;
    if (Array.isArray(node.children)) {
        return node.children.some(_hasRelevantRoles);
    }
    return false;
}

/**
 * Walk the operator list once to build mcid → [textMetaIndex, ...] map.
 * Text-paint ops are counted in-order to assign textMeta indices.
 */
function _buildMcidMap(opList, OPS) {
    const { fnArray, argsArray } = opList;
    const textOps = new Set([
        OPS.showText, OPS.showSpacedText,
        OPS.nextLineShowText, OPS.nextLineSetSpacingShowText,
    ]);
    const bmcOp = OPS.beginMarkedContent;
    const bdcOp = OPS.beginMarkedContentProps;
    const emcOp = OPS.endMarkedContent;

    const mcidStack = [];
    const mcidToIndices = new Map();
    let textItemIndex = 0;

    for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i];

        if (fn === bmcOp || fn === bdcOp) {
            const args = argsArray[i];
            // BDC args: [tag, properties]. Properties may be an object with mcid,
            // or a name string referencing a properties dict (handled as null here).
            let mcid = null;
            if (fn === bdcOp && args && typeof args[1] === 'object' && args[1] !== null) {
                mcid = args[1].mcid ?? args[1].MCID ?? null;
            }
            mcidStack.push(mcid);
            continue;
        }

        if (fn === emcOp) {
            mcidStack.pop();
            continue;
        }

        if (textOps.has(fn)) {
            // Find the innermost non-null MCID on the stack.
            for (let k = mcidStack.length - 1; k >= 0; k--) {
                if (mcidStack[k] !== null) {
                    const mcid = mcidStack[k];
                    if (!mcidToIndices.has(mcid)) mcidToIndices.set(mcid, []);
                    mcidToIndices.get(mcid).push(textItemIndex);
                    break;
                }
            }
            textItemIndex++;
        }
    }

    return mcidToIndices;
}

/**
 * Recursive struct tree walker. Collects Table nodes into tableNodes[].
 * Each entry: { rows: [ { cells: [ { indices: number[] } ] } ] }
 */
function _walkTree(node, parentTableNode, mcidToItemIndices, tableNodes) {
    if (!node) return;
    const role = node.role || '';

    if (ROLE_TABLE.has(role)) {
        const tableNode = { rows: [] };
        tableNodes.push(tableNode);
        if (Array.isArray(node.children)) {
            for (const child of node.children) {
                _walkTree(child, tableNode, mcidToItemIndices, tableNodes);
            }
        }
        return;
    }

    if (ROLE_TR.has(role) && parentTableNode) {
        const row = { cells: [] };
        parentTableNode.rows.push(row);
        if (Array.isArray(node.children)) {
            for (const child of node.children) {
                _walkTD(child, row, mcidToItemIndices);
            }
        }
        return;
    }

    // Recurse into non-table structural nodes (Document, Part, Sect, Div, etc.)
    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            _walkTree(child, parentTableNode, mcidToItemIndices, tableNodes);
        }
    }
}

function _walkTD(node, row, mcidToItemIndices) {
    if (!node) return;
    const role = node.role || '';

    if (ROLE_TD.has(role)) {
        // Collect all MCIDs under this TD subtree
        const indices = [];
        _collectMcidIndices(node, mcidToItemIndices, indices);
        row.cells.push({ indices });
        return;
    }

    // Recurse — a TR may contain grouping elements before the TDs
    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            _walkTD(child, row, mcidToItemIndices);
        }
    }
}

function _collectMcidIndices(node, mcidToItemIndices, out) {
    if (!node) return;
    // Leaf nodes carry a mcid property (PDF.js exposes this on struct leaf nodes)
    if (typeof node.mcid === 'number') {
        const idxs = mcidToItemIndices.get(node.mcid);
        if (idxs) out.push(...idxs);
    }
    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            _collectMcidIndices(child, mcidToItemIndices, out);
        }
    }
}

/**
 * Convert a table node into LATTICE_TABLE-shaped regions for the assembler.
 * One region per row for now — the assembler's tableBuilder consumes
 * textItemIndices and re-derives cell structure from X positions.
 */
function _emitTableRegions(tableNode, textMeta, out, startId) {
    if (!tableNode.rows.length) return;

    // Collect all item indices across all cells in the table
    const allIndices = [];
    for (const row of tableNode.rows) {
        for (const cell of row.cells) {
            allIndices.push(...cell.indices);
        }
    }
    if (!allIndices.length) return;

    // Compute bbox from the text items' viewport positions
    const validItems = allIndices
        .map(i => textMeta[i])
        .filter(Boolean)
        .filter(tm => tm.str.trim());
    if (!validItems.length) return;

    const xMin = Math.min(...validItems.map(tm => tm.vx));
    const yMin = Math.min(...validItems.map(tm => tm.vy - tm.vFont));
    const xMax = Math.max(...validItems.map(tm => tm.vx + tm.vWidth));
    const yMax = Math.max(...validItems.map(tm => tm.vy));

    out.push({
        type: RegionType.LATTICE_TABLE,
        id: `struct_table_${startId}`,
        bbox: { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin },
        textItemIndices: allIndices,
        structRows: tableNode.rows,   // full row/cell structure for tableBuilder
        yCenter: (yMin + yMax) / 2,
        columnIndex: -1,              // full-width until post-column-detection patch
        fromStructTree: true,
    });
}

/**
 * Detect a column hint from reading order in the struct tree.
 * In a well-tagged 2-column document, the struct leaves are ordered
 * left-col top-to-bottom then right-col top-to-bottom. Walking leaves
 * in tree order, a large Y decrease (upward jump) marks the column boundary.
 * Returns the approximate X midpoint of the gutter, or null if not detected.
 */
function _detectColumnHint(structTree, mcidToItemIndices, textMeta) {
    // Collect leaf nodes in tree order, map to their Y coordinates
    const leafYs = [];
    _collectLeafYs(structTree, mcidToItemIndices, textMeta, leafYs);

    if (leafYs.length < 6) return null;

    // Find the largest Y decrease (upward jump) — that's the column wrap point.
    // Require the jump to be at least 20% of the page content height to qualify.
    const contentSpan = Math.max(...leafYs) - Math.min(...leafYs);
    if (contentSpan < 40) return null;

    let maxDrop = 0, jumpIdx = -1;
    for (let i = 1; i < leafYs.length; i++) {
        const drop = leafYs[i - 1] - leafYs[i];
        if (drop > maxDrop) { maxDrop = drop; jumpIdx = i; }
    }

    if (maxDrop < contentSpan * 0.20 || jumpIdx < 0) return null;

    // The X hint: items just before the jump are in the left column bottom;
    // items just after are in the right column top. Midpoint of their X ranges
    // estimates the gutter center.
    const leftItems  = _collectLeafItems(structTree, mcidToItemIndices, textMeta, 0, jumpIdx);
    const rightItems = _collectLeafItems(structTree, mcidToItemIndices, textMeta, jumpIdx, Infinity);

    if (!leftItems.length || !rightItems.length) return null;
    const leftXMax  = Math.max(...leftItems.map(tm => tm.vx + tm.vWidth));
    const rightXMin = Math.min(...rightItems.map(tm => tm.vx));

    if (rightXMin <= leftXMax) return null; // no clean gap
    return (leftXMax + rightXMin) / 2;
}

function _collectLeafYs(node, mcidToItemIndices, textMeta, out) {
    if (!node) return;
    if (typeof node.mcid === 'number') {
        const idxs = mcidToItemIndices.get(node.mcid) || [];
        for (const i of idxs) {
            const tm = textMeta[i];
            if (tm?.str.trim()) out.push(tm.vy);
        }
        return;
    }
    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            _collectLeafYs(child, mcidToItemIndices, textMeta, out);
        }
    }
}

function _collectLeafItems(node, mcidToItemIndices, textMeta, startLeaf, endLeaf, _counter = { n: 0 }) {
    const items = [];
    _collectLeafItemsInner(node, mcidToItemIndices, textMeta, startLeaf, endLeaf, _counter, items);
    return items;
}

function _collectLeafItemsInner(node, mcidToItemIndices, textMeta, startLeaf, endLeaf, counter, items) {
    if (!node) return;
    if (typeof node.mcid === 'number') {
        const idx = counter.n++;
        if (idx >= startLeaf && idx < endLeaf) {
            const idxs = mcidToItemIndices.get(node.mcid) || [];
            for (const i of idxs) {
                const tm = textMeta[i];
                if (tm?.str.trim()) items.push(tm);
            }
        }
        return;
    }
    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            _collectLeafItemsInner(child, mcidToItemIndices, textMeta, startLeaf, endLeaf, counter, items);
        }
    }
}
