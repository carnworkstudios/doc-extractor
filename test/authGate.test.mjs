/**
 * authGate host matrix.
 *
 * `isSignedIn()` has to give the right answer in four different hosts that each
 * expose auth a different way. It shipped giving the wrong answer in one of them
 * for every anonymous visitor, and nothing caught it: the code was deployed, the
 * CSS was deployed, the overlay was built correctly, and the gate was open
 * anyway. Only exercising the actual host contexts finds that class of bug.
 *
 * The specific failure this locks down: the first branch used to be
 *
 *     if (window.CwsBridge && window.CwsBridge.isEmbedded) return true;
 *
 * meaning to detect the VS Code webview. But `isEmbedded` is defined in
 * assets/os/bridge.js as `window.parent !== window` — "I am in an iframe" — which
 * is true for every tool the OS shell loads. So the shell's anonymous visitors
 * resolved as signed in, and the real OsShell.getUser() check below it became
 * unreachable.
 *
 * Run: npm test        (no dependencies, no framework, no build step)
 *
 * NOTE: this parses the module as text rather than importing it, because
 * authGate.js imports ./toast.js and touches `document` at module scope. Keep
 * the slice markers below in sync if the file's top-level layout changes; the
 * test fails loudly rather than silently passing if they stop matching.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src', 'ui', 'authGate.js');

const src = fs.readFileSync(SRC, 'utf8');
const START = 'function _isDevHost';
const END = '/**\n * Ask the shell';
const a = src.indexOf(START);
const b = src.indexOf(END);
if (a === -1 || b === -1 || b <= a) {
  console.error(
    `FATAL: could not slice isSignedIn() out of ${SRC}.\n` +
    `  looked for start ${JSON.stringify(START)} -> ${a}\n` +
    `  looked for end   ${JSON.stringify(END)} -> ${b}\n` +
    `The file was refactored. Update the markers in this test — do NOT delete the test.`
  );
  process.exit(2);
}

const body = src.slice(a, b).replace(/^export /gm, '');
const makeIsSignedIn = new Function('window', 'location', 'localStorage', `${body}\nreturn isSignedIn;`);

/**
 * @param {object} spec
 * @param {'vscode-in'|'vscode-out'|'vscode-pending'|'web'|'none'} spec.bridge
 * @param {boolean} [spec.framed]     inside an iframe (the OS shell case)
 * @param {object|null} [spec.shellUser]  what OsShell.getUser() returns
 * @param {boolean} [spec.gxSession]  GxAuth.hasSession() for standalone
 * @param {string}  [spec.hostname]
 */
function host(spec) {
  const location = { hostname: spec.hostname ?? 'ginexys.com', search: '' };
  const win = { location };

  if (spec.bridge === 'vscode-in' || spec.bridge === 'vscode-out' || spec.bridge === 'vscode-pending') {
    const status = { 'vscode-in': 'signed-in', 'vscode-out': 'signed-out', 'vscode-pending': 'pending' }[spec.bridge];
    // The real VS Code shim sets isEmbedded:true AND provides getAuthState.
    win.CwsBridge = { isEmbedded: true, getAuthState: () => ({ status }) };
  } else if (spec.bridge === 'web') {
    // assets/os/bridge.js: isEmbedded mirrors framed-ness, and there is no
    // getAuthState. This is the shape that caused the outage.
    win.CwsBridge = { isEmbedded: !!spec.framed };
  }

  win.parent = spec.framed
    ? { OsShell: { getUser: () => spec.shellUser ?? null } }
    : win;

  if ('gxSession' in spec) win.GxAuth = { hasSession: () => !!spec.gxSession };

  return makeIsSignedIn(win, location, { getItem: () => null })();
}

const CASES = [
  ['VS Code webview, signed in',    { bridge: 'vscode-in', framed: true },                    true],
  ['VS Code webview, signed out',   { bridge: 'vscode-out', framed: true },                   false],
  ['VS Code webview, pending',      { bridge: 'vscode-pending', framed: true },               false],
  ['OS shell, anonymous',           { bridge: 'web', framed: true, shellUser: null },         false],
  ['OS shell, signed in',           { bridge: 'web', framed: true, shellUser: { tier: 'free' } }, true],
  ['Standalone, anonymous',         { bridge: 'web', gxSession: false },                      false],
  ['Standalone, signed in',         { bridge: 'web', gxSession: true },                       true],
  ['No bridge, no GxAuth',          { bridge: 'none' },                                       false],
  ['Dev host bypass',               { bridge: 'none', hostname: 'localhost' },                true],
];

let failed = 0;
for (const [name, spec, want] of CASES) {
  let got, err = null;
  try { got = host(spec); } catch (e) { err = e; }
  const ok = !err && got === want;
  if (!ok) failed++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(30)} ` +
    (err ? `threw ${err.message}` : `got=${String(got).padEnd(5)} want=${want}`)
  );
}

console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
if (failed) {
  console.error(
    '\nA failing "OS shell, anonymous" case means the gate is open to everyone in\n' +
    'the shell. That is the exact production outage this test exists for.'
  );
  process.exit(1);
}
