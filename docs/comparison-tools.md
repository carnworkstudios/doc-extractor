# Comparison and Verification Tools

PDF Processor provides specialized tools for verifying extraction accuracy and comparing different versions of documents.

---

## 1. Visual Diff View

The **Visual Diff** tab is essential for verifying that the extraction engine has captured the document layout accurately.

*   **Side-by-Side Layout**: The screen is split into two panes (Left: Original File, Right: DOC).
*   **Synchronized Scrolling**: Move through the PDF and the HTML simultaneously to compare structures page-by-page.
*   **Contextual Editing**: You can click into the HTML pane to fix typos or adjust formatting while looking directly at the source PDF.
*   **Resizer Handle**: Drag the central divider to adjust the width of each pane for easier viewing on smaller screens.

---

## 2. Compare Diff View

The **Compare Diff** tab is activated when you load a second PDF file. It is designed for document versioning and change tracking.

### Comparing Two PDFs
1.  Load your primary document using **Open PDF**.
2.  Load the second version using **Compare PDF** (✚).
3.  The **Compare Diff** tab will become active.

### View Options
*   **Rich Text vs. Plain Text**: Toggle between comparing visual formatting or raw text content.
*   **Split View**: Shows the "Before" document on the left and "After" on the right with highlighted changes.
*   **Unified View**: Merges both documents into a single stream, using standard diff colors (Red for removals, Green for additions).

### Diff Precision
*   **Word Level**: Best for general document updates and proofreading.
*   **Character Level**: Best for technical documents or data grids where small symbol changes are critical.

---

## 3. Extraction Verification Workflow

To ensure 100% accuracy in your extracted documents:

1.  Perform the extraction.
2.  Switch to **Visual Diff** to check for missing paragraphs or misaligned tables.
3.  Use the **HTML** view for final proofreading.
4.  If comparing versions, use **Compare Diff** to ensure that changes in the PDF source are reflected correctly in your structured output.

> [!TIP]
> Use the **Status Bar** at the bottom of the screen to monitor extraction progress. If the progress hangs, check the original PDF for excessive image-based text which may require more time for OCR processing.
