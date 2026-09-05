// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// pathReconciler.js
// Pure transform function that reconciles SubpathRecords into normalized, provenanced PathSegments.

export function curveBboxContrib(p0, p1, p2, p3) {
    const extrema = (a, b, c, d) => {
        const dA = -3*a + 9*b - 9*c + 3*d;
        const dB =  6*a - 12*b + 6*c;
        const dC = -3*a + 3*b;
        const roots = [];
        if (Math.abs(dA) > 1e-6) {
            const disc = dB*dB - 4*dA*dC;
            if (disc >= 0) {
                const sq = Math.sqrt(disc);
                const t1 = (-dB + sq) / (2*dA);
                const t2 = (-dB - sq) / (2*dA);
                if (t1 > 0 && t1 < 1) roots.push(t1);
                if (t2 > 0 && t2 < 1) roots.push(t2);
            }
        } else if (Math.abs(dB) > 1e-6) {
            const t = -dC / dB;
            if (t > 0 && t < 1) roots.push(t);
        }
        const eval_ = t => a*(1-t)**3 + 3*b*t*(1-t)**2 + 3*c*t**2*(1-t) + d*t**3;
        return [a, d, ...roots.map(eval_)];
    };
    const xs = extrema(p0[0], p1[0], p2[0], p3[0]);
    const ys = extrema(p0[1], p1[1], p2[1], p3[1]);
    return {
        xMin: Math.min(...xs), xMax: Math.max(...xs),
        yMin: Math.min(...ys), yMax: Math.max(...ys),
    };
}

function applyMatrix(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function classifySubpath(subpath, vpTransform) {
    const toViewport = (pdfX, pdfY) => {
        const [cx, cy] = applyMatrix(subpath.ctm, pdfX, pdfY);
        return [
            vpTransform[0] * cx + vpTransform[2] * cy + vpTransform[4],
            vpTransform[1] * cx + vpTransform[3] * cy + vpTransform[5],
        ];
    };

    let xMin = Infinity, xMax = -Infinity;
    let yMin = Infinity, yMax = -Infinity;
    
    const expand = (x, y) => {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
    };

    const segsViewport = [];
    let allAxisAligned = true;

    for (const s of subpath.segs) {
        const [x1, y1] = toViewport(s.ax, s.ay);
        const [x2, y2] = toViewport(s.bx, s.by);
        
        expand(x1, y1);
        expand(x2, y2);
        
        const dx = Math.abs(x2 - x1);
        const dy = Math.abs(y2 - y1);
        if (dx > 0.5 && dy > 0.5) allAxisAligned = false;
        
        const isHoriz = dy <= dx;
        let nx1 = x1, ny1 = y1, nx2 = x2, ny2 = y2;
        if (isHoriz && nx1 > nx2) { nx1 = x2; nx2 = x1; ny1 = y2; ny2 = y1; }
        if (!isHoriz && ny1 > ny2) { ny1 = y2; ny2 = y1; nx1 = x2; nx2 = x1; }
        
        segsViewport.push({ ax: nx1, ay: ny1, bx: nx2, by: ny2 });
    }

    for (const c of subpath.curves) {
        const [p0x, p0y] = toViewport(c.p0[0], c.p0[1]);
        const [p1x, p1y] = toViewport(c.p1[0], c.p1[1]);
        const [p2x, p2y] = toViewport(c.p2[0], c.p2[1]);
        const [p3x, p3y] = toViewport(c.p3[0], c.p3[1]);
        
        const b = curveBboxContrib([p0x,p0y], [p1x,p1y], [p2x,p2y], [p3x,p3y]);
        expand(b.xMin, b.yMin);
        expand(b.xMax, b.yMax);
    }
    
    if (xMin === Infinity) return null;
    
    let type = 'FREE_PATH';
    if (allAxisAligned && subpath.curves.length === 0) {
        if (segsViewport.length === 4) {
            type = 'RECT';
        } else if (segsViewport.length > 4) {
            type = 'POLYGON';
        }
    } else if (allAxisAligned && subpath.curves.length > 0 && subpath.closed) {
        type = 'ROUNDED_RECT';
    }

    return {
        type,
        bbox: { xMin, xMax, yMin, yMax },
        segsViewport,
        strokeWidth: subpath.strokeWidth,
        strokeColor: subpath.strokeColor,
        constructPathId: subpath.constructPathId,
        id: subpath.id
    };
}

function normalizeThinRect(classified, eps) {
    if (classified.type !== 'RECT') return classified.segsViewport;
    
    const w = classified.bbox.xMax - classified.bbox.xMin;
    const h = classified.bbox.yMax - classified.bbox.yMin;
    
    if (h < eps) {
        const cy = (classified.bbox.yMin + classified.bbox.yMax) / 2;
        return [{ ax: classified.bbox.xMin, ay: cy, bx: classified.bbox.xMax, by: cy }];
    } else if (w < eps) {
        const cx = (classified.bbox.xMin + classified.bbox.xMax) / 2;
        return [{ ax: cx, ay: classified.bbox.yMin, bx: cx, by: classified.bbox.yMax }];
    } else {
        const x1 = classified.bbox.xMin, x2 = classified.bbox.xMax;
        const y1 = classified.bbox.yMin, y2 = classified.bbox.yMax;
        return [
            { ax: x1, ay: y1, bx: x2, by: y1 },
            { ax: x2, ay: y1, bx: x2, by: y2 },
            { ax: x1, ay: y2, bx: x2, by: y2 },
            { ax: x1, ay: y1, bx: x1, by: y2 }
        ];
    }
}

function mergeDashes(classifiedSubpaths, eps) {
    const freePaths = classifiedSubpaths.filter(c => c.type === 'FREE_PATH');
    const partitions = new Map();
    
    for (const c of freePaths) {
        if (c.segsViewport.length !== 1) continue;
        const s = c.segsViewport[0];
        
        const dx = Math.abs(s.bx - s.ax);
        const dy = Math.abs(s.by - s.ay);
        
        let orientation = '';
        let bandCenter = 0;
        
        if (dy <= eps && dx > eps) {
            orientation = 'H';
            bandCenter = (s.ay + s.by) / 2;
        } else if (dx <= eps && dy > eps) {
            orientation = 'V';
            bandCenter = (s.ax + s.bx) / 2;
        } else {
            continue;
        }
        
        const colorHex = c.strokeColor.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
        const swBucket = Math.round(c.strokeWidth * 2);
        const yBucket = Math.round(bandCenter / eps) * eps;
        
        const key = `${colorHex}|${swBucket}|${orientation}|${yBucket}`;
        
        if (!partitions.has(key)) partitions.set(key, []);
        partitions.get(key).push({
            c,
            s,
            orientation,
            posMin: orientation === 'H' ? Math.min(s.ax, s.bx) : Math.min(s.ay, s.by),
            posMax: orientation === 'H' ? Math.max(s.ax, s.bx) : Math.max(s.ay, s.by)
        });
    }
    
    const mergedResults = [];
    
    for (const [key, group] of partitions.entries()) {
        group.sort((a, b) => a.posMin - b.posMin);
        
        const avgLen = group.reduce((sum, item) => sum + (item.posMax - item.posMin), 0) / group.length;
        const gapThreshold = Math.max(8, 0.4 * avgLen);
        
        let currentRun = null;
        for (const item of group) {
            if (!currentRun) {
                currentRun = { ...item, runMax: item.posMax };
                continue;
            }
            
            const gap = item.posMin - currentRun.runMax;
            if (gap < gapThreshold) {
                currentRun.runMax = Math.max(currentRun.runMax, item.posMax);
            } else {
                mergedResults.push(currentRun);
                currentRun = { ...item, runMax: item.posMax };
            }
        }
        if (currentRun) mergedResults.push(currentRun);
    }
    
    const finalSegments = [];
    let mergeIdCounter = 0;
    
    for (const run of mergedResults) {
        const id = run.c.id;
        let x1, y1, x2, y2;
        if (run.orientation === 'H') {
            x1 = run.posMin; x2 = run.runMax;
            y1 = run.s.ay; y2 = run.s.ay;
        } else {
            x1 = run.s.ax; x2 = run.s.ax;
            y1 = run.posMin; y2 = run.runMax;
        }
        finalSegments.push({
            id: `sm_${id}_${mergeIdCounter++}`,
            x1, y1, x2, y2,
            strokeWidth: run.c.strokeWidth,
            strokeColor: run.c.strokeColor,
            srcType: 'DASH_RUN'
        });
    }
    
    return finalSegments;
}

export function reconcile(subpaths, rawFilledRects, viewport) {
    const eps = 4; // LatticeReconstructor.DEFAULT_OPTS.eps
    const vpTransform = viewport.transform;
    
    const classified = subpaths.map(sp => classifySubpath(sp, vpTransform)).filter(Boolean);
    
    let canonicalSegments = [];
    let segIdCounter = 0;
    
    for (const c of classified.filter(c => c.type === 'RECT')) {
        const segs = normalizeThinRect(c, eps);
        for (const s of segs) {
            canonicalSegments.push({
                id: `s${c.id}_${segIdCounter++}`,
                x1: s.ax, y1: s.ay, x2: s.bx, y2: s.by,
                strokeWidth: c.strokeWidth,
                strokeColor: c.strokeColor,
                srcType: 'RECT'
            });
        }
    }
    
    const mergedDashes = mergeDashes(classified, eps);
    canonicalSegments.push(...mergedDashes);
    
    for (const c of classified) {
        if (c.type === 'ROUNDED_RECT' || c.type === 'POLYGON' || (c.type === 'FREE_PATH' && c.segsViewport.length !== 1)) {
            for (const s of c.segsViewport) {
                canonicalSegments.push({
                    id: `s${c.id}_${segIdCounter++}`,
                    x1: s.ax, y1: s.ay, x2: s.bx, y2: s.by,
                    strokeWidth: c.strokeWidth,
                    strokeColor: c.strokeColor,
                    srcType: c.type,
                    srcSegCount: c.segsViewport.length
                });
            }
        } else if (c.type === 'FREE_PATH' && c.segsViewport.length === 1) {
            const s = c.segsViewport[0];
            const dx = Math.abs(s.bx - s.ax);
            const dy = Math.abs(s.by - s.ay);
            if (dx > eps && dy > eps) {
                canonicalSegments.push({
                    id: `s${c.id}_${segIdCounter++}`,
                    x1: s.ax, y1: s.ay, x2: s.bx, y2: s.by,
                    strokeWidth: c.strokeWidth,
                    strokeColor: c.strokeColor,
                    srcType: c.type,
                    srcSegCount: c.segsViewport.length
                });
            }
        }
    }

    return { segments: canonicalSegments, filledRects: rawFilledRects };
}
