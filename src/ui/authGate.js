/**
 * authGate.js
 * Sign-in gate for the Analyze and Batch surfaces.
 *
 * Signing in is how someone joins the project rather than just uses it: they get
 * release notes, they can send feedback, and the maintainer learns which of
 * these surfaces are actually worth building on. Everything else in the tool
 * stays free, offline and ungated — nothing here is behind a payment.
 *
 * This is a community boundary, not a security one. It lives in client code and
 * is trivially removable; treat it as an invitation, not an enforcement point.
 *
 * Auth resolution, in order:
 *   VS Code webview (CwsBridge embedded) — the extension owns auth → signed in.
 *   Dev host (localhost/127.0.0.1)       — always signed in, so the panel is
 *                                          exercisable without a backend.
 *   OS shell (framed)                    — window.parent.OsShell.getUser().
 *   Standalone (direct nav)              — window.GxAuth.hasSession().
 * Unknown → signed OUT. The gate fails CLOSED: an unresolvable auth state must
 * not silently hand over a gated surface.
 */

import { showToast } from './toast.js';

const GATED = [
    {
        key: 'analyze',
        // The Analyze top-level tab and its panel.
        tabSel: '.tab-btn[data-view="analyze"]',
        panelSel: '#view-analyze',
        feature: 'pdf-analyze-signin',
        title: 'Sign in to use Analyze',
        blurb: 'Region inspection, per-page re-extraction and layout tuning. Free with a Ginexys account.',
    },
    {
        key: 'batch',
        // The Batch nav tab and its panel inside the nav drawer.
        tabSel: '.nav-tab-btn[data-tab="batch"]',
        panelSel: '#nav-view-batch',
        feature: 'pdf-batch-signin',
        title: 'Sign in to use Batch',
        blurb: 'Queue many documents, extract them off the main thread, and export them combined. Free with a Ginexys account.',
    },
];

let _signedIn = false;
let _resolved = false;

// ── Auth resolution ──────────────────────────────────────────────────────────

function _isDevHost() {
    // Escape hatch: the dev bypass hides the gate on localhost, so there is no
    // way to see it locally. `?gate=1` (or localStorage gx-force-gate=1) forces
    // the signed-out path on for testing.
    try {
        if (new URLSearchParams(location.search).get('gate') === '1') return false;
        if (localStorage.getItem('gx-force-gate') === '1') return false;
    } catch (_) { /* storage can throw in sandboxed frames */ }
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

/** Best-effort synchronous read. Fails closed on anything unresolvable. */
export function isSignedIn() {
    
// ── Auth resolution ─────────────────────────────────
    // Analyze and Batch open to every anonymous visitor on ginexys.com, because
    // this branch runs before the OsShell.getUser() check below and so made the
    // real check unreachable for exactly the users it was meant to cover.
    //
    // 'pending' is the boot state and must read as signed OUT. initAuthGate
    // subscribes to onAuthChange, so the gate lifts by itself the moment the
    // extension resolves a real session.
    if (window.CwsBridge && typeof window.CwsBridge.getAuthState === 'function') {
        try {
            return window.CwsBridge.getAuthState()?.status === 'signed-in';
        } catch (_) { return false; }
    }
    if (_isDevHost()) return true;
    try {
        if (window.parent !== window && window.parent.OsShell?.getUser) {
            return !!window.parent.OsShell.getUser();
        }
    } catch (_) {
        // Cross-origin parent — cannot read, so we cannot claim signed in.
    }
    if (window.GxAuth && typeof window.GxAuth.hasSession === 'function') {
        return !!window.GxAuth.hasSession();
    }
    return false;
}

/**
 * Ask the shell for auth state. The shell OPENS ITS AUTH MODAL when the user is
 * anonymous, which is exactly the prompt we want, so this doubles as the
 * sign-in trigger. Resolves to the resulting signed-in state.
 */
function _requestAuthFromShell({ timeoutMs = 1500 } = {}) {
    return new Promise((resolve) => {
        if (window.parent === window) return resolve(isSignedIn());
        let done = false;
        const handler = (e) => {
            if (e.source !== window.parent) return;
            if (e.origin !== window.location.origin) return;
            if (e.data?.type !== 'gx:auth-response') return;
            done = true;
            window.removeEventListener('message', handler);
            resolve(!!e.data.signedIn);
        };
        window.addEventListener('message', handler);
        window.parent.postMessage({ type: 'gx:request-auth' }, window.location.origin);
        setTimeout(() => {
            if (done) return;
            window.removeEventListener('message', handler);
            // No reply — do NOT assume signed in. This gate fails closed.
            resolve(false);
        }, timeoutMs);
    });
}

/** Open whatever sign-in surface this host offers. */
export async function promptSignIn(feature) {
    if (window.parent !== window) {
        const ok = await _requestAuthFromShell();
        refreshGates();
        if (!ok) {
            showToast('Sign in to unlock Analyze and Batch.', 'info', 5000);
        }
        return ok;
    }
    if (window.GxAuth && typeof window.GxAuth.open === 'function') {
        window.GxAuth.open();
        return false;
    }
    // Standalone with no auth surface loaded — fall back to the waitlist modal
    // the rest of this tool already uses for gated features.
    (window.GxModals || window.parent?.GxModals)?.open?.('pro_waitlist', { featureSlug: feature });
    return false;
}

// ── Overlay ──────────────────────────────────────────────────────────────────

function _buildOverlay(spec) {
    const el = document.createElement('div');
    el.className = 'gx-signin-gate';
    el.dataset.gateKey = spec.key;
    el.innerHTML = `
        <div class="gx-signin-gate-card">
            <iconify-icon icon="material-symbols:lock-outline" class="gx-signin-gate-icon"></iconify-icon>
            <div class="gx-signin-gate-title"></div>
            <div class="gx-signin-gate-blurb"></div>
            <button type="button" class="gx-signin-gate-btn">Sign in</button>
        </div>`;
    // textContent, not innerHTML — the copy is ours today but this is the kind
    // of string that quietly becomes user/config data later.
    el.querySelector('.gx-signin-gate-title').textContent = spec.title;
    el.querySelector('.gx-signin-gate-blurb').textContent = spec.blurb;
    el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        promptSignIn(spec.feature);
    });
    return el;
}

function _applyGate(spec, signedIn) {
    const panel = document.querySelector(spec.panelSel);
    const tab = document.querySelector(spec.tabSel);

    if (tab) {
        tab.classList.toggle('gx-gated', !signedIn);
        // A lock affordance on the tab itself, so the state is legible before
        // the user clicks into a covered panel.
        tab.setAttribute('data-gx-gated', String(!signedIn));
    }

    if (!panel) return;
    const existing = panel.querySelector(':scope > .gx-signin-gate');

    if (signedIn) {
        existing?.remove();
        panel.classList.remove('gx-gated-panel');
        return;
    }
    panel.classList.add('gx-gated-panel');
    if (!existing) panel.appendChild(_buildOverlay(spec));
}

/** Re-evaluate auth and apply/remove every gate. */
export function refreshGates() {
    _signedIn = isSignedIn();
    _resolved = true;
    GATED.forEach(spec => _applyGate(spec, _signedIn));
    return _signedIn;
}

/**
 * Guard an action. Returns true if it may proceed; otherwise prompts and
 * returns false. Use at the ENTRY POINT of gated work (batch enqueue, analyze
 * run), not only in the UI — an overlay is a picture, this is the check.
 */
export function requireSignIn(feature = 'pdf-gated') {
    if (isSignedIn()) return true;
    promptSignIn(feature);
    return false;
}

export function isGateResolved() { return _resolved; }

export function initAuthGate() {
    refreshGates();

    // VS Code webview: auth arrives asynchronously from the extension host and
    // starts as 'pending', which isSignedIn() reads as signed out. Without this
    // subscription the gate would stay up for the whole session even for a
    // signed-in user, because nothing else re-evaluates it in that host.
    if (window.CwsBridge && typeof window.CwsBridge.onAuthChange === 'function') {
        try { window.CwsBridge.onAuthChange(() => refreshGates()); } catch (_) { /* non-fatal */ }
    }

    // The shell broadcasts auth transitions; re-run so a sign-in unlocks both
    // surfaces without a reload.
    window.addEventListener('message', (e) => {
        if (e.origin !== window.location.origin) return;
        const t = e.data?.type;
        if (t === 'gx:auth-response' || t === 'gx:auth-changed' || t === 'gx:user-changed') {
            refreshGates();
        }
    });

    // The panel is injected by the shell after load, and the batch panel is
    // rendered lazily, so re-apply once both have had a chance to exist.
    window.addEventListener('gx:analyze-panel-ready', refreshGates);
    setTimeout(refreshGates, 1200);
}
