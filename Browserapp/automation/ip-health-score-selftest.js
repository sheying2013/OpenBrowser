'use strict';

const assert = require('assert');
const { calculateIpHealthScore } = require('./ip-health-score');

function run() {
  const unavailable = calculateIpHealthScore();
  assert.strictEqual(unavailable.score, null);
  assert.strictEqual(unavailable.level, 'unknown');

  const residential = calculateIpHealthScore({
    ip: '203.0.113.10',
    countryCode: 'US',
    asn: 'AS64500',
    proxy: false,
    hosting: false,
    mobile: false,
  });
  assert.deepStrictEqual(
    { score: residential.score, level: residential.level, label: residential.label },
    { score: 70, level: 'review', label: '需复核' },
  );
  assert.strictEqual(residential.confidence, 'low');

  const ipPureExample = calculateIpHealthScore({
    ip: '2.27.132.142',
    countryCode: 'HK',
    asn: 'AS402279',
    asName: 'Geoscry Network LLC',
    hosting: false,
    proxy: false,
    mobile: false,
    ipPure: {
      fraudScore: 59,
      isResidential: false,
      isBroadcast: false,
      asOrganization: 'Private Customer',
    },
  });
  assert.strictEqual(ipPureExample.score, 41);
  assert.strictEqual(ipPureExample.level, 'risky');
  assert.strictEqual(ipPureExample.label, '高风险');
  assert.strictEqual(ipPureExample.confidence, 'high');
  assert.strictEqual(ipPureExample.factors[0].code, 'ippure-risk');

  const proxy = calculateIpHealthScore({
    ip: '198.51.100.20',
    countryCode: 'US',
    asn: 'AS64501',
    proxy: true,
    hosting: false,
  });
  assert.strictEqual(proxy.score, 35);
  assert.strictEqual(proxy.level, 'risky');
  assert.strictEqual(proxy.factors[0].code, 'proxy');

  const proxyHosting = calculateIpHealthScore({
    ip: '198.51.100.21',
    countryCode: 'US',
    asn: 'AS64502',
    proxy: true,
    hosting: true,
  });
  assert.strictEqual(proxyHosting.score, 25);
  assert.strictEqual(proxyHosting.factors[0].code, 'proxy-hosting');

  const mobile = calculateIpHealthScore({
    ip: '198.51.100.22',
    countryCode: 'US',
    asn: 'AS64503',
    mobile: true,
  });
  assert.strictEqual(mobile.score, 67);
  assert.strictEqual(mobile.level, 'review');

  process.stdout.write('ip-health-score selftest: ok\n');
}

if (require.main === module) run();

module.exports = { run };
