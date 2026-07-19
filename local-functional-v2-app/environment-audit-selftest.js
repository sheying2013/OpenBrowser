const assert = require('assert');
const { build, isDirect } = require('./environment-audit');

const local = build({
  id: 'env-001',
  proxy: 'Direct',
  os: 'Windows',
  privacy: { webrtc: 'real', timezoneMode: 'real', geoMode: 'disabled', canvas: 'real', webgl: 'real', webgpu: 'real', media: 'blocked' },
  advanced: { saveCookies: true, saveLocalStorage: true, saveIndexedDB: true, saveHistory: true }
}, { systemTimezone: 'Asia/Shanghai' });

assert.equal(isDirect('Direct'), true);
assert.equal(local.checks.find((item) => item.id === 'profile').state, 'pass');
assert.equal(local.checks.find((item) => item.id === 'fingerprint').state, 'info');

const unverifiedProxy = build({
  id: 'env-002',
  proxy: 'socks5://user:password@127.0.0.1:1080',
  os: 'macOS',
  userAgent: 'Custom UA',
  privacy: { webrtc: 'real', timezoneMode: 'ip', geoMode: 'ip', canvas: 'blocked', webgl: 'blocked', webgpu: 'blocked', media: 'real' },
  advanced: {}
});

assert.ok(unverifiedProxy.warnings >= 4);
assert.equal(unverifiedProxy.checks.find((item) => item.id === 'proxy').state, 'warn');
assert.equal(JSON.stringify(unverifiedProxy).includes('password'), false, 'audit must not expose proxy credentials');
console.log('Environment audit self-test passed');
