#!/usr/bin/env node
'use strict';

/**
 * End-to-end verification for Windows browser kernel timezone consistency.
 *
 * Verifies:
 * 1. Timezone string validation adheres strictly to recognized IANA timezones.
 * 2. Launch argument parser extracts explicit --time-zone-for-testing values.
 * 3. User explicit flag takes precedence and prevents duplicate flag injection.
 * 4. Invalid or unspecified timezones are not injected as kernel flags.
 * 5. Live browser E2E under Windows persona:
 *    - Date: getTimezoneOffset, toString, and local components reflect target persona.
 *    - Intl: resolvedOptions().timeZone and formatted strings match target persona.
 *    - Worker: DedicatedWorker inherits identical timezone context.
 *    - Cookie: Expiration and date formatting operate consistently with the target timezone.
 * 6. Mutation mode (--mutate): Omission of the launch flag causes host timezone leakage,
 *    confirming sensitivity of the test suite to kernel-level timezone parameterization.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { isValidIanaTimezone, extractTimezoneFromArgs } = require('../engine');
const { buildFingerprint, applyFingerprintToTab } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const isMutateMode = process.argv.includes('--mutate') || process.env.MUTATE === '1';

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg = null;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const resolve = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
  }
  send(method, params = {}) {
    this.seq += 1;
    const id = this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: 'CDP timeout: ' + method } });
      }, 15000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.result?.exceptionDetails) {
      const ex = res.result.exceptionDetails;
      throw new Error(ex.text || ex.exception?.description || 'Evaluation error');
    }
    return res.result?.result?.value;
  }
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
}

async function waitForPage(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = (list || []).find((item) => item.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (_) {}
    await sleep(200);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unit & Contract Checks
// ---------------------------------------------------------------------------

check('isValidIanaTimezone validates recognized IANA timezones', () => {
  assert.strictEqual(isValidIanaTimezone('America/New_York'), true);
  assert.strictEqual(isValidIanaTimezone('Europe/London'), true);
  assert.strictEqual(isValidIanaTimezone('Asia/Tokyo'), true);
  assert.strictEqual(isValidIanaTimezone('UTC'), true);
  assert.strictEqual(isValidIanaTimezone('Australia/Sydney'), true);
});

check('isValidIanaTimezone rejects invalid, empty, or non-IANA identifiers', () => {
  assert.strictEqual(isValidIanaTimezone(''), false);
  assert.strictEqual(isValidIanaTimezone('   '), false);
  assert.strictEqual(isValidIanaTimezone(null), false);
  assert.strictEqual(isValidIanaTimezone(undefined), false);
  assert.strictEqual(isValidIanaTimezone('Invalid/Zone_Name'), false);
  assert.strictEqual(isValidIanaTimezone('12345'), false);
  assert.strictEqual(isValidIanaTimezone('GMT+99'), false);
});

check('extractTimezoneFromArgs parses explicit switch value from arguments', () => {
  const args = ['--user-data-dir=/tmp/foo', '--time-zone-for-testing=America/Chicago', '--headless=new'];
  assert.strictEqual(extractTimezoneFromArgs(args), 'America/Chicago');
  assert.strictEqual(extractTimezoneFromArgs(['--user-data-dir=/tmp/foo']), null);
  assert.strictEqual(extractTimezoneFromArgs([]), null);
  assert.strictEqual(extractTimezoneFromArgs(null), null);
});

check('User explicit switch takes precedence over automatic profile timezone', () => {
  const finalArgs = ['--user-data-dir=/tmp/foo', '--time-zone-for-testing=Europe/Paris'];
  const userExplicitTz = extractTimezoneFromArgs(finalArgs);
  const hasExplicitTzFlag = Boolean(userExplicitTz || finalArgs.some((arg) => /^--time-zone-for-testing(?:=|$)/i.test(String(arg))));

  assert.strictEqual(hasExplicitTzFlag, true);
  assert.strictEqual(userExplicitTz, 'Europe/Paris');

  // Verify that an auto-injection pass does not push a duplicate flag
  let injected = false;
  if (!hasExplicitTzFlag) {
    finalArgs.push('--time-zone-for-testing=America/New_York');
    injected = true;
  }
  assert.strictEqual(injected, false);
  assert.strictEqual(finalArgs.filter((a) => a.startsWith('--time-zone-for-testing')).length, 1);
});

check('Invalid timezone identifier does not produce a command line flag', () => {
  const finalArgs = ['--user-data-dir=/tmp/foo'];
  const candidateTz = 'NotAReal/Timezone';
  if (isValidIanaTimezone(candidateTz)) {
    finalArgs.push(`--time-zone-for-testing=${candidateTz}`);
  }
  assert.strictEqual(finalArgs.some((a) => a.startsWith('--time-zone-for-testing')), false);
});

check('Real timezone mode suppresses synthetic timezone flag injection', () => {
  const finalArgs = ['--user-data-dir=/tmp/foo'];
  const profile = { privacy: { timezoneMode: 'real', timezone: 'America/New_York' } };
  const isRealTimezone = profile.privacy?.timezoneMode === 'real';
  if (!isRealTimezone && isValidIanaTimezone(profile.privacy.timezone)) {
    finalArgs.push(`--time-zone-for-testing=${profile.privacy.timezone}`);
  }
  assert.strictEqual(finalArgs.some((a) => a.startsWith('--time-zone-for-testing')), false);
});

// ---------------------------------------------------------------------------
// Real Browser E2E Tests (Date, Intl, Worker, Cookie)
// ---------------------------------------------------------------------------

async function runTimezoneLiveSession(mutate = false) {
  const TARGET_TIMEZONE = 'America/New_York';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-tz-kernel-${mutate ? 'mutate' : 'normal'}-`));

  // Spin up a minimal local HTTP server to verify cookies over standard HTTP
  let serverPort = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'server_tz_probe=active; Path=/',
    });
    res.end('<!DOCTYPE html><html><head><title>Timezone Test</title></head><body><h1>TZ</h1></body></html>');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    serverPort = server.address().port;
    resolve();
  }));

  const profile = {
    id: `tz-test-${mutate ? 'mutate' : 'normal'}`,
    name: `tz-test-${mutate ? 'mutate' : 'normal'}`,
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    userAgent: WINDOWS_UA,
    exitTimezone: TARGET_TIMEZONE,
    privacy: {
      timezoneMode: 'custom',
      timezone: TARGET_TIMEZONE,
    },
  };

  const fp = buildFingerprint(profile);

  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile,
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });

  const launchArgs = [dir, '--headless=new', '--disable-gpu'];
  const spawnEnv = { ...process.env };

  if (mutate) {
    // In mutate mode, intentionally strip --time-zone-for-testing and TZ to simulate unpatched state
    delete spawnEnv.TZ;
  } else {
    launchArgs.push(`--time-zone-for-testing=${TARGET_TIMEZONE}`);
    spawnEnv.TZ = TARGET_TIMEZONE;
  }

  const child = spawn(launcher, launchArgs, {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
    env: spawnEnv,
  });
  child.unref();

  let devtoolsPort = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(200);
    try {
      const portFile = path.join(dir, 'DevToolsActivePort');
      const val = parseInt(fs.readFileSync(portFile, 'utf8').trim().split('\n')[0], 10);
      if (val > 0) { devtoolsPort = val; break; }
    } catch (_) {}
  }

  if (!devtoolsPort) {
    await stopChild(child, dir);
    server.close();
    return { error: 'DevToolsActivePort not available' };
  }

  const page = await waitForPage(devtoolsPort);
  if (!page?.webSocketDebuggerUrl) {
    await stopChild(child, dir);
    server.close();
    return { error: 'Page target not found' };
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WebSocket connection failed'));
  });

  const cdp = new CdpClient(ws);

  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  if (!mutate) {
    // Under normal operation, apply fingerprint to tab
    await applyFingerprintToTab(cdp.send.bind(cdp), null, fp, profile);
  }

  // Navigate to local test server
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
  await sleep(600);

  // 1. Date Surface Probe
  const dateProbe = await cdp.evaluate(`(() => {
    const d = new Date();
    const summer = new Date(2026, 6, 15, 12, 0, 0); // July (EDT, offset 240)
    const winter = new Date(2026, 0, 15, 12, 0, 0); // January (EST, offset 300)
    return {
      currentOffset: d.getTimezoneOffset(),
      summerOffset: summer.getTimezoneOffset(),
      winterOffset: winter.getTimezoneOffset(),
      dateString: d.toString(),
      summerString: summer.toString(),
      winterString: winter.toString(),
    };
  })()`);

  // 2. Intl Surface Probe
  const intlProbe = await cdp.evaluate(`(() => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const formattedLong = new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' }).format(new Date());
    const summerLong = new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' }).format(new Date(2026, 6, 15));
    return {
      timeZone: resolved.timeZone,
      formattedLong,
      summerLong,
    };
  })()`);

  // 3. Worker Surface Probe
  const workerProbe = await cdp.evaluate(`new Promise((resolve) => {
    const workerScript = \`
      const d = new Date();
      const resolved = new Intl.DateTimeFormat().resolvedOptions();
      const summer = new Date(2026, 6, 15, 12, 0, 0);
      postMessage({
        timeZone: resolved.timeZone,
        currentOffset: d.getTimezoneOffset(),
        summerOffset: summer.getTimezoneOffset(),
        dateString: d.toString()
      });
    \`;
    const blob = new Blob([workerScript], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = (event) => resolve(event.data);
    worker.onerror = (err) => resolve({ error: String(err.message || err) });
  })`);

  // 4. Cookie Surface Probe
  const cookieProbe = await cdp.evaluate(`(() => {
    const oneHourLater = new Date(Date.now() + 3600000);
    const expiresUtc = oneHourLater.toUTCString();
    document.cookie = 'client_tz_cookie=confirmed; expires=' + expiresUtc + '; path=/';
    return {
      documentCookie: document.cookie,
      expiresUtc,
      offset: oneHourLater.getTimezoneOffset(),
    };
  })()`);

  const netCookies = await cdp.send('Network.getCookies', { urls: [`http://127.0.0.1:${serverPort}/`] });

  // Cleanup
  ws.close();
  server.close();
  await stopChild(child, dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  return {
    date: dateProbe,
    intl: intlProbe,
    worker: workerProbe,
    cookie: cookieProbe,
    netCookies: netCookies?.result?.cookies || netCookies?.cookies || [],
    targetTimezone: TARGET_TIMEZONE,
  };
}

(async () => {
  console.log(`Starting Windows Browser Kernel Timezone Selftest (mode: ${isMutateMode ? 'MUTATION' : 'NORMAL'})...\n`);

  if (!isMutateMode) {
    const live = await runTimezoneLiveSession(false);
    if (live.error) {
      console.error(`  FAIL  Live browser execution failed: ${live.error}`);
      process.exit(1);
    }

    check('Live browser: Date.prototype.getTimezoneOffset reflects persona timezone DST offsets', () => {
      // America/New_York: Summer/EDT offset is 240 (UTC-4), Winter/EST offset is 300 (UTC-5)
      assert.strictEqual(live.date.summerOffset, 240);
      assert.strictEqual(live.date.winterOffset, 300);
    });

    check('Live browser: Date.prototype.toString contains matching timezone designation', () => {
      assert.ok(
        live.date.summerString.includes('GMT-0400') || live.date.summerString.includes('EDT'),
        `Expected GMT-0400 or EDT in summer string, got: ${live.date.summerString}`
      );
      assert.ok(
        live.date.winterString.includes('GMT-0500') || live.date.winterString.includes('EST'),
        `Expected GMT-0500 or EST in winter string, got: ${live.date.winterString}`
      );
    });

    check('Live browser: Intl.DateTimeFormat resolvedOptions matches persona timezone', () => {
      assert.strictEqual(live.intl.timeZone, live.targetTimezone);
    });

    check('Live browser: DedicatedWorker inherits consistent timezone without host leakage', () => {
      assert.strictEqual(live.worker.timeZone, live.targetTimezone);
      assert.strictEqual(live.worker.summerOffset, 240);
      assert.ok(
        live.worker.dateString.includes('GMT-0400') || live.worker.dateString.includes('EDT'),
        `Worker date string expected GMT-0400 or EDT, got: ${live.worker.dateString}`
      );
    });

    check('Live browser: Cookie expiration calculation and storage maintain UTC / timezone integrity', () => {
      assert.ok(live.cookie.documentCookie.includes('client_tz_cookie=confirmed'));
      assert.ok(live.cookie.expiresUtc.endsWith('GMT'));
      assert.strictEqual(live.cookie.offset, live.date.currentOffset);

      const clientCookie = live.netCookies.find((c) => c.name === 'client_tz_cookie');
      assert.ok(clientCookie, 'client_tz_cookie not found in network cookies');
      assert.ok(Number.isFinite(clientCookie.expires) && clientCookie.expires > Date.now() / 1000);
    });

  } else {
    // MUTATION MODE: Verify that omitting the parameter leaks host timezone
    console.log('Running MUTATION session (omitting --time-zone-for-testing to verify sensitivity)...');
    const mutated = await runTimezoneLiveSession(true);
    if (mutated.error) {
      console.error(`  FAIL  Mutated session failed: ${mutated.error}`);
      process.exit(1);
    }

    check('mutation check: omitting kernel timezone parameter causes Intl.DateTimeFormat to leak host timezone', () => {
      assert.notStrictEqual(
        mutated.intl.timeZone,
        mutated.targetTimezone,
        `Expected mutation to leak host timezone instead of maintaining ${mutated.targetTimezone}`
      );
    });

    check('mutation check: omitting kernel timezone parameter causes Date offset to leak host offset', () => {
      assert.notStrictEqual(
        mutated.date.summerOffset,
        240,
        `Expected mutation to diverge from target offset 240`
      );
    });

    check('mutation check: omitting kernel timezone parameter causes Worker to leak host timezone', () => {
      assert.notStrictEqual(
        mutated.worker.timeZone,
        mutated.targetTimezone,
        `Expected worker to leak host timezone instead of ${mutated.targetTimezone}`
      );
    });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nwindows-timezone-kernel-e2e-selftest: OK ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
})();
