import { defineConfig } from 'vite'
import path from 'path'
import fs from 'fs'
import { createRequire } from 'module'
import wasm from 'vite-plugin-wasm'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const require = createRequire(import.meta.url)
const monacoEditorPlugin = require('vite-plugin-monaco-editor').default

// ── OCR / layout runtime assets sourced from node_modules ────────────────────
// tesseract.js and onnxruntime-web load these companion files at RUNTIME by URL
// (see src/ui/tesseractOcr.js and src/workers/layoutWorker.js), so they must be
// emitted as static files rather than bundled. They are NOT committed — public/
// is gitignored in this submodule, so a fresh CI clone has none of them, which
// previously shipped a prod build whose /tesseract/worker.min.js 404'd to the
// HTML error page ("non-JavaScript MIME type of text/html") and disabled OCR.
// Copying from node_modules keeps them reproducible from package-lock.json.
// The two model blobs with no npm source (yolov8n-doclaynet.onnx,
// eng.traineddata) stay committed under public/.
// onnxruntime-web locates its wasm with `new URL("ort-wasm-simd-threaded.wasm",
// import.meta.url)`. Vite resolves that to an emitted, content-hashed asset — a
// second 11.9 MB copy of a file we already ship at a pinned path. layoutWorker
// overwrites ort.env.wasm.wasmPaths inside initModel(), which runs AFTER that
// injected assignment, so the emitted copy is never fetched. Rewrite the URL
// construction to a bare string in ORT's module only; nothing reads the value.
// (rollupOptions.external does not apply here — `new URL(...)` is Vite asset
// handling, not a module import.)
const stripOrtWasmAssetEmit = () => ({
    name: 'strip-ort-wasm-asset-emit',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
        if (!id.includes('onnxruntime-web')) return null
        if (!code.includes('ort-wasm-simd-threaded.wasm')) return null
        // Keep it a URL object so downstream `.href` access stays valid — only
        // the base is swapped to import.meta.url's directory, which Vite does
        // not treat as an asset reference and therefore does not emit a copy.
        const out = code.replaceAll(
            'new URL("ort-wasm-simd-threaded.wasm",import.meta.url)',
            'new URL("./"+"ort-wasm-simd-threaded.wasm",import.meta.url)',
        )
        return out === code ? null : { code: out, map: null }
    },
})

// viteStaticCopy resolves a relative `src` against the PROCESS working
// directory, not against this config file. Building from anywhere other than
// tools/pdf-processor/ therefore looked for node_modules/ beside the caller and
// failed with "No file was found to copy". Anchor every source to __dirname so
// the build is cwd-independent; `vite build --config tools/pdf-processor/...`
// from the repo root now resolves identically to `npm run build` inside the
// submodule. Forward slashes because fast-glob (which viteStaticCopy uses for
// the `.*` patterns) treats a backslash as an escape character, not a
// separator — path.join would break these on Windows.
const fromHere = (p) => path.resolve(__dirname, p).split(path.sep).join('/')

const RUNTIME_ASSET_COPIES = [
    { src: fromHere('node_modules/tesseract.js/dist/worker.min.js'), dest: 'tesseract' },
    { src: fromHere('node_modules/tesseract.js-core/tesseract-core-lstm.*'), dest: 'tesseract' },
    { src: fromHere('node_modules/tesseract.js-core/tesseract-core-simd-lstm.*'), dest: 'tesseract' },
    { src: fromHere('node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.*'), dest: 'tesseract' },
    // Pinned by filename: layoutWorker sets ort.env.wasm.wasmPaths to these two
    // exact files to avoid ORT's default JSEP/WebGPU build (~25MB, over
    // Cloudflare Pages' per-file limit).
    { src: fromHere('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs'), dest: 'ort-wasm' },
    { src: fromHere('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'), dest: 'ort-wasm' },
]

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
            '@batch': path.resolve(__dirname, '../../assets/pdf-processor/batch'),
        },
    },

    server: {
        port: 5173,
        open: '/tools/pdf-processor/editor/',
        fs: {
            // Allow Vite dev server to serve files from the repo root so
            // /assets/components/gx-tool-shell.js resolves during local dev.
            allow: [path.resolve(__dirname, '../..')],
        },
    },

    build: {
        // Now relative to project root (was '../dist' when root was src/)
        outDir: path.resolve(__dirname, 'dist'),
        emptyOutDir: true,
        target: 'esnext',
        rollupOptions: {
            // Only the real app entry points go here. The sub-page stubs
            // (visual-diff/, compare/, editor/) are now thin SEO shells that
            // load gx-tool-shell.js from /assets/components/ — a path outside
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
        plugins: () => [stripOrtWasmAssetEmit(), wasm()],
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
        // Emit the runtime OCR/layout assets into dist/ (and serve them in dev).
        viteStaticCopy({ targets: RUNTIME_ASSET_COPIES }),
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
        // onnxruntime-web (layoutWorker) and tesseract.js dynamically `import()`/fetch
        // their .mjs/.wasm/.onnx/.traineddata companions from public/ort-wasm,
        // public/tesseract, public/models, public/tessdata at runtime. Vite's dev
        // server refuses to serve public/ files through its module-transform
        // pipeline ("should not be imported from source code") — that check only
        // applies to requests Vite treats as ESM imports, not plain static fetches.
        // Intercept these paths before Vite's resolver sees them so they're always
        // served as raw bytes, matching what actually happens in the built dist/.
        {
            name: 'serve-runtime-model-assets',
            configureServer(server) {
                const publicDir = path.resolve(__dirname, 'public');
                // Resolve a request to a real file. models/ and tessdata/ live in
                // public/; tesseract/ and ort-wasm/ are build-time copies out of
                // node_modules (RUNTIME_ASSET_COPIES) that do not exist on disk
                // under public/ during dev, so fall back to their npm source.
                const npmFallback = {
                    '/tesseract/worker.min.js': 'node_modules/tesseract.js/dist/worker.min.js',
                };
                const npmDirFallback = [
                    ['/tesseract/', 'node_modules/tesseract.js-core'],
                    ['/ort-wasm/', 'node_modules/onnxruntime-web/dist'],
                ];
                const resolveAsset = (urlPath) => {
                    const inPublic = path.join(publicDir, urlPath);
                    if (fs.existsSync(inPublic)) return inPublic;
                    if (npmFallback[urlPath]) {
                        const p = path.resolve(__dirname, npmFallback[urlPath]);
                        if (fs.existsSync(p)) return p;
                    }
                    for (const [prefix, dir] of npmDirFallback) {
                        if (!urlPath.startsWith(prefix)) continue;
                        const p = path.resolve(__dirname, dir, urlPath.slice(prefix.length));
                        if (fs.existsSync(p)) return p;
                    }
                    return null;
                };
                const rawPrefixes = ['/ort-wasm/', '/tesseract/', '/models/', '/tessdata/'];
                server.middlewares.use((req, res, next) => {
                    if (!rawPrefixes.some(p => req.url.startsWith(p))) return next();
                    const filePath = resolveAsset(req.url.split('?')[0]);
                    if (!filePath) return next();
                    const ext = path.extname(filePath);
                    const mime = {
                        '.mjs':  'application/javascript',
                        '.js':   'application/javascript',
                        '.wasm': 'application/wasm',
                        '.onnx': 'application/octet-stream',
                        '.traineddata': 'application/octet-stream',
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
