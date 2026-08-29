// provenance.js — lineage events for the OCR pipeline.
//
// Implements architecture/ocr-native-pipeline.md §06 on the record shape from
// lineage-event-log.md §03. Each pipeline block emits ONE event; `parents[]`
// chains them into a DAG rather than a list, which is what lets a low-
// confidence span be traced back to the surface and photometry that produced
// it (lineage-event-log.md §04).
//
// Two rules from §03 are load-bearing and easy to break:
//
//   * BYTES ARE NEVER IN THE RECORD. `sha256` is an identity, `pointer` is a
//     resolver. A log carrying content would violate the IP boundary (§08) on
//     its first line.
//   * `hash` is sha256(prev.hash + canonical_json(this)), which is what makes
//     the log an audit trail instead of a log file. Canonical means sorted
//     keys — a JSON.stringify with incidental key order would produce a
//     different hash for identical content and break verification.

const STAGE = 'extraction';          // CwsContracts.PROVENANCE_STAGES.EXTRACTION
const TOOL = 'pdf_processor';

export function createLineage(sessionId) {
    let prevHash = '0'.repeat(64);
    let seq = 0;
    const events = [];

    async function emit(op, opts = {}) {
        const ev = {
            v: 1,
            id: `ev_${String(++seq).padStart(4, '0')}`,
            ts: Date.now(),
            session: sessionId,
            actor: opts.actor || 'automation',
            tool: TOOL,
            stage: STAGE,
            op,
            subject: opts.subject || null,
            score: opts.score != null ? opts.score : null,
            source: opts.source || 'pdf-extract',
            parents: opts.parents || [],
            prev: events.length ? events[events.length - 1].id : null,
        };
        ev.hash = await sha256(prevHash + canonical(ev));
        prevHash = ev.hash;
        events.push(ev);
        return ev;
    }

    return { emit, events, verify: () => verify(events) };
}

/** Recompute the chain. Returns the first index that fails, or -1 if intact. */
export async function verify(events) {
    let prev = '0'.repeat(64);
    for (let i = 0; i < events.length; i++) {
        const { hash, ...rest } = events[i];
        if (await sha256(prev + canonical(rest)) !== hash) return i;
        prev = hash;
    }
    return -1;
}

/** Stable key order — see the header. */
function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

/** Content identity for a JSON-serializable artifact; bytes stay outside events. */
export async function hashCanonical(value) {
    return sha256(canonical(value));
}

async function sha256(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256 of a canvas's pixels — the artifact identity for a surface. */
export async function hashCanvas(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // Digest the raw plane. Large but exact; a downsampled digest would make
    // two different surfaces collide and the identity would be a lie.
    const buf = await crypto.subtle.digest('SHA-256', d);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
