// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025-2026 Canworks, LLC
// doclingCheck.js — structural cross-check of the advanced-extraction (Docling)
// result against the deterministic pre-flight analyzer.
//
// This is the invariant-checker role from pdf-extraction-v2.md: two independent
// views of the same document — Docling's semantic classification and the
// geometry analyzer's structural evidence — compared deterministically. A
// disagreement is not an error; it is a flag naming which view claimed what.
//
// v0 compares per-page object counts only. Docling bboxes are in PDF points
// (bottom-left origin) and analyzer geometry is viewport-scaled (top-left
// origin); count comparison needs no coordinate reconciliation and cannot
// produce false precision.

/**
 * @param {Array} analysisPages — pdfAnalyzer output pages:
 *   {pageNum, textItemCount, closedRectCount, imageCount, scanned}
 * @param {object} assets — backend extract_assets output:
 *   {tables: [{page_no, num_rows, num_cols}], pictures: [{page_no}]}
 * @returns {{agreementScore:number, flags:Array, pages:Array}}
 */
export function checkDoclingAgreement(analysisPages, assets) {
    const tablesByPage = new Map();
    for (const t of assets?.tables || []) {
        if (t.page_no != null) tablesByPage.set(t.page_no, (tablesByPage.get(t.page_no) || 0) + 1);
    }
    const picturesByPage = new Map();
    for (const p of assets?.pictures || []) {
        if (p.page_no != null) picturesByPage.set(p.page_no, (picturesByPage.get(p.page_no) || 0) + 1);
    }

    const flags = [];
    const pages = [];
    let claims = 0, agreements = 0;

    for (const pg of analysisPages || []) {
        const doclingTables   = tablesByPage.get(pg.pageNum) || 0;
        const doclingPictures = picturesByPage.get(pg.pageNum) || 0;
        // Closed rects are table-frame evidence; a page with several is very
        // likely to contain at least one lattice table.
        const geometrySeesTable = pg.closedRectCount >= 3;
        const entry = {
            page: pg.pageNum,
            doclingTables,
            doclingPictures,
            geometryClosedRects: pg.closedRectCount,
            geometryImages: pg.imageCount,
            scanned: !!pg.scanned,
        };
        pages.push(entry);

        if (pg.scanned) {
            // No vector substrate — geometry has no standing to dispute Docling.
            continue;
        }

        if (geometrySeesTable || doclingTables > 0) {
            claims++;
            if (geometrySeesTable && doclingTables === 0) {
                flags.push({
                    page: pg.pageNum,
                    type: 'table_missing_in_docling',
                    detail: `geometry found ${pg.closedRectCount} closed rects but Docling produced no table`,
                });
            } else if (!geometrySeesTable && doclingTables > 0 && pg.closedRectCount === 0) {
                // Docling table with zero rect evidence — plausible borderless
                // (stream) table, so flag as unconfirmed, not wrong.
                flags.push({
                    page: pg.pageNum,
                    type: 'table_unconfirmed_by_geometry',
                    detail: `Docling claims ${doclingTables} table(s) with no closed-rect evidence (borderless?)`,
                });
            } else {
                agreements++;
            }
        }

        if (pg.imageCount > 0 || doclingPictures > 0) {
            claims++;
            if (pg.imageCount > 0 && doclingPictures === 0) {
                flags.push({
                    page: pg.pageNum,
                    type: 'image_missing_in_docling',
                    detail: `geometry sees ${pg.imageCount} image region(s), Docling extracted none`,
                });
            } else {
                agreements++;
            }
        }
    }

    return {
        agreementScore: claims ? Math.round((agreements / claims) * 1000) / 1000 : 1,
        // How many claims were actually adjudicated. Without this the caller
        // cannot tell a genuine 1.0 ("everything agreed") from a vacuous one
        // ("every page was scanned, so nothing was compared") — both report
        // agreementScore 1 with no flags. A scanned document scores a perfect
        // 1.0 here while the checker examines none of Docling's output.
        claims,
        flags,
        pages,
    };
}
