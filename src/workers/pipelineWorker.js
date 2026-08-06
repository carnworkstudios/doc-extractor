// src/workers/pipelineWorker.js
import * as mupdf from 'mupdf';
import { env, AutoProcessor, AutoModelForVision2Seq, RawImage } from '@huggingface/transformers';

env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;

let processor = null;
let model = null;

async function getDocling() {
    if (!processor || !model) {
        const model_id = 'onnx-community/granite-docling-258M-ONNX';
        try {
            processor = await AutoProcessor.from_pretrained(model_id);
            model = await AutoModelForVision2Seq.from_pretrained(model_id, {
                dtype: 'fp32',
                device: 'webgpu',
            });
        } catch (e) {
            console.warn("WebGPU not available, falling back to WASM:", e.message);
            processor = await AutoProcessor.from_pretrained(model_id);
            model = await AutoModelForVision2Seq.from_pretrained(model_id, {
                dtype: 'fp32',
                device: 'wasm',
            });
        }
    }
    return { processor, model };
}

// NOTE (2026-08-06): the `process_batch_item` branch was removed. It extracted
// PDFs with MuPDF's `toStructuredText().asText()` — a second, much weaker engine
// than the deterministic geometry pipeline the single-document timeline runs, so
// batch output had no tables, no regions and no IR. Batch now drives
// geometryWorker.js through the WorkerPool, which is the same engine.
self.onmessage = async (e) => {
    if (e.data.type !== 'process') return;
    const { pdfIndex, bytes } = e.data;

    try {
        const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
        const numPages = doc.countPages();
        let fullXML = '';

        self.postMessage({ type: 'progress', pdfIndex, status: 'Loading AI Model', progress: 0, total: numPages });
        const { processor, model } = await getDocling();

        // Build the chat template prompt once (same for every page)
        const messages = [
            {
                role: 'user',
                content: [
                    { type: 'image' },
                    { type: 'text', text: 'Convert this page to docling.' },
                ],
            },
        ];
        const prompt = processor.apply_chat_template(messages, { add_generation_prompt: true });

        for (let i = 0; i < numPages; i++) {
            self.postMessage({ type: 'progress', pdfIndex, status: 'Rendering Image', progress: i + 1, total: numPages });
            const page = doc.loadPage(i);

            // Render page to PNG at ~150 DPI, then decode via RawImage for reliable channel handling
            const pixmap = page.toPixmap(mupdf.Matrix.scale(150/72, 150/72), mupdf.ColorSpace.DeviceRGB, false);
            const pngBytes = pixmap.asPNG();
            const pngBlob = new Blob([pngBytes], { type: 'image/png' });
            const rgbImage = await RawImage.fromBlob(pngBlob);

            console.log(`[Docling] Page ${i + 1} image: ${rgbImage.width}x${rgbImage.height}, ${rgbImage.channels}ch`);

            self.postMessage({ type: 'progress', pdfIndex, status: 'Running DocTags Inference', progress: i + 1, total: numPages });

            // Correct processor call: processor(text, images_array, options)
            const inputs = await processor(prompt, [rgbImage], {
                do_image_splitting: false,  // false = less memory; set true for higher accuracy
            });

            // Generate with sufficient token budget for full-page documents
            const generatedIds = await model.generate({
                ...inputs,
                max_new_tokens: 4096,
            });

            // Slice off the input prompt tokens before decoding
            const promptLength = inputs.input_ids.dims.at(-1);
            const outputIds = generatedIds.slice(null, [promptLength, null]);

            const doctags = processor.batch_decode(outputIds, {
                skip_special_tokens: true,
            })[0].trim();

            console.log(`[Docling] Page ${i + 1} raw output (${doctags.length} chars):`, doctags.slice(0, 200));

            fullXML += `\n<page number="${i + 1}">\n${doctags}\n</page>\n`;
        }

        self.postMessage({ type: 'complete', pdfIndex, docTags: fullXML });
    } catch (err) {
        self.postMessage({ type: 'error', pdfIndex, error: err.stack || err.message });
    }
};
