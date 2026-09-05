import { PDFDocument } from 'pdf-lib';

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp)$/i;

export function routeFile(name = '') {
    if (IMAGE_EXT.test(name)) return 'image';
    if (/\.docx$/i.test(name)) return 'docx';
    if (/\.json$/i.test(name)) return 'json';
    if (/\.md$/i.test(name)) return 'md';
    if (/\.html?$/i.test(name)) return 'html';
    return 'pdf';
}

export function mimeForFile(name = '') {
    const route = routeFile(name);
    if (route === 'image') {
        if (/\.png$/i.test(name)) return 'image/png';
        if (/\.webp$/i.test(name)) return 'image/webp';
        if (/\.bmp$/i.test(name)) return 'image/bmp';
        return 'image/jpeg';
    }
    if (route === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (route === 'json') return 'application/json';
    if (route === 'html') return 'text/html';
    if (route === 'md') return 'text/markdown';
    return 'application/pdf';
}

function plainText(html) {
    return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizeHtml(html) {
    return typeof DOMPurify !== 'undefined'
        ? DOMPurify.sanitize(html, {
            ADD_TAGS: ['style'], ALLOW_DATA_ATTR: true, ADD_ATTR: ['style'], FORCE_BODY: false,
        })
        : html;
}

function extractMarkdownTables(md, out) {
    const ROW = /^\s*\|(.+)\|\s*$/;
    const DELIM = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
    const cells = line => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
        .split('|').map(cell => cell.trim());
    const lines = md.split('\n');
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
        const table = ROW.test(lines[i]) && i + 1 < lines.length && DELIM.test(lines[i + 1]);
        if (!table) { kept.push(lines[i]); continue; }
        const headers = cells(lines[i]);
        const rows = [];
        let j = i + 2;
        for (; j < lines.length && ROW.test(lines[j]); j++) rows.push(cells(lines[j]));
        const head = `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`;
        const body = rows.map(row => `<tr>${row.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
        out.push(`<div class="pdf-table-wrap pdf-table--lattice"><table class="tablecoil"><tbody>${head}${body}</tbody></table></div>`);
        kept.push(`@@GXTABLE${out.length - 1}@@`);
        i = j - 1;
    }
    return kept.join('\n');
}

export function markdownToHtml(md) {
    const tables = [];
    const html = extractMarkdownTables(md, tables)
        .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '<hr>')
        .replace(/^#{6}\s+(.+)$/gm, '<h6>$1</h6>')
        .replace(/^#{5}\s+(.+)$/gm, '<h5>$1</h5>')
        .replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>')
        .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
        .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
        .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>\n?)+/g, value => `<ul>${value}</ul>`)
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\n{2,}/g, '</p><p>')
        .replace(/^(?!<[h|u|l|p])/gm, '')
        .replace(/^(.+)$/gm, line => {
            if (/^<(h[1-6]|ul|li|p|hr|div|table)/.test(line)) return line;
            if (/^@@GXTABLE\d+@@$/.test(line)) return line;
            return `<p class="pdf-region type-paragraph">${line}</p>`;
        });
    return html.replace(/@@GXTABLE(\d+)@@/g, (_, i) => tables[Number(i)] || '');
}

async function imageBytesToPdf(bytes, { name, type }) {
    const pdf = await PDFDocument.create();
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const isPng = type === 'image/png' || /\.png$/i.test(name);
    const isJpeg = /image\/jpe?g/i.test(type) || /\.jpe?g$/i.test(name);
    let embedded;
    if (isPng) embedded = await pdf.embedPng(source);
    else if (isJpeg) embedded = await pdf.embedJpg(source);
    else {
        const bitmap = await createImageBitmap(new Blob([source], { type: type || mimeForFile(name) }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        const png = await canvas.convertToBlob({ type: 'image/png' });
        embedded = await pdf.embedPng(await png.arrayBuffer());
    }
    const scale = Math.min(1, 1000 / Math.max(embedded.width, embedded.height));
    const width = Math.max(1, embedded.width * scale);
    const height = Math.max(1, embedded.height * scale);
    const page = pdf.addPage([width, height]);
    page.drawImage(embedded, { x: 0, y: 0, width, height });
    return new Uint8Array(await pdf.save({ useObjectStreams: false }));
}

export async function parseFileBytes(bytes, { name = 'document.pdf', type = '', extractImage } = {}) {
    const format = routeFile(name);
    if (format === 'pdf') return { kind: 'pdf', bytes };
    if (format === 'image') {
        const pdfBytes = await imageBytesToPdf(bytes, { name, type });
        if (extractImage) return extractImage(pdfBytes);
        return { kind: 'pdf', bytes: pdfBytes, source: 'image' };
    }
    if (format === 'docx') {
        const [{ docxToGxDoc }, { gxDocToHtml }, { ensureBlockIds }] = await Promise.all([
            import('../ir/docxToGxDoc.js'), import('../ir/gxDocToHtml.js'), import('../ir/gxDoc.js'),
        ]);
        const docxBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const gxDoc = await docxToGxDoc(docxBuffer, { source: 'docx', title: name });
        ensureBlockIds(gxDoc);
        const html = gxDocToHtml(gxDoc);
        return { kind: 'import', source: 'docx', html, text: plainText(html), gxDoc };
    }
    const raw = new TextDecoder().decode(bytes);
    if (format === 'json') {
        const [{ jsonToGxDoc }, { gxDocToHtml }, { ensureBlockIds }] = await Promise.all([
            import('../ir/jsonToGxDoc.js'), import('../ir/gxDocToHtml.js'), import('../ir/gxDoc.js'),
        ]);
        const gxDoc = jsonToGxDoc(raw, { source: 'json', title: name });
        ensureBlockIds(gxDoc);
        const html = gxDocToHtml(gxDoc);
        return { kind: 'import', source: 'json', html, text: plainText(html), gxDoc };
    }
    const source = format === 'md' ? 'markdown' : 'html';
    const clean = sanitizeHtml(format === 'md' ? markdownToHtml(raw) : raw);
    const { htmlToGxDocAddressable } = await import('../ir/htmlToGxDoc.js');
    const { gxDoc, html } = htmlToGxDocAddressable(clean, { source, title: name });
    return { kind: 'import', source, html, text: plainText(clean), gxDoc };
}

export async function parseFile(file, options = {}) {
    const parsed = await parseFileBytes(new Uint8Array(await file.arrayBuffer()), {
        name: file.name, type: file.type, extractImage: options.extractImage,
    });
    if (parsed.kind === 'pdf') {
        return {
            ...parsed,
            file: parsed.source === 'image'
                ? new File([parsed.bytes], file.name, { type: 'application/pdf' })
                : file,
        };
    }
    return { ...parsed, file };
}
