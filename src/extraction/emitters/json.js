// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 carnworkstudios
// src/extraction/emitters/json.js
// Stage 3c: AST → JSON string

/**
 * Emit an AST as pretty-printed JSON.
 * @param {{ type: 'document', children: Array }} ast
 * @returns {string}
 */
export function emitJSON(ast) {
    return JSON.stringify(ast, null, 2);
}
