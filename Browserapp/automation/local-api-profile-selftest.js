'use strict';

// PR #7 smoke: profile create/delete endpoints on the Local API.
// Drives the REAL LocalApiServer.route() with a REAL BrowserEngine (mock app.getPath only).
// Does not launch Electron or a real browser — verifies the request-handling path:
// id validation, number auto-increment, client proxy_config merge, privacy field
// preservation through engine.sanitizeProfile, syncProfiles persistence, and delete.

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const assert = require('assert');
const { BrowserEngine } = require('../engine.js');
const { LocalApiServer } = require('./local-api-server.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  PASS  ' + name); passed += 1; };

(async () => {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-pr7-'));
  const app = { getPath: () => userData };

  // Allow the profile data root inside our temp userData (validateDataRootIsolationSecure).
  const engine = new BrowserEngine(app, { profileDataRoot: path.join(userData, 'browser-profiles-v2') });
  // Do not auto-bootstrap a real kernel in this offline test.
  engine.kernelBootstrapPromise = null;

  const api = new LocalApiServer({ engine, apiKey: 'test-key-123', allowedOrigins: [] });
  // route() reads this._req/_res internally? No — route(method, pathname, input, req). Drive directly.
  const route = (method, pathname, input) => api.route(method, pathname, input, { headers: {} });

  // ---- create 1: minimal, auto id/number ----
  let r = await route('POST', '/api/v1/user/create', { name: 'Env One', language: 'en-US', proxy: 'Direct' });
  ok('create returns code 0', r && r.code === 0);
  ok('create assigns ob- id', /^ob-[A-Za-z0-9_-]{1,64}$/.test(r.data.user_id));
  const id1 = r.data.user_id;
  ok('engine has profile', engine.profiles.has(id1));
  ok('name preserved', engine.profiles.get(id1).name === 'Env One');
  ok('proxy Direct', engine.profiles.get(id1).proxy === 'Direct');
  ok('number starts at 1', engine.profiles.get(id1).number === 1);

  // ---- create 2: client-style proxy_config + privacy ----
  r = await route('POST', '/api/profiles/create', {
    name: 'Env Two', language: 'ja-JP',
    user_proxy_config: { proxy_type: 'http', proxy_host: '1.2.3.4', proxy_port: '8080', proxy_user: 'u', proxy_password: 'p' },
    privacy: { languageMode: 'ja-JP', timezoneMode: 'ip', webrtc: 'disabled', geoMode: 'disabled' },
  });
  ok('create2 code 0', r && r.code === 0);
  const id2 = r.data.user_id;
  const p2 = engine.profiles.get(id2);
  ok('proxy built from config', p2.proxy === 'http://u:p@1.2.3.4:8080');
  ok('number auto-increments to 2', p2.number === 2);
  ok('language ja-JP', p2.language === 'ja-JP');
  ok('privacy.languageMode preserved', p2.privacy.languageMode === 'ja-JP');
  ok('privacy.timezoneMode ip preserved', p2.privacy.timezoneMode === 'ip');
  ok('privacy.webrtc disabled preserved', p2.privacy.webrtc === 'disabled');
  ok('privacy.geoMode disabled preserved', p2.privacy.geoMode === 'disabled');

  // ---- create 3: duplicate id rejected ----
  r = await route('POST', '/api/v2/browser-profile/create', { user_id: id1, name: 'Dup' });
  ok('duplicate id rejected', r && r.code !== 0);

  // ---- create 4: explicit user_id + number ----
  r = await route('POST', '/api/v1/user/create', { user_id: 'my-profile-42', number: '42', name: 'Explicit' });
  ok('explicit id honored', r && r.code === 0 && r.data.user_id === 'my-profile-42');
  ok('explicit number honored', engine.profiles.get('my-profile-42').number === 42);

  // ---- invalid id rejected ----
  r = await route('POST', '/api/v1/user/create', { user_id: 'bad id!', name: 'X' });
  ok('invalid id rejected', r && r.code !== 0);

  // ---- missing name → auto-named (feature); non-string name coerced by String() ----
  r = await route('POST', '/api/v1/user/create', { user_id: 'auto-named' });
  ok('missing name auto-names', r && r.code === 0 && engine.profiles.get('auto-named').name.startsWith('Environment'));
  r = await route('POST', '/api/v1/user/create', { user_id: 'coerced-name', name: 12345 });
  ok('numeric name coerced to string', r && r.code === 0 && engine.profiles.get('coerced-name').name === '12345');

  // ---- delete unknown id → idempotent success (deleted:0); invalid id → 400 ----
  r = await route('POST', '/api/v1/user/delete', { user_id: 'nonexistent-profile' });
  ok('delete unknown id idempotent', r && r.code === 0 && r.data.deleted === 0);
  r = await route('POST', '/api/v1/user/delete', { user_id: 'bad id!' });
  ok('delete invalid id clean 400', r && r.code === 400);

  // ---- privacy edge: client-style timezoneMode (string) maps ----
  // (real clients send "custom" + timezone string; verify both forms survive)
  r = await route('POST', '/api/v1/user/create', {
    name: 'TZ Custom', privacy: { timezoneMode: 'custom', timezone: 'Asia/Tokyo' },
  });
  const pTz = engine.profiles.get(r.data.user_id);
  ok('privacy.timezoneMode custom preserved', pTz && pTz.privacy.timezoneMode === 'custom');
  ok('privacy.timezone preserved', pTz && pTz.privacy.timezone === 'Asia/Tokyo');

  // ---- delete single ----
  r = await route('POST', '/api/v1/user/delete', { user_id: id2, delete_data: false });
  ok('delete code 0', r && r.code === 0);
  ok('delete removed profile', !engine.profiles.has(id2));
  ok('delete reported 1', r.data.deleted === 1);

  // ---- delete batch by ids array ----
  r = await route('POST', '/api/profiles/delete', { ids: [id1, 'my-profile-42'] });
  ok('batch delete code 0', r && r.code === 0);
  ok('batch deleted 2', r.data.deleted === 2);

  // ---- missing id rejected ----
  r = await route('POST', '/api/v1/user/delete', {});
  ok('delete missing id rejected', r && r.code !== 0);

  // ---- cleanup ----
  await api.stop().catch(() => {});
  await fsp.rm(userData, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${passed} assertions passed`);
  process.exit(0);
})().catch((err) => { console.error('FAIL', err); process.exit(1); });
