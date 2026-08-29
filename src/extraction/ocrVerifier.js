// ocrVerifier.js — deterministic verification for gx-scanned-document/1.
//
// Recognition confidence is evidence, not verification. Verification asks a
// different question: can every rendered claim be traced to source OCR evidence
// at compatible geometry, and did any source evidence disappear?

export const VERIFICATION_OUTCOMES = Object.freeze({
    VERIFIED: 'verified',
    DISPUTED: 'disputed',
    UNSUPPORTED: 'unsupported',
    MISSING: 'missing',
});

const LOW_CONFIDENCE = 70;
const MAX_DUPLICATE_CLAIMS = 1;

export function verifyScannedPage(page) {
    if (!page || !Array.isArray(page.lines) || !Array.isArray(page.blocks)) {
        return emptyReport('invalid-page-evidence');
    }

    const lines = new Map(page.lines.map(line => [line.id, line]));
    const claimCountByLine = new Map();
    const claims = page.blocks.map(block => verifyBlock(block, lines, claimCountByLine));

    // Evidence which no output block claims is a missing extraction claim. It
    // stays separate from unsupported output: one is loss, the other invention.
    for (const line of page.lines) {
        if ((claimCountByLine.get(line.id) || 0) > 0) continue;
        claims.push({
            id: `verify-missing-${line.id}`,
            subjectId: null,
            outcome: VERIFICATION_OUTCOMES.MISSING,
            score: 0,
            evidence: [{ kind: 'ocr-line', id: line.id, bbox: { ...line.bbox } }],
            checks: { sourceCovered: false, textGrounded: true, geometryGrounded: true },
            findings: [{ code: 'source-line-unclaimed', severity: 'error', lineId: line.id }],
        });
    }

    // A source line claimed by multiple peer blocks is ambiguous provenance.
    for (const claim of claims) {
        const duplicate = claim.evidence?.some(e =>
            e.kind === 'ocr-line' && (claimCountByLine.get(e.id) || 0) > MAX_DUPLICATE_CLAIMS);
        if (duplicate && claim.outcome === VERIFICATION_OUTCOMES.VERIFIED) {
            claim.outcome = VERIFICATION_OUTCOMES.DISPUTED;
            claim.score = Math.min(claim.score, 0.65);
            claim.findings.push({ code: 'source-line-claimed-multiple-times', severity: 'warning' });
        }
    }

    const counts = countOutcomes(claims);
    const score = claims.length
        ? round3(claims.reduce((sum, claim) => sum + (claim.score ?? 0), 0) / claims.length)
        : null;
    return {
        schema: 'gx-verification/1',
        verifier: 'deterministic-ocr-v1',
        status: aggregateStatus(counts, claims.length),
        score,
        confidence: score, // compatibility for consumers that still read confidence
        counts,
        claims,
        evidence: {
            page: page.page,
            coordinateSpace: page.coordinateSpace,
            tokenCount: page.tokens?.length || 0,
            lineCount: page.lines.length,
            blockCount: page.blocks.length,
        },
        optional: { semanticCoherence: null },
    };
}

function verifyBlock(block, lines, claimCountByLine) {
    const evidenceLines = (block.lineIds || []).map(id => lines.get(id)).filter(Boolean);
    for (const line of evidenceLines) claimCountByLine.set(line.id, (claimCountByLine.get(line.id) || 0) + 1);

    const evidenceText = evidenceLines.map(line => line.text).join(block.kind === 'paragraph' ? ' ' : '\n');
    const textGrounded = normalize(evidenceText) === normalize(block.text);
    const geometryGrounded = evidenceLines.every(line => contained(line.bbox, block.bbox, 2));
    const sourceCovered = evidenceLines.length > 0 || block.kind === 'image';
    const confidence = mean(evidenceLines.map(line => line.confidence).filter(Number.isFinite));
    const findings = [];

    if (!sourceCovered) findings.push({ code: 'no-source-evidence', severity: 'error' });
    if (!textGrounded) findings.push({ code: 'output-text-not-source-equivalent', severity: 'error' });
    if (!geometryGrounded) findings.push({ code: 'evidence-outside-claim-geometry', severity: 'error' });
    if (confidence != null && confidence < LOW_CONFIDENCE) {
        findings.push({ code: 'low-recognition-confidence', severity: 'warning', value: round3(confidence / 100) });
    }
    if (block.kind === 'table' && (!block.table || block.table.rows < 2 || block.table.cols < 2)) {
        findings.push({ code: 'weak-table-structure', severity: 'warning' });
    }

    let outcome = VERIFICATION_OUTCOMES.VERIFIED;
    if (!sourceCovered || !textGrounded || !geometryGrounded) outcome = VERIFICATION_OUTCOMES.UNSUPPORTED;
    else if (findings.some(f => f.severity === 'warning')) outcome = VERIFICATION_OUTCOMES.DISPUTED;

    const structural = sourceCovered && textGrounded && geometryGrounded ? 1 : 0;
    const recognition = confidence == null ? (block.kind === 'image' ? 1 : 0.5) : confidence / 100;
    const score = outcome === VERIFICATION_OUTCOMES.UNSUPPORTED
        ? round3(0.25 * recognition)
        : round3(0.75 * structural + 0.25 * recognition);

    return {
        id: `verify-${block.id}`,
        subjectId: block.id,
        outcome,
        score,
        evidence: evidenceLines.map(line => ({ kind: 'ocr-line', id: line.id, bbox: { ...line.bbox } })),
        checks: { sourceCovered, textGrounded, geometryGrounded },
        findings,
    };
}

function aggregateStatus(counts, total) {
    if (!total) return null;
    if (counts.unsupported) return VERIFICATION_OUTCOMES.UNSUPPORTED;
    if (counts.missing) return VERIFICATION_OUTCOMES.MISSING;
    if (counts.disputed) return VERIFICATION_OUTCOMES.DISPUTED;
    return VERIFICATION_OUTCOMES.VERIFIED;
}

function countOutcomes(claims) {
    const counts = { verified: 0, disputed: 0, unsupported: 0, missing: 0 };
    for (const claim of claims) if (claim.outcome in counts) counts[claim.outcome]++;
    return counts;
}

function emptyReport(reason) {
    return {
        schema: 'gx-verification/1', verifier: 'deterministic-ocr-v1', status: null,
        score: null, confidence: null,
        counts: { verified: 0, disputed: 0, unsupported: 0, missing: 0 },
        claims: [], evidence: null, optional: { semanticCoherence: null }, reason,
    };
}

function normalize(s) {
    return String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}
function contained(inner, outer, pad) {
    return inner.x0 >= outer.x0 - pad && inner.y0 >= outer.y0 - pad &&
        inner.x1 <= outer.x1 + pad && inner.y1 <= outer.y1 + pad;
}
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const round3 = n => Math.round(n * 1000) / 1000;
