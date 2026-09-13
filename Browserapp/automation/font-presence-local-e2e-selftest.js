#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for the system-font-presence surface.
 *
 * A page can ask the engine whether a named family is installed by constructing a FontFace from
 * a plain local() source and awaiting load(). The host font store answers that directly, so a
 * persona running on a different platform is contradicted by a single settled promise. The
 * injected layer answers that question from the persona's own platform font list instead:
 * families that platform ships resolve, everything else fails the way the engine fails for a
 * local source it cannot find. Only a plain local() source is intercepted - a source that mixes
 * local() with a url() candidate is a page loading its own web font and keeps the engine's own
 * resolution order.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildFingerprint, buildInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} - ${error.message}`); process.exitCode = 1; }
};
const skip = (name, why) => { results.push({ name, ok: true }); console.log(`  SKIP  ${name}${why ? ' - ' + why : ''}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.id && this.pending.has(message.id)) {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve(message);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: { message: 'CDP timeout: ' + method } }); }, 30000);
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  call(a, b, c) { return typeof c === 'undefined' ? this.send(a, b || {}) : this.send(b, c || {}); }
  async value(expression) {
    const message = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const exception = message?.result?.exceptionDetails;
    if (exception) return { error: exception.text || String(exception) };
    const raw = message?.result?.result?.value;
    try { return JSON.parse(raw); } catch (_) { return { error: 'probe parse', raw: String(raw).slice(0, 240) }; }
  }
}

function buildProbe() {
  return `(async () => {
    const out = { marker: window.__marker === true, items: {}, shape: {}, statusOk: true };
    const probe = async (family) => {
      const face = new FontFace(family, 'local("' + family + '")');
      const entry = {};
      try { await face.load(); entry.outcome = 'resolve'; }
      catch (e) { entry.outcome = 'reject'; entry.errName = e && e.name; }
      try { entry.status = face.status; } catch (_) { entry.status = 'throw'; }
      entry.ownNames = Object.getOwnPropertyNames(face);
      return entry;
    };
    const families = ${JSON.stringify([
      'Helvetica Neue', 'Luminari', 'PingFang HK Light', 'Galvji', 'InaiMathi Bold', 'Chakra Petch',
      'Segoe UI', 'Cambria Math', 'Nirmala UI', 'Leelawadee UI', 'Microsoft YaHei',
      'Aldhabi', 'Segoe Fluent Icons', 'HoloLens MDL2 Assets',
    ])};
    for (const family of families) out.items[family] = await probe(family);

    // Business safety: a page's own web font still loads.
    const subsetPath = '/subset.woff2';
    let webfont = null;
    try {
      const buf = await (await fetch(subsetPath)).arrayBuffer();
      const face = new FontFace('AuditWebFont', buf);
      await face.load();
      webfont = face.status === 'loaded' ? 'loaded' : face.status;
    } catch (e) { webfont = 'err:' + (e && e.name); }
    // A mixed source must keep the engine's own resolution order (url candidate wins).
    let mixed = null;
    try {
      const buf = await (await fetch(subsetPath)).arrayBuffer();
      const blobUrl = URL.createObjectURL(new Blob([buf], { type: 'font/woff2' }));
      const face = new FontFace('AuditMixed', 'local("NoSuchLocalFontZZZ"), url("' + blobUrl + '")');
      await face.load();
      mixed = face.status === 'loaded' ? 'loaded' : face.status;
    } catch (e) { mixed = 'err:' + (e && e.name); }
    out.webfont = webfont;
    out.mixed = mixed;

    out.shape = {
      type: typeof FontFace,
      name: FontFace.name,
      length: FontFace.length,
      toStringCtor: Function.prototype.toString.call(FontFace),
      toStringLoad: Function.prototype.toString.call(FontFace.prototype.load),
      toStringHasSource: /localOnlyFamily|isPlainLocalSource/.test(Function.prototype.toString.call(FontFace.prototype.load)),
    };

    // Rebuild the platform-consistency check used by common detectors over the probe results.
    const APPLE = ['Helvetica Neue', 'Luminari', 'PingFang HK Light', 'InaiMathi Bold', 'Galvji', 'Chakra Petch'];
    const WIN = ['Cambria Math', 'Nirmala UI', 'Leelawadee UI', 'HoloLens MDL2 Assets', 'Segoe Fluent Icons'];
    const found = Object.keys(out.items).filter((f) => out.items[f].outcome === 'resolve');
    const inSet = (list) => list.some((f) => found.includes(f));
    out.consistency = {
      found,
      isLikeApple: inSet(APPLE),
      isLikeWindows: inSet(WIN),
    };
    return JSON.stringify(out);
  })()`;
}

async function serve() {
  const subset = fs.readFileSync(path.join(appRoot, 'assets', 'font-subsets', 'windows', 'segoe-ui.woff2'));
  const server = http.createServer((request, response) => {
    if (request.url === '/subset.woff2') {
      response.setHeader('Content-Type', 'font/woff2');
      response.end(subset);
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>font-presence</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function runPersona(label, userAgent, osName, serverPort, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-fontpresence-${label}-`));
  const profile = {
    id: `fontpresence-${label}`, name: `fontpresence-${label}`, language: 'en-US',
    userAgent, kernelVersion: '148.0.7778.165', os: osName, exitIp: '203.0.113.7',
    privacy: { deviceProfile: 'persona' },
  };
  const fp = buildFingerprint(profile);
  await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, 'init_template.json') });

  const child = spawn(launcher, [dir, '--headless=new'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });
  child.unref();
  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(400);
    try {
      const value = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (value > 0) { port = value; break; }
    } catch (_) {}
  }
  if (!port) return { error: 'no devtools port' };
  let page = null;
  for (let i = 0; i < 40 && !page; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = (list || []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    } catch (_) {}
    if (!page) await sleep(300);
  }
  if (!page?.webSocketDebuggerUrl) return { error: 'no page target' };

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP WebSocket connect failed')); });
  const cdp = new Cdp(ws);
  await cdp.call('Page.enable', {});
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__marker = true;' });
  const source = mutate ? '/* persona font presence gate disabled for mutation */' : buildInjectionScript(fp);
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source });
  await cdp.call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
  await sleep(2500);
  const probe = await cdp.value(buildProbe());
  try { ws.close(); } catch (_) {}
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
  return { probe };
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 kernel launcher available');
    console.log(`font-presence-local-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const { server, port } = await serve();

  const win = await runPersona('win', WINDOWS_UA, 'Windows', port, process.argv.includes('--mutate'));
  const mac = await runPersona('mac', MAC_UA, 'macOS', port, process.argv.includes('--mutate'));

  check('probe marker self-proof', () => {
    assert.strictEqual(win.probe.marker, true, 'window.__marker must be true (win)');
    assert.strictEqual(mac.probe.marker, true, 'window.__marker must be true (mac)');
  });

  check('foreign families reject with a NetworkError on a Windows persona', () => {
    for (const family of ['Helvetica Neue', 'Luminari', 'PingFang HK Light', 'Galvji', 'InaiMathi Bold', 'Chakra Petch']) {
      const entry = win.probe.items[family];
      assert.ok(entry, `probe entry for ${family} must exist`);
      assert.strictEqual(entry.outcome, 'reject', `${family} must reject on a Windows persona, got ${entry.outcome}`);
      assert.strictEqual(entry.errName, 'NetworkError', `${family} rejection must be a NetworkError`);
    }
  });

  check('persona families resolve on a Windows persona', () => {
    for (const family of ['Segoe UI', 'Cambria Math', 'Nirmala UI', 'Leelawadee UI', 'Microsoft YaHei', 'Aldhabi', 'Segoe Fluent Icons', 'HoloLens MDL2 Assets']) {
      const entry = win.probe.items[family];
      assert.ok(entry, `probe entry for ${family} must exist`);
      assert.strictEqual(entry.outcome, 'resolve', `${family} must resolve on a Windows persona, got ${entry.outcome}`);
    }
  });

  check('Apple families resolve and Windows families reject on a macOS persona', () => {
    for (const family of ['Helvetica Neue', 'Luminari', 'PingFang HK Light', 'InaiMathi Bold', 'Galvji']) {
      const entry = mac.probe.items[family];
      assert.strictEqual(entry.outcome, 'resolve', `${family} must resolve on a macOS persona, got ${entry.outcome}`);
    }
    for (const family of ['Segoe UI', 'Cambria Math', 'Nirmala UI', 'Leelawadee UI']) {
      const entry = mac.probe.items[family];
      assert.strictEqual(entry.outcome, 'reject', `${family} must reject on a macOS persona, got ${entry.outcome}`);
    }
  });

  check('a page own web font and a mixed local()+url() source still load', () => {
    assert.strictEqual(win.probe.webfont, 'loaded', `page web font must load, got ${win.probe.webfont}`);
    assert.strictEqual(win.probe.mixed, 'loaded', `mixed local()+url() source must load, got ${win.probe.mixed}`);
  });

  check('FontFace keeps its native shape and hides the patch', () => {
    const shape = win.probe.shape;
    assert.strictEqual(shape.type, 'function');
    assert.strictEqual(shape.name, 'FontFace');
    assert.strictEqual(shape.length, 2);
    assert.ok(/\[native code\]/.test(shape.toStringCtor), 'FontFace.toString must look native');
    assert.ok(/\[native code\]/.test(shape.toStringLoad), 'load.toString must look native');
    assert.strictEqual(shape.toStringHasSource, false, 'load.toString must not leak wrapper internals');
  });

  check('status agrees with the forced outcome and faces stay own-property clean', () => {
    for (const family of ['Segoe UI', 'Helvetica Neue']) {
      const entry = win.probe.items[family];
      const expected = entry.outcome === 'resolve' ? 'loaded' : 'error';
      assert.strictEqual(entry.status, expected, `${family} status must be ${expected}, got ${entry.status}`);
      assert.deepStrictEqual(entry.ownNames, [], `${family} face must carry no own properties`);
    }
  });

  check('platform-consistency markers line up with the claimed OS', () => {
    assert.strictEqual(win.probe.consistency.isLikeApple, false,
      `Windows persona must not look Apple-like, found: ${win.probe.consistency.found.join(', ')}`);
    assert.strictEqual(win.probe.consistency.isLikeWindows, true,
      'Windows persona must look Windows-like');
    assert.strictEqual(mac.probe.consistency.isLikeApple, true, 'macOS persona must look Apple-like');
    assert.strictEqual(mac.probe.consistency.isLikeWindows, false,
      `macOS persona must not look Windows-like, found: ${mac.probe.consistency.found.join(', ')}`);
  });

  server.close();

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) console.log(`font-presence-local-e2e-selftest: OK ${results.length}/${results.length}`);
  else {
    console.log(`font-presence-local-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('font-presence-local-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
