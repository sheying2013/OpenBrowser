'use strict';

// Behavior test for BrowserEngine.waitForPort — the CDP-port readiness wait on the launch
// critical path. Verifies the event-driven (fs.watch) fast path + polling fallback resolve
// correctly and that every failure path (child exit / spawn error / timeout) still throws.
// waitForPort does not use `this`, so it is driven directly against a fake CDP endpoint.

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { BrowserEngine } = require('./engine.js');

const waitForPort = BrowserEngine.prototype.waitForPort;
const ctx = {};

function fakeCdp() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1/x', Browser: 'Fake/1' }));
      } else { res.writeHead(404); res.end(); }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const mkTmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'wfp-'));
let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  PASS  ' + n); passed += 1; };

(async () => {
  // Event-driven / poll: file appears mid-wait → resolves to that port, promptly.
  {
    const srv = await fakeCdp(); const port = srv.address().port;
    const dir = await mkTmp();
    const t0 = Date.now();
    const p = waitForPort.call(ctx, dir, 5000, null);
    setTimeout(() => fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), port + '\n/devtools/x'), 150);
    const got = await p; const dt = Date.now() - t0;
    ok('resolves to the written port', got === port);
    ok(`detected promptly after write (<600ms): ${dt}ms`, dt < 600);
    srv.close();
  }
  // File already present at call time → immediate resolve.
  {
    const srv = await fakeCdp(); const port = srv.address().port;
    const dir = await mkTmp();
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), port + '\n/devtools/y');
    ok('immediate detection when file pre-exists', (await waitForPort.call(ctx, dir, 5000, null)) === port);
    srv.close();
  }
  // Child exited before the port was ready → throws (never hangs to timeout).
  {
    const dir = await mkTmp(); let threw = false;
    try { await waitForPort.call(ctx, dir, 5000, { exitCode: 1, signalCode: null, _startupDiagnostic: {} }); }
    catch (e) { threw = /exited before CDP/.test(e.message); }
    ok('throws when child already exited', threw);
  }
  // spawn error surfaces immediately.
  {
    const dir = await mkTmp(); let threw = false;
    try { await waitForPort.call(ctx, dir, 5000, { exitCode: null, _startupDiagnostic: { spawnError: 'ENOENT' } }); }
    catch (e) { threw = /could not start: ENOENT/.test(e.message); }
    ok('throws on spawnError', threw);
  }
  // Never-appears → clean timeout error.
  {
    const dir = await mkTmp(); let threw = false;
    try { await waitForPort.call(ctx, dir, 300, null); }
    catch (e) { threw = /port was not ready/.test(e.message); }
    ok('times out cleanly when file never appears', threw);
  }
  console.log(`\nwaitforport-selftest: ${passed} checks passed.`);
  process.exit(0);
})().catch((e) => { console.error('waitforport-selftest FAILED:', e); process.exit(1); });
