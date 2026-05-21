/**
 * app.js; main entry point
 */

import $ from 'jquery';
import DOMPurify from 'dompurify';
import { initViewTabs } from './ui/viewController.js';
import { initFileInputs } from './ui/fileUpload.js';
import { initExportSystem } from './ui/exportController.js';
import { initToolbar } from './ui/pageNav.js';
import { initContextMenu } from './ui/contextMenu.js';
import { initDividerResize } from './ui/visualDiff.js';
import { initMonacoEditor } from './editor/monacoSetup.js';
import { initAnalyzePanel } from './ui/analyzePanel.js';
import { initHTMLSync } from './ui/htmlSync.js';
import { initZoneToolbar } from './ui/zoneToolbar.js';
import { initSelectionMode } from './ui/selectionMode.js';
import { initViewCode } from './ui/viewCode.js';

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
    initZoneToolbar();
    initExportSystem();
    initSelectionMode();
    initViewCode();

    // From our new diffChecker controller logic
    import('./ui/diffViewController.js').then(m => m.initDiffTabsAndLayout());
});
