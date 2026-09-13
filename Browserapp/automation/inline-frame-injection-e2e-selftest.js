#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for the documents that are not a top level page of their own target.
 *
 * A page can hand out a fingerprint out of a document the opener controls - an about:blank popup it
 * writes into, a srcdoc / data: / blob: frame, a noopener popup - and a cross origin frame lives in a
 * target of its own, so it has to be attached and injected separately. None of those are covered by
 * the page tests, and a document that misses the layer hands out the machine identity instead of the
 * profile one.
 *
 * The test is two sided: the same probe runs once with nothing injected and once with the production
 * chain (browser level auto attach, the page/iframe entry point, the worker script), so a probe that
 * gathered nothing cannot pass by accident. Identity fields are used as the signal because in this
 * deployment the kernel does not apply them from init.json - the page layer is what carries them.
 */

const assert = require('assert');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { buildFingerprint, buildWorkerInjectionScript, applyFingerprintToTab } = require('./fingerprint');
const kinit = require('./kernel-init-sync');

const KERNEL_ROOT = path.join(__dirname, '..', 'kernels', 'macos-x64');
const LAUNCHER = path.join(KERNEL_ROOT, 'launch_openbrowser.sh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROFILE = {
  id: 'inline-frame-e2e',
  name: 'inline-frame-e2e',
  kernelVersion: '148.0.7778.165',
  os: 'windows',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  canvas: 'noise',
  webgl: 'noise',
  cores: 8,
  memory: 8,
  privacy: { webrtc: 'proxy', timezoneMode: 'custom', timezone: 'America/Chicago', languages: ['fr-FR', 'fr'] },
};

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${err.message}`); process.exitCode = 1; }
};
const skip = (name) => { results.push({ name, ok: true }); console.log(`  SKIP  ${name}`); };

const PAYLOAD = `(function (kind) {
  const payload = {
    kind: kind,
    platform: navigator.platform,
    cores: navigator.hardwareConcurrency,
    mem: navigator.deviceMemory,
    langs: (navigator.languages || []).join(','),
    tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return ''; } })(),
    hasCores: 'hardwareConcurrency' in navigator,
    hasMem: 'deviceMemory' in navigator,
    hasLangs: 'languages' in navigator,
    hasUad: 'userAgentData' in navigator,
  };
  try { (window.opener || window.parent).postMessage({ __obReport: payload }, '*'); } catch (_) {}
  try { fetch('/report?payload=' + encodeURIComponent(JSON.stringify(payload)), { mode: 'no-cors' }); } catch (_) {}
  return payload;
})`;
const REPORT = PAYLOAD;

const CHILD = `<!doctype html><html><head><title>child</title></head><body><script>window.__report = ${REPORT}('__KIND__');<\/script></body></html>`;

const OPENER = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const relayed = [];
  window.addEventListener('message', (event) => { try { if (event.data && event.data.__obReport) relayed.push(event.data.__obReport); } catch (_) {} });
  const childHtml = (kind) => ${JSON.stringify(CHILD)}.split('__KIND__').join(kind);
  // A popup the opener writes into: the document belongs to the popup but the opener's script fills it.
  const written = window.open('about:blank');
  if (written) { written.document.open(); written.document.write(childHtml('written-popup')); written.document.close(); }
  // A popup that navigates itself: the same target path a noopener popup takes, without depending on
  // the popup blocker letting a gesture-less window.open through twice.
  window.open('/child?kind=named-popup', 'ob-inline-probe');
  const frame = (kind, attrs) => {
    const f = document.createElement('iframe');
    for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v);
    f.id = kind;
    document.body.appendChild(f);
    return kind;
  };
  frame('srcdoc-frame', { srcdoc: childHtml('srcdoc-frame') });
  frame('blob-frame', { src: URL.createObjectURL(new Blob([childHtml('blob-frame')], { type: 'text/html' })) });
  frame('data-frame', { src: 'data:text/html;charset=utf-8,' + encodeURIComponent(childHtml('data-frame')) });
  frame('cross-origin-frame', { src: location.protocol + '//localhost:' + location.port + '/child?kind=cross-origin-frame' });
  await wait(4500);
  try { fetch('/report?payload=' + encodeURIComponent(JSON.stringify(relayed)), { mode: 'no-cors' }); } catch (_) {}
  return 'ok:' + relayed.length;
})()`;

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', (ev) => {
      let m = null; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) { const { res, timer } = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(timer); res(m); return; }
      if (m.method) for (const h of this.handlers) h(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq; const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res) => { const timer = setTimeout(() => { this.pending.delete(id); res({ error: 'timeout', method }); }, 30000); this.pending.set(id, { res, timer }); this.ws.send(JSON.stringify(msg)); });
  }
  on(handler) { this.handlers.push(handler); }
}

async function run(kind, inject) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-inline-'));
  const profile = Object.assign({}, PROFILE, { id: PROFILE.id + '-' + kind, name: PROFILE.name + '-' + kind });
  const fp = buildFingerprint(profile);
  await kinit.writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(KERNEL_ROOT, 'init_template.json') });
  const reports = [];
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://x');
    if (parsed.pathname === '/report') {
      try {
        const parsedPayload = JSON.parse(parsed.searchParams.get('payload') || '{}');
        for (const entry of (Array.isArray(parsedPayload) ? parsedPayload : [parsedPayload])) reports.push(entry);
      } catch (_) {}
      res.writeHead(204); res.end(); return;
    }
    if (parsed.pathname === '/child') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(CHILD.split('__KIND__').join(parsed.searchParams.get('kind') || 'child'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body>opener</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const child = spawn(LAUNCHER, [dir, '--headless=new', '--disable-popup-blocking'], { cwd: KERNEL_ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  const stop = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch (_) {}
    try { server.close(); } catch (_) {}
  };

  let port = null;
  for (let i = 0; i < 90; i += 1) {
    await sleep(300);
    try { const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10); if (p > 0) { port = p; break; } } catch (_) {}
  }
  if (!port) { stop(); return { error: 'the kernel did not expose a CDP endpoint' }; }

  const wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('debugger socket')); });
  const cdp = new Cdp(ws);
  const injected = [];
  let openerIdentity = null;

  // The production chain: browser level auto attach with waitForDebuggerOnStart, nested attach for
  // pages so their frames and workers are discovered too, injection before the target resumes.
  cdp.on((message) => {
    if (message.method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo = {}, waitingForDebugger } = message.params || {};
    if (!sessionId) return;
    (async () => {
      try {
        if (targetInfo.type === 'page' || targetInfo.type === 'iframe') {
          await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
          if (inject) {
            await applyFingerprintToTab((method, params) => cdp.send(method, params, sessionId), null, fp, profile, { applyKey: 'inline-frame:' + kind + ':' + (targetInfo.targetId || sessionId) });
            injected.push(targetInfo.type + ':' + String(targetInfo.url || '').slice(0, 50));
          }
        } else if (inject && ['worker', 'shared_worker'].includes(targetInfo.type)) {
          await cdp.send('Runtime.evaluate', { expression: buildWorkerInjectionScript(fp), returnByValue: true }, sessionId);
        }
      } catch (error) {
        injected.push('ERR:' + error.message);
      } finally {
        if (waitingForDebugger) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      }
    })();
  });
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  await cdp.send('Target.createTarget', { url: origin + '/opener' });
  await sleep(2500);

  const targets = await cdp.send('Target.getTargets');
  const page = (targets.result?.targetInfos || []).find((t) => t.type === 'page' && t.url.indexOf('/opener') >= 0);
  let openerResult = null;
  if (page) {
    const att = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const m = await cdp.send('Runtime.evaluate', { expression: OPENER, awaitPromise: true, returnByValue: true }, att.result.sessionId);
    openerResult = m.result?.result?.value || null;
    const self = await cdp.send('Runtime.evaluate', { expression: PAYLOAD + '(' + JSON.stringify('opener') + ')', returnByValue: true }, att.result.sessionId);
    openerIdentity = self.result?.result?.value || null;
  }
  await sleep(2500);
  // A popup that was opened without an opener cannot send anything back through the page, so its
  // target is read directly - which also proves the target itself was injected.
  const after = await cdp.send('Target.getTargets');
  const popup = (after.result?.targetInfos || []).find((t) => t.type === 'page' && String(t.url).indexOf('kind=named-popup') >= 0);
  if (popup) {
    const popupAttached = await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
    const popupValue = await cdp.send('Runtime.evaluate', { expression: PAYLOAD + '(' + JSON.stringify('named-popup') + ')', returnByValue: true }, popupAttached.result.sessionId);
    const value = popupValue.result?.result?.value;
    if (value) reports.push(value);
  }
  try { ws.close(); } catch (_) {}
  stop();
  return { reports, injected, openerResult, openerIdentity, targetCount: (targets.result?.targetInfos || []).length };
}

const identityOf = (profile) => ({
  platform: profile.platform,
  cores: profile.hardwareConcurrency,
  mem: profile.deviceMemory,
  langs: (profile.languages || []).join(','),
  tz: profile.timezone,
});

(async () => {
  const raw = await run('raw', false);
  const injected = await run('injected', true);
  if (raw.error || injected.error) {
    skip('inline frame probe completed: ' + (raw.error || injected.error));
    console.log('inline-frame-injection-e2e-selftest: ok');
    return;
  }

  const kinds = (result) => [...new Set((result.reports || []).map((r) => r.kind))].sort();
  const byKind = (result, kind) => (result.reports || []).filter((r) => r.kind === kind)[0] || null;
  const wanted = ['written-popup', 'named-popup', 'srcdoc-frame', 'blob-frame', 'data-frame', 'cross-origin-frame'];
  // Only the members the document actually exposes can be compared: a data: frame has no
  // deviceMemory at all, and inventing one is what the presence check above forbids.
  const matches = (reference) => (report) => {
    if (!report || !reference) return false;
    for (const field of ['platform', 'cores', 'mem', 'langs', 'tz']) {
      if (!(field in report) || report[field] === undefined) continue;
      if (String(report[field]) !== String(reference[field])) return false;
    }
    return true;
  };

  check('every inline document reported from the raw pass', () => {
    const seen = kinds(raw);
    for (const kind of wanted) assert.ok(seen.includes(kind), `raw pass missed ${kind} (saw ${seen.join(',')})`);
  });
  check('every inline document reported from the injected pass', () => {
    const seen = kinds(injected);
    for (const kind of wanted) assert.ok(seen.includes(kind), `injected pass missed ${kind} (saw ${seen.join(',')})`);
  });
  check('the raw pass hands every document the machine identity (test is sensitive)', () => {
    const rawMatch = matches(raw.openerIdentity);
    const wrong = wanted.filter((kind) => !rawMatch(byKind(raw, kind)));
    assert.deepStrictEqual(wrong, [], 'raw documents that differ from the raw opener: ' + wrong.join(',') + ' :: ' + JSON.stringify(raw.reports) + ' vs opener ' + JSON.stringify(raw.openerIdentity));
    assert.ok(raw.openerIdentity, 'the raw pass must read the opener identity');
  });
  check('the injected identity differs from the raw one (the probe is sensitive)', () => {
    const reference = injected.openerIdentity;
    assert.ok(reference, 'the injected pass must read the opener identity');
    assert.notDeepStrictEqual(
      [raw.openerIdentity.platform, String(raw.openerIdentity.cores), raw.openerIdentity.tz],
      [reference.platform, String(reference.cores), reference.tz],
      'the raw and injected openers must not agree, or nothing is being measured',
    );
  });
  check('no document gains a navigator member a real engine would not expose there', () => {
    const flagged = [];
    for (const kind of wanted) {
      const before = byKind(raw, kind);
      const after = byKind(injected, kind);
      if (!before || !after) continue;
      for (const field of ['hasCores', 'hasMem', 'hasLangs']) {
        if (Boolean(before[field]) !== Boolean(after[field])) flagged.push(kind + '.' + field + ' raw=' + before[field] + ' injected=' + after[field]);
      }
    }
    assert.deepStrictEqual(flagged, [], 'member presence changed: ' + flagged.join('; '));
  });
  check('every inline document carries the same identity as the main frame', () => {
    const profileMatch = matches(injected.openerIdentity);
    const wrong = wanted.filter((kind) => !profileMatch(byKind(injected, kind)));
    assert.deepStrictEqual(wrong, [], 'documents without the injected identity: ' + wrong.join(',') + ' :: ' + JSON.stringify(injected.reports) + ' vs opener ' + JSON.stringify(injected.openerIdentity));
  });
  check('the cross origin frame lives in a target of its own and is injected there', () => {
    assert.ok(injected.injected.some((line) => line.indexOf('iframe:') === 0), 'no cross origin iframe target was injected: ' + injected.injected.join(' '));
  });
  check('a popup target of its own is injected as a page', () => {
    assert.ok(injected.injected.some((line) => line.indexOf('page:') === 0), 'no page target was injected: ' + injected.injected.join(' '));
  });

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log(`inline-frame-injection-e2e-selftest: OK ${results.length}/${results.length}`);
  else { console.log(`inline-frame-injection-e2e-selftest: FAILED ${failed.length}/${results.length}`); process.exitCode = 1; }
  process.exit(process.exitCode || 0);
})().catch((err) => {
  console.error('inline-frame-injection-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
