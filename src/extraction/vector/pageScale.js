// pageScale.js — natural-unit scale for the PDF extraction pipeline.
//
// S = body font size in viewport pixels — the natural length unit of the page.
// All thresholds are dimensionless multiples of S so the pipeline adapts to
// any font size, zoom level, or DPI without hardcoded px magic numbers.
//
// Usage:
//   const scale = new PageScale(textMeta, viewport);
//   if (gap > scale.streamGapPx) { ... }

export class PageScale {
    /**
     * @param {Array<{vFont:number, str:string}>} textMeta  — viewport-enriched text items
     * @param {object} viewport  — PDF.js viewport ({ transform: [a,b,c,d,e,f] })
     */
    constructor(textMeta, viewport) {
        const vpT = viewport.transform;
        this.vScale = Math.hypot(vpT[0], vpT[1]) || Math.hypot(vpT[2], vpT[3]) || 1;

        // S: median body font height in viewport pixels — the natural unit
        const sizes = textMeta
            .filter(tm => tm.str?.trim())
            .map(tm => tm.vFont || 12 * this.vScale)
            .sort((a, b) => a - b);
        this.S = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 12 * this.vScale;

        // ── Dimensionless ratios (multiples of S) ─────────────────────────────
        this.R_Y_BAND        = 0.45; // Y-band grouping tolerance
        this.R_PARA_GAP      = 1.80; // paragraph break Y gap
        this.R_TABLE_PAD     = 0.80; // table bbox expansion padding
        this.R_UNDERLINE     = 0.35; // underline match tolerance (fraction of cap height)
        this.R_PROXIMITY     = 0.60; // table cell assignment proximity
        this.R_COL_TOL       = 0.80; // stream column-anchor cluster tolerance
        this.R_STREAM_GAP    = 2.50; // borderless-table row gap
        this.R_COL_GAP_MIN   = 1.50; // minimum page column gutter
        this.R_CLUSTER_Y_GAP = 2.00; // spatial Y gap floor (relative to S)
        this.R_CLUSTER_X_GAP = 1.50; // spatial X gap floor (relative to S)

        // ── Quality thresholds (unitless) ─────────────────────────────────────
        this.STREAM_CONFIDENCE     = 0.60; // confidence floor for borderless table
        this.STREAM_MIN_COLS       = 3;    // minimum distinct column anchors required
        this.STREAM_MIN_BANDS      = 3;    // minimum row bands required
        this.HEADING_SCALE         = 1.25; // font-size ratio above which a line is a heading
        this.MARGIN_FLOOR          = 0.10; // min X fraction to qualify as a real column split

        // ── Stream structural-context gates ───────────────────────────────────
        // These three thresholds distinguish borderless data tables from
        // column-aligned flowing text (TOC pages, multi-column prose, etc.)
        this.STREAM_MIN_FILL       = 0.30; // min item fill rate: items / (bands × cols)
        this.STREAM_MAX_AVG_LEN    = 20;   // max avg text-item char length (table cells are short)
        this.STREAM_MAX_ITEMS_BAND = 8;    // max avg items per band (dense lines → prose, not rows)
    }

    // ── Absolute helpers (viewport pixels) ───────────────────────────────────
    get yBandTolPx()    { return this.S * this.R_Y_BAND; }
    get paraGapPx()     { return this.S * this.R_PARA_GAP; }
    get tablePadPx()    { return Math.max(2, this.S * this.R_TABLE_PAD); }
    get underlineTolPx(){ return this.S * this.R_UNDERLINE; }
    get proximityPx()   { return this.S * this.R_PROXIMITY; }
    get colTolPx()      { return this.S * this.R_COL_TOL; }
    get streamGapPx()   { return this.S * this.R_STREAM_GAP; }
    get colGapMinPx()   { return this.S * this.R_COL_GAP_MIN; }

    clusterYGap(yRange) { return Math.max(this.S * this.R_CLUSTER_Y_GAP, yRange * 0.10); }
    clusterXGap(xRange) { return Math.max(this.S * this.R_CLUSTER_X_GAP, xRange * 0.08); }
}
