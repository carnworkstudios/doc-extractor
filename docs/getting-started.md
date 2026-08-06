# Getting Started with PDF Processor

The PDF Processor is a high-performance, browser-native tool for converting PDF documents into structured HTML and Markdown. Using a combination of layout analysis and OCR, it allows for seamless data extraction without your files ever leaving your machine.

## Core Workflow

1.  **Load Document**: Import a PDF file for processing.
2.  **Verify Layout**: Use the **PDF View** to inspect the source document.
3.  **Review Extraction**: Switch to **HTML** or **Editor** views to see the parsed results.
4.  **Edit and Refine**: Adjust formatting, fix OCR errors, and modify the grid layout.
5.  **Export**: Download the final result as clean HTML or a regenerated PDF.

---

## 1. Loading Documents

### Primary Document

Select the **Open PDF** button in the header to load your source file. TIFANY will immediately begin the layout analysis and text extraction process.

### Multi-Page Support

For documents with multiple pages:

- Use the **Page Navigation** arrows (⟨ ⟩) in the toolbar.
- Select a specific page from the **Jump to Page** dropdown.
- The extraction engine processes each page independently, allowing you to export specific pages or the entire document.

---

## 2. Integrated Views

The top tab bar allows you to switch between different representations of the document:

| View            | Description                                                                          |
| :-------------- | :----------------------------------------------------------------------------------- |
| **PDF**         | Renders the original PDF file using `pdf.js`.                                        |
| **HTML**        | A live, editable preview of the extracted HTML structure.                            |
| **Editor**      | A technical code view using the Monaco Editor for direct HTML/Markdown manipulation. |
| **Visual Diff** | A side-by-side view for comparing the original PDF against the extracted output.     |

---

## 3. Editing and Formatting

### Rich Text UI

When in the **HTML** or **Visual Diff** views, use the formatting toolbar to refine the extracted text:

- **Text Styles**: Bold, Italics, and Underline.
- **Headings**: Convert blocks to H1, H2, H3, or standard Body text.
- **Lists**: Create Bulleted or Numbered lists.
- **Columns**: Toggle between single-column and responsive 2-column layouts.

### Manual Page Management

- **Add Page**: Use the **+ Page** button to insert blank pages into the extracted document. Useful for adding cover letters or appendices during the conversion process.

---

## 4. Exporting Results

Once your document is refined, use the **Export** buttons in the top right:

- **HTML**: Downloads the extracted data as a standalone HTML file with preserved styles.
- **PDF**: Generates a new PDF file based on the extracted and edited HTML content, effectively performing a PDF-to-HTML-to-PDF conversion with layout adjustments.
