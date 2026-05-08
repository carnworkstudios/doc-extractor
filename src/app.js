/**
 * app.js; main entry point
 */

import $ from 'jquery';
import DOMPurify from 'dompurify';
import { initViewTabs } from './ui/viewController.js';
import { initFileInputs, downloadExtractedHTML, exportExtractedPDF } from './ui/fileUpload.js';
import { initToolbar } from './ui/pageNav.js';
import { initContextMenu } from './ui/contextMenu.js';
import { initDividerResize } from './ui/visualDiff.js';
import { initMonacoEditor } from './editor/monacoSetup.js';
import { initAnalyzePanel } from './ui/analyzePanel.js';
import { initHTMLSync } from './ui/htmlSync.js';

// DOMPurify available globally for fileUpload / monacoSetup
window.DOMPurify = DOMPurify;

$(() => {
    initViewTabs();
    initFileInputs();
    initToolbar();
    initContextMenu();
    initDividerResize();
    initMonacoEditor();
    initAnalyzePanel();
    initHTMLSync();

    // From our new diffChecker controller logic
    import('./ui/diffViewController.js').then(m => m.initDiffTabsAndLayout());

    $('#btn-download-html').on('click', downloadExtractedHTML);
    $('#btn-export-pdf').on('click', exportExtractedPDF);
});
