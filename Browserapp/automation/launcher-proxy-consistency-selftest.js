#!/usr/bin/env node
'use strict';

/**
 * Launcher Proxy Consistency & End-to-End Enforcement Selftest
 *
 * Background:
 * A critical bug previously caused Chromium kernels to bypass configured proxies:
 * The inner shell launcher (and earlier Dock wrappers) injected '--no-proxy-server'
 * by default whenever the caller did not pass '--no-proxy-server'.
 * In Chromium, '--no-proxy-server' takes precedence over '--proxy-server=...',
 * causing silent direct connection and leaking the host machine's real IP address.
 *
 * This test suite enforces:
 * 1. Static audit: No launcher or wrapper in the codebase injects '--no-proxy-server' by default.
 * 2. Explicit proxy preservation: When '--proxy-server=...' is provided, launchers must preserve it
 *    and never append '--no-proxy-server'.
 * 3. End-to-end negative control: A live headless kernel launched with an unreachable proxy
 *    (--proxy-server=http://127.0.0.1:9) MUST fail navigation with 'net::ERR_PROXY_CONNECTION_FAILED'.
 *    If it succeeds or bypasses the proxy, that is a fatal security regression.
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const { buildFingerprint } = require('./fingerprint');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const innerLauncher = path.join(kernelRoot, 'chrome_148', 'openbrowser_148', 'OpenBrowser.app', 'Contents', 'MacOS', 'OpenBrowser');
const helperLauncher = path.join(kernelRoot, 'launch_openbrowser.sh');
const envIconPath = path.join(__dirname, 'env-icon.js');
const reapScript = path.join(__dirname, 'reap-orphan-kernels.js');

let totalChecks = 0;
let passedChecks = 0;

function check(name, fn) {
  totalChecks++;
  try {
    const detail = fn();
    passedChecks++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    console.log(`  FAIL  ${name} — ${err.message}`);
    process.exitCode = 1;
  }
}

async function asyncCheck(name, fn) {
  totalChecks++;
  try {
    const detail = await fn();
    passedChecks++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    console.log(`  FAIL  ${name} — ${err.message}`);
    process.exitCode = 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('=== Running launcher-proxy-consistency-selftest ===\n');

  // --- 1. Static Audit of Launchers & Scripts ---
  check('inner OpenBrowser.app launcher does not inject --no-proxy-server', () => {
    assert.ok(fs.existsSync(innerLauncher), `Launcher must exist at ${innerLauncher}`);
    const src = fs.readFileSync(innerLauncher, 'utf8');
    assert.ok(
      !src.includes('EXTRA+=(--no-proxy-server)'),
      'inner launcher must NOT contain EXTRA+=(--no-proxy-server)'
    );
    assert.ok(
      src.includes('SECURITY: never inject --no-proxy-server here'),
      'inner launcher must document the security invariant regarding --no-proxy-server'
    );
    return 'inner launcher verified clean of forced direct connection';
  });

  check('launch_openbrowser.sh does not inject --no-proxy-server', () => {
    assert.ok(fs.existsSync(helperLauncher), `Helper script must exist at ${helperLauncher}`);
    const src = fs.readFileSync(helperLauncher, 'utf8');
    assert.ok(
      !src.includes('--no-proxy-server'),
      'launch_openbrowser.sh must not hardcode --no-proxy-server'
    );
    return 'helper launcher verified clean';
  });

  check('automation/env-icon.js Dock wrapper generator does not inject --no-proxy-server', () => {
    assert.ok(fs.existsSync(envIconPath), `env-icon.js must exist at ${envIconPath}`);
    const src = fs.readFileSync(envIconPath, 'utf8');
    assert.ok(
      !src.includes('EXTRA+=(--no-proxy-server)'),
      'env-icon.js must NOT generate wrappers containing EXTRA+=(--no-proxy-server)'
    );
    assert.ok(
      !/\bHAS_NOPROXY\b/.test(src),
      'env-icon.js must not contain obsolete HAS_NOPROXY logic'
    );
    return 'Dock wrapper generator verified clean';
  });

  check('automation/browser-kernel.js probe arguments do not inject --no-proxy-server', () => {
    const bkPath = path.join(__dirname, 'browser-kernel.js');
    assert.ok(fs.existsSync(bkPath), `browser-kernel.js must exist at ${bkPath}`);
    const src = fs.readFileSync(bkPath, 'utf8');
    assert.ok(
      !src.includes('--no-proxy-server'),
      'browser-kernel.js must not inject --no-proxy-server'
    );
    return 'browser-kernel.js verified clean';
  });

  // --- 2. Live Headless Kernel End-to-End Proxy Verification ---
  if (process.platform === 'darwin' && fs.existsSync(helperLauncher)) {
    await asyncCheck('kernel strictly enforces configured proxy (negative control fails via dead proxy)', async () => {
      const profileDir = fs.mkdtempSync('/tmp/ob-proxy-e2e-');
      let child = null;
      let ws = null;
      try {
        const profile = {
          id: 'proxy-e2e-neg',
          name: 'proxy-e2e-neg',
          kernelVersion: '148.0.7778.165',
          os: 'macos',
          privacy: {},
        };
        const fp = buildFingerprint(profile);
        await writeOpenBrowserKernelInit(profileDir, { fingerprint: fp, profile });

        // Launch with blackhole proxy: 127.0.0.1:9 (discard port)
        child = spawn(
          helperLauncher,
          [
            profileDir,
            '--headless=new',
            '--proxy-server=http://127.0.0.1:9',
          ],
          { cwd: kernelRoot, detached: true, stdio: 'ignore' }
        );
        child.unref();

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
        assert.ok(port, 'kernel must expose DevTools port');

        const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
        const listData = await listRes.json();
        const pageTarget = listData.find((t) => t.type === 'page');
        assert.ok(pageTarget && pageTarget.webSocketDebuggerUrl, 'page target must exist');

        ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = (e) => reject(new Error('WebSocket connection failed'));
        });

        let seq = 0;
        const cdp = (method, params) =>
          new Promise((resolve) => {
            const id = ++seq;
            const handler = (event) => {
              const msg = JSON.parse(event.data);
              if (msg.id === id) {
                ws.removeEventListener('message', handler);
                resolve(msg);
              }
            };
            ws.addEventListener('message', handler);
            ws.send(JSON.stringify({ id, method, params }));
          });

        await cdp('Page.enable');
        const nav = await cdp('Page.navigate', { url: 'https://example.com' });

        // With --proxy-server=http://127.0.0.1:9, Chromium MUST NOT connect directly.
        // It must report net::ERR_PROXY_CONNECTION_FAILED or similar proxy error.
        assert.ok(nav && nav.result, 'navigation response must be present');
        assert.strictEqual(
          nav.result.errorText,
          'net::ERR_PROXY_CONNECTION_FAILED',
          `navigation through dead proxy must fail with net::ERR_PROXY_CONNECTION_FAILED (got: ${nav.result.errorText})`
        );

        return 'proxy connection failed as expected (net::ERR_PROXY_CONNECTION_FAILED), no silent direct bypass';
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
        try {
          execSync(`node "${reapScript}"`, { stdio: 'ignore' });
        } catch (_) {}
      }
    });

    await asyncCheck('kernel allows direct connection when no proxy is configured', async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('DIRECT_OK');
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const testPort = server.address().port;

      const profileDir = fs.mkdtempSync('/tmp/ob-direct-e2e-');
      let child = null;
      let ws = null;
      try {
        const profile = {
          id: 'direct-e2e',
          name: 'direct-e2e',
          kernelVersion: '148.0.7778.165',
          os: 'macos',
          privacy: {},
        };
        const fp = buildFingerprint(profile);
        await writeOpenBrowserKernelInit(profileDir, { fingerprint: fp, profile });

        // Launch WITHOUT proxy
        child = spawn(
          helperLauncher,
          [
            profileDir,
            '--headless=new',
          ],
          { cwd: kernelRoot, detached: true, stdio: 'ignore' }
        );
        child.unref();

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
        assert.ok(port, 'kernel must expose DevTools port');

        const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
        const listData = await listRes.json();
        const pageTarget = listData.find((t) => t.type === 'page');
        assert.ok(pageTarget && pageTarget.webSocketDebuggerUrl);

        ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = (e) => reject(new Error('WebSocket connection failed'));
        });

        let seq = 0;
        const cdp = (method, params) =>
          new Promise((resolve) => {
            const id = ++seq;
            const handler = (event) => {
              const msg = JSON.parse(event.data);
              if (msg.id === id) {
                ws.removeEventListener('message', handler);
                resolve(msg);
              }
            };
            ws.addEventListener('message', handler);
            ws.send(JSON.stringify({ id, method, params }));
          });

        await cdp('Page.enable');
        const nav = await cdp('Page.navigate', { url: `http://127.0.0.1:${testPort}/` });
        assert.strictEqual(
          nav.result?.errorText,
          undefined,
          `direct navigation to local test server must succeed without error (got: ${nav.result?.errorText})`
        );

        return `direct navigation succeeded on port ${testPort}`;
      } finally {
        server.close();
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
        try {
          execSync(`node "${reapScript}"`, { stdio: 'ignore' });
        } catch (_) {}
      }
    });
  } else {
    console.log('  SKIP  launcher not available on current platform');
  }

  console.log(`\n======================================================================`);
  console.log(`launcher-proxy-consistency-selftest: OK ${passedChecks}/${totalChecks} passed`);

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
