import * as pdfjsLib from 'pdfjs-dist';

async function renderPDF(files) {
    try {
        // Normalize input: accept single file or array
        const fileArray = Array.isArray(files) ? files : [files];

        if (fileArray.length === 0) {
            throw new Error('No files provided');
        }

        // Clear container
        const pagesContainer = document.getElementById('pages');
        pagesContainer.innerHTML = '';

        // Single PDF view
        if (fileArray.length === 1) {
            return await renderSinglePDF(fileArray[0], pagesContainer);
        }

        // Multiple PDFs: side-by-side diff view
        if (fileArray.length === 2) {
            return await renderPDFDiffView(fileArray[0], fileArray[1], pagesContainer);
        }

        // More than 2 PDFs: render sequentially
        if (fileArray.length > 2) {
            console.warn(`${fileArray.length} PDFs provided. Rendering first two in diff view.`);
            return await renderPDFDiffView(fileArray[0], fileArray[1], pagesContainer);
        }

    } catch (error) {
        console.error('PDF Rendering Error:', error);
        throw error;
    }
}

async function renderSinglePDF(file, container) {
    console.log('Rendering single PDF:', file.name);

    const arrayBuffer = await file.arrayBuffer();
    const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = pdfDoc.numPages;

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.5 });
        const textContent = await page.getTextContent();

        // Render canvas - Only render the images.
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-canvas';
        canvas.dataset.pageNumber = pageNum;
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        if (pageNum === 1) {
            canvas.classList.add('active');
        }

        // Grab everything on the pdf and place it on the canvas
        const context = canvas.getContext('2d');
        // HIJACK CANVAS TEXT METHODS
        const originalFillText = context.fillText;
        const originalStrokeText = context.strokeText;
        context.fillText = () => { }; //set text to null;
        context.strokeText = () => { };


        await page.render({ canvasContext: context, viewport }).promise;

        context.fillText = originalFillText;
        context.strokeText = originalStrokeText;

        // Create page wrapper
        const pageDiv = document.createElement('div');
        pageDiv.className = 'page';
        pageDiv.style.position = 'relative';
        pageDiv.style.width = `${viewport.width}px`;
        pageDiv.style.height = `${viewport.height}px`;

        // Add text layer
        const textLayer = createTextLayer(textContent, viewport, pageDiv);
        pageDiv.appendChild(textLayer);
        pageDiv.appendChild(canvas);

        // Add page number
        const pageNumberDiv = document.createElement('div');
        pageNumberDiv.className = 'page-number';
        pageNumberDiv.textContent = `Page ${pageNum} of ${numPages}`;
        pageDiv.appendChild(pageNumberDiv);

        container.appendChild(pageDiv);
    }

    return numPages;
}

async function renderPDFDiffView(file1, file2, container) {
    console.log('Rendering side-by-side diff view:', file1.name, 'vs', file2.name);

    // Load both PDFs
    const pdf1 = await loadPDFData(file1);
    console.log("pdf 1", pdf1);
    const pdf2 = await loadPDFData(file2);
    console.log("pdf 1", pdf2);

    const maxPages = Math.max(pdf1.numPages, pdf2.numPages);

    // Create diff container
    const diffContainer = document.createElement('div');
    diffContainer.className = 'pdf-diff-container';
    diffContainer.style.display = 'flex';
    diffContainer.style.gap = '10px';
    diffContainer.style.overflow = 'auto';

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        const pageComparisonDiv = document.createElement('div');
        pageComparisonDiv.className = 'page-comparison';
        pageComparisonDiv.style.display = 'flex';
        pageComparisonDiv.style.gap = '10px';
        pageComparisonDiv.style.marginBottom = '20px';
        pageComparisonDiv.style.width = '100%';

        // Left side (Original)
        const leftDiv = document.createElement('div');
        leftDiv.className = 'pdf-side original';
        leftDiv.style.flex = '1';
        leftDiv.style.minWidth = '0';

        if (pageNum <= pdf1.numPages) {
            const page = await pdf1.doc.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.5 });
            const textContent = await page.getTextContent();

            // Render canvas - Only render the images.
            const canvas = document.createElement('canvas');
            canvas.className = 'pdf-canvas';
            canvas.dataset.pageNumber = pageNum;
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            if (pageNum === 1) {
                canvas.classList.add('active');
            }

            // Grab everything on the pdf and place it on the canvas
            const context = canvas.getContext('2d');
            // HIJACK CANVAS TEXT METHODS
            const originalFillText = context.fillText;
            const originalStrokeText = context.strokeText;
            context.fillText = () => { }; //set text to null;
            context.strokeText = () => { };


            await page.render({ canvasContext: context, viewport }).promise;

            context.fillText = originalFillText;
            context.strokeText = originalStrokeText;
            await page.render({ canvasContext: context, viewport }).promise;

            const pageWrapper = document.createElement('div');
            pageWrapper.style.position = 'relative';
            pageWrapper.style.width = `${viewport.width}px`;
            pageWrapper.style.height = `${viewport.height}px`;

            const textLayer = createTextLayer(textContent, viewport, pageWrapper);
            pageWrapper.appendChild(textLayer);
            pageWrapper.appendChild(canvas);

            leftDiv.appendChild(pageWrapper);
        } else {
            leftDiv.innerHTML = '<p style="text-align: center; color: #999;">No page</p>';
        }

        const leftLabel = document.createElement('div');
        leftLabel.className = 'diff-label original-label';
        leftLabel.textContent = `${file1.name} - Page ${pageNum}`;
        leftLabel.style.fontSize = '12px';
        leftLabel.style.fontWeight = 'bold';
        leftLabel.style.marginBottom = '5px';
        leftDiv.insertBefore(leftLabel, leftDiv.firstChild);

        // Right side (Modified)
        const rightDiv = document.createElement('div');
        rightDiv.className = 'pdf-side modified';
        rightDiv.style.flex = '1';
        rightDiv.style.minWidth = '0';

        if (pageNum <= pdf2.numPages) {
            const page = await pdf2.doc.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.5 });
            const textContent = await page.getTextContent();

            const canvas = document.createElement('canvas');
            canvas.className = 'pdf-canvas';
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            const context = canvas.getContext('2d');
            await page.render({ canvasContext: context, viewport }).promise;

            const pageWrapper = document.createElement('div');
            pageWrapper.style.position = 'relative';
            pageWrapper.style.width = `${viewport.width}px`;
            pageWrapper.style.height = `${viewport.height}px`;

            const textLayer = createTextLayer(textContent, viewport, pageWrapper);
            pageWrapper.appendChild(textLayer);
            pageWrapper.appendChild(canvas);

            rightDiv.appendChild(pageWrapper);
        } else {
            rightDiv.innerHTML = '<p style="text-align: center; color: #999;">No page</p>';
        }

        const rightLabel = document.createElement('div');
        rightLabel.className = 'diff-label modified-label';
        rightLabel.textContent = `${file2.name} - Page ${pageNum}`;
        rightLabel.style.fontSize = '12px';
        rightLabel.style.fontWeight = 'bold';
        rightLabel.style.marginBottom = '5px';
        rightDiv.insertBefore(rightLabel, rightDiv.firstChild);

        pageComparisonDiv.appendChild(leftDiv);
        pageComparisonDiv.appendChild(rightDiv);
        diffContainer.appendChild(pageComparisonDiv);
    }

    container.appendChild(diffContainer);
    return maxPages;
}

async function loadPDFData(file) {
    console.log('Loading PDF:', file.name);
    const arrayBuffer = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    return {
        file: file,
        doc: doc,
        numPages: doc.numPages
    };
}

function createTextLayer(textContent, viewport, pageWrapper) {
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    textLayer.style.position = 'absolute';
    textLayer.style.left = '0';
    textLayer.style.top = '0';
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    textLayer.style.pointerEvents = 'auto';
    textLayer.style.overflow = 'visible';

    const positionedItems = textContent.items.map(item => {
        const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        const fontSize = Math.hypot(item.transform[0], item.transform[1]) * viewport.scale;

        return {
            str: item.str,
            x,
            y,
            fontSize,
            fontFamily: 'sans-serif',
            fontName: item.fontName
        };
    });

    positionedItems.forEach(it => {
        const span = document.createElement('span');
        span.textContent = it.str;
        span.style.position = 'absolute';
        span.style.left = `${it.x}px`;
        span.style.top = `${it.y - it.fontSize}px`;
        span.style.fontSize = `${it.fontSize}px`;
        span.style.fontFamily = it.fontFamily;
        span.style.whiteSpace = 'pre';
        textLayer.appendChild(span);
    });

    return textLayer;
}


export default { renderPDF };
