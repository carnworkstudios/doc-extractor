// ================================ ASSET BASE ================================
// Where runtime-fetched payloads (ONNX weights, ORT wasm, tessdata) live.
//
// Vite bakes `import.meta.env.BASE_URL` in at build time — for this tool that is
// the absolute path `/tools/pdf-processor/`. That is correct on the website and
// WRONG in any host that serves the same bundle from a different origin or a
// non-root directory. In a VS Code webview the bundle is served from
// `vscode-webview://<uuid>/…/media/`, so `/tools/pdf-processor/models/…`
// resolves against the webview root, 404s, and every model load fails — which
// surfaces to the user as "extraction failed" with nothing in the message
// naming a path.
//
// The host therefore gets to declare the real base by setting
// `globalThis.__GX_ASSET_BASE__` BEFORE the bundle runs (the webview injects it
// in a nonce'd inline script). Workers inherit it through the same global,
// which the worker bootstrap forwards.
//
// Order matters: an explicit host override wins over the build-time value,
// because only the host knows where it actually put the files.
function _resolveBase() {
    const override = typeof globalThis !== 'undefined' && globalThis.__GX_ASSET_BASE__;
    if (typeof override === 'string' && override) {
        return override.endsWith('/') ? override : override + '/';
    }
    const built = (import.meta.env && import.meta.env.BASE_URL) || '/';
    return built.endsWith('/') ? built : built + '/';
}

export const ASSET_BASE = _resolveBase();

/** Resolve one runtime asset path (e.g. 'models/ppocr/det.onnx') against the host base. */
export function assetUrl(relPath) {
    return ASSET_BASE + String(relPath).replace(/^\/+/, '');
}

/**
 * The URL pdf.js should use for its own worker.
 *
 * Vite resolves `pdf.worker.mjs?url` to an absolute site path at build time. In
 * a VS Code webview that path is cross-origin, so the extension pre-fetches the
 * script and publishes a same-origin blob URL as `__VSC_PDF_WORKER_SRC__`.
 * Inside a blob-spawned worker the problem is worse than a 401: `import.meta.url`
 * is `blob:`, so an absolute specifier cannot be resolved at all
 * ("Failed to resolve module specifier"). Prefer the host's blob whenever it
 * exists; fall back to the build-time URL on the website.
 */
export function pdfWorkerSrc(builtUrl) {
    const override = typeof globalThis !== 'undefined' && globalThis.__VSC_PDF_WORKER_SRC__;
    return (typeof override === 'string' && override) ? override : builtUrl;
}
