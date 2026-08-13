/**
 * contentHistory.js
 * Ported from table-formatter/src/js/components/tableHistory.js.
 * Adapted: ES module, no jQuery UI coupling, no window globals.
 *
 * Covers structural DOM mutations that bypass contentEditable's native
 * undo stack (zone reorder/split/group, insert-box, add-page).
 * Typing / bold / italic / alignment use the browser's own Ctrl+Z.
 */
export class ContentHistory {
    /**
     * @param {number} maxHistory  most snapshots to retain
     * @param {number} maxBytes    most total characters to retain across the
     *   whole stack. A depth-only cap is a memory bug on large documents: a
     *   1236-page extraction serializes to 16 MB, so 50 levels is ~800 MB of
     *   retained strings. Depth is the wrong unit when snapshot size varies
     *   by three orders of magnitude between documents.
     */
    constructor(maxHistory = 50, maxBytes = 64 * 1024 * 1024) {
        this._stack        = [];
        this._index        = -1;
        this._maxHistory   = maxHistory;
        this._maxBytes     = maxBytes;
        this._bytes        = 0;
        this._isRestoring  = false;
    }

    /** Save an innerHTML snapshot. No-op if restoring or unchanged. */
    push(snapshot) {
        if (this._isRestoring) return;
        if (!snapshot || snapshot.trim() === '') return;
        if (this._index >= 0 && this._stack[this._index] === snapshot) return;

        // Discard redo tail
        for (let i = this._index + 1; i < this._stack.length; i++) {
            this._bytes -= this._stack[i].length;
        }
        this._stack = this._stack.slice(0, this._index + 1);
        this._stack.push(snapshot);
        this._bytes += snapshot.length;
        this._index++;

        // Evict oldest until BOTH caps hold. Always keep at least two entries
        // so one undo step survives even when a single snapshot is over budget.
        while (this._stack.length > 2 &&
               (this._stack.length > this._maxHistory || this._bytes > this._maxBytes)) {
            this._bytes -= this._stack[0].length;
            this._stack.shift();
            this._index--;
        }
    }

    /** Return the previous snapshot or null if at the beginning. */
    undo() {
        if (!this.canUndo()) return null;
        this._index--;
        return this._stack[this._index];
    }

    /** Return the next snapshot or null if at the end. */
    redo() {
        if (!this.canRedo()) return null;
        this._index++;
        return this._stack[this._index];
    }

    canUndo()  { return this._index > 0; }
    canRedo()  { return this._index < this._stack.length - 1; }

    /** Reset on new PDF load. */
    clear() {
        this._stack  = [];
        this._index  = -1;
        this._bytes  = 0;
    }

    get isRestoring() { return this._isRestoring; }
    set isRestoring(v) { this._isRestoring = v; }
}
