#!/usr/bin/env node
'use strict';

/**
 * CookieRobot Self-Test:
 * 1. Pure logic unit tests covering:
 *    - Configuration parsing and boundary clamping
 *    - Target URL normalization
 *    - Random walk plan generation with duration variance
 *    - Human-like Bezier mouse trajectory calculations
 * 2. E2E live kernel test covering:
 *    - Local loopback HTTP service setting cookies and internal navigation links
 *    - Headless kernel startup (mirroring new-tab-resume-first-e2e-selftest.js pattern)
 *    - Multi-site automated random walk with human pacing and scroll/click simulation
 *    - Verification of JSONL audit records (domain, timestamp, pages, cookie delta)
 *    - Event sequencing (robot-started -> progress -> robot-finished)
 *    - Clean interruption and resource teardown via robot.stop()
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const {
  CookieRobot,
  DEFAULT_CONFIG,
  normalizeRobotConfig,
  normalizeTargetUrl,
  generateWalkPlan,
  generateMouseTrajectory,
  bezierPoint,
} = require('./cookie-robot');

const { buildFingerprint } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
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
  } catch (error) {
    results.push({ name, ok: false, error: error.message || String(error) });
    console.log('  FAIL  ' + name + ' - ' + (error.message || error));
    process.exitCode = 1;
  }
}

async function asyncCheck(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('  PASS  ' + name);
  } catch (error) {
    results.push({ name, ok: false, error: error.message || String(error) });
    console.log('  FAIL  ' + name + ' - ' + (error.message || error));
    process.exitCode = 1;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stopChild(child, dir) {
  try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { if (child?.pid) process.kill(child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync('pkill -f "user-data-dir=' + dir + '" 2>/dev/null || true'); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// =========================================================================
// SECTION 1: PURE LOGIC UNIT TESTS
// =========================================================================

check('normalizeTargetUrl handles diverse url/domain formats', () => {
  assert.strictEqual(normalizeTargetUrl(''), null);
  assert.strictEqual(normalizeTargetUrl('   '), null);

  const plain = normalizeTargetUrl('example.com');
  assert.strictEqual(plain.url, 'https://example.com/');
  assert.strictEqual(plain.domain, 'example.com');

  const httpUrl = normalizeTargetUrl('http://test.org/path?q=1');
  assert.strictEqual(httpUrl.url, 'http://test.org/path?q=1');
  assert.strictEqual(httpUrl.domain, 'test.org');

  const loopback = normalizeTargetUrl('127.0.0.1:8080/foo');
  assert.strictEqual(loopback.url, 'http://127.0.0.1:8080/foo');
  assert.strictEqual(loopback.domain, '127.0.0.1');

  const localhost = normalizeTargetUrl('localhost:3000');
  assert.strictEqual(localhost.url, 'http://localhost:3000/');
  assert.strictEqual(localhost.domain, 'localhost');
});

check('normalizeRobotConfig applies defaults and clamps bounds correctly', () => {
  const def = normalizeRobotConfig({});
  assert.deepStrictEqual(def.domains, DEFAULT_CONFIG.domains);
  assert.strictEqual(def.stayDurationMin, DEFAULT_CONFIG.stayDurationMin);
  assert.strictEqual(def.stayDurationMax, DEFAULT_CONFIG.stayDurationMax);
  assert.strictEqual(def.walkDepth, DEFAULT_CONFIG.walkDepth);
  assert.strictEqual(def.scrollProbability, DEFAULT_CONFIG.scrollProbability);
  assert.strictEqual(def.clickProbability, DEFAULT_CONFIG.clickProbability);
  assert.strictEqual(def.maxRetries, DEFAULT_CONFIG.maxRetries);

  // String domains split by newlines and commas
  const custom = normalizeRobotConfig({
    domains: 'site1.com\nsite2.com, site3.com\r\n',
    stayDurationMin: -5,
    stayDurationMax: 2,
    walkDepth: 99,
    scrollProbability: 2.5,
    clickProbability: -1,
    maxRetries: 10,
  });
  assert.deepStrictEqual(custom.domains, ['site1.com', 'site2.com', 'site3.com']);
  assert.strictEqual(custom.stayDurationMin, 0.1); // min clamp
  assert.strictEqual(custom.stayDurationMax, 2); // clamped >= min
  assert.strictEqual(custom.walkDepth, 10); // max 10
  assert.strictEqual(custom.scrollProbability, 1.0); // max 1.0
  assert.strictEqual(custom.clickProbability, 0.0); // min 0.0
  assert.strictEqual(custom.maxRetries, 5); // max 5
});

check('generateWalkPlan creates deterministic walk sequence with custom PRNG', () => {
  let mockRandIndex = 0;
  const mockRandomValues = [0.0, 0.5, 1.0];
  const mockRandom = () => mockRandomValues[(mockRandIndex++) % mockRandomValues.length];

  const plan = generateWalkPlan({
    domains: ['alpha.com', 'beta.org', 'gamma.net'],
    stayDurationMin: 10,
    stayDurationMax: 20,
    walkDepth: 3,
  }, { random: mockRandom });

  assert.strictEqual(plan.totalSites, 3);
  assert.strictEqual(plan.sites[0].domain, 'alpha.com');
  assert.strictEqual(plan.sites[0].stayDurationSec, 10.0); // 10 + 0.0 * 10
  assert.strictEqual(plan.sites[1].domain, 'beta.org');
  assert.strictEqual(plan.sites[1].stayDurationSec, 15.0); // 10 + 0.5 * 10
  assert.strictEqual(plan.sites[2].domain, 'gamma.net');
  assert.strictEqual(plan.sites[2].stayDurationSec, 20.0); // 10 + 1.0 * 10
  assert.strictEqual(plan.totalEstimatedDurationSec, 45.0);
});

check('generateMouseTrajectory calculates smooth Bezier curve points', () => {
  const p0 = bezierPoint(0, 0, 10, 20, 30);
  assert.strictEqual(p0, 0);
  const p1 = bezierPoint(1, 0, 10, 20, 30);
  assert.strictEqual(p1, 30);

  const trajectory = generateMouseTrajectory(100, 100, 500, 400, { steps: 10 });
  assert.ok(trajectory.length >= 8 && trajectory.length <= 15, `expected steps, got ${trajectory.length}`);
  const last = trajectory[trajectory.length - 1];
  assert.ok(Math.abs(last.x - 500) <= 3, `x should approach target: ${last.x}`);
  assert.ok(Math.abs(last.y - 400) <= 3, `y should approach target: ${last.y}`);

  // Short distance returns minimal points
  const shortDist = generateMouseTrajectory(100, 100, 101, 101);
  assert.strictEqual(shortDist.length, 1);
  assert.strictEqual(shortDist[0].x, 101);
  assert.strictEqual(shortDist[0].y, 101);
});

// =========================================================================
// SECTION 2: LIVE KERNEL + LOOPBACK HTTP SERVER E2E INTEGRATION
// =========================================================================

async function runLiveKernelSuite() {
  // 1. Setup local loopback HTTP server
  let serverHits = { site1: 0, subpage1: 0, site2: 0 };
  const server = http.createServer((req, res) => {
    const url = req.url;
    if (url === '/site1' || url === '/site1/') {
      serverHits.site1 += 1;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': `cookie_site1=val_${Date.now()}; Path=/`,
      });
      res.end(`<!DOCTYPE html><html><head><title>Site 1 Landing</title></head>
        <body style="height: 2000px; padding: 20px;">
          <h1>Site 1 Landing Page</h1>
          <p>Welcome to test site 1.</p>
          <div style="margin: 40px 0;">
            <a id="link-subpage" href="/site1/subpage" target="_blank" style="display: inline-block; padding: 10px 20px; background: blue; color: white;">Explore Subpage</a>
          </div>
        </body></html>`);
    } else if (url === '/site1/subpage') {
      serverHits.subpage1 += 1;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': `cookie_subpage1=sub_${Date.now()}; Path=/`,
      });
      res.end(`<!DOCTYPE html><html><head><title>Site 1 Subpage</title></head>
        <body style="height: 1500px; padding: 20px;">
          <h1>Subpage Content</h1>
          <p>This is internal link content.</p>
        </body></html>`);
    } else if (url === '/site2' || url === '/site2/') {
      serverHits.site2 += 1;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': `cookie_site2=alpha_${Date.now()}; Path=/`,
      });
      res.end(`<!DOCTYPE html><html><head><title>Site 2 Landing</title></head>
        <body style="height: 1800px; padding: 20px;">
          <h1>Site 2 Content</h1>
          <p>Second test site.</p>
        </body></html>`);
    } else if (url === '/broken') {
      req.socket.destroy();
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;
  console.log(`  [Setup] Local loopback HTTP test server listening on 127.0.0.1:${serverPort}`);

  // 2. Launch headless real browser kernel
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-cookierobot-selftest-'));
  const recordFile = path.join(profileDir, 'cookie-robot-audit.jsonl');
  let child = null;
  let browserPort = 0;

  try {
    const profile = {
      id: 'cookierobot-test-profile',
      name: 'CookieRobot Test Profile',
      kernelVersion: '148.0.7778.165',
      os: 'macOS',
      privacy: { deviceProfile: 'persona' },
    };
    const fp = buildFingerprint(profile);
    await writeOpenBrowserKernelInit(profileDir, {
      fingerprint: fp,
      profile,
      templatePath: path.join(kernelRoot, 'init_template.json'),
    });

    child = spawn(launcher, [profileDir, '--headless=new', '--enable-unsafe-swiftshader', '--remote-debugging-port=0'], {
      cwd: kernelRoot,
      detached: true,
      stdio: 'ignore',
    });

    // Acquire DevToolsActivePort
    for (let i = 0; i < 80; i += 1) {
      await sleep(100);
      try {
        const val = parseInt(fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
        if (val > 0) {
          browserPort = val;
          break;
        }
      } catch (_) {}
    }
    assert.ok(browserPort > 0, 'Acquired DevToolsActivePort from kernel');

    // Acquire browser-level persistent websocket connection
    const browserWs = await cdp.browserSocket(browserPort);
    assert.ok(browserWs, 'Acquired browser websocket URL');
    const browserConn = await cdp.connect(browserWs);

    // 3. Test multi-site warm-up task execution
    await asyncCheck('CookieRobot executes full multi-site random walk and sets cookies', async () => {
      const events = [];
      const robot = new CookieRobot({
        port: browserPort,
        cdpConnection: browserConn,
        profileId: profile.id,
        profile,
        root: profileDir,
        config: {
          domains: [
            `127.0.0.1:${serverPort}/site1`,
            `127.0.0.1:${serverPort}/site2`,
          ],
          stayDurationMin: 0.3,
          stayDurationMax: 0.5,
          walkDepth: 2,
          scrollProbability: 1.0,
          clickProbability: 1.0,
          maxRetries: 1,
          recordFile,
        },
        emit: (evt) => events.push(evt),
      });

      const result = await robot.start();
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.profileId, profile.id);
      assert.ok(result.totalPagesVisited >= 2, `Total pages visited: ${result.totalPagesVisited}`);
      assert.ok(result.totalCookiesAdded >= 2, `Total cookies added: ${result.totalCookiesAdded}`);

      // Verify server hit counters
      assert.ok(serverHits.site1 >= 1, 'Site 1 was visited');
      assert.ok(serverHits.subpage1 >= 1, 'Site 1 subpage was visited via target=_blank link');
      assert.ok(serverHits.site2 >= 1, 'Site 2 was visited');

      // Verify target=_blank handling: switched tab, closed old tab, tab count stays strictly 1
      const switchedTab = events.some((e) => e.phase === 'switch-tab');
      assert.strictEqual(switchedTab, true, 'switch-tab event emitted when following target=_blank link');
      const finalTabs = await cdp.tabs(browserPort);
      assert.strictEqual(finalTabs.length, 1, `Surplus tabs pruned; exactly 1 active tab remains (actual: ${finalTabs.length})`);

      // Verify event sequence
      assert.ok(events.length >= 4, `Event count: ${events.length}`);
      assert.strictEqual(events[0].type, 'robot-started');
      assert.strictEqual(events[0].totalSites, 2);

      const progressEvents = events.filter((e) => e.type === 'robot-progress');
      assert.ok(progressEvents.length >= 2, 'Has progress events');

      const finishEvent = events.find((e) => e.type === 'robot-finished');
      assert.ok(finishEvent, 'robot-finished event emitted');
      assert.strictEqual(finishEvent.status, 'completed');
      assert.strictEqual(finishEvent.aborted, false);

      // Verify JSONL record file output
      assert.ok(fs.existsSync(recordFile), 'JSONL record file was created');
      const lines = fs.readFileSync(recordFile, 'utf8').trim().split('\n').filter(Boolean);
      assert.strictEqual(lines.length, 2, 'JSONL contains 2 site records');

      const rec1 = JSON.parse(lines[0]);
      assert.strictEqual(rec1.domain, '127.0.0.1');
      assert.strictEqual(rec1.status, 'completed');
      assert.ok(rec1.pagesVisited >= 1);
      assert.ok(rec1.cookiesAdded >= 1);
      assert.ok(rec1.totalCookies >= 1);
      assert.ok(rec1.durationMs > 0);

      const rec2 = JSON.parse(lines[1]);
      assert.strictEqual(rec2.domain, '127.0.0.1');
      assert.strictEqual(rec2.status, 'completed');
      assert.ok(rec2.cookiesAdded >= 1);
    });

    // 4. Test interruption / cancellation (clean stop)
    await asyncCheck('CookieRobot stops cleanly when stop() is called mid-flight', async () => {
      const stopEvents = [];
      const stopRecordFile = path.join(profileDir, 'cookie-robot-stop-test.jsonl');
      const robot = new CookieRobot({
        port: browserPort,
        cdpConnection: browserConn,
        profileId: profile.id,
        profile,
        root: profileDir,
        config: {
          domains: [
            `127.0.0.1:${serverPort}/site1`,
            `127.0.0.1:${serverPort}/site2`,
          ],
          stayDurationMin: 5.0, // Long stay
          stayDurationMax: 10.0,
          walkDepth: 1,
          recordFile: stopRecordFile,
        },
        emit: (evt) => stopEvents.push(evt),
      });

      const startPromise = robot.start();
      assert.strictEqual(robot.isRunning(), true);

      // Wait brief moment for navigation to start, then stop
      await sleep(400);
      await robot.stop();

      const result = await startPromise;
      assert.strictEqual(result.status, 'stopped');
      assert.strictEqual(robot.isRunning(), false);

      const finishEvent = stopEvents.find((e) => e.type === 'robot-finished');
      assert.ok(finishEvent, 'robot-finished event emitted on stop');
      assert.strictEqual(finishEvent.status, 'stopped');
      assert.strictEqual(finishEvent.aborted, true);
    });

    // 5. Test site-level failure retry and skip
    await asyncCheck('CookieRobot retries and gracefully skips inaccessible site without crashing the task', async () => {
      const skipRecordFile = path.join(profileDir, 'cookie-robot-skip-test.jsonl');
      const robot = new CookieRobot({
        port: browserPort,
        cdpConnection: browserConn,
        profileId: profile.id,
        profile,
        root: profileDir,
        config: {
          domains: [
            `127.0.0.1:${serverPort}/broken`,
            `127.0.0.1:${serverPort}/site2`,
          ],
          stayDurationMin: 0.2,
          stayDurationMax: 0.4,
          walkDepth: 1,
          maxRetries: 1,
          navigationTimeoutMs: 3000,
          recordFile: skipRecordFile,
        },
      });

      const result = await robot.start();
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.records.length, 2);
      assert.strictEqual(result.records[0].status, 'skipped');
      assert.strictEqual(result.records[1].status, 'completed');
    });

    try { browserConn.close(); } catch (_) {}
  } finally {
    // Teardown
    await stopChild(child, profileDir);
    server.close();
    console.log('  [Teardown] Kernel child stopped and loopback server closed.');
  }

  // 6. Test BrowserEngine CookieRobot method contracts
  await asyncCheck('BrowserEngine exposes CookieRobot start, stop and getRecords methods', async () => {
    const { BrowserEngine } = require('../engine');
    assert.strictEqual(typeof BrowserEngine.prototype.startCookieRobot, 'function');
    assert.strictEqual(typeof BrowserEngine.prototype.stopCookieRobot, 'function');
    assert.strictEqual(typeof BrowserEngine.prototype.getCookieRobotRecords, 'function');
    assert.strictEqual(typeof BrowserEngine.prototype.getCookieRobotStatus, 'function');

    const fakeApp = { getPath: () => os.tmpdir() };
    const engine = new BrowserEngine(fakeApp);
    await assert.rejects(
      () => engine.startCookieRobot('non-existent-profile'),
      { code: 'PROFILE_NOT_RUNNING' },
      'startCookieRobot must reject when environment is not running'
    );
  });
}

async function main() {
  console.log('Running CookieRobot Self-Tests...');
  await runLiveKernelSuite();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nCookieRobot Selftest Summary: ${results.length - failed.length}/${results.length} PASSED`);
  if (failed.length) {
    console.error('Failed checks:', failed.map((f) => f.name));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal selftest error:', err);
  process.exit(1);
});
