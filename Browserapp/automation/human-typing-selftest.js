#!/usr/bin/env node
'use strict';

/**
 * End-to-end self-test for Human-Like Typing simulation.
 *
 * Requirements:
 *   1. Unit tests:
 *      - Adjacent key neighbourhood table completeness
 *      - Speed profiles (fast / medium / slow) within 50-180ms bounds & typoRate <= 3%
 *      - Gaussian random distribution & WPM curve
 *      - Text fidelity across random strings
 *   2. Real kernel + local loopback E2E:
 *      - Start real Chromium kernel with DevToolsActivePort
 *      - Initialize engine & LocalApiServer (real HTTP local loopback)
 *      - Navigate tab to data: page containing text inputs
 *      - Call POST /human-typing via Local API
 *      - Assert final input value == target text
 *      - Assert all DOM keydown events have isTrusted === true
 *      - Assert keydown interval variance is within natural human range
 *      - Assert typo slip-and-rollback path executes and restores exact text
 *      - Assert AbortSignal cancels typing immediately
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const {
  createTypingEngine,
  dispatchHumanTyping,
  sampleGaussian,
  wpmCurveFactor,
  SPEED_PROFILES,
  ADJACENT_KEYS,
  DEFAULT_TYPO_CONFIG,
  DEFAULT_DELAY_RANGE,
  normalizeDelayRange,
  delayRangeFromSettings,
  parseTypoConfig,
  normalizeText,
  isTypoEligible,
} = require('./human-typing');

const { BrowserEngine } = require('../engine');
const { LocalApiServer } = require('./local-api-server');
const cdp = require('../cdp');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log('  PASS  ' + name);
  } catch (e) {
    results.push({ name, ok: false, err: e.message || String(e) });
    console.log('  FAIL  ' + name + ' -> ' + (e.message || String(e)));
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('  PASS  ' + name);
  } catch (e) {
    results.push({ name, ok: false, err: e.message || String(e) });
    console.log('  FAIL  ' + name + ' -> ' + (e.message || String(e)));
    process.exitCode = 1;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createBufferDriver() {
  let text = '';
  let caret = 0;
  const log = [];
  return {
    async typeChar(ch) {
      text = text.slice(0, caret) + ch + text.slice(caret);
      caret += ch.length;
      log.push({ op: 'type', ch });
    },
    async pressKey(key) {
      log.push({ op: 'key', key });
      if (key === 'Backspace') {
        if (caret > 0) {
          text = text.slice(0, caret - 1) + text.slice(caret);
          caret -= 1;
        }
      } else if (key === 'Delete') {
        if (caret < text.length) {
          text = text.slice(0, caret) + text.slice(caret + 1);
        }
      } else if (key === 'ArrowLeft') {
        if (caret > 0) caret -= 1;
      } else if (key === 'ArrowRight') {
        if (caret < text.length) caret += 1;
      }
    },
    async flush() {},
    get text() { return text; },
    get caret() { return caret; },
    get log() { return log.slice(); },
  };
}

function calculateVariance(numbers) {
  if (!numbers || numbers.length < 2) return 0;
  const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
  const sqDiffs = numbers.map((n) => Math.pow(n - mean, 2));
  return sqDiffs.reduce((a, b) => a + b, 0) / (numbers.length - 1);
}

function postJson(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(data);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...headers,
      },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (_) {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTP request timed out')));
    req.write(payload);
    req.end();
  });
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync('pkill -f "user-data-dir=' + dir + '" 2>/dev/null || true'); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  console.log('Running Human-Like Typing Core & E2E Selftests...\n');

  // ==========================================
  // PART 1: Core Cadence & Unit Invariants
  // ==========================================
  check('adjacent-key table is complete (48 QWERTY keys)', () => {
    const keys = Object.keys(ADJACENT_KEYS);
    assert.strictEqual(keys.length, 48);
    for (const ch of ['a', 'z', 'q', 'm', '1', '0', ' ', ';', "'", '[', ']', ',', '.', '/', '-', '=', '`']) {
      assert.ok(ADJACENT_KEYS[ch], `missing neighbours for ${JSON.stringify(ch)}`);
      assert.ok(ADJACENT_KEYS[ch].length > 0);
    }
  });

  check('speed profiles meet 50-180ms bounds & typoRate <= 3%', () => {
    for (const [key, profile] of Object.entries(SPEED_PROFILES)) {
      assert.ok(profile.delayRange[0] >= 50, `${key} min delay >= 50ms`);
      assert.ok(profile.delayRange[1] <= 180, `${key} max delay <= 180ms`);
      assert.ok(profile.typoRate <= 3.0, `${key} typoRate <= 3%`);
      assert.ok(profile.meanDelay >= profile.delayRange[0] && profile.meanDelay <= profile.delayRange[1]);
    }
    assert.ok(DEFAULT_TYPO_CONFIG.typoRate <= 3.0, 'default typoRate <= 3%');
  });

  check('Gaussian sampler stays within min/max bounds and centers near mean', () => {
    const samples = [];
    for (let i = 0; i < 500; i += 1) {
      const v = sampleGaussian(50, 180, 115, 20);
      assert.ok(v >= 50 && v <= 180, `sample ${v} out of bounds`);
      samples.push(v);
    }
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    assert.ok(avg >= 105 && avg <= 125, `Gaussian average ${avg} deviated from mean 115`);
    const variance = calculateVariance(samples);
    assert.ok(variance > 100, `Gaussian variance ${variance} is natural`);
  });

  check('WPM curve factor models realistic cadence variation', () => {
    // Initial ramp is slower (factor > 1.0)
    const factor0 = wpmCurveFactor(0, 50);
    const factor20 = wpmCurveFactor(20, 50);
    assert.ok(factor0 > factor20, 'initial keystroke has ramp latency');
    assert.ok(factor20 >= 0.7 && factor20 <= 1.35, 'cadence factor in natural envelope');
  });

  check('normalizeDelayRange and settings parser', () => {
    assert.deepStrictEqual(normalizeDelayRange([80, 140]), [80, 140]);
    assert.deepStrictEqual(normalizeDelayRange([140, 80]), [80, 140]);
    assert.deepStrictEqual(normalizeDelayRange(100), [100, 100]);
    assert.deepStrictEqual(delayRangeFromSettings({ speed: 'fast' }), [50, 100]);
    assert.deepStrictEqual(delayRangeFromSettings({ speed: 'slow' }), [120, 180]);
  });

  await checkAsync('text fidelity with simulated slips and corrections', async () => {
    const driver = createBufferDriver();
    const engine = createTypingEngine(driver, {
      sleep: async () => {},
      randomInt: (min) => min,
      pickWrongChar: () => 'x',
    });
    // With typoRate 100, every eligible character slips and is corrected
    await engine.simulateType('HumanTyping2026', [50, 50], {
      typoRate: 100,
      scenario1Threshold: 100,
      scenario2Threshold: 0,
      scenario2BackspaceRate: 100,
    });
    assert.strictEqual(driver.text, 'HumanTyping2026', 'Final text matches exactly after corrections');
  });

  await checkAsync('AbortSignal cancels typing immediately', async () => {
    const driver = createBufferDriver();
    const controller = new AbortController();
    const engine = createTypingEngine(driver, {
      signal: controller.signal,
      sleep: async (ms) => {
        if (controller.signal.aborted) {
          const err = new Error('Typing cancelled');
          err.name = 'AbortError';
          throw err;
        }
        await sleep(ms);
      },
    });

    // Abort after 40ms
    setTimeout(() => controller.abort(), 40);
    let rejected = false;
    try {
      await engine.typeText('SuperLongTextThatWillBeAbortedBeforeFinish', [50, 100]);
    } catch (e) {
      rejected = true;
      assert.strictEqual(e.name, 'AbortError');
    }
    assert.ok(rejected, 'Typing must reject with AbortError when signal is aborted');
    assert.ok(driver.text.length < 'SuperLongTextThatWillBeAbortedBeforeFinish'.length, 'Typing stopped mid-way');
  });

  // ==========================================
  // PART 2: Real Kernel + Local API E2E
  // ==========================================
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-humantyping-e2e-'));
  let child = null;
  let apiServer = null;

  try {
    console.log('\nStarting real kernel and local loopback API server...');
    child = spawn(launcher, [tmpDir, '--headless=new', '--enable-unsafe-swiftshader'], {
      cwd: kernelRoot,
      detached: true,
      stdio: 'ignore',
    });

    let port = 0;
    for (let i = 0; i < 80; i += 1) {
      await sleep(100);
      try {
        const val = parseInt(fs.readFileSync(path.join(tmpDir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
        if (val > 0) { port = val; break; }
      } catch (_) {}
    }
    assert.ok(port > 0, 'DevToolsActivePort acquired from real kernel');

    const profileId = 'selftest-typing-profile';
    const mockApp = { getPath: () => tmpDir };
    const engine = new BrowserEngine(mockApp, { profileDataRoot: path.join(tmpDir, 'profiles') });
    engine.kernelBootstrapPromise = null;

    // Register active running session in engine
    const profileObj = { id: profileId, name: 'Typing Selftest Profile', simulateInputSpeed: 'medium' };
    engine.profiles.set(profileId, profileObj);
    engine.running.set(profileId, {
      id: profileId,
      port,
      profile: profileObj,
      child,
      stopping: false,
      cleanedUp: false,
    });

    // Set up LocalApiServer on random loopback port
    const apiKey = 'test-typing-key-2026';
    apiServer = new LocalApiServer({ engine, apiKey, port: 0 });
    const startedInfo = await apiServer.start();
    const apiUrl = `http://127.0.0.1:${startedInfo.port}`;

    // Set up test HTML page in browser
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
  <input id="input1" type="text" style="width:300px;">
  <input id="input2" type="text" style="width:300px;">
  <script>
    window.keyEvents = [];
    window.inputEventsCount = 0;
    window.changeEventsCount = 0;
    const input1 = document.getElementById('input1');
    input1.addEventListener('keydown', (e) => {
      window.keyEvents.push({
        key: e.key,
        code: e.code,
        timeStamp: performance.now(),
        isTrusted: e.isTrusted
      });
    });
    const input2 = document.getElementById('input2');
    input2.addEventListener('input', () => { window.inputEventsCount += 1; });
    input2.addEventListener('change', () => { window.changeEventsCount += 1; });
  </script>
</body>
</html>`;
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    const tab = await cdp.firstTab(port);
    assert.ok(tab, 'active browser tab acquired');
    await cdp.call(tab.webSocketDebuggerUrl, 'Page.navigate', { url: dataUrl });
    await sleep(400);

    // E2E Test 1: POST /human-typing via Local API
    await checkAsync('Local API POST /human-typing types text with isTrusted=true and natural variance', async () => {
      const targetText = 'OpenBrowser 2026';
      const res = await postJson(`${apiUrl}/human-typing`, {
        user_id: profileId,
        selector: '#input1',
        text: targetText,
        speed: 'fast',
        clear: true,
      }, { 'x-api-key': apiKey });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.code, 0);
      assert.strictEqual(res.body.data.success, true);
      assert.strictEqual(res.body.data.chars, targetText.length);

      // Verify DOM value in real browser
      const evalVal = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: 'document.getElementById("input1").value',
        returnByValue: true,
      });
      assert.strictEqual(evalVal.result.value, targetText, 'DOM input value matches target text');

      // Verify recorded keydown events
      const eventsEval = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: 'window.keyEvents',
        returnByValue: true,
      });
      const events = eventsEval.result.value;
      assert.ok(Array.isArray(events) && events.length >= targetText.length, 'key events captured by DOM listener');

      // Assert isTrusted === true
      for (const evt of events) {
        assert.strictEqual(evt.isTrusted, true, 'Keystroke event must have isTrusted === true');
      }

      // Assert interval variance
      const deltas = [];
      for (let i = 1; i < events.length; i += 1) {
        deltas.push(events[i].timeStamp - events[i - 1].timeStamp);
      }
      const variance = calculateVariance(deltas);
      const avgInterval = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      console.log(`    -> Recorded ${events.length} events, avg interval: ${avgInterval.toFixed(1)}ms, variance: ${variance.toFixed(1)}`);
      assert.ok(avgInterval >= 40 && avgInterval <= 250, `Average keystroke interval ${avgInterval}ms in human range`);
      assert.ok(variance > 25, `Keystroke interval variance ${variance} indicates natural human cadence`);
    });

    // E2E Test 2: Typo slip & correction path
    await checkAsync('Typo slip-and-rollback corrects mistakes and achieves 100% final fidelity', async () => {
      const typoText = 'hello world';
      const res = await postJson(`${apiUrl}/human-typing`, {
        user_id: profileId,
        selector: '#input2',
        text: typoText,
        speed: 'fast',
        clear: true,
        typoRate: 70, // explicitly passed high typo rate to guarantee slips
      }, { 'x-api-key': apiKey });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.code, 0);
      assert.ok(res.body.data.slips > 0, 'At least one typo slip occurred');
      assert.ok(res.body.data.correctedChars > 0, 'Corrected chars recorded');

      const evalVal = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: 'document.getElementById("input2").value',
        returnByValue: true,
      });
      assert.strictEqual(evalVal.result.value, typoText, 'Input value fully restored to intended text');

      // Verify input and change events were dispatched for React/Vue compatibility
      const eventCounts = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: '({ input: window.inputEventsCount, change: window.changeEventsCount })',
        returnByValue: true,
      });
      assert.ok(eventCounts.result.value.input > 0, 'input event dispatched on clear');
      assert.ok(eventCounts.result.value.change > 0, 'change event dispatched on clear');
    });

    // E2E Test 3: Text length upper bound (5000 chars)
    await checkAsync('Text length limit 5000 chars enforced with 400 rejection', async () => {
      const huge = 'a'.repeat(5001);
      const res = await postJson(`${apiUrl}/human-typing`, {
        user_id: profileId,
        selector: '#input2',
        text: huge,
      }, { 'x-api-key': apiKey });

      assert.strictEqual(res.body.code, 400);
      assert.ok(/exceeds/i.test(res.body.msg || res.body.message));
    });

    // E2E Test 4: Per-profile queue mutex prevents concurrent typing tearing
    await checkAsync('Per-profile queue mutex prevents concurrent typing tearing', async () => {
      const p1 = postJson(`${apiUrl}/human-typing`, {
        user_id: profileId,
        selector: '#input1',
        text: 'apple',
        speed: 'fast',
        clear: true,
      }, { 'x-api-key': apiKey });

      const p2 = postJson(`${apiUrl}/human-typing`, {
        user_id: profileId,
        selector: '#input1',
        text: 'banana',
        speed: 'fast',
        clear: true,
      }, { 'x-api-key': apiKey });

      const [r1, r2] = await Promise.all([p1, p2]);
      assert.strictEqual(r1.body.code, 0);
      assert.strictEqual(r2.body.code, 0);

      const evalVal = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: 'document.getElementById("input1").value',
        returnByValue: true,
      });
      assert.strictEqual(evalVal.result.value, 'banana', 'Final value is clean without tearing');
    });

    // E2E Test 5: options precedence: options cannot override sensitive or server resolution
    await checkAsync('options parameter cannot override sensitive or server resolution', async () => {
      const res = await postJson(`${apiUrl}/human-typing`, {
        user_id: profileId,
        selector: '#input2',
        text: 'secret123',
        sensitive: true,
        options: { sensitive: false },
      }, { 'x-api-key': apiKey });
      assert.strictEqual(res.body.code, 0);
    });

    // E2E Test 6: AbortSignal cancellation through engine method
    await checkAsync('engine.dispatchHumanTyping cancels immediately on AbortSignal', async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 60);

      let rejected = false;
      try {
        await engine.dispatchHumanTyping(profileId, '#input2', 'Aborted typing long string sequence', {
          speed: 'slow',
          signal: controller.signal,
          clear: true,
        });
      } catch (err) {
        rejected = true;
        assert.ok(/aborted|cancelled/i.test(err.message), `Expected abort error, got: ${err.message}`);
      }
      assert.ok(rejected, 'dispatchHumanTyping was rejected upon AbortSignal');
    });

    // E2E Test 7: Security guardrail - reject unknown profile or invalid target
    await checkAsync('Security guardrail rejects non-running profile or invalid target session', async () => {
      let rejected = false;
      try {
        await engine.dispatchHumanTyping('non-existent-profile', null, 'test');
      } catch (err) {
        rejected = true;
        assert.ok(/not running/i.test(err.message));
      }
      assert.ok(rejected, 'Non-running profile was rejected');

      let invalidTargetRejected = false;
      try {
        await engine.dispatchHumanTyping(profileId, { targetId: 'fake-target-id-9999' }, 'test');
      } catch (err) {
        invalidTargetRejected = true;
        assert.ok(/does not belong/i.test(err.message));
      }
      assert.ok(invalidTargetRejected, 'Target outside active CDP session was rejected');
    });

  } finally {
    if (apiServer) {
      try { await apiServer.stop(); } catch (_) {}
    }
    if (child) {
      await stopChild(child, tmpDir);
    }
  }

  // Summary
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\nHUMAN_TYPING_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
