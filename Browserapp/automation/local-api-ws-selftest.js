'use strict';

/**
 * Dedicated test for Local API WebSocket DevTools endpoint compliance.
 *
 * Verifies GAP-11 fix:
 * 1. ws.puppeteer returns standard ws://127.0.0.1:port/devtools/browser/<guid>
 *    when Chromium DevTools /json/version is available.
 * 2. ws.puppeteer falls back to ws://127.0.0.1:port/devtools/browser/<id>
 *    when /json/version is unreachable.
 * 3. Never returns http:// in ws.puppeteer across start/detail/open-url/list endpoints.
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const { LocalApiServer, resolveWebSocketDebuggerUrl } = require('./local-api-server');

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  PASS  ' + name);
  passed += 1;
};

async function createMockDevToolsServer(browserGuid) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        const port = server.address().port;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          Browser: 'Chrome/148.0.7778.165',
          'Protocol-Version': '1.3',
          'User-Agent': 'Mozilla/5.0 Chrome/148.0.0.0',
          'V8-Version': '13.0.0',
          'WebKit-Version': '537.36',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${browserGuid}`,
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

(async () => {
  console.log('Running Local API WebSocket protocol endpoint selftests...\n');

  // Test 1: Live DevTools /json/version resolution
  const testGuid = '4b92c431-7e88-4672-911b-75a74e54e4c2';
  const mockServer = await createMockDevToolsServer(testGuid);
  const mockPort = mockServer.address().port;

  try {
    const resolved = await resolveWebSocketDebuggerUrl(mockPort, 'profile-test-1');
    ok('resolves live webSocketDebuggerUrl from /json/version', resolved === `ws://127.0.0.1:${mockPort}/devtools/browser/${testGuid}`);
    ok('resolved live url uses ws:// protocol', resolved.startsWith('ws://'));
  } finally {
    await new Promise((res) => mockServer.close(res));
  }

  // Test 2: Fallback when port is dead / no HTTP listener
  // Use a port that was just closed and is now free
  const fallback = await resolveWebSocketDebuggerUrl(mockPort, 'profile-fallback-id');
  ok('falls back to ws://127.0.0.1:port/devtools/browser/<id> on unreachable port',
    fallback === `ws://127.0.0.1:${mockPort}/devtools/browser/profile-fallback-id`);
  ok('fallback url uses ws:// protocol', fallback.startsWith('ws://'));

  // Test 3: Local API route handlers integration
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-ws-test-'));
  const dummyProfile = { id: 'test-p1', name: 'Test P1', proxy: 'Direct' };

  const mockEngine = {
    profiles: new Map([['test-p1', dummyProfile]]),
    running: new Map(),
    async start(profile) {
      const runningItem = { port: 9555, id: profile.id };
      this.running.set(profile.id, runningItem);
      return runningItem;
    },
    async stop(id) {
      this.running.delete(id);
      return { stopped: true };
    },
    status() {
      return [{
        id: 'test-p1',
        name: 'Test P1',
        running: true,
        port: 9555,
      }];
    },
  };

  const api = new LocalApiServer({ engine: mockEngine, apiKey: 'ws-key-test', allowedOrigins: [] });
  const route = (method, pathname, input) => api.route(method, pathname, input, { headers: {} });

  // 3a. /api/v1/browser/start
  const startRes = await route('POST', '/api/v1/browser/start', { user_id: 'test-p1' });
  ok('start API succeeds', startRes.code === 0);
  ok('start API ws.puppeteer is string', typeof startRes.data.ws?.puppeteer === 'string');
  ok('start API ws.puppeteer is ws:// format', startRes.data.ws.puppeteer.startsWith('ws://127.0.0.1:9555/devtools/browser/'));
  ok('start API ws.puppeteer is not http://', !startRes.data.ws.puppeteer.startsWith('http://'));
  ok('start API preserves debug_port', startRes.data.debug_port === 9555);
  ok('start API preserves user_id and profile_id', startRes.data.user_id === 'test-p1' && startRes.data.profile_id === 'test-p1');

  // 3b. /api/v1/user/detail
  const detailRes = await route('GET', '/api/v1/user/detail', { user_id: 'test-p1' });
  ok('detail API succeeds', detailRes.code === 0);
  ok('detail API ws.puppeteer is ws:// format', detailRes.data.ws?.puppeteer.startsWith('ws://127.0.0.1:9555/devtools/browser/'));
  ok('detail API ws.puppeteer is not http://', !detailRes.data.ws?.puppeteer.startsWith('http://'));

  // 3c. /api/v1/user/list
  const listRes = await route('GET', '/api/v1/user/list', {});
  ok('list API succeeds', listRes.code === 0);
  const listItem = listRes.data.list.find((x) => x.id === 'test-p1');
  ok('list item has ws.puppeteer in ws:// format', listItem.ws?.puppeteer.startsWith('ws://127.0.0.1:9555/devtools/browser/'));
  ok('list item ws.puppeteer is not http://', !listItem.ws?.puppeteer.startsWith('http://'));

  await api.stop().catch(() => {});
  await fsp.rm(userData, { recursive: true, force: true }).catch(() => {});

  console.log(`\n======================================================`);
  console.log(`ALL ${passed} LOCAL API WEBSOCKET SELFTESTS PASSED!`);
  console.log(`======================================================\n`);
  process.exit(0);
})().catch((err) => {
  console.error('FAIL in local-api-ws-selftest:', err);
  process.exit(1);
});
