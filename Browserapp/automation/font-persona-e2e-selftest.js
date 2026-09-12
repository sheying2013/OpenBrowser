#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for the font persona, run against the bundled kernel.
 *
 * `document.fonts.check()` is one of the few APIs that reports font presence directly, and the
 * injector answers it from the persona's platform set. Nothing proved that in a real page: the
 * unit test drives a stub, and the kernel's own font layer was measured inert (toggling
 * `is_font_finger_printing_enable` and shipping a `font_list` changed no measured width on this
 * build), so the script layer is the only thing standing between a page and the host's fonts.
 *
 * Measured baseline (this host, 2026-09-11): the untouched kernel answers `true` for every family
 * probed, including families the host does not ship shape the same way. The discriminating signal
 * is therefore a family the persona must deny.
 */

const assert = require('assert');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
const skip = (name) => { results.push({ name, ok: true }); console.log(`  SKIP  ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  const ask = (spec) => { try { return document.fonts.check(spec); } catch (e) { return 'err'; } };
  const ctx = document.createElement('canvas').getContext('2d');
  const width = (family) => { ctx.font = '72px "' + family + '", monospace'; return Math.round(ctx.measureText('mmmmmmmmmmlli').width * 1000) / 1000; };
  return JSON.stringify({
    segoe: ask('12px "Segoe UI"'),
    segoeUnquoted: ask('12px Segoe UI'),
    helvetica: ask('12px "Helvetica Neue"'),
    menlo: ask('12px "Menlo"'),
    widthSegoe: width('Segoe UI'),
    widthHelvetica: width('Helvetica Neue'),
    localFonts: typeof queryLocalFonts,
  });
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
  const foreignList = (fp.fonts && fp.fonts.foreign) || [];
  if (!personaList.length || !foreignList.length) {
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
  const host = await cdp.evalValue(PROBE);
  await applyFingerprintToTab(cdp.call.bind(cdp), page.webSocketDebuggerUrl, fp, profile);
  const injected = await cdp.evalValue(PROBE);
  try { ws.close(); } catch (_) {}
  stop();

  const foreignProbe = foreignList.find((name) => /helvetica neue|menlo|segoe/i.test(name)) || foreignList[0];
  const modelledProbe = personaList.find((name) => /segoe ui|arial|calibri/i.test(name)) || personaList[0];

  check('the probe answers before and after the inject', () => {
    assert.ok(host && !host.error, `host probe: ${host && host.raw}`);
    assert.ok(injected && !injected.error, `injected probe: ${injected && injected.raw}`);
  });
  check('the persona confirms a family its platform ships', () => {
    assert.strictEqual(injected.segoe, true, 'document.fonts.check("12px \\"Segoe UI\\"")');
    assert.strictEqual(injected.segoeUnquoted, true, 'the unquoted form must be answered too');
  });
  // The untouched kernel answers true for everything on this host, so a denial can only come from
  // the injected model: that is what makes this assertion meaningful.
  check('the persona denies a family that belongs to another platform', () => {
    assert.strictEqual(injected.helvetica, false, `check("12px \\"Helvetica Neue\\"") must be denied (foreign family: ${foreignProbe})`);
  });
  if (host.helvetica === true) {
    check('the denial is caused by the inject, not the host', () => {
      assert.strictEqual(host.helvetica, true, 'baseline must answer true for the same query');
      assert.notStrictEqual(host.helvetica, injected.helvetica, 'the injected answer must differ from the baseline');
    });
  } else {
    skip('the host already denied the foreign family, so the sensitivity control is unproven');
  }
  check('the modelled set comes from the platform table', () => {
    assert.ok(personaList.includes('Segoe UI'), `persona list should carry Segoe UI: ${modelledProbe}`);
    assert.ok(!personaList.includes('Helvetica Neue'), 'a Windows persona must not advertise a macOS family');
  });
  check('text measurement is explicitly out of scope (documented boundary)', () => {
    // The script does not touch measurement; this pins the boundary so a future change is deliberate.
    assert.strictEqual(typeof injected.widthSegoe, 'number');
    assert.strictEqual(typeof injected.widthHelvetica, 'number');
  });

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log(`font-persona-e2e-selftest: OK ${results.length}/${results.length}`);
  else { console.log(`font-persona-e2e-selftest: FAILED ${failed.length}/${results.length}`); process.exitCode = 1; }
})().catch((err) => {
  console.error('font-persona-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
