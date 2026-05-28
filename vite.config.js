import { defineConfig } from 'vite'
import path from 'path'
import { createRequire } from 'module'
import wasm from 'vite-plugin-wasm'

const require = createRequire(import.meta.url)
const monacoEditorPlugin = require('vite-plugin-monaco-editor').default

export default defineConfig({
    // Project root = pdf-processor/ so editor/index.html is served at /tools/pdf-processor/editor/
    root: path.resolve(__dirname),

    // Match the <base href="/tools/pdf-processor/"> in the HTML files so
    // relative asset references (src/styles.css, ./src/app.js) resolve correctly
    // in both dev and production builds.
    base: '/tools/pdf-processor/',

    resolve: {
        alias: {
            '@os': path.resolve(__dirname, '../../assets/os'),
        },
    },

    server: {
        port: 5173,
        open: '/tools/pdf-processor/editor/',
    },

    optimizeDeps: {
        exclude: ['mupdf'],
    },

    build: {
        // Now relative to project root (was '../dist' when root was src/)
        outDir: path.resolve(__dirname, 'dist'),
        emptyOutDir: true,
        target: 'esnext',
        rollupOptions: {
            // Only the real app entry points go here. The sub-page stubs
            // (visual-diff/, compare/, editor/) are now thin SEO shells that
            // load gx-pdf-shell.js from /assets/components/ — a path outside
            // this submodule. build.sh copies the whole dist/ to the deploy
            // folder alongside the parent's assets/, so the absolute path
            // resolves correctly at runtime without Rollup bundling it.
            input: {
                main:   path.resolve(__dirname, 'index.html'),
            },
            // Tell Rollup the shared shell component is external so it never
            // tries to resolve the /assets/components/ absolute path.
            external: [
                /^\/assets\/components\//,
            ],
            output: {
                // Keep asset names stable so the VS Code extension provider
                // can reference them by name without rebuilding after every
                // content-hash change. Only workers need stable names; app
                // chunks can keep their hashes for cache-busting on the web.
                assetFileNames: (assetInfo) => {
                    if (assetInfo.name && assetInfo.name.includes('pdf.worker')) {
                        return 'assets/pdf.worker.mjs';
                    }
                    return 'assets/[name]-[hash][extname]';
                },
            },
        },
    },

    worker: {
        format: 'es',
        plugins: () => [wasm()],
        rollupOptions: {
            output: {
                // Stable name for geometryWorker — no hash suffix.
                entryFileNames: (chunkInfo) => {
                    if (chunkInfo.name === 'geometryWorker') {
                        return 'assets/geometryWorker.js';
                    }
                    return 'assets/[name]-[hash].js';
                },
                // PDF.js display layer (bundled into geometryWorker) calls window.location
                // inside PDFWorker._initialize(). In a Web Worker there is no `window`,
                // only `self`. This banner aliases them before any bundled code runs,
                // preventing the ReferenceError that causes pdfjs to crash into fake-worker.
                banner: (chunk) => {
                    if (chunk.name === 'geometryWorker') {
                        return 'if (typeof window === "undefined") { self.window = self; }';
                    }
                    return '';
                },
            },
        },
    },

    plugins: [
        wasm(),
        monacoEditorPlugin({
            languageWorkers: ['editorWorkerService', 'html', 'css'],
        }),
        // Redirect bare /tools/pdf-processor/ to /tools/pdf-processor/editor/
        // Prevents Vite HMR ping failures when PDF.js nested worker requests the base URL
        {
            name: 'redirect-root-to-editor',
            configureServer(server) {
                server.middlewares.use((req, res, next) => {
                    if (req.url === '/tools/pdf-processor/' || req.url === '/tools/pdf-processor') {
                        res.writeHead(302, { Location: '/tools/pdf-processor/editor/' });
                        res.end();
                        return;
                    }
                    next();
                });
            },
        },
    ],
})
