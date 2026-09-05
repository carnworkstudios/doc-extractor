// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// src/extraction/astBuilder.js
// Stage 2: Token stream → DoclingDocument-shaped AST (stack-based, zero deps)

import { T } from './tokenizer.js';

const TAG_TO_NODE = {
    text:           'paragraph',
    section_header: 'section_header',
    table:          'table',
    otsl:           'table_body',
    fcel:           'table_cell',
    ecel:           'table_cell_empty',
    list_item:      'list_item',
    page_header:    'page_header',
    page_footer:    'page_footer',
    caption:        'caption',
    formula:        'formula',
    footnote:       'footnote',
    picture:        'picture',
};

// Tags treated as transparent wrappers (no AST node created)
const TRANSPARENT = new Set(['doctag']);

function makeNode(type, extra) {
    return { type, children: [], ...extra };
}

/**
 * Build a document AST from a token stream.
 * @param {Array} tokens - Output of tokenize()
 * @returns {{ type: 'document', children: Array }}
 */
export function buildAST(tokens) {
    const root = makeNode('document');
    const stack = [root];
    let currentRow = null;

    const top = () => stack[stack.length - 1];

    const isInsideTableBody = () => {
        for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].type === 'table_body') return true;
        }
        return false;
    };

    const finalizeRow = () => {
        if (currentRow && currentRow.children.length > 0) {
            // Find the nearest table_body on the stack
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].type === 'table_body') {
                    stack[i].children.push(currentRow);
                    break;
                }
            }
        }
        currentRow = null;
    };

    for (const tok of tokens) {
        switch (tok.type) {
            case T.PAGE_OPEN: {
                const node = makeNode('page', { pageNumber: tok.page });
                top().children.push(node);
                stack.push(node);
                break;
            }

            case T.PAGE_CLOSE: {
                finalizeRow();
                // Pop back to document level
                while (stack.length > 1 && top().type !== 'document') {
                    stack.pop();
                }
                break;
            }

            case T.TAG_OPEN: {
                if (TRANSPARENT.has(tok.name)) break;

                const nodeType = TAG_TO_NODE[tok.name];
                if (!nodeType) break; // Unknown tag, skip

                const node = makeNode(nodeType);

                if (nodeType === 'table_body') {
                    // Starting a table body — initialize row tracking
                    top().children.push(node);
                    stack.push(node);
                    currentRow = makeNode('table_row');
                } else if (nodeType === 'table_cell' || nodeType === 'table_cell_empty') {
                    // Cells go into the current row, and we push for content
                    if (!currentRow) currentRow = makeNode('table_row');
                    currentRow.children.push(node);
                    stack.push(node);
                } else {
                    top().children.push(node);
                    stack.push(node);
                }
                break;
            }

            case T.TAG_CLOSE: {
                if (TRANSPARENT.has(tok.name)) break;

                const nodeType = TAG_TO_NODE[tok.name];
                if (!nodeType) break;

                if (nodeType === 'table_body') {
                    // Finalize any pending row before closing
                    finalizeRow();
                }

                // Pop the matching node from the stack
                // Be tolerant: pop up to (and including) the matching node
                if (nodeType === 'table_cell' || nodeType === 'table_cell_empty') {
                    // Just pop the cell
                    if (top().type === nodeType) stack.pop();
                } else {
                    while (stack.length > 1 && top().type !== nodeType) {
                        stack.pop();
                    }
                    if (top().type === nodeType) stack.pop();
                }
                break;
            }

            case T.TAG_SELF: {
                if (tok.name === 'nl') {
                    // In table context: finalize current row, start new one
                    if (isInsideTableBody()) {
                        finalizeRow();
                        currentRow = makeNode('table_row');
                    }
                } else if (tok.name === 'picture') {
                    top().children.push(makeNode('picture'));
                }
                break;
            }

            case T.TEXT: {
                top().children.push({ type: 'text_content', value: tok.text });
                break;
            }

            case T.LOC: {
                // Skip bbox coordinates for now — could attach as metadata later
                break;
            }
        }
    }

    return root;
}
