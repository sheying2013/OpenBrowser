'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const assert = require('assert');
const { ApiKeyStore, KEY_FILE, TXT_FILE } = require('./api-key-store.js');
const { LocalApiServer } = require('./local-api-server.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  PASS  ' + name); passed += 1; };

(async () => {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-apikey-'));

  // ---- first launch: generate + persist ----
  const store1 = new ApiKeyStore(userData);
  const key1 = await store1.resolve('');
  ok('generated key is base64url 32-byte', /^[A-Za-z0-9_-]{43}$/.test(key1));
  const saved1 = JSON.parse(await fsp.readFile(path.join(userData, KEY_FILE), 'utf8'));
  ok('file written with version', saved1.version === 1);
  ok('file holds the key', saved1.apiKey === key1);
  const savedTxt = (await fsp.readFile(path.join(userData, TXT_FILE), 'utf8')).trim();
  ok('txt file in sync', savedTxt === key1);
  if (process.platform !== 'win32') {
    ok('file is 0600', (fs.statSync(path.join(userData, KEY_FILE)).mode & 0o777) === 0o600);
  }

  // ---- restart: same key comes back from disk ----
  const store2 = new ApiKeyStore(userData);
  ok('second launch reuses stored key', (await store2.resolve('')) === key1);

  // ---- env override wins, file untouched ----
  const savedBefore = await fsp.readFile(path.join(userData, KEY_FILE), 'utf8');
  const envKey = 'env-provided-key';
  ok('env key wins', (await store2.resolve(envKey)) === envKey);
  ok('env key did not rewrite file', (await fsp.readFile(path.join(userData, KEY_FILE), 'utf8')) === savedBefore);
  const store3 = new ApiKeyStore(userData);
  ok('unset env falls back to stored key', (await store3.resolve('')) === key1);

  // ---- rotate: new key, persisted ----
  const key2 = await store3.rotate();
  ok('rotate returns a different key', key2 && key2 !== key1);
  const store4 = new ApiKeyStore(userData);
  ok('rotated key is persisted', (await store4.resolve('')) === key2);

  // ---- corrupt file: regenerate, do not crash ----
  await fsp.writeFile(path.join(userData, KEY_FILE), '{ not json', 'utf8');
  await fsp.rm(path.join(userData, TXT_FILE), { force: true });
  const key3 = await new ApiKeyStore(userData).resolve('');
  ok('corrupt file regenerates key', /^[A-Za-z0-9_-]{43}$/.test(key3) && key3 !== key2);

  // ---- unwritable location: degrade to session-only key, do not throw ----
  const blocked = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-apikey-blocked-'));
  await fsp.mkdir(path.join(blocked, KEY_FILE)); // file path occupied by a directory
  const keyBlocked = await new ApiKeyStore(blocked).resolve('');
  ok('unwritable store still yields a usable key', /^[A-Za-z0-9_-]{43}$/.test(keyBlocked));

  // ---- LocalApiServer.setApiKey swaps the runtime key ----
  const api = new LocalApiServer({ apiKey: key3, allowedOrigins: [] });
  const req = (key) => ({ headers: { 'api-key': key } });
  ok('auth accepts current key', api.authOk(req(key3)));
  const key4 = await store4.rotate();
  api.setApiKey(key4);
  ok('auth rejects old key after rotate', api.authOk(req(key3)) === false);
  ok('auth accepts rotated key', api.authOk(req(key4)));
  api.setApiKey('');
  ok('setApiKey refuses empty (auth stays intact)', api.authOk(req(key4)) === true);

  console.log(`\napi-key-store selftest: ${passed} checks passed`);
})().catch((error) => {
  console.error('api-key-store selftest FAILED:', error);
  process.exit(1);
});
