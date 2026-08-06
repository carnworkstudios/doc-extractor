/**
 * toolReady.js
 * Wait for another tool in the OS shell to acknowledge its launch.
 *
 * Cross-tool sends (PDF → TAFNE, PDF → Schema Editor) have to open the target
 * tool first and then post data to it. Posting immediately loses the message,
 * because the target's listener is not registered until its own boot finishes.
 *
 * Lived in analyzePanel.js purely by accident of where it was first needed; it
 * has nothing to do with the analyze panel, and importing it from there was the
 * only thing keeping a stale 1,391-line copy of that panel in the bundle.
 */

/**
 * @param {string} toolId — 'tifany' | 'svg_wiring' | …
 * @param {number} timeout — ms to wait before resolving anyway. Resolving on
 *   timeout is deliberate: a missed ack should degrade to "send and hope",
 *   not hang the caller forever.
 * @returns {Promise<void>}
 */
export function waitForToolReady(toolId, timeout) {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            window.removeEventListener('message', handler);
            resolve();
        };
        const handler = (e) => {
            const t = e.data?.type;
            if ((t === 'cws:tool:launch-ack' || t === 'cws:lifecycle:registered') &&
                (e.data?.payload?.toolId === toolId || !e.data?.payload?.toolId)) {
                finish();
            }
        };
        window.addEventListener('message', handler);
        setTimeout(finish, timeout);
    });
}
