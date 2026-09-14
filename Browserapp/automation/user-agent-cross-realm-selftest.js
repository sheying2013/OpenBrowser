#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildFingerprint, buildInjectionScript } = require('./fingerprint');
const { buildUaProfile } = require('./user-agent');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const kernelRoot = path.join(__dirname, '..', 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m = null;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, timer } = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(timer);
        resolve(m);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: 'CDP timeout', method });
      }, 30000);
      this.pending.set(id, { resolve, timer });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ error: String(err) });
      }
    });
  }

  async eval(expression, sessionId) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    if (res?.result?.exceptionDetails) {
      return { __error: true, details: res.result.exceptionDetails };
    }
    return res?.result?.result?.value;
  }
}

async function runCrossRealmAudit() {
  console.log('========================================================================');
  console.log('  User-Agent Cross-Realm toString & TypeError Fidelity Selftest');
  console.log('========================================================================\n');

  const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
  const profileConfig = {
    id: 'selftest-cross-realm-persona',
    name: 'selftest-cross-realm-persona',
    kernelVersion: '148.0.7778.165',
    os: 'windows',
    userAgent: WINDOWS_UA,
    platform: 'Win32',
    canvas: 'noise',
    webgl: 'noise',
    cores: 8,
    memory: 8,
    privacy: {
      webrtc: 'proxy',
      timezone: 'America/New_York',
      languages: ['en-US', 'en'],
    }
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-cross-realm-'));
  const portFile = path.join(dir, 'DevToolsActivePort');

  const fp = buildFingerprint(profileConfig);
  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile: profileConfig,
    templatePath: path.join(kernelRoot, 'init_template.json')
  });

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>Cross-Realm Testbed</title></head><body><h1>Cross-Realm Testbed</h1></body></html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;

  const child = spawn(launcher, [dir, '--headless=new', '--disable-popup-blocking'], {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  let port = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const p = parseInt(fs.readFileSync(portFile, 'utf8').trim().split('\n')[0], 10);
      if (p > 0) { port = p; break; }
    } catch (_) {}
  }

  if (!port) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    srv.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    throw new Error('Failed to start Chromium: DevToolsActivePort not found');
  }

  let result = null;
  let ws = null;
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);

    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const targetId = created?.result?.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached?.result?.sessionId;

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: buildInjectionScript(fp)
    }, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    await sleep(1500);

    const PROBE_CODE = `(async () => {
      const out = {
        getters: {},
        subRealmErrors: {},
        navigatorValues: {}
      };

      const ifr = document.createElement('iframe');
      document.body.appendChild(ifr);
      const subWin = ifr.contentWindow;

      const targetProps = ['userAgent', 'platform', 'hardwareConcurrency', 'vendor'];
      for (const prop of targetProps) {
        const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, prop);
        const getter = desc ? desc.get : null;
        if (getter) {
          const parentToString = Function.prototype.toString.call(getter);
          const subToString = subWin.Function.prototype.toString.call(getter);
          const symbols = Object.getOwnPropertySymbols(getter);
          const names = Object.getOwnPropertyNames(getter);
          out.getters[prop] = {
            parentToString,
            subToString,
            symbolsCount: symbols.length,
            names,
            nameProp: getter.name,
            lengthProp: getter.length,
          };
        } else {
          out.getters[prop] = { missing: true };
        }
      }

      // Illegal receiver calls across realms
      const subObj = subWin.eval('({})');
      for (const prop of ['userAgent', 'platform']) {
        const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, prop);
        if (desc && desc.get) {
          try {
            desc.get.call(subObj);
            out.subRealmErrors[prop + '_onSubObj'] = { threw: false };
          } catch (e) {
            out.subRealmErrors[prop + '_onSubObj'] = {
              threw: true,
              name: e ? e.name : null,
              message: e ? e.message : null,
              instanceOfParentTypeError: e instanceof TypeError,
              instanceOfSubWinTypeError: e instanceof subWin.TypeError,
              stack: e ? e.stack : ''
            };
          }
        }
      }

      // Inside subWin eval on subWin's own Navigator.prototype
      try {
        const subEvalRes = subWin.eval(\`
          let caught = null;
          try {
            const d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
            if (d && d.get) d.get.call({});
          } catch (e) {
            caught = e;
          }
          ({
            threw: Boolean(caught),
            name: caught ? caught.name : null,
            isSubWinTypeError: caught instanceof TypeError,
            isTopTypeError: typeof window.top !== 'undefined' && caught instanceof window.top.TypeError,
          })
        \`);
        out.subRealmErrors.subWinInternalCall = subEvalRes;
      } catch (err) {
        out.subRealmErrors.subWinInternalCall = { error: err.message };
      }

      out.navigatorValues = {
        parentUserAgent: navigator.userAgent,
        subUserAgent: subWin.navigator.userAgent,
        parentPlatform: navigator.platform,
        subPlatform: subWin.navigator.platform,
        parentVendor: navigator.vendor,
        subVendor: subWin.navigator.vendor,
      };

      return out;
    })()`;

    result = await cdp.eval(PROBE_CODE, sessionId);
    await cdp.send('Target.closeTarget', { targetId });
  } finally {
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    srv.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  return { result, WINDOWS_UA };
}

(async () => {
  const testResults = [];
  const check = (desc, fn) => {
    try {
      fn();
      testResults.push({ desc, pass: true });
      console.log(`  PASS  ${desc}`);
    } catch (e) {
      testResults.push({ desc, pass: false, error: e.message });
      console.log(`  FAIL  ${desc}: ${e.message}`);
    }
  };

  const { result, WINDOWS_UA } = await runCrossRealmAudit();
  assert.ok(result, 'Result must not be null');

  console.log('\n--- Asserting Cross-Realm Function Shapes ---');

  const nativePattern = /^function get [A-Za-z]+\(\) \{ \[native code\] \}$/;

  for (const prop of ['userAgent', 'platform', 'hardwareConcurrency', 'vendor']) {
    const data = result.getters[prop];
    assert.ok(data, `Data for ${prop} must exist`);

    check(`${prop} getter subToString matches native code pattern`, () => {
      assert.match(data.subToString, nativePattern, `${prop} subToString must match native code pattern, got: ${data.subToString}`);
    });

    check(`${prop} getter subToString does NOT leak wrapper code (isNav / [key] / stripStackFrame)`, () => {
      assert.ok(!data.subToString.includes('isNav'), `${prop} must not contain 'isNav'`);
      assert.ok(!data.subToString.includes('[key]'), `${prop} must not contain '[key]'`);
      assert.ok(!data.subToString.includes('stripStackFrame'), `${prop} must not contain 'stripStackFrame'`);
    });

    check(`${prop} getter has zero symbol properties (Object.getOwnPropertySymbols === 0)`, () => {
      assert.strictEqual(data.symbolsCount, 0, `${prop} must have 0 symbols`);
    });

    check(`${prop} getter name matches 'get ${prop}'`, () => {
      assert.strictEqual(data.nameProp, 'get ' + prop);
    });

    check(`${prop} getter length is 0`, () => {
      assert.strictEqual(data.lengthProp, 0);
    });
  }

  console.log('\n--- Asserting Cross-Realm TypeError Construction ---');

  check('userAgent getter called on sub-realm receiver throws subWin.TypeError', () => {
    const err = result.subRealmErrors.userAgent_onSubObj;
    assert.ok(err && err.threw, 'Must throw');
    assert.strictEqual(err.name, 'TypeError');
    assert.strictEqual(err.instanceOfSubWinTypeError, true, 'Error must be an instance of subWin.TypeError');
    assert.ok(!err.stack.includes('stripStackFrame'), 'Stack must not contain stripStackFrame');
    assert.ok(!err.stack.includes('nativeGetter'), 'Stack must not contain nativeGetter');
  });

  check('platform getter called on sub-realm receiver throws subWin.TypeError', () => {
    const err = result.subRealmErrors.platform_onSubObj;
    assert.ok(err && err.threw, 'Must throw');
    assert.strictEqual(err.name, 'TypeError');
    assert.strictEqual(err.instanceOfSubWinTypeError, true, 'Error must be an instance of subWin.TypeError');
  });

  check('subWin internal call on subWin Navigator.prototype.userAgent throws subWin TypeError', () => {
    const subRes = result.subRealmErrors.subWinInternalCall;
    assert.ok(subRes && subRes.threw, 'Must throw');
    assert.strictEqual(subRes.isSubWinTypeError, true, 'Must be instance of subWin TypeError');
  });

  console.log('\n--- Asserting Persona Navigator Values ---');

  check('navigator.userAgent matches Windows persona value in parent window', () => {
    assert.strictEqual(result.navigatorValues.parentUserAgent, WINDOWS_UA);
  });

  check('navigator.userAgent matches Windows persona value in sub-realm iframe', () => {
    assert.strictEqual(result.navigatorValues.subUserAgent, WINDOWS_UA);
  });

  check('navigator.platform matches Win32 in parent and sub-realm', () => {
    assert.strictEqual(result.navigatorValues.parentPlatform, 'Win32');
    assert.strictEqual(result.navigatorValues.subPlatform, 'Win32');
  });

  console.log('\n========================================================================');
  const failed = testResults.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`user-agent-cross-realm-selftest: FAILED (${failed.length}/${testResults.length} failed)`);
    process.exit(1);
  } else {
    console.log(`user-agent-cross-realm-selftest: OK ${testResults.length}/${testResults.length} ALL PASSED`);
    process.exit(0);
  }
})();
