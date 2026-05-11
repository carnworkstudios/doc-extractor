/**
 * imageStore.js
 * Lightweight IndexedDB wrapper to cache raw extracted PDF image blobs,
 * enabling pure offline hydration without bloating browser memory.
 */

const DB_NAME = 'pdf-processor-db';
const STORE_NAME = 'images';
const DB_VERSION = 1;

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
            };

            request.onsuccess = (event) => resolve(event.target.result);
            request.onerror = (event) => reject(event.target.error);
        });
    }
    return dbPromise;
}

/**
 * Saves a dictionary of { "img_id": Blob } to IndexedDB.
 */
export async function saveImages(imageDict) {
    if (!imageDict || Object.keys(imageDict).length === 0) return;

    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        for (const [id, blob] of Object.entries(imageDict)) {
            store.put(blob, id);
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Retrieves a Blob for a specific image ID.
 */
export async function getImageBlob(id) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(id);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Clears all cached images from the store.
 */
export async function clearImages() {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.clear();

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}
