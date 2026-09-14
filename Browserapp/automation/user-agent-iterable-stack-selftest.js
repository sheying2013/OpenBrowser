'use strict';

/**
 * user-agent-iterable-stack-selftest.js
 *
 * Verifies the fixes for:
 *  1. [P1] UAD-SET-DROPPED: navigator.userAgentData.getHighEntropyValues sequence<DOMString> polymorphism
 *     - Accepts Set, Array, and arbitrary Iterables.
 *     - Strict WebIDL argument validation: 0 args, null, undefined, primitive numbers, strings,
 *       and non-iterable objects reject with exact native TypeError messages.
 *  2. [P1] STACK-GETTER-LEAK: Navigator and NavigatorUAData getters error stack cleanliness
 *     - Navigator.prototype.__lookupGetter__('userAgent').call({}) throws TypeError: Illegal invocation
 *     - Stack trace contains NO wrapper frames (e.g. 'at get userAgent')
 *     - Stack line count and caller frame anchor match stock Chromium native baseline.
 *     - Native function fidelity: toString() === '[native code]', name, length, and property descriptors.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildUaProfile, buildUaInjectionScript } = require('./user-agent');
const { buildFingerprint, buildInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg = null;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        resolve(msg);
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

const PROBE_EXPRESSION = `(async () => {
  const data = {
    highEntropy: {},
    stacks: {},
    descriptors: {}
  };

  const uad = navigator.userAgentData;

  async function probeGeh(label, fn) {
    try {
      const res = fn();
      if (res && typeof res.then === 'function') {
        try {
          const val = await res;
          data.highEntropy[label] = { ok: true, val };
        } catch (rej) {
          data.highEntropy[label] = {
            ok: false,
            errorName: rej ? rej.name : String(rej),
            errorMessage: rej ? rej.message : String(rej),
            stack: rej ? rej.stack : ''
          };
        }
      } else {
        data.highEntropy[label] = { ok: true, val: res };
      }
    } catch (syncErr) {
      data.highEntropy[label] = {
        ok: false,
        sync: true,
        errorName: syncErr.name,
        errorMessage: syncErr.message,
        stack: syncErr.stack
      };
    }
  }

  if (uad) {
    await probeGeh('set', () => uad.getHighEntropyValues(new Set(['architecture', 'bitness', 'model'])));
    await probeGeh('array', () => uad.getHighEntropyValues(['architecture', 'bitness', 'model']));
    await probeGeh('customIterable', () => {
      const iter = {
        *[Symbol.iterator]() {
          yield 'architecture';
          yield 'bitness';
        }
      };
      return uad.getHighEntropyValues(iter);
    });
    await probeGeh('noArgs', () => uad.getHighEntropyValues());
    await probeGeh('undefined', () => uad.getHighEntropyValues(undefined));
    await probeGeh('null', () => uad.getHighEntropyValues(null));
    await probeGeh('number', () => uad.getHighEntropyValues(12345));
    await probeGeh('string', () => uad.getHighEntropyValues('architecture'));
    await probeGeh('plainObject', () => uad.getHighEntropyValues({}));
    await probeGeh('illegalReceiver', () => NavigatorUAData.prototype.getHighEntropyValues.call({}, ['architecture']));
  }

  // Getter stack probes
  function probeGetter(label, fn) {
    try {
      fn();
      data.stacks[label] = { threw: false };
    } catch (e) {
      data.stacks[label] = {
        threw: true,
        name: e.name,
        message: e.message,
        stack: e.stack,
        lines: e.stack.split('\\n')
      };
    }
  }

  probeGetter('navUserAgent', () => Navigator.prototype.__lookupGetter__('userAgent').call({}));
  if (typeof NavigatorUAData !== 'undefined') {
    probeGetter('uadBrands', () => NavigatorUAData.prototype.__lookupGetter__('brands').call({}));
    probeGetter('uadPlatform', () => NavigatorUAData.prototype.__lookupGetter__('platform').call({}));
    probeGetter('uadMobile', () => NavigatorUAData.prototype.__lookupGetter__('mobile').call({}));
    probeGetter('uadToJSON', () => NavigatorUAData.prototype.toJSON.call({}));
  }

  // Descriptors & native appearance
  try {
    const dUa = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
    const gUa = dUa ? dUa.get : null;
    data.descriptors.navUserAgent = {
      enumerable: dUa?.enumerable,
      configurable: dUa?.configurable,
      hasSet: Boolean(dUa && 'set' in dUa),
      setValue: dUa?.set,
      name: gUa?.name,
      length: gUa?.length,
      toString: gUa ? Function.prototype.toString.call(gUa) : null
    };

    if (typeof NavigatorUAData !== 'undefined') {
      const dGeh = Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'getHighEntropyValues');
      data.descriptors.getHighEntropyValues = {
        enumerable: dGeh?.enumerable,
        configurable: dGeh?.configurable,
        writable: dGeh?.writable,
        name: dGeh?.value?.name,
        length: dGeh?.value?.length,
        toString: dGeh?.value ? Function.prototype.toString.call(dGeh.value) : null
      };

      const dTj = Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'toJSON');
      data.descriptors.toJSON = {
        enumerable: dTj?.enumerable,
        configurable: dTj?.configurable,
        writable: dTj?.writable,
        name: dTj?.value?.name,
        length: dTj?.value?.length,
        toString: dTj?.value ? Function.prototype.toString.call(dTj.value) : null
      };
    }
  } catch (e) {
    data.descriptors.error = String(e);
  }

  return data;
})()`;

async function runSession(profileConfig, inject) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-test-session-'));
  const portFile = path.join(dir, 'DevToolsActivePort');

  if (inject) {
    const fp = buildFingerprint(profileConfig);
    await writeOpenBrowserKernelInit(dir, {
      fingerprint: fp,
      profile: profileConfig,
      templatePath: path.join(kernelRoot, 'init_template.json')
    });
  }

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>Test Page</title></head><body>Secure Context</body></html>');
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
    if (inject) {
      const fp = buildFingerprint(profileConfig);
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: buildInjectionScript(fp)
      }, sessionId);
    }
    await cdp.send('Page.navigate', { url }, sessionId);
    await sleep(1500);

    result = await cdp.eval(PROBE_EXPRESSION, sessionId);
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

  return result;
}

const testResults = [];
async function check(name, fn) {
  try {
    await fn();
    testResults.push({ name, ok: true });
    console.log('  PASS  ' + name);
  } catch (err) {
    testResults.push({ name, ok: false, error: err.message || String(err) });
    console.error('  FAIL  ' + name + ': ' + (err.message || String(err)));
  }
}

async function main() {
  console.log('========================================================================');
  console.log('  User-Agent Iterable & Stack Cleanliness E2E Verification Suite');
  console.log('========================================================================\n');

  // -------------------------------------------------------------------------
  // Part 1: Static / Unit Compilation Checks
  // -------------------------------------------------------------------------
  await check('1.1: buildUaInjectionScript compiles cleanly via Function constructor', () => {
    const profile = buildUaProfile({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      os: 'windows',
      platform: 'Win32'
    });
    const code = buildUaInjectionScript(profile);
    assert.doesNotThrow(() => {
      new Function(code);
    }, 'buildUaInjectionScript must not produce syntax errors in template interpolation');
  });

  await check('1.2: buildUaInjectionScript contains stripStackFrame and sequence iterator handling', () => {
    const profile = buildUaProfile({ userAgent: 'test', os: 'windows' });
    const code = buildUaInjectionScript(profile);
    assert.ok(code.includes('stripStackFrame'), 'Must include stripStackFrame helper');
    assert.ok(code.includes('parseHints'), 'Must include parseHints sequence helper');
    assert.ok(code.includes('Symbol.iterator'), 'Must include Symbol.iterator check for WebIDL sequence');
  });

  // -------------------------------------------------------------------------
  // Part 2: Live Kernel A/B Adversarial Verification
  // -------------------------------------------------------------------------
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('SKIP: macOS Chromium kernel not present on this host.');
    return;
  }

  console.log('\n[Phase 1/2] Launching stock Chromium kernel for native baseline...');
  const baseline = await runSession({ id: 'baseline', os: 'macos' }, false);

  console.log('[Phase 2/2] Launching injected Chromium session with Windows persona...');
  const windowsProfile = {
    id: 'test-win-persona',
    name: 'test-win-persona',
    kernelVersion: '148.0.7778.165',
    os: 'windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    canvas: 'noise',
    webgl: 'noise',
    cores: 8,
    memory: 8,
    privacy: {
      webrtc: 'proxy',
      timezoneMode: 'custom',
      timezone: 'America/New_York',
      languages: ['en-US', 'en'],
      speech: 'noise',
      battery: 'noise',
      webgpu: 'webgl',
      webrtcAddress: '203.0.113.9'
    }
  };
  const injected = await runSession(windowsProfile, true);

  console.log('\n--- Evaluating Behavioral & Stack Fidelity ---\n');

  // 2.1 Set polymorphism
  await check('2.1: getHighEntropyValues accepts Set and returns requested fields', () => {
    const bSet = baseline.highEntropy?.set;
    const iSet = injected.highEntropy?.set;
    assert.strictEqual(bSet?.ok, true, `Baseline Set call failed: ${JSON.stringify(bSet)}`);
    assert.strictEqual(iSet?.ok, true, `Injected Set call failed: ${JSON.stringify(iSet)}`);
    assert.ok('architecture' in iSet.val, 'architecture must be present when passed in Set');
    assert.ok('bitness' in iSet.val, 'bitness must be present when passed in Set');
    assert.ok('model' in iSet.val, 'model must be present when passed in Set');
    assert.strictEqual(iSet.val.platform, 'Windows', 'Platform must reflect Windows persona');
    assert.strictEqual(iSet.val.architecture, 'x86', 'Architecture must reflect Windows persona x86');
  });

  // 2.2 Array polymorphism
  await check('2.2: getHighEntropyValues accepts Array and returns persona fields', () => {
    const iArr = injected.highEntropy?.array;
    assert.strictEqual(iArr?.ok, true, `Injected Array call failed: ${JSON.stringify(iArr)}`);
    assert.ok('architecture' in iArr.val, 'architecture must be present when passed in Array');
    assert.ok('bitness' in iArr.val, 'bitness must be present when passed in Array');
  });

  // 2.3 Custom Iterable polymorphism
  await check('2.3: getHighEntropyValues accepts custom generator / Iterable', () => {
    const iGen = injected.highEntropy?.customIterable;
    assert.strictEqual(iGen?.ok, true, `Injected custom Iterable call failed: ${JSON.stringify(iGen)}`);
    assert.ok('architecture' in iGen.val, 'architecture must be present when passed in generator');
    assert.ok('bitness' in iGen.val, 'bitness must be present when passed in generator');
  });

  // 2.4 - 2.9 Malformed sequence input error consistency
  await check('2.4: 0 arguments rejects with exact TypeError matching native baseline', () => {
    const b = baseline.highEntropy?.noArgs;
    const i = injected.highEntropy?.noArgs;
    assert.strictEqual(i?.ok, false, '0 args must reject');
    assert.strictEqual(i?.errorName, b?.errorName, `Error name mismatch: got ${i?.errorName}, expected ${b?.errorName}`);
    assert.strictEqual(i?.errorMessage, b?.errorMessage, `Error message mismatch: got "${i?.errorMessage}", expected "${b?.errorMessage}"`);
  });

  await check('2.5: null argument rejects with exact TypeError matching native baseline', () => {
    const b = baseline.highEntropy?.null;
    const i = injected.highEntropy?.null;
    assert.strictEqual(i?.ok, false, 'null arg must reject');
    assert.strictEqual(i?.errorName, b?.errorName, `Error name mismatch: got ${i?.errorName}, expected ${b?.errorName}`);
    assert.strictEqual(i?.errorMessage, b?.errorMessage, `Error message mismatch: got "${i?.errorMessage}", expected "${b?.errorMessage}"`);
  });

  await check('2.6: undefined argument rejects with exact TypeError matching native baseline', () => {
    const b = baseline.highEntropy?.undefined;
    const i = injected.highEntropy?.undefined;
    assert.strictEqual(i?.ok, false, 'undefined arg must reject');
    assert.strictEqual(i?.errorName, b?.errorName, `Error name mismatch: got ${i?.errorName}, expected ${b?.errorName}`);
    assert.strictEqual(i?.errorMessage, b?.errorMessage, `Error message mismatch: got "${i?.errorMessage}", expected "${b?.errorMessage}"`);
  });

  await check('2.7: primitive number argument rejects with exact TypeError matching native baseline', () => {
    const b = baseline.highEntropy?.number;
    const i = injected.highEntropy?.number;
    assert.strictEqual(i?.ok, false, 'number arg must reject');
    assert.strictEqual(i?.errorName, b?.errorName, `Error name mismatch: got ${i?.errorName}, expected ${b?.errorName}`);
    assert.strictEqual(i?.errorMessage, b?.errorMessage, `Error message mismatch: got "${i?.errorMessage}", expected "${b?.errorMessage}"`);
  });

  await check('2.8: primitive string argument rejects with exact TypeError matching native baseline', () => {
    const b = baseline.highEntropy?.string;
    const i = injected.highEntropy?.string;
    assert.strictEqual(i?.ok, false, 'string arg must reject');
    assert.strictEqual(i?.errorName, b?.errorName, `Error name mismatch: got ${i?.errorName}, expected ${b?.errorName}`);
    assert.strictEqual(i?.errorMessage, b?.errorMessage, `Error message mismatch: got "${i?.errorMessage}", expected "${b?.errorMessage}"`);
  });

  await check('2.9: non-iterable plain object rejects with exact TypeError matching native baseline', () => {
    const b = baseline.highEntropy?.plainObject;
    const i = injected.highEntropy?.plainObject;
    assert.strictEqual(i?.ok, false, 'plain object arg must reject');
    assert.strictEqual(i?.errorName, b?.errorName, `Error name mismatch: got ${i?.errorName}, expected ${b?.errorName}`);
    assert.strictEqual(i?.errorMessage, b?.errorMessage, `Error message mismatch: got "${i?.errorMessage}", expected "${b?.errorMessage}"`);
  });

  await check('2.10: illegal receiver on getHighEntropyValues rejects with TypeError: Illegal invocation', () => {
    const b = baseline.highEntropy?.illegalReceiver;
    const i = injected.highEntropy?.illegalReceiver;
    assert.strictEqual(i?.ok, false, 'illegal receiver must reject');
    assert.strictEqual(i?.errorName, 'TypeError', 'Must reject with TypeError');
    assert.ok(i?.errorMessage.includes('Illegal invocation'), `Error message must contain 'Illegal invocation', got: ${i?.errorMessage}`);
  });

  // 2.11 - 2.14 Stack frame cleanliness
  await check('2.11: Navigator.prototype.userAgent getter illegal receiver stack has NO wrapper frame and matches baseline', () => {
    const b = baseline.stacks?.navUserAgent;
    const i = injected.stacks?.navUserAgent;
    assert.strictEqual(i?.threw, true, 'Getter must throw on illegal receiver');
    assert.strictEqual(i?.name, b?.name, `Error name mismatch: ${i?.name} vs ${b?.name}`);
    assert.strictEqual(i?.message, b?.message, `Error message mismatch: ${i?.message} vs ${b?.message}`);
    assert.ok(!i?.stack.includes('get userAgent'), `Stack must not contain wrapper frame 'get userAgent'. Got:\n${i?.stack}`);
    assert.strictEqual(i?.lines?.length, b?.lines?.length, `Stack line count must match baseline (${b?.lines?.length}). Got ${i?.lines?.length}`);
    assert.ok(i?.lines[1]?.startsWith('    at <anonymous>'), `Top stack frame must be the anonymous callsite, got: ${i?.lines[1]}`);
  });

  await check('2.12: NavigatorUAData.prototype.platform getter illegal receiver stack has NO wrapper frame and matches baseline', () => {
    const b = baseline.stacks?.uadPlatform;
    const i = injected.stacks?.uadPlatform;
    assert.strictEqual(i?.threw, true, 'Getter must throw on illegal receiver');
    assert.ok(!i?.stack.includes('get platform'), `Stack must not contain wrapper frame 'get platform'. Got:\n${i?.stack}`);
    assert.strictEqual(i?.lines?.length, b?.lines?.length, `Stack line count mismatch: ${i?.lines?.length} vs ${b?.lines?.length}`);
  });

  await check('2.13: NavigatorUAData.prototype.brands getter illegal receiver stack has NO wrapper frame', () => {
    const b = baseline.stacks?.uadBrands;
    const i = injected.stacks?.uadBrands;
    assert.strictEqual(i?.threw, true, 'Getter must throw on illegal receiver');
    assert.ok(!i?.stack.includes('get brands'), `Stack must not contain wrapper frame 'get brands'. Got:\n${i?.stack}`);
    assert.strictEqual(i?.lines?.length, b?.lines?.length, `Stack line count mismatch: ${i?.lines?.length} vs ${b?.lines?.length}`);
  });

  await check('2.14: NavigatorUAData.prototype.toJSON illegal receiver stack has NO wrapper frame', () => {
    const b = baseline.stacks?.uadToJSON;
    const i = injected.stacks?.uadToJSON;
    assert.strictEqual(i?.threw, true, 'toJSON must throw on illegal receiver');
    assert.ok(!i?.stack.includes('toJSON'), `Stack must not contain wrapper frame 'toJSON'. Got:\n${i?.stack}`);
    assert.strictEqual(i?.lines?.length, b?.lines?.length, `Stack line count mismatch: ${i?.lines?.length} vs ${b?.lines?.length}`);
  });

  // 2.15 - 2.18 Native Appearance & Descriptors
  await check('2.15: Navigator.prototype.userAgent getter toString is [native code], name and length match baseline', () => {
    const b = baseline.descriptors?.navUserAgent;
    const i = injected.descriptors?.navUserAgent;
    assert.strictEqual(i?.name, b?.name, `Name mismatch: ${i?.name} vs ${b?.name}`);
    assert.strictEqual(i?.length, b?.length, `Length mismatch: ${i?.length} vs ${b?.length}`);
    assert.strictEqual(i?.toString, b?.toString, `toString mismatch: ${i?.toString} vs ${b?.toString}`);
    assert.strictEqual(i?.enumerable, b?.enumerable, `enumerable mismatch: ${i?.enumerable} vs ${b?.enumerable}`);
    assert.strictEqual(i?.configurable, b?.configurable, `configurable mismatch: ${i?.configurable} vs ${b?.configurable}`);
    assert.strictEqual(i?.hasSet, b?.hasSet, `hasSet mismatch: ${i?.hasSet} vs ${b?.hasSet}`);
  });

  await check('2.16: NavigatorUAData.prototype.getHighEntropyValues descriptor and toString match baseline', () => {
    const b = baseline.descriptors?.getHighEntropyValues;
    const i = injected.descriptors?.getHighEntropyValues;
    assert.strictEqual(i?.name, b?.name, `Name mismatch: ${i?.name} vs ${b?.name}`);
    assert.strictEqual(i?.length, b?.length, `Length mismatch: ${i?.length} vs ${b?.length}`);
    assert.strictEqual(i?.toString, b?.toString, `toString mismatch: ${i?.toString} vs ${b?.toString}`);
    assert.strictEqual(i?.writable, b?.writable, `writable mismatch: ${i?.writable} vs ${b?.writable}`);
    assert.strictEqual(i?.enumerable, b?.enumerable, `enumerable mismatch: ${i?.enumerable} vs ${b?.enumerable}`);
    assert.strictEqual(i?.configurable, b?.configurable, `configurable mismatch: ${i?.configurable} vs ${b?.configurable}`);
  });

  await check('2.17: NavigatorUAData.prototype.toJSON descriptor and toString match baseline', () => {
    const b = baseline.descriptors?.toJSON;
    const i = injected.descriptors?.toJSON;
    assert.strictEqual(i?.name, b?.name, `Name mismatch: ${i?.name} vs ${b?.name}`);
    assert.strictEqual(i?.length, b?.length, `Length mismatch: ${i?.length} vs ${b?.length}`);
    assert.strictEqual(i?.toString, b?.toString, `toString mismatch: ${i?.toString} vs ${b?.toString}`);
    assert.strictEqual(i?.writable, b?.writable, `writable mismatch: ${i?.writable} vs ${b?.writable}`);
    assert.strictEqual(i?.enumerable, b?.enumerable, `enumerable mismatch: ${i?.enumerable} vs ${b?.enumerable}`);
    assert.strictEqual(i?.configurable, b?.configurable, `configurable mismatch: ${i?.configurable} vs ${b?.configurable}`);
  });

  const failed = testResults.filter((r) => !r.ok);
  console.log('\n========================================================================');
  if (failed.length > 0) {
    console.error(`user-agent-iterable-stack-selftest: FAILED (${failed.length}/${testResults.length} failed)`);
    process.exit(1);
  } else {
    console.log(`user-agent-iterable-stack-selftest: OK ${testResults.length}/${testResults.length} ALL PASSED`);
    console.log('========================================================================');
  }
}

main().catch((err) => {
  console.error('Test suite runner crashed:', err);
  process.exit(1);
});
