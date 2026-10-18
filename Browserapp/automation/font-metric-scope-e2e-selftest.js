#!/usr/bin/env node
'use strict';

/**
 * Regression for issue #36 defect 1: font metric reads must not have intrusive side effects.
 *
 * The font shield wraps offsetWidth/clientHeight/getBoundingClientRect and temporarily forces a
 * clean font-family on every ancestor that resolves to a foreign family. The first implementation
 * called getComputedStyle() on every ancestor for every single read, so a page polling layout
 * forced a full style recalculation each time (reported: 74% of samples inside checkNode, 800
 * style changes for 600 reads, frozen tabs).
 *
 * This harness drives the real injected document-start script in the real kernel and asserts:
 *   1. a repeated read of an element with a clean ancestor chain performs no getComputedStyle call
 *   2. a repeated read of an element with a foreign-font ancestor performs no getComputedStyle call
 *   3. the shield still rewrites the metric to the fallback font for the foreign ancestor
 *   4. reads leave no font-family residue on the DOM
 *   5. getBoundingClientRect follows the same cached path
 *   6. 500 cached reads stay far below the cost of 500 forced style recalculations
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildFingerprint, buildInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log('  PASS  ' + name);
  } catch (error) {
    results.push({ name, ok: false });
    console.log('  FAIL  ' + name + ' - ' + error.message);
    process.exitCode = 1;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: 'CDP timeout: ' + method } });
      }, 30000);
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  call(method, params = {}) { return this.send(method, params); }
  async value(expression) {
    const message = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const exception = message?.result?.exceptionDetails;
    if (exception) return { error: exception.text || JSON.stringify(exception) };
    const raw = message?.result?.result?.value;
    try { return JSON.parse(raw); } catch (_) { return { error: 'probe parse', raw: String(raw).slice(0, 240) }; }
  }
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync('pkill -f "user-data-dir=' + dir + '" 2>/dev/null || true'); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function waitForPage(port, timeoutMs = 16000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = (list || []).find((item) => item.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (_) {}
    await sleep(300);
  }
  return null;
}

function buildProbeScript(foreignFamily) {
  return `(async () => {
    const FOREIGN = ${JSON.stringify(foreignFamily)};
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await wait(50);

    const realGetComputedStyle = window.getComputedStyle.bind(window);
    let computedStyleCalls = 0;
    window.getComputedStyle = function (...args) {
      computedStyleCalls += 1;
      return realGetComputedStyle(...args);
    };

    const makeTree = (family) => {
      const wrap = document.createElement('div');
      wrap.id = 'ob-shield-' + Math.random().toString(36).slice(2);
      wrap.style.fontFamily = family;
      wrap.style.fontSize = '24px';
      const inner = document.createElement('span');
      inner.textContent = 'mmmmmmmmmmlliWWWW@@@@1234';
      wrap.appendChild(inner);
      document.body.appendChild(wrap);
      return { wrap, inner };
    };

    // clean chain: no foreign family anywhere
    const clean = makeTree('serif');
    // dirty chain: ancestor resolves to a family outside the persona font list
    // no fallback family on purpose: the shield then has to collapse to monospace, which is the
    // reference the assertion below compares against
    const dirty = makeTree('"' + FOREIGN + '"');
    await wait(50);

    const pulse = (element, api, times) => {
      let sink = 0;
      for (let i = 0; i < times; i += 1) {
        if (api === 'rect') sink += element.getBoundingClientRect().width;
        else sink += element.offsetWidth;
      }
      return sink;
    };

    // warm-up populates the verdict cache
    pulse(clean.inner, 'offsetWidth', 3);
    pulse(dirty.inner, 'offsetWidth', 3);
    pulse(clean.inner, 'rect', 3);
    pulse(dirty.inner, 'rect', 3);

    computedStyleCalls = 0;
    const cleanStart = performance.now();
    const cleanSink = pulse(clean.inner, 'offsetWidth', 500);
    const cleanMs = performance.now() - cleanStart;
    const cleanCalls = computedStyleCalls;

    computedStyleCalls = 0;
    const dirtyStart = performance.now();
    const dirtySink = pulse(dirty.inner, 'offsetWidth', 500);
    const dirtyMs = performance.now() - dirtyStart;
    const dirtyCalls = computedStyleCalls;

    computedStyleCalls = 0;
    pulse(dirty.inner, 'rect', 200);
    const rectCalls = computedStyleCalls;

    // the shield must still make a foreign-font ancestor measure like the fallback font
    await wait(20);
    const shieldedWidth = dirty.inner.offsetWidth;
    dirty.wrap.style.fontFamily = 'monospace';
    await wait(20);
    const monospaceWidth = dirty.inner.offsetWidth;
    dirty.wrap.style.fontFamily = '"' + FOREIGN + '"';
    await wait(20);

    // no residue: inline font-family and attribute text must survive untouched
    const dirtyInline = dirty.wrap.style.fontFamily;
    const dirtyAttr = dirty.wrap.getAttribute('style') || '';
    const cleanInline = clean.wrap.style.fontFamily;

    let mutations = 0;
    const observer = new MutationObserver((records) => { mutations += records.length; });
    observer.observe(dirty.wrap, { attributes: true, attributeFilter: ['style', 'font-family'] });
    pulse(dirty.inner, 'offsetWidth', 50);
    await wait(30);
    observer.disconnect();

    // For 5 fresh reads, capture the temporary family the shield installs while the metric is read.
    const seenFamilies = [];
    const wrapStyle = dirty.wrap.style;
    const nativeSetProperty = wrapStyle.setProperty.bind(wrapStyle);
    wrapStyle.setProperty = function (name, value, priority) {
      if (name === 'font-family') seenFamilies.push(String(value));
      return nativeSetProperty(name, value, priority);
    };
    pulse(dirty.inner, 'offsetWidth', 5);
    await wait(20);
    const computedFamily = getComputedStyle(dirty.wrap).fontFamily;

    return JSON.stringify({
      hasShield: typeof window.getComputedStyle === 'function',
      cleanCalls,
      dirtyCalls,
      rectCalls,
      cleanMs,
      dirtyMs,
      cleanSink,
      dirtySink,
      shieldedWidth,
      monospaceWidth,
      foreignFamily: FOREIGN,
      dirtyInline,
      dirtyAttr,
      cleanInline,
      mutations,
      marker: typeof window.__marker !== 'undefined' ? window.__marker : null,
      errors: (window.__obErrors || []).slice(0, 6),
      seenFamilies,
      computedFamily,
      foreignListLength: ${JSON.stringify(0)}
    });
  })()`;
}

async function runSession() {
  const profile = {
    id: 'font-metric-scope-e2e',
    name: 'font-metric-scope-e2e',
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    userAgent: WINDOWS_UA,
    privacy: { deviceProfile: 'persona' },
  };
  const fp = buildFingerprint(profile);
  // fp.fonts.foreign is exactly the set the document-start script treats as foreign (the fonts of
  // the emulated persona's *other* OS), so a member of it is guaranteed to take the shield path.
  const foreignList = ((fp.fonts && fp.fonts.foreign) || []).filter(Boolean);
  if (!foreignList.length) return { error: 'persona exposes no foreign font families' };
  const foreignFamily = String(foreignList[0]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-font-scope-e2e-'));
  let child = null;
  try {
    await writeOpenBrowserKernelInit(dir, {
      fingerprint: fp,
      profile,
      templatePath: path.join(kernelRoot, 'init_template.json'),
    });
    child = spawn(launcher, [dir, '--headless=new', '--enable-unsafe-swiftshader'], {
      cwd: kernelRoot,
      detached: true,
      stdio: 'ignore',
    });
    let port = 0;
    for (let i = 0; i < 80; i += 1) {
      await sleep(100);
      try {
        const value = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
        if (value > 0) { port = value; break; }
      } catch (_) {}
    }
    if (!port) return { error: 'DevToolsActivePort port not acquired' };
    const page = await waitForPage(port);
    if (!page?.webSocketDebuggerUrl) return { error: 'Target page not available' };
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);
    await cdp.call('Page.enable', {});
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__marker = true; window.__obErrors = []; window.addEventListener("error", function (e) { try { window.__obErrors.push(String((e && e.message) || e)); } catch (_) {} });',
    });
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectionScript(fp) });
    // A real document is required: the initial target is already about:blank, so navigating to
    // about:blank again is a same-document no-op and none of the new-document scripts ever run.
    await cdp.call('Page.navigate', { url: "data:text/html,<title>ob-probe</title><body><p>ob</p></body>" });
    await sleep(1200);
    const probe = await cdp.value(buildProbeScript(foreignFamily));
    try { ws.close(); } catch (_) {}
    return probe;
  } finally {
    if (child) await stopChild(child, dir);
  }
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('font-metric-scope-e2e-selftest: SKIP kernel launcher unavailable');
    return;
  }
  console.log('\nfont metric scope E2E (issue #36 defect 1)...');
  const probe = await runSession();
  if (probe.error) throw new Error('Probe failed: ' + probe.error);

  check('clean ancestor chain performs zero getComputedStyle calls on repeat reads', () => {
    assert.strictEqual(probe.cleanCalls, 0, 'expected 0 getComputedStyle calls, got ' + probe.cleanCalls);
  });
  check('foreign-font ancestor performs zero getComputedStyle calls on repeat reads', () => {
    assert.strictEqual(probe.dirtyCalls, 0, 'expected 0 getComputedStyle calls, got ' + probe.dirtyCalls);
  });
  check('getBoundingClientRect shares the cached verdict', () => {
    assert.strictEqual(probe.rectCalls, 0, 'expected 0 getComputedStyle calls, got ' + probe.rectCalls);
  });
  if (process.env.DEBUG_FONT_SCOPE === '1') {
    console.log(JSON.stringify(probe, null, 2));
  }
  check('foreign ancestor still measures as the fallback font (shield intact)', () => {
    assert.ok(probe.shieldedWidth > 0, 'shielded width must be positive');
    assert.strictEqual(probe.shieldedWidth, probe.monospaceWidth,
      'shielded width ' + probe.shieldedWidth + ' must equal monospace width ' + probe.monospaceWidth);
  });
  check('reads leave no font-family residue', () => {
    assert.ok(probe.dirtyInline.indexOf(probe.foreignFamily) !== -1, 'inline family must be restored, got ' + probe.dirtyInline);
    assert.ok(probe.dirtyAttr.indexOf('font-family') !== -1, 'style attribute must be preserved, got ' + probe.dirtyAttr);
    assert.strictEqual(probe.cleanInline, 'serif', 'clean chain inline family must be untouched');
  });
  check('500 cached reads stay under a forced-recalculation budget', () => {
    assert.ok(probe.cleanMs < 60, 'clean chain 500 reads took ' + probe.cleanMs.toFixed(1) + 'ms');
    assert.ok(probe.dirtyMs < 250, 'foreign chain 500 reads took ' + probe.dirtyMs.toFixed(1) + 'ms');
  });
  check('mutation count stays proportional to shielded reads only', () => {
    assert.ok(probe.mutations <= 120, 'expected at most 2 mutations per read, got ' + probe.mutations);
  });
  check('metric values are real numbers', () => {
    assert.ok(probe.cleanSink > 0 && probe.dirtySink > 0, 'metric reads must produce positive widths');
  });

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) console.log('\nfont-metric-scope-e2e-selftest: OK ' + results.length + '/' + results.length);
  else { console.log('\nfont-metric-scope-e2e-selftest: FAILED ' + failed.length + '/' + results.length); process.exitCode = 1; }
})().catch((error) => {
  console.error('font-metric-scope-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
