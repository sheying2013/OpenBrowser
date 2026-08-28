const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { normalizeProxyRecord } = require('./automation/proxy-store');

const source = fs.readFileSync(require.resolve('./renderer.js'), 'utf8');
const start = source.indexOf('function normalizedProxyType');
const end = source.indexOf('function proxyLines');
assert(start >= 0 && end > start);
const context = { URL };
vm.runInNewContext(source.slice(start, end), context);
const editorProxyStart = source.indexOf('function parseEditorProxy');
const editorProxyEnd = source.indexOf('function editorSet', editorProxyStart);
assert(editorProxyStart >= 0 && editorProxyEnd > editorProxyStart);
vm.runInNewContext(source.slice(editorProxyStart, editorProxyEnd), context);
assert.strictEqual(context.normalizeProxy('192.0.2.10:6099:user:pass', 'socks5'), 'socks5://user:pass@192.0.2.10:6099');
assert.strictEqual(context.normalizeProxy('192.0.2.10:6099:user:pass', 'http'), 'http://user:pass@192.0.2.10:6099');
assert.strictEqual(context.normalizeProxy('192.0.2.10:6099:user:pass', 'https'), 'https://user:pass@192.0.2.10:6099');
assert.strictEqual(context.normalizeProxy('http://user:pass@192.0.2.10:6099', 'socks5'), 'http://user:pass@192.0.2.10:6099');
assert.strictEqual(context.normalizeProxy('socks5s://user:pass@192.0.2.10:6099', 'http'), 'socks5://user:pass@192.0.2.10:6099');
assert.strictEqual(context.normalizeProxy('host:1080:u@x:p:a', 'socks5'), 'socks5://u%40x:p%3Aa@host:1080');
assert.throws(() => context.normalizeProxy('bad-value', 'socks5'));

const encoded = normalizeProxyRecord({ raw: 'socks5://user%40mail:p%3Aa%2Fss%25@proxy.test:1080' });
assert.strictEqual(encoded.username, 'user@mail');
assert.strictEqual(encoded.password, 'p:a/ss%');
assert.strictEqual(encoded.raw, 'socks5://user%40mail:p%3Aa%2Fss%25@proxy.test:1080');

const existing = normalizeProxyRecord({
  raw: 'socks5://saved-user:saved-pass@old-proxy.test:1080',
  name: 'saved',
});
const blankPatch = normalizeProxyRecord({
  name: 'renamed', host: '', port: '', username: '', password: '', raw: '',
}, existing);
assert.strictEqual(blankPatch.username, 'saved-user');
assert.strictEqual(blankPatch.password, 'saved-pass');
assert.ok(blankPatch.raw.includes('saved-user:saved-pass@'));

assert.strictEqual(context.mergeRemoteProxy(
  'socks5://old-proxy.test:1080',
  'socks5://remote-user:remote-pass@old-proxy.test:1080',
), 'socks5://remote-user:remote-pass@old-proxy.test:1080');

const explicitClear = normalizeProxyRecord({
  raw: 'socks5://old-proxy.test:1080',
  proxyAuthAction: 'clear',
}, existing);
assert.strictEqual(explicitClear.username, '');
assert.strictEqual(explicitClear.password, '');
assert.strictEqual(explicitClear.authenticated, false);

const echoedRawPatch = normalizeProxyRecord({
  raw: existing.raw,
  username: 'next@user',
  password: 'next:pass',
}, existing);
assert.strictEqual(echoedRawPatch.username, 'next@user');
assert.strictEqual(echoedRawPatch.password, 'next:pass');
assert.ok(echoedRawPatch.raw.includes('next%40user:next%3Apass@'));

assert.strictEqual(context.proxyAuthActionForUpdate(
  existing.raw,
  'socks5://old-proxy.test:1080',
  'proxy',
), 'clear');
assert.strictEqual(context.proxyAuthActionForUpdate(
  existing.raw,
  'socks5://new-proxy.test:1080',
  'proxy',
), null);

const createFromBareRaw = normalizeProxyRecord({
  raw: 'http://new-proxy.test:8080',
  username: 'new-user',
  password: 'new-pass',
});
assert.strictEqual(createFromBareRaw.username, 'new-user');
assert.strictEqual(createFromBareRaw.password, 'new-pass');
assert.ok(createFromBareRaw.raw.includes('new-user:new-pass@'));

const replacementRaw = normalizeProxyRecord({
  raw: 'http://fresh%40user:fresh%3Apass@new-proxy.test:8080',
  protocol: existing.protocol,
  host: existing.host,
  port: existing.port,
  username: existing.username,
  password: existing.password,
}, existing);
assert.strictEqual(replacementRaw.protocol, 'http');
assert.strictEqual(replacementRaw.host, 'new-proxy.test');
assert.strictEqual(replacementRaw.username, 'fresh@user');

const clearedAuth = normalizeProxyRecord({ raw: 'socks5://old-proxy.test:1080' }, existing);
assert.strictEqual(clearedAuth.username, '');
assert.strictEqual(clearedAuth.password, '');
assert.strictEqual(clearedAuth.authenticated, false);

const legacyFields = normalizeProxyRecord({
  proxy_type: 'http',
  proxy_host: 'legacy.test',
  proxy_port: '3128',
  proxy_user: 'legacy-user',
  proxy_password: 'legacy-pass',
});
assert.strictEqual(legacyFields.raw, 'http://legacy-user:legacy-pass@legacy.test:3128');

console.log('PROXY_FORMAT_SELFTEST_OK bare_socks5=1 bare_http=1 bare_https=1 explicit=1 alias=1 encoding=1 merge=1 redacted_restore=1 explicit_clear=1 ui_clear=1 raw_priority=1 legacy=1');
