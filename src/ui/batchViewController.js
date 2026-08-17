/**
 * batchViewController.js
 * UI Controller for Batch Processing embedded inside the Nav Panel.
 * Handles drag-and-drop ingestion, focused document extraction, slot mounting, and JSON export.
 */

import $ from 'jquery';
import { state } from '../state.js';
import { BatchQueueManager } from '@batch/batchQueue.js';
import { WorkerPool } from '@batch/workerPool.js';
import { switchView } from './viewController.js';
import { showToast } from './toast.js';
import { mountExtractedDocument, markdownToHtml } from './fileUpload.js';
import { htmlToGxDoc } from '../ir/htmlToGxDoc.js';
import { enforceBudget, touchDoc } from '../utils/imageStore.js';
import { gxDocToHtml } from '../ir/gxDocToHtml.js';
import { docxToGxDoc } from '../ir/docxToGxDoc.js';
import { jsonToGxDoc } from '../ir/jsonToGxDoc.js';
import { mergeGxDocs } from '../ir/mergeGxDocs.js';
import { renderGxDocAs, downloadRendered } from './exportController.js';
import { buildAnnotatedPdf } from '../annotation/exportPdf.js';
import { syncTextEditsToGxDoc } from './pdfTextEdit.js';
import { requireSignIn, refreshGates } from './authGate.js';
import { PDFDocument } from 'pdf-lib';

export let batchQueue = null;
export let workerPool = null;
export let _focusedBatchId = null;

/**
 * Non-PDF batch import.
 * Deliberately the SAME importers a single-file upload uses (handleDocumentFile
 * / handleDocxFile / handleJsonFile) rather than the ad-hoc decoding the batch
 * worker used to do, which produced `<pre>`-wrapped markdown and no IR at all.
 */
async function decodeDocument({ bytes, format, name }) {
    if (format === 'docx') {
        const gxDoc = await docxToGxDoc(bytes.buffer, { source: 'docx', title: name });
        const html = gxDocToHtml(gxDoc);
        return { html, text: _htmlToPlain(html), gxDoc };
    }

    const raw = new TextDecoder().decode(bytes);

    if (format === 'json') {
        const gxDoc = jsonToGxDoc(raw, { source: 'json', title: name });
        const html = gxDocToHtml(gxDoc);
        return { html, text: _htmlToPlain(html), gxDoc };
    }

    if (format === 'html' || format === 'md') {
        const html = format === 'md' ? markdownToHtml(raw) : raw;
        const clean = typeof DOMPurify !== 'undefined'
            ? DOMPurify.sanitize(html, { ADD_TAGS: ['style'], ALLOW_DATA_ATTR: true, FORCE_BODY: false })
            : html;
        return {
            html: clean,
            text: _htmlToPlain(clean),
            gxDoc: htmlToGxDoc(clean, { source: format === 'md' ? 'markdown' : 'html', title: name }),
        };
    }

    throw new Error(`Unsupported batch format: .${format}`);
}

function _htmlToPlain(html) {
    return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function initBatchViewController() {
    // The pool owns scheduling; this tool owns the extraction worker. Passing
    // the factory in keeps the two independent — the pool never needs to know
    // where the engine lives.
    workerPool = new WorkerPool({
        workerFactory: () => new Worker(
            new URL('../workers/geometryWorker.js', import.meta.url),
            { type: 'module' },
        ),
        pdfWorkerSrc: window.__VSC_PDF_WORKER_SRC__,
    });

    batchQueue = new BatchQueueManager({
        workerPool,
        decodeDocument,
        buildGxDoc: ({ html, name, pageCount }) =>
            htmlToGxDoc(html, { source: 'pdf', title: name, pageCount: pageCount ?? null }),
    });

    batchQueue.on('progress', updateBatchUI);
    batchQueue.on('itemComplete', (evt) => {
        updateBatchUI();
        // Auto-mount only the document the user is actually waiting on.
        if (evt.item && evt.item.id === _focusedBatchId) {
            focusBatchItem(evt.item.id, 1);
        }
    });
    batchQueue.on('itemError', (evt) => {
        updateBatchUI();
        showToast(`Batch: "${evt.item.name}" failed — ${evt.error}`, 'error', 6000);
    });
    batchQueue.on('drain', updateBatchUI);

    _wireGlobalBatchEvents();
}

function _wireGlobalBatchEvents() {
    // Nav Panel header action button "+ Upload"
    $('#btn-batch-upload').on('click', () => {
        $('#nav-batch-file-input').trigger('click');
    });
}

// Progress now streams per PAGE per document, so a naive re-render would rebuild
// the whole list hundreds of times a second. Coalesce to one paint per frame.
let _uiFrame = 0;
export function updateBatchUI() {
    if (_uiFrame) return;
    _uiFrame = requestAnimationFrame(() => { _uiFrame = 0; _renderBatchUI(); });
}

function _renderBatchUI() {
    const $container = $('#nav-view-batch');
    if (!$container.length || !batchQueue) return;

    const items = batchQueue.getAllItems();

    // If container is empty or structure unbuilt, build full layout
    if ($container.children('.nav-batch-wrapper').length === 0) {
        $container.html(`
            <div class="nav-batch-wrapper" style="padding: 12px; display: flex; flex-direction: column; gap: 12px; height: 100%;">
                <!-- COMPACT DROPZONE -->
                <div id="nav-batch-dropzone" class="nav-batch-dropzone" style="border: 2px dashed #cbd5e1; border-radius: 8px; padding: 16px 12px; text-align: center; background: #f8fafc; cursor: pointer; transition: all 0.2s ease;">
                    <iconify-icon icon="material-symbols:cloud-upload-outline" style="font-size: 24px; color: #64748b; margin-bottom: 4px;"></iconify-icon>
                    <div style="font-size: 12px; font-weight: 600; color: #1e293b;">Drag & drop batch files</div>
                    <div style="font-size: 11px; color: #64748b; margin-bottom: 8px;">PDF, DOCX, HTML, MD, JSON</div>
                    <button class="nav-action-btn" id="btn-browse-batch" style="margin: 0 auto; font-size: 11px; padding: 3px 8px;">
                        <iconify-icon icon="material-symbols:folder-open"></iconify-icon> Browse Files
                    </button>
                    <input id="nav-batch-file-input" type="file" multiple accept="application/pdf,text/html,.html,text/markdown,.md,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,application/json,.json" style="display: none;" />
                </div>

                <!-- BATCH TOOLBAR -->
                <div class="nav-batch-toolbar" style="display: flex; justify-content: space-between; align-items: center; padding: 4px 0;">
                    <span id="nav-batch-count" style="font-size: 11px; font-weight: 600; color: #64748b;">${items.length} Documents</span>
                    <button id="nav-batch-clear-btn" class="nav-action-btn" title="Clear Batch Queue" style="font-size: 11px; padding: 3px 6px;">
                        <iconify-icon icon="material-symbols:delete-outline"></iconify-icon>
                    </button>
                </div>

                <!-- EXPORT BAR -->
                <div class="nav-batch-export" style="display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid #e2e8f0; border-radius: 6px; background: #f8fafc;">
                    <div style="display: flex; gap: 6px; align-items: center;">
                        <select id="nav-batch-format" style="flex: 1; font-size: 11px; padding: 3px 6px; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff; color: #0f172a;">
                            <option value="markdown">Markdown (.md)</option>
                            <option value="html">HTML (.html)</option>
                            <option value="json">gx-doc JSON (.json)</option>
                            <option value="xml">XML (.xml)</option>
                            <option value="doc">Word (.doc)</option>
                            <option value="pdf">PDF (.pdf)</option>
                            <option value="manifest">Batch manifest (.json)</option>
                        </select>
                        <button id="nav-batch-export-btn" class="nav-action-btn" title="Export the batch" style="font-size: 11px; padding: 3px 8px;">
                            <iconify-icon icon="material-symbols:download"></iconify-icon> Export
                        </button>
                    </div>
                    <label style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: #475569; cursor: pointer;">
                        <input type="checkbox" id="nav-batch-combine" checked style="margin: 0;" />
                        <span>Combine into one file</span>
                    </label>
                    <div id="nav-batch-export-hint" style="font-size: 10px; color: #94a3b8; line-height: 1.35;"></div>
                </div>

                <!-- BATCH ITEM LIST -->
                <div id="nav-batch-list" class="nav-batch-list" style="display: flex; flex-direction: column; gap: 8px; overflow-y: auto; flex: 1;"></div>
            </div>
        `);

        _wireDropzoneEvents();
    } else {
        $('#nav-batch-count').text(`${items.length} Documents`);
        _updateExportHint();
    }

    _renderBatchItemList(items);
    // The panel HTML above replaces #nav-view-batch's children, taking the
    // gate overlay with it. Re-apply after every rebuild.
    refreshGates();
}

function _wireDropzoneEvents() {
    const $dropzone = $('#nav-batch-dropzone');
    const $input = $('#nav-batch-file-input');

    $dropzone.on('click', (e) => {
        if ($(e.target).closest('button').length || e.target === $input[0]) return;
        $input.trigger('click');
    });

    $('#btn-browse-batch').on('click', (e) => {
        e.stopPropagation();
        $input.trigger('click');
    });

    $input.on('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
            // The overlay is a picture; this is the check. Guard the ENTRY
            // POINT so a signed-out user cannot start work by any route.
            if (!requireSignIn('pdf-batch-signin')) { e.target.value = ''; return; }
            const added = batchQueue.enqueueMany(e.target.files);
            e.target.value = '';
            if (added.length > 0) {
                // Focus first newly enqueued item
                focusBatchItem(added[0].id, 1);
            }
        }
    });

    $dropzone.on('dragover', (e) => {
        e.preventDefault();
        $dropzone.css({ 'border-color': '#3b82f6', 'background': '#eff6ff' });
    });

    $dropzone.on('dragleave drop', (e) => {
        e.preventDefault();
        $dropzone.css({ 'border-color': '#cbd5e1', 'background': '#f8fafc' });
    });

    $dropzone.on('drop', (e) => {
        const dt = e.originalEvent.dataTransfer;
        if (dt && dt.files && dt.files.length > 0) {
            if (!requireSignIn('pdf-batch-signin')) return;
            const added = batchQueue.enqueueMany(dt.files);
            if (added.length > 0) {
                focusBatchItem(added[0].id, 1);
            }
        }
    });

    $('#nav-batch-clear-btn').on('click', () => {
        // Keep the content-hash cache: clearing the LIST should not throw away
        // extraction work for documents the user re-adds seconds later. Their
        // crops stay too — the cached HTML references them by key, so deleting
        // the pixels would turn every re-added document into placeholders. What
        // bounds the store is the byte budget, which evicts whole documents
        // least-recently-used first; this is exactly the abandoned-but-maybe-
        // wanted case it exists for.
        enforceBudget().catch(() => {});
        batchQueue.clear({ keepCache: true });
        _focusedBatchId = null;
        updateBatchUI();
    });

    $('#nav-batch-export-btn').on('click', exportBatchResults);
    $('#nav-batch-format, #nav-batch-combine').on('change', _updateExportHint);
    _updateExportHint();
}

/** Say what the current selection will actually produce, before it produces it. */
function _updateExportHint() {
    const $hint = $('#nav-batch-export-hint');
    if (!$hint.length || !batchQueue) return;

    const format = $('#nav-batch-format').val() || 'markdown';
    const combine = $('#nav-batch-combine').is(':checked');
    const done = batchQueue.getAllItems().filter(i => i.status === 'completed');

    if (format === 'manifest') {
        $('#nav-batch-combine').prop('disabled', true);
        $hint.text(`One JSON holding every document's IR, HTML, text and lineage graph (${done.length} documents).`);
        return;
    }
    $('#nav-batch-combine').prop('disabled', false);

    if (format === 'pdf') {
        const pdfs = done.filter(i => i.format === 'pdf' && i.bytes).length;
        const skipped = done.length - pdfs;
        $hint.text(combine
            ? `Merges ${pdfs} PDF${pdfs !== 1 ? 's' : ''} into one file with annotations, links and bookmarks.${skipped ? ` ${skipped} non-PDF skipped.` : ''}`
            : `${pdfs} separate annotated PDF${pdfs !== 1 ? 's' : ''}.${skipped ? ` ${skipped} non-PDF skipped.` : ''}`);
        return;
    }

    const withIr = done.filter(i => i.gxDoc).length;
    const skipped = done.length - withIr;
    $hint.text(combine
        ? `One ${format.toUpperCase()} file, documents in list order, each titled and bookmarked.${skipped ? ` ${skipped} skipped (no IR).` : ''}`
        : `${withIr} separate ${format.toUpperCase()} files, downloaded one after another.${skipped ? ` ${skipped} skipped (no IR).` : ''}`);
}

function _renderBatchItemList(items) {
    const $list = $('#nav-batch-list');
    if (!$list.length) return;

    if (items.length === 0) {
        $list.html(`
            <div class="nav-empty-hint" style="padding: 24px 12px; text-align: center;">
                <iconify-icon icon="material-symbols:folder-zip-outline" style="font-size: 32px; color: #cbd5e1; margin-bottom: 8px;"></iconify-icon>
                <div style="font-weight: 500; color: #64748b;">No Batch Documents</div>
                <div style="font-size: 11px; color: #94a3b8; margin-top: 4px;">Upload files above to process & switch contexts seamlessly.</div>
            </div>
        `);
        return;
    }

    const html = items.map(item => {
        const isFocused = item.id === _focusedBatchId;
        const isSlot1 = state.pdf1.file && state.pdf1.file.name === item.name;
        const isSlot2 = state.pdf2.file && state.pdf2.file.name === item.name;

        const formatUpper = item.format.toUpperCase();
        const badgeColor = item.status === 'completed' ? '#10b981' :
                           item.status === 'error' ? '#ef4444' :
                           item.status === 'processing' ? '#3b82f6' : '#64748b';

        // Real per-page status from the geometry worker, not a fabricated
        // percentage. "Page 7/31" is the honest signal a long extraction needs.
        const statusLabel = item.status === 'completed' ? (item.fromCache ? 'CACHED' : 'READY') :
                            item.status === 'processing' ? escapeHtml(item.statusText || `${item.progress}%`) :
                            item.status === 'error' ? 'ERROR' : 'QUEUED';

        return `
            <div class="nav-batch-card ${isFocused ? 'active' : ''}" data-id="${item.id}" style="
                border: 1px solid ${isFocused ? '#3b82f6' : '#e2e8f0'};
                border-left: 4px solid ${isFocused ? '#3b82f6' : '#cbd5e1'};
                border-radius: 6px;
                padding: 10px;
                background: ${isFocused ? '#eff6ff' : '#ffffff'};
                cursor: pointer;
                transition: all 0.15s ease;
                display: flex;
                flex-direction: column;
                gap: 6px;
            ">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: #f1f5f9; color: #334155;">
                        ${formatUpper}
                    </span>
                    <div style="display: flex; gap: 4px; align-items: center;">
                        ${isSlot1 ? '<span style="font-size: 9px; font-weight: 700; background: #dbeafe; color: #1e40af; padding: 1px 5px; border-radius: 3px;">SLOT 1</span>' : ''}
                        ${isSlot2 ? '<span style="font-size: 9px; font-weight: 700; background: #fef3c7; color: #92400e; padding: 1px 5px; border-radius: 3px;">SLOT 2</span>' : ''}
                        <span style="font-size: 10px; font-weight: 600; color: ${badgeColor};">
                            ${statusLabel}
                        </span>
                    </div>
                </div>

                <div style="font-size: 12px; font-weight: 600; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(item.name)}">
                    ${escapeHtml(item.name)}
                </div>

                ${item.status === 'processing' ? `
                    <div style="width: 100%; height: 3px; background: #e2e8f0; border-radius: 2px; overflow: hidden;">
                        <div style="width: ${item.progress}%; height: 100%; background: #3b82f6; transition: width 0.2s;"></div>
                    </div>
                ` : ''}

                ${item.status === 'error' ? `
                    <div style="font-size: 10px; color: #b91c1c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(item.error || '')}">
                        ${escapeHtml(item.error || 'Extraction failed')}
                    </div>
                ` : ''}

                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px; border-top: 1px solid #f1f5f9; padding-top: 4px;">
                    <span style="font-size: 10px; color: #94a3b8;">
                        ${item.status === 'completed' && item.format === 'pdf'
                            ? `${item.pageCount} pg · ${item.tableCount} tbl`
                            : 'Click to Focus &amp; Extract'}
                    </span>
                    <div style="display: flex; gap: 4px;">
                        ${item.status === 'error' ? `
                            <button class="nav-action-btn retry-btn" data-id="${item.id}" title="Retry extraction" style="font-size: 10px; padding: 1px 6px;">
                                Retry
                            </button>
                        ` : ''}
                        <button class="nav-action-btn load-slot2-btn" data-id="${item.id}" title="Load to Slot 2 for Compare Diff" style="font-size: 10px; padding: 1px 6px;">
                            + Slot 2
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    $list.html(html);

    // Bind click handlers for item cards & slot 2 buttons
    $list.find('.nav-batch-card').on('click', function (e) {
        if ($(e.target).closest('.load-slot2-btn, .retry-btn').length) return;
        const itemId = $(this).data('id');
        focusBatchItem(itemId, 1);
    });

    $list.find('.load-slot2-btn').on('click', function (e) {
        e.stopPropagation();
        focusBatchItem($(this).data('id'), 2);
    });

    $list.find('.retry-btn').on('click', function (e) {
        e.stopPropagation();
        batchQueue.retry($(this).data('id'));
    });
}

export async function focusBatchItem(itemId, slotNum = 1) {
    if (!requireSignIn('pdf-batch-signin')) return;
    const item = batchQueue.getItem(itemId);
    if (!item) return;

    _focusedBatchId = itemId;
    updateBatchUI();
    // The document you are looking at is the last one that should be evicted.
    touchDoc(itemId).catch(() => {});

    if (item.status === 'error') {
        showToast(`"${item.name}" failed: ${item.error}. Use Retry on the card.`, 'error', 6000);
        return;
    }
    if (item.status !== 'completed') {
        // itemComplete re-enters this function for the focused item, so this is
        // a status message, not a dead end.
        showToast(`Extracting "${item.name}"…`, 'info');
        return;
    }

    try {
        // Mount through the SAME path a single-file upload uses. Everything the
        // main timeline sets up — canvas, editable text layers, annotation
        // layers, analysis regions, zone chips, diff state — comes from here.
        await mountExtractedDocument({
            file: item.file,
            bytes: item.format === 'pdf' ? item.bytes : null,
            html: item.extractedHTML || '<p>No extracted content available.</p>',
            text: item.extractedText || '',
            styles: item.styles || '',
            docId: item.id,
            gxDoc: item.gxDoc,
            pages: item.pages,
            extraction: {
                source: item.format === 'pdf' ? 'local' : `batch-import-${item.format}`,
                pageCount: item.pageCount || null,
                tableCount: item.format === 'pdf' ? item.tableCount : null,
                scannedPageCount: null,
                isScanned: null,
                batch: true,
                cached: item.fromCache,
            },
            slot: slotNum,
        });

        if (slotNum === 2) {
            showToast(`Loaded "${item.name}" into Slot 2 for Compare Diff`, 'success');
            return;
        }

        switchView(item.format === 'pdf' && item.bytes ? 'pdf' : 'html');

        const detail = item.format === 'pdf'
            ? ` — ${item.pageCount} page${item.pageCount !== 1 ? 's' : ''}, ${item.tableCount} table${item.tableCount !== 1 ? 's' : ''}`
            : '';
        showToast(`Focused "${item.name}"${detail}${item.fromCache ? ' (cached)' : ''}`, 'success');
    } catch (err) {
        console.error('[Batch] focus failed:', err);
        showToast(`Failed to focus "${item.name}": ${err.message}`, 'error');
    }
}

/**
 * Batch export.
 *
 * Combined export is a MERGE problem, not six format problems: every exporter is
 * already gx-doc-first, so N documents are merged into one gx-doc and handed to
 * the same emitters a single-document export uses. Only PDF is different —
 * pages are real objects, so the source PDFs are concatenated with pdf-lib and
 * the merged annotations/bookmarks/text-edits are drawn onto the result.
 */
export async function exportBatchResults() {
    if (!requireSignIn('pdf-batch-signin')) return;
    const items = batchQueue.getAllItems().filter(i => i.status === 'completed');
    if (items.length === 0) {
        showToast('No completed batch items to export.', 'warning');
        return;
    }

    // The focused document's text edits live in the DOM until harvested. Its
    // gxDoc IS the batch item's gxDoc (same object), so this lands in the export.
    syncTextEditsToGxDoc();

    const format = $('#nav-batch-format').val() || 'markdown';
    const combine = $('#nav-batch-combine').is(':checked');

    if (format === 'manifest') return exportBatchManifest(items);
    if (format === 'pdf') return exportBatchPdf(items, combine);

    const withIr = items.filter(i => i.gxDoc);
    const skipped = items.length - withIr.length;
    if (!withIr.length) {
        showToast('No documents have a structured IR to export. Re-run extraction.', 'error');
        return;
    }

    try {
        if (combine) {
            const merged = mergeGxDocs(
                withIr.map(i => ({ name: i.name, gxDoc: i.gxDoc })),
                { title: `Batch of ${withIr.length} documents` },
            );
            const name = `batch_${withIr.length}-docs_${_stamp()}`;
            downloadRendered(renderGxDocAs(format, merged, name), name);
            showToast(
                `Exported ${withIr.length} documents as one ${format.toUpperCase()} file` +
                (skipped ? ` (${skipped} skipped — no IR)` : ''),
                'success',
            );
        } else {
            // Sequential downloads — there is no archiver dependency here, and
            // adding one is an architecture decision, not an export detail.
            for (const item of withIr) {
                const name = item.name.replace(/\.[^.]+$/, '');
                downloadRendered(renderGxDocAs(format, item.gxDoc, name), name);
                await new Promise(r => setTimeout(r, 120)); // browsers throttle bursts
            }
            showToast(
                `Exported ${withIr.length} separate ${format.toUpperCase()} files` +
                (skipped ? ` (${skipped} skipped — no IR)` : ''),
                'success',
            );
        }
    } catch (err) {
        console.error('[Batch] export failed:', err);
        showToast(`Batch export failed: ${err.message}`, 'error', 6000);
    }
}

/**
 * Combined PDF: concatenate the source pages, then draw the MERGED gx-doc's
 * annotations, links, bookmarks and text edits onto the result. Merging first
 * and annotating second is what keeps page-keyed data pointing at the right
 * pages — annotating each document separately then concatenating would lose the
 * outline on the second merge.
 */
async function exportBatchPdf(items, combine) {
    const pdfItems = items.filter(i => i.format === 'pdf' && i.bytes);
    if (!pdfItems.length) {
        showToast('No PDF documents in the batch to export as PDF.', 'error');
        return;
    }
    const skipped = items.length - pdfItems.length;

    try {
        if (!combine) {
            for (const item of pdfItems) {
                const out = await buildAnnotatedPdf({ bytes: item.bytes.slice(), gxDoc: item.gxDoc || {} });
                downloadRendered(
                    { content: new Blob([out], { type: 'application/pdf' }), mime: 'application/pdf', ext: 'pdf' },
                    item.name.replace(/\.pdf$/i, ''),
                );
                await new Promise(r => setTimeout(r, 120));
            }
            showToast(`Exported ${pdfItems.length} separate PDFs`, 'success');
            return;
        }

        showToast(`Merging ${pdfItems.length} PDFs…`, 'info');
        const out = await PDFDocument.create();
        for (const item of pdfItems) {
            const src = await PDFDocument.load(item.bytes.slice(), { ignoreEncryption: true });
            const copied = await out.copyPages(src, src.getPageIndices());
            copied.forEach(p => out.addPage(p));
        }
        const mergedBytes = await out.save();

        // Only the PDF items contribute pages, so the gx-doc merge must use the
        // same set in the same order or every page number would be off.
        const mergedDoc = mergeGxDocs(
            pdfItems.map(i => ({ name: i.name, gxDoc: i.gxDoc })),
            { title: `Batch of ${pdfItems.length} PDFs` },
        );

        const final = await buildAnnotatedPdf({ bytes: mergedBytes, gxDoc: mergedDoc });
        const name = `batch_${pdfItems.length}-pdfs_${_stamp()}`;
        downloadRendered(
            { content: new Blob([final], { type: 'application/pdf' }), mime: 'application/pdf', ext: 'pdf' },
            name,
        );
        showToast(
            `Merged ${pdfItems.length} PDFs into one file` + (skipped ? ` (${skipped} non-PDF skipped)` : ''),
            'success',
        );
    } catch (err) {
        console.error('[Batch] PDF export failed:', err);
        showToast(`PDF export failed: ${err.message}`, 'error', 6000);
    }
}

function _stamp() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

/** The original all-in-one manifest: every document's IR plus its lineage. */
function exportBatchManifest(items) {
    const exportData = {
        schema: 'ginexys-batch-export-v1',
        exportedAt: new Date().toISOString(),
        totalItems: items.length,
        items: items.map(item => ({
            name: item.name,
            format: item.format,
            // The content hash is the cache key AND the provenance anchor: it
            // identifies exactly which bytes produced this result.
            contentHash: item.contentHash,
            pageCount: item.pageCount,
            tableCount: item.tableCount,
            gxDoc: item.gxDoc,
            extractedHTML: item.extractedHTML,
            extractedText: item.extractedText,
            provenance: item.graph ? item.graph.serialize() : null
        }))
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `batch_export_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported batch results JSON', 'success');
}

function escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
