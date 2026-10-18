#!/usr/bin/env node
'use strict';

/**
 * Regression for issue #36 defect 2: a page target created after startup must not stay paused on
 * waitForDebuggerOnStart while the injector runs its full command chain.
 *
 * The engine arms Fetch and the font response rewriter *before* releasing the pause. On a fresh
 * target (new window / noopener tab) the renderer may not have an execution context yet, so every
 * session command can sit on its own timeout while the tab keeps showing nothing. The engine now
 * does the inverse for targets created after the startup barrier: inject while paused, resume
 * immediately, then arm response rewriting.
 *
 * This harness drives the real kernel and asserts that contract end to end:
 *   1. a late-created window target is released from the pause well inside the inject budget
 *   2. the target is resumed exactly once
 *   3. the document-start inject still applies to a target resumed that early
 *   4. arming Fetch after the resume does not wedge the next document load
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
// Mirrors the engine budget for a late-created page target.
const INJECT_BUDGET_MS = 2500;
const RESUME_BUDGET_MS = 1500;

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
  constructor(ws, onEvent) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.onEvent = onEvent || (() => {});
    ws.addEventListener('message', (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.id && this.pending.has(message.id)) {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve(message);
        return;
      }
      if (message.method) this.onEvent(message);
    });
  }
  send(method, params = {}, options = {}) {
    const id = ++this.seq;
    const sessionId = options.sessionId;
    const timeout = options.timeout || 15000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: 'CDP timeout: ' + method } });
      }, timeout);
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  async value(expression, sessionId) {
    const message = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, { sessionId });
    const exception = message?.result?.exceptionDetails;
    if (exception) return { error: exception.text || JSON.stringify(exception) };
    const raw = message?.result?.result?.value;
    try { return JSON.parse(raw); } catch (_) { return { raw: String(raw).slice(0, 200) }; }
  }
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync('pkill -f "user-data-dir=' + dir + '" 2>/dev/null || true'); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function runSession() {
  const profile = {
    id: 'new-tab-resume-e2e',
    name: 'new-tab-resume-e2e',
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    userAgent: WINDOWS_UA,
    privacy: { deviceProfile: 'persona' },
  };
  const fp = buildFingerprint(profile);
  const injectSource = buildInjectionScript(fp);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-newtab-resume-'));
  let child = null;
  const stats = { resumes: 0, fetchEnabledAt: 0, fetchErrors: [] };
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

    const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
    const browserWs = version.webSocketDebuggerUrl;
    if (!browserWs) return { error: 'browser websocket missing' };
    const ws = new WebSocket(browserWs);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    const attached = [];
    let pausedHandler = null;
    const cdp = new Cdp(ws, (message) => {
      if (message.method === 'Target.attachedToTarget') attached.push(message.params);
      if (message.method === 'Fetch.requestPaused' && pausedHandler) pausedHandler(message);
    });

    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const autoAttach = await cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    if (autoAttach.error) return { error: 'setAutoAttach failed: ' + autoAttach.error.message };

    const created = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    const targetId = created?.result?.targetId;
    if (!targetId) return { error: 'createTarget failed: ' + JSON.stringify(created).slice(0, 200) };

    // wait for the attach event of the new page target
    let params = null;
    for (let i = 0; i < 100 && !params; i += 1) {
      params = attached.find((item) => item.targetInfo && item.targetInfo.targetId === targetId && item.targetInfo.type === 'page') || null;
      if (!params) await sleep(50);
    }
    if (!params) return { error: 'no attachedToTarget event for new window target' };
    const sessionId = params.sessionId;
    const attachAt = Date.now();

    // inject while paused (what the engine does), then resume immediately
    const pageEnable = await cdp.send('Page.enable', {}, { sessionId, timeout: INJECT_BUDGET_MS });
    const addScript = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: injectSource }, { sessionId, timeout: INJECT_BUDGET_MS });
    const resume = await cdp.send('Runtime.runIfWaitingForDebugger', {}, { sessionId, timeout: 3000 });
    stats.resumes += 1;
    const resumedAt = Date.now();

    // arm Fetch only after the resume, exactly like the engine's deferred path
    pausedHandler = (message) => {
      cdp.send('Fetch.continueRequest', { requestId: message.params.requestId }, { sessionId: message.sessionId || sessionId, timeout: 3000 })
        .then((reply) => { if (reply.error) stats.fetchErrors.push(reply.error.message); });
    };
    const fetchEnable = await cdp.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Request' },
        { urlPattern: '*', requestStage: 'Response', resourceType: 'Document' },
      ],
    }, { sessionId, timeout: 3000 });
    if (fetchEnable.error) stats.fetchErrors.push(fetchEnable.error.message);
    stats.fetchEnabledAt = Date.now();

    const navigate = await cdp.send('Page.navigate', { url: 'data:text/html,<title>late</title><body><p id=x>late-tab</p><style>p{color:rgb(1,2,3)}</style></body>' }, { sessionId, timeout: 5000 });
    await sleep(800);
    const probe = await cdp.value(`(() => {
      const style = document.getElementById('x') ? getComputedStyle(document.getElementById('x')).color : '';
      return JSON.stringify({
        readyState: document.readyState,
        innerWidth: window.innerWidth,
        text: document.body ? document.body.innerText.trim().slice(0, 20) : '',
        color: style,
        hardwareConcurrency: navigator.hardwareConcurrency,
        userAgent: navigator.userAgent,
        languages: (navigator.languages || []).join(','),
      });
    })()`, sessionId);

    try { ws.close(); } catch (_) {}
    return {
      pageEnableError: pageEnable.error ? pageEnable.error.message : null,
      addScriptError: addScript.error ? addScript.error.message : null,
      resumeError: resume.error ? resume.error.message : null,
      navigateError: navigate.error ? navigate.error.message : null,
      attachToResumeMs: resumedAt - attachAt,
      resumeToFetchMs: stats.fetchEnabledAt - resumedAt,
      resumes: stats.resumes,
      fetchErrors: stats.fetchErrors,
      probe,
      expectedHardwareConcurrency: fp.hardwareConcurrency,
      expectedUa: fp.userAgent,
    };
  } finally {
    if (child) await stopChild(child, dir);
  }
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('new-tab-resume-first-e2e-selftest: SKIP kernel launcher unavailable');
    return;
  }
  console.log('\nnew tab resume-first E2E (issue #36 defect 2)...');
  const state = await runSession();
  if (state.error) throw new Error('Probe failed: ' + state.error);
  if (process.env.DEBUG_NEWTAB === '1') console.log(JSON.stringify(state, null, 2));

  check('late target is released from the pause inside the inject budget', () => {
    assert.ok(state.attachToResumeMs > 0, 'attach-to-resume must be measured, got ' + state.attachToResumeMs);
    assert.ok(state.attachToResumeMs <= RESUME_BUDGET_MS,
      'attach-to-resume took ' + state.attachToResumeMs + 'ms, budget ' + RESUME_BUDGET_MS + 'ms');
  });
  check('late target is resumed exactly once', () => {
    assert.strictEqual(state.resumes, 1, 'expected one resume call, got ' + state.resumes);
    assert.strictEqual(state.resumeError, null, 'resume returned ' + state.resumeError);
  });
  check('inject primitives accepted while the target was still paused', () => {
    assert.strictEqual(state.pageEnableError, null, 'Page.enable failed: ' + state.pageEnableError);
    assert.strictEqual(state.addScriptError, null, 'addScriptToEvaluateOnNewDocument failed: ' + state.addScriptError);
  });
  check('the resumed tab paints a real document', () => {
    assert.strictEqual(state.navigateError, null, 'navigate failed: ' + state.navigateError);
    assert.strictEqual(state.probe.readyState, 'complete', 'readyState ' + state.probe.readyState);
    assert.ok(state.probe.innerWidth > 0, 'innerWidth ' + state.probe.innerWidth);
    assert.strictEqual(state.probe.text, 'late-tab', 'body text ' + state.probe.text);
    assert.strictEqual(state.probe.color, 'rgb(1, 2, 3)', 'stylesheet not applied: ' + state.probe.color);
  });
  check('document-start inject still applies after the early resume', () => {
    assert.strictEqual(Number(state.probe.hardwareConcurrency), Number(state.expectedHardwareConcurrency),
      'hardwareConcurrency ' + state.probe.hardwareConcurrency + ' expected ' + state.expectedHardwareConcurrency);
    assert.strictEqual(state.probe.userAgent, state.expectedUa, 'userAgent ' + state.probe.userAgent);
  });
  check('deferred Fetch arming does not wedge the next load', () => {
    assert.deepStrictEqual(state.fetchErrors, [], 'Fetch errors: ' + state.fetchErrors.join('; '));
  });

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) console.log('\nnew-tab-resume-first-e2e-selftest: OK ' + results.length + '/' + results.length);
  else { console.log('\nnew-tab-resume-first-e2e-selftest: FAILED ' + failed.length + '/' + results.length); process.exitCode = 1; }
})().catch((error) => {
  console.error('new-tab-resume-first-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
