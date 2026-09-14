#!/usr/bin/env node
'use strict';

/**
 * Kernel Automation Flag Forensics & DevTools Gateway Selftest
 *
 * Ground Truth Evidence & Architectural Background:
 * 1. Chromium's native switch '--enable-automation' directly enables Blink's
 *    AutomationControlled feature (features::kAutomationControlled), setting
 *    navigator.webdriver=true, showing automation infobars, and triggering anti-bot
 *    detections (e.g. Google BotGuard / sorry CAPTCHA).
 * 2. In the bundled kernel (reverse engineered at 0x6071fbd & 0x6072aec in devtools_http_handler.cc),
 *    'can_webdriver' in init.json is stored at 0xee5d34c and queried by 0x8269ac0.
 *    It is purely a gatekeeper for DevToolsHttpHandler HTTP & WebSocket requests.
 *    If false/missing, CDP returns HTTP 500 / rejects WS. It does NOT touch Blink or JS.
 * 3. CDP automation only requires remote-debugging-port: '0' and init.can_webdriver: true.
 *    It does NOT require and must NEVER include 'enable-automation'.
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, execSync } = require('child_process');

const {
  writeOpenBrowserKernelInit,
  validateKernelInitInvariants,
  loadInitObject,
} = require('./kernel-init-sync');
const { buildFingerprint } = require('./fingerprint');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const reapScript = path.join(__dirname, 'reap-orphan-kernels.js');

let totalChecks = 0;
let passedChecks = 0;
const results = [];

function check(name, fn) {
  totalChecks++;
  try {
    const detail = fn();
    passedChecks++;
    results.push({ name, ok: true, detail: detail || '' });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
    process.exitCode = 1;
  }
}

async function asyncCheck(name, fn) {
  totalChecks++;
  try {
    const detail = await fn();
    passedChecks++;
    results.push({ name, ok: true, detail: detail || '' });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
    process.exitCode = 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('=== Running kernel-automation-flag-forensics-selftest ===\n');

  // --- 1. Static & Mapping Invariants ---
  await asyncCheck('writeOpenBrowserKernelInit excludes enable-automation from cmd_line', async () => {
    const tmp = fs.mkdtempSync('/tmp/ob-forensics-');
    try {
      const profile = {
        id: 'forensics-test-1',
        name: 'forensics-test-1',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/148.0.0.0 Safari/537.36',
        privacy: {},
      };
      const fp = buildFingerprint(profile);
      const { init } = await writeOpenBrowserKernelInit(tmp, { fingerprint: fp, profile });

      assert.ok(init.cmd_line, 'init must contain cmd_line object');
      assert.strictEqual(
        init.cmd_line['enable-automation'],
        undefined,
        'cmd_line must NOT contain enable-automation'
      );
      assert.strictEqual(
        'enable-automation' in init.cmd_line,
        false,
        'enable-automation key must not exist in cmd_line'
      );
      return 'cmd_line has 0 automation flags';
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  await asyncCheck('writeOpenBrowserKernelInit purges pre-existing enable-automation from legacy init.json', async () => {
    const tmp = fs.mkdtempSync('/tmp/ob-forensics-legacy-');
    try {
      const initPath = path.join(tmp, 'init.json');
      // Simulate a legacy profile whose init.json had enable-automation seeded
      const legacyInit = {
        cmd_line: {
          'enable-automation': '',
          'custom-seed-flag': 'active',
        },
        can_webdriver: false,
      };
      fs.writeFileSync(initPath, JSON.stringify(legacyInit));

      const profile = {
        id: 'forensics-test-legacy',
        name: 'forensics-test-legacy',
        privacy: {},
      };
      const fp = buildFingerprint(profile);
      const { init } = await writeOpenBrowserKernelInit(tmp, { fingerprint: fp, profile });

      assert.strictEqual(
        init.cmd_line['enable-automation'],
        undefined,
        'pre-existing enable-automation must be stripped from cmd_line'
      );
      assert.strictEqual(
        init.cmd_line['custom-seed-flag'],
        'active',
        'legitimate custom seed flags must still be preserved'
      );
      assert.strictEqual(
        init.can_webdriver,
        true,
        'can_webdriver must be restored to true to ensure CDP accessibility'
      );
      return 'legacy enable-automation purged, can_webdriver restored';
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  await asyncCheck('can_webdriver and allow_remote_debugging are preserved as true in init.json', async () => {
    const tmp = fs.mkdtempSync('/tmp/ob-forensics-flags-');
    try {
      const profile = { id: 'test-flags', name: 'test-flags', privacy: {} };
      const fp = buildFingerprint(profile);
      const { init } = await writeOpenBrowserKernelInit(tmp, { fingerprint: fp, profile });

      assert.strictEqual(init.can_webdriver, true, 'can_webdriver must be true (DevToolsHttpHandler gate)');
      assert.strictEqual(init.allow_remote_debugging, true, 'allow_remote_debugging must be true');
      assert.strictEqual(init.cmd_line['remote-debugging-port'], '0', 'remote-debugging-port must be 0');
      return 'can_webdriver=true, allow_remote_debugging=true, remote-debugging-port=0';
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  check('validateKernelInitInvariants rejects enable-automation in cmd_line', () => {
    const cleanInit = {
      cmd_line: { 'remote-debugging-port': '0', 'user-agent': 'test' },
      can_webdriver: true,
      allow_remote_debugging: true,
    };
    const passRes = validateKernelInitInvariants(cleanInit);
    assert.strictEqual(passRes.valid, true, 'clean init must pass invariant check');

    const dirtyInit = {
      cmd_line: { 'remote-debugging-port': '0', 'enable-automation': '' },
      can_webdriver: true,
      allow_remote_debugging: true,
    };
    const failRes = validateKernelInitInvariants(dirtyInit);
    assert.strictEqual(failRes.valid, false, 'init with enable-automation must fail invariant check');
    assert.ok(
      failRes.issues.some((i) => i.includes('enable-automation')),
      'issue list must explicitly mention enable-automation'
    );
    return 'invariants enforce absence of enable-automation';
  });

  check('bundled templates do not contain enable-automation', () => {
    const t1Path = path.join(kernelRoot, 'init_template.json');
    const t2Path = path.join(kernelRoot, 'chrome_148', 'init_clean_standalone.json');

    if (fs.existsSync(t1Path)) {
      const t1 = JSON.parse(fs.readFileSync(t1Path, 'utf8'));
      assert.strictEqual('enable-automation' in (t1.cmd_line || {}), false, 'init_template.json must not have enable-automation');
      assert.strictEqual(t1.can_webdriver, true, 'init_template.json must have can_webdriver=true');
    }
    if (fs.existsSync(t2Path)) {
      const t2 = JSON.parse(fs.readFileSync(t2Path, 'utf8'));
      assert.strictEqual('enable-automation' in (t2.cmd_line || {}), false, 'init_clean_standalone.json must not have enable-automation');
      assert.strictEqual(t2.can_webdriver, true, 'init_clean_standalone.json must have can_webdriver=true');
    }
    return 'all checked templates are clean';
  });

  // --- 2. Live Headless Kernel End-to-End CDP & Flag Verification ---
  if (process.platform === 'darwin' && fs.existsSync(launcher)) {
    await asyncCheck('live headless kernel connects CDP without enable-automation', async () => {
      const profileDir = fs.mkdtempSync('/tmp/ob-live-forensics-');
      let child = null;
      let ws = null;
      try {
        const profile = {
          id: 'live-forensics',
          name: 'live-forensics',
          kernelVersion: '148.0.7778.165',
          os: 'macos',
          privacy: {},
        };
        const fp = buildFingerprint(profile);
        const { init } = await writeOpenBrowserKernelInit(profileDir, { fingerprint: fp, profile });

        assert.strictEqual(init.can_webdriver, true);
        assert.strictEqual('enable-automation' in init.cmd_line, false);

        // Spawn kernel strictly in headless mode
        child = spawn(launcher, [profileDir, '--headless=new'], {
          cwd: kernelRoot,
          detached: true,
          stdio: 'ignore',
        });
        child.unref();

        // Wait for DevToolsActivePort
        let port = null;
        for (let i = 0; i < 40; i++) {
          await sleep(250);
          try {
            const p = parseInt(
              fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0],
              10
            );
            if (p > 0) {
              port = p;
              break;
            }
          } catch (_) {}
        }
        assert.ok(port, 'kernel must open DevTools port');

        // Test HTTP gateway (gated by can_webdriver at 0x6071fbd)
        const versionRes = await fetch(`http://127.0.0.1:${port}/json/version`);
        assert.strictEqual(versionRes.status, 200, 'DevTools /json/version must return HTTP 200');
        const versionData = await versionRes.json();
        assert.ok(versionData.Browser && versionData.Browser.includes('Chrome'), 'Browser must report Chrome');

        // Test WebSocket gateway (gated by can_webdriver at 0x6072aec)
        const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
        const listData = await listRes.json();
        const pageTarget = listData.find((t) => t.type === 'page');
        assert.ok(pageTarget, 'kernel must have an active page target');
        assert.ok(pageTarget.webSocketDebuggerUrl, 'page target must provide webSocketDebuggerUrl');

        ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = (e) => reject(new Error('WebSocket connection failed'));
        });

        // Query Runtime evaluation to verify browser state
        const evalResult = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('CDP evaluate timeout')), 5000);
          ws.onmessage = (event) => {
            clearTimeout(timer);
            try {
              resolve(JSON.parse(event.data));
            } catch (err) {
              reject(err);
            }
          };
          ws.send(
            JSON.stringify({
              id: 100,
              method: 'Runtime.evaluate',
              params: {
                expression: '({ chromeApp: !!(window.chrome && window.chrome.app), title: document.title })',
                returnByValue: true,
              },
            })
          );
        });

        assert.ok(evalResult && evalResult.result, 'evaluation must succeed');
        assert.ok(evalResult.result.result, 'evaluation must yield a result value');
        return `CDP connected on port ${port}, browser: ${versionData.Browser}`;
      } finally {
        if (ws) {
          try { ws.close(); } catch (_) {}
        }
        if (child) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
        }
        try {
          execSync(`pkill -f "user-data-dir=${profileDir}" 2>/dev/null || true`);
        } catch (_) {}
        await fsp.rm(profileDir, { recursive: true, force: true });
        // Always reap orphan kernels
        try {
          execSync(`node "${reapScript}"`, { stdio: 'ignore' });
        } catch (_) {}
      }
    });
  } else {
    console.log('  SKIP  launcher not available on current platform');
  }

  console.log(`\n======================================================================`);
  console.log(`kernel-automation-flag-forensics-selftest: OK ${passedChecks}/${totalChecks} passed`);

  if (passedChecks !== totalChecks) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  try {
    execSync(`node "${reapScript}"`, { stdio: 'ignore' });
  } catch (_) {}
  process.exit(1);
});
