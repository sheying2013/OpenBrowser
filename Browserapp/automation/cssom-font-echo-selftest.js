#!/usr/bin/env node
'use strict';

/**
 * CSSOM echo fidelity selftest.
 *
 * Verifies that getters for style.textContent, style.innerHTML, style.innerText,
 * CSSRule.prototype.cssText, CSSStyleDeclaration.prototype.cssText, and
 * getPropertyValue('src') return the caller's original unmodified input and never
 * leak/echo the internal LocalFontFallback<24hex> placeholder.
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

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
};
const skip = (name, why) => {
  results.push({ name, ok: true });
  console.log(`  SKIP  ${name}${why ? ' - ' + why : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 kernel launcher available');
    console.log(`cssom-font-echo-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head></head><body>Echo Test</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const profile = {
    id: 'echo-test',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    privacy: { deviceProfile: 'persona' },
  };
  const fp = buildFingerprint(profile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-echo-unit-'));
  await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, 'init_template.json') });

  const child = spawn(launcher, [dir, '--headless=new'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });

  let devToolsPort = null;
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    try {
      devToolsPort = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (devToolsPort > 0) break;
    } catch (_) {}
  }
  if (!devToolsPort) throw new Error('DevToolsActivePort not acquired');

  const list = await (await fetch(`http://127.0.0.1:${devToolsPort}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });

  let seq = 0;
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    const h = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === id) { ws.removeEventListener('message', h); res(m.result || m.error); }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectionScript(fp) });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await sleep(1000);

  const evalRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const originalCss = '@font-face { font-family: "test_alias"; src: local("Helvetica Neue"); }';
      const style = document.createElement('style');
      style.textContent = originalCss;
      document.head.appendChild(style);

      const tc = style.textContent;
      const ih = style.innerHTML;

      const style2 = document.createElement('style');
      style2.innerHTML = originalCss;
      document.head.appendChild(style2);
      const ih2 = style2.innerHTML;

      const style3 = document.createElement('style');
      style3.innerText = originalCss;
      document.head.appendChild(style3);
      const it3 = style3.innerText;

      const sheet = new CSSStyleSheet();
      sheet.insertRule(originalCss, 0);
      const ruleText = sheet.cssRules[0].cssText;
      const ruleStyleCss = sheet.cssRules[0].style.cssText;

      const dummyDiv = document.createElement('div');
      dummyDiv.style.setProperty('src', 'local("Helvetica Neue")');
      const getPropSrc = dummyDiv.style.getPropertyValue('src');

      return {
        tc,
        ih,
        ih2,
        it3,
        ruleText,
        ruleStyleCss,
        getPropSrc,
        tcHasFallback: tc.includes('LocalFontFallback'),
        ihHasFallback: ih.includes('LocalFontFallback'),
        ih2HasFallback: ih2.includes('LocalFontFallback'),
        it3HasFallback: it3.includes('LocalFontFallback'),
        ruleHasFallback: ruleText.includes('LocalFontFallback'),
        ruleStyleHasFallback: ruleStyleCss.includes('LocalFontFallback'),
        propHasFallback: getPropSrc.includes('LocalFontFallback'),
      };
    })()`,
    returnByValue: true,
  });

  const data = evalRes?.result?.value;

  check('style.textContent returns original CSS without LocalFontFallback', () => {
    assert.strictEqual(data.tcHasFallback, false);
    assert.ok(data.tc.includes('Helvetica Neue'));
  });

  check('style.innerHTML returns original CSS without LocalFontFallback', () => {
    assert.strictEqual(data.ihHasFallback, false);
    assert.strictEqual(data.ih2HasFallback, false);
    assert.ok(data.ih.includes('Helvetica Neue'));
  });

  check('style.innerText returns original CSS without LocalFontFallback', () => {
    assert.strictEqual(data.it3HasFallback, false);
    assert.ok(data.it3.includes('Helvetica Neue'));
  });

  check('CSSRule.prototype.cssText returns original rule text without LocalFontFallback', () => {
    assert.strictEqual(data.ruleHasFallback, false);
    assert.ok(data.ruleText.includes('Helvetica Neue'));
  });

  check('CSSStyleDeclaration.prototype.cssText returns original text without LocalFontFallback', () => {
    assert.strictEqual(data.ruleStyleHasFallback, false);
    assert.ok(data.ruleStyleCss.includes('Helvetica Neue'));
  });

  check('CSSStyleDeclaration.prototype.getPropertyValue returns original value without LocalFontFallback', () => {
    assert.strictEqual(data.propHasFallback, false);
    assert.ok(data.getPropSrc.includes('Helvetica Neue'));
  });

  ws.close();
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) {
    console.log(`\ncssom-font-echo-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`\ncssom-font-echo-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('cssom-font-echo-selftest crashed:', err);
  process.exitCode = 1;
});
