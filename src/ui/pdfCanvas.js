/**
 * pdfCanvas.js
 * Renders a pdf document to canvas elements in a given container using pdfjs-dist.
 */

import $ from 'jquery';
import * as pdfjsLib from 'pdfjs-dist';
import { refreshTextEditMode } from './pdfTextEdit.js';
// Global worker source is already configured in pdfAnalyzer.js or geometryWorker.js,
// but just in case, it should be available.

const SCALE = 1.5;
export { SCALE };

// Zoom is applied as a CSS transform on rendered .page-wrapper elements;
// the canvas keeps its rendered resolution, transform handles visual scaling.
let _zoom = 1.0;

export function getPDFZoom() { return _zoom; }

export function setPDFZoom(z) {
    _zoom = z;
    document.documentElement.style.setProperty('--pdf-zoom', String(z));
}

/**
 * Fit zoom so the rendered page width matches the current container's
 * usable width. Uses the largest visible PDF container present in the DOM.
 */
export function fitPDFWidth() {
    const container = document.querySelector(
        '#view-pdf.active #pdf-canvas-container, ' +
        '#view-visual-diff.active #visual-diff-pdf, ' +
        '#pdf-canvas-container'
    );
    const firstPage = container?.querySelector('.page-wrapper');
    if (!container || !firstPage) return;
    const styles = getComputedStyle(container);
    const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const usable = container.clientWidth - padX - 8;
    const intrinsic = parseFloat(firstPage.style.width) || firstPage.offsetWidth / _zoom;
    if (intrinsic > 0) setPDFZoom(Math.max(0.5, Math.min(3.0, usable / intrinsic)));
}

export async function renderPDFToCanvas(bytes, containerId = 'pdf-canvas-container') {
    const $container = $(`#${containerId}`);
    if (!$container.length) return { wrappers: [], numPages: 0 };
    $container.empty();

    const wrappers = [];
    let numPages = 0;
    
    try {
        const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
        numPages = pdfDoc.numPages;

        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            const page = await pdfDoc.getPage(pageNum);
            const viewport = page.getViewport({ scale: SCALE });
            
            const $wrapper = $('<div>', {
                class: 'page-wrapper',
                css: { width: viewport.width, height: viewport.height, position: 'relative', overflow: 'hidden', marginBottom: '20px' },
                'data-page': pageNum,
                'data-page-w': viewport.width / SCALE,
                'data-page-h': viewport.height / SCALE,
                contentEditable: 'true'
            });

            const $canvas = $('<canvas>', {
                css: { display: 'block', width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 1 },
                contentEditable: 'false'
            });
            $canvas[0].width = viewport.width;
            $canvas[0].height = viewport.height;
            $wrapper.append($canvas);

            const $textLayer = $('<div>', {
                class: 'editable-text-layer',
                contenteditable: 'true',
                spellcheck: 'false',
                css: {
                    position: 'absolute', top: 0, left: 0,
                    width: '100%', height: '100%', zIndex: 2,
                    outline: 'none'
                }
            });
            $wrapper.append($textLayer);

            $container.append($wrapper);
            wrappers.push($wrapper[0]);

            // Render PDF to canvas
            const ctx = $canvas[0].getContext('2d');
            
            // Render text layer
            const textContent = await page.getTextContent();
            buildTextLayer(textContent, viewport, $textLayer);
            
            await page.render({ canvasContext: ctx, viewport }).promise;
        }
    } catch(err) {
        console.error("pdfjs render error:", err);
    }

    // The container was emptied above, so the edit-text class has to be
    // re-applied to the fresh wrappers.
    refreshTextEditMode();

    return { wrappers, numPages };
}

function buildTextLayer(textContent, viewport, $layerEl) {
    try {
        const positionedItems = textContent.items.map(item => {
            const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
            const fontSize = Math.hypot(item.transform[0], item.transform[1]) * viewport.scale;

            return {
                str: item.str,
                x,
                y,
                fontSize,
                // item.width/height are in PDF points at scale 1.
                width: (item.width || 0) * viewport.scale,
                fontFamily: item.fontName || 'sans-serif'
            };
        });

        positionedItems.forEach(it => {
            if (!it.str.trim()) return; // Skip empty whitespace

            const $span = $('<span>').text(it.str).addClass('pdf-text-span').css({
                left: it.x,
                top: it.y - it.fontSize,
                fontSize: it.fontSize + 'px',
                fontFamily: it.fontFamily,
                position: 'absolute',
                color: 'transparent',
                whiteSpace: 'pre',
                cursor: 'text'
            });

            // Provenance for the pdf-lib export route: the ORIGINAL string plus
            // the span's box in DISPLAY SPACE (PDF points, top-left origin,
            // y down) — the same space annotations use, so exportPdf can run
            // both through viewportToUserSpace without a second convention.
            const el = $span[0];
            el.dataset.orig = it.str;
            el.dataset.x = String(it.x / viewport.scale);
            el.dataset.y = String((it.y - it.fontSize) / viewport.scale);
            el.dataset.w = String(it.width / viewport.scale);
            el.dataset.fs = String(it.fontSize / viewport.scale);

            // Note: The text layer must be transparent to allow selection
            // while showing the actual PDF rendering beneath it. In text-edit
            // mode the canvas is hidden and CSS makes these spans opaque.
            $layerEl.append($span);
        });
    } catch (e) {
        console.warn("Failed to build pdfjs text layer", e);
    }
}
