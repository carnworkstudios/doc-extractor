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
import { downloadExtractedHTML, isProUser, integrationBackendUrl } from './fileUpload.js';
import { exportAnnotatedPdf } from '../annotation/exportPdf.js';
import { syncTextEditsToGxDoc } from './pdfTextEdit.js';
import { waitForToolReady } from '../utils/toolReady.js';
import { gxDocToHtml } from '../ir/gxDocToHtml.js';

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

    // Pro/dev: ungate the integration rows so clicks reach the dropdown-item
    // handler instead of the waitlist interceptor.
    if (isProUser()) {
        for (const slug of ['pdf-export-notion', 'pdf-export-sheets']) {
            const overlay = document.querySelector(`#export-dropdown .gx-pro-interceptor[data-pro-feature="${slug}"]`);
            if (!overlay) continue;
            overlay.closest('.dropdown-item')?.classList.remove('gx-pro-locked');
            overlay.remove();
        }
    }
}

async function handleExport(format) {
    const gxDoc = state.pdf1.gxDoc;
    const html  = state.pdf1.extractedHTML;
    if (!html && !gxDoc) {
        showToast('No content to export. Load a file first.', 'error');
        return;
    }

    switch (format) {
        case 'html':
            downloadExtractedHTML();
            break;
        case 'pdf':
            await exportToPdf();
            break;
        case 'markdown':
            await exportToMarkdown(gxDoc ?? null, html);
            break;
        case 'xml':
            exportToXML(gxDoc ?? null, html);
            break;
        case 'doc':
            exportToDoc(gxDoc ?? null, html);
            break;
        case 'json':
            exportToJson(gxDoc);
            break;
        case 'notion':
        case 'sheets':
            await exportToIntegration(format, html);
            break;
    }
}

// ── PDF export (vector: original pages + annotations) ─────────────────────────

/** Vector PDF export — copies the original PDF and overlays annotations. */
async function exportToPdf() {
    const { bytes, gxDoc, file } = state.pdf1;
    if (!bytes) {
        showToast('No PDF loaded to export.', 'error');
        return;
    }
    // Text edits live in the DOM until something asks for them. Harvest before
    // the build so an export never silently drops in-progress edits.
    const textEdits = syncTextEditsToGxDoc();
    const hasAnn = Array.isArray(gxDoc?.annotations) && gxDoc.annotations.length > 0;
    if (!hasAnn && !textEdits.length) {
        showToast('Exporting original PDF (no annotations present)…', 'info');
    } else {
        const parts = [];
        if (hasAnn) parts.push('annotations');
        if (textEdits.length) parts.push(`${textEdits.length} text edit${textEdits.length !== 1 ? 's' : ''}`);
        showToast(`Building vector PDF with ${parts.join(' + ')}…`, 'info');
    }
    const fileName = `${(file?.name || 'annotated').replace(/\.pdf$/i, '')}-annotated.pdf`;
    try {
        await exportAnnotatedPdf({ bytes, gxDoc, fileName, onStatus: showToast });
        showToast('Vector PDF exported', 'success');
    } catch (err) {
        showToast(`PDF export failed: ${err.message}`, 'error', 5000);
    }
}

// ── Integration export (Pro) — extracted tables → /api/v1/io/* adapters ───────


function tableToGrid(tableEl) {
    return [...tableEl.querySelectorAll('tr')].map(tr =>
        [...tr.querySelectorAll('td, th')].map(cell => cell.textContent.trim())
    );
}

async function exportToIntegration(provider, html) {
    const tables = [...parseDoc(html).querySelectorAll('table')];
    if (!tables.length) {
        showToast('No tables found in the extracted document.', 'error');
        return;
    }

    const label = provider === 'notion' ? 'Notion' : 'Google Sheets';
    showToast(`Exporting ${tables.length} table${tables.length > 1 ? 's' : ''} to ${label}…`);

    const base = integrationBackendUrl();
    let lastUrl = '';
    // Sheets: first table creates the spreadsheet, the rest land as extra
    // sheets in it. Notion: each table becomes a database under the parent page.
    let target = {};
    try {
        for (let i = 0; i < tables.length; i++) {
            const name = tables.length > 1 ? `${baseName()} — table ${i + 1}` : baseName();
            const res = await fetch(`${base}/api/v1/io/${provider}/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, grid: tableToGrid(tables[i]), target }),
            });
            const data = await res.json();
            if (data.status !== 'success') throw new Error(data.error || 'Export failed');
            lastUrl = data.url || lastUrl;
            if (provider === 'sheets' && data.spreadsheet_id) {
                target = { spreadsheet_id: data.spreadsheet_id };
            }
        }
    } catch (err) {
        showToast(`${label} export failed: ${err.message}`, 'error', 5000);
        return;
    }

    if (lastUrl) {
        try { await navigator.clipboard.writeText(lastUrl); } catch (_) { /* clipboard optional */ }
        showToast(`Exported to ${label} — link copied to clipboard.`, 'success', 5000);
        console.log(`[export] ${label}: ${lastUrl}`);
    } else {
        showToast(`Exported to ${label}.`, 'success');
    }
}

// ── Cross-tool send (Pro) — OS shell Send card → gx-tables-v1 envelope ────────

// The shell's IPC panel relays a Send-card click as gx:ipc-send. TAFNE consumes
// gx-tables-v1 envelopes via loadTablesAsSheets; the vector→Schema route lives
// in the Analyze tab, so that card just points there.
window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin || e.data?.type !== 'gx:ipc-send') return;
    if (e.data.target === 'tifany') {
        sendTablesToTafne();
    } else if (e.data.target === 'svg_wiring') {
        showToast('Use the Analyze tab to send vector regions to Schema Editor.', 'info', 4000);
    }
});

async function sendTablesToTafne() {
    const html = state.pdf1.extractedHTML;
    if (!html) {
        showToast('No content to send. Load a file first.', 'error');
        return;
    }
    const domTables = [...parseDoc(html).querySelectorAll('table')];
    if (!domTables.length) {
        showToast('No tables found in the extracted document.', 'error');
        return;
    }
    if (!window.CwsBridge?.isEmbedded) {
        showToast('Not embedded in the OS shell.', 'error');
        return;
    }

    // gx-tables-v1 rows are objects keyed by header — headers must be unique.
    // Candidate-artifact contract (tool-intelligence-spec.md §04.2): a table
    // extracted from a PDF is a CANDIDATE, not a finished fact. We attach its
    // extraction confidence and mark candidate:true so TAFNE's trust stage
    // treats it as "to verify", not "trusted" — the two-stage trust model
    // (extracted-uncertain → validated-trusted). The score is the region's own
    // classifier confidence when the table maps to an extracted region.
    const tables = domTables.map((t, i) => {
        const grid = tableToGrid(t);
        const seen = {};
        const headers = (grid[0] || []).map((h, j) => {
            let name = (h || '').trim() || `Column ${j + 1}`;
            if (seen[name]) name = `${name} (${++seen[name]})`;
            seen[name] = seen[name] || 1;
            return name;
        });
        const rows = grid.slice(1).map(r =>
            Object.fromEntries(headers.map((h, j) => [h, r[j] ?? ''])));
        // Extraction confidence: prefer a data-confidence on the table element,
        // fall back to 'uncertain' (0.7) so downstream always knows it's a candidate.
        const conf = parseFloat(t.getAttribute?.('data-confidence'));
        const extractionScore = !isNaN(conf) ? conf : 0.7;
        return {
            name: domTables.length > 1 ? `${baseName()} — table ${i + 1}` : baseName(),
            rows,
            candidate: true,
            extractionScore,
        };
    }).filter(t => t.rows.length);
    if (!tables.length) {
        showToast('Tables have no data rows to send.', 'error');
        return;
    }

    try {
        window.CwsBridge.send('cws:tool:launch', { toolId: 'tifany', focusAfterLaunch: true }, 'os');
        await waitForToolReady('tifany', 8000);
        // meta.candidate flags the whole handoff as extracted-uncertain, so the
        // receiver (TAFNE) knows to route it through its validate/trust stage.
        const payload = { schema: 'gx-tables-v1', tables, meta: { source: 'pdf-processor', title: baseName(), candidate: true } };
        // Lineage assembly is an optional host-provided capability. When
        // window.GxProvenance is absent no lineage is sent and the tool works
        // exactly as before. This tool is a pipeline SOURCE, so there is nothing
        // incoming to inherit; build() returns its own extraction record.
        // Aggregate extraction confidence across the candidate tables → the
        // extraction-stage score on the lineage spine.
        const avgScore = tables.reduce((s, t) => s + (t.extractionScore || 0), 0) / tables.length;
        const provenance = window.GxProvenance
            ? window.GxProvenance.build('pdf-processor', window.CwsContracts.PROVENANCE_STAGES.EXTRACTION, {
                source: baseName(),
                score: avgScore,          // extracted-uncertain: real per-batch confidence
                candidate: true,
            })
            : [];
        const pointerId = await window.CwsBridge.requestStore(JSON.stringify(payload), 'json-data');
        window.CwsBridge.offerData(window.CwsContracts.createEnvelope({
            pointer: pointerId,
            contentType: 'json-data',
            metadata: { source: 'pdf-processor', title: baseName(), tableCount: tables.length, candidate: true },
            // action:'load-candidate-tables' tells TAFNE to route through verify,
            // not treat as a finished table. TAFNE falls back to load-tables if it
            // doesn't yet special-case candidates.
            hints: { suggestedTarget: 'tifany', action: 'load-candidate-tables' },
            provenance,
        }));
        showToast(`Sent ${tables.length} table${tables.length > 1 ? 's' : ''} to TAFNE`, 'success');
    } catch (err) {
        showToast(`Send failed: ${err.message || err}`, 'error');
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
    // The success moment of the whole product: the user is taking their data
    // out. Recorded here rather than at button-click so format and size are
    // known, and so it fires for every export route through this helper.
    try {
        window.GxTrack?.('document_exported', {
            tool: 'pdf-processor',
            export_format: ext,
            size_bytes: typeof content === 'string' ? content.length : null,
        });
    } catch (_) { /* analytics is never load-bearing */ }

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

// ── Flow-chain merge (reading-order rejoin) ───────────────────────────────────
//
// The assembler links paragraphs that continue across column/zone seams: the
// FIRST <p> of a continuation region carries data-flow-prev + data-continuation,
// and the head <p> carries data-flow-next (see flowLinker.js / pageAssembler.js).
// The spatial HTML keeps every fragment in its own column, but the semantic
// exports (Markdown/XML) must present one continuous paragraph. This pre-pass
// walks each chain head-first and folds every continuation <p> into the head,
// mirroring the assembler's _joinFlowText join semantics, then removes the
// now-empty continuation <p> so the recursive emitter never sees it.

// Trailing hyphen forms the dehyphenate join strips: ASCII, unicode, soft.
const FLOW_HYPHEN_END_RE = /[-‐‑­]\s*$/;

/** Deepest last non-empty text node in an element (for seam joining). */
function _lastTextNode(el) {
    for (let i = el.childNodes.length - 1; i >= 0; i--) {
        const n = el.childNodes[i];
        if (n.nodeType === Node.TEXT_NODE) {
            if (n.textContent && n.textContent.trim()) return n;
        } else if (n.nodeType === Node.ELEMENT_NODE) {
            const found = _lastTextNode(n);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Fold continuation <p> `cont` into head <p> `head`, honoring the join kind
 * (mirrors pageAssembler._joinFlowText): 'dehyphenate' strips the trailing
 * hyphen and butts the words together, 'hyphen-keep' butts with the hyphen
 * intact, 'space' (default) inserts a single separating space. Inline markup
 * (bold/italic spans) is preserved by moving nodes rather than text.
 */
function _absorbFlow(head, cont, join, doc) {
    const last = _lastTextNode(head);
    if (join === 'dehyphenate') {
        if (last) last.textContent = last.textContent.replace(FLOW_HYPHEN_END_RE, '');
    } else if (join === 'hyphen-keep') {
        if (last) last.textContent = last.textContent.replace(/\s+$/, '');
    } else {
        if (last) last.textContent = last.textContent.replace(/\s+$/, '');
        head.appendChild(doc.createTextNode(' '));
    }
    let first = true;
    while (cont.firstChild) {
        const child = cont.firstChild;
        if (first && child.nodeType === Node.TEXT_NODE) {
            child.textContent = child.textContent.replace(/^\s+/, '');
        }
        head.appendChild(child);
        first = false;
    }
}

/** Merge all paragraph flow chains in-place, removing absorbed continuations. */
export function mergeFlowChains(doc) {
    const byId = new Map();
    doc.querySelectorAll('[id]').forEach(el => byId.set(el.getAttribute('id'), el));

    // Chain heads: have a next link but no continuation link that resolves in
    // this document (a true head, not a mid-chain node).
    const heads = [...doc.querySelectorAll('[data-flow-next]')].filter(el => {
        const prev = el.getAttribute('data-flow-prev');
        return !prev || !byId.has(prev);
    });

    for (const head of heads) {
        const seen = new Set([head]);
        let nextId = head.getAttribute('data-flow-next');
        while (nextId) {
            const cont = byId.get(nextId);
            if (!cont || seen.has(cont)) break; // dangling ref or cycle guard
            seen.add(cont);
            const following = cont.getAttribute('data-flow-next'); // read before removal
            const join = cont.getAttribute('data-flow-join') || 'space';
            _absorbFlow(head, cont, join, doc);
            cont.remove();
            nextId = following;
        }
        head.removeAttribute('data-flow-next');
        head.removeAttribute('data-flow-prev');
        head.removeAttribute('data-flow-join');
        head.removeAttribute('data-continuation');
    }
}

// Structural wrappers the semantic exporters descend through — reading order is
// child order within each (page-row → col → zone → region), so a plain
// depth-first walk over children yields blocks in reading order.
export const FLOW_WRAPPER_RE = /\bpdf-(page-row|col|zone|region)\b/;

// ── Markdown export ───────────────────────────────────────────────────────────

async function exportToMarkdown(gxDoc, html) {
    if (gxDoc) {
        showToast('Generating Markdown…', 'info');
        downloadBlob(gxDocToMarkdown(gxDoc), 'text/markdown', 'md');
        showToast('Markdown exported', 'success');
        return;
    }
    showToast('Generating Markdown…', 'info');
    const doc = parseDoc(html);
    mergeFlowChains(doc);
    const lines = [];

    const pages = doc.querySelectorAll('section.pdf-page-content');
    const sections = pages.length ? pages : [doc.body];

    const emitLeaf = (el) => {
        const tag = el.tagName.toLowerCase();
        const cls = el.className || '';

        // Headings
        if (tag === 'h1') { lines.push(`# ${blockText(el)}\n`); return; }
        if (tag === 'h2') { lines.push(`## ${blockText(el)}\n`); return; }
        if (tag === 'h3') { lines.push(`### ${blockText(el)}\n`); return; }
        if (tag === 'h4') { lines.push(`#### ${blockText(el)}\n`); return; }
        if (tag === 'h5') { lines.push(`##### ${blockText(el)}\n`); return; }
        if (tag === 'h6') { lines.push(`###### ${blockText(el)}\n`); return; }

        // Page label emitted by assembler — skip, it's noise
        if (cls.includes('page-label')) return;

        // Divider
        if (tag === 'hr') { lines.push('---\n'); return; }

        // Table
        if (cls.includes('pdf-table-wrap')) {
            const table = el.querySelector('table');
            if (table) { lines.push(tableToMarkdown(table) + '\n'); }
            return;
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
            return;
        }

        // Unordered list
        if (tag === 'ul') {
            [...el.querySelectorAll('li')].forEach(li => {
                lines.push(`- ${blockText(li)}`);
            });
            lines.push('');
            return;
        }

        // Ordered list
        if (tag === 'ol') {
            [...el.querySelectorAll('li')].forEach((li, i) => {
                lines.push(`${i + 1}. ${blockText(li)}`);
            });
            lines.push('');
            return;
        }

        // Image placeholder
        if (tag === 'div' && cls.includes('pdf-image-placeholder')) {
            const img = el.querySelector('img[data-img-id]');
            const id = img?.getAttribute('data-img-id') || 'img';
            lines.push(`![Image ${id}](image_${id}.png)\n`);
            return;
        }

        // Paragraph div (font/align classes) or any other block
        const text = blockText(el);
        if (text) lines.push(text + '\n');
    };

    const walk = (container) => {
        for (const el of container.children) {
            const cls = el.className || '';
            if (FLOW_WRAPPER_RE.test(cls)) { walk(el); continue; }
            emitLeaf(el);
        }
    };

    sections.forEach((page, pi) => {
        if (pages.length > 1 && pi > 0) lines.push('\n---\n');
        walk(page);
    });

    downloadBlob(lines.join('\n'), 'text/markdown', 'md');
    showToast('Markdown exported', 'success');
}

// ── XML export ────────────────────────────────────────────────────────────────

function exportToXML(gxDoc, html) {
    if (gxDoc) {
        showToast('Generating XML…', 'info');
        const name = baseName();
        downloadBlob(gxDocToXml(gxDoc, name), 'application/xml', 'xml');
        showToast('XML exported', 'success');
        return;
    }
    showToast('Generating XML…', 'info');
    const doc = parseDoc(html);
    mergeFlowChains(doc);
    const name = baseName();
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<document name="${xmlEsc(name)}">\n`;

    const pages = doc.querySelectorAll('section.pdf-page-content');
    const sections = pages.length ? [...pages] : [doc.body];

    const emitLeaf = (el) => {
        const tag = el.tagName.toLowerCase();
        const cls = el.className || '';

        if (cls.includes('page-label')) return;

        // Headings
        if (/^h[1-6]$/.test(tag)) {
            const level = tag[1];
            xml += `    <heading level="${level}">${xmlEsc(el.textContent.trim())}</heading>\n`;
            return;
        }

        // Divider
        if (tag === 'hr') { xml += `    <divider/>\n`; return; }

        // Table
        if (cls.includes('pdf-table-wrap')) {
            const table = el.querySelector('table');
            if (table) xml += tableToXml(table, '    ') + '\n';
            return;
        }

        // Callout box
        if (tag === 'aside' && cls.includes('pdf-box')) {
            const role = cls.includes('warning') ? 'warning'
                       : cls.includes('caution') ? 'caution'
                       : cls.includes('note')    ? 'note'
                       : cls.includes('tip')     ? 'tip'
                       : 'box';
            xml += `    <callout type="${role}">${xmlEsc(el.textContent.trim())}</callout>\n`;
            return;
        }

        // Lists
        if (tag === 'ul' || tag === 'ol') {
            const kind = tag === 'ol' ? 'ordered' : 'unordered';
            xml += `    <list type="${kind}">\n`;
            [...el.querySelectorAll('li')].forEach(li => {
                xml += `      <item>${xmlEsc(li.textContent.trim())}</item>\n`;
            });
            xml += `    </list>\n`;
            return;
        }

        // Image placeholder
        if (cls.includes('pdf-image-placeholder')) {
            const img = el.querySelector('img[data-img-id]');
            const id = img?.getAttribute('data-img-id') || '';
            xml += `    <image ref="${xmlEsc(id)}"/>\n`;
            return;
        }

        // Paragraph
        const text = el.textContent.trim();
        if (text) xml += `    <paragraph>${xmlEsc(text)}</paragraph>\n`;
    };

    const walk = (container) => {
        for (const el of container.children) {
            const cls = el.className || '';
            if (FLOW_WRAPPER_RE.test(cls)) { walk(el); continue; }
            emitLeaf(el);
        }
    };

    sections.forEach((page, pi) => {
        const pageNum = page.getAttribute('data-page') || (pi + 1);
        xml += `  <page number="${pageNum}">\n`;
        walk(page);
        xml += `  </page>\n`;
    });

    xml += `</document>`;
    downloadBlob(xml, 'application/xml', 'xml');
    showToast('XML exported', 'success');
}

// ── DOC export (HTML → Office mhtml envelope) ─────────────────────────────────

function exportToDoc(gxDoc, html) {
    showToast('Generating Word document…', 'info');
    const name = baseName();
    const body = gxDoc ? gxDocToHtml(gxDoc) : html;
    downloadBlob(wrapAsWordDoc(body, name), 'application/msword', 'doc');
    showToast('Word document exported', 'success');
}

/** The Office HTML envelope Word opens as a document. */
export function wrapAsWordDoc(body, name) {
    return `
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
${body}
</body>
</html>`.trim();
}

// ── Pure render surface (used by the batch combined export) ───────────────────

/**
 * Render a gx-doc to a target format WITHOUT downloading it.
 *
 * The single-document exporters above own the download + toast + analytics.
 * Batch needs the same emitters against a MERGED gx-doc under a different file
 * name, so the string production is exposed here rather than duplicated. Every
 * format below is gx-doc-first, which is the whole reason combined export is a
 * merge problem and not six format-specific merge problems.
 *
 * @returns {{content: string, mime: string, ext: string}}
 */
export function renderGxDocAs(format, gxDoc, name = 'document') {
    switch (format) {
        case 'markdown':
            return { content: gxDocToMarkdown(gxDoc), mime: 'text/markdown', ext: 'md' };
        case 'xml':
            return { content: gxDocToXml(gxDoc, name), mime: 'application/xml', ext: 'xml' };
        case 'doc':
            return { content: wrapAsWordDoc(gxDocToHtml(gxDoc), name), mime: 'application/msword', ext: 'doc' };
        case 'json':
            return { content: JSON.stringify(gxDoc, null, 2), mime: 'application/json', ext: 'json' };
        case 'html':
            return { content: wrapAsStandaloneHtml(gxDocToHtml(gxDoc), name), mime: 'text/html', ext: 'html' };
        default:
            throw new Error(`Unsupported render format: ${format}`);
    }
}

/** Minimal self-contained HTML document around rendered gx-doc markup. */
export function wrapAsStandaloneHtml(body, name) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${xmlEsc(name)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.6;
         max-width: 900px; margin: 0 auto; padding: 40px 24px; color: #111; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  td, th { border: 1px solid #999; padding: 6px 10px; font-size: 14px; text-align: left; }
  th { background: #f2f2f2; }
  aside { border: 1px solid #888; padding: 8px 14px; margin: 12px 0; }
  img { max-width: 100%; height: auto; }
  hr { border: none; border-top: 1px solid #ccc; margin: 20px 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** Download a rendered payload under an explicit name (batch export path). */
export function downloadRendered({ content, mime, ext }, fileName) {
    try {
        window.GxTrack?.('document_exported', {
            tool: 'pdf-processor',
            export_format: ext,
            size_bytes: typeof content === 'string' ? content.length : null,
            batch: true,
        });
    } catch (_) { /* analytics is never load-bearing */ }

    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${fileName}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ── JSON export (gx-doc/1 IR) ─────────────────────────────────────────────────

function exportToJson(gxDoc) {
    if (!gxDoc) {
        showToast('No structured document in state.', 'error');
        return;
    }
    downloadBlob(JSON.stringify(gxDoc, null, 2), 'application/json', 'json');
    showToast('JSON exported', 'success');
}

// ── gx-doc emitters (typed IR path for Markdown / XML) ────────────────────────

/** Render a block's runs to inline Markdown; falls back to its plain text. */
function runsToMarkdown(block) {
    if (!Array.isArray(block.runs) || !block.runs.length) return block.text || '';
    return block.runs.map(r => {
        const s = r.text || '';
        if (r.bold && r.italic) return `***${s}***`;
        if (r.bold) return `**${s}**`;
        if (r.italic) return `*${s}*`;
        return s;
    }).join('');
}

function gxDocToMarkdown(gxDoc) {
    const lines = [];
    gxDoc.pages.forEach((page, pi) => {
        if (pi > 0) lines.push('\n---\n');
        // Array order is the emitter's reading order (column-major inside a
        // page row) — identical to the DOM-walk export it replaces.
        for (const b of page.blocks) {
            switch (b.type) {
                case 'heading':
                    lines.push(`${'#'.repeat(b.level)} ${runsToMarkdown(b).trim()}\n`);
                    break;
                case 'paragraph': {
                    const text = runsToMarkdown(b).trim();
                    if (text) lines.push(text + '\n');
                    break;
                }
                case 'table':
                    lines.push(gxTableToMarkdown(b) + '\n');
                    break;
                case 'list':
                    (b.items || []).forEach((item, i) => {
                        lines.push(`${b.ordered ? `${i + 1}.` : '-'} ${item}`);
                    });
                    lines.push('');
                    break;
                case 'callout': {
                    const role = b.kind === 'warning' ? '> **⚠ Warning**\n>\n'
                        : b.kind === 'caution' ? '> **⚡ Caution**\n>\n'
                        : b.kind === 'note' ? '> **ℹ Note**\n>\n'
                        : b.kind === 'tip' ? '> **✅ Tip**\n>\n'
                        : '> ';
                    const body = (b.text || '').split('\n').map(l => `> ${l}`).join('\n');
                    lines.push(role + body + '\n');
                    break;
                }
                case 'image':
                    lines.push(`![Image ${b.id}](image_${b.id}.png)\n`);
                    break;
                case 'divider':
                    lines.push('---\n');
                    break;
            }
        }
    });
    return lines.join('\n');
}

function gxTableToMarkdown(b) {
    const grid = [b.headers || [], ...(b.rows || [])].filter(row => row.length);
    if (!grid.length) return '';
    const header = grid[0];
    const sep = header.map(() => '---');
    const body = grid.slice(1);
    const escCell = c => String(c == null ? '' : c).replace(/\|/g, '\\|');
    const lines = [
        `| ${header.map(escCell).join(' | ')} |`,
        `| ${sep.join(' | ')} |`,
        ...body.map(row => `| ${row.map(escCell).join(' | ')} |`),
    ];
    return lines.join('\n');
}

function gxDocToXml(gxDoc, name) {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<document name="${xmlEsc(name)}">\n`;
    gxDoc.pages.forEach((page, pi) => {
        xml += `  <page number="${page.page ?? (pi + 1)}">\n`;
        for (const b of page.blocks) {
            switch (b.type) {
                case 'heading':
                    xml += `    <heading level="${b.level}">${xmlEsc(b.text || '')}</heading>\n`;
                    break;
                case 'paragraph':
                    if (b.text) xml += `    <paragraph>${xmlEsc(b.text)}</paragraph>\n`;
                    break;
                case 'table':
                    xml += gxTableToXml(b, '    ') + '\n';
                    break;
                case 'list':
                    xml += `    <list type="${b.ordered ? 'ordered' : 'unordered'}">\n`;
                    (b.items || []).forEach(item => xml += `      <item>${xmlEsc(item)}</item>\n`);
                    xml += `    </list>\n`;
                    break;
                case 'callout':
                    xml += `    <callout type="${xmlEsc(b.kind || 'box')}">${xmlEsc(b.text || '')}</callout>\n`;
                    break;
                case 'image':
                    xml += `    <image ref="${xmlEsc(b.id || '')}"/>\n`;
                    break;
                case 'divider':
                    xml += `    <divider/>\n`;
                    break;
            }
        }
        xml += `  </page>\n`;
    });
    xml += `</document>`;
    return xml;
}

function gxTableToXml(b, indent) {
    const i = indent;
    let out = `${i}<table>\n`;
    if (b.headers && b.headers.length) {
        out += `${i}  <row>\n`;
        b.headers.forEach(h => out += `${i}    <header>${xmlEsc(h)}</header>\n`);
        out += `${i}  </row>\n`;
    }
    (b.rows || []).forEach(row => {
        out += `${i}  <row>\n`;
        row.forEach(cell => out += `${i}    <cell>${xmlEsc(cell)}</cell>\n`);
        out += `${i}  </row>\n`;
    });
    out += `${i}</table>`;
    return out;
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
