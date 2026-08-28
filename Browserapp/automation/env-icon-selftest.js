#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { generateEnvIconPng } = require('./env-icon');

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openbrowser-env-icon-'));
  try {
    for (const size of [16, 32, 48, 128]) {
      const out = path.join(root, `icon-${size}.png`);
      generateEnvIconPng('12', size, out);
      const bytes = await fsp.readFile(out);
      assert.ok(bytes.length > 64);
      assert.strictEqual(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
    const src = fs.readFileSync(path.join(__dirname, 'env-icon.js'), 'utf8');
    assert.ok(
      !src.includes('EXTRA+=(--no-proxy-server)'),
      'macOS Dock wrapper must not inject --no-proxy-server (Chromium treats it as Direct and leaks the real IP)',
    );
    assert.ok(!/\bHAS_NOPROXY\b/.test(src), 'HAS_NOPROXY tracking is unused after the proxy leak fix');
    assert.ok(
      /ARTIFACT_STAMP_VERSION = 3/.test(src),
      'stamp version must bump so existing Dock wrappers rebuild without --no-proxy-server',
    );
    console.log('env-icon-selftest: ok');
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
