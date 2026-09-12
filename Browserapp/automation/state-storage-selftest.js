'use strict';

/** Self-test for atomic state writes and transient filesystem retries. */

const assert = require('assert');
const fsp = require('fs/promises');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  writeJsonAtomically,
  writeRawAtomically,
} = require('../engine/state-storage');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, err: error.message || String(error) }); }
}

async function withPatchedOpen(failures, fn) {
  const original = fsp.open;
  let remaining = failures;
  fsp.open = async (...args) => {
    const target = String(args[0] || '');
    if (remaining > 0 && target.includes('.tmp-')) {
      remaining -= 1;
      const error = new Error('simulated transient open failure');
      error.code = 'ENOENT';
      throw error;
    }
    return original.apply(fsp, args);
  };
  try { return await fn(); } finally { fsp.open = original; }
}

async function withPatchedRename(failures, fn) {
  const original = fsp.rename;
  let remaining = failures;
  fsp.rename = async (...args) => {
    if (remaining > 0) {
      remaining -= 1;
      const error = new Error('simulated transient rename failure');
      error.code = 'EINVAL';
      throw error;
    }
    return original.apply(fsp, args);
  };
  try { return await fn(); } finally { fsp.rename = original; }
}

(async () => {
  await check('writeRawAtomically retries a transient open error', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'state-storage-'));
    const file = path.join(root, 'state.json');
    try {
      await withPatchedOpen(1, () => writeRawAtomically(file, '{"ok":true}', 0o600));
      assert.strictEqual(await fsp.readFile(file, 'utf8'), '{"ok":true}');
      const leftovers = (await fsp.readdir(root)).filter((name) => name.startsWith('state.json.tmp-'));
      assert.deepStrictEqual(leftovers, []);
    } finally {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  await check('writeRawAtomically retries a transient rename error', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'state-storage-'));
    const file = path.join(root, 'state.json');
    try {
      await withPatchedRename(1, () => writeRawAtomically(file, '{"renamed":true}', 0o600));
      assert.strictEqual(await fsp.readFile(file, 'utf8'), '{"renamed":true}');
      const leftovers = (await fsp.readdir(root)).filter((name) => name.startsWith('state.json.tmp-'));
      assert.deepStrictEqual(leftovers, []);
    } finally {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  await check('writeRawAtomically gives up after four transient failures', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'state-storage-'));
    const file = path.join(root, 'state.json');
    try {
      await assert.rejects(() => withPatchedOpen(4, () => writeRawAtomically(file, 'x', 0o600)), /transient open failure/);
      assert.strictEqual(fs.existsSync(file), false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  await check('writeJsonAtomically creates a backup and keeps the new state', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'state-storage-'));
    const file = path.join(root, 'state.json');
    try {
      await writeJsonAtomically(file, '{"version":1}');
      await writeJsonAtomically(file, '{"version":2}');
      assert.strictEqual(await fsp.readFile(file, 'utf8'), '{"version":2}');
      assert.strictEqual(await fsp.readFile(file + '.bak', 'utf8'), '{"version":1}');
    } finally {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  const failed = results.filter((item) => !item.ok);
  for (const item of results) {
    if (item.ok) console.log('  PASS  ' + item.name);
    else console.error('  FAIL  ' + item.name + ': ' + item.err);
  }
  if (failed.length) {
    console.error(`state-storage-selftest: FAIL ${results.length - failed.length}/${results.length}`);
    process.exitCode = 1;
  } else {
    console.log(`state-storage-selftest: OK ${results.length}/${results.length}`);
  }
})();
