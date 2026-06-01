/**
 * app.js; main entry point
 */

import $ from 'jquery';
import DOMPurify from 'dompurify';
import { initViewTabs, syncToolbarToView } from './ui/viewController.js';
import { initFileInputs } from './ui/fileUpload.js';
import { initExportSystem } from './ui/exportController.js';
import { initToolbar } from './ui/pageNav.js';
import { initContextMenu } from './ui/contextMenu.js';
import { initDividerResize } from './ui/visualDiff.js';
import { initMonacoEditor } from './editor/monacoSetup.js';
import { initAnalyzePanel } from './ui/analyzePanel.js';
import { initHTMLSync, patchPageHtml } from './ui/htmlSync.js';
import { initZoneToolbar } from './ui/zoneToolbar.js';
import { initSelectionMode } from './ui/selectionMode.js';
import { initViewCode } from './ui/viewCode.js';
import { initPDFEditMode } from './ui/pdfEditMode.js';
import { initHistoryController } from './ui/historyController.js';

// DOMPurify available globally for fileUpload / monacoSetup
window.DOMPurify = DOMPurify;

// patchPageHtml exposed globally so analyzePanel can call it from onReprocessResult
// without a circular import (analyzePanel → htmlSync → state → analyzePanel).
window._patchPageHtml = patchPageHtml;

$(() => {
    initViewTabs();
    initFileInputs();
    initToolbar();
    initContextMenu();
    initDividerResize();
    initMonacoEditor();
    initAnalyzePanel();
    initHTMLSync();
    initZoneToolbar();
    initExportSystem();
    initSelectionMode();
    initViewCode();
    initPDFEditMode();
    initHistoryController();

    // Sync toolbar to the default active tab (PDF) on first load
    syncToolbarToView('pdf');

    // From our new diffChecker controller logic
    import('./ui/diffViewController.js').then(m => m.initDiffTabsAndLayout());
});

