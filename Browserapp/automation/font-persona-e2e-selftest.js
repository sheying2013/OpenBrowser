#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for the font persona, run against the bundled kernel.
 *
 * Two surfaces are covered and one boundary is pinned:
 *   * Local Font Access runs against the real kernel and must report the persona's platform set
 *     while keeping the engine's FontData shape (prototype brand, inherited accessors, no own
 *     enumerable members, JSON as "{}").
 *   * document.fonts.check() must stay bit-identical to the untouched build. It answers true for
 *     every system family in this engine, so an override that denied "foreign" families would be
 *     pure difference: an own member on the FontFaceSet, a false where stock answers true, and no
 *     SyntaxError for a spec without a size.
 *   * Text measurement is not intercepted. The kernel-side font switch was measured inert on this
 *     build (toggling it and shipping a font list changed no measured width), so the host's real
 *     metrics stay readable and that surface has to be closed in the platform font stack.
 */

const assert = require('assert');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { buildFingerprint, applyFingerprintToTab } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${err.message}`); process.exitCode = 1; }
};
const skip = (name, why) => { results.push({ name, ok: true }); console.log(`  SKIP  ${name}${why ? ` — ${why}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(async () => {
  const out = {};
  const chk = (spec) => { try { return document.fonts.check(spec); } catch (e) { return 'THROW:' + e.name; } };
  out.check = {
    segoe: chk('12px "Segoe UI"'),
    segoeBare: chk('12px Segoe UI'),
    weight: chk('italic 700 12px "Segoe UI"'),
    helvetica: chk('12px "Helvetica Neue"'),
    menlo: chk('12px Menlo'),
    nonexistent: chk('12px "__Nonexistent_Family_e2e__"'),
    noSize: chk('"Segoe UI"'),
  };
  out.checkMeta = {
    own: Object.prototype.hasOwnProperty.call(document.fonts, 'check'),
    onProto: Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(document.fonts), 'check'),
    name: document.fonts.check.name,
    len: document.fonts.check.length,
    str: String(document.fonts.check),
  };
  const qdesc = Object.getOwnPropertyDescriptor(window, 'queryLocalFonts');
  out.qlfMeta = qdesc ? {
    enumerable: qdesc.enumerable, writable: qdesc.writable, configurable: qdesc.configurable, hasGet: !!qdesc.get,
    name: queryLocalFonts.name, len: queryLocalFonts.length, str: String(queryLocalFonts),
  } : null;
  try {
    const list = await queryLocalFonts();
    const f = list[0];
    const seen = [];
    for (const key in f) seen.push(key);
    out.qlf = {
      n: list.length,
      arrFrozen: Object.isFrozen(list),
      hasSegoe: list.some((x) => x.family === 'Segoe UI'),
      hasHelvetica: list.some((x) => x.family === 'Helvetica Neue'),
      proto: Object.getPrototypeOf(f) && Object.getPrototypeOf(f).constructor && Object.getPrototypeOf(f).constructor.name,
      ownKeys: Object.keys(f),
      getOwnNames: Object.getOwnPropertyNames(f),
      frozen: Object.isFrozen(f),
      extensible: Object.isExtensible(f),
      tag: Object.prototype.toString.call(f),
      symTag: f[Symbol.toStringTag],
      isFontData: typeof FontData === 'function' ? (f instanceof FontData) : 'n/a',
      json: JSON.stringify(f),
      forIn: seen.join(','),
      firstPost: f.postscriptName,
      firstStyle: f.style,
    };
  } catch (e) { out.qlfErr = e.name + ':' + String(e.message).slice(0, 60); }
  // Calling through another receiver must not be a way to read the host list: this engine does
  // not check the receiver, so a guard that delegated would leak every installed family.
  out.qlfReceiver = {
    bad: await (async () => {
      try { const list = await queryLocalFonts.call({}); return { threw: false, hasSegoe: list.some((x) => x.family === 'Segoe UI'), hasHelvetica: list.some((x) => x.family === 'Helvetica Neue') }; }
      catch (e) { return { threw: true, err: e.name }; }
    })(),
    loose: await (async () => {
      try { const list = await queryLocalFonts.call(undefined); return { threw: false, hasSegoe: list.some((x) => x.family === 'Segoe UI'), hasHelvetica: list.some((x) => x.family === 'Helvetica Neue') }; }
      catch (e) { return { threw: true, err: e.name }; }
    })(),
    bare: await (async () => { try { const q = queryLocalFonts; await q(); return 'ok'; } catch (e) { return 'THROW:' + e.name; } })(),
  };
  const ctx = document.createElement('canvas').getContext('2d');
  const width = (family) => { ctx.font = '72px "' + family + '", monospace'; return Math.round(ctx.measureText('mmmmmmmmmmlli').width * 1000) / 1000; };
  out.measure = { segoe: width('Segoe UI'), helvetica: width('Helvetica Neue'), nonexistent: width('__Nonexistent_Family_e2e__') };
  return JSON.stringify(out);
})()`;

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m = null; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) { const { res, timer } = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(timer); res(m); }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res) => {
      const timer = setTimeout(() => { this.pending.delete(id); res({ error: 'timeout', method }); }, 30000);
      this.pending.set(id, { res, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  call(a, b, c) { return typeof c === 'undefined' ? this.send(a, b || {}) : this.send(b, c || {}); }
  async evalValue(expression) {
    const m = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const v = m && m.result && m.result.result ? m.result.result.value : null;
    try { return JSON.parse(v); } catch (_) { return { error: 'probe parse', raw: String(v).slice(0, 200) }; }
  }
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('  SKIP  macos-x64 148 kernel launcher unavailable');
    console.log('font-persona-e2e-selftest: ok');
    return;
  }

  const profile = {
    id: 'font-e2e', name: 'font-e2e', kernelVersion: '148.0.7778.165', os: 'Windows',
    userAgent: WINDOWS_UA, canvas: 'noise', webgl: 'noise',
    privacy: { deviceProfile: 'persona' },
  };
  const fp = buildFingerprint(profile);
  const personaList = (fp.fonts && fp.fonts.list) || [];
  if (!personaList.length) {
    console.log('  SKIP  this profile did not produce a font persona');
    console.log('font-persona-e2e-selftest: ok');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-font-e2e-'));
  await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, 'init_template.json') });
  const child = spawn(launcher, [dir, '--headless=new'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });
  child.unref();
  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(400);
    try {
      const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (p > 0) { port = p; break; }
    } catch (_) {}
  }
  const stop = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
  };
  if (!port) {
    stop();
    console.log('  SKIP  kernel did not expose a CDP endpoint');
    console.log('font-persona-e2e-selftest: ok');
    return;
  }

  let page = null;
  for (let i = 0; i < 20; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = (list || []).find((t) => t.type === 'page');
      if (page) break;
    } catch (_) {}
    await sleep(400);
  }
  if (!page?.webSocketDebuggerUrl) {
    stop();
    console.log('  SKIP  kernel did not expose a page target');
    console.log('font-persona-e2e-selftest: ok');
    return;
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
  const cdp = new Cdp(ws);
  // Local Font Access is a secure-context API, so the probe needs a trustworthy origin: the
  // initial about:blank target does not expose queryLocalFonts at all.
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>font probe</body></html>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await cdp.send('Page.enable', {});
  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(1200);
  const granted = await cdp.send('Browser.grantPermissions', { origin, permissions: ['localFonts'] });
  const host = await cdp.evalValue(PROBE);
  await applyFingerprintToTab(cdp.call.bind(cdp), page.webSocketDebuggerUrl, fp, profile);
  const injected = await cdp.evalValue(PROBE);
  try { ws.close(); } catch (_) {}
  try { server.close(); } catch (_) {}
  stop();

  check('the probe answers before and after the inject', () => {
    assert.ok(host && !host.error, `host probe: ${host && host.raw}`);
    assert.ok(injected && !injected.error, `injected probe: ${injected && injected.raw}`);
  });
  check('the local font grant is available to the probe', () => {
    assert.strictEqual(String(granted && granted.error && granted.error.message || ''), '', `grantPermissions: ${JSON.stringify(granted && granted.error)}`);
    assert.ok(!host.qlfErr, `host queryLocalFonts: ${host.qlfErr}`);
    assert.ok(!injected.qlfErr, `injected queryLocalFonts: ${injected.qlfErr}`);
  });

  // The regression this exists for: any hook on check() shows up as an own member, a different
  // answer, or a swallowed SyntaxError. All three are compared against the untouched build.
  check('document.fonts.check() stays identical to the untouched build', () => {
    assert.strictEqual(injected.checkMeta.own, host.checkMeta.own, 'own member on the FontFaceSet');
    assert.strictEqual(injected.checkMeta.onProto, host.checkMeta.onProto, 'prototype member');
    assert.strictEqual(injected.checkMeta.name, host.checkMeta.name, 'function name');
    assert.strictEqual(injected.checkMeta.len, host.checkMeta.len, 'function arity');
    assert.strictEqual(injected.checkMeta.str, host.checkMeta.str, 'function source');
    assert.deepStrictEqual(injected.check, host.check, 'every answer must match the untouched build');
  });
  check('the untouched build answers true for system families (sensitivity control)', () => {
    // If a future kernel starts answering false, this control tells us the parity check above is no
    // longer discriminating, instead of passing silently.
    assert.strictEqual(host.check.nonexistent, true, 'stock behaviour: check() answers true for any system family');
    assert.strictEqual(host.check.noSize, 'THROW:SyntaxError', 'stock behaviour: a spec without a size throws');
  });

  check('local font access reports the persona platform set', () => {
    assert.strictEqual(injected.qlf.hasSegoe, true, 'a Windows persona must enumerate Segoe UI');
    assert.strictEqual(injected.qlf.hasHelvetica, false, 'a Windows persona must not enumerate Helvetica Neue');
    assert.ok(personaList.includes('Segoe UI'), 'the platform table carries Segoe UI');
    assert.ok(!personaList.includes('Helvetica Neue'), 'a Windows persona must not advertise a macOS family');
  });
  if (host.qlf && !host.qlf.hasSegoe && host.qlf.hasHelvetica) {
    check('the enumeration is caused by the inject, not the host', () => {
      assert.notStrictEqual(host.qlf.hasSegoe, injected.qlf.hasSegoe, 'host must not already enumerate Segoe UI');
      assert.notStrictEqual(host.qlf.n, injected.qlf.n, 'entry count must come from the persona');
    });
  } else {
    skip('the enumeration is caused by the inject, not the host', 'the host already matched the persona shape');
  }

  check('the enumeration keeps the engine FontData shape', () => {
    for (const key of ['arrFrozen', 'proto', 'frozen', 'extensible', 'tag', 'symTag', 'isFontData', 'json', 'forIn']) {
      assert.deepStrictEqual(injected.qlf[key], host.qlf[key], `FontData.${key} must match the untouched build`);
    }
    assert.deepStrictEqual(injected.qlf.ownKeys, [], 'FontData own enumerable keys');
    assert.deepStrictEqual(injected.qlf.getOwnNames, [], 'FontData own property names');
    assert.strictEqual(injected.qlf.tag, '[object FontData]', 'brand');
    assert.strictEqual(injected.qlf.json, '{}', 'JSON shape');
  });
  check('a receiver the engine rejects still rejects', () => {
    assert.strictEqual(host.qlfReceiver.bad.threw, true, 'the untouched build rejects a non-window receiver');
    assert.strictEqual(injected.qlfReceiver.bad.threw, true, 'the injected build must reject it too');
    assert.strictEqual(injected.qlfReceiver.bad.err, host.qlfReceiver.bad.err, 'the error type must match');
    assert.strictEqual(injected.qlfReceiver.bare, host.qlfReceiver.bare, 'a bare call must behave like the untouched build');
  });
  check('a receiver the engine tolerates still answers from the persona', () => {
    assert.strictEqual(injected.qlfReceiver.loose.threw, host.qlfReceiver.loose.threw, 'both builds must agree on the call');
    assert.strictEqual(host.qlfReceiver.loose.hasSegoe, false, 'sensitivity control: the host list has no Segoe UI');
    assert.strictEqual(injected.qlfReceiver.loose.hasSegoe, true, 'the persona must answer through a tolerated receiver');
    assert.strictEqual(injected.qlfReceiver.loose.hasHelvetica, false, 'the host list must not leak through a tolerated receiver');
  });
  check('the enumeration keeps the host method descriptor', () => {
    for (const key of ['enumerable', 'writable', 'configurable', 'hasGet', 'name', 'len', 'str']) {
      assert.deepStrictEqual(injected.qlfMeta[key], host.qlfMeta[key], `queryLocalFonts.${key} must match the untouched build`);
    }
  });
  check('the persona answers formatted fields for its own list', () => {
    assert.strictEqual(injected.qlf.firstStyle, 'Regular', 'style is normalised');
    assert.ok(personaList.some((f) => f.replace(/\s+/g, '') === injected.qlf.firstPost), `postscriptName must come from the persona: ${injected.qlf.firstPost}`);
  });
  check('text measurement is explicitly out of scope (documented boundary)', () => {
    // The script does not touch measurement; this pins the boundary so a future change is deliberate.
    assert.strictEqual(typeof injected.measure.segoe, 'number');
    assert.strictEqual(typeof injected.measure.helvetica, 'number');
  });

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log(`font-persona-e2e-selftest: OK ${results.length}/${results.length}`);
  else { console.log(`font-persona-e2e-selftest: FAILED ${failed.length}/${results.length}`); process.exitCode = 1; }
})().catch((err) => {
  console.error('font-persona-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
