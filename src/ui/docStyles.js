/**
 * docStyles.js
 * Owns the CSS that belongs to the CURRENTLY MOUNTED extracted document.
 *
 * `generateDocumentStyles(fontRegistry)` produces a per-document stylesheet:
 * one `.f0…fN` rule per distinct font the extraction found, plus the static
 * layout rules the assembler's markup depends on. It is derived FROM the
 * extraction — it is not something the user wrote, and it is not content.
 *
 * It used to be prepended to the document string as a `<style>` block, which
 * put it in the one place it could not survive:
 *
 *   • A fragment that STARTS with `<style>` is parked in `<head>` by the HTML
 *     parser, and every consumer reads `body.innerHTML` — so the block is
 *     silently dropped on any full-document round trip. DOMPurify allows
 *     `<style>` (39 of the document's 40 style tags survive sanitising); it is
 *     only ever the leading one that disappears, and it takes every font rule
 *     with it. `downloadExtractedHTML` already had to work around exactly this.
 *   • Because the string changed shape on every round trip, the Monaco model
 *     could never compare equal to it, so opening the Editor tab re-set an
 *     800 KB model whether or not anything had been edited.
 *   • It is 11 KB of generated CSS in the editable surface, which is 11 KB of
 *     something the user cannot usefully edit there — the fonts come back
 *     regenerated on the next extraction regardless.
 *
 * So it lives here instead: one `<style>` element in the app's own head,
 * replaced when a document is mounted, cleared when one is dropped. The
 * document string carries content only. The export re-attaches it, the same way
 * the export re-inlines pictures from the blob store — payload and references
 * are separated in the app, and rejoined in the file that leaves it.
 *
 * NOT in the blob store, and NOT a `<link rel="stylesheet">`: this is a small
 * text asset the renderer needs synchronously before first paint, `link` is not
 * in DOMPurify's allow-list (so it would be stripped exactly like the `<style>`
 * was), and an external stylesheet reference is deliberately refused elsewhere
 * in this tool for the same security reason.
 */

const EL_ID = 'gx-doc-styles';

let _css = '';

function _el() {
    let el = document.getElementById(EL_ID);
    if (!el) {
        el = document.createElement('style');
        el.id = EL_ID;
        // Last in head: these rules are scoped under `.pdf-doc` and are meant to
        // win over the app's own stylesheet for extracted content.
        document.head.appendChild(el);
    }
    return el;
}

/**
 * Install the mounted document's stylesheet, replacing whatever was there.
 *
 * Documents do not merge: two of them define `.f0` differently, so mounting the
 * second while the first's rules are still live would restyle both. Replacing
 * wholesale is what keeps the compare slot and a batch focus honest.
 */
export function setDocumentStyles(css) {
    _css = typeof css === 'string' ? css : '';
    _el().textContent = _css;
    return _css;
}

/** The mounted document's CSS, for the export to re-inline. */
export function getDocumentStyles() {
    return _css;
}

/** Drop the stylesheet — no document is mounted. */
export function clearDocumentStyles() {
    _css = '';
    const el = document.getElementById(EL_ID);
    if (el) el.textContent = '';
}

/**
 * Pull a leading `<style>` block out of a document string.
 *
 * For documents produced BEFORE this module existed, and for any path that
 * still hands over a string with the block prepended. Returns the CSS and the
 * remaining markup, so the caller can route each to where it belongs instead of
 * letting the parser decide (which is how it went missing).
 */
export function splitLeadingStyles(html) {
    if (typeof html !== 'string') return { css: '', html: '' };
    const m = /^\s*<style[^>]*>([\s\S]*?)<\/style>\s*/i.exec(html);
    if (!m) return { css: '', html };
    return { css: m[1].trim(), html: html.slice(m[0].length) };
}
