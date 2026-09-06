/** Keep the standalone tool and the Ginexys OS shell on one theme contract. */
const STORAGE_KEY = 'cws-theme';

function normalized(theme) {
    return theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme, { persist = false } = {}) {
    const next = normalized(theme);
    document.documentElement.dataset.theme = next;
    if (persist) {
        try { localStorage.setItem(STORAGE_KEY, next); } catch (_) {}
    }
    window.dispatchEvent(new CustomEvent('pdf-theme-change', { detail: { theme: next } }));
    const button = document.getElementById('theme-toggle-btn');
    button?.setAttribute('aria-pressed', String(next === 'dark'));
    button?.setAttribute('title', next === 'dark' ? 'Use light mode' : 'Use dark mode');
    return next;
}

export function initTheme() {
    let initial = document.documentElement.dataset.theme;
    if (!initial) {
        try { initial = localStorage.getItem(STORAGE_KEY); } catch (_) {}
    }
    applyTheme(initial || 'light');

    document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
        const current = document.documentElement.dataset.theme || 'light';
        applyTheme(current === 'dark' ? 'light' : 'dark', { persist: true });
    });

    // bridge.js emits this event for OS-hosted tools. Listen to the raw message
    // as well so the standalone Vite entry behaves correctly without bridge.
    window.addEventListener('cws-theme-change', event => {
        applyTheme(event.detail?.theme || event.detail?.payload?.theme);
    });
    window.addEventListener('message', event => {
        if (event.data?.type !== 'cws:theme-change' && event.data?.type !== 'cws:theme:change') return;
        applyTheme(event.data?.theme || event.data?.payload?.theme);
    });
}
