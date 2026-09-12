'use strict';

/**
 * Self-test for configuration input validation.
 */

const assert = require('assert');
const v = require('./input-validation');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

// ---- numeric coercion ----

check('toFiniteNumber rejects values that Number() would turn into zero', () => {
  assert.strictEqual(v.toFiniteNumber(null), null);
  assert.strictEqual(v.toFiniteNumber(''), null);
  assert.strictEqual(v.toFiniteNumber('   '), null);
  assert.strictEqual(v.toFiniteNumber(undefined), null);
  assert.strictEqual(v.toFiniteNumber(true), null);
  assert.strictEqual(v.toFiniteNumber(false), null);
  assert.strictEqual(v.toFiniteNumber({}), null);
  assert.strictEqual(v.toFiniteNumber([]), null);
  assert.strictEqual(v.toFiniteNumber(NaN), null);
  assert.strictEqual(v.toFiniteNumber(Infinity), null);
});

check('toFiniteNumber accepts plain decimal numbers and numeric strings', () => {
  assert.strictEqual(v.toFiniteNumber(0), 0);
  assert.strictEqual(v.toFiniteNumber(-12.5), -12.5);
  assert.strictEqual(v.toFiniteNumber('25.03'), 25.03);
  assert.strictEqual(v.toFiniteNumber(' -7 '), -7);
  assert.strictEqual(v.toFiniteNumber('1e3'), 1000);
});

check('toFiniteNumber refuses hexadecimal and other exotic notations', () => {
  assert.strictEqual(v.toFiniteNumber('0x10'), null);
  assert.strictEqual(v.toFiniteNumber('0b11'), null);
  assert.strictEqual(v.toFiniteNumber('12px'), null);
  assert.strictEqual(v.toFiniteNumber('1,5'), null);
});

check('toBoundedInteger enforces whole numbers inside the range', () => {
  assert.strictEqual(v.toBoundedInteger(80, 1, 65535), 80);
  assert.strictEqual(v.toBoundedInteger('80', 1, 65535), 80);
  assert.strictEqual(v.toBoundedInteger(80.5, 1, 65535), null);
  assert.strictEqual(v.toBoundedInteger(0, 1, 65535), null);
  assert.strictEqual(v.toBoundedInteger(65536, 1, 65535), null);
});

// ---- coordinates ----

check('latitude accepts the closed range and rejects the outside', () => {
  assert.strictEqual(v.isValidLatitude(-90), true);
  assert.strictEqual(v.isValidLatitude(90), true);
  assert.strictEqual(v.isValidLatitude('25.033'), true);
  assert.strictEqual(v.isValidLatitude(90.0001), false);
  assert.strictEqual(v.isValidLatitude(-90.0001), false);
  assert.strictEqual(v.isValidLatitude(9999), false);
  assert.strictEqual(v.isValidLatitude(null), false);
  assert.strictEqual(v.isValidLatitude(''), false);
});

check('longitude accepts the closed range and rejects the outside', () => {
  assert.strictEqual(v.isValidLongitude(-180), true);
  assert.strictEqual(v.isValidLongitude(180), true);
  assert.strictEqual(v.isValidLongitude(121.4737), true);
  assert.strictEqual(v.isValidLongitude(180.0001), false);
  assert.strictEqual(v.isValidLongitude(-181), false);
});

check('normalizeLatitude never turns an absent value into zero', () => {
  assert.strictEqual(v.normalizeLatitude(null), null);
  assert.strictEqual(v.normalizeLatitude(''), null);
  assert.strictEqual(v.normalizeLatitude(undefined), null);
  assert.strictEqual(v.normalizeLatitude(9999), null);
  assert.strictEqual(v.normalizeLatitude(0), 0, 'an explicit zero is a real coordinate');
  assert.strictEqual(v.normalizeLatitude('25.033'), 25.033);
});

check('normalizeLongitude never turns an absent value into zero', () => {
  assert.strictEqual(v.normalizeLongitude(null), null);
  assert.strictEqual(v.normalizeLongitude(''), null);
  assert.strictEqual(v.normalizeLongitude(0), 0);
  assert.strictEqual(v.normalizeLongitude(121.4737), 121.4737);
});

check('a half-supplied coordinate pair is reported as unknown', () => {
  assert.deepStrictEqual(v.normalizeCoordinates(25.033, null), { latitude: null, longitude: null, valid: false });
  assert.deepStrictEqual(v.normalizeCoordinates(null, 121.4737), { latitude: null, longitude: null, valid: false });
  assert.deepStrictEqual(v.normalizeCoordinates(25.033, 121.4737), { latitude: 25.033, longitude: 121.4737, valid: true });
  assert.deepStrictEqual(v.normalizeCoordinates(9999, 9999), { latitude: null, longitude: null, valid: false });
});

check('the poles and the antimeridian stay expressible', () => {
  assert.deepStrictEqual(v.normalizeCoordinates(-90, 180), { latitude: -90, longitude: 180, valid: true });
  assert.deepStrictEqual(v.normalizeCoordinates(90, -180), { latitude: 90, longitude: -180, valid: true });
});

// ---- ip addresses ----

check('IPv4 recognition accepts real addresses and rejects lookalikes', () => {
  for (const good of ['0.0.0.0', '1.1.1.1', '192.168.1.1', '255.255.255.255', '8.8.4.4']) {
    assert.strictEqual(v.isIPv4(good), true, `${good} should be valid`);
  }
  for (const bad of ['256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.4/24', 'example.com', '']) {
    assert.strictEqual(v.isIPv4(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
});

check('IPv6 recognition covers compressed and mapped forms', () => {
  for (const good of ['::1', '::', 'fe80::1', '2001:db8::8a2e:370:7334', '::ffff:192.168.1.1']) {
    assert.strictEqual(v.isIPv6(good), true, `${good} should be valid`);
  }
  for (const bad of ['1:2:3:4:5:6:7:8:9', 'gggg::1', '192.168.1.1']) {
    assert.strictEqual(v.isIPv6(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
});

check('isIP spans both families and trims surrounding space', () => {
  assert.strictEqual(v.isIP(' 10.0.0.1 '), true);
  assert.strictEqual(v.isIP(' ::1 '), true);
  assert.strictEqual(v.isIP('not-an-ip'), false);
  assert.strictEqual(v.isIP(null), false);
});

check('findIPs does not carve an address out of a longer numeric run', () => {
  assert.deepStrictEqual(v.findIPs('rate 999.1.1.1 here'), []);
  assert.deepStrictEqual(v.findIPs('version 1.2.3.4.5 released'), []);
  assert.deepStrictEqual(v.findIPs('0x11.2.3.4'), []);
});

check('findIPs returns unique addresses in order of appearance', () => {
  assert.deepStrictEqual(
    v.findIPs('10.0.0.1 then 10.0.0.1 again, then fe80::1'),
    ['10.0.0.1', 'fe80::1'],
  );
});

check('findIPs keeps a mapped address whole', () => {
  assert.deepStrictEqual(v.findIPs('x ::ffff:10.0.0.1 y'), ['::ffff:10.0.0.1']);
});

check('findIPs tolerates punctuation and brackets', () => {
  assert.deepStrictEqual(v.findIPs('ip=10.0.0.1, next'), ['10.0.0.1']);
  assert.deepStrictEqual(v.findIPs('http://[::1]:8080/'), ['::1']);
  assert.deepStrictEqual(v.findIPs(''), []);
  assert.deepStrictEqual(v.findIPs(null), []);
});

// ---- ports and hosts ----

check('isValidPort enforces the transport range', () => {
  assert.strictEqual(v.isValidPort(1), true);
  assert.strictEqual(v.isValidPort(65535), true);
  assert.strictEqual(v.isValidPort('1080'), true);
  assert.strictEqual(v.isValidPort(0), false);
  assert.strictEqual(v.isValidPort(65536), false);
  assert.strictEqual(v.isValidPort(999999), false);
  assert.strictEqual(v.isValidPort(-1), false);
  assert.strictEqual(v.isValidPort(80.5), false);
  assert.strictEqual(v.isValidPort(null), false);
  assert.strictEqual(v.isValidPort(''), false);
});

check('isValidHostname follows the label rules', () => {
  for (const good of ['example.com', 'a.b.c', 'localhost', 'sub-domain.example.co.uk', '10.0.0.1', 'xn--80ak6aa92e.com']) {
    assert.strictEqual(v.isValidHostname(good), true, `${good} should be valid`);
  }
  for (const bad of ['', '-leading.com', 'trailing-.com', 'double..dot', 'space in.com', `${'a'.repeat(64)}.com`]) {
    assert.strictEqual(v.isValidHostname(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
});

check('isValidHostname accepts a trailing root dot', () => {
  assert.strictEqual(v.isValidHostname('example.com.'), true);
});

check('parseHostPort handles dotted, named and bracketed forms', () => {
  assert.deepStrictEqual(v.parseHostPort('1.2.3.4:8080'), { host: '1.2.3.4', port: 8080 });
  assert.deepStrictEqual(v.parseHostPort('proxy.example.com:1080'), { host: 'proxy.example.com', port: 1080 });
  assert.deepStrictEqual(v.parseHostPort('[::1]:8080'), { host: '::1', port: 8080 });
  assert.deepStrictEqual(v.parseHostPort('[2001:db8::1]:443'), { host: '2001:db8::1', port: 443 });
});

check('parseHostPort rejects malformed input', () => {
  assert.strictEqual(v.parseHostPort('1.2.3.4'), null, 'a bare host has no port');
  assert.strictEqual(v.parseHostPort('::1:8080'), null, 'a bare IPv6 literal is ambiguous');
  assert.strictEqual(v.parseHostPort('1.2.3.4:0'), null);
  assert.strictEqual(v.parseHostPort('1.2.3.4:70000'), null);
  assert.strictEqual(v.parseHostPort(':8080'), null);
  assert.strictEqual(v.parseHostPort(''), null);
  assert.strictEqual(v.parseHostPort(null), null);
});

// ---- contact details ----

check('isValidEmail accepts ordinary addresses', () => {
  for (const good of ['a@b.co', 'first.last@example.com', 'user+tag@example.co.uk', "o'brien@example.com"]) {
    assert.strictEqual(v.isValidEmail(good), true, `${good} should be valid`);
  }
});

check('isValidEmail rejects malformed addresses', () => {
  for (const bad of ['', 'plain', '@example.com', 'a@', 'a@@b.com', 'a@b', 'a b@example.com', '.a@example.com', 'a..b@example.com', null]) {
    assert.strictEqual(v.isValidEmail(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
});

check('isValidPhone validates mainland numbers', () => {
  assert.strictEqual(v.isValidPhone('13800138000', { region: 'CN' }), true);
  assert.strictEqual(v.isValidPhone('138 0013 8000', { region: 'CN' }), true);
  assert.strictEqual(v.isValidPhone('138-0013-8000', { region: 'CN' }), true);
  assert.strictEqual(v.isValidPhone('12800138000', { region: 'CN' }), false);
  assert.strictEqual(v.isValidPhone('1380013800', { region: 'CN' }), false);
  assert.strictEqual(v.isValidPhone('', { region: 'CN' }), false);
});

check('isValidPhone validates north american numbers', () => {
  assert.strictEqual(v.isValidPhone('4155550123', { region: 'US' }), true);
  assert.strictEqual(v.isValidPhone('(415) 555-0123', { region: 'US' }), true);
  assert.strictEqual(v.isValidPhone('1155550123', { region: 'US' }), false, 'area code cannot start with 1');
});

check('isValidPhone supports an international form', () => {
  assert.strictEqual(v.isValidPhone('+14155550123', { region: 'E164' }), true);
  assert.strictEqual(v.isValidPhone('+8613800138000', { region: 'E164' }), true);
  assert.strictEqual(v.isValidPhone('+0123456789', { region: 'E164' }), false);
});

check('isValidPhone rejects an unknown region instead of guessing', () => {
  assert.throws(() => v.isValidPhone('123', { region: 'ZZ' }), /Unsupported phone region/);
});

// ---- urls ----

check('isValidUrl requires an absolute address over an accepted scheme', () => {
  assert.strictEqual(v.isValidUrl('https://example.com/path?q=1'), true);
  assert.strictEqual(v.isValidUrl('http://127.0.0.1:8080/'), true);
  assert.strictEqual(v.isValidUrl('ftp://example.com'), false, 'scheme not accepted by default');
  assert.strictEqual(v.isValidUrl('ftp://example.com', { protocols: ['ftp:'] }), true);
  assert.strictEqual(v.isValidUrl('example.com'), false, 'relative input is not a url');
  assert.strictEqual(v.isValidUrl('/relative/path'), false);
  assert.strictEqual(v.isValidUrl(''), false);
  assert.strictEqual(v.isValidUrl(null), false);
});

// ---- wiring ----

check('exit lookup results reject out-of-range and absent coordinates', () => {
  const { normalizeIpInfoResult } = require('../proxy-forwarder.js');
  const base = { ip: '1.2.3.4', country: 'US', region: 'California', city: 'SF', timezone: 'America/Los_Angeles' };
  const coords = (extra) => {
    const r = normalizeIpInfoResult({ ...base, ...extra });
    return { latitude: r.latitude, longitude: r.longitude };
  };

  assert.deepStrictEqual(coords({ latitude: null, longitude: null }), { latitude: null, longitude: null },
    'an absent coordinate must stay absent rather than collapsing to zero');
  assert.deepStrictEqual(coords({ latitude: '', longitude: '' }), { latitude: null, longitude: null });
  assert.deepStrictEqual(coords({ latitude: 9999, longitude: 9999 }), { latitude: null, longitude: null });
  assert.deepStrictEqual(coords({ latitude: 37.77, longitude: -122.42 }), { latitude: 37.77, longitude: -122.42 });
});

check('exit lookup results validate the packed coordinate string too', () => {
  const { normalizeIpInfoResult } = require('../proxy-forwarder.js');
  const base = { ip: '1.2.3.4', country: 'US', region: 'California', city: 'SF' };
  const good = normalizeIpInfoResult({ ...base, loc: '37.77,-122.42' });
  assert.strictEqual(good.latitude, 37.77);
  assert.strictEqual(good.longitude, -122.42);

  const bad = normalizeIpInfoResult({ ...base, loc: '9999,9999' });
  assert.strictEqual(bad.latitude, null);
  assert.strictEqual(bad.longitude, null);
});

check('findIPs leaves identifiers and version strings alone', () => {
  assert.deepStrictEqual(v.findIPs('v1.2.3.4'), []);
  assert.deepStrictEqual(v.findIPs('0x11.2.3.4'), []);
  assert.deepStrictEqual(v.findIPs('the host is 10.0.0.1.'), ['10.0.0.1'], 'a sentence-final dot is fine');
  assert.deepStrictEqual(v.findIPs('{"ip":"10.0.0.1"}'), ['10.0.0.1']);
  assert.deepStrictEqual(v.findIPs('IP:10.0.0.1;'), ['10.0.0.1']);
});

// ---- report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
console.log(`\nINPUT_VALIDATION_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
if (failed.length) process.exitCode = 1;
