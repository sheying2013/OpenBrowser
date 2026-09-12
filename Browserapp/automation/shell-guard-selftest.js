'use strict';

/**
 * Shell navigation guard.
 *
 * Drives the real guard with an event-emitter stand-in for webContents, and
 * pins the allow-list to the session request filter in the host process so the
 * two definitions cannot drift apart.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  attachShellNavigationGuard,
  createShellNavigationPolicy,
  SHELL_WINDOW,
  SHELL_ALLOWED_PROTOCOLS,
  SHELL_ALLOWED_URLS,
  LOCAL_HOSTS,
} = require('./shell-guard');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

const SHELL_URL = 'file:///Applications/OpenBrowser/resources/app/index.html';

function fakeWebContents(initialUrl = SHELL_URL) {
  const listeners = new Map();
  const state = { windowOpenHandler: null };
  return {
    state,
    on(type, handler) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(handler); },
    removeListener(type, handler) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    listenerCount(type) { return (listeners.get(type) || []).length; },
    getURL: () => initialUrl,
    setWindowOpenHandler(handler) { state.windowOpenHandler = handler; },
    /** Simulate an attempted navigation; returns the decision the guard made. */
    navigate(url) {
      let prevented = false;
      const event = { preventDefault: () => { prevented = true; } };
      for (const handler of [...(listeners.get('will-navigate') || [])]) handler(event, url);
      return prevented;
    },
  };
}

// ---- protocol / url allow-list ----
{
  const blocked = [];
  const contents = fakeWebContents();
  attachShellNavigationGuard(contents, { onBlocked: (info) => blocked.push(info) });

  check('the shell may reload its own local document', () => {
    assert.strictEqual(contents.navigate(SHELL_URL), false);
    assert.strictEqual(blocked.length, 0);
  });
  check('about:blank is allowed', () => {
    assert.strictEqual(contents.navigate('about:blank'), false);
  });
  check('another local file is allowed', () => {
    assert.strictEqual(contents.navigate('file:///tmp/other.html'), false);
  });
  check('a remote page cannot replace the shell', () => {
    assert.strictEqual(contents.navigate('https://example.test/login'), true);
    assert.strictEqual(blocked.length, 1);
    assert.ok(/example\.test/.test(blocked[0].reason), blocked[0].reason);
    assert.strictEqual(blocked[0].url, 'https://example.test/login');
  });
  check('plain http is blocked too', () => {
    assert.strictEqual(contents.navigate('http://example.test/'), true);
  });
  check('the local api host stays reachable', () => {
    assert.strictEqual(contents.navigate('http://127.0.0.1:50325/status'), false);
    assert.strictEqual(contents.navigate('http://localhost:50326/'), false);
  });
  check('a look-alike host cannot ride the localhost rule', () => {
    assert.strictEqual(contents.navigate('http://localhost.example.test/'), true);
    assert.strictEqual(contents.navigate('http://127.0.0.1.example.test/'), true);
    assert.strictEqual(contents.navigate('https://example.test/?next=localhost'), true);
  });
  check('non-network schemes are blocked', () => {
    assert.strictEqual(contents.navigate('mailto:someone@example.test'), true);
    assert.strictEqual(contents.navigate('javascript:alert(1)'), true);
    assert.strictEqual(contents.navigate('ftp://example.test/x'), true);
  });
  check('a malformed target is blocked rather than allowed by accident', () => {
    assert.strictEqual(contents.navigate('http://[::1'), true);
  });
  check('blocks are reported with a reason', () => {
    const last = blocked[blocked.length - 1];
    assert.ok(last && typeof last.reason === 'string' && last.reason.length > 0);
  });
}

// ---- child windows ----
{
  const contents = fakeWebContents();
  attachShellNavigationGuard(contents);
  check('a window-open handler is installed', () => {
    assert.strictEqual(typeof contents.state.windowOpenHandler, 'function');
  });
  check('child windows stay denied for every target', () => {
    for (const url of ['https://example.test/', 'file:///tmp/x.html', 'about:blank', 'http://127.0.0.1:50325/']) {
      assert.deepStrictEqual(contents.state.windowOpenHandler({ url }), { action: 'deny' }, url);
    }
  });
}

// ---- detach ----
{
  const contents = fakeWebContents();
  const detach = attachShellNavigationGuard(contents);
  check('the guard registers exactly one navigation listener', () => {
    assert.strictEqual(contents.listenerCount('will-navigate'), 1);
  });
  check('detaching removes the listener and stops blocking', () => {
    detach();
    assert.strictEqual(contents.listenerCount('will-navigate'), 0);
    assert.strictEqual(contents.navigate('https://example.test/'), false);
  });
  check('detaching twice is harmless', () => {
    detach();
    assert.strictEqual(contents.listenerCount('will-navigate'), 0);
  });
}

// ---- policy shape ----
{
  check('the policy names the shell window and lists only the local hosts', () => {
    const policy = createShellNavigationPolicy();
    assert.deepStrictEqual(policy.allowedProtocols, ['file:', 'data:', 'devtools:']);
    assert.deepStrictEqual(policy.allowedUrls, ['about:blank']);
    assert.deepStrictEqual(policy.hostsByWindow[SHELL_WINDOW], ['127.0.0.1', 'localhost']);
    assert.strictEqual(policy.developmentMode, false);
  });
  check('development mode is opt-in only', () => {
    assert.strictEqual(createShellNavigationPolicy().developmentMode, false);
    assert.strictEqual(createShellNavigationPolicy({ developmentMode: true }).developmentMode, true);
    const permissive = fakeWebContents();
    attachShellNavigationGuard(permissive, { policy: createShellNavigationPolicy({ developmentMode: true }) });
    assert.strictEqual(permissive.navigate('https://example.test/'), false);
  });
  check('a missing webContents is rejected loudly', () => {
    assert.throws(() => attachShellNavigationGuard(null), /webContents/);
  });
}

// ---- the allow-list must mirror the host-process request filter ----
{
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  check('main.js wires the guard into the shell window', () => {
    assert.ok(/require\('\.\/automation\/shell-guard'\)/.test(mainSource), 'guard module is not required');
    assert.ok(/attachShellNavigationGuard\(win\.webContents/.test(mainSource), 'guard is not attached to the shell window');
  });
  check('the shell no longer sets its own window-open handler', () => {
    assert.ok(!/webContents\.setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/.test(mainSource),
      'the guard owns window-open policy; a second handler would silently win');
  });
  check('every allow-listed protocol is also in the request filter', () => {
    const filter = mainSource.match(/onBeforeRequest\(\(details, callback\)[\s\S]{0,600}?callback\(\{ cancel: !allowed \}\)/);
    assert.ok(filter, 'could not locate the session request filter');
    for (const protocol of SHELL_ALLOWED_PROTOCOLS) {
      assert.ok(filter[0].includes(`'${protocol}'`) || filter[0].includes(protocol),
        `request filter does not allow ${protocol}`);
    }
  });
  check('every local host is also in the request filter', () => {
    const filter = mainSource.match(/onBeforeRequest\(\(details, callback\)[\s\S]{0,600}?callback\(\{ cancel: !allowed \}\)/)[0];
    for (const host of LOCAL_HOSTS) {
      if (host === 'localhost') { assert.ok(/localhost/.test(filter), 'localhost missing from request filter'); continue; }
      const escaped = host.replace(/\./g, '\\.');
      assert.ok(filter.includes(escaped) || filter.includes(host), `${host} missing from request filter`);
    }
  });
  check('the guard constants do not drift from the request filter protocols', () => {
    const filterSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const listed = [...filterSource.matchAll(/url\.startsWith\('([a-z]+:)'\)/g)].map((m) => m[1]);
    for (const protocol of listed) {
      assert.ok(SHELL_ALLOWED_PROTOCOLS.includes(protocol),
        `request filter allows ${protocol} but the shell guard does not (add it to SHELL_ALLOWED_PROTOCOLS)`);
    }
    for (const protocol of SHELL_ALLOWED_PROTOCOLS) {
      assert.ok(listed.includes(protocol), `shell guard allows ${protocol} but the request filter does not`);
    }
  });
  check('the allowed url list stays minimal', () => {
    assert.deepStrictEqual(SHELL_ALLOWED_URLS, ['about:blank']);
  });
}

// ================= report =================
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\nSHELL_GUARD_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${results.filter((r) => r.ok).length}/${results.length}`);
if (failed.length) process.exitCode = 1;
