/**
 * navPanel.js
 * Unified left-aligned navigation panel with 3 tabs:
 *   1. Outline: Document heading hierarchy & page jump tree
 *   2. Bookmarks: User-pinned page / scroll locations
 *   3. Annotations: List of all vector & text annotations
 */

import $ from 'jquery';
import { state } from '../state.js';
import { getCurrentPage, jumpToPage } from './pageNav.js';
import * as annEngine from '../annotation/engine.js';
import { showToast } from './toast.js';
import { getEffectiveActiveView } from './viewController.js';
import { updateBatchUI } from './batchViewController.js';
import { promptDialog } from './promptDialog.js';

let _activeTab = 'outline'; // 'outline' | 'bookmarks' | 'annotations' | 'links' | 'batch'
let _isOpen = false;

export function initNavPanel() {
    _bindEvents();
    _subscribeToEngine();
}

export function toggleNavPanel(open) {
    if (open !== undefined) {
        _isOpen = open;
    } else {
        _isOpen = !_isOpen;
    }
    $('#app-workspace').toggleClass('nav-panel-open', _isOpen);
    $('#btn-toggle-nav').toggleClass('active', _isOpen);

    renderNavPanel();
}

export function renderNavPanel() {
    const activeView = getEffectiveActiveView();
    const isPdf = activeView === 'pdf';

    // Context-aware tooltips
    $('.nav-tab-btn[data-tab="outline"]').attr('title', isPdf ? 'PDF Outline & Pages' : 'Doc Structure & Headings');
    $('.nav-tab-btn[data-tab="bookmarks"]').attr('title', 'Bookmarks');
    $('.nav-tab-btn[data-tab="annotations"]').attr('title', isPdf ? 'PDF Annotations' : 'Doc Notes');
    $('.nav-tab-btn[data-tab="links"]').attr('title', 'Hyperlinks & References');
    $('.nav-tab-btn[data-tab="batch"]').attr('title', 'Batch Documents & Queue');

    // Tab strip active highlight (only when panel body is open)
    $('.nav-tab-btn').removeClass('active');
    if (_isOpen) {
        $(`.nav-tab-btn[data-tab="${_activeTab}"]`).addClass('active');
    }

    // Toggle header action buttons (Pin Page vs Add Link vs Upload Batch)
    $('#btn-add-bookmark').toggle(_activeTab === 'bookmarks');
    $('#btn-add-link').toggle(_activeTab === 'links');
    $('#btn-batch-upload').toggle(_activeTab === 'batch');

    if (!_isOpen) return;

    // Header title update based on context & active tab
    if (_activeTab === 'outline') {
        $('#nav-panel-title').text(isPdf ? 'PDF Outline' : 'Doc Structure');
    } else if (_activeTab === 'bookmarks') {
        $('#nav-panel-title').text('Bookmarks');
    } else if (_activeTab === 'annotations') {
        $('#nav-panel-title').text(isPdf ? 'Annotations' : 'Doc Notes');
    } else if (_activeTab === 'links') {
        $('#nav-panel-title').text('Hyperlinks');
    } else if (_activeTab === 'batch') {
        $('#nav-panel-title').text('Batch Documents');
    }

    // Hide all tab views, show active
    $('.nav-panel-view').removeClass('active');
    $(`#nav-view-${_activeTab}`).addClass('active');

    switch (_activeTab) {
        case 'outline':
            renderOutlineTab();
            break;
        case 'bookmarks':
            renderBookmarksTab();
            break;
        case 'annotations':
            renderAnnotationsTab();
            break;
        case 'links':
            renderLinksTab();
            break;
        case 'batch':
            updateBatchUI();
            break;
    }
}

function _bindEvents() {
    $('#btn-toggle-nav').on('click', () => toggleNavPanel());
    $('#nav-panel-close').on('click', () => toggleNavPanel(false));

    $('.nav-tab-btn').on('click', function () {
        const tab = $(this).data('tab');
        if (_isOpen && _activeTab === tab) {
            toggleNavPanel(false);
        } else {
            _activeTab = tab;
            toggleNavPanel(true);
        }
    });

    // Add Bookmark button
    $('#btn-add-bookmark').on('click', () => {
        addBookmarkCurrentPage();
    });

    // Add Link button
    $('#btn-add-link').on('click', () => {
        addNewHyperlink();
    });

    // Live HTML edit tracking for link updates
    $('#html-preview').on('input blur keyup', () => {
        if (_isOpen && _activeTab === 'links') {
            renderLinksTab();
        }
    });
}

function _subscribeToEngine() {
    annEngine.subscribe(() => renderNavPanel());
}

// ── TAB 1: OUTLINE (PANEL AWARE: PDF OUTLINE vs DOC STRUCTURE) ────────────────

function renderOutlineTab() {
    const $container = $('#nav-view-outline').empty();
    const activeView = getEffectiveActiveView();
    const isPdf = activeView === 'pdf';
    const gxDoc = state.pdf1.gxDoc;
    const curPage = getCurrentPage();

    let items = []; // { type, page, level, text, element }

    if (isPdf) {
        // PDF VIEW OUTLINE MODE
        if (gxDoc?.pages?.length) {
            gxDoc.pages.forEach(p => {
                const pageNum = p.page || 1;
                const headings = (p.blocks || []).filter(b => b.type === 'heading');
                if (headings.length) {
                    headings.forEach(h => {
                        items.push({
                            type: 'pdf',
                            page: pageNum,
                            level: h.level || 1,
                            text: h.text || `Heading ${h.level || 1}`
                        });
                    });
                } else {
                    items.push({
                        type: 'pdf',
                        page: pageNum,
                        level: 0,
                        text: `Page ${pageNum}`
                    });
                }
            });
        } else {
            const $pages = $('#pdf-canvas-container .page-wrapper');
            if ($pages.length) {
                $pages.each((i, el) => {
                    const pageNum = parseInt($(el).attr('data-page'), 10) || (i + 1);
                    items.push({ type: 'pdf', page: pageNum, level: 0, text: `Page ${pageNum}` });
                });
            }
        }
    } else {
        // DOCS / HTML / EDITOR VIEW OUTLINE MODE
        const surfaceId = 'html-preview';
        const $preview = $(`#${surfaceId}`).length ? $(`#${surfaceId}`) : $('#html-preview');
        const $headings = $preview.find('h1, h2, h3, h4, h5, h6, .pdf-page-content');

        if ($headings.length) {
            $headings.each((i, el) => {
                const $el = $(el);
                if ($el.hasClass('pdf-page-content')) {
                    const pageNum = parseInt($el.attr('data-page'), 10) || (i + 1);
                    items.push({
                        type: 'doc',
                        page: pageNum,
                        level: 0,
                        text: `Section ${pageNum}`,
                        element: el
                    });
                } else {
                    const tag = el.tagName.toLowerCase();
                    const level = parseInt(tag.replace('h', ''), 10) || 1;
                    const text = $el.text().trim() || `Heading ${level}`;
                    const pageNum = parseInt($el.closest('.pdf-page-content').attr('data-page'), 10) || 1;
                    items.push({
                        type: 'doc',
                        page: pageNum,
                        level: level,
                        text: text,
                        element: el
                    });
                }
            });
        } else if (state.pdf1?.extractedHTML) {
            try {
                const parser = new DOMParser();
                const doc = parser.parseFromString(state.pdf1.extractedHTML, 'text/html');
                const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
                headings.forEach((h) => {
                    const tag = h.tagName.toLowerCase();
                    const level = parseInt(tag.replace('h', ''), 10) || 1;
                    items.push({
                        type: 'doc',
                        page: 1,
                        level: level,
                        text: h.textContent.trim() || `Heading ${level}`
                    });
                });
            } catch (e) {
                console.warn('Failed to parse extractedHTML headings', e);
            }
        }
    }

    if (!items.length) {
        const emptyMsg = isPdf ? 'No PDF outline available.' : 'No document headings (H1-H6) found.';
        $container.html(`<div class="nav-empty-hint">${emptyMsg}</div>`);
        return;
    }

    const $tree = $('<div class="nav-tree"></div>');

    items.forEach(item => {
        const isCurrent = isPdf && item.page === curPage;
        const indentCls = item.level > 0 ? `nav-indent-${Math.min(item.level, 4)}` : '';
        const pageHeaderCls = item.level === 0 ? 'nav-item-page-head' : '';
        const activeCls = isCurrent ? 'nav-item-active' : '';

        const badgeText = item.type === 'pdf'
            ? `p.${item.page}`
            : (item.level > 0 ? `H${item.level}` : `Sec`);

        const iconifyTag = item.level === 0
            ? 'material-symbols:description-outline'
            : (item.level === 1 ? 'material-symbols:format-h1' : (item.level === 2 ? 'material-symbols:format-h2' : 'material-symbols:title'));

        const $row = $(`
            <div class="nav-tree-item ${indentCls} ${pageHeaderCls} ${activeCls}">
                <span class="nav-tree-icon">
                    <iconify-icon icon="${iconifyTag}"></iconify-icon>
                </span>
                <span class="nav-tree-text">${_escapeHtml(item.text)}</span>
                <span class="nav-tree-page-badge">${badgeText}</span>
            </div>
        `);

        $row.on('click', () => {
            if (isPdf) {
                jumpToPage(item.page);
            } else if (activeView === 'editor' && state.monacoEditor) {
                const query = item.text;
                const matches = state.monacoEditor.getModel()?.findMatches(query, true, false, false, null, true);
                if (matches && matches.length) {
                    const line = matches[0].range.startLineNumber;
                    state.monacoEditor.revealLineInCenter(line);
                    state.monacoEditor.setPosition({ lineNumber: line, column: 1 });
                    state.monacoEditor.focus();
                }
            } else {
                let targetEl = item.element;
                if (!targetEl || !document.body.contains(targetEl)) {
                    const activeSurfId = 'html-preview';
                    const container = document.getElementById(activeSurfId) || document.getElementById('html-preview');
                    if (container) {
                        targetEl = container.querySelector(`.pdf-page-content[data-page="${item.page}"]`)
                            || Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6')).find(h => h.textContent.trim() === item.text);
                    }
                }
                if (targetEl) {
                    targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    $(targetEl).css({ outline: '2px solid #4facfe', borderRadius: '3px' });
                    setTimeout(() => $(targetEl).css({ outline: '', borderRadius: '' }), 1800);
                } else if (item.page) {
                    jumpToPage(item.page);
                }
            }
            renderOutlineTab();
        });

        $tree.append($row);
    });

    $container.append($tree);
}

// ── TAB 2: BOOKMARKS ─────────────────────────────────────────────────────────

function renderBookmarksTab() {
    const $container = $('#nav-view-bookmarks');
    $container.find('.nav-bookmarks-list').remove();

    const gxDoc = state.pdf1.gxDoc;
    if (!gxDoc) {
        $container.append('<div class="nav-empty-hint nav-bookmarks-list">Load a document to manage bookmarks.</div>');
        return;
    }

    if (!Array.isArray(gxDoc.bookmarks)) {
        gxDoc.bookmarks = [];
    }

    const bookmarks = gxDoc.bookmarks;
    if (!bookmarks.length) {
        $container.append('<div class="nav-empty-hint nav-bookmarks-list">No bookmarks saved yet. Click "+ Add Bookmark" to pin your current page location.</div>');
        return;
    }

    const $list = $('<div class="nav-bookmarks-list"></div>');
    const curPage = getCurrentPage();

    bookmarks.forEach((bm, idx) => {
        const isCurrent = bm.page === curPage;
        const $item = $(`
            <div class="nav-bm-item ${isCurrent ? 'active' : ''}">
                <span class="nav-bm-icon"><iconify-icon icon="material-symbols:bookmark"></iconify-icon></span>
                <div class="nav-bm-main">
                    <input type="text" class="nav-bm-title" value="${_escapeHtml(bm.label || `Page ${bm.page}`)}" />
                    <span class="nav-bm-meta">Page ${bm.page} &bull; ${new Date(bm.created || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <button class="nav-bm-del" title="Delete bookmark"><iconify-icon icon="material-symbols:delete-outline"></iconify-icon></button>
            </div>
        `);

        $item.find('.nav-bm-title').on('click', (e) => e.stopPropagation());
        $item.find('.nav-bm-title').on('change', function () {
            bm.label = $(this).val();
            showToast('Bookmark updated', 'info');
        });

        $item.on('click', () => {
            jumpToPage(bm.page);
            renderBookmarksTab();
        });

        $item.find('.nav-bm-del').on('click', (e) => {
            e.stopPropagation();
            gxDoc.bookmarks.splice(idx, 1);
            showToast('Bookmark removed', 'info');
            renderBookmarksTab();
        });

        $list.append($item);
    });

    $container.append($list);
}

function addBookmarkCurrentPage() {
    const gxDoc = state.pdf1.gxDoc;
    if (!gxDoc) {
        showToast('No active document to bookmark.', 'error');
        return;
    }
    if (!Array.isArray(gxDoc.bookmarks)) {
        gxDoc.bookmarks = [];
    }

    const curPage = getCurrentPage();
    const existing = gxDoc.bookmarks.find(b => b.page === curPage);
    if (existing) {
        showToast(`Page ${curPage} is already bookmarked.`, 'info');
        return;
    }

    const newBm = {
        id: `bm_${Date.now()}`,
        page: curPage,
        label: `Bookmark - Page ${curPage}`,
        created: new Date().toISOString()
    };

    gxDoc.bookmarks.push(newBm);
    showToast(`Added bookmark for Page ${curPage}`, 'success');
    renderBookmarksTab();
}

// ── TAB 3: ANNOTATIONS ────────────────────────────────────────────────────────

function renderAnnotationsTab() {
    const $container = $('#nav-view-annotations').empty();
    const annotations = annEngine.getAnnotations();

    if (!annotations.length) {
        $container.html('<div class="nav-empty-hint">No annotations created yet. Select an annotation tool from the toolbar to draw on the page.</div>');
        return;
    }

    // Group annotations by page
    const byPage = new Map();
    annotations.forEach(a => {
        const p = a.page || 1;
        if (!byPage.has(p)) byPage.set(p, []);
        byPage.get(p).push(a);
    });

    const sortedPages = [...byPage.keys()].sort((a, b) => a - b);
    const $list = $('<div class="nav-ann-list"></div>');

    sortedPages.forEach(pNum => {
        const anns = byPage.get(pNum);
        const $group = $(`
            <div class="nav-ann-group">
                <div class="nav-ann-group-title">Page ${pNum} (${anns.length})</div>
            </div>
        `);

        anns.forEach(ann => {
            const kindIcon = _annKindIcon(ann.kind);
            const color = ann.style?.color || '#3b82f6';
            const label = ann.text || ann.label || `${ann.kind} annotation`;

            const $row = $(`
                <div class="nav-ann-item" data-id="${ann.id}">
                    <span class="nav-ann-swatch" style="background:${color}"></span>
                    <span class="nav-ann-icon"><iconify-icon icon="${kindIcon}"></iconify-icon></span>
                    <span class="nav-ann-title">${_escapeHtml(label)}</span>
                    <button class="nav-ann-del" title="Delete annotation"><iconify-icon icon="material-symbols:close"></iconify-icon></button>
                </div>
            `);

            $row.on('click', () => {
                jumpToPage(pNum);
                annEngine.setMode('annotate');
                annEngine.setTool('select');
                annEngine.selectAnnotation(ann.id);
            });

            $row.find('.nav-ann-del').on('click', (e) => {
                e.stopPropagation();
                annEngine.removeAnnotation(ann.id);
            });

            $group.append($row);
        });

        $list.append($group);
    });

    // Clear all footer
    const $footer = $(`
        <div class="nav-ann-footer">
            <button class="nav-ann-clear-btn"><iconify-icon icon="material-symbols:delete-sweep-outline"></iconify-icon> Clear All Annotations</button>
        </div>
    `);

    $footer.find('.nav-ann-clear-btn').on('click', () => {
        if (confirm('Delete all annotations from this document?')) {
            annEngine.clearAnnotations();
            showToast('All annotations cleared', 'info');
        }
    });

    $container.append($list).append($footer);
}

function _annKindIcon(kind) {
    switch (kind) {
        case 'highlight': return 'material-symbols:format-ink-highlighter';
        case 'ink': return 'material-symbols:ink-pen';
        case 'rect': return 'material-symbols:crop-square';
        case 'ellipse': return 'material-symbols:circle-outline';
        case 'arrow': return 'material-symbols:trending-flat';
        case 'text': return 'material-symbols:text-fields';
        case 'measure': return 'material-symbols:straighten';
        default: return 'material-symbols:edit-note-outline';
    }
}

function _escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── TAB 4: HYPERLINKS & REFERENCES ───────────────────────────────────────────

export function renderLinksTab() {
    const $container = $('#nav-view-links').empty();
    const activeView = getEffectiveActiveView();
    const gxDoc = state.pdf1.gxDoc;

    let links = []; // { id, text, href, isExternal, page, element, source: 'html'|'pdf' }

    // 1. Scan active HTML preview DOM for <a> tags
    const surfaceId = 'html-preview';
    const $preview = $(`#${surfaceId}`).length ? $(`#${surfaceId}`) : $('#html-preview');
    const $aTags = $preview.find('a[href]');
    if ($aTags.length) {
        $aTags.each((i, el) => {
            const $el = $(el);
            const href = ($el.attr('href') || '').trim();
            const text = $el.text().trim() || $el.attr('title') || href || `Link ${i + 1}`;
            const isExternal = href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:') || href.startsWith('tel:');
            const page = parseInt($el.closest('.pdf-page-content').attr('data-page'), 10) || 1;

            links.push({
                id: `html_link_${i}`,
                text,
                href,
                isExternal,
                page,
                element: el,
                source: 'html'
            });
        });
    }

    // 2. Scan PDF document state for links
    if (gxDoc?.links?.length) {
        gxDoc.links.forEach((l, idx) => {
            const href = (l.href || l.url || '').trim();
            const text = l.text || l.label || `PDF Link ${idx + 1}`;
            const isExternal = href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:');
            links.push({
                id: l.id || `pdf_link_${idx}`,
                text,
                href,
                isExternal,
                page: l.page || 1,
                rawObj: l,
                source: 'pdf'
            });
        });
    }

    if (!links.length) {
        $container.html(`
            <div class="nav-empty-hint">
                No hyperlinks found in document.<br><br>
                Select text in editor or click <strong>"+ Add Link"</strong> above to insert a link.
            </div>
        `);
        return;
    }

    const $list = $('<div class="nav-links-list"></div>');

    links.forEach((link) => {
        const iconName = link.isExternal ? 'material-symbols:open-in-new' : 'material-symbols:link';
        const badgeTag = link.isExternal ? 'EXT' : (link.source === 'pdf' ? `p.${link.page}` : 'INT');

        const $item = $(`
            <div class="nav-link-item" data-id="${link.id}">
                <span class="nav-link-icon">
                    <iconify-icon icon="${iconName}"></iconify-icon>
                </span>
                <div class="nav-link-main">
                    <span class="nav-link-text" title="${_escapeHtml(link.text)}">${_escapeHtml(link.text)}</span>
                    <span class="nav-link-url" title="${_escapeHtml(link.href)}">${_escapeHtml(link.href)}</span>
                </div>
                <span class="nav-link-badge">${badgeTag}</span>
                <div class="nav-link-actions">
                    ${link.isExternal ? `<button class="nav-link-act-btn open" title="Open URL in new tab"><iconify-icon icon="material-symbols:launch"></iconify-icon></button>` : ''}
                    <button class="nav-link-act-btn edit" title="Edit Link URL"><iconify-icon icon="material-symbols:edit-outline"></iconify-icon></button>
                    <button class="nav-link-act-btn del" title="Remove Link"><iconify-icon icon="material-symbols:delete-outline"></iconify-icon></button>
                </div>
            </div>
        `);

        // Click row -> Focus & jump to element/page
        $item.on('click', () => {
            if (link.source === 'html') {
                let targetEl = link.element;
                if (!targetEl || !document.body.contains(targetEl)) {
                    const activeSurfId = 'html-preview';
                    const container = document.getElementById(activeSurfId) || document.getElementById('html-preview');
                    if (container) targetEl = container.querySelector(`a[href="${link.href}"]`);
                }
                if (targetEl) {
                    targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    $(targetEl).css({ outline: '2px solid #4facfe', borderRadius: '3px' });
                    setTimeout(() => $(targetEl).css({ outline: '', borderRadius: '' }), 1800);
                }
            } else if (link.page) {
                jumpToPage(link.page);
            }
        });

        // Open button
        $item.find('.nav-link-act-btn.open').on('click', (e) => {
            e.stopPropagation();
            if (link.href) window.open(link.href, '_blank', 'noopener,noreferrer');
        });

        // Edit button
        $item.find('.nav-link-act-btn.edit').on('click', async (e) => {
            e.stopPropagation();
            const newUrl = await promptDialog('Edit Hyperlink URL:', link.href);
            if (newUrl !== null && newUrl.trim() !== '') {
                const trimmedUrl = newUrl.trim();
                if (link.source === 'html' && link.element) {
                    $(link.element).attr('href', trimmedUrl);
                    showToast('Hyperlink URL updated', 'success');
                } else if (link.source === 'pdf' && link.rawObj) {
                    link.rawObj.href = trimmedUrl;
                    showToast('PDF Link updated', 'success');
                }
                renderLinksTab();
            }
        });

        // Delete button
        $item.find('.nav-link-act-btn.del').on('click', (e) => {
            e.stopPropagation();
            if (confirm(`Remove link "${link.text}"?`)) {
                if (link.source === 'html' && link.element) {
                    $(link.element).contents().unwrap();
                    showToast('Link removed', 'info');
                } else if (link.source === 'pdf' && gxDoc?.links) {
                    gxDoc.links = gxDoc.links.filter(l => l !== link.rawObj);
                    showToast('PDF Link removed', 'info');
                }
                renderLinksTab();
            }
        });

        $list.append($item);
    });

    $container.append($list);
}

export async function addNewHyperlink() {
    const activeView = getEffectiveActiveView();
    const isPdf = activeView === 'pdf';

    if (!isPdf) {
        // HTML / Docs view link creation.
        //
        // promptDialog is async, unlike window.prompt() — the page keeps
        // running while it's open, so the contenteditable selection can be
        // disturbed before the user answers. Capture the range now and
        // restore it right before execCommand needs it, the same pattern
        // pageNav.js's column/list dropdowns use to survive an intervening
        // click.
        const sel = window.getSelection();
        const selectedText = sel ? sel.toString().trim() : '';
        const capturedRange = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;

        const url = await promptDialog('Enter Hyperlink URL (e.g. https://example.com or #section):', 'https://');
        if (!url || !url.trim()) return;
        const cleanUrl = url.trim();

        if (selectedText) {
            if (capturedRange) {
                const sel2 = window.getSelection();
                sel2.removeAllRanges();
                sel2.addRange(capturedRange);
            }
            document.execCommand('createLink', false, cleanUrl);
            showToast(`Linked "${selectedText}" to ${cleanUrl}`, 'success');
        } else {
            const linkText = await promptDialog('Enter display text for the link:', 'Link');
            if (!linkText || !linkText.trim()) return;

            const cleanText = linkText.trim();
            const html = `<a href="${_escapeHtml(cleanUrl)}" target="_blank" rel="noopener">${_escapeHtml(cleanText)}</a>`;
            if (capturedRange) {
                const sel2 = window.getSelection();
                sel2.removeAllRanges();
                sel2.addRange(capturedRange);
            }
            document.execCommand('insertHTML', false, html);
            showToast(`Inserted link "${cleanText}"`, 'success');
        }

        renderLinksTab();
    } else {
        // PDF view link creation
        const gxDoc = state.pdf1.gxDoc;
        if (!gxDoc) {
            showToast('Load a PDF document to add links.', 'error');
            return;
        }

        const url = await promptDialog('Enter Hyperlink URL for current PDF page:', 'https://');
        if (!url || !url.trim()) return;

        const cleanUrl = url.trim();
        const curPage = getCurrentPage();
        gxDoc.links = gxDoc.links || [];

        const newLink = {
            id: `link_${Date.now()}`,
            page: curPage,
            text: `Link - Page ${curPage}`,
            href: cleanUrl,
            created: new Date().toISOString()
        };

        gxDoc.links.push(newLink);
        showToast(`Added PDF link for Page ${curPage}`, 'success');
        renderLinksTab();
    }
}
