// tesseractOcr.js — DEPRECATED shim.
//
// OCR now lives behind the facade in ./ocr/index.js, which selects an engine
// (tesseract.js or PP-OCRv5) and reports which one actually ran. This file
// re-exports it so existing imports keep working; new code should import from
// './ocr/index.js' directly.
export {
    ensureOcr,
    ensureTesseract,
    recognizePage,
    disposeOcr,
    disposeTesseract,
    getOcrReport,
    setPreferredEngine,
    listEngines,
} from './ocr/index.js';
