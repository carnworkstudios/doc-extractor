/**
 * imageStore.js
 * Lightweight IndexedDB wrapper to cache raw extracted PDF image blobs,
 * enabling pure offline hydration without bloating browser memory.
 *
 * This is where every extracted picture's PIXELS live. The extracted HTML
 * carries only `data-img-id="<key>"`; `hydrateImages` (htmlSync.js) turns each
 * key into a `blob:` object URL at display time, and `downloadExtractedHTML`
 * turns it back into base64 at export time so a downloaded file is still
 * standalone.
 *
 * The alternative — inlining `src="data:image/png;base64,…"` — put a ~1.4 MB
 * single line into the document string for every figure. That string is the
 * Monaco model, the contenteditable surface, the DOMParser input for every
 * region lookup, and the thing "Edit Code" hands the editor. Monaco stops
 * rendering a line at 10,000 characters, so an image opened in the editor
 * appeared as a start tag that never closed. Same pixels, three copies, and an
 * unreadable document.
 *
 * Blob URLs are same-origin, so this costs no CORS relaxation: nothing is
 * fetched over the network, and the VS Code webview CSP already permits `blob:`
 * under img-src. An `indexeddb:`-style reference does not exist — the object URL
 * IS the supported way to point an <img> at stored bytes.
 *
 * ── Lifetime ────────────────────────────────────────────────────────────────
 * This is a CACHE, not a document store, and it is treated as one:
 *
 *   • every key is namespaced by document (`d…::p…::…`), so two documents open
 *     at once — a compare slot, or six PDFs in a batch — cannot overwrite each
 *     other's pictures;
 *   • a document's blobs are deleted when that document is dropped
 *     (`deleteDoc`), rather than left to rot until something clears everything;
 *   • the store keeps a byte budget. Past it, whole documents are evicted
 *     least-recently-used first, so a long session cannot grow without bound;
 *   • a quota failure is a normal event, not a crash: it evicts and retries
 *     once, and if the pixels still do not fit the page renders placeholders.
 *
 * The `meta` object store carries per-document accounting (bytes, lastUsed) so
 * eviction never has to read the blobs themselves to decide what to drop.
 */

const DB_NAME = 'pdf-processor-db';
const STORE_NAME = 'images';
const META_NAME = 'docs';
const DB_VERSION = 2;

/**
 * Total pixels the cache may hold. A 76-page manual with 103 figures measures
 * ~15 MB, so this is roughly a dozen ordinary documents — comfortably inside
 * the origin quota (typically a percentage of free disk) while still bounded.
 */
const BUDGET_BYTES = 256 * 1024 * 1024;

let dbPromise = null;

function initDB() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
                // v1 → v2 adds per-document accounting. Blobs written by v1 are
                // un-namespaced and unaccounted, so they are dropped rather than
                // left as permanently unevictable junk.
                if (!db.objectStoreNames.contains(META_NAME)) {
                    db.createObjectStore(META_NAME);
                    if (event.oldVersion >= 1) {
                        try {
                            event.target.transaction.objectStore(STORE_NAME).clear();
                        } catch (_) { /* nothing to clear */ }
                    }
                }
            };

            request.onsuccess = (event) => resolve(event.target.result);
            request.onerror = (event) => reject(event.target.error);
        });
    }
    return dbPromise;
}

function _tx(db, stores, mode) {
    const tx = db.transaction(stores, mode);
    return { tx, get: (n) => tx.objectStore(n) };
}

function _await(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
}

function _req(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/**
 * The store key for one picture, on one page, of one document.
 *
 * Both halves of the namespace are load-bearing:
 *
 *   • Region ids are PAGE-LOCAL — the classifier's fallback ids are `image_0`,
 *     `image_1`, so every page has an `image_0`. Without the page, page 3's
 *     figure overwrites page 1's.
 *   • Pages are DOCUMENT-LOCAL — every PDF has a page 1. Without the document,
 *     the second file in a compare, and every document after the first in a
 *     batch, overwrites the pictures of the one before it. The batch pool runs
 *     several extractions concurrently into this one store, so that collision
 *     is not even ordered: it is whichever worker finished last.
 *
 * Which is the same shape as the cross-tool address {tool, doc, page, regionId}.
 */
export function cropKey(docId, page, regionId) {
    return `${docPrefix(docId)}p${page}::${regionId}`;
}

export function docPrefix(docId) {
    return `d${docId == null ? '_' : docId}::`;
}

/** The document a key belongs to, or null for an un-namespaced legacy key. */
export function docOfKey(key) {
    const m = /^d(.*?)::/.exec(String(key || ''));
    return m ? m[1] : null;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Retrieves a Blob for a specific image key.
 */
export async function getImageBlob(id) {
    const db = await initDB();
    const { get } = _tx(db, STORE_NAME, 'readonly');
    return _req(get(STORE_NAME).get(id));
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Saves a dictionary of { key: Blob }.
 *
 * All keys in one call are expected to belong to one document (they come from
 * one page of one extraction); the document is charged for their bytes and
 * marked as just-used, which is what makes eviction able to pick a victim.
 *
 * A QuotaExceededError is handled rather than propagated: the cache evicts its
 * least-recently-used documents and tries once more. If it still does not fit,
 * the caller logs and the page renders placeholders — a document with missing
 * pictures beats a failed extraction.
 */
export async function saveImages(imageDict) {
    if (!imageDict || Object.keys(imageDict).length === 0) return;
    try {
        await _put(imageDict);
    } catch (err) {
        if (err?.name !== 'QuotaExceededError') throw err;
        const docId = docOfKey(Object.keys(imageDict)[0]);
        const freed = await evictLRU({ keep: docId, target: _bytesOf(imageDict) * 4 });
        console.warn(`[imageStore] quota reached — evicted ${freed.docs} document(s), `
            + `${Math.round(freed.bytes / 1024 / 1024)} MB; retrying`);
        await _put(imageDict);       // still throws if it genuinely does not fit
    }
    // Budget enforcement is deliberately AFTER the write and not awaited by the
    // caller's critical path: the page it just extracted is the one document
    // that must not be evicted, and it is now the most recently used.
    enforceBudget(docOfKey(Object.keys(imageDict)[0])).catch(() => {});
}

function _bytesOf(imageDict) {
    return Object.values(imageDict).reduce((n, b) => n + (b?.size || 0), 0);
}

async function _put(imageDict) {
    const db = await initDB();
    const docId = docOfKey(Object.keys(imageDict)[0]);
    const added = _bytesOf(imageDict);
    const { tx, get } = _tx(db, [STORE_NAME, META_NAME], 'readwrite');
    const images = get(STORE_NAME);
    for (const [key, blob] of Object.entries(imageDict)) images.put(blob, key);

    const meta = get(META_NAME);
    const prev = await _req(meta.get(docId));
    meta.put({ bytes: (prev?.bytes || 0) + added, lastUsed: Date.now() }, docId);
    return _await(tx);
}

// ── Eviction ─────────────────────────────────────────────────────────────────

/**
 * Delete every blob belonging to one document.
 *
 * Called when a document is replaced or removed — the only moment at which its
 * pictures are certainly junk. Uses a key-range over the document's prefix, so
 * it never loads a blob to decide whether to delete it.
 */
export async function deleteDoc(docId) {
    if (docId == null) return 0;
    const db = await initDB();
    const prefix = docPrefix(docId);
    const { tx, get } = _tx(db, [STORE_NAME, META_NAME], 'readwrite');
    const meta = get(META_NAME);
    const rec = await _req(meta.get(docId));
    // '￿' terminates the prefix range: every key that starts with the
    // prefix sorts before it, and nothing else does.
    get(STORE_NAME).delete(IDBKeyRange.bound(prefix, prefix + '￿'));
    meta.delete(docId);
    await _await(tx);
    return rec?.bytes || 0;
}

/**
 * Drop whole documents, least-recently-used first, until `target` bytes have
 * been freed. Whole documents, never individual pictures: half a document's
 * figures is a document that looks broken, and the user has no way to know why.
 */
export async function evictLRU({ keep = null, target = Infinity } = {}) {
    const db = await initDB();
    const { get } = _tx(db, META_NAME, 'readonly');
    const store = get(META_NAME);
    const ids = await _req(store.getAllKeys());
    const recs = await _req(store.getAll());
    const victims = pickVictims(ids.map((id, i) => ({ id, ...(recs[i] || {}) })), { keep, target });

    let freed = 0;
    for (const v of victims) freed += await deleteDoc(v.id);
    return { bytes: freed, docs: victims.length };
}

/**
 * Which documents to drop, oldest use first, to free `target` bytes.
 *
 * Separated from the database so the decision is testable on its own — the
 * arithmetic is where eviction goes wrong (evicting the document you are
 * looking at, stopping one short, or freeing the whole cache to make room for
 * one page), and none of those failures need IndexedDB to reproduce.
 *
 * `keep` is never a victim: it is the document being written or viewed right
 * now, so evicting it would free space by deleting the very pixels the caller
 * is about to reference.
 */
export function pickVictims(records, { keep = null, target = Infinity } = {}) {
    const ordered = (records || [])
        .filter(r => r && String(r.id) !== String(keep))
        .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));

    const victims = [];
    let freed = 0;
    for (const r of ordered) {
        if (freed >= target) break;
        victims.push(r);
        freed += r.bytes || 0;
    }
    return victims;
}

/** Evict LRU documents until the cache is back inside its byte budget. */
export async function enforceBudget(keep = null) {
    const db = await initDB();
    const { get } = _tx(db, META_NAME, 'readonly');
    const recs = await _req(get(META_NAME).getAll());
    const total = recs.reduce((n, r) => n + (r?.bytes || 0), 0);
    if (total <= BUDGET_BYTES) return { bytes: 0, docs: 0 };
    return evictLRU({ keep, target: total - BUDGET_BYTES });
}

/** Mark a document as in use, so eviction picks something else first. */
export async function touchDoc(docId) {
    if (docId == null) return;
    const db = await initDB();
    const { tx, get } = _tx(db, META_NAME, 'readwrite');
    const meta = get(META_NAME);
    const rec = await _req(meta.get(docId));
    if (rec) meta.put({ ...rec, lastUsed: Date.now() }, docId);
    await _await(tx);
}

/** What the cache is holding, for diagnostics and the storage readout. */
export async function storeStats() {
    const db = await initDB();
    const { get } = _tx(db, META_NAME, 'readonly');
    const ids = await _req(get(META_NAME).getAllKeys());
    const recs = await _req(get(META_NAME).getAll());
    return {
        docs: ids.length,
        bytes: recs.reduce((n, r) => n + (r?.bytes || 0), 0),
        budget: BUDGET_BYTES,
        byDoc: ids.map((id, i) => ({ id, ...(recs[i] || {}) })),
    };
}

/**
 * Clears everything.
 *
 * Kept for a hard reset, but note that it is almost never the right call: a
 * batch holds several live documents at once, and clearing the store because
 * ONE of them was replaced blanks the others. Prefer `deleteDoc`.
 */
export async function clearImages() {
    const db = await initDB();
    const { tx, get } = _tx(db, [STORE_NAME, META_NAME], 'readwrite');
    get(STORE_NAME).clear();
    get(META_NAME).clear();
    return _await(tx);
}
