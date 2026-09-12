#!/usr/bin/env node
'use strict';

/**
 * Real-kernel guard for native input forwarding.
 *
 * This test proves that the synchronization input path produces the same
 * trusted beforeinput/input/change chain as a real user typing. It also keeps a
 * JavaScript-created event as a sensitivity control so an accidentally
 * synthetic implementation cannot pass unnoticed.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildFingerprint } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const { applyTrustedChange, applyTrustedInput } = require('./trusted-input');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${error.message}`); process.exitCode = 1; }
};
const skip = (name, why) => { results.push({ name, ok: true }); console.log(`  SKIP  ${name}${why ? ' — ' + why : ''}`); };
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
  call(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: { message: 'timeout ' + method } }); }, 15000);
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async value(expression) {
    const message = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const exception = message?.result?.exceptionDetails;
    if (exception) return { error: exception.text || String(exception) };
    return message?.result?.result?.value;
  }
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
}

async function waitForPage(port, timeoutMs = 16000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = (list || []).find((item) => item.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch (_) {}
    await sleep(300);
  }
  return null;
}

function pageSource() {
  return `<!doctype html><meta charset="utf-8"><title>trusted-input</title>
<input id="text" autocomplete="off">
<div id="edit" contenteditable="true">seed</div>
<select id="select"><option value="a">a</option><option value="b">b</option><option value="c">c</option></select>
<script>
window.__events = [];
for (const type of ['beforeinput','input','change','keydown','keyup','mousedown','mouseup','click']) {
  document.addEventListener(type, (event) => {
    window.__events.push({ type: event.type, trusted: event.isTrusted, id: event.target && event.target.id || '', value: event.target && 'value' in event.target ? String(event.target.value) : '' });
  }, true);
}
window.__synthetic = () => {
  const event = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' });
  document.getElementById('text').dispatchEvent(event);
  return { trusted: event.isTrusted };
};
</script>`;
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 148 kernel launcher available');
    console.log(`trusted-input-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(pageSource());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-trusted-input-'));
  const profile = {
    id: 'trusted-input-e2e',
    name: 'trusted-input-e2e',
    kernelVersion: '148.0.7778.165',
    userAgent: WINDOWS_UA,
    privacy: {},
  };
  const fp = buildFingerprint(profile);
  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile,
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });
  const child = spawn(launcher, [dir, '--headless=new'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });
  child.unref();

  try {
    let port = null;
    for (let index = 0; index < 80; index += 1) {
      await sleep(350);
      try {
        const value = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
        if (value > 0) { port = value; break; }
      } catch (_) {}
    }
    if (!port) {
      skip('kernel exposed a CDP endpoint', 'no port');
    } else {
      const page = await waitForPage(port);
      if (!page) {
        skip('kernel exposed a page target', 'no page');
      } else {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP WebSocket connect failed')); });
        const cdp = new Cdp(ws);
        const call = cdp.call.bind(cdp);
        await cdp.call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
        await sleep(800);

        const synthetic = JSON.parse(await cdp.value('JSON.stringify(window.__synthetic())'));
        await cdp.value('window.__events.length = 0; true');

        const inputResult = await applyTrustedInput(call, { selector: '#text', tag: 'input', value: 'hello' });
        await sleep(150);
        const inputState = JSON.parse(await cdp.value('JSON.stringify({ value: document.getElementById("text").value, events: window.__events.splice(0) })'));

        const changeResult = await applyTrustedChange(call, { selector: '#text', tag: 'input', value: 'world' });
        await sleep(150);
        const changeState = JSON.parse(await cdp.value('JSON.stringify({ value: document.getElementById("text").value, events: window.__events.splice(0) })'));

        const selectResult = await applyTrustedChange(call, { selector: '#select', value: 'c', selectedIndex: 2 });
        await sleep(150);
        const selectState = JSON.parse(await cdp.value('JSON.stringify({ value: document.getElementById("select").value, events: window.__events.splice(0) })'));

        const contentResult = await applyTrustedInput(call, { selector: '#edit', value: 'content' });
        await sleep(150);
        const contentState = JSON.parse(await cdp.value('JSON.stringify({ value: document.getElementById("edit").textContent, events: window.__events.splice(0) })'));

        try { ws.close(); } catch (_) {}

        check('JavaScript-created input events remain untrusted (sensitivity control)', () => {
          assert.strictEqual(synthetic.trusted, false, 'synthetic control must be false');
        });
        check('native insertText updates the field', () => {
          assert.strictEqual(inputResult.ok, true, `native input result: ${inputResult.reason}`);
          assert.strictEqual(inputResult.native, true, 'input must use native CDP input');
          assert.strictEqual(inputState.value, 'hello');
        });
        check('native insertText emits trusted beforeinput/input/change', () => {
          const trusted = (type) => inputState.events.some((event) => event.type === type && event.trusted === true);
          assert.ok(trusted('beforeinput'), 'beforeinput must be trusted');
          assert.ok(trusted('input'), 'input must be trusted');
          assert.ok(trusted('change'), 'change must be trusted after blur');
          assert.strictEqual(inputState.events.some((event) => event.trusted === false), false, 'native path must not add untrusted events');
        });
        check('trusted change path updates text and emits a trusted change', () => {
          assert.strictEqual(changeResult.ok, true, `change result: ${changeResult.reason}`);
          assert.strictEqual(changeState.value, 'world');
          assert.ok(changeState.events.some((event) => event.type === 'change' && event.trusted === true), 'change must be trusted');
        });
        check('contenteditable replacement uses native input and trusted events', () => {
          assert.strictEqual(contentResult.ok, true, `content result: ${contentResult.reason}`);
          assert.strictEqual(contentResult.native, true);
          assert.strictEqual(contentState.value, 'content');
          assert.ok(contentState.events.some((event) => event.type === 'beforeinput' && event.trusted === true));
          assert.ok(contentState.events.some((event) => event.type === 'input' && event.trusted === true));
          assert.strictEqual(contentState.events.some((event) => event.trusted === false), false);
        });
        check('select change preserves value and reports whether native selection worked', () => {
          assert.strictEqual(selectResult.ok, true, `select result: ${selectResult.reason}`);
          assert.strictEqual(selectState.value, 'c');
          assert.ok(selectState.events.some((event) => event.type === 'change'), 'select change event must be emitted');
          if (selectResult.native) assert.ok(selectState.events.some((event) => event.type === 'change' && event.trusted === true));
          else assert.ok(selectResult.fallback === true, 'non-native select path must be marked as fallback');
        });
      }
    }
  } finally {
    await stopChild(child, dir);
    await new Promise((resolve) => server.close(resolve));
  }

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) console.log(`trusted-input-e2e-selftest: OK ${results.length}/${results.length}`);
  else console.log(`trusted-input-e2e-selftest: FAILED ${failed.length}/${results.length}`);
})().catch((error) => {
  console.error('trusted-input-e2e-selftest: crashed', error.stack || error);
  process.exitCode = 1;
});
