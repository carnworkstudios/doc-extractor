// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// streamTableDetector.js
// Thin wrapper around detectStreamTables for the orchestrator.
// Calls the existing borderless-table detector on unclaimed text items.

import { detectStreamTables } from '../streamDetector.js';

export function detectStreamTableRegions(unclaimedMeta, scale, regions, segments, pageGraph, columnXs = []) {
    const streamTables = detectStreamTables(unclaimedMeta, scale, regions, segments, columnXs);
    return streamTables;
}
