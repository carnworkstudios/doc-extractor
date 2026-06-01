// imageRegionDetector.js
// Filters significant image regions, merges overlapping/adjacent clusters,
// and returns IMAGE-type region objects.
// Extracted from contextClassifier.js lines 179-236.

import { RegionType } from './regionTypes.js';

const MIN_IMG_DIM = 20;
const MERGE_GAP   = 8;

export function detectImageRegions(imageMeta) {
    const significantImages = imageMeta.filter(img =>
        img.bbox.w >= MIN_IMG_DIM && img.bbox.h >= MIN_IMG_DIM
    );

    significantImages.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);

    const mergedImages = [];
    for (const img of significantImages) {
        const { x, y, w, h } = img.bbox;
        const right  = x + w;
        const bottom = y + h;

        const cluster = mergedImages.find(c =>
            x <= c.right  + MERGE_GAP &&
            right  >= c.x - MERGE_GAP &&
            y <= c.bottom + MERGE_GAP &&
            bottom >= c.y - MERGE_GAP
        );
        if (cluster) {
            cluster.x      = Math.min(cluster.x,      x);
            cluster.y      = Math.min(cluster.y,      y);
            cluster.right  = Math.max(cluster.right,  right);
            cluster.bottom = Math.max(cluster.bottom, bottom);
        } else {
            mergedImages.push({ id: img.id, x, y, right, bottom });
        }
    }

    const imageBBoxes = imageMeta.map(img => img.bbox);
    const isInsideImage = (x, y) => imageBBoxes.some(b =>
        x >= b.x - 5 && x <= b.x + b.w + 5 &&
        y >= b.y - 5 && y <= b.y + b.h + 5
    );

    const regions = [];
    for (const c of mergedImages) {
        const bbox = { x: c.x, y: c.y, w: c.right - c.x, h: c.bottom - c.y };
        regions.push({
            type: RegionType.IMAGE,
            id: c.id,
            bbox,
            textItemIndices: [],
            yCenter: bbox.y + bbox.h / 2,
            columnIndex: -1,
        });
    }

    return { regions, imageBBoxes, isInsideImage };
}

export function filterTableSegs(segments, underlineSegIds, isInsideImage) {
    return segments.filter(s => {
        if (underlineSegIds.has(s.id)) return false;
        if (isInsideImage(s.x1, s.y1) && isInsideImage(s.x2, s.y2)) return false;
        return true;
    });
}
