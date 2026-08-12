/**
 * promptDialog.js
 * In-page replacement for window.prompt().
 *
 * window.prompt()/alert()/confirm() are unreliable inside the VS Code webview:
 * some VS Code builds block them outright, others show them but the returned
 * value or timing doesn't behave the way the calling code expects (the
 * webview isn't a top-level browsing context, and Electron's dialog plumbing
 * doesn't extend to it the way it does a real browser tab). Every call site
 * that used prompt() to ask for a URL or label should use this instead — it
 * is a small in-DOM modal that works identically in a normal browser tab and
 * inside the webview, because it never leaves the page.
 */

let _styleInjected = false;

function injectStyles() {
    if (_styleInjected || document.getElementById('gx-pdlg-styles')) return;
    _styleInjected = true;
    const el = document.createElement('style');
    el.id = 'gx-pdlg-styles';
    el.textContent = `
.gx-pdlg-backdrop {
    position: fixed; inset: 0; z-index: 100000;
    background: rgba(15, 23, 42, 0.45);
    display: flex; align-items: center; justify-content: center;
}
.gx-pdlg-box {
    background: #fff; color: #1e293b;
    border-radius: 8px; box-shadow: 0 12px 32px rgba(0,0,0,0.28);
    padding: 16px; width: 320px; max-width: calc(100vw - 32px);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.gx-pdlg-msg { margin: 0 0 10px; font-weight: 600; }
.gx-pdlg-input {
    width: 100%; box-sizing: border-box; padding: 7px 8px;
    border: 1px solid #cbd5e1; border-radius: 5px; font-size: 13px;
    margin-bottom: 12px; outline: none;
}
.gx-pdlg-input:focus { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,0.15); }
.gx-pdlg-actions { display: flex; justify-content: flex-end; gap: 8px; }
.gx-pdlg-btn {
    padding: 6px 14px; border-radius: 5px; border: 1px solid transparent;
    font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.gx-pdlg-btn--cancel { background: #f1f5f9; color: #334155; }
.gx-pdlg-btn--ok { background: #2563eb; color: #fff; }
`;
    document.head.appendChild(el);
}

/**
 * Resolves to the entered string, or null if cancelled/escaped — matching
 * window.prompt()'s contract so call sites don't need to change their logic,
 * only the call itself.
 */
export function promptDialog(message, defaultValue = '') {
    injectStyles();

    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'gx-pdlg-backdrop';
        backdrop.innerHTML = `
            <div class="gx-pdlg-box" role="dialog" aria-modal="true">
                <p class="gx-pdlg-msg"></p>
                <input class="gx-pdlg-input" type="text" />
                <div class="gx-pdlg-actions">
                    <button type="button" class="gx-pdlg-btn gx-pdlg-btn--cancel">Cancel</button>
                    <button type="button" class="gx-pdlg-btn gx-pdlg-btn--ok">OK</button>
                </div>
            </div>`;
        backdrop.querySelector('.gx-pdlg-msg').textContent = message;
        const input = backdrop.querySelector('.gx-pdlg-input');
        input.value = defaultValue;

        document.body.appendChild(backdrop);
        input.focus();
        input.select();

        let done = false;
        function finish(value) {
            if (done) return;
            done = true;
            backdrop.remove();
            resolve(value);
        }

        backdrop.querySelector('.gx-pdlg-btn--ok').addEventListener('click', () => finish(input.value));
        backdrop.querySelector('.gx-pdlg-btn--cancel').addEventListener('click', () => finish(null));
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(null); });
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(input.value);
            if (e.key === 'Escape') finish(null);
        });
    });
}
