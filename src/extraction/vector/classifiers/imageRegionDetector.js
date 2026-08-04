// imageRegionDetector.js
// Detects IMAGE regions: the picture-shaped areas of a page.
//
// A "picture" in a PDF is not one operator. The same visual figure arrives as
// any mix of:
//   • one raster XObject (the easy case)
//   • hundreds of tiny image masks — stipple fills, bitmap glyph cells, tiled
//     scans. A wiring diagram in a service manual can be 458 masks of 1×9 px.
//   • vector strokes (see figureDetector), often for the frame and arrows of a
//     diagram whose labels are raster
//   • all of the above in ONE figure
//
// Filtering fragments by their own size deletes the mask case entirely, and
// running raster and vector detection separately shreds a mixed figure into
// interleaved slices. Clustering by bounding-box proximity does not rescue it
// either: on a page of stacked sub-figures the gap BETWEEN two figures is
// routinely smaller than the internal gap inside one, so no single distance
// separates them.
//
// So detection runs over the INK: mark the cells that raster fragments and
// figure strokes cover, then flood fill. Two figures separated by a caption are
// different components because no ink connects them, however close their boxes
// sit; one figure's parts stay joined by its own arrows and frame.
//
// The `vectorFigure` flag is preserved on every region — the crop path and
// downstream consumers key off it, and figureDetector.js remains the home of
// the stroke test and of standalone vector-figure detection.

import { RegionType } from './regionTypes.js';
import { isFigureStroke } from './figureDetector.js';

// Coarse grid for ink connectivity. Matches the figure detector's resolution.
const CELL_PX        = 16;
const MIN_SEGS       = 30;   // vector-only: enough strokes to be a drawing
const MIN_DIAG_FRAC  = 0.25; // vector-only: figure-stroke share of segments
const MAX_TEXT_COVER = 0.35; // vector-only: above this it is a text panel

// A real picture is at least this big in both axes once assembled.
const MIN_REGION_DIM = 20;

/**
 * Detect pictures as connected areas of INK, raster and vector together.
 *
 * This replaces bbox-proximity clustering, which cannot work here: on a page of
 * stacked sub-figures the gap BETWEEN two figures is routinely smaller than the
 * internal gap inside one of them, so no single distance separates them. Any
 * threshold that joins one figure's parts also welds it to its neighbour.
 *
 * Flood fill over the ink itself has no such threshold. Two figures separated
 * by a caption band are separate components because there is no ink between
 * them, however close their bounding boxes sit. One figure's rows stay joined
 * because its own arrows and frame are ink that bridges them.
 *
 * Raster fragments mark every cell they cover, so a picture painted as hundreds
 * of 1×9 masks marks a solid blob rather than vanishing under a size filter.
 */
export function detectPictureRegions(imageMeta, segments, textMeta, viewport, scale) {
    const W = Math.max(1, Math.ceil(viewport.width / CELL_PX));
    const H = Math.max(1, Math.ceil(viewport.height / CELL_PX));
    const marked = new Uint8Array(W * H);
    const rasterCell = new Uint8Array(W * H);
    let anyMark = false;

    const cellX = px => Math.min(W - 1, Math.max(0, Math.floor(px / CELL_PX)));
    const cellY = py => Math.min(H - 1, Math.max(0, Math.floor(py / CELL_PX)));

    // Raster ink: fill every cell the fragment covers.
    const frags = imageMeta.filter(m => m.bbox && m.bbox.w > 0 && m.bbox.h > 0);
    for (const m of frags) {
        const b = m.bbox;
        for (let cy = cellY(b.y); cy <= cellY(b.y + b.h); cy++) {
            for (let cx = cellX(b.x); cx <= cellX(b.x + b.w); cx++) {
                marked[cy * W + cx] = 1;
                rasterCell[cy * W + cx] = 1;
                anyMark = true;
            }
        }
    }

    // Vector ink. The figure-stroke test alone (multi-segment AND not clean
    // H/V) is too strict to trace a drawing's shape: an isometric line drawing
    // is mostly axis-aligned, so only its few diagonals mark cells and the
    // figure breaks into a scatter of tiny components. Short axis-aligned
    // strokes from a multi-segment subpath are drawing ink too — what the
    // strict test exists to exclude is table RULING, which is long. Length is
    // the discriminator, so admit short H/V strokes as well.
    const shortStroke = scale.S * 4;
    for (const s of segments) {
        const drawing = isFigureStroke(s) ||
            (s.srcSegCount > 1 && Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < shortStroke);
        if (!drawing) continue;
        marked[cellY((s.y1 + s.y2) / 2) * W + cellX((s.x1 + s.x2) / 2)] = 1;
        anyMark = true;
    }
    if (!anyMark) return [];

    // 1-cell dilation so nearly-touching ink joins one component.
    const dilated = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (!marked[y * W + x]) continue;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx, ny = y + dy;
                    if (nx >= 0 && nx < W && ny >= 0 && ny < H) dilated[ny * W + nx] = 1;
                }
            }
        }
    }

    const compId = new Int32Array(W * H).fill(-1);
    const comps = [];
    for (let i = 0; i < W * H; i++) {
        if (!dilated[i] || compId[i] !== -1) continue;
        const id = comps.length;
        const comp = { x0: W, y0: H, x1: 0, y1: 0, rasterCells: 0 };
        const stack = [i];
        compId[i] = id;
        while (stack.length) {
            const c = stack.pop();
            const cy = Math.floor(c / W), cx = c % W;
            if (rasterCell[c]) comp.rasterCells++;
            if (cx < comp.x0) comp.x0 = cx;
            if (cy < comp.y0) comp.y0 = cy;
            if (cx > comp.x1) comp.x1 = cx;
            if (cy > comp.y1) comp.y1 = cy;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = cx + dx, ny = cy + dy;
                    if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                    const n = ny * W + nx;
                    if (dilated[n] && compId[n] === -1) { compId[n] = id; stack.push(n); }
                }
            }
        }
        comps.push(comp);
    }

    const out = [];
    for (let ci = 0; ci < comps.length; ci++) {
        const comp = comps[ci];
        const bx0 = comp.x0 * CELL_PX, by0 = comp.y0 * CELL_PX;
        const bx1 = (comp.x1 + 1) * CELL_PX, by1 = (comp.y1 + 1) * CELL_PX;

        // True extents from the members themselves, so a stroke or fragment
        // that starts inside the component but reaches past the cell grid is
        // not clipped.
        let segCount = 0, diagCount = 0;
        let ex0 = Infinity, ey0 = Infinity, ex1 = -Infinity, ey1 = -Infinity;
        const take = (x0, y0, x1, y1) => {
            ex0 = Math.min(ex0, x0); ey0 = Math.min(ey0, y0);
            ex1 = Math.max(ex1, x1); ey1 = Math.max(ey1, y1);
        };
        // Extents come from everything inside the component's cell box, not
        // only from cells the component owns. A drawing's frame and leader
        // lines are clean H/V strokes, which never mark ink cells (that test
        // exists to keep table ruling out of figures) — but they ARE part of
        // the picture. Excluding them clips the region, and any stroke left
        // outside then leaks back into the table pool and reconstructs a
        // phantom grid over the diagram.
        for (const s of segments) {
            const mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2;
            if (mx < bx0 || mx > bx1 || my < by0 || my > by1) continue;
            segCount++;
            if (isFigureStroke(s)) diagCount++;
            take(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2),
                 Math.max(s.x1, s.x2), Math.max(s.y1, s.y2));
        }
        const memberIds = [];
        let allAxisAligned = true;
        for (const m of frags) {
            const b = m.bbox;
            const mx = b.x + b.w / 2, my = b.y + b.h / 2;
            if (compId[cellY(my) * W + cellX(mx)] !== ci) continue;
            memberIds.push(m.id);
            if (m.axisAligned === false) allAxisAligned = false;
            take(b.x, b.y, b.x + b.w, b.y + b.h);
        }
        if (!memberIds.length && !segCount) continue;

        const bbox = {
            x: Math.max(0, ex0),
            y: Math.max(0, ey0),
            w: Math.min(viewport.width, ex1) - Math.max(0, ex0),
            h: Math.min(viewport.height, ey1) - Math.max(0, ey0),
        };
        if (bbox.w < MIN_REGION_DIM || bbox.h < MIN_REGION_DIM) continue;

        // Raster-backed components are pictures by definition. Vector-only ones
        // must still clear the drawing gates, or a table's ruling and a bordered
        // text panel would both read as figures.
        const rasterBacked = memberIds.length > 0;
        if (!rasterBacked) {
            if (segCount < MIN_SEGS) continue;
            if (diagCount / segCount < MIN_DIAG_FRAC) continue;
            let textArea = 0;
            for (const tm of textMeta) {
                if (!tm.str?.trim()) continue;
                const cx = tm.vx + (tm.vWidth || 0) / 2;
                if (cx >= bbox.x && cx <= bbox.x + bbox.w &&
                    tm.vy >= bbox.y && tm.vy <= bbox.y + bbox.h) {
                    textArea += (tm.vWidth || 0) * (tm.vFont || scale.S);
                }
            }
            if (textArea / (bbox.w * bbox.h) > MAX_TEXT_COVER) continue;
        }

        const hasVector = diagCount > 0;
        out.push({
            type: RegionType.IMAGE,
            id: memberIds.length === 1 && !hasVector ? memberIds[0] : `picture_${ci}`,
            bbox,
            yCenter: bbox.y + bbox.h / 2,
            textItemIndices: [],
            columnIndex: -1,
            sourceImageIds: memberIds,
            hasRaster: rasterBacked,
            axisAligned: allAxisAligned,
            // True means "crop this area from the page render" — required for
            // vector art and for any picture assembled from several fragments.
            vectorFigure: hasVector || memberIds.length > 1,
            composite: memberIds.length > 1 || (rasterBacked && hasVector),
            algorithm: rasterBacked && hasVector ? 'mixed-figure'
                : rasterBacked ? 'raster-image' : 'vector-figure',
        });
    }

    return _mergeOverlapping(out);
}

// Components are disjoint on the cell grid, but their extents are expanded to
// the true reach of their member strokes, and a drawing's leader lines run well
// past its ink. Two regions that end up overlapping are therefore the same
// picture seen from two blobs — never two figures, since separate figures do
// not overlap. Fold them together rather than emitting one nested in another.
function _mergeOverlapping(regions) {
    const overlaps = (a, b) => {
        const iw = Math.min(a.bbox.x + a.bbox.w, b.bbox.x + b.bbox.w) - Math.max(a.bbox.x, b.bbox.x);
        const ih = Math.min(a.bbox.y + a.bbox.h, b.bbox.y + b.bbox.h) - Math.max(a.bbox.y, b.bbox.y);
        if (iw <= 0 || ih <= 0) return false;
        const smaller = Math.min(a.bbox.w * a.bbox.h, b.bbox.w * b.bbox.h) || 1;
        return (iw * ih) / smaller > 0.25;
    };

    // Run to a fixed point. Absorbing a region GROWS the survivor, which can
    // bring it over a region already emitted earlier in the pass — a single
    // sweep leaves that one stranded inside its own parent.
    let out = regions.map(r => ({ ...r }));
    let changed = true;
    while (changed) {
        changed = false;
        const next = [];
        for (const r of out) {
            const hit = next.find(o => overlaps(o, r));
            if (!hit) { next.push(r); continue; }
            const x0 = Math.min(hit.bbox.x, r.bbox.x), y0 = Math.min(hit.bbox.y, r.bbox.y);
            const x1 = Math.max(hit.bbox.x + hit.bbox.w, r.bbox.x + r.bbox.w);
            const y1 = Math.max(hit.bbox.y + hit.bbox.h, r.bbox.y + r.bbox.h);
            hit.bbox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
            hit.yCenter = y0 + (y1 - y0) / 2;
            hit.sourceImageIds = [...hit.sourceImageIds, ...r.sourceImageIds];
            hit.hasRaster = hit.hasRaster || r.hasRaster;
            hit.vectorFigure = true;
            hit.composite = true;
            changed = true;
        }
        out = next;
    }
    return out;
}

export function filterTableSegs(segments, underlineSegIds, isInsideImage, viewport = null) {
    return segments.filter(s => {
        if (underlineSegIds.has(s.id)) return false;
        if (isInsideImage(s.x1, s.y1) && isInsideImage(s.x2, s.y2)) return false;
        if (viewport && isPageEdgeSeg(s, viewport)) return false;
        return true;
    });
}

// A rule lying on the sheet edge and running its full length is the page
// border, not table ruling. Left in the pool it merges with any table whose Y
// range it overlaps, adding two phantom columns and stretching the table's bbox
// to the full page — which then reads as a table that swallowed the layout.
function isPageEdgeSeg(s, viewport) {
    const { width: W, height: H } = viewport;
    const edge = 0.01;
    const full = 0.9;

    const x = (s.x1 + s.x2) / 2, y = (s.y1 + s.y2) / 2;
    const dx = Math.abs(s.x2 - s.x1), dy = Math.abs(s.y2 - s.y1);

    const onLeftOrRight = x <= W * edge || x >= W * (1 - edge);
    const onTopOrBottom = y <= H * edge || y >= H * (1 - edge);

    if (dy > dx && dy >= H * full && onLeftOrRight) return true;
    if (dx > dy && dx >= W * full && onTopOrBottom) return true;
    return false;
}
