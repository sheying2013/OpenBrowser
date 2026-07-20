#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveNpmCommand } = require('./ensure-host-runtime.js');

const npm = resolveNpmCommand(['--version']);

assert.ok(npm && typeof npm.command === 'string' && npm.command.length > 0);
assert.ok(Array.isArray(npm.args));
assert.ok(npm.args.includes('--version'));

if (process.platform === 'win32') {
  assert.ok(
    npm.command === process.execPath || path.basename(npm.command).toLowerCase() === 'cmd.exe',
    'Windows npm should run through node.exe npm-cli.js or cmd.exe fallback'
  );
}

const result = spawnSync(npm.command, npm.args, { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
assert.strictEqual(result.status, 0);

console.log('ensure-host-runtime selftest: ok');
