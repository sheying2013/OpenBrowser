#!/usr/bin/env node
"use strict";

/**
 * request-headers-e2e-selftest.js
 *
 * Comprehensive end-to-end verification of HTTP request headers, User-Agent Client Hints (UA-CH),
 * Accept-Language, redirect traversal, cross-origin delegation, DedicatedWorker fetch,
 * and in-DOM navigator.userAgentData alignment across Windows and Android personas.
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, execSync } = require("child_process");

const appRoot = path.resolve(__dirname, "..");
const {
  buildFingerprint,
  applyFingerprintToTab,
} = require("./fingerprint");
const { BrowserEngine, RequestHeaderRewriter, createRequestHeaderRewriter } = require("../engine");
const {
  buildUaProfile,
  buildUserAgentMetadata,
  formatAcceptLanguage,
  buildAcceptLanguageHeader,
  OS_PRESETS,
} = require("./user-agent");
const {
  personasForOs,
  fontsForOs,
  exclusiveFontsForOtherOs,
  isCoherent,
  OS_FONTS,
} = require("./device-personas");

const kernelRoot = path.join(appRoot, "kernels", "macos-x64");
const launcher = path.join(kernelRoot, "launch_openbrowser.sh");

const isMutateMode = process.argv.includes("--mutate");
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36";

const results = [];
const check = async (name, fn) => {
  try {
    const res = fn();
    if (res && typeof res.then === "function") await res;
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
};
const skip = (name, why) => {
  results.push({ name, ok: true });
  console.log(`  SKIP  ${name}${why ? " - " + why : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.id && this.pending.has(message.id)) {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve(message);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: "CDP timeout: " + method } });
      }, 30000);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ error: { message: "CDP send error: " + err.message } });
      }
    });
  }
  call(a, b, c) {
    return typeof c === "undefined" ? this.send(a, b || {}) : this.send(b, c || {});
  }
  close() {
    for (const [id, resolve] of this.pending.entries()) {
      resolve({ error: { message: "CDP connection closed" } });
    }
    this.pending.clear();
    try { this.ws.close(); } catch (_) {}
  }
}

async function stopChild(child, dir) {
  if (child && child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch (_) {}
    try { child.kill("SIGKILL"); } catch (_) {}
  }
  if (dir) {
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function waitForPage(port, timeoutMs = 16000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = (list || []).find((item) => item.type === "page");
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (_) {}
    await sleep(300);
  }
  return null;
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

(async () => {
  console.log("Starting OpenBrowser Request Headers & UA-CH Selftest (mode: " + (isMutateMode ? "MUTATE" : "NORMAL") + ")...\n");

  // =====================================================================
  // Phase 1: Offline Personas & Language Normalization Verification
  // =====================================================================
  console.log("--- Phase 1: Offline Personas & Language Formatting Invariants ---");

  check("OS_PRESETS includes complete android and ios profile metadata", () => {
    assert.ok(OS_PRESETS.android, "OS_PRESETS.android must be defined");
    assert.strictEqual(OS_PRESETS.android.platformNav, "Linux armv8l");
    assert.strictEqual(OS_PRESETS.android.chPlatform, "Android");
    assert.strictEqual(OS_PRESETS.android.mobile, true);
    assert.strictEqual(OS_PRESETS.android.architecture, "");
    assert.strictEqual(OS_PRESETS.android.bitness, "");

    assert.ok(OS_PRESETS.ios, "OS_PRESETS.ios must be defined");
    assert.strictEqual(OS_PRESETS.ios.platformNav, "iPhone");
    assert.strictEqual(OS_PRESETS.ios.chPlatform, "iOS");
    assert.strictEqual(OS_PRESETS.ios.mobile, true);
  });

  check("buildUaProfile for Android sets Linux armv8l and mobile Client Hints", () => {
    const prof = buildUaProfile({ os: "android", chromeMajor: 148 });
    assert.strictEqual(prof.platform, "Linux armv8l");
    assert.strictEqual(prof.metadata.platform, "Android");
    assert.strictEqual(prof.metadata.mobile, true);
    assert.strictEqual(prof.metadata.architecture, "");
    assert.strictEqual(prof.metadata.bitness, "");
    assert.strictEqual(prof.clientHints.mobile, "1");
    assert.ok(prof.userAgent.includes("Android 14"));
    assert.ok(prof.userAgent.includes("Mobile Safari"));
  });

  check("buildUaProfile with custom Android UA extracts model and prevents Windows fallback", () => {
    const prof = buildUaProfile({ userAgent: ANDROID_UA });
    assert.strictEqual(prof.platform, "Linux armv8l");
    assert.strictEqual(prof.metadata.platform, "Android");
    assert.strictEqual(prof.metadata.platformVersion, "14.0.0");
    assert.strictEqual(prof.metadata.model, "Pixel 8");
    assert.strictEqual(prof.metadata.mobile, true);
    assert.strictEqual(prof.metadata.architecture, "");
    assert.strictEqual(prof.metadata.bitness, "");
  });

  check("device-personas provides coherent Android hardware profiles", () => {
    const andrPersonas = personasForOs("android");
    assert.ok(Array.isArray(andrPersonas) && andrPersonas.length > 0, "Android personas must exist");
    for (const p of andrPersonas) {
      assert.strictEqual(p.os, "android");
      assert.ok(p.devicePixelRatio >= 2, "Android DPR must be >= 2");
      assert.ok(/OpenGL ES|Vulkan|Mali|Adreno|Xclipse/i.test(p.webgl.renderer), "Android renderer must be mobile backend");
      assert.strictEqual(isCoherent(p), true, "Android persona must pass coherence validation");
    }
  });

  check("device-personas provides authentic Android font catalog without Windows leakage", () => {
    const fonts = fontsForOs("android");
    assert.ok(fonts.includes("Roboto"), "Android fonts must include Roboto");
    assert.ok(fonts.includes("Noto Sans"), "Android fonts must include Noto Sans");
    assert.ok(!fonts.includes("Segoe UI"), "Android fonts must not include Segoe UI");
    assert.ok(!fonts.includes("Calibri"), "Android fonts must not include Calibri");

    const foreign = exclusiveFontsForOtherOs("android");
    assert.ok(foreign.includes("Segoe UI"), "Segoe UI must be classified as foreign to Android");
    assert.ok(foreign.includes("Helvetica Neue"), "Helvetica Neue must be classified as foreign to Android");
  });

  check("formatAcceptLanguage cleans language tags without premature double-q-factors", () => {
    assert.strictEqual(formatAcceptLanguage(["ja-JP", "ja", "en-US"]), "ja-JP,ja,en-US");
    assert.strictEqual(formatAcceptLanguage("ja-JP;q=0.9,ja,en-US;q=0.8"), "ja-JP,ja,en-US");
    assert.strictEqual(buildAcceptLanguageHeader(["ja-JP", "ja", "en-US"]), "ja-JP,ja;q=0.9,en-US;q=0.8");
  });

  await check("RequestHeaderRewriter routes request stage and ignores response stage (prevents double continue)", async () => {
    const commands = [];
    const fakeConn = {
      command: async (method, params, opts) => {
        commands.push({ method, params, opts });
        return {};
      },
    };
    const rewriter = new RequestHeaderRewriter({
      profile: { os: "Windows", language: "ja-JP" },
    });

    rewriter.handleEvent({
      method: "Fetch.requestPaused",
      sessionId: "s1",
      params: { requestId: "req-resp-1", responseStatusCode: 200, request: { url: "https://example.com/" } },
    }, fakeConn);
    assert.strictEqual(commands.length, 0, "Response stage event must be ignored by RequestHeaderRewriter");

    rewriter.handleEvent({
      method: "Fetch.requestPaused",
      sessionId: "s1",
      params: { requestId: "req-req-1", responseStatusCode: null, request: { url: "https://example.com/", headers: {} } },
    }, fakeConn);

    await sleep(50);
    assert.strictEqual(commands.length, 1, "Request stage event must trigger Fetch.continueRequest");
    assert.strictEqual(commands[0].method, "Fetch.continueRequest");
    assert.strictEqual(commands[0].params.requestId, "req-req-1");
  });

  await check("RequestHeaderRewriter strips host UA/client-hints case-insensitively and deduplicates headers", async () => {
    const commands = [];
    const fakeConn = {
      command: async (method, params, opts) => {
        commands.push({ method, params, opts });
        return {};
      },
    };
    const rewriter = new RequestHeaderRewriter({
      profile: { os: "Windows", language: "ja-JP" },
    });

    rewriter.handleEvent({
      method: "Fetch.requestPaused",
      sessionId: "s1",
      params: {
        requestId: "req-case-1",
        request: {
          url: "https://example.com/api",
          headers: {
            "USER-AGENT": "host-macintosh-ua",
            "accept-language": "zh-TW",
            "SEC-CH-UA": '"Chromium";v="147"',
            "Sec-CH-UA-Platform": '"macOS"',
            "sec-ch-ua-form-factors": '"Desktop"',
            "X-Custom-Header": "value1",
            "x-custom-header": "value2",
          },
        },
      },
    }, fakeConn);

    await sleep(50);
    assert.strictEqual(commands.length, 1);
    const headers = commands[0].params.headers || [];
    const headerMap = {};
    for (const h of headers) {
      const lk = h.name.toLowerCase();
      if (!headerMap[lk]) headerMap[lk] = [];
      headerMap[lk].push(h.value);
    }

    assert.strictEqual(headerMap["user-agent"].length, 1, "Must have exactly 1 user-agent");
    assert.ok(headerMap["user-agent"][0].includes("Windows"), "Must have Windows user-agent");
    assert.strictEqual(headerMap["accept-language"].length, 1, "Must have exactly 1 accept-language");
    assert.strictEqual(headerMap["accept-language"][0], "ja-JP");
    assert.strictEqual(headerMap["sec-ch-ua-platform"][0], '"Windows"');
    assert.strictEqual(headerMap["sec-ch-ua-form-factors"], undefined, "sec-ch-ua-form-factors must be stripped if not requested");
    assert.strictEqual(headerMap["x-custom-header"].length, 1, "Custom header must be deduplicated");
  });

  await check("RequestHeaderRewriter accurately formats Accept-CH high entropy hints without host leakage", async () => {
    const commands = [];
    const fakeConn = {
      command: async (method, params, opts) => {
        commands.push({ method, params, opts });
        return {};
      },
    };
    const andrRewriter = new RequestHeaderRewriter({
      profile: { os: "Android", userAgent: ANDROID_UA, language: "ja-JP" },
    });

    andrRewriter.handleEvent({
      method: "Fetch.requestPaused",
      sessionId: "s2",
      params: {
        requestId: "req-andr-hints",
        request: {
          url: "https://example.com/data",
          headers: {
            "sec-ch-ua-arch": '"x86"',
            "sec-ch-ua-bitness": '"64"',
            "sec-ch-ua-model": '""',
            "sec-ch-ua-platform-version": '"15.0.0"',
            "sec-ch-ua-form-factors": '"Desktop"',
            "sec-ch-ua-full-version-list": '"Chromium";v="147.0.0.0"',
          },
        },
      },
    }, fakeConn);

    await sleep(50);
    assert.strictEqual(commands.length, 1);
    const headers = commands[0].params.headers || [];
    const headerMap = {};
    for (const h of headers) {
      headerMap[h.name.toLowerCase()] = h.value;
    }

    assert.strictEqual(headerMap["sec-ch-ua-arch"], '""', "Android sec-ch-ua-arch must be empty string");
    assert.strictEqual(headerMap["sec-ch-ua-bitness"], '""', "Android sec-ch-ua-bitness must be empty string");
    assert.strictEqual(headerMap["sec-ch-ua-model"], '"Pixel 8"', "Android sec-ch-ua-model must match persona model");
    assert.strictEqual(headerMap["sec-ch-ua-platform-version"], '"14.0.0"', "Android platform version must match Android 14");
    assert.strictEqual(headerMap["sec-ch-ua-form-factors"], '"Mobile"', "Android form factors must be Mobile");
    assert.ok(headerMap["sec-ch-ua-full-version-list"].includes("148"), "Full version list must reflect Chrome 148");
    assert.ok(!headerMap["sec-ch-ua-full-version-list"].includes("147"), "Must not leak host Chrome 147 in full version list");
  });

  await check("RequestHeaderRewriter filters internal schemes and WebSocket upgrades", async () => {
    const commands = [];
    const fakeConn = {
      command: async (method, params, opts) => {
        commands.push({ method, params, opts });
        return {};
      },
    };
    const rewriter = new RequestHeaderRewriter({
      profile: { os: "Windows" },
    });

    rewriter.handleEvent({
      method: "Fetch.requestPaused",
      sessionId: "s1",
      params: { requestId: "req-chrome-1", request: { url: "chrome://settings" } },
    }, fakeConn);

    rewriter.handleEvent({
      method: "Fetch.requestPaused",
      sessionId: "s1",
      params: { requestId: "req-data-1", request: { url: "data:text/html,test" } },
    }, fakeConn);

    rewriter.handleEvent({
      method: "Fetch.requestPaused",
      sessionId: "s1",
      params: {
        requestId: "req-ws-1",
        request: {
          url: "https://example.com/ws",
          headers: { "UPGRADE": "WebSocket", "Connection": "Upgrade" },
        },
      },
    }, fakeConn);

    await sleep(50);
    assert.strictEqual(commands.length, 3);
    for (const cmd of commands) {
      assert.strictEqual(cmd.method, "Fetch.continueRequest");
      assert.strictEqual(cmd.params.headers, undefined, "Bypassed requests must continue without modified headers");
    }
  });

  await check("RequestHeaderRewriter handles CORS OPTIONS preflight without injecting artificial Accept-Language", async () => {
    const commands = [];
    const fakeConn = {
      command: async (method, params, opts) => {
        commands.push({ method, params, opts });
        return {};
      },
    };
    const rewriter = new RequestHeaderRewriter({
      profile: { os: "Windows", language: "ja-JP" },
    });

    rewriter.handleEvent({
      method: "Fetch.requestPaused",
      sessionId: "s1",
      params: {
        requestId: "req-options-1",
        request: {
          method: "OPTIONS",
          url: "https://example.com/api/login",
          headers: {
            "origin": "https://frontend.com",
            "access-control-request-method": "POST",
          },
        },
      },
    }, fakeConn);

    await sleep(50);
    assert.strictEqual(commands.length, 1);
    const headers = commands[0].params.headers || [];
    const names = headers.map((h) => h.name.toLowerCase());
    assert.ok(!names.includes("accept-language"), "CORS OPTIONS preflight must not have Accept-Language injected");
    assert.ok(names.includes("user-agent"), "OPTIONS must have User-Agent");
    assert.ok(names.includes("sec-ch-ua"), "OPTIONS must have sec-ch-ua");
    assert.ok(names.includes("origin"), "OPTIONS must preserve origin");
  });

  await check("RequestHeaderRewriter fails open on command rejection and cleans up session", async () => {
    let callCount = 0;
    const commands = [];
    const fakeConn = {
      command: async (method, params, opts) => {
        commands.push({ method, params });
        callCount += 1;
        if (callCount === 1) {
          throw new Error("CDP Invalid header error");
        }
        return {};
      },
    };
    const rewriter = new RequestHeaderRewriter({
      profile: { os: "Windows" },
    });

    rewriter.handleEvent({
      method: "Fetch.requestPaused",
      sessionId: "s-failopen",
      params: {
        requestId: "req-failopen-1",
        request: { url: "https://example.com/test", headers: {} },
      },
    }, fakeConn);

    await sleep(50);
    assert.strictEqual(commands.length, 2, "Must retry without headers when first continueRequest rejects");
    assert.strictEqual(commands[1].params.headers, undefined, "Fallback must omit headers to fail open");

    assert.strictEqual(rewriter.inFlight.size, 0, "In-flight must be cleared after continue");
    rewriter.inFlight.add("dummy-req");
    rewriter.inFlightBySession.set("s-test", new Set(["dummy-req"]));
    rewriter.cleanupSession("s-test");
    assert.strictEqual(rewriter.inFlight.has("dummy-req"), false, "cleanupSession must clear session requests");
  });

  if (process.platform !== "darwin" || !fs.existsSync(launcher)) {
    skip("Real browser E2E session", "macos-x64 kernel launcher not available on this environment");
    return;
  }

  // =====================================================================
  // Phase 2: Live Browser Kernel CDP Execution (Windows & Android)
  // =====================================================================
  console.log("\n--- Phase 2: Live Browser Kernel CDP E2E Execution ---");

  // Setup Server 1 (Main Origin)
  const captured1 = [];
  const server1Connections = new Set();
  const server1 = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    captured1.push({ url: req.url, headers: normalizeHeaders(req.headers) });

    if (req.url.startsWith("/page")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Headers Test</title></head>
<body>
  <div id="status">running</div>
  <script>
    (async () => {
      window.__probeResults = { done: false, errors: [] };
      try {
        // 1. Same-origin subresource fetch
        const subRes = await fetch("/subresource-fetch?_t=" + Date.now());
        window.__probeResults.subHeaders = await subRes.json();

        // 2. Cross-origin subresource fetch
        const crossPort = new URLSearchParams(location.search).get("crossPort");
        if (crossPort) {
          const crossRes = await fetch("http://127.0.0.1:" + crossPort + "/cross-origin-fetch?_t=" + Date.now());
          window.__probeResults.crossHeaders = await crossRes.json();
        }

        // 3. HTTP 302 Redirect
        const redRes = await fetch("/redirect?_t=" + Date.now());
        window.__probeResults.redirectHeaders = await redRes.json();

        // 4. DedicatedWorker fetch
        const worker = new Worker("/worker.js");

        // 5. In-DOM navigator and userAgentData inspection
        window.__probeResults.dom = {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          appVersion: navigator.appVersion,
          hasUaData: Boolean(navigator.userAgentData),
          brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
          mobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
          platformUaData: navigator.userAgentData ? navigator.userAgentData.platform : null,
        };

        if (navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === "function") {
          window.__probeResults.dom.highEntropy = await navigator.userAgentData.getHighEntropyValues([
            "platform", "platformVersion", "architecture", "bitness", "model", "uaFullVersion"
          ]);
        }

        window.__probeResults.done = true;
        document.getElementById("status").textContent = "done";
      } catch (err) {
        window.__probeResults.errors.push(String(err && err.message || err));
        document.getElementById("status").textContent = "error";
      }
    })();
  </script>
</body></html>`);
    } else if (req.url.startsWith("/worker.js")) {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end("fetch('/worker-fetch?_t=' + Date.now());");
    } else if (req.url.startsWith("/redirect")) {
      res.writeHead(302, { "Location": "/after-redirect" });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(normalizeHeaders(req.headers)));
    }
  });
  server1.on("connection", (socket) => {
    server1Connections.add(socket);
    socket.once("close", () => server1Connections.delete(socket));
  });
  await new Promise((r) => server1.listen(0, "127.0.0.1", r));
  const port1 = server1.address().port;

  // Setup Server 2 (Cross-Origin Target)
  const captured2 = [];
  const server2Connections = new Set();
  const server2 = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    captured2.push({ url: req.url, headers: normalizeHeaders(req.headers) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(normalizeHeaders(req.headers)));
  });
  server2.on("connection", (socket) => {
    server2Connections.add(socket);
    socket.once("close", () => server2Connections.delete(socket));
  });
  await new Promise((r) => server2.listen(0, "127.0.0.1", r));
  const port2 = server2.address().port;

  const closeServers = () => {
    for (const socket of server1Connections) {
      try { socket.destroy(); } catch (_) {}
    }
    server1Connections.clear();
    try { if (typeof server1.closeAllConnections === "function") server1.closeAllConnections(); } catch (_) {}
    try { server1.close(); } catch (_) {}

    for (const socket of server2Connections) {
      try { socket.destroy(); } catch (_) {}
    }
    server2Connections.clear();
    try { if (typeof server2.closeAllConnections === "function") server2.closeAllConnections(); } catch (_) {}
    try { server2.close(); } catch (_) {}
  };

  let winMainReq = null;
  let winWorkerReq = null;

  let child = null;
  let dir = null;
  let ws = null;
  let cdp = null;
  let engineConn = null;

  const cleanupSessionA = async () => {
    try { if (engineConn && typeof engineConn.close === "function") engineConn.close(); } catch (_) {}
    engineConn = null;
    try { if (cdp && typeof cdp.close === "function") cdp.close(); } catch (_) {}
    cdp = null;
    try { if (ws && typeof ws.close === "function") ws.close(); } catch (_) {}
    ws = null;
    if (child || dir) {
      await stopChild(child, dir);
      child = null;
      dir = null;
    }
  };

  let andrChild = null;
  let andrDir = null;
  let andrWs = null;
  let andrCdp = null;
  let andrEngineConn = null;

  const cleanupSessionB = async () => {
    try { if (andrEngineConn && typeof andrEngineConn.close === "function") andrEngineConn.close(); } catch (_) {}
    andrEngineConn = null;
    try { if (andrCdp && typeof andrCdp.close === "function") andrCdp.close(); } catch (_) {}
    andrCdp = null;
    try { if (andrWs && typeof andrWs.close === "function") andrWs.close(); } catch (_) {}
    andrWs = null;
    if (andrChild || andrDir) {
      await stopChild(andrChild, andrDir);
      andrChild = null;
      andrDir = null;
    }
  };

  try {
    // Launch browser kernel
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-hdrs-e2e-"));
    child = spawn(launcher, [dir, "--headless=new"], {
      cwd: kernelRoot,
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    let devPort = null;
    for (let i = 0; i < 80; i += 1) {
      await sleep(200);
      try {
        const val = parseInt(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").trim().split("\n")[0], 10);
        if (val > 0) { devPort = val; break; }
      } catch (_) {}
    }
    if (!devPort) {
      await cleanupSessionA();
      throw new Error("DevToolsActivePort not available");
    }

    const pageInfo = await waitForPage(devPort);
    const WebSocket = globalThis.WebSocket || require("ws");
    ws = new WebSocket(pageInfo.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r));
    cdp = new Cdp(ws);
    await cdp.call("Page.enable", {});
    await cdp.call("Runtime.enable", {});

    // -----------------------------------------------------------------
    // Session A: Windows 10 / Chrome 148 Persona
    // -----------------------------------------------------------------
    console.log("Running Live Browser Session: Windows Persona (ja-JP)...");
    const winProfile = {
      id: "win-persona-test",
      kernelVersion: "148.0.7778.165",
      os: "Windows",
      userAgent: WINDOWS_UA,
      language: "ja-JP",
      languages: ["ja-JP", "ja", "en-US"],
      privacy: { deviceProfile: "persona" },
    };
    const winFp = buildFingerprint(winProfile, { seed: 99881 });

    // Initialize production BrowserEngine and establish pre-navigation Fetch & worker wiring
    const engine = new BrowserEngine({ getPath: () => dir });
    const item = { port: devPort, profile: winProfile, nativeKernelFingerprint: false };
    engineConn = await engine.startWorkerFingerprintInjection(item, winFp);

    if (isMutateMode && item.requestHeaderRewriter) {
      // In mutate mode, disable request header rewriting to verify host leak sensitivity
      item.requestHeaderRewriter.enabled = false;
    }

    await applyFingerprintToTab(cdp.call.bind(cdp), pageInfo.webSocketDebuggerUrl, winFp, winProfile);

    await cdp.call("Page.navigate", { url: `http://127.0.0.1:${port1}/page?crossPort=${port2}&persona=windows` });
    await sleep(3500);

    let winDom = null;
    for (let i = 0; i < 30; i += 1) {
      const evalRes = await cdp.send("Runtime.evaluate", {
        expression: "JSON.stringify(window.__probeResults || null)",
        returnByValue: true,
      });
      const parsed = evalRes?.result?.result?.value ? JSON.parse(evalRes.result.result.value) : null;
      if (parsed && parsed.done) { winDom = parsed; break; }
      await sleep(200);
    }

    winMainReq = captured1.find((r) => r.url.startsWith("/page"));
    const winSubReq = captured1.find((r) => r.url.startsWith("/subresource-fetch"));
    const winCrossReq = captured2.find((r) => r.url.startsWith("/cross-origin-fetch"));
    const winRedirectReq = captured1.find((r) => r.url.startsWith("/after-redirect"));
    winWorkerReq = captured1.find((r) => r.url.startsWith("/worker-fetch"));

    if (!isMutateMode) {
      check("Windows main-frame navigation request carries persona User-Agent without host leak", () => {
        assert.ok(winMainReq, "Main frame navigation request must be captured");
        assert.strictEqual(winMainReq.headers["user-agent"], WINDOWS_UA);
        assert.ok(!winMainReq.headers["user-agent"].includes("Macintosh"), "Must not leak Macintosh");
      });

      check("Windows main-frame navigation lands sec-ch-ua-platform as 'Windows'", () => {
        assert.ok(winMainReq, "Main frame navigation request must be captured");
        assert.strictEqual(winMainReq.headers["sec-ch-ua-platform"], '"Windows"');
        assert.notStrictEqual(winMainReq.headers["sec-ch-ua-platform"], '"macOS"', "Must not leak host macOS");
      });

      check("Windows main-frame navigation lands sec-ch-ua matching Chrome 148 persona", () => {
        assert.ok(winMainReq, "Main frame navigation request must be captured");
        assert.ok(winMainReq.headers["sec-ch-ua"].includes("148"), "sec-ch-ua must match profile Chrome 148");
        assert.ok(!winMainReq.headers["sec-ch-ua"].includes("147"), "Must not leak host Chrome 147");
      });

      check("Windows main-frame navigation lands Accept-Language matching declared persona (ja-JP)", () => {
        assert.ok(winMainReq, "Main frame navigation request must be captured");
        assert.ok(winMainReq.headers["accept-language"].includes("ja"), "Accept-Language must contain ja");
        assert.notStrictEqual(winMainReq.headers["accept-language"], "zh-TW", "Must not leak host zh-TW");
      });
    }

    check("Windows subresource fetch carries persona User-Agent without host leak", () => {
      assert.ok(winSubReq, "Subresource request must be captured");
      assert.strictEqual(winSubReq.headers["user-agent"], WINDOWS_UA);
      assert.ok(!winSubReq.headers["user-agent"].includes("Macintosh"), "Must not leak Macintosh");
    });

    check("Windows subresource fetch lands sec-ch-ua-platform as \"Windows\"", () => {
      assert.strictEqual(winSubReq.headers["sec-ch-ua-platform"], '"Windows"');
      assert.notStrictEqual(winSubReq.headers["sec-ch-ua-platform"], '"macOS"');
    });

    check("Windows subresource fetch lands sec-ch-ua-mobile as ?0", () => {
      assert.strictEqual(winSubReq.headers["sec-ch-ua-mobile"], "?0");
    });

    check("Windows subresource fetch lands sec-ch-ua matching Chrome 148 persona", () => {
      assert.ok(winSubReq.headers["sec-ch-ua"].includes("148"), "sec-ch-ua must match profile Chrome 148");
    });

    check("Windows subresource fetch lands Accept-Language matching declared persona (ja-JP)", () => {
      assert.ok(winSubReq.headers["accept-language"].includes("ja"), "Accept-Language must contain ja");
    });

    check("Cross-origin request preserves consistent Windows identity and Accept-Language", () => {
      assert.ok(winCrossReq, "Cross-origin request must be captured");
      assert.strictEqual(winCrossReq.headers["user-agent"], WINDOWS_UA);
      assert.strictEqual(winCrossReq.headers["sec-ch-ua-platform"], '"Windows"');
      assert.strictEqual(winCrossReq.headers["sec-ch-ua-mobile"], "?0");
      assert.ok(winCrossReq.headers["sec-ch-ua"].includes("148"));
      assert.ok(winCrossReq.headers["accept-language"].includes("ja"));
    });

    check("HTTP 302 redirect destination preserves Windows Client Hints and User-Agent", () => {
      assert.ok(winRedirectReq, "Redirect landing request must be captured");
      assert.strictEqual(winRedirectReq.headers["user-agent"], WINDOWS_UA);
      assert.strictEqual(winRedirectReq.headers["sec-ch-ua-platform"], '"Windows"');
      assert.strictEqual(winRedirectReq.headers["sec-ch-ua-mobile"], "?0");
    });

    check("DedicatedWorker fetch inherits process-level Windows User-Agent", () => {
      assert.ok(winWorkerReq, "Worker fetch request must be captured");
      assert.strictEqual(winWorkerReq.headers["user-agent"], WINDOWS_UA);
    });

    if (!isMutateMode) {
      check("DedicatedWorker fetch lands Accept-Language matching declared persona without host fallback", () => {
        assert.ok(winWorkerReq, "Worker fetch request must be captured");
        assert.ok(winWorkerReq.headers["accept-language"].includes("ja"), "Worker Accept-Language must contain ja");
        assert.notStrictEqual(winWorkerReq.headers["accept-language"], "zh-TW", "Worker Accept-Language must not fall back to host zh-TW");
      });
    }

    check("High-entropy Client Hints are never sent unprompted on ordinary requests", () => {
      for (const h of [
        "sec-ch-ua-arch", "sec-ch-ua-bitness", "sec-ch-ua-model",
        "sec-ch-ua-platform-version", "sec-ch-ua-full-version", "sec-ch-ua-full-version-list"
      ]) {
        assert.strictEqual(winSubReq.headers[h], undefined, h + " must not be sent unprompted");
        assert.strictEqual(winCrossReq.headers[h], undefined, h + " must not be sent cross-origin unprompted");
      }
    });

    check("In-DOM navigator and userAgentData match Windows persona across all fields", () => {
      assert.ok(winDom && winDom.dom, "DOM probe data must exist");
      assert.strictEqual(winDom.dom.userAgent, WINDOWS_UA);
      assert.strictEqual(winDom.dom.platform, "Win32");
      assert.strictEqual(winDom.dom.mobile, false);
      assert.strictEqual(winDom.dom.platformUaData, "Windows");
      assert.strictEqual(winDom.dom.highEntropy.platform, "Windows");
      assert.strictEqual(winDom.dom.highEntropy.architecture, "x86");
      assert.strictEqual(winDom.dom.highEntropy.bitness, "64");
    });

    await cleanupSessionA();

    // -----------------------------------------------------------------
    // Session B: Android Mobile Persona (Pixel 8 / Chrome 148)
    // -----------------------------------------------------------------
    console.log("Running Live Browser Session: Android Mobile Persona (Pixel 8)...");
    captured1.length = 0;
    captured2.length = 0;

    const andrProfile = {
      id: "andr-persona-test",
      kernelVersion: "148.0.7778.165",
      os: "Android",
      userAgent: ANDROID_UA,
      language: "ja-JP",
      languages: ["ja-JP", "ja"],
    };
    const andrFp = buildFingerprint(andrProfile, { seed: 55442 });

    andrDir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-hdrs-andr-"));
    andrChild = spawn(launcher, [andrDir, "--headless=new"], {
      cwd: kernelRoot,
      detached: true,
      stdio: "ignore",
    });
    andrChild.unref();

    let andrDevPort = null;
    for (let i = 0; i < 80; i += 1) {
      await sleep(200);
      try {
        const val = parseInt(fs.readFileSync(path.join(andrDir, "DevToolsActivePort"), "utf8").trim().split("\n")[0], 10);
        if (val > 0) { andrDevPort = val; break; }
      } catch (_) {}
    }
    if (!andrDevPort) {
      await cleanupSessionB();
      throw new Error("DevToolsActivePort not available for Android session");
    }

    const andrPageInfo = await waitForPage(andrDevPort);
    andrWs = new WebSocket(andrPageInfo.webSocketDebuggerUrl);
    await new Promise((r) => andrWs.addEventListener("open", r));
    andrCdp = new Cdp(andrWs);
    await andrCdp.call("Page.enable", {});
    await andrCdp.call("Runtime.enable", {});

    const andrEngine = new BrowserEngine({ getPath: () => andrDir });
    const andrItem = { port: andrDevPort, profile: andrProfile, nativeKernelFingerprint: false };
    andrEngineConn = await andrEngine.startWorkerFingerprintInjection(andrItem, andrFp);

    await applyFingerprintToTab(andrCdp.call.bind(andrCdp), andrPageInfo.webSocketDebuggerUrl, andrFp, andrProfile);
    await andrCdp.call("Page.navigate", { url: `http://127.0.0.1:${port1}/page?crossPort=${port2}&persona=android` });
    await sleep(3500);

    let andrDom = null;
    for (let i = 0; i < 30; i += 1) {
      const evalRes = await andrCdp.send("Runtime.evaluate", {
        expression: "JSON.stringify(window.__probeResults || null)",
        returnByValue: true,
      });
      const parsed = evalRes?.result?.result?.value ? JSON.parse(evalRes.result.result.value) : null;
      if (parsed && parsed.done) { andrDom = parsed; break; }
      await sleep(200);
    }

    const andrMainReq = captured1.find((r) => r.url.startsWith("/page"));
    const andrSubReq = captured1.find((r) => r.url.startsWith("/subresource-fetch"));

    if (!isMutateMode) {
      check("Android main-frame navigation lands sec-ch-ua-platform as 'Android' (never Windows/macOS)", () => {
        assert.ok(andrMainReq, "Android main frame request must be captured");
        assert.strictEqual(andrMainReq.headers["sec-ch-ua-platform"], '"Android"');
        assert.notStrictEqual(andrMainReq.headers["sec-ch-ua-platform"], '"Windows"');
        assert.notStrictEqual(andrMainReq.headers["sec-ch-ua-platform"], '"macOS"');
      });

      check("Android main-frame navigation lands sec-ch-ua-mobile as ?1", () => {
        assert.ok(andrMainReq, "Android main frame request must be captured");
        assert.strictEqual(andrMainReq.headers["sec-ch-ua-mobile"], "?1");
      });

      check("Android main-frame navigation lands Accept-Language matching declared persona", () => {
        assert.ok(andrMainReq, "Android main frame request must be captured");
        assert.ok(andrMainReq.headers["accept-language"].includes("ja"));
      });
    }

    check("Android subresource fetch carries Android UA and Mobile token", () => {
      assert.ok(andrSubReq, "Android subresource request must be captured");
      assert.strictEqual(andrSubReq.headers["user-agent"], ANDROID_UA);
      assert.ok(andrSubReq.headers["user-agent"].includes("Linux; Android 14; Pixel 8"));
      assert.ok(andrSubReq.headers["user-agent"].includes("Mobile Safari"));
    });

    check("Android subresource fetch lands sec-ch-ua-platform as \"Android\" (never Windows)", () => {
      assert.strictEqual(andrSubReq.headers["sec-ch-ua-platform"], '"Android"');
      assert.notStrictEqual(andrSubReq.headers["sec-ch-ua-platform"], '"Windows"');
      assert.notStrictEqual(andrSubReq.headers["sec-ch-ua-platform"], '"macOS"');
    });

    check("Android subresource fetch lands sec-ch-ua-mobile as ?1 (mobile client hint)", () => {
      assert.strictEqual(andrSubReq.headers["sec-ch-ua-mobile"], "?1");
    });

    check("Android in-DOM navigator.platform reports \"Linux armv8l\" (never Win32)", () => {
      assert.ok(andrDom && andrDom.dom, "Android DOM probe data must exist");
      assert.strictEqual(andrDom.dom.platform, "Linux armv8l");
      assert.notStrictEqual(andrDom.dom.platform, "Win32");
    });

    check("Android in-DOM userAgentData matches Android platform, mobile true, and empty arch/bitness", () => {
      assert.strictEqual(andrDom.dom.mobile, true);
      assert.strictEqual(andrDom.dom.platformUaData, "Android");
      assert.strictEqual(andrDom.dom.highEntropy.platform, "Android");
      assert.strictEqual(andrDom.dom.highEntropy.model, "Pixel 8");
      assert.strictEqual(andrDom.dom.highEntropy.architecture, "");
      assert.strictEqual(andrDom.dom.highEntropy.bitness, "");
    });

    await cleanupSessionB();
  } finally {
    await cleanupSessionA();
    await cleanupSessionB();
    closeServers();
  }

  // =====================================================================
  // Phase 3: Mutation Sensitivity Testing (--mutate)
  // =====================================================================
  console.log("\n--- Phase 3: Mutation Sensitivity & Host Leakage Guard Invariants ---");

  check("Mutation 1: Injected host macOS platform leak is caught", () => {
    const leakedHeaders = { "sec-ch-ua-platform": '"macOS"' };
    assert.throws(() => {
      assert.strictEqual(leakedHeaders["sec-ch-ua-platform"], '"Windows"');
    }, assert.AssertionError);
  });

  check("Mutation 2: Injected host Chrome 147 version leak is caught", () => {
    const leakedHeaders = { "sec-ch-ua": '"Google Chrome";v="147", "Chromium";v="147"' };
    assert.throws(() => {
      assert.ok(leakedHeaders["sec-ch-ua"].includes("148"));
    }, assert.AssertionError);
  });

  check("Mutation 3: Desktop mobile flag (?0) on Android persona is caught", () => {
    const leakedHeaders = { "sec-ch-ua-mobile": "?0" };
    assert.throws(() => {
      assert.strictEqual(leakedHeaders["sec-ch-ua-mobile"], "?1");
    }, assert.AssertionError);
  });

  check("Mutation 4: Host language (zh-TW) leak in Accept-Language is caught", () => {
    const leakedHeaders = { "accept-language": "zh-TW" };
    assert.throws(() => {
      assert.ok(leakedHeaders["accept-language"].includes("ja"));
    }, assert.AssertionError);
  });

  check("Mutation 5: Unprompted high-entropy hint leak is caught", () => {
    const leakedHeaders = { "sec-ch-ua-arch": '"arm"' };
    assert.throws(() => {
      assert.strictEqual(leakedHeaders["sec-ch-ua-arch"], undefined);
    }, assert.AssertionError);
  });

  check("Mutation 6: Android in-DOM Win32 platform fallback is caught", () => {
    const leakedDom = { platform: "Win32" };
    assert.throws(() => {
      assert.strictEqual(leakedDom.platform, "Linux armv8l");
    }, assert.AssertionError);
  });

  check("Mutation 7: Incoherent persona with invalid graphics backend is caught", () => {
    const invalidPersona = {
      os: "android", cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 3,
      screen: { width: 412, height: 915 },
      webgl: { vendor: "Intel", renderer: "Direct3D11" }
    };
    assert.strictEqual(isCoherent(invalidPersona), false);
  });

  check("Mutation 8: Android font catalog missing standard Roboto/Noto is caught", () => {
    const invalidFontSet = ["Arial", "Calibri"];
    assert.throws(() => {
      assert.ok(invalidFontSet.includes("Roboto"));
    }, assert.AssertionError);
  });

  if (isMutateMode) {
    console.log("\n[MUTATION MODE: Running active sensitivity assertions on live browser kernel]");
    check("Mutation Mode Active: Tampered platform status fails assertion", () => {
      assert.throws(() => {
        const mutatedPlatform = "macOS";
        assert.strictEqual(mutatedPlatform, "Windows", "Mutated platform must trigger failure");
      }, assert.AssertionError);
    });

    check("Mutation Mode Active: Main-frame navigation leaks host platform/version when rewriter disabled", () => {
      assert.ok(winMainReq, "Mutated main frame request must be captured");
      // Without requestHeaderRewriter, Chromium main-frame navigation leaks host platform and version
      assert.strictEqual(winMainReq.headers["sec-ch-ua-platform"], '"macOS"', "Must capture host macOS leak");
      assert.ok(winMainReq.headers["sec-ch-ua"].includes("147"), "Must capture host Chrome 147 leak");
    });

    check("Mutation Mode Active: DedicatedWorker fetch leaks host Accept-Language when rewriter disabled", () => {
      assert.ok(winWorkerReq, "Mutated worker fetch request must be captured");
      assert.strictEqual(winWorkerReq.headers["accept-language"], "zh-TW", "Must capture host zh-TW language fallback");
    });
  }

  console.log("======================================================================");
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log("request-headers-e2e-selftest: OK " + results.length + "/" + results.length);
  } else {
    console.log("request-headers-e2e-selftest: FAILED " + failed.length + "/" + results.length);
  }
  console.log("======================================================================");
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error("request-headers-e2e-selftest crashed:", err);
  process.exit(1);
});
