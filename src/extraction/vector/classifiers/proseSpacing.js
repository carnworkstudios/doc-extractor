// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// Measure line pitch from adjacent prose lines in one classification bucket.
// Short labels, lists and headings provide no spacing samples. Separate font
// groups keep captions and small diagram labels out of the body measurement.

export function measureProseSpacing(lines) {
    const describe = line => {
        const items = (line.items || []).filter(t => t.str?.trim());
        const chars = items.reduce((n, t) => n + t.str.trim().length, 0);
        const font = chars ? items.reduce((n, t) => n + t.vFont * t.str.trim().length, 0) / chars : 0;
        return { chars, font, x: Math.min(...items.map(t => t.vx)),
            end: Math.max(...items.map(t => t.vx + (t.vWidth || 0))), y: line.y,
            text: items.map(t => t.str.trim()).join(' ') };
    };
    const descriptions = lines.map(describe);
    const samples = new Map();
    for (let i = 1; i < descriptions.length; i++) {
        const a = descriptions[i - 1], b = descriptions[i];
        if (a.chars < 40 || b.chars < 40 || !a.font || !b.font) continue;
        if (/^(?:[•●▪–-]|\d+[.)])\s/.test(a.text) || /^(?:[•●▪–-]|\d+[.)])\s/.test(b.text)) continue;
        if (Math.abs(a.font - b.font) > b.font * 0.10) continue;
        if (Math.abs(a.x - b.x) > b.font) continue;
        const pitch = Math.abs(b.y - a.y);
        if (pitch < b.font * 0.9 || pitch > b.font * 1.8) continue;
        const key = Math.round(b.font * 2) / 2;
        if (!samples.has(key)) samples.set(key, []);
        samples.get(key).push(pitch);
    }
    const gaps = new Map();
    for (const [font, pitches] of samples) {
        if (pitches.length < 3) continue;
        pitches.sort((a, b) => a - b);
        // The lower half favors ordinary leading over paragraph boundaries.
        // Require repeated evidence near that pitch before accepting it.
        const pitch = pitches[Math.floor((pitches.length - 1) * 0.25)];
        const near = pitches.filter(p => Math.abs(p - pitch) <= pitch * 0.10);
        if (near.length < 3) continue;
        const leading = near[Math.floor(near.length / 2)];
        gaps.set(font, leading * 1.4);
    }
    return {
        gapFor(line) {
            const { font } = describe(line);
            return gaps.get(Math.round(font * 2) / 2) ?? null;
        },
    };
}
