'use strict';

/** Self-test for the window navigation policy. */

const assert = require('assert');
const {
  createPolicy,
  evaluateNavigation,
  evaluateWindowOpen,
  isNavigationAllowed,
  attachNavigationGuard,
  hostMatches,
  originOf,
} = require('./navigation-policy');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

/** Minimal Electron webContents stand-in. */
function fakeWebContents(initialUrl = 'https://app.example.com/start') {
  const listeners = new Map();
  let windowOpenHandler = null;
  return {
    getURL: () => initialUrl,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    removeListener(event, handler) {
      const list = listeners.get(event) || [];
      listeners.set(event, list.filter((h) => h !== handler));
    },
    setWindowOpenHandler(handler) {
      windowOpenHandler = handler;
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) || []) handler(...args);
    },
    callWindowOpenHandler(details) {
      return windowOpenHandler ? windowOpenHandler(details) : null;
    },
    hasWindowOpenHandler: () => windowOpenHandler !== null,
    listenerCount: (event) => (listeners.get(event) || []).length,
  };
}

const policy = createPolicy({
  hostsByWindow: {
    'extension-store': ['chromewebstore.google.com', 'addons.mozilla.org'],
    'help-window': ['*.example.com'],
  },
});

// ---- host matching ----

check('hostMatches compares case-insensitively', () => {
  assert.strictEqual(hostMatches('Example.COM', 'example.com'), true);
  assert.strictEqual(hostMatches('example.com', 'EXAMPLE.com'), true);
});

check('hostMatches supports a leading wildcard', () => {
  assert.strictEqual(hostMatches('a.example.com', '*.example.com'), true);
  assert.strictEqual(hostMatches('deep.a.example.com', '*.example.com'), true);
  assert.strictEqual(hostMatches('example.com', '*.example.com'), true, 'bare domain matches too');
  assert.strictEqual(hostMatches('notexample.com', '*.example.com'), false, 'no suffix bleed');
  assert.strictEqual(hostMatches('evil.com', '*.example.com'), false);
});

check('hostMatches rejects empty input', () => {
  assert.strictEqual(hostMatches('', 'example.com'), false);
  assert.strictEqual(hostMatches('example.com', ''), false);
  assert.strictEqual(hostMatches(null, null), false);
});

check('originOf parses or returns null', () => {
  assert.strictEqual(originOf('https://a.example.com/x?y=1'), 'https://a.example.com');
  assert.strictEqual(originOf('not a url'), null);
});

// ---- decision order ----

check('development mode allows everything', () => {
  const dev = createPolicy({ developmentMode: true });
  const d = evaluateNavigation(dev, 'any', 'https://evil.test/');
  assert.strictEqual(d.allowed, true);
  assert.strictEqual(d.rule, 'development');
});

check('allow-listed urls pass', () => {
  assert.strictEqual(isNavigationAllowed(policy, 'x', 'about:blank'), true);
});

check('allow-listed protocols pass', () => {
  assert.strictEqual(isNavigationAllowed(policy, 'x', 'file:///tmp/page.html'), true);
});

check('per-window host allow-list passes', () => {
  assert.strictEqual(isNavigationAllowed(policy, 'extension-store', 'https://chromewebstore.google.com/detail'), true);
  assert.strictEqual(isNavigationAllowed(policy, 'extension-store', 'https://addons.mozilla.org/en-US/'), true);
});

check('wildcard window allow-list passes', () => {
  assert.strictEqual(isNavigationAllowed(policy, 'help-window', 'https://docs.example.com/guide'), true);
});

check('host allow-list is scoped to its own window', () => {
  assert.strictEqual(isNavigationAllowed(policy, 'other-window', 'https://chromewebstore.google.com/'), false);
});

check('same-origin navigation passes', () => {
  const d = evaluateNavigation(policy, 'x', 'https://app.example.com/next', {
    initialUrl: 'https://app.example.com/start',
  });
  assert.strictEqual(d.allowed, true);
  assert.strictEqual(d.rule, 'same-origin');
});

check('cross-origin navigation is blocked', () => {
  const d = evaluateNavigation(policy, 'x', 'https://evil.test/', {
    initialUrl: 'https://app.example.com/start',
  });
  assert.strictEqual(d.allowed, false);
  assert.ok(/blocked/.test(d.reason));
});

check('opaque-origin targets cannot ride the same-origin rule', () => {
  // A window whose initial url is a local file reports the opaque origin
  // "null" - exactly like data:, blob: and javascript: do. Those must not
  // compare equal, or every one of them would be allowed by accident.
  const initialUrl = 'file:///opt/app/resources/app/index.html';
  for (const target of ['javascript:alert(1)', 'mailto:someone@example.test', 'data:text/html,<b>x</b>', 'blob:null/abc']) {
    const d = evaluateNavigation(policy, 'shell', target, { initialUrl });
    assert.strictEqual(d.allowed, false, `${target} should be blocked`);
    assert.notStrictEqual(d.rule, 'same-origin', `${target} must not use the same-origin rule`);
  }
  // A real origin still gets the same-origin shortcut.
  const ok = evaluateNavigation(policy, 'shell', 'https://app.example.com/next', { initialUrl: 'https://app.example.com/start' });
  assert.strictEqual(ok.allowed, true);
  assert.strictEqual(ok.rule, 'same-origin');
});

check('malformed urls are blocked', () => {
  const d = evaluateNavigation(policy, 'x', 'not a url');
  assert.strictEqual(d.allowed, false);
  assert.strictEqual(d.reason, 'malformed url');
});

check('missing policy blocks everything', () => {
  assert.strictEqual(evaluateNavigation(null, 'x', 'https://a.test/').allowed, false);
});

check('file protocol is blocked when not allow-listed', () => {
  const strict = createPolicy({ allowedProtocols: [] });
  assert.strictEqual(isNavigationAllowed(strict, 'x', 'file:///etc/passwd'), false);
});

check('about:blank is blocked when urls are not allow-listed', () => {
  const strict = createPolicy({ allowedUrls: [] });
  assert.strictEqual(isNavigationAllowed(strict, 'x', 'about:blank'), false);
});

// ---- window open ----

check('window open is allowed for allow-listed targets', () => {
  const d = evaluateWindowOpen(policy, 'extension-store', 'https://chromewebstore.google.com/x');
  assert.strictEqual(d.allow, true);
  assert.strictEqual(d.openExternal, false);
});

check('disallowed external target is flagged for the system browser', () => {
  const d = evaluateWindowOpen(policy, 'x', 'https://external.test/page', {
    initialUrl: 'https://app.example.com/start',
  });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.openExternal, true);
});

check('disallowed non-http target is not marked external', () => {
  const d = evaluateWindowOpen(policy, 'x', 'ftp://files.test/a');
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.openExternal, false);
});

// ---- electron binding ----

check('guard blocks a disallowed will-navigate', () => {
  const wc = fakeWebContents('https://app.example.com/start');
  attachNavigationGuard(wc, 'x', policy);
  let prevented = false;
  wc.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://evil.test/');
  assert.strictEqual(prevented, true);
  assert.strictEqual(wc.listenerCount('will-navigate'), 1);
});

check('guard allows a same-origin will-navigate', () => {
  const wc = fakeWebContents('https://app.example.com/start');
  attachNavigationGuard(wc, 'x', policy);
  let prevented = false;
  wc.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://app.example.com/next');
  assert.strictEqual(prevented, false);
});

check('guard reports blocked navigations to the hook', () => {
  const wc = fakeWebContents('https://app.example.com/start');
  const messages = [];
  attachNavigationGuard(wc, 'x', policy, { onBlocked: (m) => messages.push(m) });
  wc.emit('will-navigate', { preventDefault() {} }, 'https://evil.test/');
  assert.strictEqual(messages.length, 1);
  assert.ok(/evil\.test/.test(messages[0]));
});

check('guard denies new windows and forwards http targets externally', () => {
  const wc = fakeWebContents('https://app.example.com/start');
  const opened = [];
  attachNavigationGuard(wc, 'x', policy, { openExternal: (u) => opened.push(u) });
  assert.strictEqual(wc.hasWindowOpenHandler(), true);

  const denied = wc.callWindowOpenHandler({ url: 'https://evil.test/' });
  assert.strictEqual(denied.action, 'deny');
  assert.deepStrictEqual(opened, ['https://evil.test/']);

  const allowed = wc.callWindowOpenHandler({ url: 'https://app.example.com/next' });
  assert.strictEqual(allowed.action, 'allow');
});

check('detach removes the navigation listener', () => {
  const wc = fakeWebContents('https://app.example.com/start');
  const detach = attachNavigationGuard(wc, 'x', policy);
  assert.strictEqual(wc.listenerCount('will-navigate'), 1);
  detach();
  assert.strictEqual(wc.listenerCount('will-navigate'), 0);
});

check('guard rejects a webContents without .on', () => {
  assert.throws(() => attachNavigationGuard({}, 'x', policy), /webContents with \.on/);
});

check('policy copies host lists so later mutation does not leak', () => {
  const hosts = { w: ['a.test'] };
  const p = createPolicy({ hostsByWindow: hosts });
  hosts.w.push('evil.test');
  assert.strictEqual(isNavigationAllowed(p, 'w', 'https://evil.test/'), false);
  assert.strictEqual(isNavigationAllowed(p, 'w', 'https://a.test/'), true);
});

// ---- report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
console.log(`\nNAVIGATION_POLICY_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
if (failed.length) process.exitCode = 1;
