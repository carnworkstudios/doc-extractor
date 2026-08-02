/**
 * state.js
 * Shared application state using jQuery paradigm where possible.
 */

export const state = {
    // `extraction` holds the facts about HOW the current content was produced
    // (engine, page count, scanned classification) — set by fileUpload, read by
    // the structured MCP reply. Null until something has been extracted.
    pdf1: { file: null, doc: null, bytes: null, extractedHTML: '', extractedText: '', extraction: null },
    pdf2: { file: null, doc: null, bytes: null, extractedHTML: '', extractedText: '', extraction: null },
    activeView: 'pdf',
    monacoEditor: null,   // monaco.editor instance (HTML editor)
    
    // Compare Diff sub-settings
    diffLayout: 'split',      // 'split' | 'unified'
    diffPrecision: 'word',    // 'word' | 'char'
    diffActiveView: 'rich-text' // 'rich-text' | 'plain-text'
};
