// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 carnworkstudios
// src/extraction/emitters/html.js
// Stage 3a: AST → semantic HTML string

function esc(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function childrenHTML(node) {
    if (!node.children || node.children.length === 0) return '';
    return emitChildren(node.children);
}

/**
 * Emit children, grouping consecutive list_item nodes into <ul> blocks.
 */
function emitChildren(children) {
    const parts = [];
    let i = 0;

    while (i < children.length) {
        const child = children[i];

        if (child.type === 'list_item') {
            // Collect consecutive list items
            const items = [];
            while (i < children.length && children[i].type === 'list_item') {
                items.push(`<li>${childrenHTML(children[i])}</li>`);
                i++;
            }
            parts.push(`<ul>\n${items.join('\n')}\n</ul>`);
        } else {
            parts.push(visit(child));
            i++;
        }
    }

    return parts.join('\n');
}

function visit(node) {
    switch (node.type) {
        case 'document':
            return childrenHTML(node);

        case 'page':
            return `<section class="page" data-page="${node.pageNumber}">\n${childrenHTML(node)}\n</section>`;

        case 'paragraph':
            return `<p>${childrenHTML(node)}</p>`;

        case 'section_header':
            return `<h2>${childrenHTML(node)}</h2>`;

        case 'table':
            return `<table class="tablecoil">\n${childrenHTML(node)}\n</table>`;

        case 'table_body': {
            const rows = node.children || [];
            if (rows.length === 0) return '<tbody></tbody>';

            // First row as thead
            const headerRow = rows[0];
            const headerCells = (headerRow.children || [])
                .map(c => `<th>${childrenHTML(c)}</th>`)
                .join('');

            const bodyRows = rows.slice(1)
                .map(row => {
                    const cells = (row.children || [])
                        .map(c => {
                            if (c.type === 'table_cell_empty') return '<td></td>';
                            return `<td>${childrenHTML(c)}</td>`;
                        })
                        .join('');
                    return `<tr>${cells}</tr>`;
                })
                .join('\n');

            let html = `<thead><tr>${headerCells}</tr></thead>`;
            if (bodyRows) html += `\n<tbody>\n${bodyRows}\n</tbody>`;
            return html;
        }

        case 'table_row': {
            const cells = (node.children || [])
                .map(c => {
                    if (c.type === 'table_cell_empty') return '<td></td>';
                    return `<td>${childrenHTML(c)}</td>`;
                })
                .join('');
            return `<tr>${cells}</tr>`;
        }

        case 'table_cell':
            return childrenHTML(node);

        case 'table_cell_empty':
            return '';

        case 'list_item':
            // Handled by emitChildren grouping; fallback if visited directly
            return `<li>${childrenHTML(node)}</li>`;

        case 'page_header':
            return `<header class="page-header">${childrenHTML(node)}</header>`;

        case 'page_footer':
            return `<footer class="page-footer">${childrenHTML(node)}</footer>`;

        case 'caption':
            return `<figcaption>${childrenHTML(node)}</figcaption>`;

        case 'formula':
            return `<span class="formula">${childrenHTML(node)}</span>`;

        case 'footnote':
            return `<aside class="footnote">${childrenHTML(node)}</aside>`;

        case 'picture':
            return '<figure class="picture">[Image]</figure>';

        case 'text_content':
            return esc(node.value);

        default:
            return childrenHTML(node);
    }
}

/**
 * Emit an AST as semantic HTML.
 * @param {{ type: 'document', children: Array }} ast
 * @returns {string}
 */
export function emitHTML(ast) {
    return visit(ast);
}
