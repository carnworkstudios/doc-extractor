/**
 * jsonToGxDoc.js
 * Serialized gx-doc/1 (the JSON export) → gx-doc/1 IR. The round-trip import.
 *
 * The JSON export already emits a valid gx-doc/1 document, so this importer is
 * parse + validate, with honest errors when the payload is not a gx-doc.
 * Pure data — no DOM, no dependencies.
 */

import { validateDoc } from './gxDoc.js';

/**
 * @param {string} jsonText — contents of a .json file exported by the tool
 * @param {object} [meta] — { source: 'json', title }
 * @returns {object} gxDoc — a structurally valid gx-doc/1 document
 * @throws {Error} when the payload is not valid JSON or not a valid gx-doc/1
 */
export function jsonToGxDoc(jsonText, meta = {}) {
    let doc;
    try {
        doc = JSON.parse(jsonText);
    } catch (err) {
        throw new Error(`Invalid JSON: ${err.message}`);
    }

    const result = validateDoc(doc);
    if (!result.ok) {
        throw new Error(`Not a gx-doc/1 document: ${result.errors.join('; ')}`);
    }

    doc.meta = {
        source: meta.source ?? doc.meta?.source ?? null,
        title: meta.title ?? doc.meta?.title ?? null,
        pageCount: doc.meta?.pageCount ?? null,
    };
    return doc;
}
