// docScale.js — document-level tolerance calibration.
//
// PageScale measures the unit (S = modal body font per page) but the ratios
// on top of it (R_COL_GAP_MIN, R_Y_BAND, R_COL_TOL, …) are priors — guesses
// that hold for most documents and silently fail on outliers.
//
// DocScale removes the guessing by pooling histogram statistics across ALL
// pages of a document before detection. The same measured valleys feed the
// extractor's gates AND Boxwood's inferSplits minValley — detector and
// layout engine can never drift apart on what a gutter is.
//
// Usage:
//   const ds = new DocScale();
//   ds.accumulate(pageTextMeta);  // call for each page
//   ds.calibrate(priorS);         // call once after all pages accumulated
//   // then pass ds to PageScale as override source, or read ds directly
//   if (gap > ds.colGapMinPx) { ... }

const MIN_SAMPLES = 20;

export class DocScale {
    constructor() {
        this._allDX = [];
        this._allDY = [];
        this._allFonts = [];
        this._pageCount = 0;
        this._colGapMinPx = null;
        this._leadingPx = null;
        this._colTolPx = null;
        this._calibrated = false;
    }

    accumulate(textMeta) {
        if (!textMeta || textMeta.length < 2) return;
        this._pageCount++;

        // Collect horizontal gaps between consecutive items on the same line
        const byLine = new Map();
        for (const tm of textMeta) {
            const vy = Math.round(tm.vy);
            if (!byLine.has(vy)) byLine.set(vy, []);
            byLine.get(vy).push(tm);
        }
        for (const items of byLine.values()) {
            const sorted = items.sort((a, b) => a.vx - b.vx);
            for (let i = 1; i < sorted.length; i++) {
                const gap = sorted[i].vx - (sorted[i - 1].vx + (sorted[i - 1].vWidth || 0));
                if (gap > 0 && gap < 200) this._allDX.push(gap);
            }
        }

        // Collect vertical gaps between consecutive DISTINCT line baselines.
        // Deltas must be measured line-to-line, not item-to-item: consecutive
        // items on the same visual line differ by fractional y jitter, and
        // those near-zero deltas would dominate the histogram and calibrate
        // leading to sub-line values (which fragments every paragraph).
        const baselines = [...byLine.keys()].sort((a, b) => a - b);
        for (let i = 1; i < baselines.length; i++) {
            const dy = baselines[i] - baselines[i - 1];
            if (dy >= 4 && dy < 80) this._allDY.push(dy);
        }

        // Collect font sizes
        for (const tm of textMeta) {
            if (tm.vFont > 0) this._allFonts.push(tm.vFont);
        }
    }

    calibrate(priorS) {
        if (this._calibrated) return;
        this._calibrated = true;

        // Prefer the measured modal font size over the caller's prior: the
        // accumulated values are viewport pixels, and a point-space prior
        // (e.g. 12) puts every plausibility bound at half the right magnitude.
        const measuredS = _modal(this._allFonts);
        const S = measuredS ?? priorS;

        const priorColGap = S * 1.50;
        const priorLeading = S * 1.20; // leading is line PITCH (~1.2 × font), not band tolerance
        const priorColTol = S * 0.80;

        this._colGapMinPx = this._calibrateGap(this._allDX, priorColGap);
        this._leadingPx = this._calibrateLeading(this._allDY, priorLeading);
        this._colTolPx = this._calibrateColTol(this._allDX, priorColTol);
    }

    // Horizontal gap histogram → trimodal (intra-word, inter-word, gutter)
    // Returns the valley between word-space mode and gutter mode.
    // Returns null when the measurement is unusable — a null must flow through
    // to PageScale so its per-page ratio defaults stay in charge. Returning
    // the prior here would masquerade a guess as a document-level measurement.
    _calibrateGap(gaps, prior) {
        if (gaps.length < MIN_SAMPLES) return null;
        const modes = _findModes(gaps, 2);
        if (modes.length < 2) return null;
        // Modes are sorted. Valley is the midpoint between the two largest modes.
        const wordMode = modes[modes.length - 2];
        const gutterMode = modes[modes.length - 1];
        const valley = (wordMode + gutterMode) / 2;
        if (valley < prior * 0.5 || valley > prior * 3) return null;
        return valley;
    }

    // Baseline-delta histogram → dominant leading (line pitch) mode
    _calibrateLeading(deltas, prior) {
        if (deltas.length < MIN_SAMPLES) return null;
        const modes = _findModes(deltas, 1);
        if (modes.length < 1) return null;
        // The histogram bin center can overshoot the true pitch by half a
        // bin width, and paragraph-gap thresholds are sensitive to a few px.
        // Refine: median of the raw deltas within ±20% of the coarse mode.
        const coarse = modes[0];
        const near = deltas.filter(d => Math.abs(d - coarse) <= coarse * 0.20)
            .sort((a, b) => a - b);
        const leading = near.length >= MIN_SAMPLES
            ? near[Math.floor(near.length / 2)]
            : coarse;
        if (leading < prior * 0.5 || leading > prior * 2.5) return null;
        return leading;
    }

    // Column tolerance from within-word gap variance
    _calibrateColTol(gaps, prior) {
        if (gaps.length < MIN_SAMPLES) return null;
        // Sort and look for the 85th percentile gap — captures the upper bound
        // of within-line spacing without reaching gutter-level gaps.
        const sorted = [...gaps].sort((a, b) => a - b);
        const p85 = sorted[Math.floor(sorted.length * 0.85)];
        const tol = p85 * 1.5;
        // Out-of-band means the gap histogram is gutter-polluted or too sparse
        // to trust — clamping it to the band edge would still ship a bad
        // measurement, so defer to PageScale's per-page default instead.
        if (tol < prior * 0.5 || tol > prior * 2) return null;
        return tol;
    }

    get colGapMinPx() { return this._colGapMinPx; }
    get leadingPx() { return this._leadingPx; }
    get colTolPx() { return this._colTolPx; }
    get calibrated() { return this._calibrated; }

    toJSON() {
        return {
            calibrated: this._calibrated,
            colGapMinPx: this._colGapMinPx,
            leadingPx: this._leadingPx,
            colTolPx: this._colTolPx,
            pageCount: this._pageCount,
        };
    }
}

// Modal value at 0.5-unit resolution — same binning PageScale uses for S,
// so DocScale's plausibility priors live in the same unit space (viewport px).
function _modal(values) {
    if (!values || values.length < MIN_SAMPLES) return null;
    const bins = new Map();
    for (const v of values) {
        const bin = Math.round(v * 2) / 2;
        bins.set(bin, (bins.get(bin) || 0) + 1);
    }
    let mode = null, count = 0;
    for (const [bin, c] of bins) {
        if (c > count) { count = c; mode = bin; }
    }
    return mode;
}

// Find modes in a numeric array using histogram binning.
// Returns up to `maxModes` modes sorted descending by count.
function _findModes(values, maxModes) {
    if (values.length === 0) return [];

    // Determine bin width using the Freedman-Diaconis rule for robustness
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const q1 = sorted[Math.floor(n * 0.25)];
    const q3 = sorted[Math.floor(n * 0.75)];
    const iqr = q3 - q1;
    const binWidth = Math.max(0.5, iqr / (2 * Math.cbrt(n)));

    const minVal = sorted[0];
    const maxVal = sorted[sorted.length - 1];
    const numBins = Math.max(1, Math.ceil((maxVal - minVal) / binWidth));

    const bins = new Array(numBins).fill(0);
    for (const v of values) {
        const idx = Math.min(numBins - 1, Math.floor((v - minVal) / binWidth));
        bins[idx]++;
    }

    // Find peaks: bins higher than both neighbors
    const peaks = [];
    for (let i = 1; i < numBins - 1; i++) {
        if (bins[i] > bins[i - 1] && bins[i] >= bins[i + 1]) {
            const center = minVal + (i + 0.5) * binWidth;
            peaks.push({ value: center, count: bins[i] });
        }
    }

    // Sort by count descending, return up to maxModes
    peaks.sort((a, b) => b.count - a.count);
    return peaks.slice(0, maxModes).map(p => p.value);
}
