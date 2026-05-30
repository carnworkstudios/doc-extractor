import { defineConfig } from 'vite'
import path from 'path'
import fs from 'fs'
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
        fs: {
            // Allow Vite dev server to serve files from the repo root so
            // /assets/components/gx-pdf-shell.js resolves during local dev.
            allow: [path.resolve(__dirname, '../..')],
        },
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
        // Serve /assets/* from the repo root during dev — these files live outside
        // the pdf-processor/ Vite root so they 404 without this middleware.
        {
            name: 'serve-repo-assets',
            configureServer(server) {
                const repoRoot = path.resolve(__dirname, '../..');
                server.middlewares.use((req, res, next) => {
                    if (!req.url.startsWith('/assets/')) return next();
                    const filePath = path.join(repoRoot, req.url.split('?')[0]);
                    if (!fs.existsSync(filePath)) return next();
                    const ext = path.extname(filePath);
                    const mime = {
                        '.js':   'application/javascript',
                        '.css':  'text/css',
                        '.json': 'application/json',
                        '.png':  'image/png',
                        '.svg':  'image/svg+xml',
                        '.woff2':'font/woff2',
                        '.woff': 'font/woff',
                    }[ext] || 'application/octet-stream';
                    res.setHeader('Content-Type', mime);
                    fs.createReadStream(filePath).pipe(res);
                });
            },
        },
        // Vite's HTML transform prepends `base` ('/tools/pdf-processor/') to absolute
        // URLs in <script src> / <link href>. In dev that breaks references to repo-root
        // /assets/* files (ginexys-modals.js, modal CSS, OS bridge), which live outside
        // this Vite root. Undo the rewrite so the serve-repo-assets middleware can serve them.
        //
        // apply:'serve' restricts this plugin to dev only. In `vite build` the
        // /tools/pdf-processor/assets/main-*.css and /tools/pdf-processor/assets/main-*.js
        // paths MUST keep their prefix so the VS Code extension's PdfEditorProvider HTML
        // rewriter (which distinguishes Vite-bundled vs portfolio-root /assets/) routes
        // them to the right webview URI.
        {
            name: 'preserve-repo-asset-paths',
            apply: 'serve',
            transformIndexHtml: {
                order: 'post',
                handler(html) {
                    return html.replace(
                        /(src|href)="\/tools\/pdf-processor\/(assets\/[^"]+)"/g,
                        '$1="/$2"'
                    );
                },
            },
        },
    ],
})
