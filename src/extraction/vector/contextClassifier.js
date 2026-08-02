// contextClassifier.js — orchestrator
//
// Builds the shared spatial context (PageGraph), then calls each classifier
// sub-module in tier order, merges results, and returns the region manifest.
//
// Previously a 1,150-line monolith. Now each detection algorithm lives in
// its own file under classifiers/ and receives PageGraph for spatial queries.
//
// Safe to run inside a Web Worker.

import { PageScale } from './pageScale.js';
import { readStructTree } from './structTreeReader.js';
import { PageGraph } from './spatialGraph.js';
import { detectPageColumns, splitByColumns } from './classifiers/columnSplitDetector.js';
import { detectUnderlines } from './classifiers/underlineDetector.js';
import { detectImageRegions, filterTableSegs } from './classifiers/imageRegionDetector.js';
import { detectVectorFigures } from './classifiers/figureDetector.js';
import { detectLatticeTables } from './classifiers/latticeDetector.js';
import { detectStreamTableRegions } from './classifiers/streamTableDetector.js';
import { detectBoxRegions } from './classifiers/boxDetector.js';
import { detectDividers } from './classifiers/dividerDetector.js';
import { detectHeadersFooters } from './classifiers/headerFooterDetector.js';
import { classifyHeading } from './classifiers/headingDetector.js';
import { classifyList, BULLET_RE as _BULLET_RE, ORDERED_RE as _ORDERED_RE } from './classifiers/listDetector.js';
import { RegionType } from './classifiers/regionTypes.js';
import { LatticeReconstructor } from './latticeReconstructor.js';

export { detectPageColumns, splitByColumns } from './classifiers/columnSplitDetector.js';
export { RegionType } from './classifiers/regionTypes.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toViewport(vpTransform, pdfX, pdfY) {
    return [
        vpTransform[0] * pdfX + vpTransform[2] * pdfY + vpTransform[4],
        vpTransform[1] * pdfX + vpTransform[3] * pdfY + vpTransform[5],
    ];
}

function insideBBox(px, py, bbox, pad = 0) {
    return px >= bbox.x - pad && px <= bbox.x + bbox.w + pad &&
        py >= bbox.y - pad && py <= bbox.y + bbox.h + pad;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function classifyPage(segments, textItems, viewport, pageWidthPt, imageMeta = [], opts = {}) {
    const filledRects  = opts.filledRects  ?? [];
    const fontStyleMap = opts.fontStyleMap ?? {};
    const rawStructTree = opts.structTree  ?? null;
    const OPS           = opts.OPS         ?? null;
    const vpT = viewport.transform;
    const scaleX = Math.hypot(vpT[0], vpT[1]) || 1;
    const scaleY = Math.hypot(vpT[2], vpT[3]) || 1;

    // ── 1. Convert all text items to viewport coordinates ────────────────────
    const textMeta = textItems.map((item, idx) => {
        const [vx, vy] = toViewport(vpT, item.transform[4], item.transform[5]);
        const fontSizePt = Math.abs(item.transform?.[3] || 12);
        const widthPt = item.width || (fontSizePt * 0.5 * (item.str?.length || 1));
        const fn = item.fontName || '';
        const fStyle = fontStyleMap[fn];
        const syntheticItalic = Math.abs(item.transform[2]) > 0.05;
        return {
            idx,
            vx, vy,
            vWidth: widthPt * scaleX,
            vFont: fontSizePt * scaleY,
            fontSize: fontSizePt,
            fontName: fn,
            str: item.str || '',
            underlined: false,
            bold:   fStyle?.bold   ?? false,
            italic: fStyle?.italic ?? syntheticItalic,
        };
    });

    const scale = new PageScale(textMeta, viewport, opts.docScale);
    if (opts.headingScale !== undefined) scale.HEADING_SCALE = opts.headingScale;

    // Apply per-page threshold overrides from the Analysis panel sliders.
    // Only the four exposed ratios can be overridden; all other PageScale
    // values (S, vScale, computed getters) remain calibrated to this page.
    const so = opts.pipeline?.scaleOverrides;
    if (so) {
        if (so.R_Y_BAND          !== undefined) scale.R_Y_BAND          = so.R_Y_BAND;
        if (so.R_PARA_GAP        !== undefined) scale.R_PARA_GAP        = so.R_PARA_GAP;
        if (so.R_COL_GAP_MIN     !== undefined) scale.R_COL_GAP_MIN     = so.R_COL_GAP_MIN;
        if (so.STREAM_CONFIDENCE !== undefined) scale.STREAM_CONFIDENCE = so.STREAM_CONFIDENCE;
    }

    const tablePad = opts.tablePad ?? scale.tablePadPx;
    const skip = opts.pipeline?.skip ?? new Set();

    // ── Tier 1: Structure tree (highest fidelity) ─────────────────────────────
    let structTableIndices = new Set();
    let columnHintX = null;

    if (rawStructTree && OPS) {
        try {
            const { structRegions, hasTable, columnHint } = readStructTree(
                rawStructTree, opts._opList ?? null, textMeta, OPS
            );
            if (hasTable && structRegions.length > 0) {
                for (const sr of structRegions) {
                    for (const idx of sr.textItemIndices) structTableIndices.add(idx);
                }
                opts._structRegions = structRegions;
            }
            columnHintX = columnHint ?? null;
        } catch (_) {}
    }

    // ── 2. Classify H-segments: underline vs. table border ───────────────────
    const eps = 4;
    const hSegs = [], vSegs = [];

    for (const s of segments) {
        const dx = Math.abs(s.x2 - s.x1);
        const dy = Math.abs(s.y2 - s.y1);
        if (dy <= eps && dx > eps) hSegs.push(s);
        else if (dx <= eps && dy > eps) vSegs.push(s);
    }

    const underlineSegIds = detectUnderlines(hSegs, textMeta, scale, opts);

    // ── 3. Image regions + filtered segments ────────────────────────────────
    const { regions: imageRegions, imageBBoxes, isInsideImage } = detectImageRegions(imageMeta);

    // ── 3.5. Vector line-art figures (diagrams drawn as paths, not XObjects) ─
    // Detected BEFORE lattice so a wiring diagram's wire runs can't be
    // reconstructed into a bogus table grid. Their segments are excluded from
    // the table pool and their label text is claimed for the figure.
    const figureRegions = (!skip.has('IMAGE'))
        ? detectVectorFigures(segments, textMeta, viewport, scale, isInsideImage)
        : [];

    const insideFigure = (x, y) => figureRegions.some(f =>
        x >= f.bbox.x - 2 && x <= f.bbox.x + f.bbox.w + 2 &&
        y >= f.bbox.y - 2 && y <= f.bbox.y + f.bbox.h + 2
    );
    const isInsideImageOrFigure = (x, y) => isInsideImage(x, y) || insideFigure(x, y);

    // Raster images swallowed by a figure bbox are dropped: the figure crop
    // renders the whole area, including the embedded raster content.
    const keptImageRegions = imageRegions.filter(ir => {
        if (!figureRegions.length) return true;
        const b = ir.bbox;
        return !figureRegions.some(f => {
            const iw = Math.min(b.x + b.w, f.bbox.x + f.bbox.w) - Math.max(b.x, f.bbox.x);
            const ih = Math.min(b.y + b.h, f.bbox.y + f.bbox.h) - Math.max(b.y, f.bbox.y);
            return iw > 0 && ih > 0 && (iw * ih) / (b.w * b.h || 1) > 0.6;
        });
    });

    const tableSegs = filterTableSegs(segments, underlineSegIds, isInsideImageOrFigure);
    const regions = [...keptImageRegions, ...figureRegions];

    // ── 4. Build PageGraph (shared spatial context) ─────────────────────────
    const pageGraph = PageGraph.build(segments, textMeta, viewport, imageBBoxes, underlineSegIds);

    // ── Custom Override Regions ──────────────────────────────────────────────
    const customRegions = opts.pipeline?.customRegions || [];
    const customInjectedRegions = [];
    const customClaimedTextIndices = new Set();

    // ── Deleted region exclusion ──────────────────────────────────────────────
    // skip:true means the user deleted this specific region. Pre-claim its text
    // items so no classifier can pick them up, AND remove its segments from
    // tableSegs so the lattice/stream detectors can't reconstruct a region there.
    // The text items remain in textMeta (unclaimed), so they fall through to
    // _classifyBucket and get re-classified naturally.
    const deletedBboxes = customRegions.filter(cr => cr.skip && cr.bbox).map(cr => cr.bbox);
    if (deletedBboxes.length) {
        const pad = scale.tablePadPx ?? 5;
        for (const tm of textMeta) {
            if (!tm.str.trim()) continue;
            if (deletedBboxes.some(b => insideBBox(tm.vx, tm.vy, b, pad))) {
                customClaimedTextIndices.add(tm.idx);
            }
        }
        // Remove segments inside deleted bboxes from tableSegs so lattice/stream
        // detectors can't reconstruct a region over the deleted area.
        const eps2 = 2;
        const filteredTableSegs = tableSegs.filter(s =>
            !deletedBboxes.some(b =>
                insideBBox(s.x1, s.y1, b, eps2) && insideBBox(s.x2, s.y2, b, eps2)
            )
        );
        // Reassign tableSegs for all downstream classifier steps
        tableSegs.length = 0;
        for (const s of filteredTableSegs) tableSegs.push(s);
    }

    for (const cr of customRegions) {
        if (!cr.bbox) continue;
        if (cr.skip) continue;  // already handled above — nothing to inject

        const bbox = cr.bbox;
        const type = cr.type;

        // Find text items and segments inside this custom region
        const pad = scale.tablePadPx ?? 5;
        const textIndices = [];
        const matchedItems = [];
        for (const tm of textMeta) {
            if (tm.str.trim() && insideBBox(tm.vx, tm.vy, bbox, pad)) {
                textIndices.push(tm.idx);
                matchedItems.push(tm);
                customClaimedTextIndices.add(tm.idx);
            }
        }

        const matchedTableSegs = [];
        const epsS = 2;
        for (const s of segments) {
            if (insideBBox(s.x1, s.y1, bbox, epsS) && insideBBox(s.x2, s.y2, bbox, epsS)) {
                matchedTableSegs.push(s);
            }
        }

        // Build specific structural properties for tables
        let lattice = null;
        if (type === RegionType.LATTICE_TABLE || type === RegionType.TABLE) {
            const reconstructor = new LatticeReconstructor(matchedTableSegs, {
                eps: 5, scale, textMeta, pageHeight: viewport.height,
            });
            const lattices = reconstructor.reconstructAll();
            lattice = lattices[0] || {
                bbox,
                cols: [bbox.x, bbox.x + bbox.w],
                rows: [bbox.y, bbox.y + bbox.h],
                cells: [[{ x1: bbox.x, y1: bbox.y, x2: bbox.x + bbox.w, y2: bbox.y + bbox.h, textIndices }]]
            };
        } else if (type === RegionType.STREAM_TABLE) {
            const bands = _groupByYBand(matchedItems, scale.yBandTolPx);
            if (bands.length > 0) {
                const colTol = scale.colTolPx;
                const tagged = [];
                for (let bi = 0; bi < bands.length; bi++) {
                    for (const item of bands[bi].items) {
                        tagged.push({
                            vx: item.vx, vy: item.vy, vWidth: item.vWidth || 0,
                            str: item.str || '', _band: bi
                        });
                    }
                }
                const xClusters = _clusterByX(tagged, colTol);
                const colAnchors = [];
                for (const cluster of xClusters) {
                    colAnchors.push({ x: _mean(cluster.map(i => i.vx)), items: cluster });
                }
                colAnchors.sort((a, b) => a.x - b.x);

                let cols, rows;
                if (colAnchors.length === 0) {
                    cols = [bbox.x, bbox.x + bbox.w];
                } else {
                    const gutters = _detectGutters(bands, 0.6, scale.S * 0.15) || [];
                    cols = [bbox.x];
                    for (let i = 1; i < colAnchors.length; i++) {
                        const lo = colAnchors[i - 1].x;
                        const hi = colAnchors[i].x;
                        const gutter = gutters.find(x => x > lo && x < hi);
                        cols.push(gutter ?? (lo + hi) / 2);
                    }
                    cols.push(bbox.x + bbox.w);
                }

                rows = [bbox.y];
                for (let i = 1; i < bands.length; i++) {
                    rows.push((bands[i - 1].y + bands[i].y) / 2);
                }
                rows.push(bbox.y + bbox.h);

                // detectionMethod 'user-drawn': this grid came from a region the
                // user drew, not from streamDetector's scored candidate search.
                // The 1.0 is "the human said so", NOT a measurement — tableBuilder
                // only publishes a data-confidence for genuinely measured sources.
                lattice = {
                    rows, cols, hLines: [], vLines: [], bbox, border: false,
                    detectionMethod: 'user-drawn', confidence: 1.0
                };
            } else {
                lattice = {
                    rows: [bbox.y, bbox.y + bbox.h],
                    cols: [bbox.x, bbox.x + bbox.w],
                    hLines: [], vLines: [], bbox, border: false,
                    detectionMethod: 'user-drawn', confidence: 1.0
                };
            }
        }

        customInjectedRegions.push({
            id: cr.id,
            type,
            bbox,
            yCenter: bbox.y + bbox.h / 2,
            textItemIndices: textIndices,
            columnIndex: cr.columnIndex ?? -1,
            lattice,
            boxRole: cr.boxRole ?? 'generic',
            fillColor: cr.fillColor ?? null,
            listOrdered: cr.listOrdered ?? false,
            algorithm: 'custom-override'
        });
    }

    // Pre-seed assignedTextIndices with items claimed by Tier 1 struct regions and custom regions
    const assignedTextIndices = new Set(structTableIndices);
    for (const idx of customClaimedTextIndices) {
        assignedTextIndices.add(idx);
    }

    // Claim figure label text: items whose center sits inside a vector figure
    // belong to the figure crop, not to the paragraph flow.
    if (figureRegions.length) {
        for (const tm of textMeta) {
            if (!tm.str.trim() || assignedTextIndices.has(tm.idx)) continue;
            const cx = tm.vx + (tm.vWidth || 0) / 2;
            const fig = figureRegions.find(f =>
                cx >= f.bbox.x && cx <= f.bbox.x + f.bbox.w &&
                tm.vy >= f.bbox.y && tm.vy <= f.bbox.y + f.bbox.h
            );
            if (fig) {
                fig.textItemIndices.push(tm.idx);
                assignedTextIndices.add(tm.idx);
            }
        }
    }

    // Claim text inside INSET raster images the same way. The 4x page-render
    // crop bakes overlapping text into the image pixels, so extracting it
    // again as paragraphs duplicates content at positions where nothing
    // belongs in the flow (chart axis labels, annotated screenshots).
    //
    // Background rasters must NOT claim: design PDFs draw real body text over
    // full-page images, and claiming it would delete the page's content. Two
    // guards, both required:
    //   - geometry: the image is an inset (≤ 35% of page area, not a
    //     near-full-width band)
    //   - content: the image swallows < 40% of the page's unclaimed text
    if (!skip.has('IMAGE') && keptImageRegions.length) {
        const pageArea = viewport.width * viewport.height;
        const totalUnclaimed = textMeta.filter(
            tm => tm.str.trim() && !assignedTextIndices.has(tm.idx)).length;
        // Poster page: text-sparse page dominated by imagery (covers, hero
        // slides). The whole page is one designed unit; its text belongs in
        // the crop. Article pages (real body text over a decorative
        // background) have hundreds of items and must keep their text.
        const POSTER_MAX_ITEMS = 60;
        for (const ir of keptImageRegions) {
            const b = ir.bbox;
            const isInset = (b.w * b.h) / pageArea <= 0.35 &&
                !(b.w >= viewport.width * 0.85 && b.h >= viewport.height * 0.5);
            const inside = [];
            for (const tm of textMeta) {
                if (!tm.str.trim() || assignedTextIndices.has(tm.idx)) continue;
                const cx = tm.vx + (tm.vWidth || 0) / 2;
                if (cx >= b.x && cx <= b.x + b.w && tm.vy >= b.y && tm.vy <= b.y + b.h) {
                    inside.push(tm.idx);
                }
            }
            if (!inside.length) continue;
            const posterMode = !isInset &&
                totalUnclaimed <= POSTER_MAX_ITEMS &&
                inside.length >= totalUnclaimed * 0.9;
            if (isInset) {
                // Inset figure: claim its labels unless it would swallow a
                // large share of the page's text (mis-sized bbox safety).
                if (totalUnclaimed > 0 && inside.length / totalUnclaimed >= 0.40) continue;
            } else if (!posterMode) {
                continue;
            }
            for (const idx of inside) {
                ir.textItemIndices.push(idx);
                assignedTextIndices.add(idx);
            }
        }
    }

    // ── 5. Lattice table regions ─────────────────────────────────────────────
    if (!skip.has('LATTICE_TABLE')) {
        const latticeRegions = detectLatticeTables(tableSegs, textMeta, scale, viewport, filledRects, assignedTextIndices, opts);
        for (const r of latticeRegions) regions.push(r);
    }

    // ── 6. Additional image regions from opts ───────────────────────────────
    const extraImageRegions = opts.imageRegions || [];
    for (const img of extraImageRegions) {
        regions.push({
            type: RegionType.IMAGE,
            bbox: img,
            yCenter: img.y + img.h / 2,
            textItemIndices: [],
            columnIndex: -1,
        });
    }

    // ── 7. Stream table detection ───────────────────────────────────────────
    const unclaimedMeta = textMeta.filter(
        tm => !assignedTextIndices.has(tm.idx) && tm.str.trim(),
    );
    if (!skip.has('STREAM_TABLE')) {
        // Pre-detect column zones from unclaimed text so the stream detector
        // can run per column zone rather than mixing items from separate columns.
        // This fast pre-pass uses the same detector as step 10 but on unclaimedMeta only.
        let streamColXs = [];
        if (unclaimedMeta.length > 10) {
            const { splits: preSplits } = detectPageColumns(unclaimedMeta, viewport, scale);
            streamColXs = preSplits.map(s => s.x ?? s).filter(x => x > viewport.width * 0.1 && x < viewport.width * 0.9);
        }
        const streamTables = detectStreamTableRegions(unclaimedMeta, scale, regions, tableSegs, pageGraph, streamColXs);
        for (const lattice of streamTables) {
            if (!lattice?.bbox) continue;
            const bbox = lattice.bbox;
            const tableTextIndices = [];
            for (const tm of unclaimedMeta) {
                if (assignedTextIndices.has(tm.idx)) continue;
                if (insideBBox(tm.vx, tm.vy, bbox, tablePad)) {
                    tableTextIndices.push(tm.idx);
                    assignedTextIndices.add(tm.idx);
                }
            }
            regions.push({
                type: RegionType.STREAM_TABLE,
                bbox,
                yCenter: bbox.y + bbox.h / 2,
                lattice,
                textItemIndices: tableTextIndices,
                columnIndex: -1,
                proximityPx: scale.proximityPx,
            });
        }
    }

    // ── 8. Isolated-rectangle box detection ─────────────────────────────────
    if (!skip.has('BOX')) {
        const boxRegions = detectBoxRegions(hSegs, vSegs, underlineSegIds, textMeta, scale, viewport, regions, filledRects, assignedTextIndices);
        for (const r of boxRegions) regions.push(r);
    }

    // ── 10. Page-level column detection ──────────────────────────────────────
    const remainingMeta = textMeta.filter(
        tm => !assignedTextIndices.has(tm.idx) && tm.str.trim(),
    );

    // Manual splits from the Analysis col-split tool bypass all detection gates.
    // They are injected directly into rawSplits and take priority over everything.
    const manualSplitDefs = opts.pipeline?.manualSplits;
    const vpW0 = viewport.width;
    let rawSplits = (manualSplitDefs?.length)
        ? manualSplitDefs
            .filter(s => s.x > vpW0 * 0.05 && s.x < vpW0 * 0.95)
            .sort((a, b) => a.x - b.x)
            .map(s => ({ x: s.x, leftFraction: s.x / vpW0, rightFraction: 1 - s.x / vpW0 }))
        : [];
    let fullWidthIndices = new Set();

    // If manual splits exist, skip all automatic detection — user's word is final
    if (rawSplits.length) {
        for (const tm of remainingMeta) {
            const itemEnd = tm.vx + (tm.vWidth || 0);
            if (rawSplits.some(sp => tm.vx < sp.x && itemEnd > sp.x)) {
                fullWidthIndices.add(tm.idx);
            }
        }
        // Jump directly to column bucketing — skip geometry + bipartite detection
        const columnSplitsEarly = rawSplits.map(s => s.x);
        _refineFullWidthByLine(remainingMeta, fullWidthIndices, columnSplitsEarly, scale);
        const narrowMeta0 = remainingMeta.filter(tm => !fullWidthIndices.has(tm.idx));
        const fullWidthMeta0 = remainingMeta.filter(tm => fullWidthIndices.has(tm.idx));
        const columnBuckets0 = splitByColumns(narrowMeta0, columnSplitsEarly);
        if (columnSplitsEarly.length > 0) {
            const epsC = 5;
            for (const r of regions) {
                if (r.columnIndex !== -1 || !r.bbox) continue;
                const crossesSplit = columnSplitsEarly.some(sx =>
                    r.bbox.x < sx - epsC && (r.bbox.x + r.bbox.w) > sx + epsC);
                if (r.bbox.w >= viewport.width * 0.65 || crossesSplit) continue;
                const cx = r.bbox.x + r.bbox.w / 2;
                for (let ci = 0; ci <= columnSplitsEarly.length; ci++) {
                    const lo = ci === 0 ? -Infinity : columnSplitsEarly[ci - 1];
                    const hi = ci === columnSplitsEarly.length ? Infinity : columnSplitsEarly[ci];
                    if (cx >= lo && cx < hi) { r.columnIndex = ci; break; }
                }
            }
        }
        const bodyFontSizePt0 = scale.S / scaleY;
        for (let ci = 0; ci < columnBuckets0.length; ci++) {
            const lines = _groupByYBand(columnBuckets0[ci], scale.yBandTolPx);
            _classifyBucket(regions, lines, bodyFontSizePt0, scale, ci, skip);
        }
        if (fullWidthMeta0.length > 0) {
            const lines = _groupByYBand(fullWidthMeta0, scale.yBandTolPx);
            _classifyBucket(regions, lines, bodyFontSizePt0, scale, -1, skip);
        }
        // Divider detection — same post-classification pass as the automatic path
        if (!skip.has('DIVIDER')) {
            const dividerRegions0 = detectDividers(hSegs, underlineSegIds, textMeta, scale, viewport, regions);
            for (const r of dividerRegions0) regions.push(r);
        }
        // Skip to header/footer detection and return
        if (opts._structRegions?.length) {
            for (const sr of opts._structRegions) {
                for (let i = regions.length - 1; i >= 0; i--) {
                    const r = regions[i];
                    if (!r.bbox || r.fromStructTree) continue;
                    if (r.yCenter >= sr.bbox.y && r.yCenter <= sr.bbox.y + sr.bbox.h &&
                        r.bbox.x >= sr.bbox.x - 10 && (r.bbox.x + r.bbox.w) <= sr.bbox.x + sr.bbox.w + 10) {
                        regions.splice(i, 1);
                    }
                }
                regions.push(sr);
            }
        }
        regions.sort((a, b) => a.yCenter - b.yCenter);
        detectHeadersFooters(regions, textMeta, viewport, scale, filledRects, opts.chromeSigs);
        let finalRegions2 = regions;
        const customRegions2 = opts.pipeline?.customRegions || [];
        if (customRegions2.length > 0) {
            finalRegions2 = regions.filter(r => {
                if (!r.bbox || r.algorithm === 'custom-override') return true;
                return !customRegions2.some(cr => {
                    const cb = cr.bbox;
                    if (!cb) return false;
                    const iw = Math.min(r.bbox.x + r.bbox.w, cb.x + cb.w) - Math.max(r.bbox.x, cb.x);
                    const ih = Math.min(r.bbox.y + r.bbox.h, cb.y + cb.h) - Math.max(r.bbox.y, cb.y);
                    if (iw > 0 && ih > 0) {
                        const area = r.bbox.w * r.bbox.h;
                        return area > 0 && (iw * ih) / area > 0.40;
                    }
                    return false;
                });
            });
            for (const cr of customInjectedRegions) finalRegions2.push(cr);
        }
        finalRegions2.sort((a, b) => a.yCenter - b.yCenter);
        return { regions: finalRegions2, textMeta, columnSplits: columnSplitsEarly, rawSplits, scale };
    }

    // No manual splits — fall through to automatic detection below

    const nonEmptyMeta = textMeta.filter(tm => tm.str.trim());
    let columnRules = [];
    if (nonEmptyMeta.length > 0 && vSegs.length > 0) {
        const contentTop    = Math.min(...nonEmptyMeta.map(tm => tm.vy - tm.vFont));
        const contentBottom = Math.max(...nonEmptyMeta.map(tm => tm.vy));
        const contentHeight = contentBottom - contentTop;
        const vpW = viewport.width;

        if (contentHeight > 0) {
            columnRules = vSegs.filter(s => {
                const segLen  = Math.abs(s.y2 - s.y1);
                const midX    = (s.x1 + s.x2) / 2;
                return segLen >= contentHeight * 0.60
                    && midX >= vpW * 0.10
                    && midX <= vpW * 0.90;
            });
        }
    }

    if (columnRules.length > 0) {
        const vpW = viewport.width;
        columnRules.sort((a, b) => a.x1 - b.x1);
        for (const s of columnRules) {
            const midX = (s.x1 + s.x2) / 2;
            rawSplits.push({
                x: midX,
                leftFraction:  midX / vpW,
                rightFraction: (vpW - midX) / vpW,
            });
        }
        for (const tm of remainingMeta) {
            const itemEnd = tm.vx + (tm.vWidth || 0);
            const bridgesAny = rawSplits.some(sp => tm.vx < sp.x && itemEnd > sp.x);
            if (bridgesAny) fullWidthIndices.add(tm.idx);
        }
    } else if (columnHintX !== null) {
        const vpW = viewport.width;
        rawSplits = [{
            x: columnHintX,
            leftFraction:  columnHintX / vpW,
            rightFraction: (vpW - columnHintX) / vpW,
        }];
        fullWidthIndices = new Set();
        for (const tm of remainingMeta) {
            const itemEnd = tm.vx + (tm.vWidth || 0);
            if (tm.vx < columnHintX && itemEnd > columnHintX) fullWidthIndices.add(tm.idx);
        }
    } else {
        const bipartite = detectPageColumns(remainingMeta, viewport, scale);
        rawSplits = bipartite.splits;
        fullWidthIndices = bipartite.fullWidthIndices;
    }

    if (rawSplits.length === 0 && columnRules.length === 0) {
        const allNonEmpty = textMeta.filter(tm => tm.str.trim());
        if (allNonEmpty.length > remainingMeta.length + 4) {
            const { splits: fallbackSplits } = detectPageColumns(allNonEmpty, viewport, scale);
            rawSplits.push(...fallbackSplits);
        }
    }

    // Snap each detected split to the center of the actual coverage gap
    // (the gutter) near it. Detection can land the split coordinate inside a
    // column's ragged-right zone, which makes ordinary body lines "straddle"
    // the split and fall out of their column (N19 p1: split 566 vs true
    // gutter center 598 — every left-column line ending at 581 went
    // full-width). Snapping is bounded to ±3S so it can only correct
    // locally, never invent a different layout.
    for (const sp of rawSplits) {
        const snapped = _snapSplitToGutter(sp.x, remainingMeta, viewport, scale);
        if (snapped !== sp.x) {
            sp.x = snapped;
            sp.leftFraction = snapped / viewport.width;
            sp.rightFraction = 1 - sp.leftFraction;
        }
    }
    const columnSplits = rawSplits.map(s => s.x);

    _refineFullWidthByLine(remainingMeta, fullWidthIndices, columnSplits, scale);

    const narrowMeta = remainingMeta.filter(tm => !fullWidthIndices.has(tm.idx));
    const fullWidthMeta = remainingMeta.filter(tm => fullWidthIndices.has(tm.idx));

    const columnBuckets = splitByColumns(narrowMeta, columnSplits);

    if (columnSplits.length > 0) {
        const vw = viewport.width;
        const epsC = 5;
        for (const r of regions) {
            if (r.columnIndex !== -1 || !r.bbox) continue;
            const crossesSplit = columnSplits.some(sx => r.bbox.x < sx - epsC && (r.bbox.x + r.bbox.w) > sx + epsC);
            if (r.bbox.w >= vw * 0.65 || crossesSplit) continue;
            const cx = r.bbox.x + r.bbox.w / 2;
            for (let ci = 0; ci <= columnSplits.length; ci++) {
                const lo = ci === 0 ? -Infinity : columnSplits[ci - 1];
                const hi = ci === columnSplits.length ? Infinity : columnSplits[ci];
                if (cx >= lo && cx < hi) { r.columnIndex = ci; break; }
            }
        }
    }

    // ── 11. Classify remaining text by column ────────────────────────────────
    const bodyFontSizePt = scale.S / scaleY;

    for (let ci = 0; ci < columnBuckets.length; ci++) {
        const lines = _groupByYBand(columnBuckets[ci], scale.yBandTolPx);
        _classifyBucket(regions, lines, bodyFontSizePt, scale, ci, skip);
    }

    if (fullWidthMeta.length > 0) {
        const lines = _groupByYBand(fullWidthMeta, scale.yBandTolPx);
        _classifyBucket(regions, lines, bodyFontSizePt, scale, -1, skip);
    }

    // ── 11.5. Divider detection — runs AFTER text classification so paragraph/
    //         heading/list regions are present and the bbox-containment guard works.
    if (!skip.has('DIVIDER')) {
        const dividerRegions = detectDividers(hSegs, underlineSegIds, textMeta, scale, viewport, regions);
        for (const r of dividerRegions) regions.push(r);
    }

    // ── 12. Merge Tier 1 struct regions ─────────────────────────────────────
    if (opts._structRegions?.length) {
        for (const sr of opts._structRegions) {
            for (let i = regions.length - 1; i >= 0; i--) {
                const r = regions[i];
                if (!r.bbox || r.fromStructTree) continue;
                if (r.yCenter >= sr.bbox.y && r.yCenter <= sr.bbox.y + sr.bbox.h &&
                    r.bbox.x >= sr.bbox.x - 10 && (r.bbox.x + r.bbox.w) <= sr.bbox.x + sr.bbox.w + 10) {
                    regions.splice(i, 1);
                }
            }
            regions.push(sr);
        }
    }

    // ── 12.5. Overlap filtering and Custom Region Injection ─────────────────
    let finalRegions = regions;
    if (customRegions.length > 0) {
        finalRegions = regions.filter(r => {
            if (!r.bbox || r.algorithm === 'custom-override') return true;
            return !customRegions.some(cr => {
                const cb = cr.bbox;
                if (!cb) return false;
                const iw = Math.min(r.bbox.x + r.bbox.w, cb.x + cb.w) - Math.max(r.bbox.x, cb.x);
                const ih = Math.min(r.bbox.y + r.bbox.h, cb.y + cb.h) - Math.max(r.bbox.y, cb.y);
                if (iw > 0 && ih > 0) {
                    const area = r.bbox.w * r.bbox.h;
                    return area > 0 && (iw * ih) / area > 0.40; // 40% overlap threshold
                }
                return false;
            });
        });
        for (const cr of customInjectedRegions) {
            finalRegions.push(cr);
        }
    }

    // ── 13. Sort all regions top→bottom ─────────────────────────────────────
    finalRegions.sort((a, b) => a.yCenter - b.yCenter);

    // ── 14. Header / Footer detection ───────────────────────────────────────
    detectHeadersFooters(finalRegions, textMeta, viewport, scale, filledRects, opts.chromeSigs);

    // columnSplits returned as plain X array (what pageAssembler expects).
    // rawSplits carries the full {x, leftFraction, rightFraction} objects for
    // callers that need the fractions (geometryWorker postMessage, zone layout).
    return { regions: finalRegions, textMeta, columnSplits: rawSplits.map(s => s.x), rawSplits, scale };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// Snap a column split X to the center of the widest uncovered interval
// (the real gutter) within ±3S of the candidate. Items wider than 40% of
// the viewport (titles, full-width lines) are excluded from coverage — they
// legitimately span the gutter and would otherwise mask it. Returns the
// original x when no plausible gap (≥ 0.75S wide) exists in the window.
function _snapSplitToGutter(splitX, meta, viewport, scale) {
    const win = scale.S * 3;
    const lo = splitX - win, hi = splitX + win;
    const wideCap = viewport.width * 0.40;
    const iv = [];
    for (const tm of meta) {
        const w = tm.vWidth || 0;
        if (w > wideCap) continue;
        const s = tm.vx, e = tm.vx + w;
        if (e <= lo || s >= hi) continue;
        iv.push([Math.max(s, lo), Math.min(e, hi)]);
    }
    if (!iv.length) return splitX;
    // Minimum-crossings scan. A pure empty-gap search fails whenever a
    // header/footer/title line runs through the page center, so instead
    // count how many items cover each x; full-window spanners add a
    // constant everywhere and cancel out of the argmin. The widest run of
    // minimal coverage is the gutter.
    const STEP = 2;
    const n = Math.floor((hi - lo) / STEP) + 1;
    const counts = new Array(n).fill(0);
    for (const [s, e] of iv) {
        const i0 = Math.max(0, Math.ceil((s - lo) / STEP));
        const i1 = Math.min(n - 1, Math.floor((e - lo) / STEP));
        for (let i = i0; i <= i1; i++) counts[i]++;
    }
    const minC = Math.min(...counts);
    // The gutter is a valley, not necessarily an empty channel — a title or
    // footer line crossing the page center adds 1 everywhere near minC. Take
    // the widest run within a small slack of the minimum; heavy flanks
    // (column body text) sit far above it and bound the run.
    const thr = minC + Math.max(2, Math.ceil(minC * 0.5));
    let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
    for (let i = 0; i <= n; i++) {
        if (i < n && counts[i] <= thr) {
            if (curStart === -1) curStart = i;
            curLen++;
        } else {
            if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
            curStart = -1; curLen = 0;
        }
    }
    // The run must be a real channel (≥ 0.75S wide) and interior to the
    // window — a run touching the edge is unbounded evidence.
    if (bestLen * STEP < scale.S * 0.75) return splitX;
    if (bestStart === 0 || bestStart + bestLen >= n) return splitX;
    return lo + (bestStart + bestLen / 2) * STEP;
}

// Refine which items stay full-width once column splits are known.
//
// Two rules layered on the raw full-width set (wide bands / straddlers):
//  (a) Heading-scale items straddling a split are full-width — centered
//      titles cross the gutter but must never be bucketed into a column.
//      Body-size straddlers are left alone: gutter-bridging equation items
//      belong to their column's flow (raiko-aistats lesson).
//  (b) The fits-in-one-column removal works line-wise, not item-wise: an
//      item that fits a column but is x-contiguous with a kept full-width
//      item on the same baseline is the same visual line ({email}@domain,
//      centered author rows) and stays full-width with it. Clean column
//      bands have no kept anchor, so every item is removed exactly as before.
function _refineFullWidthByLine(remainingMeta, fullWidthIndices, columnSplits, scale) {
    if (!columnSplits.length) return;
    const tol = scale.proximityPx ?? 5;
    const boundaries = [-Infinity, ...columnSplits, Infinity];

    const headingFloor = scale.S * scale.HEADING_SCALE;
    for (const tm of remainingMeta) {
        if (fullWidthIndices.has(tm.idx)) continue;
        const itemEnd = tm.vx + (tm.vWidth || 0);
        if ((tm.vFont || 0) >= headingFloor &&
            columnSplits.some(sx => tm.vx < sx - tol && itemEnd > sx + tol)) {
            fullWidthIndices.add(tm.idx);
        }
    }

    const fits = tm => {
        const itemEnd = tm.vx + (tm.vWidth || 0);
        return boundaries.slice(0, -1).some((lo, ci) =>
            tm.vx >= lo - tol && itemEnd <= boundaries[ci + 1] + tol);
    };

    const fwMeta = remainingMeta.filter(tm => fullWidthIndices.has(tm.idx));
    const bands = [];
    for (const tm of [...fwMeta].sort((a, b) => a.vy - b.vy)) {
        let band = bands.find(b => Math.abs(b.y - tm.vy) <= scale.yBandTolPx);
        if (!band) { band = { y: tm.vy, items: [] }; bands.push(band); }
        band.y = (band.y * band.items.length + tm.vy) / (band.items.length + 1);
        band.items.push(tm);
    }

    const joinGap = scale.S * 2;
    for (const band of bands) {
        const items = band.items.sort((a, b) => a.vx - b.vx);
        const keep = items.map(tm => !fits(tm));
        for (let i = 1; i < items.length; i++) {
            if (keep[i] || !keep[i - 1]) continue;
            const gap = items[i].vx - (items[i - 1].vx + (items[i - 1].vWidth || 0));
            if (gap <= joinGap) keep[i] = true;
        }
        for (let i = items.length - 2; i >= 0; i--) {
            if (keep[i] || !keep[i + 1]) continue;
            const gap = items[i + 1].vx - (items[i].vx + (items[i].vWidth || 0));
            if (gap <= joinGap) keep[i] = true;
        }
        for (let i = 0; i < items.length; i++) {
            if (!keep[i]) fullWidthIndices.delete(items[i].idx);
        }
    }
}

function _classifyBucket(regions, lines, bodyFontSizePt, scale, columnIndex, skip = new Set()) {
    let currentBlock = [];
    let currentType = null;
    let lastMarkerX = null; // left edge of the most recent list-marker line

    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const lineStr = line.items.map(tm => tm.str.trim()).join(' ').trim();
        if (!lineStr) continue;

        let lineType;
        const headingType = classifyHeading(line, bodyFontSizePt, scale);
        const listResult  = classifyList(line, bodyFontSizePt, scale);

        // When a type is skipped, demote it to PARAGRAPH so items stay in the
        // text flow instead of disappearing (they just won't be classified)
        if (headingType && !skip.has('HEADING')) {
            lineType = headingType;
        } else if (listResult && !skip.has('LIST')) {
            lineType = listResult.type;
            lastMarkerX = Math.min(...line.items.map(t => t.vx));
        } else {
            if (skip.has('PARAGRAPH')) continue; // skip means omit from output
            lineType = RegionType.PARAGRAPH;

            // Wrapped list-item continuation: an unmarked line directly under a
            // LIST block, indented past the marker column, belongs to the same
            // list item — keep it in the LIST block instead of splitting a new
            // paragraph region between every marker line. Compared against the
            // marker line's X (not the previous line's) so multi-line wraps hold.
            if (currentType === RegionType.LIST && !skip.has('LIST') &&
                currentBlock.length && lastMarkerX !== null) {
                const thisX = Math.min(...line.items.map(t => t.vx));
                const closeGap = li > 0 && Math.abs(line.y - lines[li - 1].y) <= scale.paraGapPx;
                if (closeGap && thisX > lastMarkerX + scale.S * 0.4) {
                    lineType = RegionType.LIST;
                }
            }
        }

        const hasGap = li > 0 && Math.abs(line.y - lines[li - 1].y) > scale.paraGapPx;

        if (currentType !== null && (lineType !== currentType || hasGap)) {
            _flushBlock(regions, currentBlock, currentType, columnIndex);
            currentBlock = [];
        }

        currentType = lineType;
        currentBlock.push(line);
    }

    if (currentBlock.length) {
        _flushBlock(regions, currentBlock, currentType, columnIndex);
    }
}

function _flushBlock(regions, lines, type, columnIndex = -1) {
    if (!lines.length) return;

    const allIndices = lines.flatMap(l => l.items.map(tm => tm.idx));
    const allItems = lines.flatMap(l => l.items);

    let yMin = Infinity, yMax = -Infinity, xMin = Infinity, xMax = -Infinity;
    for (const tm of allItems) {
        if (tm.vy < yMin) yMin = tm.vy;
        if (tm.vy > yMax) yMax = tm.vy;
        if (tm.vx < xMin) xMin = tm.vx;
        if (tm.vx + tm.vWidth > xMax) xMax = tm.vx + tm.vWidth;
    }

    const avgFontSize = allItems.reduce((s, tm) => s + tm.fontSize, 0) / allItems.length;
    const avgFontVp = allItems.reduce((s, tm) => s + tm.vFont, 0) / allItems.length;

    regions.push({
        type,
        bbox: { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin + avgFontVp },
        yCenter: (yMin + yMax) / 2,
        textItemIndices: allIndices,
        fontSize: avgFontSize,
        columnIndex,
        listOrdered: type === RegionType.LIST
            ? _ORDERED_RE.test(lines[0].items.map(tm => tm.str.trim()).join(' '))
            : undefined,
    });
}

function _groupByYBand(items, yTol) {
    const sorted = [...items].sort((a, b) => a.vy - b.vy);
    const lines = [];

    for (const tm of sorted) {
        let band = null;
        for (const l of lines) {
            if (Math.abs(l.y - tm.vy) <= yTol) { band = l; break; }
        }
        if (band) {
            const n = band.items.length;
            band.y = (band.y * n + tm.vy) / (n + 1);
            band.items.push(tm);
        } else {
            lines.push({ y: tm.vy, items: [tm] });
        }
    }

    for (const l of lines) l.items.sort((a, b) => a.vx - b.vx);
    lines.sort((a, b) => a.y - b.y);
    return lines;
}

export function detectZoneColumns(zoneTextMeta, viewport, scale) {
    if (!zoneTextMeta.length) return { splits: [] };

    const ys = zoneTextMeta.map(tm => tm.vy);
    const zoneHeight = Math.max(...ys) - Math.min(...ys);
    const MIN_ZONE_HEIGHT = scale.S * 1.4 * 10;
    const dropGate3 = zoneHeight >= MIN_ZONE_HEIGHT;

    return detectPageColumns(zoneTextMeta, viewport, scale, { dropGate3 });
}

function _mean(arr) {
    return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function _clusterByX(items, tol) {
    const sorted = [...items].sort((a, b) => a.vx - b.vx);
    const clusters = [];
    for (const item of sorted) {
        let placed = false;
        for (const cluster of clusters) {
            const meanX = cluster.reduce((s, i) => s + i.vx, 0) / cluster.length;
            if (Math.abs(item.vx - meanX) <= tol) {
                cluster.push(item);
                placed = true;
                break;
            }
        }
        if (!placed) clusters.push([item]);
    }
    return clusters;
}

function _detectGutters(bands, minFrac = 0.6, minGutterPx = 4) {
    if (!bands.length) return [];
    const allItems = bands.flatMap(b => b.items);
    if (!allItems.length) return [];

    const maxX = allItems.reduce((m, i) => Math.max(m, i.vx + (i.vWidth || 0)), 0);
    const w = Math.ceil(maxX) + 1;
    if (w < 8) return [];

    const bandCount = new Float32Array(w);
    for (const band of bands) {
        const seen = new Uint8Array(w);
        for (const item of band.items) {
            const x1 = Math.max(0, Math.floor(item.vx));
            const x2 = Math.min(w - 1, Math.ceil(item.vx + (item.vWidth || 0)));
            for (let x = x1; x <= x2; x++) seen[x] = 1;
        }
        for (let x = 0; x < w; x++) bandCount[x] += seen[x];
    }

    const threshold = bands.length * minFrac;
    const gutters = [];
    let gStart = null;

    for (let x = 0; x < w; x++) {
        if (bandCount[x] < threshold) {
            if (gStart === null) gStart = x;
        } else if (gStart !== null) {
            if (x - gStart >= minGutterPx) gutters.push((gStart + x) / 2);
            gStart = null;
        }
    }
    return gutters;
}
