// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// metadataFonts.js — document metadata and font-embedding inconsistencies.
//
// WHAT METADATA IS AND IS NOT GOOD FOR
// ------------------------------------
// PDF metadata is trivially editable. Nothing here proves anything, and a
// module that reported "Producer says Acrobat but ModDate is before CreationDate,
// therefore the document was altered" would be making exactly the leap the
// user's observed/inferred/uncertain rule exists to forbid.
//
// What metadata IS good for is corroboration. On its own an odd Producer string
// is worth nothing; alongside a noise-floor discontinuity in the same document
// it is worth quite a lot. So this module's job is to MEASURE precisely and
// claim narrowly — almost everything it emits is `observed`, and the few
// inferences it draws are the ones where the mechanism is not ambiguous.
//
// THE FONT TEST IS THE STRONGER ONE
// ---------------------------------
// Font evidence is much harder to fake than metadata because it is a
// consequence of how the file was WRITTEN, not a string somebody typed.
//
//   * A subset font is embedded with a six-letter tag (`ABCDEF+Times`) and
//     contains only the glyphs the document uses. If a page paints a character
//     that is not in the subset, that text was added after the subset was
//     computed — by a different tool, in a later edit.
//   * A single logical typeface appearing under two different subset tags on
//     one page means two different producers wrote to that page.
//   * A font referenced but not embedded on a page where every other font IS
//     embedded is an insertion from a tool with different settings.
//
// ctmAdapter already records `fontName` on every TEXT_PAINT, and pdf.js exposes
// the font objects through `page.commonObjs`. Nothing new is parsed here.

import { observed, inferred, uncertain } from './findings.js';

const CHECK = 'metadata-fonts';

// A pdf.js subset tag: six uppercase letters and a plus.
const SUBSET_TAG = /^([A-Z]{6})\+(.+)$/;

/** Strip the subset tag to get the underlying typeface name. */
export function baseFontName(name) {
    if (!name) return '';
    const m = SUBSET_TAG.exec(name);
    return m ? m[2] : name;
}

function parsePdfDate(s) {
    // D:YYYYMMDDHHmmSSOHH'mm'
    if (typeof s !== 'string') return null;
    const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s.trim());
    if (!m) return null;
    const [, Y, Mo, D, H, Mi, S] = m;
    const d = new Date(Date.UTC(+Y, (+Mo || 1) - 1, +D || 1, +H || 0, +Mi || 0, +S || 0));
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {object} info      pdf.js `getMetadata().info`
 * @param {object|null} xmp  pdf.js `getMetadata().metadata` (may be null)
 */
export function analyseMetadata(info = {}, xmp = null) {
    const out = [];
    const created = parsePdfDate(info.CreationDate);
    const modified = parsePdfDate(info.ModDate);

    const m = observed(CHECK, 'document information dictionary read', {
        producer: info.Producer || null,
        creator: info.Creator || null,
        creationDate: created ? created.toISOString() : null,
        modDate: modified ? modified.toISOString() : null,
        pdfVersion: info.PDFFormatVersion || null,
        isLinearized: info.IsLinearized ?? null,
        encrypted: info.IsXFAPresent ?? null,
        hasXmp: !!xmp,
    });
    out.push(m);

    if (created && modified) {
        const deltaDays = (modified - created) / 86400000;
        const d = observed(CHECK, 'creation and modification timestamps compared',
            { deltaDays: +deltaDays.toFixed(3) });
        out.push(d);
        if (deltaDays < -0.02) {
            // Not "the file was backdated". Timezone handling in PDF writers is
            // genuinely bad and a small negative delta is common. The claim is
            // only that the two fields are inconsistent with each other.
            out.push(inferred(CHECK,
                'ModDate precedes CreationDate; the two timestamps cannot both describe '
                + 'this file as written',
                [d.id], { severity: Math.min(0.6, 0.2 + Math.abs(deltaDays) / 365) }));
        } else if (deltaDays > 0.02) {
            out.push(observed(CHECK,
                `the file was modified ${deltaDays.toFixed(1)} days after it was created`,
                { deltaDays: +deltaDays.toFixed(3) },
                { severity: 0.1 }));
        }
    } else if (created || modified) {
        out.push(observed(CHECK, 'only one of CreationDate / ModDate is present',
            { hasCreation: !!created, hasMod: !!modified }, { severity: 0.15 }));
    }

    if (xmp && info.Producer) {
        // XMP carries its own producer/tool history. When the two disagree the
        // file passed through something that updated one and not the other.
        const xmpProducer = safeXmp(xmp, 'pdf:Producer') || safeXmp(xmp, 'xmp:CreatorTool');
        if (xmpProducer && xmpProducer !== info.Producer) {
            const o = observed(CHECK, 'XMP and the info dictionary name different producers',
                { infoProducer: info.Producer, xmpProducer });
            out.push(o);
            out.push(inferred(CHECK,
                'the file was written by one tool and later rewritten by another that '
                + 'updated only one of the two metadata stores',
                [o.id], { severity: 0.45 }));
        }
    }
    return out;
}

function safeXmp(xmp, key) {
    try { return xmp.get ? xmp.get(key) : null; } catch { return null; }
}

/**
 * Font-level analysis for ONE page.
 *
 * @param {Array} textPaintOps  from ctmAdapter.extractSubpaths()
 * @param {Map<string,object>} fontInfo  fontName -> pdf.js font object
 *        (`{ name, loadedName, data, isType3Font, missingFile, ... }`)
 * @param {number} pageNo
 */
export function analyseFonts(textPaintOps = [], fontInfo = new Map(), pageNo = 1) {
    const out = [];
    const used = new Map();        // fontName -> Set of code points painted
    for (const op of textPaintOps) {
        if (!op.fontName) continue;
        let s = used.get(op.fontName);
        if (!s) { s = new Set(); used.set(op.fontName, s); }
        for (const ch of (op.text || '')) s.add(ch);
    }
    if (!used.size) {
        return [observed(CHECK, 'page paints no text', { page: pageNo, fonts: 0 })];
    }

    const rows = [];
    for (const [name, chars] of used) {
        const f = fontInfo.get(name) || {};
        const tag = SUBSET_TAG.exec(f.name || name);
        rows.push({
            name,
            base: baseFontName(f.name || name),
            subsetTag: tag ? tag[1] : null,
            embedded: f.missingFile === undefined ? null : !f.missingFile,
            type3: !!f.isType3Font,
            glyphs: chars.size,
        });
    }
    const o = observed(CHECK, 'per-page font usage enumerated',
        { page: pageNo, fonts: rows.length, detail: rows });
    out.push(o);

    // ── one typeface, several subset tags ───────────────────────────────────
    const byBase = new Map();
    for (const r of rows) {
        if (!r.subsetTag) continue;
        const k = r.base.toLowerCase();
        if (!byBase.has(k)) byBase.set(k, new Set());
        byBase.get(k).add(r.subsetTag);
    }
    for (const [base, tags] of byBase) {
        if (tags.size < 2) continue;
        const m = observed(CHECK,
            `typeface "${base}" appears on this page under ${tags.size} different subset tags`,
            { page: pageNo, base, tags: [...tags] }, { severity: 0.4 });
        out.push(m);
        out.push(inferred(CHECK,
            `two independently-computed subsets of the same typeface are painted on one `
            + 'page, which happens when text from a second source is merged into an '
            + 'existing page rather than typeset with it',
            [o.id, m.id], { severity: 0.65 }));
    }

    // ── mixed embedding ─────────────────────────────────────────────────────
    const embedded = rows.filter((r) => r.embedded === true);
    const notEmbedded = rows.filter((r) => r.embedded === false);
    if (embedded.length && notEmbedded.length) {
        const m = observed(CHECK,
            `${notEmbedded.length} of ${rows.length} fonts on this page are not embedded, `
            + 'while the rest are',
            { page: pageNo,
              embedded: embedded.map((r) => r.name),
              notEmbedded: notEmbedded.map((r) => r.name) },
            { severity: 0.35 });
        out.push(m);
        out.push(uncertain(CHECK,
            'mixed embedding can mean text was added by a tool configured differently '
            + 'from the one that produced the page — or simply that a standard-14 font '
            + 'was used, which is never embedded',
            { severity: 0.2 }));
    }

    return out;
}

/**
 * Cross-page font consistency.
 *
 * A page whose font set is disjoint from every other page's is the strongest
 * signal in this module: documents are typeset once, so a page that shares no
 * typeface with its neighbours was very likely produced separately.
 */
export function analyseFontsAcrossPages(perPage) {
    const out = [];
    if (perPage.length < 3) return out;
    const sets = perPage.map((p) => new Set(p.fonts.map((f) => baseFontName(f).toLowerCase())));
    const global = new Map();
    for (const s of sets) for (const f of s) global.set(f, (global.get(f) || 0) + 1);

    const o = observed(CHECK, 'font usage compared across pages',
        { pages: perPage.length,
          typefaces: [...global.entries()].map(([f, n]) => ({ font: f, pages: n })) });
    out.push(o);

    for (let i = 0; i < perPage.length; i++) {
        if (!sets[i].size) continue;
        // "Shared with a majority of pages" rather than "present on page i-1":
        // a document with front matter in a display face would otherwise flag
        // its own title page.
        const shared = [...sets[i]].filter((f) => global.get(f) > perPage.length / 2);
        if (shared.length) continue;
        const m = observed(CHECK,
            `page ${perPage[i].page} shares no typeface with the document majority`,
            { page: perPage[i].page, pageFonts: [...sets[i]],
              documentFonts: [...global.keys()] },
            { severity: 0.5, region: { page: perPage[i].page, x: 0, y: 0, w: 0, h: 0 } });
        out.push(m);
        out.push(inferred(CHECK,
            `page ${perPage[i].page} was typeset with a font set unrelated to the rest of `
            + 'the document, which is consistent with it having been produced separately '
            + 'and inserted',
            [o.id, m.id], { severity: 0.7 }));
    }
    return out;
}

export const _internals = { parsePdfDate, SUBSET_TAG };
