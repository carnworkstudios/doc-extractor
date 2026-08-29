// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 carnworkstudios
// src/extraction/tokenizer.js
// Stage 1: DocTags string → flat token stream (regex-based, zero deps)

export const T = {
    PAGE_OPEN:  'PAGE_OPEN',
    PAGE_CLOSE: 'PAGE_CLOSE',
    TAG_OPEN:   'TAG_OPEN',
    TAG_CLOSE:  'TAG_CLOSE',
    TAG_SELF:   'TAG_SELF',
    LOC:        'LOC',
    TEXT:        'TEXT',
};

const TAG_RE = /<\/([a-z_]+)\s*>|<([a-z_]+)(?:\s+([^>]*?))?\s*\/?>|<loc_(\d+)>/g;

/**
 * Tokenize a raw DocTags string (with <page> wrappers) into a flat token array.
 * @param {string} raw
 * @returns {Array<{type:string, name?:string, text?:string, page?:number, attrs?:string}>}
 */
export function tokenize(raw) {
    if (!raw) return [];

    const tokens = [];
    let lastIndex = 0;

    TAG_RE.lastIndex = 0;
    let m;

    while ((m = TAG_RE.exec(raw)) !== null) {
        // Text between previous match and this one
        if (m.index > lastIndex) {
            const text = raw.slice(lastIndex, m.index);
            if (text.trim()) {
                tokens.push({ type: T.TEXT, text: text.trim() });
            }
        }
        lastIndex = TAG_RE.lastIndex;

        const [full, closeName, openName, attrs, locVal] = m;

        if (locVal !== undefined) {
            // <loc_123>
            tokens.push({ type: T.LOC, value: parseInt(locVal, 10) });
        } else if (closeName) {
            // </tag>
            if (closeName === 'page') {
                tokens.push({ type: T.PAGE_CLOSE });
            } else {
                tokens.push({ type: T.TAG_CLOSE, name: closeName });
            }
        } else if (openName) {
            const selfClosing = full.endsWith('/>');

            if (openName === 'page') {
                const pageMatch = attrs && attrs.match(/number="(\d+)"/);
                tokens.push({ type: T.PAGE_OPEN, page: pageMatch ? parseInt(pageMatch[1], 10) : 0 });
            } else if (selfClosing) {
                tokens.push({ type: T.TAG_SELF, name: openName });
            } else {
                tokens.push({ type: T.TAG_OPEN, name: openName, attrs: attrs || null });
            }
        }
    }

    // Trailing text
    if (lastIndex < raw.length) {
        const text = raw.slice(lastIndex);
        if (text.trim()) {
            tokens.push({ type: T.TEXT, text: text.trim() });
        }
    }

    return tokens;
}
