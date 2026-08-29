import assert from 'node:assert/strict';

globalThis.document = { querySelector: () => null };
globalThis.localStorage = { getItem: () => null };
globalThis.window = {};

const { OSWorkerBroker } = await import('../../../assets/os/worker-broker.js');

// Asking for chunks must select the only transport that currently emits them,
// even when the orchestrator is also healthy.
const routed = new OSWorkerBroker();
routed.isOrchestratorOnline = true;
routed.isBackendOnline = true;
routed.isLegacyBackendOnline = true;
routed._extractViaLegacyBackend = async (_fd, _progress, onChunk) => {
    await onChunk({ page_start: 1 });
    return { status: 'success', transport: 'legacy-stream' };
};
routed._extractViaOrchestrator = async () => ({ status: 'success', transport: 'orchestrator' });
const routedEvents = [];
const routedResult = await routed.extractPdf(new FormData(), null, async c => routedEvents.push(c.page_start));
assert.equal(routedResult.transport, 'legacy-stream');
assert.deepEqual(routedEvents, [1]);

// The SSE reader must await asynchronous page rendering, preserving delivery
// order before it resolves the final document.
const broker = new OSWorkerBroker();
broker.backendUrl = 'http://fixture';
const encoder = new TextEncoder();
const sse = [
    'event: chunk\ndata: {"page_start":1}\n\n',
    'event: chunk\ndata: {"page_start":2}\n\n',
    'event: complete\ndata: {"status":"success"}\n\n',
].join('');
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(sse)); controller.close(); },
}), { headers: { 'content-type': 'text/event-stream' } });

const delivered = [];
try {
    const result = await broker._extractViaLegacyBackend(new FormData(), null, async chunk => {
        await new Promise(resolve => setTimeout(resolve, chunk.page_start === 1 ? 10 : 0));
        delivered.push(chunk.page_start);
    });
    assert.equal(result.status, 'success');
    assert.deepEqual(delivered, [1, 2]);
} finally {
    globalThis.fetch = previousFetch;
}

console.log('ok    worker broker page streaming');
