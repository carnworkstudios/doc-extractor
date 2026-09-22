/**
 * platformNotice.js — tell a standalone user where the platform features live.
 *
 * Analyze and Batch are the injected intelligence layer (see
 * architecture/three-tier-architecture.md). They are deliberately absent from
 * the forkable tool: a fork gets the deterministic editor, not the judgement.
 *
 * Absent is the correct behaviour, but a blank panel is indistinguishable from
 * a broken one. This renders the difference explicitly — the feature exists, it
 * runs on the platform, here is the link — instead of leaving someone to guess
 * whether they hit a bug.
 *
 * MIT, and deliberately so: a fork keeps this file. The honest thing for a fork
 * to show is "this capability is not part of what you forked", which is exactly
 * what it says. Nothing here reveals how Analyze or Batch work.
 */

const PLATFORM_URL = 'https://ginexys.com/tools/pdf-processor';

function _card({ title, body, cta }) {
    const wrap = document.createElement('div');
    wrap.className = 'gx-platform-notice';
    wrap.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true" class="gx-platform-notice-icon">
            <path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>
        </svg>
        <div class="gx-platform-notice-title"></div>
        <p class="gx-platform-notice-body"></p>
        <a class="gx-platform-notice-cta" target="_blank" rel="noopener noreferrer"></a>
    `;
    wrap.querySelector('.gx-platform-notice-title').textContent = title;
    wrap.querySelector('.gx-platform-notice-body').textContent = body;
    const a = wrap.querySelector('.gx-platform-notice-cta');
    a.textContent = cta;
    a.href = PLATFORM_URL;
    return wrap;
}

/**
 * Render the notice into a container, unless the injected layer is present.
 * `presenceCheck` returns true when the real feature is available.
 */
function _mount(containerId, presenceCheck, copy) {
    const el = document.getElementById(containerId);
    if (!el) return;
    // The platform injected it — leave the real panel completely alone.
    if (presenceCheck()) return;
    if (el.querySelector('.gx-platform-notice')) return;
    el.appendChild(_card(copy));
}

export function initPlatformNotices() {
    // Deferred: the injected scripts arrive on the iframe's load handler, after
    // this module's import has already run. Checking immediately would draw the
    // notice over a panel that is about to work.
    setTimeout(() => {
        _mount(
            'analyze-panel-inner',
            () => !!(window.GxAnalyzePanel || document.querySelector('.gx-analyze-root')),
            {
                title: 'Analyze runs on the Ginexys platform',
                body: 'Analyze reads an extraction and reports what went wrong with it — '
                    + 'region classification, table confidence, and the tuning controls that '
                    + 'correct them. It is part of the Ginexys platform rather than the '
                    + 'standalone editor.',
                cta: 'Open this tool on ginexys.com →',
            },
        );

        _mount(
            'nav-view-batch',
            () => !!(window.GxBatch && window.GxBatch.WorkerPool),
            {
                title: 'Batch runs on the Ginexys platform',
                body: 'Batch processes many documents in one run with scheduling, progress '
                    + 'and per-document results. Single-document extraction works here '
                    + 'exactly as it does on the platform.',
                cta: 'Open this tool on ginexys.com →',
            },
        );
    }, 1200);
}
