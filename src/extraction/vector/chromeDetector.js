// chromeDetector.js — cross-page running header/footer detection.
//
// A running footer repeats on (nearly) every page with only its page number
// changing. Per-page margin heuristics can't see that; repetition across the
// document can. During the worker's document prescan each page contributes
// the signatures of its margin-zone lines; signatures that recur on enough
// pages are running chrome, and the per-page header/footer classifier treats
// a signature match as decisive evidence.
//
// Ported from pdf_md (github.com/MasakatsuFunaki/pdf_md, MIT)
// layout_passes.cpp: digit runs collapse to '#' so "Page 3" and "Page 14"
// share a signature; spaces drop and ASCII lowercases so layout jitter and
// case differences don't defeat the match.

const ZONE_FRACTION = 0.12;   // top/bottom margin bands, fraction of page height
const REPEAT_FRACTION = 0.6;  // signature must appear on this share of pages
const MIN_PAGES = 3;          // repetition is meaningless below this

export function chromeSignature(text) {
    return String(text).replace(/\d+/g, '#').replace(/\s+/g, '').toLowerCase();
}

export class ChromeDetector {
    constructor() {
        this._pageSigs = [];
    }

    /**
     * Record one page's margin-zone line signatures.
     * @param {Array} textMeta — {str, vx, vy, vFont}; vy grows UP (raw PDF-space
     *   scaled coords, as built in the worker's prescan)
     * @param {number} pageHeight — page height in the same coordinate space
     */
    accumulatePage(textMeta, pageHeight) {
        const topBand = (1 - ZONE_FRACTION) * pageHeight;
        const botBand = ZONE_FRACTION * pageHeight;
        const zoneItems = (textMeta || []).filter(t =>
            t.str?.trim() && (t.vy > topBand || t.vy < botBand));

        // Cheap line grouping — same open-line rule as textRebuilder, on vy.
        const lines = [];
        for (const t of [...zoneItems].sort((a, b) => b.vy - a.vy)) {
            const size = t.vFont || 12;
            let line = null, bestDist = Infinity;
            for (const l of lines) {
                const tol = 0.5 * Math.max(l.size, size);
                const dist = Math.abs(l.y - t.vy);
                if (dist <= tol && dist < bestDist) { line = l; bestDist = dist; }
            }
            if (!line) { line = { y: t.vy, size, items: [] }; lines.push(line); }
            line.items.push(t);
            line.size = Math.max(line.size, size);
        }

        const sigs = new Set();
        for (const l of lines) {
            const sig = chromeSignature(
                l.items.sort((a, b) => a.vx - b.vx).map(t => t.str).join(''));
            if (sig.length >= 2) sigs.add(sig);
        }
        this._pageSigs.push(sigs);
    }

    /** Signatures that repeat on enough pages to be running chrome. */
    repeatedSigs() {
        const out = new Set();
        const n = this._pageSigs.length;
        if (n < MIN_PAGES) return out;
        const need = Math.max(MIN_PAGES, Math.ceil(n * REPEAT_FRACTION));
        const counts = new Map();
        for (const sigs of this._pageSigs) {
            for (const s of sigs) counts.set(s, (counts.get(s) || 0) + 1);
        }
        for (const [s, c] of counts) {
            if (c >= need) out.add(s);
        }
        return out;
    }
}
