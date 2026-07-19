const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require.resolve('./renderer.js'), 'utf8');
const start = source.indexOf('function normalizedProxyType');
const end = source.indexOf('function proxyLines');
assert(start >= 0 && end > start);
const context = {};
vm.runInNewContext(source.slice(start, end), context);
assert.strictEqual(context.normalizeProxy('192.0.2.10:6099:user:pass', 'socks5'), 'socks5://user:pass@192.0.2.10:6099');
assert.strictEqual(context.normalizeProxy('192.0.2.10:6099:user:pass', 'http'), 'http://user:pass@192.0.2.10:6099');
assert.strictEqual(context.normalizeProxy('192.0.2.10:6099:user:pass', 'https'), 'https://user:pass@192.0.2.10:6099');
assert.strictEqual(context.normalizeProxy('http://user:pass@192.0.2.10:6099', 'socks5'), 'http://user:pass@192.0.2.10:6099');
assert.strictEqual(context.normalizeProxy('socks5s://user:pass@192.0.2.10:6099', 'http'), 'socks5://user:pass@192.0.2.10:6099');
assert.strictEqual(context.normalizeProxy('host:1080:u@x:p:a', 'socks5'), 'socks5://u%40x:p%3Aa@host:1080');
assert.throws(() => context.normalizeProxy('bad-value', 'socks5'));
console.log('PROXY_FORMAT_SELFTEST_OK bare_socks5=1 bare_http=1 bare_https=1 explicit=1 alias=1 encoding=1');
