/**
 * exportController.js
 * Multi-format export dropdown: HTML, Markdown, PDF, XML.
 *
 * Extracted HTML structure (from pageAssembler.js / componentRender.js):
 *   <section class="pdf-page-content" data-page="N">
 *     <h3|h4>           — headings
 *     <div class="fN ta-x"> — paragraphs (font+align classes, may contain <span>)
 *     <ul|ol>           — lists with <li> children
 *     <div class="pdf-table-wrap ..."><table>…</table></div> — tables
 *     <aside class="pdf-box ..."> — callout boxes
 *     <hr class="pdf-divider">   — dividers
 *     <img class="extracted-pdf-image" data-img-id="…"> — images
 *   </section>
 */

import $ from 'jquery';
import { state } from '../state.js';
import { showToast } from './toast.js';
import { downloadExtractedHTML, exportExtractedPDF } from './fileUpload.js';

export function initExportSystem() {
    $('#btn-export-main').on('click', (e) => {
        e.stopPropagation();
        const dropdown = document.getElementById('export-dropdown');
        const menu = dropdown?.querySelector('.dropdown-menu');
        const isOpen = dropdown?.classList.contains('open');

        if (!isOpen && menu) {
            const btn = document.getElementById('btn-export-main');
            const rect = btn.getBoundingClientRect();
            // Align right edge of menu with right edge of button
            const menuWidth = 240;
            let left = rect.right - menuWidth;
            if (left < 8) left = 8;
            menu.style.top  = (rect.bottom + 8) + 'px';
            menu.style.left = left + 'px';
        }

        $('#export-dropdown').toggleClass('open');
    });

    $(document).on('click', () => {
        $('#export-dropdown').removeClass('open');
    });

    $('.dropdown-item').on('click', function () {
        handleExport($(this).data('format'));
        $('#export-dropdown').removeClass('open');
    });
}

async function handleExport(format) {
    const html = state.pdf1.extractedHTML;
    if (!html) {
        showToast('No content to export. Load a file first.', 'error');
        return;
    }

    switch (format) {
        case 'html':
            downloadExtractedHTML();
            break;
        case 'pdf':
            exportExtractedPDF();
            break;
        case 'markdown':
            await exportToMarkdown(html);
            break;
        case 'xml':
            exportToXML(html);
            break;
        case 'doc':
            exportToDoc(html);
            break;
    }
}

// ── Shared DOM parse ──────────────────────────────────────────────────────────

function parseDoc(html) {
    return new DOMParser().parseFromString(html, 'text/html');
}

function baseName() {
    return state.pdf1.file?.name?.replace(/\.[^.]+$/, '') || 'extracted';
}

function downloadBlob(content, type, ext) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${baseName()}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ── Text extraction helpers ───────────────────────────────────────────────────

/** Recursively extract plain text from a node, honoring inline bold/italic spans. */
function nodeText(node, forMd = false) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;

    const tag = node.tagName?.toLowerCase();

    if (forMd) {
        const inner = [...node.childNodes].map(n => nodeText(n, true)).join('');
        const cls = node.className || '';
        const isBold   = tag === 'b' || tag === 'strong' || cls.includes('bold');
        const isItalic = tag === 'i' || tag === 'em'     || cls.includes('ital');
        if (isBold && isItalic) return `***${inner}***`;
        if (isBold)   return `**${inner}**`;
        if (isItalic) return `*${inner}*`;
        if (tag === 'u' || cls.includes('uline')) return inner; // underline has no MD equivalent
        return inner;
    }

    return node.textContent;
}

/** Extract clean text from a block element for Markdown. */
function blockText(el) {
    return [...el.childNodes].map(n => nodeText(n, true)).join('').trim();
}

// ── Table → Markdown GFM ─────────────────────────────────────────────────────

function tableToMarkdown(tableEl) {
    const rows = [...tableEl.querySelectorAll('tr')];
    if (!rows.length) return '';

    const grid = rows.map(tr =>
        [...tr.querySelectorAll('td, th')].map(cell => cell.textContent.trim().replace(/\|/g, '\\|'))
    );

    const header = grid[0];
    const sep    = header.map(() => '---');
    const body   = grid.slice(1);

    const lines = [
        `| ${header.join(' | ')} |`,
        `| ${sep.join(' | ')} |`,
        ...body.map(row => `| ${row.join(' | ')} |`),
    ];
    return lines.join('\n');
}

// ── Table → XML ───────────────────────────────────────────────────────────────

function tableToXml(tableEl, indent) {
    const rows = [...tableEl.querySelectorAll('tr')];
    const i = indent;
    let out = `${i}<table>\n`;
    rows.forEach(tr => {
        out += `${i}  <row>\n`;
        [...tr.querySelectorAll('td, th')].forEach(cell => {
            const tag = cell.tagName.toLowerCase() === 'th' ? 'header' : 'cell';
            out += `${i}    <${tag}>${xmlEsc(cell.textContent.trim())}</${tag}>\n`;
        });
        out += `${i}  </row>\n`;
    });
    out += `${i}</table>`;
    return out;
}

// ── Markdown export ───────────────────────────────────────────────────────────

async function exportToMarkdown(html) {
    showToast('Generating Markdown…', 'info');
    const doc = parseDoc(html);
    const lines = [];

    const pages = doc.querySelectorAll('section.pdf-page-content');
    const sections = pages.length ? pages : [doc.body];

    sections.forEach((page, pi) => {
        if (pages.length > 1) {
            if (pi > 0) lines.push('\n---\n');
        }

        for (const el of page.children) {
            const tag = el.tagName.toLowerCase();
            const cls = el.className || '';

            // Headings
            if (tag === 'h1') { lines.push(`# ${blockText(el)}\n`); continue; }
            if (tag === 'h2') { lines.push(`## ${blockText(el)}\n`); continue; }
            if (tag === 'h3') { lines.push(`### ${blockText(el)}\n`); continue; }
            if (tag === 'h4') { lines.push(`#### ${blockText(el)}\n`); continue; }
            if (tag === 'h5') { lines.push(`##### ${blockText(el)}\n`); continue; }
            if (tag === 'h6') { lines.push(`###### ${blockText(el)}\n`); continue; }

            // Page label emitted by assembler — skip, it's noise
            if (cls.includes('page-label')) continue;

            // Divider
            if (tag === 'hr') { lines.push('---\n'); continue; }

            // Table
            if (cls.includes('pdf-table-wrap')) {
                const table = el.querySelector('table');
                if (table) { lines.push(tableToMarkdown(table) + '\n'); }
                continue;
            }

            // Callout box → blockquote
            if (tag === 'aside' && cls.includes('pdf-box')) {
                const role = cls.includes('warning') ? '> **⚠ Warning**\n>\n'
                           : cls.includes('caution') ? '> **⚡ Caution**\n>\n'
                           : cls.includes('note')    ? '> **ℹ Note**\n>\n'
                           : cls.includes('tip')     ? '> **✅ Tip**\n>\n'
                           : '> ';
                const body = blockText(el).split('\n').map(l => `> ${l}`).join('\n');
                lines.push(role + body + '\n');
                continue;
            }

            // Unordered list
            if (tag === 'ul') {
                [...el.querySelectorAll('li')].forEach(li => {
                    lines.push(`- ${blockText(li)}`);
                });
                lines.push('');
                continue;
            }

            // Ordered list
            if (tag === 'ol') {
                [...el.querySelectorAll('li')].forEach((li, i) => {
                    lines.push(`${i + 1}. ${blockText(li)}`);
                });
                lines.push('');
                continue;
            }

            // Image placeholder
            if (tag === 'div' && cls.includes('pdf-image-placeholder')) {
                const img = el.querySelector('img[data-img-id]');
                const id = img?.getAttribute('data-img-id') || 'img';
                lines.push(`![Image ${id}](image_${id}.png)\n`);
                continue;
            }

            // Zone / column wrappers — recurse into children
            if (cls.includes('pdf-zone') || cls.includes('pdf-col')) {
                for (const child of el.children) {
                    const t = child.textContent.trim();
                    if (t) lines.push(blockText(child) + '\n');
                }
                continue;
            }

            // Paragraph div (font/align classes) or any other block
            const text = blockText(el);
            if (text) lines.push(text + '\n');
        }
    });

    downloadBlob(lines.join('\n'), 'text/markdown', 'md');
    showToast('Markdown exported', 'success');
}

// ── XML export ────────────────────────────────────────────────────────────────

function exportToXML(html) {
    showToast('Generating XML…', 'info');
    const doc = parseDoc(html);
    const name = baseName();
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<document name="${xmlEsc(name)}">\n`;

    const pages = doc.querySelectorAll('section.pdf-page-content');
    const sections = pages.length ? [...pages] : [doc.body];

    sections.forEach((page, pi) => {
        const pageNum = page.getAttribute('data-page') || (pi + 1);
        xml += `  <page number="${pageNum}">\n`;

        for (const el of page.children) {
            const tag = el.tagName.toLowerCase();
            const cls = el.className || '';

            if (cls.includes('page-label')) continue;

            // Headings
            if (/^h[1-6]$/.test(tag)) {
                const level = tag[1];
                xml += `    <heading level="${level}">${xmlEsc(el.textContent.trim())}</heading>\n`;
                continue;
            }

            // Divider
            if (tag === 'hr') { xml += `    <divider/>\n`; continue; }

            // Table
            if (cls.includes('pdf-table-wrap')) {
                const table = el.querySelector('table');
                if (table) xml += tableToXml(table, '    ') + '\n';
                continue;
            }

            // Callout box
            if (tag === 'aside' && cls.includes('pdf-box')) {
                const role = cls.includes('warning') ? 'warning'
                           : cls.includes('caution') ? 'caution'
                           : cls.includes('note')    ? 'note'
                           : cls.includes('tip')     ? 'tip'
                           : 'box';
                xml += `    <callout type="${role}">${xmlEsc(el.textContent.trim())}</callout>\n`;
                continue;
            }

            // Lists
            if (tag === 'ul' || tag === 'ol') {
                const kind = tag === 'ol' ? 'ordered' : 'unordered';
                xml += `    <list type="${kind}">\n`;
                [...el.querySelectorAll('li')].forEach(li => {
                    xml += `      <item>${xmlEsc(li.textContent.trim())}</item>\n`;
                });
                xml += `    </list>\n`;
                continue;
            }

            // Image placeholder
            if (cls.includes('pdf-image-placeholder')) {
                const img = el.querySelector('img[data-img-id]');
                const id = img?.getAttribute('data-img-id') || '';
                xml += `    <image ref="${xmlEsc(id)}"/>\n`;
                continue;
            }

            // Zone / column wrappers — flatten children as paragraphs
            if (cls.includes('pdf-zone') || cls.includes('pdf-col')) {
                for (const child of el.children) {
                    const t = child.textContent.trim();
                    if (t) xml += `    <paragraph>${xmlEsc(t)}</paragraph>\n`;
                }
                continue;
            }

            // Paragraph
            const text = el.textContent.trim();
            if (text) xml += `    <paragraph>${xmlEsc(text)}</paragraph>\n`;
        }

        xml += `  </page>\n`;
    });

    xml += `</document>`;
    downloadBlob(xml, 'application/xml', 'xml');
    showToast('XML exported', 'success');
}

// ── DOC export (HTML → Office mhtml envelope) ─────────────────────────────────

function exportToDoc(html) {
    showToast('Generating Word document…', 'info');
    const name = baseName();

    const doc = `
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="utf-8">
  <meta name="ProgId" content="Word.Document">
  <meta name="Generator" content="Ginexys PDF Processor">
  <title>${xmlEsc(name)}</title>
  <!--[if gte mso 9]>
  <xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml>
  <![endif]-->
  <style>
    body { font-family: Calibri, sans-serif; font-size: 11pt; margin: 1in; }
    h1,h2,h3,h4,h5,h6 { font-family: Calibri, sans-serif; }
    table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
    td, th { border: 1px solid #999; padding: 4pt 8pt; font-size: 10pt; }
    th { background: #f2f2f2; font-weight: bold; }
    ul, ol { margin: 6pt 0; padding-left: 20pt; }
    p, div { margin: 4pt 0; }
    aside { border: 1pt solid #888; padding: 6pt 12pt; margin: 8pt 0; }
    hr { border: none; border-top: 1pt solid #ccc; margin: 10pt 0; }
    img { max-width: 100%; }
  </style>
</head>
<body>
${html}
</body>
</html>`.trim();

    downloadBlob(doc, 'application/msword', 'doc');
    showToast('Word document exported', 'success');
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function xmlEsc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
