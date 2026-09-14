#!/usr/bin/env node
'use strict';

const assert = require('assert');
const net = require('net');
const {
  connectSocket,
  setProxyDohResolver,
  getProxyDohLookup,
} = require('../proxy-forwarder');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
}

async function run() {
  console.log('Starting Proxy-Forwarder DoH DNS Resolution Selftest...\n');

  // 创建一个测试 Echo Server
  const server = net.createServer((socket) => {
    socket.on('data', (d) => socket.write(d));
  });
  const serverPort = await listen(server);

  try {
    // 1. IP 地址连接不走 DoH
    await checkAsync('connectSocket with IP directly connects without invoking DoH resolver', async () => {
      let dohInvoked = false;
      const mockResolver = {
        resolve4: async () => { dohInvoked = true; return ['127.0.0.1']; },
        resolve6: async () => { dohInvoked = true; return ['::1']; },
      };
      setProxyDohResolver(mockResolver);

      const socket = await connectSocket('127.0.0.1', serverPort, 3000);
      assert.strictEqual(dohInvoked, false, 'DoH should not be called for IP literal');
      assert.ok(socket && !socket.destroyed, 'Socket must be active');
      socket.destroy();
    });

    // 2. 域名连接走 DoH 解析
    await checkAsync('connectSocket resolves proxy vendor domain via DoH', async () => {
      let resolvedDomain = '';
      const mockResolver = {
        resolve4: async (host) => {
          resolvedDomain = host;
          return ['127.0.0.1'];
        },
        resolve6: async () => [],
      };
      setProxyDohResolver(mockResolver);

      const socket = await connectSocket('proxy.vendor.test', serverPort, 3000);
      assert.strictEqual(resolvedDomain, 'proxy.vendor.test', 'DoH resolver must resolve vendor domain');
      assert.ok(socket && !socket.destroyed, 'Socket must connect to resolved IP');

      // 验证通信
      socket.write('HELLO');
      const response = await new Promise((resolve) => socket.once('data', resolve));
      assert.strictEqual(response.toString(), 'HELLO');
      socket.destroy();
    });

    // 3. DoH 查无记录 (ENODATA) 时按既有语义 fallback 到系统 DNS，并输出可观测警告日志
    await checkAsync('connectSocket falls back to system resolver on DoH ENODATA with warning log', async () => {
      const mockResolver = {
        resolve4: async () => {
          const err = new Error('No record');
          err.code = 'ENODATA';
          throw err;
        },
        resolve6: async () => {
          const err = new Error('No record');
          err.code = 'ENODATA';
          throw err;
        },
      };
      setProxyDohResolver(mockResolver);

      let warnLogged = false;
      const origWarn = console.warn;
      console.warn = (...args) => {
        if (args.join(' ').includes('[proxy-forwarder] DoH lookup for "localhost" fell back to system DNS')) {
          warnLogged = true;
        }
        origWarn.apply(console, args);
      };

      try {
        // localhost 在系统 hosts/DNS 中可解析为 127.0.0.1
        const socket = await connectSocket('localhost', serverPort, 3000);
        assert.ok(socket && !socket.destroyed, 'Socket should connect via fallback');
        assert.strictEqual(warnLogged, true, 'Observable warning log must be emitted on fallback');
        socket.destroy();
      } finally {
        console.warn = origWarn;
      }
    });

    // 4. DoH 发生 transport error 时降级为系统解析，但必须输出可观测告警（绝不静默、也绝不硬失败）
    await checkAsync('connectSocket degrades to system resolver on DoH transport failure with loud warning', async () => {
      const mockResolver = {
        resolve4: async () => {
          const err = new Error('DoH upstream unreachable');
          err.code = 'ECONNREFUSED';
          throw err;
        },
        resolve6: async () => {
          const err = new Error('DoH upstream unreachable');
          err.code = 'ECONNREFUSED';
          throw err;
        },
      };
      setProxyDohResolver(mockResolver);

      let warnLogged = false;
      const origWarn = console.warn;
      console.warn = (...args) => {
        if (args.join(' ').includes('[proxy-forwarder] DoH transport failure for "localhost"')) {
          warnLogged = true;
        }
        origWarn.apply(console, args);
      };

      try {
        // A blocked DoH endpoint must not brick proxy dialling for restricted networks.
        const socket = await connectSocket('localhost', serverPort, 3000);
        assert.ok(socket && !socket.destroyed, 'Socket should connect via system-DNS fallback');
        assert.strictEqual(warnLogged, true, 'Transport-failure fallback must emit an observable warning');
        socket.destroy();
      } finally {
        console.warn = origWarn;
      }
    });

    // 5. 超时语义保持不变
    await checkAsync('connectSocket timeout destroys socket with timeout error', async () => {
      // 模拟一个永不返回响应的挂起 lookup
      const hangingResolver = {
        resolve4: () => new Promise(() => {}), // never resolves
        resolve6: () => new Promise(() => {}),
      };
      setProxyDohResolver(hangingResolver);

      await assert.rejects(
        () => connectSocket('hanging.proxy.test', serverPort, 100),
        /Proxy connection timed out/,
        'Must reject with timeout error'
      );
    });

    // 6. AbortSignal 语义保持不变
    await checkAsync('connectSocket signal abort rejects with closed error', async () => {
      // 已经 aborted 的 signal
      const preAborted = AbortSignal.abort();
      await assert.rejects(
        () => connectSocket('127.0.0.1', serverPort, 3000, preAborted),
        /Proxy bridge closed/
      );

      // 连接中途 abort
      const controller = new AbortController();
      const mockResolver = {
        resolve4: () => new Promise((resolve) => setTimeout(() => resolve(['127.0.0.1']), 500)),
        resolve6: async () => [],
      };
      setProxyDohResolver(mockResolver);

      const connPromise = connectSocket('mid-abort.proxy.test', serverPort, 3000, controller.signal);
      setTimeout(() => controller.abort(), 50);

      await assert.rejects(
        () => connPromise,
        /Proxy bridge closed/
      );
    });

  } finally {
    setProxyDohResolver(null); // 恢复默认 resolver
    server.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n======================================================================`);
  console.log(`proxy-forwarder-doh-selftest: OK ${passed}/${results.length}${failed ? ` (FAILED: ${failed})` : ''}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
