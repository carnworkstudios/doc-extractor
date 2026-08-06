# PDF Processor

**Browser-native PDF extraction pipeline for engineers, analysts, and technical writers.**  
Convert complex PDF layouts (tables, multi-column flows, images, redlines) into clean, editable HTML and Markdown. Zero upload. Zero ML weights. Fully deterministic geometry.  
Part of the [Ginexys](https://ginexys.com) engineering pipeline.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/ginexys.ginexys-pdf?label=VS%20Code&color=007ACC&logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=ginexys.ginexys-pdf)
[![Browser version](https://img.shields.io/badge/Live-ginexys.com-9333ea?logo=googlechrome&logoColor=white)](https://ginexys.com/tools/pdf-processor/)
[![Built with PDF.js](https://img.shields.io/badge/Built%20with-PDF.js-red.svg)](https://mozilla.github.io/pdf.js/)
[![Vanilla JS](https://img.shields.io/badge/Vanilla-JS-yellow.svg)](#architecture-a-deterministic-structural-frontend)
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen.svg)](#contributing)

## Table of Contents

- [What it does](#what-it-does)
- [Try it now](#try-it-now)
- [Architecture: a deterministic-structural frontend](#architecture-a-deterministic-structural-frontend)
- [Engine deep-dive](#engine-deep-dive)
  - [1. Path reconciler](#1-path-reconciler-turning-pdf-path-operators-into-clean-segments)
  - [2. Bipartite column detector](#2-bipartite-column-detector-finding-gutters-without-histograms)
  - [3. Struct-tree reader](#3-struct-tree-reader-using-the-pdfs-own-reading-order)
  - [4. Page assembler](#4-page-assembler-turning-classified-regions-into-html)
  - [5. HTML-as-CAD editor](#5-html-as-cad-editor-treating-the-output-as-editable-geometry)
  - [Further reading](#further-reading)
- [Three-pass extraction pipeline](#three-pass-extraction-pipeline)
- [Five views](#five-views)
- [Export formats](#export-formats)
- [Documentation](#-documentation)
- [Quick start](#quick-start)
- [Who uses this](#who-uses-this)
- [Part of the Ginexys pipeline](#part-of-the-ginexys-pipeline)
- [Self-hosting](#self-hosting)
- [Contributing](#contributing)
- [License](#license)

---

![PDF Processor demo: extract tables, compare two PDFs, edit HTML in the browser](./pdf-extractor-demo.gif)

## Try it now

**[→ Open the tool](https://ginexys.com/tools/pdf-processor/)** · **[→ Install in VS Code](https://marketplace.visualstudio.com/items?itemName=ginexys.ginexys-pdf)** · **[→ Getting Started](docs/getting-started.md)**

## What it does

You got a PDF: a quarterly report, a research paper, a contract, a datasheet. It has tables. It has multi-column layouts. It probably has redlines you need to track across versions. Most PDF tools either upload your file to a cloud service or strip layout completely and hand back a wall of text.

PDF Processor stays in the browser and reasons about geometry directly. The original PDF never leaves your machine. The extracted HTML preserves the columns, tables, and figures as they were laid out, not as a flat text dump. And you can edit the extracted output as easily as the original.

---

## Architecture: a deterministic-structural frontend

PDF Processor occupies a specific niche in the design space of PDF tooling. The four architectural commitments below are load-bearing. Change any one and the rest of the system shifts. Full reasoning in **[Finding the niche: frontend-first PDF extraction design space](https://ginexys.com/blog/posts/frontend-pdf-extraction-design-space/)**.

- **No backend dependency.** Free-tier extraction runs entirely in the browser tab or VS Code webview. Standalone extraction never hits a network.
- **No ML model weights.** No multi-gigabyte downloads, no cold-start latency. The geometry pipeline is deterministic, so the same input always produces the same output.
- **No raster intermediate.** Text positions come from the PDF's own text operators (`getTextContent`), not from rendering pixels and reading them back. Glyph fidelity is preserved.
- **Deterministic geometry.** Column detection, table reconstruction, and zone assembly use bipartite reasoning, vertical-rule detection, and struct-tree reading order. No stochastic heuristics that change between runs.

---

## Engine deep-dive

PDF Processor is composed of five separable engines, each addressing one well-defined problem. Each has a deep-dive write-up explaining the algorithm, the failure modes it avoids, and the trade-offs accepted.

### 1. Path reconciler: turning PDF path operators into clean segments

PDF path operators are instructions for a stateful drawing machine, not segments. `m x y` moves the cursor, `l x y` strokes to a new cursor, `re` opens a rectangle subpath, `h` closes it, all under the current transformation matrix. A correct reader rebuilds analytic geometry. Ours captures the CTM per-subpath in the adapter, reconciles subpath geometry analytically, and merges fragmented dashes via global partition.

- Source: `src/extraction/vector/ctmAdapter.js`, `pathReconciler.js`
- Deep dive: **[Building a correct PDF path reconciler](https://ginexys.com/blog/posts/path-reconciler-deepdive/)**
- Post-mortem: **[What the first three attempts got wrong](https://ginexys.com/blog/posts/path-reconciler-postmortem/)**

### 2. Bipartite column detector: finding gutters without histograms

Most column detectors fail because they treat spatial gaps as structural evidence. Histogram approaches "fill in the gap before you can measure it." The correct model is graph-theoretic: find an X coordinate that partitions text bands into two populations with **no crossing members**. Pair that with a three-gate confidence test (gutter width, band coverage, column balance) before promoting a candidate to a real split.

- Source: `src/extraction/vector/pdfAnalyzer.js`, `spatialGraph.js`, `streamDetector.js`
- Deep dive: **[How to detect PDF columns without lying to yourself](https://ginexys.com/blog/posts/bipartite-column-detection-deepdive/)**
- Post-mortem: **[Why zero-coverage gap detection fails for multi-column PDFs](https://ginexys.com/blog/posts/column-detection-blog/)**

### 3. Struct-tree reader: using the PDF's own reading order

When PDFs ship with a logical structure tree (`/StructTreeRoot`), it tells you exactly which text items belong to which `<Table>`, `<TR>`, `<TD>`, paragraph, or heading, and in what reading order. We pre-claim these regions before geometry runs, so the deterministic geometry pipeline only operates on unclaimed content. This is Tier 1 of the three-pass extraction pipeline.

- Source: `src/extraction/vector/structTreeReader.js`, `contextClassifier.js`
- Architecture: **[Frontend PDF extraction design space](https://ginexys.com/blog/posts/frontend-pdf-extraction-design-space/)**
- Tier model: **[Tier restructure post-mortem](https://ginexys.com/blog/posts/tier-restructure-postmortem/)**

### 4. Page assembler: turning classified regions into HTML

After geometry runs, you have a list of classified regions: text bands, columns, table frames, image bboxes. Correct HTML reconstruction requires three things most implementations skip: proportional column widths from measured gutter positions, zone boundaries derived from content top edges (not midpoints), and a per-zone content classifier that picks the right CSS layout pattern. Each has a specific failure mode if skipped.

- Source: `src/extraction/vector/pageAssembler.js`, `tableBuilder.js`, `latticeReconstructor.js`, `textRebuilder.js`
- Deep dive: **[Building a correct PDF page assembler](https://ginexys.com/blog/posts/page-assembly-deepdive/)**
- Post-mortem: **[Page-assembly failure modes we hit](https://ginexys.com/blog/posts/page-assembly-postmortem/)**

### 5. HTML-as-CAD editor: treating the output as editable geometry

Once a page is rendered as HTML, you can either treat it as a static document (what most tools do) or as CAD, where every element has a position and you can drag, group, and snap it with full control. Selection Mode pulls that off in the browser using SVG overlays and `position:absolute` handles that preserve the underlying layout.

- Source: `src/ui/selectionMode.js`, `pdfEditMode.js`
- Deep dive: **[How we turned extracted HTML into a CAD editor](https://ginexys.com/blog/posts/pdf-cad-why/)**
- Build log: **[PDF as CAD: the case for editable extraction](https://ginexys.com/blog/posts/pdf-cad-journey/)**

### Further reading

- [Coordinate spaces and sync architecture](https://ginexys.com/blog/posts/coordinate-spaces-and-sync-architecture/): how viewport-px, PDF-points, and CSS-zoom stay reconciled across PDF canvas, Doc view, and Visual Diff.
- [PDF lattice vs stream tables](https://ginexys.com/blog/posts/pdf-lattice-vs-stream-tables/): when border-detection works and when it doesn't.
- [PDF font style extraction](https://ginexys.com/blog/posts/pdf-font-style-extraction/): preserving bold, italic, and size through the pipeline.
- [PDF header/footer detection](https://ginexys.com/blog/posts/pdf-header-footer-detection/): separating page chrome from body content.
- [PDF zone layout model](https://ginexys.com/blog/posts/pdf-zone-layout-model/): how the assembler reasons about Y-bands and column splits.
- [Engineering journal: the PDF pipeline](https://ginexys.com/blog/posts/engineering-journal-pdf-pipeline/): chronological build log.

---

## Three-pass extraction pipeline

Each page runs through three tiers in order. The first tier that returns a high-confidence reading wins for that page. Unclaimed content from a higher tier passes through to the next.

| Tier                     | Signal                                                                  | Source file                                |
| ------------------------ | ----------------------------------------------------------------------- | ------------------------------------------ |
| **1. Struct tree**       | `/StructTreeRoot` with explicit `Table`/`TR`/`TD`/`P` MCID operators    | `structTreeReader.js`                      |
| **2. Vertical rules**    | Long horizontal/vertical path segments (table borders, column dividers) | `latticeReconstructor.js`, `ctmAdapter.js` |
| **3. Bipartite columns** | Text-band partition algorithm + three-gate confidence test              | `pdfAnalyzer.js`, `spatialGraph.js`        |

Tier-1 regions are **pre-claimed** before Tier 2 and Tier 3 run, so geometry only operates on the remaining content. This produces the most accurate reading on born-digital PDFs without sacrificing fallback quality on legacy scans.

---

## Five views

| View             | What it shows                                                                           |
| ---------------- | --------------------------------------------------------------------------------------- |
| **PDF**          | Native `pdf.js` canvas with pinch-zoom, page navigation, original render fidelity       |
| **Doc**          | Rendered HTML extraction with preserved layout, tables, images, columns                 |
| **Visual Diff**  | Side-by-side PDF vs extracted HTML with page-synchronized scroll                        |
| **Editor**       | Monaco code editor on the extracted HTML, with live preview to Doc view, 300ms debounce |
| **Compare Diff** | Load a second PDF and diff: split or unified view, word + character level               |

---

## Export formats

| Format                  | Use case                                              |
| ----------------------- | ----------------------------------------------------- |
| **Markdown**            | GitHub docs, MkDocs, Docusaurus, blog ingest          |
| **HTML**                | Web publishing, Confluence, knowledge bases           |
| **DOC**                 | Word import, downstream Office workflows              |
| **XML**                 | Structured data pipelines, archival, schema ingest    |
| **JSON**                | Tabular data extraction, programmatic post-processing |
| **Notion** (Pro)        | Direct push to Notion pages with table fidelity       |
| **Google Sheets** (Pro) | Table-only extraction straight to a new Sheet         |

> **Visual Diff and Compare Diff** are the differentiator. Catching every changed clause in a contract redline, or visually verifying that the extracted output matches the source, isn't a feature most PDF tools offer.

---

## 📚 Documentation

Detailed guides are available to help you get the most out of PDF Processor:

- **[Getting Started](docs/getting-started.md).** Loading documents, switching views, basic editing.
- **[Comparison Tools](docs/comparison-tools.md).** Visual Diff and Compare Diff workflows.
- **[Engine deep-dives](#engine-deep-dive).** Each of the five engines has a dedicated technical post on `ginexys.com/blog/posts/`.

---

## Quick start

### Browser version (zero install)

1. Visit **[ginexys.com/tools/pdf-processor](https://ginexys.com/tools/pdf-processor/)**.
2. Drop a PDF on the upload zone, or click to pick one.
3. Cycle through PDF, Doc, Visual Diff, Editor, and Compare Diff views in the tab bar.
4. Pick your export format, then download.

### VS Code extension

```
ext install ginexys.ginexys-pdf
```

Right-click any `.pdf` file in Explorer, then pick "Open with PDF Processor." The full extraction pipeline runs locally inside the VS Code webview.

### Local development

```bash
git clone https://github.com/carnworkstudios/doc-extractor.git
cd doc-extractor/tools/pdf-processor
npm install
npx vite
```

Vite serves on `http://localhost:5173`. Plain static-host inspection is also supported via `npx serve .`.

---

## Who uses this

**Engineers and researchers.** Extract tables and figures from technical papers, datasheets, and lab reports without losing column structure.  
**Financial analysts.** Pull tables from quarterly reports, prospectuses, and 10-Ks straight into Excel-ready CSV or JSON.  
**Legal and compliance teams.** Visual Diff and Compare Diff catch redlines and amendments across contract versions.  
**Technical writers.** Convert legacy PDF docs into Markdown or HTML for modern docs platforms.  
**Data engineers.** Programmatic JSON output as the first stage of an ingest pipeline, combined with [TAFNE](https://ginexys.com/tools/table-formatter/) for downstream reshaping.

---

## Part of the Ginexys pipeline

PDF Processor is the **Extract** step of the Ginexys engineering document pipeline:

```
Extract  (PDF/image → structured data)   PDF Processor  (this tool)
   ↓
Transform (reshape, edit, clean)         TAFNE
   ↓
Engineer  (schematic / topology editor)  Schema Editor
```

- **[TAFNE](https://github.com/carnworkstudios/TAFNE).** Table Formatter and Node Editor for downstream reshaping.
- **[Schema Editor](https://github.com/canworkstudios/schema-editor).** Domain-specific schematic/topology editor.
- Install all three: **[Ginexys Developer Tools](https://marketplace.visualstudio.com/items?itemName=ginexys.ginexys)** (VS Code extension pack).

---

## Self-hosting

The tool ships as static assets. Drop the `dist/` build behind any HTTPS origin and it works. No backend, no database, no API keys.

```bash
cd tools/pdf-processor
npm install
npm run build
# dist/ contains the deployable static bundle
```

Privacy posture is preserved end-to-end: extraction runs in the user's browser, not on your server. Pro features (Docling AI extraction, Notion/Sheets export) route through Ginexys infrastructure and require your own keys if you wire them up.

---

## Contributing

PRs welcome. Open an issue first for significant architectural changes, particularly anything touching the extraction pipeline, since changes there ripple through the whole engine. Smaller fixes (bugs, docs, UI polish) can go straight to PR.

- Repository: [github.com/carnworkstudios/doc-extractor](https://github.com/carnworkstudios/doc-extractor)
- Issues: [github.com/carnworkstudios/doc-extractor/issues](https://github.com/carnworkstudios/doc-extractor/issues)

---

## License

MIT. See [LICENSE](./LICENSE).

Copyright (c) 2026 Canworks Studios / Ginexys.
