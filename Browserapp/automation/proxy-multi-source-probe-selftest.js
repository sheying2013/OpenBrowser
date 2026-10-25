'use strict';
const assert = require('assert');
const net = require('net');
const http = require('http');
const {
  lookupProxyCountry,
  normalizeIpWhoisAppResult,
  normalizeFreeIpApiResult,
  recordProviderRateLimit,
  isProviderCoolingDown,
  clearProviderCooldowns,
  clearProbeCache,
} = require('../proxy-forwarder');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function until(socket, marker) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.includes(marker)) {
        cleanup();
        resolve(data);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

async function run() {
  console.log('Starting Proxy Multi-Source Probe Selftest...');
  clearProbeCache();

  // =========================================================================
  // Test 1: Normalizer shapes and field validation
  // =========================================================================
  {
    const sampleWhois = {
      ip: '104.28.19.45',
      success: true,
      country: 'United States',
      country_code: 'US',
      region: 'California',
      city: 'San Francisco',
      latitude: 37.7749,
      longitude: -122.4194,
      postal: '94107',
      timezone: 'America/Los_Angeles',
      isp: 'Cloudflare, Inc.',
      org: 'Cloudflare',
      asn: 'AS13335',
    };
    const normWhois = normalizeIpWhoisAppResult(sampleWhois);
    assert.strictEqual(normWhois.ip, '104.28.19.45');
    assert.strictEqual(normWhois.countryCode, 'US');
    assert.strictEqual(normWhois.timezone, 'America/Los_Angeles');
    assert.strictEqual(normWhois.city, 'San Francisco');
    assert.strictEqual(normWhois.region, 'California');
    assert.strictEqual(normWhois.latitude, 37.7749);
    assert.strictEqual(normWhois.longitude, -122.4194);
    assert.strictEqual(normWhois.asn, 'AS13335');

    const sampleFree = {
      ipVersion: 4,
      ipAddress: '198.51.100.12',
      countryName: 'Japan',
      countryCode: 'JP',
      regionName: 'Tokyo',
      cityName: 'Chiyoda',
      zipCode: '100-0001',
      timeZone: 'Asia/Tokyo',
      latitude: 35.6895,
      longitude: 139.6917,
    };
    const normFree = normalizeFreeIpApiResult(sampleFree);
    assert.strictEqual(normFree.ip, '198.51.100.12');
    assert.strictEqual(normFree.countryCode, 'JP');
    assert.strictEqual(normFree.timezone, 'Asia/Tokyo');
    assert.strictEqual(normFree.city, 'Chiyoda');
    assert.strictEqual(normFree.region, 'Tokyo');
    assert.strictEqual(normFree.latitude, 35.6895);
    assert.strictEqual(normFree.longitude, 139.6917);

    console.log('  PASS  normalizeIpWhoisAppResult & normalizeFreeIpApiResult shape verified');
  }

  // =========================================================================
  // Test 2: Provider cooldown tracking and rate limit backoff
  // =========================================================================
  {
    clearProviderCooldowns();
    assert.strictEqual(isProviderCoolingDown('ipinfo.io'), false);

    recordProviderRateLimit('ipinfo.io', 50); // 50ms cooldown
    assert.strictEqual(isProviderCoolingDown('ipinfo.io'), true);
    assert.strictEqual(isProviderCoolingDown('ipwhois.app'), false);

    // Wait for cooldown to expire
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(isProviderCoolingDown('ipinfo.io'), false);

    console.log('  PASS  Provider cooldown registration and expiration verified');
  }

  // =========================================================================
  // Test 3: Multi-Provider Fallback when primary encounters 429
  // =========================================================================
  {
    // Spin up mock HTTP upstream proxy that simulates:
    // - ip-api.com returns 429 (rate-limited)
    // - ipinfo.io returns 429 (rate-limited)
    // - ipwho.is returns 500 (transient error)
    // - ipwhois.app returns 200 with rich Geo data (Tokyo, Asia/Tokyo, lat/lon)
    let ipinfoCount = 0;
    let ipwhoisCount = 0;

    const mockProxy = net.createServer((clientSocket) => {
      clientSocket.once('data', (firstChunk) => {
        const text = firstChunk.toString('latin1');
        if (text.startsWith('CONNECT')) {
          const match = text.match(/CONNECT\s+([^:]+):(\d+)/i);
          const targetHost = match ? match[1] : '';
          if (targetHost.includes('ipinfo.io')) {
            ipinfoCount++;
            recordProviderRateLimit('ipinfo.io');
          }
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          clientSocket.destroy();
        } else {
          // Plain HTTP forward
          if (text.includes('ip-api.com')) {
            const body = JSON.stringify({ status: 'fail', message: 'rate limited' });
            clientSocket.end(`HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${body}`);
          } else if (text.includes('ipwhois.app')) {
            ipwhoisCount++;
            const body = JSON.stringify({
              ip: '203.0.113.88',
              success: true,
              country: 'Japan',
              country_code: 'JP',
              region: 'Tokyo',
              city: 'Minato',
              postal: '105-0001',
              timezone: 'Asia/Tokyo',
              latitude: 35.6586,
              longitude: 139.7454,
              isp: 'Softbank',
              org: 'Softbank Corp',
              asn: 'AS17676',
            });
            clientSocket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${body}`);
          } else {
            clientSocket.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
          }
        }
      });
    });

    const proxyPort = await listen(mockProxy);
    const proxyConfig = {
      protocol: 'http',
      host: '127.0.0.1',
      port: proxyPort,
    };

    const result = await lookupProxyCountry(proxyConfig, { force: true, totalTimeoutMs: 6000 });

    assert.strictEqual(result.ip, '203.0.113.88', 'Result IP must match fallback provider');
    assert.strictEqual(result.countryCode, 'JP', 'Country code must match fallback provider');
    assert.strictEqual(result.timezone, 'Asia/Tokyo', 'Timezone must NOT degrade to empty');
    assert.strictEqual(result.city, 'Minato', 'City must be populated from fallback provider');
    assert.strictEqual(result.region, 'Tokyo', 'Region must be populated');
    assert.strictEqual(result.latitude, 35.6586, 'Latitude must be populated');
    assert.strictEqual(result.longitude, 139.7454, 'Longitude must be populated');
    assert.strictEqual(result.asn, 'AS17676', 'ASN must be populated');

    // Confirm that ipinfo.io was marked as cooling down due to 429
    assert.strictEqual(isProviderCoolingDown('ipinfo.io'), true, 'ipinfo.io must enter cooldown after 429');
    assert.strictEqual(ipwhoisCount, 1, 'ipwhois.app fallback provider was successfully reached');

    mockProxy.close();
    console.log('  PASS  Multi-provider sequential fallback preserves full timezone & coordinates on 429');
  }

  console.log('\nPROXY_MULTI_SOURCE_PROBE_SELFTEST_OK all tests passed!');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
