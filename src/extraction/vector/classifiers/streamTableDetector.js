// streamTableDetector.js
// Thin wrapper around detectStreamTables for the orchestrator.
// Calls the existing borderless-table detector on unclaimed text items.

import { detectStreamTables } from '../streamDetector.js';

export function detectStreamTableRegions(unclaimedMeta, scale, regions, segments, pageGraph) {
    const streamTables = detectStreamTables(unclaimedMeta, scale, regions, segments);
    return streamTables;
}
