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
            // Every entry HTML must be listed here, otherwise Vite skips it
            // and the deploy serves the unbundled source — which fails in the
            // browser the moment a bare ES module specifier (e.g.
            // `import $ from 'jquery'`) hits the network.
            input: {
                main:       path.resolve(__dirname, 'index.html'),
                editor:     path.resolve(__dirname, 'editor/index.html'),
                visualDiff: path.resolve(__dirname, 'visual-diff/index.html'),
                compare:    path.resolve(__dirname, 'compare/index.html'),
            },
        },
    },

    worker: {
        format: 'es',
        plugins: () => [wasm()],
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
