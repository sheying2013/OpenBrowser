'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { BrowserEngine, appendDiagnosticOutput, formatBrowserStartupError, writeBrowserStartupDiagnostic } = require('./engine');

async function main() {
  const output = appendDiagnosticOutput('', 'a'.repeat(20000));
  assert.strictEqual(output.length, 16 * 1024);
  assert.ok(output.endsWith('a'.repeat(100)));

  const child = { pid: 42, exitCode: 1, signalCode: null };
  const message = formatBrowserStartupError('Browser exited before CDP was ready (code 1)', child, {
    launchBinary: 'C:\\OpenBrowser\\wayfern.exe',
    profileRoot: 'C:\\Users\\test\\AppData\\Roaming\\openbrowser\\browser-profiles-v2\\env-001',
    stderr: 'ERROR: sandbox initialization failed',
  });
  assert.match(message, /exitCode=1/);
  assert.match(message, /sandbox initialization failed/);
  assert.match(message, /wayfern\.exe/);
  assert.match(message, /env-001/);

  const spawnMessage = formatBrowserStartupError('Browser process could not start: spawn ENOENT', {
    pid: 42,
    exitCode: null,
    signalCode: null,
  }, { launchBinary: 'C:\\missing\\wayfern.exe', spawnError: 'spawn ENOENT' });
  assert.match(spawnMessage, /spawn ENOENT/);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openbrowser-startup-log-'));
  try {
    await writeBrowserStartupDiagnostic(root, {
      type: 'browser-startup-failure',
      profileId: 'env-001',
      executable: 'C:\\OpenBrowser\\kernels\\windows-x64\\chrome.exe',
      stderr: 'WAYFERN - Terms and Conditions',
    });
    const logFile = path.join(root, 'logs', 'browser-startup.log');
    const rows = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].profileId, 'env-001');
    assert.match(rows[0].stderr, /Terms and Conditions/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }

  assert.strictEqual(typeof BrowserEngine.prototype.waitForPort, 'function');
  console.log('browser-startup-diagnostic-selftest: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
