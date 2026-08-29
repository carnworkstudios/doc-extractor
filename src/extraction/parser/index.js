// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 carnworkstudios
// src/extraction/parser/index.js
// Facade: wires the 3-stage DocTags pipeline together.
// Public API signature unchanged: parseDocTags(xmlString) → { html, text }

import { tokenize } from '../tokenizer.js';
import { buildAST } from '../astBuilder.js';
import { emitHTML } from '../emitters/html.js';
import { emitMarkdown } from '../emitters/markdown.js';

/**
 * Parse Granite DocTags XML into HTML and plain text.
 * @param {string} xmlString - Raw DocTags output (with <page> wrappers from worker)
 * @returns {{ html: string, text: string }}
 */
export function parseDocTags(xmlString) {
    if (!xmlString) return { html: '', text: '' };

    const tokens = tokenize(xmlString);
    const ast    = buildAST(tokens);
    const html   = emitHTML(ast);
    const text   = emitMarkdown(ast);

    return { html, text };
}

export { tokenize, buildAST, emitHTML, emitMarkdown };
