// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 carnworkstudios
// src/extraction/emitters/markdown.js
// Stage 3b: AST → Markdown string

function textOf(node) {
    if (node.type === 'text_content') return node.value;
    if (!node.children) return '';
    return node.children.map(textOf).join('');
}

function visit(node, depth) {
    switch (node.type) {
        case 'document':
            return (node.children || []).map(c => visit(c, 0)).join('\n');

        case 'page': {
            const sep = node.pageNumber > 1 ? '\n---\n\n' : '';
            const body = (node.children || []).map(c => visit(c, 0)).join('\n');
            return `${sep}${body}`;
        }

        case 'paragraph':
            return `${textOf(node)}\n`;

        case 'section_header':
            return `## ${textOf(node)}\n`;

        case 'table':
            return visitTable(node);

        case 'list_item':
            return `- ${textOf(node)}`;

        case 'page_header':
        case 'page_footer':
            return '';

        case 'caption':
            return `*${textOf(node)}*\n`;

        case 'formula':
            return `\`${textOf(node)}\`\n`;

        case 'footnote':
            return `> ${textOf(node)}\n`;

        case 'picture':
            return '[Image]\n';

        case 'text_content':
            return node.value;

        default:
            return (node.children || []).map(c => visit(c, 0)).join('\n');
    }
}

function visitTable(tableNode) {
    // Find table_body
    const body = (tableNode.children || []).find(c => c.type === 'table_body');
    if (!body || !body.children || body.children.length === 0) return '';

    const rows = body.children;
    const mdRows = rows.map(row =>
        '| ' + (row.children || []).map(cell => {
            if (cell.type === 'table_cell_empty') return '';
            return textOf(cell);
        }).join(' | ') + ' |'
    );

    // Insert separator after first row (header)
    if (mdRows.length > 0) {
        const colCount = (rows[0].children || []).length || 1;
        const sep = '| ' + Array(colCount).fill('---').join(' | ') + ' |';
        mdRows.splice(1, 0, sep);
    }

    return mdRows.join('\n') + '\n';
}

/**
 * Emit an AST as Markdown.
 * @param {{ type: 'document', children: Array }} ast
 * @returns {string}
 */
export function emitMarkdown(ast) {
    return visit(ast, 0);
}
