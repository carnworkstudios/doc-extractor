/**
 * state.js
 * Shared application state using jQuery paradigm where possible.
 */

export const state = {
    // `extraction` holds the facts about HOW the current content was produced
    // (engine, page count, scanned classification) — set by fileUpload, read by
    // the structured MCP reply. Null until something has been extracted.
    // `gxDoc` is the typed gx-doc/1 IR (src/ir/gxDoc.js). `extractedHTML` stays
    // as the rendered view cache — the two coexist (import-export-gateway.md).
    pdf1: { file: null, doc: null, bytes: null, extractedHTML: '', extractedText: '', extraction: null, gxDoc: null },
    pdf2: { file: null, doc: null, bytes: null, extractedHTML: '', extractedText: '', extraction: null, gxDoc: null },
    activeView: 'pdf',
    monacoEditor: null,   // monaco.editor instance (HTML editor)
    
    // Compare Diff sub-settings
    diffLayout: 'split',      // 'split' | 'unified'
    diffPrecision: 'word',    // 'word' | 'char'
    diffActiveView: 'rich-text' // 'rich-text' | 'plain-text'
};
