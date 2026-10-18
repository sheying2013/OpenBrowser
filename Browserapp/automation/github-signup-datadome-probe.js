#!/usr/bin/env node
'use strict';
// Diagnostic only (not part of the committed suite): open github.com/signup in the real kernel
// with the document-start inject active and report what the page actually exposes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { buildFingerprint, buildInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const kernelRoot = path.join(__dirname, '..', 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = '(function(){'
  + 'var uad = navigator.userAgentData ? {brands: navigator.userAgentData.brands, platform: navigator.userAgentData.platform, mobile: navigator.userAgentData.mobile} : null;'
  + 'var text = ((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").slice(0, 400);'
  + 'return JSON.stringify({'
  + 'title: document.title, url: location.href, readyState: document.readyState,'
  + 'hasEmailInput: !!document.querySelector("input[name=email], #email"), formCount: document.forms.length,'
  + 'headings: Array.from(document.querySelectorAll("h1,h2")).map(function(n){return n.innerText.trim();}).slice(0,4),'
  + 'textSample: text, webdriver: navigator.webdriver, chromeObj: typeof window.chrome,'
  + 'plugins: navigator.plugins.length, languages: navigator.languages.join(","), platform: navigator.platform,'
  + 'ua: navigator.userAgent, uad: uad, outerW: window.outerWidth, outerH: window.outerHeight,'
  + 'innerW: window.innerWidth, innerH: window.innerHeight,'
  + 'tz: Intl.DateTimeFormat().resolvedOptions().timeZone, hc: navigator.hardwareConcurrency, dm: navigator.deviceMemory,'
  + 'notif: (typeof Notification !== "undefined") ? Notification.permission : "n/a"'
  + '});'
  + '})()';

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (e) => {
      let m = null; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) { const r = this.pending.get(m.id); this.pending.delete(m.id); r(m); return; }
      if (m.method) this.events.push(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pending.delete(id); resolve({ error: { message: 'timeout ' + method } }); }, 30000);
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      const p = { id, method, params }; if (sessionId) p.sessionId = sessionId;
      this.ws.send(JSON.stringify(p));
    });
  }
  async value(expr, sessionId) {
    const m = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (m && m.result && m.result.exceptionDetails) return { error: m.result.exceptionDetails.text };
    const raw = m && m.result && m.result.result ? m.result.result.value : null;
    try { return JSON.parse(raw); } catch (_) { return { raw: String(raw).slice(0, 300) }; }
  }
}

(async () => {
  const profile = { id: 'gh-diag', name: 'gh-diag', kernelVersion: '148.0.7778.165', os: 'macOS', privacy: { deviceProfile: 'real' } };
  const fp = buildFingerprint(profile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-ghdiag-'));
  let child = null;
  try {
    await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, 'init_template.json') });
    const launchArgs = process.env.HEADFUL === '1' ? [dir] : [dir, '--headless=new'];
    child = spawn(launcher, launchArgs, { cwd: kernelRoot, detached: true, stdio: 'ignore' });
    let port = 0;
    for (let i = 0; i < 80; i += 1) {
      await sleep(100);
      try { const v = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10); if (v > 0) { port = v; break; } } catch (_) {}
    }
    if (!port) throw new Error('no port');
    const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const created = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    const targetId = created.result.targetId;
    let sessionId = null;
    for (let i = 0; i < 60 && !sessionId; i += 1) {
      const ev = cdp.events.find((m) => m.method === 'Target.attachedToTarget' && m.params.targetInfo.targetId === targetId);
      if (ev) sessionId = ev.params.sessionId; else await sleep(100);
    }
    if (!sessionId) throw new Error('no session');
    const skipEnable = process.env.SKIP_ENABLE === '1';
    const enableReport = {};
    if (!skipEnable) {
      enableReport.page = (await cdp.send('Page.enable', {}, sessionId)).error ? 'error' : 'ok';
      enableReport.runtime = (await cdp.send('Runtime.enable', {}, sessionId)).error ? 'error' : 'ok';
    }
    if (process.env.SKIP_INJECT === '1') {
      enableReport.addScript = 'skipped';
    } else {
      const addScript = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectionScript(fp) }, sessionId);
      enableReport.addScript = addScript.error ? addScript.error.message : 'ok';
    }
    await cdp.send('Network.enable', {}, sessionId);
    const targets = ['https://github.com/signup'];
    const walk = [];
    for (const url of targets) {
      cdp.events.length = 0;
      const navOne = await cdp.send('Page.navigate', { url }, sessionId);
      await sleep(6000);
      const one = await cdp.value(PROBE, sessionId);
      const extra = await cdp.value('(function(){var root=document.documentElement;var html=root?root.outerHTML:"";return JSON.stringify({htmlLen: html.length, head: html.slice(0,300), iframes: Array.from(document.querySelectorAll("iframe")).map(function(f){return String(f.src).slice(0,120);}), scripts: Array.from(document.querySelectorAll("script[src]")).map(function(s){return String(s.src).slice(0,100);}).slice(0,8), bodyBg: document.body ? getComputedStyle(document.body).backgroundColor : "none"});})()', sessionId);
      one.extra = extra;
      const docs = cdp.events.filter((m) => m.method === 'Network.responseReceived' && m.params.type === 'Document')
        .map((m) => ({ status: m.params.response.status, mime: m.params.response.mimeType, url: m.params.response.url.slice(0, 60) }));
      walk.push({ url, navError: (navOne && navOne.result && navOne.result.errorText) || 'ok', probe: one, docs });
    }
    const nav = { result: { errorText: 'walk' } };
    const probe = walk;
    const consoleErrors = cdp.events.filter((m) => m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error').slice(0, 5)
      .map((m) => (m.params.args || []).map((a) => a.value || a.description || a.type).join(' ').slice(0, 160));
    const failures = cdp.events.filter((m) => m.method === 'Network.loadingFailed').slice(0, 10)
      .map((m) => String(m.params.errorText) + ' ' + String(m.params.blockedReason || ''));
    console.log(JSON.stringify({ enableReport, navError: (nav && nav.result && nav.result.errorText) || 'ok', probe, consoleErrors, failures }, null, 2));
    try { ws.close(); } catch (_) {}
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync('pkill -f "user-data-dir=' + dir + '" 2>/dev/null || true'); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((e) => { console.error('crashed', e && e.stack); process.exit(1); });