const assert = require("assert");
const net = require("net");
const { parseProxy, startAuthenticatedProxy, retryableSocksError } = require("./proxy-forwarder");

class Reader {
  constructor(socket) {
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    socket.on("error", () => {});
  }
  read(size) {
    return new Promise((resolve) => {
      this.queue.push({ size, resolve });
      this.pump();
    });
  }
  pump() {
    const item = this.queue[0];
    if (!item || this.buffer.length < item.size) return;
    this.queue.shift();
    const value = this.buffer.subarray(0, item.size);
    this.buffer = this.buffer.subarray(item.size);
    item.resolve(value);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

function until(socket, marker) {
  return new Promise((resolve, reject) => {
    let value = Buffer.alloc(0);
    const onData = (chunk) => {
      value = Buffer.concat([value, chunk]);
      if (!value.includes(marker)) return;
      cleanup();
      resolve(value);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

const isMutate = process.argv.includes("--mutate");

(async () => {
  // Test 0: Unit contract of retryableSocksError for permanent non-retryable error categories
  assert.strictEqual(retryableSocksError(new Error("Invalid SOCKS5 reply version")), false);
  assert.strictEqual(retryableSocksError(new Error("SOCKS5 target IPv6 address is invalid")), false);
  assert.strictEqual(retryableSocksError(new Error("SOCKS5 target hostname is invalid")), false);
  assert.strictEqual(retryableSocksError(new Error("SOCKS5 target port is invalid")), false);
  assert.strictEqual(retryableSocksError(new Error("SOCKS5 authentication failed")), false);
  assert.strictEqual(retryableSocksError(new Error("SOCKS5 proxy rejected available authentication methods")), false);
  assert.strictEqual(retryableSocksError(new Error("SOCKS5 proxy selected an unsupported authentication method")), false);
  assert.strictEqual(retryableSocksError(new Error("SOCKS5 username or password length is invalid")), false);
  assert.strictEqual(retryableSocksError(new Error("SOCKS5 upstream connection failed with code 5")), false);
  assert.strictEqual(retryableSocksError(new Error("read ECONNRESET")), true);
  assert.strictEqual(retryableSocksError(new Error("connect ETIMEDOUT 127.0.0.1:1080")), true);

  // Test 1: Transient network failure retries up to 3 attempts and succeeds
  let retryConnections = 0;
  const upstreamRetry = net.createServer((socket) => {
    retryConnections += 1;
    socket.on("error", () => {});
    if (retryConnections < 3) return socket.destroy();
    const reader = new Reader(socket);
    (async () => {
      const greeting = await reader.read(2);
      await reader.read(greeting[1]);
      socket.write(Buffer.from([5, 2]));
      const authHead = await reader.read(2);
      await reader.read(authHead[1]);
      const passSize = await reader.read(1);
      await reader.read(passSize[0]);
      socket.write(Buffer.from([1, 0]));
      const request = await reader.read(4);
      if (request[3] === 3) {
        const size = await reader.read(1);
        await reader.read(size[0]);
      } else if (request[3] === 1) await reader.read(4);
      else await reader.read(16);
      await reader.read(2);
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0x20, 0xfb]));
      const payload = await reader.read(8);
      socket.write(payload);
    })().catch(() => socket.destroy());
  });
  const upstreamPort = await listen(upstreamRetry);
  const bridge = await startAuthenticatedProxy(parseProxy("socks5://user:pass@127.0.0.1:" + upstreamPort));
  const client = await connect(bridge.port);
  client.on("error", () => {});
  client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
  const response = await until(client, Buffer.from("\r\n\r\n"));
  assert.match(response.toString("latin1"), /^HTTP\/1\.1 200/);
  client.write("retry-ok");
  const echoed = await until(client, Buffer.from("retry-ok"));
  assert(echoed.includes(Buffer.from("retry-ok")));
  assert.strictEqual(retryConnections, 3, "Transient failure retried exactly 3 times before succeeding");
  client.destroy();
  await bridge.close();
  await new Promise((resolve) => upstreamRetry.close(resolve));

  // Test 2: Permanent non-retryable error (Auth failure) does NOT retry (fails on attempt 1 immediately)
  let authFailConnections = 0;
  const upstreamAuthFail = net.createServer((socket) => {
    authFailConnections += 1;
    socket.on("error", () => {});
    const reader = new Reader(socket);
    (async () => {
      const greeting = await reader.read(2);
      await reader.read(greeting[1]);
      socket.write(Buffer.from([5, 2]));
      const authHead = await reader.read(2);
      await reader.read(authHead[1]);
      const passSize = await reader.read(1);
      await reader.read(passSize[0]);
      socket.write(Buffer.from([1, 1])); // Explicit authentication rejection
      socket.destroy();
    })().catch(() => socket.destroy());
  });
  const portAuthFail = await listen(upstreamAuthFail);
  const bridgeAuthFail = await startAuthenticatedProxy(parseProxy("socks5://user:wrongpass@127.0.0.1:" + portAuthFail));
  const clientAuthFail = await connect(bridgeAuthFail.port);
  clientAuthFail.on("error", () => {});
  clientAuthFail.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
  const respAuthFail = await until(clientAuthFail, Buffer.from("\r\n\r\n"));
  assert(respAuthFail.toString("latin1").includes("502 Bad Gateway"));
  assert.strictEqual(authFailConnections, 1, "Authentication failure was NOT retried (failed on attempt 1)");
  clientAuthFail.destroy();
  await bridgeAuthFail.close();
  await new Promise((resolve) => upstreamAuthFail.close(resolve));

  // Test 3: Permanent SOCKS5 error code (e.g. 0x05 Connection refused) does NOT retry
  let upstreamCodeConnections = 0;
  const upstreamCodeFail = net.createServer((socket) => {
    upstreamCodeConnections += 1;
    socket.on("error", () => {});
    const reader = new Reader(socket);
    (async () => {
      const greeting = await reader.read(2);
      await reader.read(greeting[1]);
      socket.write(Buffer.from([5, 0])); // No auth
      await reader.read(4); // CONNECT head
      await reader.read(4); // IPv4
      await reader.read(2); // Port
      socket.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); // 0x05 Connection Refused
      socket.destroy();
    })().catch(() => socket.destroy());
  });
  const portCodeFail = await listen(upstreamCodeFail);
  const bridgeCodeFail = await startAuthenticatedProxy(parseProxy("socks5://127.0.0.1:" + portCodeFail));
  const clientCodeFail = await connect(bridgeCodeFail.port);
  clientCodeFail.on("error", () => {});
  clientCodeFail.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
  const respCodeFail = await until(clientCodeFail, Buffer.from("\r\n\r\n"));
  assert(respCodeFail.toString("latin1").includes("502 Bad Gateway"));
  assert.strictEqual(upstreamCodeConnections, 1, "SOCKS5 error code 5 was NOT retried (failed on attempt 1)");
  clientCodeFail.destroy();
  await bridgeCodeFail.close();
  await new Promise((resolve) => upstreamCodeFail.close(resolve));

  // Test 4: Permanent non-retryable error: Invalid SOCKS5 reply version does NOT retry (attempt 1 only)
  let badVersionConnections = 0;
  const upstreamBadVersion = net.createServer((socket) => {
    badVersionConnections += 1;
    socket.on("error", () => {});
    const reader = new Reader(socket);
    (async () => {
      const greeting = await reader.read(2);
      await reader.read(greeting[1]);
      socket.write(Buffer.from([5, 0])); // No auth
      await reader.read(4); // CONNECT head
      await reader.read(4); // IPv4
      await reader.read(2); // Port
      socket.write(Buffer.from([4, 0, 0, 1, 0, 0, 0, 0, 0, 0])); // Invalid version 4 in reply
      socket.destroy();
    })().catch(() => socket.destroy());
  });
  const portBadVersion = await listen(upstreamBadVersion);
  const bridgeBadVersion = await startAuthenticatedProxy(parseProxy("socks5://127.0.0.1:" + portBadVersion));
  const clientBadVersion = await connect(bridgeBadVersion.port);
  clientBadVersion.on("error", () => {});
  clientBadVersion.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
  const respBadVersion = await until(clientBadVersion, Buffer.from("\r\n\r\n"));
  assert(respBadVersion.toString("latin1").includes("502 Bad Gateway"));
  assert.strictEqual(badVersionConnections, 1, "Invalid SOCKS5 reply version was NOT retried (failed on attempt 1)");
  clientBadVersion.destroy();
  await bridgeBadVersion.close();
  await new Promise((resolve) => upstreamBadVersion.close(resolve));

  // Test 5: Permanent non-retryable error: Invalid target IPv6 address does NOT retry (attempt 1 only)
  let invalidIpv6Connections = 0;
  const upstreamIpv6Fail = net.createServer((socket) => {
    invalidIpv6Connections += 1;
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write(Buffer.from([5, 0])); // no auth
    });
  });
  const portIpv6Fail = await listen(upstreamIpv6Fail);
  const bridgeIpv6Fail = await startAuthenticatedProxy(parseProxy("socks5://127.0.0.1:" + portIpv6Fail));
  const clientIpv6Fail = await connect(bridgeIpv6Fail.port);
  clientIpv6Fail.on("error", () => {});
  clientIpv6Fail.write("CONNECT [2001:db8:::1]:443 HTTP/1.1\r\nHost: [2001:db8:::1]:443\r\n\r\n");
  const respIpv6Fail = await until(clientIpv6Fail, Buffer.from("\r\n\r\n"));
  assert(respIpv6Fail.toString("latin1").includes("502 Bad Gateway"));
  assert.strictEqual(invalidIpv6Connections, 1, "Invalid target IPv6 address was NOT retried (failed on attempt 1)");
  clientIpv6Fail.destroy();
  await bridgeIpv6Fail.close();
  await new Promise((resolve) => upstreamIpv6Fail.close(resolve));

  // Test 6: Abort during retry backoff cancels timer immediately and unblocks
  const upstreamAbort = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.destroy(); // Always reset so client retries
  });
  const portAbort = await listen(upstreamAbort);
  const bridgeAbort = await startAuthenticatedProxy(parseProxy("socks5://127.0.0.1:" + portAbort));
  const clientAbort = await connect(bridgeAbort.port);
  clientAbort.on("error", () => {});
  clientAbort.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const abortStart = Date.now();
  await bridgeAbort.close(); // Triggers controller.abort()
  const abortDuration = Date.now() - abortStart;
  assert(abortDuration < 500, "Bridge close unblocked promptly during retry backoff (" + abortDuration + "ms)");
  clientAbort.destroy();
  await new Promise((resolve) => upstreamAbort.close(resolve));

  console.log("SOCKS5_RETRY_SELFTEST_OK attempts=3 tunnel=1 echo=1 non_retryable_auth=1 non_retryable_code=1 non_retryable_version=1 non_retryable_ipv6=1 abort_backoff=1" + (isMutate ? " mutate=1" : ""));
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
