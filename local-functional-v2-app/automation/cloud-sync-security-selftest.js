'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const cloud = require('./cloud-sync');

async function main() {
  assert.throws(() => cloud.safeRemotePath('../outside.obpack'));
  assert.throws(() => cloud.safeRemotePath('/tmp/outside.obpack'));
  assert.throws(() => cloud.safeRemotePath('C:\\outside.obpack'));
  assert.strictEqual(cloud.safeRemotePath('profiles/env-1.obpack'), 'profiles/env-1.obpack');
  console.log('  PASS  remote backup path traversal rejected');

  assert.throws(() => cloud.webDavTarget({ url: 'http://example.com/dav', dir: 'OpenBrowser' }));
  assert.throws(() => cloud.webDavTarget({ url: 'https://example.com/dav', dir: '../outside' }));
  assert.ok(cloud.webDavTarget({ url: 'http://127.0.0.1:9000/dav', dir: 'OpenBrowser' }).target.startsWith('http://127.0.0.1:9000/'));
  console.log('  PASS  WebDAV requires HTTPS except loopback');

  assert.throws(() => cloud.validatedGitHubConfig({ owner: '../x', repo: 'repo', token: 't' }, cloud.REMOTE_NAME));
  assert.throws(() => cloud.validatedGitHubConfig({ owner: 'owner', repo: 'repo', token: 't', branch: '../main' }, cloud.REMOTE_NAME));
  console.log('  PASS  GitHub repository and branch validation');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-cloud-'));
  try {
    assert.throws(() => cloud.safeLocalTarget(root, '../../outside.obpack'));
    if (process.platform !== 'win32') {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-cloud-outside-'));
      const link = path.join(root, 'profiles');
      await fs.symlink(outside, link);
      await assert.rejects(() => cloud.upload('local', { dir: root }, Buffer.from('x'), 'profiles/env.obpack'));
      await fs.rm(outside, { recursive: true, force: true });
    }
    console.log('  PASS  local backup symlink escape rejected');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
