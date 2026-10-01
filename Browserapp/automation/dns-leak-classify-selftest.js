'use strict';

/**
 * DNS leak verdict classification (issue #27).
 *
 * The start page's "local consistency assessment" probes `N.<id>.bash.ws` through the *application
 * process's* host resolver (Node `dns.lookup`). Chromium, however, resolves SOCKS5 and HTTP(S)
 * CONNECT targets **on the proxy side**, so with "overseas exit + domestic system DNS" the two
 * paths structurally disagree and the panel turned permanently red: a guaranteed false positive
 * that also buries a genuine leak.
 *
 * The summariser now takes the profile's proxy protocol and only demotes the verdict when the
 * proxy really does resolve remotely. SOCKSv4 (and `socks://`, which Chromium maps to SOCKSv4) keep
 * the original `bad` verdict, because there the client *does* resolve and a divergence is a real
 * signal.
 */

const assert = require('assert');

const { summarizeDnsLeak } = require('./start-page-server');

const results = [];
function record(name, error) {
  results.push({ name, ok: !error });
  if (error) {
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS  ${name}`);
  }
}
function check(name, fn) {
  try { fn(); record(name, null); } catch (error) { record(name, error); }
}

const EXIT_US = { ip: '73.45.11.9', countryCode: 'US', country: 'United States' };
const EXIT_CN = { ip: '183.207.113.102', countryCode: 'CN', country: 'China' };

/** bash.ws-shaped rows: one `ip` row plus DNS resolver rows in another country. */
function rowsMismatch() {
  return [
    { type: 'ip', ip: EXIT_US.ip, country: 'US' },
    { type: 'dns', ip: '183.207.113.102', country: 'CN', asn: 'AS56046' },
    { type: 'dns', ip: '183.207.113.103', country: 'CN', asn: 'AS56046' },
    { type: 'conclusion', ip: 'may be leaking' },
  ];
}
function rowsMatch() {
  return [
    { type: 'ip', ip: EXIT_US.ip, country: 'US' },
    { type: 'dns', ip: '8.8.8.8', country: 'US', asn: 'AS15169' },
  ];
}
function rowsMultiCountryNoMismatch() {
  return [
    { type: 'ip', ip: EXIT_US.ip, country: 'US' },
    { type: 'dns', ip: '8.8.8.8', country: 'US' },
    { type: 'dns', ip: '1.1.1.1', country: 'AU' },
  ];
}

// --- remote-resolving proxies: divergence is informational, never a leak -------------------

for (const protocol of ['socks5', 'socks5h', 'socks5s', 'http', 'https', 'SOCKS5']) {
  check(`${protocol}: country mismatch is informational, not a leak`, () => {
    const out = summarizeDnsLeak(rowsMismatch(), EXIT_US, { proxyProtocol: protocol });
    assert.strictEqual(out.state, 'info', `expected info for ${protocol}, got ${out.state}`);
    assert.strictEqual(out.ok, true, 'an informational item must not read as a failure');
    assert.strictEqual(out.countryMismatch, true, 'the underlying observation must still be reported');
  });
}

check('socks5: the resolver list is preserved so nothing is hidden', () => {
  const out = summarizeDnsLeak(rowsMismatch(), EXIT_US, { proxyProtocol: 'socks5' });
  assert.strictEqual(out.servers.length, 2, 'both observed resolvers must survive de-duplication');
  assert.deepStrictEqual(out.dnsCountries, ['CN']);
  assert.match(out.detail, /183\.207\.113\.102/, 'detail must keep the resolver IPs');
  assert.match(out.detail, /US/, 'detail must keep the exit region');
  assert.match(out.detail, /代理端解析|远端解析/, 'detail must explain the proxy-side resolution');
});

check('socks5: label distinguishes the informational case', () => {
  const out = summarizeDnsLeak(rowsMismatch(), EXIT_US, { proxyProtocol: 'socks5' });
  assert.notStrictEqual(out.label, '可能存在 DNS 泄露');
  assert.match(out.label, /代理/);
});

check('socks5: matching regions still report good', () => {
  const out = summarizeDnsLeak(rowsMatch(), EXIT_US, { proxyProtocol: 'socks5' });
  assert.strictEqual(out.state, 'good');
});

// --- client-side resolution must keep the original, loud verdict ---------------------------

for (const protocol of ['socks4', 'socks', undefined, null, '', 'direct']) {
  check(`${JSON.stringify(protocol)}: country mismatch stays a leak`, () => {
    const out = summarizeDnsLeak(rowsMismatch(), EXIT_US, { proxyProtocol: protocol });
    assert.strictEqual(out.state, 'bad', `expected bad for ${String(protocol)}, got ${out.state}`);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.label, '可能存在 DNS 泄露');
  });
}

check('no options argument at all keeps the legacy verdict (back-compat)', () => {
  const out = summarizeDnsLeak(rowsMismatch(), EXIT_US);
  assert.strictEqual(out.state, 'bad');
});

check('socks4 with the resolver in the exit country stays good', () => {
  const out = summarizeDnsLeak(rowsMatch(), EXIT_US, { proxyProtocol: 'socks4' });
  assert.strictEqual(out.state, 'good');
});

// --- untouched branches ---------------------------------------------------------------------

check('no observed resolvers stays warn regardless of proxy protocol', () => {
  for (const protocol of ['socks5', 'socks4']) {
    const out = summarizeDnsLeak([{ type: 'ip', ip: EXIT_US.ip, country: 'US' }], EXIT_US, { proxyProtocol: protocol });
    assert.strictEqual(out.state, 'warn', `expected warn for ${protocol}`);
    assert.strictEqual(out.label, '未观测到 DNS 服务器');
  }
});

check('multi-country resolvers without an exit country stay warn', () => {
  // The warn branch needs no exit country to compare against: with a known exit country a foreign
  // resolver is a mismatch (bad) in every case, which is why the multi-country branch is only
  // reachable when the exit geography could not be resolved.
  const out = summarizeDnsLeak(rowsMultiCountryNoMismatch(), { ip: EXIT_US.ip }, { proxyProtocol: 'socks5' });
  assert.strictEqual(out.state, 'warn');
  assert.strictEqual(out.label, 'DNS 地区不一致');
});

check('a foreign resolver next to the exit country is still a mismatch', () => {
  const out = summarizeDnsLeak(rowsMultiCountryNoMismatch(), EXIT_US, { proxyProtocol: 'socks5' });
  assert.strictEqual(out.countryMismatch, true);
  assert.strictEqual(out.state, 'info', 'remote-resolving proxy keeps it informational');
  const strict = summarizeDnsLeak(rowsMultiCountryNoMismatch(), EXIT_US, { proxyProtocol: 'socks4' });
  assert.strictEqual(strict.state, 'bad', 'client-side resolution keeps it a leak');
});

check('no exit country keeps the informational-but-clean path', () => {
  const out = summarizeDnsLeak(rowsMatch(), { ip: EXIT_US.ip }, { proxyProtocol: 'socks5' });
  assert.strictEqual(out.state, 'good');
});

check('a resolver equal to the exit IP is still recognised', () => {
  const out = summarizeDnsLeak([
    { type: 'ip', ip: EXIT_CN.ip, country: 'CN' },
    { type: 'dns', ip: EXIT_CN.ip, country: 'CN' },
  ], EXIT_CN, { proxyProtocol: 'socks5' });
  assert.strictEqual(out.state, 'good');
  assert.strictEqual(out.label, 'DNS 与出口一致');
});

// --- the route must actually feed the protocol through --------------------------------------

check('the /api/dns-leak route passes the session proxy protocol', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, 'start-page-server.js'), 'utf8');
  const route = source.slice(source.indexOf("pathname === '/api/dns-leak'"));
  assert.match(route, /proxyProtocol/, 'the route must hand the protocol to the summariser');
  assert.match(source, /summarizeDnsLeak\(rows, exitNetwork, \{ proxyProtocol: options\.proxyProtocol \}\)/,
    'lookupDnsLeak must forward options.proxyProtocol');
});

const failed = results.filter((entry) => !entry.ok).length;
console.log(`\nDNS_LEAK_CLASSIFY_SELFTEST ${failed ? 'FAILED' : 'OK'} ${results.length - failed}/${results.length} checks passed\n`);
if (failed) process.exitCode = 1;
