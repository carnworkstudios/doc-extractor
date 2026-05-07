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
            input: {
                editor: path.resolve(__dirname, 'editor/index.html'),
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
    ],
})
