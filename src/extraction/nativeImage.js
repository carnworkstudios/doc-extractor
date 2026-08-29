// nativeImage.js — native (unrendered) page image extraction via pdf.js
//
// The OCR path used to rasterise pages with `page.render()` at RENDER_SCALE.
// For a scanned PDF that is a lossy detour: the page IS an image, already at
// the scanner's resolution, and rendering resamples it to whatever scale the
// caller picked. Measured on Exploring-Chemistry.pdf p.11:
//
//     native            2592 x 3241   (~305 x ~296 dpi, zero resampling)
//     RENDER_SCALE = 2  1584 x  972   (the old path — a 1.6x DOWNSAMPLE)
//     RENDER_SCALE = 4  3168 x 1944   (upsampled from the same 2592 source)
//
// Confidence went 70.3 -> 97.2 moving from scale 2 to scale 4, which was really
// just "stop starving the recogniser". Native reaches that without paying for
// a 4x rasterisation, because PP-OCR's recognition crops are cut from this
// surface at full resolution.
//
// This module deliberately does NOT depend on MuPDF. pdf.js already returns the
// decoded image at source resolution (see `extractPageImage` below); MuPDF was
// a second full PDF engine whose only call site rasterised at 150 dpi — half of
// what is available here.
//
// ── The catch ───────────────────────────────────────────────────────────────
// `page.render()` applies `page.rotate` for free. Native extraction does not:
// it hands back pixels in IMAGE space. Exploring-Chemistry is `rotate: 270`,
// so an unrotated native extract reads bottom-to-top. Rotation is therefore
// applied here, and for 90/180/270 it is an exact transpose — no interpolation,
// no photometric change, which matters because CCITT-G4 bilevel scans are
// unforgiving of resampling.

const ROT = { 0: 0, 90: 90, 180: 180, 270: 270 };

/**
 * Extract a page's embedded image(s) at native resolution, in reading
 * orientation.
 *
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @param {object} pdfjsLib  the pdf.js module (for OPS) — passed in rather than
 *   imported so this module stays usable from a worker that already holds one.
 * @returns {Promise<null | {
 *   canvas, width, height, dpi:{x,y}, rotate, polarity, resampled,
 *   imageCount, source
 * }>}  null when the page carries no image at all (born-digital) — the caller
 *   must then skip OCR entirely rather than rasterise and OCR a text layer.
 */
export async function extractPageImage(page, pdfjsLib) {
    const OPS = pdfjsLib.OPS;
    const ops = await page.getOperatorList();
    const view = page.view;                        // [x0,y0,x1,y1] MediaBox
    const boxW = view[2] - view[0];
    const boxH = view[3] - view[1];

    // Walk the operator list tracking the CTM, so each image carries the
    // transform that placed it. `transform` is cumulative in pdf.js's list but
    // save/restore bracket it, so a shallow stack is enough for placement.
    const found = [];
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        if (fn === OPS.save) { stack.push(ctm.slice()); continue; }
        if (fn === OPS.restore) { ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; continue; }
        if (fn === OPS.transform) { ctm = mul(ctm, args); continue; }
        if (fn !== OPS.paintImageXObject && fn !== OPS.paintImageMaskXObject) continue;
        found.push({ name: args[0], ctm: ctm.slice(), isMask: fn === OPS.paintImageMaskXObject });
    }
    if (!found.length) return null;

    // Resolve each name against the right store. pdf.js populates these during
    // getOperatorList; `g_`-prefixed ids live on commonObjs, the rest on objs.
    for (const f of found) {
        const store = (typeof f.name === 'string' && f.name.startsWith('g_'))
            ? page.commonObjs : page.objs;
        f.img = await resolveObj(store, f.name);
    }
    const usable = found.filter((f) => f.img && f.img.width && f.img.height);
    if (!usable.length) return null;

    const rotate = ROT[((page.rotate % 360) + 360) % 360] ?? 0;

    // ── Fast path: one image covering the page ──────────────────────────────
    // The scanned-document case, and the only one that is truly lossless. The
    // bitmap is used as-is; the only transform is the exact rotation.
    if (usable.length === 1 && coversPage(usable[0].ctm, boxW, boxH)) {
        const f = usable[0];
        const dpi = dpiOf(f.ctm, f.img.width, f.img.height);
        const surface = imageToCanvas(f.img);
        if (!surface) return null;
        const clipped = clipToPage(surface, f.ctm, view);
        const rotated = rotateCanvas(clipped, rotate);
        const polarity = polarityOf(rotated);
        return {
            canvas: rotated,
            width: rotated.width, height: rotated.height,
            dpi: rotate === 90 || rotate === 270 ? { x: dpi.y, y: dpi.x } : dpi,
            rotate, polarity, resampled: false,
            imageCount: 1, source: 'native-single',
        };
    }

    // ── Composite path: several images (or masks) making up one page ────────
    // UNEXERCISED by the current fixture set — no multi-image scan is available
    // to validate it, so it is written to be obviously correct rather than
    // clever, and it reports `resampled: true` because placing by CTM does
    // interpolate. `imageRegionDetector.js` is the standing warning here: a
    // single figure can arrive as hundreds of 1x9 px masks.
    const scale = nativeScale(usable, boxW, boxH);
    const cw = Math.max(1, Math.round(boxW * scale));
    const ch = Math.max(1, Math.round(boxH * scale));
    const c = makeCanvas(cw, ch);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    for (const f of usable) {
        const bmp = imageToCanvas(f.img);
        if (!bmp) continue;
        const [a, b, cc, d, e, ff] = f.ctm;
        ctx.save();
        // PDF user space is bottom-left origin; canvas is top-left. The flip is
        // folded into the transform rather than applied to the pixels.
        ctx.setTransform(a * scale, b * scale, -cc * scale, -d * scale,
                         e * scale, ch - ff * scale);
        ctx.drawImage(bmp, 0, 0, 1, 1);
        ctx.restore();
    }
    const out = rotateCanvas(c, rotate);
    return {
        canvas: out, width: out.width, height: out.height,
        dpi: { x: scale * 72, y: scale * 72 },
        rotate, polarity: 'ink-dark', resampled: true,
        imageCount: usable.length, source: 'native-composite',
    };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function resolveObj(store, name) {
    return new Promise((res) => {
        try { store.get(name, res); } catch { res(null); }
    });
}

function mul(m, n) {
    return [
        m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ];
}

/** True when this image's placement spans essentially the whole MediaBox. */
function coversPage(ctm, boxW, boxH) {
    const w = Math.hypot(ctm[0], ctm[1]);
    const h = Math.hypot(ctm[2], ctm[3]);
    return w >= boxW * 0.9 && h >= boxH * 0.9;
}

function dpiOf(ctm, pxW, pxH) {
    const ptW = Math.hypot(ctm[0], ctm[1]) || 1;
    const ptH = Math.hypot(ctm[2], ctm[3]) || 1;
    return { x: (pxW / ptW) * 72, y: (pxH / ptH) * 72 };
}

/** Pick a composite scale that preserves the densest image's own resolution. */
function nativeScale(images, boxW, boxH) {
    let best = 1;
    for (const f of images) {
        const d = dpiOf(f.ctm, f.img.width, f.img.height);
        best = Math.max(best, d.x / 72, d.y / 72);
    }
    // Cap so a pathological 1x1 mask stretched thin cannot demand a 40k canvas.
    return Math.min(best, 8000 / Math.max(boxW, boxH));
}

/**
 * pdf.js returns two different shapes depending on host.
 *
 *   browser: { bitmap: ImageBitmap, data: null }  — already decoded, full res
 *   node:    { data: TypedArray, kind: ImageKind } — raw plane
 *
 * Both are native resolution; only the container differs. Drawing an
 * ImageBitmap 1:1 is a copy, not a resample, so the fast path stays lossless
 * either way.
 */
function imageToCanvas(img) {
    // `bitmap` is present but can be unusable — pdf.js leaves the key in place
    // for JPEG-backed images it decoded down another route, and a bitmap with
    // undefined dims reaches OffscreenCanvas as NaN. Check the dims, not the key.
    const bw = img.bitmap && img.bitmap.width, bh = img.bitmap && img.bitmap.height;
    if (Number.isFinite(bw) && Number.isFinite(bh) && bw > 0 && bh > 0) {
        const c = makeCanvas(bw, bh);
        c.getContext('2d').drawImage(img.bitmap, 0, 0);
        return c;
    }
    if (img.data && Number.isFinite(img.width) && Number.isFinite(img.height)) {
        return toCanvas(toRGBA(img));
    }
    return null;
}

/**
 * Expand a raw pdf.js plane to RGBA (the Node path).
 *
 * GRAYSCALE_1BPP is the scanned case and is packed MSB-first, 1 = white — the
 * same convention as a 1-bit PNG, which is why the raw plane can be written
 * straight out losslessly.
 */
function toRGBA(img) {
    const { width: w, height: h, kind, data } = img;
    const out = new Uint8ClampedArray(w * h * 4);
    // 1 = GRAYSCALE_1BPP, 2 = RGB_24BPP, 3 = RGBA_32BPP  (pdf.js ImageKind)
    if (kind === 1) {
        const stride = data.length / h;
        for (let y = 0; y < h; y++) {
            const row = y * stride;
            for (let x = 0; x < w; x++) {
                const bit = (data[row + (x >> 3)] >> (7 - (x & 7))) & 1;
                const v = bit ? 255 : 0;
                const o = (y * w + x) * 4;
                out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
            }
        }
    } else if (kind === 2) {
        for (let i = 0, o = 0, s = 0; i < w * h; i++, o += 4, s += 3) {
            out[o] = data[s]; out[o + 1] = data[s + 1]; out[o + 2] = data[s + 2]; out[o + 3] = 255;
        }
    } else {
        out.set(data.subarray(0, w * h * 4));
    }
    return { data: out, width: w, height: h };
}

/**
 * Crop the native bitmap to the visible page box.
 *
 * A scan is often placed larger than the MediaBox and clipped by the viewer —
 * Exploring-Chemistry places a 612pt-wide image on a 486pt-wide page, so 21%
 * of the bitmap is off-page. `page.render()` clips that for free; native
 * extraction does not, and handing the detector 21% of dead margin both wastes
 * its fixed 960px budget and feeds it scanner edge artefacts. Cropping here is
 * what makes native comparable to the render path rather than strictly worse.
 *
 * Only the axis-aligned case is handled (b and c of the CTM are zero), which is
 * every scanned page in practice. A rotated placement returns uncropped rather
 * than guessing, because an oblique crop would need a resample.
 */
function clipToPage(canvas, ctm, view) {
    const [a, b, c, d, e, f] = ctm;
    if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6) return canvas;
    if (!a || !d) return canvas;
    const W = canvas.width, H = canvas.height;
    const [x0, y0, x1, y1] = view;

    // Image occupies PDF-space rect (e, f) -> (e + a, f + d), with image row 0
    // at the TOP, i.e. at the larger PDF y.
    const u = (x) => ((x - e) / a) * W;
    const v = (y) => (1 - (y - f) / d) * H;
    let l = Math.round(Math.min(u(x0), u(x1)));
    let r = Math.round(Math.max(u(x0), u(x1)));
    let t = Math.round(Math.min(v(y0), v(y1)));
    let bm = Math.round(Math.max(v(y0), v(y1)));
    l = Math.max(0, l); t = Math.max(0, t);
    r = Math.min(W, r); bm = Math.min(H, bm);
    const cw = r - l, chh = bm - t;
    if (cw < 8 || chh < 8) return canvas;
    if (cw >= W && chh >= H) return canvas;          // nothing to clip

    const out = makeCanvas(cw, chh);
    // 1:1 blit of an integer sub-rect — a copy, not a resample.
    out.getContext('2d').drawImage(canvas, l, t, cw, chh, 0, 0, cw, chh);
    return out;
}

function rotateCanvas(c, deg) {
    if (!deg) return c;
    const swap = deg === 90 || deg === 270;
    const out = makeCanvas(swap ? c.height : c.width, swap ? c.width : c.height);
    const ctx = out.getContext('2d');
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(c, -c.width / 2, -c.height / 2);
    return out;
}

/**
 * Which way round is the ink? Sample the border: a scan is overwhelmingly
 * paper at its margins. Asserted rather than assumed, because `/Decode [1 0]`
 * and BlackIs1 both invert and neither is rare.
 */
function polarityOf(canvas) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const top = ctx.getImageData(0, 0, w, 2).data;
    const bot = ctx.getImageData(0, h - 2, w, 2).data;
    let sum = 0, n = 0;
    for (const band of [top, bot]) {
        for (let i = 0; i < band.length; i += 4 * 8) { sum += band[i]; n++; }
    }
    return n && sum / n >= 128 ? 'ink-dark' : 'ink-light';
}

function makeCanvas(w, h) {
    return typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
}

function toCanvas(rgba) {
    const c = makeCanvas(rgba.width, rgba.height);
    c.getContext('2d').putImageData(new ImageData(rgba.data, rgba.width, rgba.height), 0, 0);
    return c;
}
