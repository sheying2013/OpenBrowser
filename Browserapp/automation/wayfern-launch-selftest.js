#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ensureKernelReadyForLaunch, termsAcceptanceArgsForKernel } = require('./browser-kernel');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDevToolsPort(root, child) {
  const portFile = path.join(root, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (fs.existsSync(portFile)) {
      const port = Number(String(await fsp.readFile(portFile, 'utf8')).split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
    if (child.exitCode !== null) break;
    await sleep(500);
  }
  return null;
}

async function main() {
  const binary = path.resolve(String(process.argv[2] || process.env.WAYFERN_BINARY || ''));
  assert.ok(binary && fs.existsSync(binary), 'Wayfern binary path is required');

  await ensureKernelReadyForLaunch({ path: binary });

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openbrowser-wayfern-launch-'));
  let child;
  try {
    const termsArgs = termsAcceptanceArgsForKernel({ path: binary });
    assert.deepStrictEqual(termsArgs, ['--accept-terms-and-conditions']);
    // Long-lived browser spawn must NOT include accept-terms (that flag exits after recording license).
    child = spawn(binary, [
      `--user-data-dir=${root}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      'about:blank',
    ], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.resume();
    child.stderr?.resume();
    const port = await waitForDevToolsPort(root, child);
    assert.ok(port, `Wayfern did not become CDP-ready, exitCode=${child.exitCode}`);
    console.log(`wayfern-launch-selftest: ok port=${port}`);
  } finally {
    if (child && child.exitCode === null) child.kill();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
