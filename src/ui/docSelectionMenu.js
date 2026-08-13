/**
 * docSelectionMenu.js
 * The single floating context menu (popover style) for the Doc tab: both
 * #html-preview and, when the "Show original PDF" mirror is toggled on, the
 * mirrored #pdf-canvas-container text layer docked beside it (see
 * workspaceLayout.js) — one popover for the whole tab rather than a second one
 * competing for the same selection. pdfContextMenu.js's own #pdf-context-
 * popover stays scoped to the real PDF tab (getEffectiveActiveView() ===
 * 'pdf'), so it never fires here; the Link/Highlight/Clear actions below
 * call the same PDF-annotation helpers it exports when the selection is on
 * that surface, execCommand + markHtmlDirty when it's on #html-preview.
 *
 * This is also now the right-click menu. It used to be two separate widgets
 * — this one for text-selection actions (Link/Highlight/Clear), and a
 * standalone #ctx-menu (contextMenu.js) for element-targeted actions (insert
 * image, edit region code, center a zone). Running two floating-menu DOM
 * trees with two separate show/hide state machines for what the user
 * experiences as "the doc editor's menu" was the redundant surface, so
 * #ctx-menu is retired and both action sets render out of this one popover,
 * switching which button group shows based on how it was opened:
 *   - text selection (mouseup/selectionchange) → Link / Highlight / Clear
 *   - right-click (contextmenu)                → Insert Image / Edit Code / Center
 * Element actions only make sense for the HTML document, so right-click
 * stays scoped to #html-preview — the PDF mirror only gets selection actions.
 */
import $ from "jquery";
import { state } from "../state.js";
import { pushSnapshot, syncUndoRedoUI } from "./historyController.js";
import { markHtmlDirty } from "./htmlSync.js";
import { showToast } from "./toast.js";
import { promptDialog } from "./promptDialog.js";
import { addNewHyperlink, renderLinksTab } from "./navPanel.js";
import { openViewCode } from "./viewCode.js";
import { toggleFlexCenter } from "./selectionMode.js";
import * as annEngine from "../annotation/engine.js";
import { selectionRectsByPage, applyStyleToRange } from "./pdfContextMenu.js";

const SURFACE_SEL = "#html-preview";
const PDF_SURFACE_SEL = "#pdf-canvas-container";
const REGION_SELECTOR = ".pdf-region, .pdf-zone, .pdf-table-wrap";

let $popover = null;
let currentRange = null;
let currentSurfaceKind = "html"; // 'html' | 'pdf' — which surface currentRange belongs to

// Right-click (element-action) state — mirrors what contextMenu.js used to
// track as module-level targetElement/targetZone.
let ctxTargetElement = null;
let ctxTargetZone = null;

export function initDocSelectionMenu() {
  _createPopoverDOM();
  _bindSelectionListeners();
  _bindContextMenuListener();
}

function _createPopoverDOM() {
  if ($("#doc-context-popover").length) return;

  $popover = $(`
        <div id="doc-context-popover" class="pdf-context-popover">
            <!-- SELECTION mode: a horizontal pill bar over the selected text. -->
            <div class="doc-ctx-group doc-ctx-group--selection">
                <button class="pdf-ctx-btn" id="doc-ctx-link" title="Add hyperlink to selection">
                    <iconify-icon icon="material-symbols:link"></iconify-icon>
                </button>
                <button class="pdf-ctx-btn" id="doc-ctx-highlight" title="Highlight text">
                    <iconify-icon icon="material-symbols:format-ink-highlighter"></iconify-icon>
                </button>
                <button class="pdf-ctx-btn del" id="doc-ctx-clear" title="Clear link / highlight">
                    <iconify-icon icon="material-symbols:delete-outline"></iconify-icon>
                </button>
                <span class="doc-ctx-sep-v"></span>
                <button class="pdf-ctx-btn" data-cmd="bold" title="Bold">
                    <iconify-icon icon="material-symbols:format-bold"></iconify-icon>
                </button>
                <button class="pdf-ctx-btn" data-cmd="italic" title="Italic">
                    <iconify-icon icon="material-symbols:format-italic"></iconify-icon>
                </button>
                <button class="pdf-ctx-btn" data-cmd="underline" title="Underline">
                    <iconify-icon icon="material-symbols:format-underlined"></iconify-icon>
                </button>
                <span class="doc-ctx-sep-v" data-ctx-surface="html"></span>
                <button class="pdf-ctx-btn" data-cmd="justifyLeft" data-ctx-surface="html" title="Align left">
                    <iconify-icon icon="material-symbols:format-align-left"></iconify-icon>
                </button>
                <button class="pdf-ctx-btn" data-cmd="justifyCenter" data-ctx-surface="html" title="Align center">
                    <iconify-icon icon="material-symbols:format-align-center"></iconify-icon>
                </button>
                <button class="pdf-ctx-btn" data-cmd="justifyRight" data-ctx-surface="html" title="Align right">
                    <iconify-icon icon="material-symbols:format-align-right"></iconify-icon>
                </button>
                <span class="doc-ctx-sep-v" data-ctx-surface="html"></span>
                <!-- Distinct id from the element-mode entry below: two nodes
                     sharing one id makes .toggle() on the element-mode gate
                     hide this one too. Both carry data-action so one handler
                     serves both. -->
                <button class="pdf-ctx-btn" id="doc-ctx-edit-code-sel"
                        data-action="edit-code" data-ctx-surface="html" title="Edit this element's HTML">
                    <iconify-icon icon="material-symbols:code"></iconify-icon>
                </button>
            </div>

            <!-- ELEMENT mode: the right-click menu, a vertical list — the
                 layout the standalone #ctx-menu had before it was folded in
                 here. Same actions, same order, same separators. -->
            <div class="doc-ctx-group doc-ctx-group--element">
                <button class="ctx-item" id="doc-ctx-img-url">
                    <iconify-icon icon="material-symbols:image-outline"></iconify-icon> Insert image from URL
                </button>
                <button class="ctx-item" id="doc-ctx-img-file">
                    <iconify-icon icon="material-symbols:upload-file-outline"></iconify-icon> Insert image from file
                </button>
                <div class="ctx-sep" id="doc-ctx-sep-edit"></div>
                <button class="ctx-item" id="doc-ctx-edit-code" data-action="edit-code">
                    <iconify-icon icon="material-symbols:code"></iconify-icon> Edit code
                </button>
                <div class="ctx-sep" id="doc-ctx-sep-center"></div>
                <button class="ctx-item" id="doc-ctx-center-zone">
                    <iconify-icon icon="material-symbols:align-horizontal-center"></iconify-icon>
                    <span id="doc-ctx-center-zone-label">Make centered</span>
                </button>
            </div>

            <input id="doc-ctx-file-input" type="file" accept="image/*" style="display:none;" />
        </div>
    `);

  $("body").append($popover);

  // ── selection actions ───────────────────────────────────────────────
  $popover.find("#doc-ctx-link").on("click", (e) => {
    e.stopPropagation();
    if (currentSurfaceKind === "pdf") {
      _addPdfLinkForSelection();
      return;
    }
    hidePopover();
    // addNewHyperlink() reads window.getSelection() itself and captures
    // its own range before awaiting the URL prompt (see navPanel.js) —
    // no need to pass currentRange through, just don't clear the
    // selection out from under it.
    addNewHyperlink();
  });

  $popover.find("#doc-ctx-highlight").on("click", (e) => {
    e.stopPropagation();
    _highlightSelection();
  });

  $popover.find("#doc-ctx-clear").on("click", (e) => {
    e.stopPropagation();
    _clearSelectionMarks();
  });

  // Inline formatting + alignment quick-access. These deliberately do NOT
  // reuse the toolbar's #btn-* ids — duplicate ids in one document mean
  // $('#btn-align-left') resolves to whichever comes first in the DOM, so the
  // copies would be inert and the toolbar's active-state sync would target
  // the wrong node. They run the same execCommand the toolbar buttons run.
  $popover.find("[data-cmd]").on("click", function (e) {
    e.stopPropagation();
    const cmd = $(this).data("cmd");

    // Bold/italic/underline work on the PDF text overlay too — it is a
    // contenteditable surface and execCommand applies there. Alignment does
    // not (a text layer's position comes from page geometry), which is why
    // only the align buttons carry data-ctx-surface="html".
    if (currentSurfaceKind === "pdf") {
      _applyPdfInlineCommand(cmd);
      return;
    }

    const range = currentRange;
    const surface = range ? _surfaceFromRange(range) : null;
    if (!surface) return;

    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    pushSnapshot();
    document.execCommand("styleWithCSS", false, false);
    document.execCommand(cmd, false, null);
    markHtmlDirty();
    syncUndoRedoUI();
    hidePopover();
  });

  // ── element actions ─────────────────────────────────────────────────
  $popover.find("#doc-ctx-img-url").on("click", async (e) => {
    e.stopPropagation();
    hidePopover();
    const url = await promptDialog("Image URL:");
    if (url && ctxTargetElement) {
      const $img = $("<img>").attr("src", url).css("max-width", "100%");
      $(ctxTargetElement).append($img);
      _syncElementEdit(ctxTargetElement);
    }
  });

  $popover.find("#doc-ctx-img-file").on("click", (e) => {
    e.stopPropagation();
    hidePopover();
    $popover.find("#doc-ctx-file-input").trigger("click");
  });

  $popover.find("#doc-ctx-file-input").on("change", function () {
    const file = this.files[0];
    if (!file || !ctxTargetElement) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const $img = $("<img>")
        .attr("src", ev.target.result)
        .css("max-width", "100%");
      $(ctxTargetElement).append($img);
      _syncElementEdit(ctxTargetElement);
    };
    reader.readAsDataURL(file);
    this.value = "";
  });

  // Edit Code is reachable two ways and each knows its target differently:
  // right-click has the exact node under the cursor (ctxTargetElement), a
  // selection has only a Range, so the element is resolved from where the
  // selection starts. Without that second branch the button was a no-op in
  // selection mode, because ctxTargetElement is only ever set by contextmenu.
  $popover.find("[data-action='edit-code']").on("click", (e) => {
    e.stopPropagation();
    const target =
      ctxTargetElement && $popover.hasClass("doc-ctx-mode-element")
        ? ctxTargetElement
        : _elementFromRange(currentRange);
    hidePopover();
    if (!target) {
      showToast("Select something inside the document first.", "error");
      return;
    }
    if (!openViewCode(target)) {
      showToast("No editable element here — try a paragraph, list or table.", "info");
    }
  });

  $popover.find("#doc-ctx-center-zone").on("click", (e) => {
    e.stopPropagation();
    hidePopover();
    if (ctxTargetZone) toggleFlexCenter(ctxTargetZone);
  });
}

/** Manual DOM mutations (appendChild) don't fire a native 'input' event, so
 * htmlSync.js's normal typing-driven sync never sees them — push explicitly,
 * same as pageNav.js's syncStructuralEdit() does for its own manual edits. */
function _syncElementEdit(el) {
  const surface = el?.closest?.(SURFACE_SEL);
  if (surface) markHtmlDirty();
}

// ── selection trigger ────────────────────────────────────────────────────

let _selCheckTimer = null;

function _bindSelectionListeners() {
  $(document).on("mouseup selectionchange", (e) => {
    // A right-click fires mousedown -> contextmenu -> mouseup. Element mode
    // is already open by the time that mouseup lands, and the caret is
    // usually collapsed, so without this guard the menu would show and
    // vanish within the same gesture. Element mode owns its own dismissal
    // (outside mousedown / Esc).
    if (e.type === "mouseup" && e.button !== 0) return;
    if ($popover?.hasClass("doc-ctx-mode-element")) return;

    // selectionchange fires on every caret move, including every
    // keystroke while typing (a keystroke moves the caret). Bail
    // synchronously on the common "just typing, nothing selected" case
    // before scheduling anything — no timer, no DOM query beyond
    // getSelection() itself. For an actual selection, clear any pending
    // check instead of stacking a new one on top of it.
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      hidePopover();
      return;
    }
    clearTimeout(_selCheckTimer);
    _selCheckTimer = setTimeout(_checkTextSelection, 20);
  });

  $(window).on("scroll resize", hidePopover);
}

function _checkTextSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    hidePopover();
    return;
  }

  const range = sel.getRangeAt(0);
  const text = sel.toString().trim();
  if (!text) {
    hidePopover();
    return;
  }

  const kind = _resolveSurfaceKind(range);
  if (!kind) {
    hidePopover();
    return;
  }

  currentSurfaceKind = kind;
  currentRange = range.cloneRange();

  // HTML-only actions (block alignment via execCommand) are meaningless on
  // the PDF text overlay, whose layout comes from page geometry.
  $popover.find("[data-ctx-surface='html']").toggle(kind === "html");

  const rects = range.getClientRects();
  const primaryRect = rects.length ? rects[0] : range.getBoundingClientRect();
  const top = primaryRect.top - 42 + window.scrollY;
  const left = primaryRect.left + primaryRect.width / 2 - 90 + window.scrollX;

  _showPopover({ top, left, mode: "selection" });
}

// ── right-click trigger ──────────────────────────────────────────────────

function _bindContextMenuListener() {
  $(document).on("contextmenu", SURFACE_SEL, (e) => {
    e.preventDefault();

    ctxTargetElement = e.target;
    ctxTargetZone = $(e.target).closest(".pdf-zone")[0] || null;

    // Same per-target gating contextMenu.js did: an action only appears when
    // it applies to what was actually right-clicked, separator included.
    const inRegion = !!$(e.target).closest(REGION_SELECTOR).length;
    $popover.find("#doc-ctx-edit-code, #doc-ctx-sep-edit").toggle(inRegion);

    const inZone = !!ctxTargetZone;
    const isCentered =
      ctxTargetZone &&
      ctxTargetZone.classList.contains("pdf-zone--flex-center");
    $popover
      .find("#doc-ctx-center-zone-label")
      .text(isCentered ? "Remove centered" : "Make centered");
    $popover.find("#doc-ctx-center-zone, #doc-ctx-sep-center").toggle(inZone);

    _showPopover({ top: e.clientY, left: e.clientX, mode: "element" });
  });

  // A right-click menu has to close on the next click anywhere else — that
  // was contextMenu.js's document click handler, and it is what makes this
  // behave like a context menu rather than a panel that sticks around.
  $(document).on("mousedown", (e) => {
    if (!$popover?.hasClass("doc-ctx-mode-element")) return;
    if ($(e.target).closest("#doc-context-popover").length) return;
    hidePopover();
  });

  // Esc closes it too.
  $(document).on("keydown", (e) => {
    if (e.key === "Escape") hidePopover();
  });
}

function _showPopover({ top, left, mode }) {
  $popover.toggleClass("doc-ctx-mode-selection", mode === "selection");
  $popover.toggleClass("doc-ctx-mode-element", mode === "element");

  // The popover is position:absolute, i.e. document-relative, but both
  // triggers hand over viewport coordinates — so BOTH modes need the scroll
  // offset added, not just selection. (Element mode used to add 0, which
  // only looked right because this page rarely scrolls the window itself.)
  const t = Math.max(10, top + window.scrollY);
  const l = Math.max(10, left + window.scrollX);
  $popover.css({ top: `${t}px`, left: `${l}px` }).addClass("active");

  // Keep it on screen: measure after it is displayed, then pull it back
  // inside the viewport if the trigger was near the right/bottom edge.
  const el = $popover[0];
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const maxL = window.scrollX + document.documentElement.clientWidth - w - 8;
  const maxT = window.scrollY + document.documentElement.clientHeight - h - 8;
  $popover.css({
    left: `${Math.max(8, Math.min(l, maxL))}px`,
    top: `${Math.max(8, Math.min(t, maxT))}px`,
  });
}

export function hidePopover() {
  if (!$popover) return;
  // The mode class must come off with `active`. The selection listener bails
  // while element mode is set, so leaving the class behind on a hidden
  // popover would permanently suppress the selection menu.
  $popover.removeClass("active doc-ctx-mode-selection doc-ctx-mode-element");
}

/** The element a selection sits in, for actions that target a node rather
 *  than the selected text. Starts from the range's start container so a
 *  selection spanning siblings resolves to where it began. */
function _elementFromRange(range) {
  if (!range) return null;
  let node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  return node?.closest?.(SURFACE_SEL) ? node : null;
}

/** Inline formatting on the PDF text overlay. The overlay is contenteditable
 *  but is NOT part of the HTML document, so the change belongs to the PDF
 *  annotation surface — there is no HTML document sync to push it through. */
function _applyPdfInlineCommand(cmd) {
  const range = currentRange;
  if (!range) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand("styleWithCSS", false, false);
  document.execCommand(cmd, false, null);
  hidePopover();
}

function _surfaceFromRange(range) {
  let node = range.commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  return node?.closest?.(SURFACE_SEL) || null;
}

/** Which of the two Doc-tab surfaces a range belongs to, or null if neither
 * (e.g. a selection in the browser chrome, or a stray range mid-teardown).
 * #pdf-canvas-container only counts here while the Doc tab is actually
 * active — otherwise it's the real PDF tab, whose selections stay owned by
 * pdfContextMenu.js's own popover. */
function _resolveSurfaceKind(range) {
  let node = range.commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (node?.closest?.(SURFACE_SEL)) return "html";
  if (state.activeView === "html" && node?.closest?.(PDF_SURFACE_SEL))
    return "pdf";
  return null;
}

function _highlightSelection() {
  const range = currentRange;
  if (!range) return;

  if (currentSurfaceKind === "pdf") {
    _highlightPdfSelection(range);
    return;
  }

  const surface = _surfaceFromRange(range);
  if (!surface) {
    hidePopover();
    return;
  }

  pushSnapshot();

  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  document.execCommand("styleWithCSS", false, true);
  document.execCommand("hiliteColor", false, "#ffeb3b");
  document.execCommand("styleWithCSS", false, false);

  showToast("Highlighted selection", "success");
  markHtmlDirty();
  syncUndoRedoUI();
  hidePopover();
}

function _clearSelectionMarks() {
  const range = currentRange;
  if (!range) return;

  if (currentSurfaceKind === "pdf") {
    _clearPdfSelectionMarks(range);
    return;
  }

  const surface = _surfaceFromRange(range);
  if (!surface) {
    hidePopover();
    return;
  }

  pushSnapshot();

  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  document.execCommand("styleWithCSS", false, true);
  document.execCommand("hiliteColor", false, "transparent");
  document.execCommand("styleWithCSS", false, false);
  document.execCommand("unlink", false);

  showToast("Marks cleared", "info");
  markHtmlDirty();
  syncUndoRedoUI();
  hidePopover();
  window.getSelection().removeAllRanges();
}

// ── PDF-surface actions ──────────────────────────────────────────────────
// Same three buttons, but the target is a PDF text layer (via the mirrored
// #pdf-canvas-container — see workspaceLayout.js), not the HTML document: links go
// into gxDoc.links and highlights into the annotation engine, exactly like
// pdfContextMenu.js's own popover does for the real PDF tab, since it's the
// same underlying document either way.

async function _addPdfLinkForSelection() {
  const range = currentRange;
  const text = range ? range.toString().trim() : "";
  if (!range || !text) {
    hidePopover();
    return;
  }
  hidePopover();

  const url = await promptDialog(`Add Hyperlink for "${text}":`, "https://");
  if (!url || !url.trim()) return;
  const cleanUrl = url.trim();

  const gxDoc = state.pdf1.gxDoc;
  if (!gxDoc) return;
  gxDoc.links = gxDoc.links || [];

  const parts = selectionRectsByPage(range);
  if (!parts.length) {
    showToast("Could not resolve that selection to a page position.", "error");
    return;
  }
  const isExternal =
    cleanUrl.startsWith("http://") ||
    cleanUrl.startsWith("https://") ||
    cleanUrl.startsWith("mailto:");
  const baseId = `link_${Date.now()}`;
  parts.forEach((p, i) =>
    gxDoc.links.push({
      id: parts.length > 1 ? `${baseId}_${i}` : baseId,
      page: p.page,
      text,
      href: cleanUrl,
      rect: p.rect,
      isExternal,
      created: new Date().toISOString(),
    }),
  );

  applyStyleToRange(range, "pdf-word-link");
  showToast(`Linked "${text}" to ${cleanUrl}`, "success");
  renderLinksTab();
  window.getSelection().removeAllRanges();
}

function _highlightPdfSelection(range) {
  const text = range.toString().trim();
  const parts = selectionRectsByPage(range);
  if (!parts.length) {
    showToast("Could not resolve that selection to a page position.", "error");
    hidePopover();
    return;
  }
  parts.forEach((p) =>
    annEngine.addAnnotation({
      kind: "highlight",
      page: p.page,
      rect: p.rect,
      style: { color: "#ffeb3b", opacity: 0.4 },
      text,
    }),
  );

  applyStyleToRange(range, "pdf-word-highlight");
  showToast(`Highlighted "${text}"`, "success");
  hidePopover();
  window.getSelection().removeAllRanges();
}

function _clearPdfSelectionMarks(range) {
  $(range.commonAncestorContainer)
    .find(".pdf-word-link, .pdf-word-highlight")
    .contents()
    .unwrap();
  showToast("Marks cleared", "info");
  hidePopover();
  window.getSelection().removeAllRanges();
}
