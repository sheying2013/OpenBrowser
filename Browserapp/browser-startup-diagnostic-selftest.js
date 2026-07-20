'use strict';

const assert = require('assert');
const { BrowserEngine, appendDiagnosticOutput, formatBrowserStartupError } = require('./engine');

function main() {
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

  assert.strictEqual(typeof BrowserEngine.prototype.waitForPort, 'function');
  console.log('browser-startup-diagnostic-selftest: ok');
}

main();
