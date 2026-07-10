// layoutTreeBuilder.js — recursive XY-cut over region boxes → Boxwood LNode tree.
//
// Transforms flat classified regions into a recursive layout tree where every
// cell is either a row split, a column split, or a leaf holding region ids.
// The tree mirrors the visual structure of the PDF page: sidebars, nested
// columns, card clusters, and single-column flow all map to LNode splits.
//
// Zones-fallback: when the XY-cut cannot find confident splits, emits a
// flat `zones` split with measured absolute boxes — same IR, no wrong tree.
//
// Usage:
//   const { tree, method, cuts } = layoutTreeBuilder(regions, pageBox, pageScale);
//   // tree is an LNode ready for resolveLayout() or emission
//
// The opts shape is locked for the Phase 4 Boxwood 1.2.0 upstream lift:
//   inferSplits(boxes, boundary, {
//     minValley: { x, y },
//     maxDepth: 4,
//     minCellBoxes: 1,
//     excludeBands: [{ axis, lo, hi }],
//   })

import { PageScale } from './pageScale.js';

const MAX_DEPTH = 4;
const MIN_CELL_BOXES = 1;
const EQUAL_TRACK_TOL = 0.10; // 10% variance allowed for 'equal' track classification

/**
 * Build a layout tree from classified regions.
 *
 * @param {PageRegion[]} regions     — classified regions with bboxes
 * @param {{x:number,y:number,w:number,h:number}} pageBox  — page bounding box
 * @param {PageScale}    pageScale   — calibrated scale for threshold derivation
 * @param {object}       [opts]      — overrides
 * @returns {{ tree: object, method: string, cuts: object[], score: null }}
 */
export function layoutTreeBuilder(regions, pageBox, pageScale, opts = {}) {
    const boxes = regions
        .filter(r => r.bbox && !_isStructurallyClaimed(r.type))
        .map(r => ({
            id: r.id,
            box: r.bbox,
            region: r,
        }));

    if (boxes.length === 0) {
        return {
            tree: { style: {}, split: { zones: {} } },
            method: 'zones-fallback',
            cuts: [],
            score: null,
        };
    }

    // Build the tree with the XY-cut algorithm
    const minValleyY = pageScale ? pageScale.yBandTolPx * 2 : 10;
    const minValleyX = pageScale ? pageScale.colGapMinPx : 20;

    const tree = _buildTree(boxes, pageBox, {
        minValley: {
            y: opts.minValleyY ?? minValleyY,
            x: opts.minValleyX ?? minValleyX,
        },
        maxDepth: opts.maxDepth ?? MAX_DEPTH,
        minCellBoxes: opts.minCellBoxes ?? MIN_CELL_BOXES,
        excludeBands: opts.excludeBands ?? _pageFrameExclusionBands(pageBox, pageScale),
        depth: 0,
    });

    if (!tree) {
        // Fallback: zones split with absolute boxes
        const zones = {};
        for (const b of boxes) {
            zones[b.id] = b.box;
        }
        return {
            tree: { style: {}, split: { zones } },
            method: 'zones-fallback',
            cuts: [],
            score: null,
        };
    }

    return {
        tree,
        method: 'xycut',
        cuts: tree._cuts || [],
        score: null,
    };
}

function _isStructurallyClaimed(type) {
    return type === 'LATTICE_TABLE' || type === 'STREAM_TABLE' ||
           type === 'TABLE' || type === 'IMAGE' || type === 'DIVIDER';
}

function _pageFrameExclusionBands(pageBox, pageScale) {
    if (!pageBox || !pageScale) return [];
    const margin = pageScale.S * 0.5;
    return [
        { axis: 'x', lo: 0, hi: margin },
        { axis: 'x', lo: pageBox.w - margin, hi: pageBox.w },
        { axis: 'y', lo: 0, hi: margin },
        { axis: 'y', lo: pageBox.h - margin, hi: pageBox.h },
    ];
}

function _boxInBand(box, band) {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    if (band.axis === 'x') return cx >= band.lo && cx <= band.hi;
    return cy >= band.lo && cy <= band.hi;
}

function _isExcluded(box, excludeBands) {
    for (const band of excludeBands) {
        if (_boxInBand(box, band)) return true;
    }
    return false;
}

function _buildTree(boxes, frame, opts) {
    if (boxes.length === 0 || opts.depth >= opts.maxDepth) return null;

    // If only one box remains, it's a leaf
    if (boxes.length <= opts.minCellBoxes) {
        return _makeLeaf(boxes, frame);
    }

    const active = boxes.filter(b => !_isExcluded(b.box, opts.excludeBands));
    if (active.length <= opts.minCellBoxes) {
        return _makeLeaf(boxes, frame);
    }

    // Try horizontal (row) cut first — rows are more common in document layout
    // because most pages have headers, body, footnotes stacked vertically.
    const hCut = _findValleyCut(active, 'y', opts.minValley.y, frame);

    // If a horizontal valley exists that separates groups cleanly, recurse
    if (hCut && hCut.groups.length >= 2) {
        // Check that each group has enough boxes
        const validGroups = hCut.groups.filter(g => g.length >= opts.minCellBoxes);
        if (validGroups.length >= 2) {
            const childBoxes = hCut.groups.map(groupBoxes => {
                const gFrame = _groupFrame(groupBoxes);
                return { boxes: groupBoxes, frame: gFrame };
            });

            const tracks = hCut.tracks; // percentage Len[]
            const gap = hCut.gapPct;

            const children = childBoxes
                .map(c => _buildTree(c.boxes, c.frame, { ...opts, depth: opts.depth + 1 }))
                .filter(Boolean);

            if (children.length >= 2) {
                return {
                    style: {},
                    split: { rows: tracks, gap },
                    children,
                    _cuts: hCut.rawCuts,
                };
            }
        }
    }

    // Try vertical (column) cut
    const vCut = _findValleyCut(active, 'x', opts.minValley.x, frame);

    if (vCut && vCut.groups.length >= 2) {
        const validGroups = vCut.groups.filter(g => g.length >= opts.minCellBoxes);
        if (validGroups.length >= 2) {
            const childBoxes = vCut.groups.map(groupBoxes => {
                const gFrame = _groupFrame(groupBoxes);
                return { boxes: groupBoxes, frame: gFrame };
            });

            const tracks = vCut.tracks;
            const gap = vCut.gapPct;

            const children = childBoxes
                .map(c => _buildTree(c.boxes, c.frame, { ...opts, depth: opts.depth + 1 }))
                .filter(Boolean);

            if (children.length >= 2) {
                return {
                    style: {},
                    split: { cols: tracks, gap },
                    children,
                    _cuts: vCut.rawCuts,
                };
            }
        }
    }

    // No confident cut found — make a leaf with all remaining boxes
    return _makeLeaf(boxes, frame);
}

function _findValleyCut(boxes, axis, minValley, frame) {
    // Project boxes onto the given axis and find whitespace valleys
    const edges = boxes.map(b => {
        const lo = axis === 'x' ? b.box.x : b.box.y;
        const hi = axis === 'x' ? b.box.x + b.box.w : b.box.y + b.box.h;
        return { lo, hi, box: b };
    }).sort((a, b) => a.lo - b.lo);

    // Build coverage intervals
    const intervals = [];
    for (const e of edges) {
        intervals.push({ pos: e.lo, type: 'start', box: e.box });
        intervals.push({ pos: e.hi, type: 'end', box: e.box });
    }
    intervals.sort((a, b) => a.pos - b.pos || (a.type === 'start' ? -1 : 1));

    // Sweep to find gaps
    let depth = 0;
    let lastPos = null;
    const valleys = [];
    const frameSize = axis === 'x' ? frame.w : frame.h;

    for (const iv of intervals) {
        if (lastPos !== null && depth === 0 && iv.pos > lastPos) {
            const gap = iv.pos - lastPos;
            if (gap >= minValley) {
                valleys.push({ pos: (lastPos + iv.pos) / 2, gap, lo: lastPos, hi: iv.pos });
            }
        }
        if (iv.type === 'start') {
            if (depth === 0) lastPos = iv.pos;
            depth++;
        } else {
            depth--;
            if (depth === 0) lastPos = iv.pos;
        }
    }

    if (valleys.length === 0) return null;

    // Sort valleys by gap size descending, take the largest
    valleys.sort((a, b) => b.gap - a.gap);

    // Use the largest valley to split into groups
    const splitValley = valleys[0];

    const leftGroup = [];
    const rightGroup = [];
    for (const b of boxes) {
        const center = axis === 'x' ? b.box.x + b.box.w / 2 : b.box.y + b.box.h / 2;
        if (center < splitValley.pos) {
            leftGroup.push(b);
        } else {
            rightGroup.push(b);
        }
    }

    if (leftGroup.length === 0 || rightGroup.length === 0) return null;

    // Compute percentage tracks
    const frameStart = axis === 'x' ? frame.x : frame.y;
    const frameEnd = frameStart + frameSize;

    const leftEnd = Math.max(...leftGroup.map(b => (axis === 'x' ? b.box.x + b.box.w : b.box.y + b.box.h)));
    const rightStart = Math.min(...rightGroup.map(b => (axis === 'x' ? b.box.x : b.box.y)));

    const leftPct = ((leftEnd - frameStart) / frameSize) * 100;
    const rightPct = ((frameEnd - rightStart) / frameSize) * 100;
    const gapPct = ((rightStart - leftEnd) / frameSize) * 100;

    // Normalize: ensure tracks sum to 100 minus gap
    const totalAllocated = leftPct + rightPct + gapPct;
    const normLeft = (leftPct / totalAllocated) * 100;
    const normRight = (rightPct / totalAllocated) * 100;
    const normGap = (gapPct / totalAllocated) * 100;

    // Return groups in order
    const sorted = [...leftGroup, ...rightGroup];

    return {
        groups: [leftGroup, rightGroup],
        tracks: [`${normLeft.toFixed(1)}%`, `${normRight.toFixed(1)}%`],
        gapPct: Math.round(normGap * 10) / 1000, // convert to fractional gap (0.02 = 2%)
        rawCuts: [{
            axis,
            position: splitValley.pos,
            gap: splitValley.gap,
            leftPct: normLeft,
            rightPct: normRight,
        }],
    };
}

function _groupFrame(group) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of group) {
        const bx = b.box;
        minX = Math.min(minX, bx.x);
        minY = Math.min(minY, bx.y);
        maxX = Math.max(maxX, bx.x + bx.w);
        maxY = Math.max(maxY, bx.y + bx.h);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function _makeLeaf(boxes, frame) {
    // A leaf node carries no split — it renders as a block container
    // with its region IDs in reading order.
    const ids = boxes
        .sort((a, b) => (a.region?.yCenter ?? 0) - (b.region?.yCenter ?? 0))
        .map(b => b.id)
        .filter(Boolean);

    return {
        id: ids.length === 1 ? ids[0] : undefined,
        style: {},
        children: ids.map(id => ({
            id,
            style: {},
            measure: null,
        })),
    };
}

/**
 * Compare resolved layout boxes against measured region bboxes.
 * Returns a fidelityScore ∈ [0, 1] — per-region IoU + center offset.
 *
 * This is the local Phase 2 implementation; it will be upstreamed as
 * `compareLayout` in Boxwood 1.2.0 (Phase 4).
 *
 * @param {ResolvedLNode[]} resolvedBoxes  — from resolveLayout(...).boxes
 * @param {PageRegion[]}    regions         — classified regions with source bboxes
 * @returns {{ score: number, perRegion: object[] }}
 */
export function compareBoxes(resolvedBoxes, regions) {
    // Build a map of flat tree leaf boxes keyed by id
    const leafBoxes = new Map();
    for (const rb of resolvedBoxes) {
        if (rb.node?.id) {
            leafBoxes.set(rb.node.id, rb.box);
        }
    }

    const results = [];
    let totalScore = 0;
    let matched = 0;

    for (const r of regions) {
        if (!r.id || !leafBoxes.has(r.id)) continue;
        const predicted = leafBoxes.get(r.id);
        const actual = r.bbox;
        if (!actual) continue;

        const ioU = _computeIoU(predicted, actual);
        const centerOffset = _centerOffset(predicted, actual, actual.w, actual.h);
        const regionScore = ioU * 0.7 + (1 - Math.min(centerOffset, 1)) * 0.3;
        results.push({ id: r.id, ioU, centerOffset, score: regionScore });
        totalScore += regionScore;
        matched++;
    }

    const score = matched > 0 ? totalScore / matched : 0;
    return { score, perRegion: results };
}

function _computeIoU(a, b) {
    const xOverlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const yOverlap = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const intersection = xOverlap * yOverlap;
    const union = a.w * a.h + b.w * b.h - intersection;
    return union > 0 ? intersection / union : 0;
}

function _centerOffset(a, b, refW, refH) {
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    const bx = b.x + b.w / 2, by = b.y + b.h / 2;
    const dx = (ax - bx) / (refW || 1);
    const dy = (ay - by) / (refH || 1);
    return Math.sqrt(dx * dx + dy * dy);
}
