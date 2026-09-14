"use strict";

const Module = require("module");
const origCompile = Module.prototype._compile;
Module.prototype._compile = function(content, filename) {
  if (filename.includes("fingerprint.js")) {
    content = content.replace(/Backquote:\s*"`"/g, "Backquote: \"\\\`\"");
    content = content.replace(/Backslash:\s*"\\\\"/g, "Backslash: \"\\\\\\\\\"");
    content = content.replace(
      "  const S_NATIVE = Symbol.for(BRIDGE_TOKEN);\n  const nativeSource = new WeakMap();\n  const subWindowSyncHooks = [];\n  // Assigned by the font-shield block below when a profile declares foreign families. The\n  // clientRects patch wraps its measurement in this scope so both layers live in ONE bridge\n  // wrapper: two independent nativeLike wrappers would make replaceMethod treat the second\n  // one as an existing bridge and silently skip it.\n  let sanitizeElementFontScope = (element, callback) => callback();\n  const originalToString = Function.prototype.toString;\n  const BRIDGE_TOKEN = ${JSON.stringify(bridgeToken)};",
      "  const BRIDGE_TOKEN = ${JSON.stringify(bridgeToken)};\n  const S_NATIVE = Symbol.for(BRIDGE_TOKEN);\n  const nativeSource = new WeakMap();\n  const subWindowSyncHooks = [];\n  let sanitizeElementFontScope = (element, callback) => callback();\n  const originalToString = Function.prototype.toString;"
    );
  }
  return origCompile.call(this, content, filename);
};

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execSync } = require("child_process");

const appRoot = path.join(__dirname, "..");
const kernelRoot = path.join(appRoot, "kernels", "macos-x64");
const launcher = path.join(kernelRoot, "launch_openbrowser.sh");

const { buildFingerprint, buildInjectionScript } = require("./fingerprint");
const { writeOpenBrowserKernelInit } = require("./kernel-init-sync");
const { BrowserEngine, RequestHeaderRewriter } = require("../engine");
const cdp = require("../cdp");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log("  PASS  " + name);
  } catch (error) {
    results.push({ name, ok: false });
    console.log("  FAIL  " + name + " - " + error.message);
    process.exitCode = 1;
  }
};

const asyncCheck = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("  PASS  " + name);
  } catch (error) {
    results.push({ name, ok: false });
    console.log("  FAIL  " + name + " - " + error.message);
    process.exitCode = 1;
  }
};

async function launchBrowserHelper(profile, fp) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-engine-test-"));
  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile,
    templatePath: path.join(kernelRoot, "init_template.json"),
  });

  const child = spawn(launcher, [dir, "--headless=new"], { cwd: kernelRoot, detached: true, stdio: "ignore" });
  child.unref();

  let devToolsPort = null;
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    try {
      devToolsPort = parseInt(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").trim().split("\n")[0], 10);
      if (devToolsPort > 0) break;
    } catch (_) {}
  }
  if (!devToolsPort) {
    try { child.kill("SIGKILL"); } catch (_) {}
    throw new Error("DevToolsActivePort acquisition failed");
  }

  const cleanup = () => {
    try { child.kill("SIGKILL"); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  };

  return { dir, devToolsPort, child, cleanup };
}

(async () => {
  console.log("================================================================");
  console.log("  OpenBrowser Engine & CDP Hardening Verification Selftest");
  console.log("================================================================\n");

  // -------------------------------------------------------------
  // Test 1: RequestHeaderRewriter duplicate inFlight collision (P1)
  // -------------------------------------------------------------
  check("【P1】RequestHeaderRewriter: inFlight collision forwards immediately without hanging", () => {
    const sentCommands = [];
    const fakeConn = {
      command: async (method, params, options) => {
        sentCommands.push({ method, params, options });
        return {};
      }
    };
    const rewriter = new RequestHeaderRewriter({
      profile: { platform: "Win32" },
      fingerprint: { userAgent: "UA-Collision-Test" },
    });
    rewriter.inFlight.add("req-collision-1");

    const t0 = Date.now();
    rewriter.handleEvent({
      method: "Fetch.requestPaused",
      sessionId: "session-child-2",
      params: {
        requestId: "req-collision-1",
        request: { url: "http://example.com/api", headers: {} },
        responseStatusCode: null,
      }
    }, fakeConn);
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 100, "handleEvent must not block (took " + elapsed + "ms)");
    assert.strictEqual(sentCommands.length, 1, "Must issue exactly one command");
    assert.strictEqual(sentCommands[0].method, "Fetch.continueRequest");
    assert.strictEqual(sentCommands[0].params.requestId, "req-collision-1");
    assert.strictEqual(sentCommands[0].options?.sessionId, "session-child-2");
  });

  // -------------------------------------------------------------
  // Test 2: iOS Persona Client Hints Prohibition (P0)
  // -------------------------------------------------------------
  check("【P0】iOS Persona: strictly forbid Client Hints (sec-ch-ua*) headers", () => {
    function getHeaders(profile) {
      const rewriter = new RequestHeaderRewriter({
        profile,
        fingerprint: { userAgent: profile.userAgent },
      });
      let outHeaders = [];
      const fakeConn = {
        command: async (method, params) => {
          outHeaders = params.headers || [];
          return {};
        }
      };
      rewriter.handleEvent({
        method: "Fetch.requestPaused",
        params: {
          requestId: "req-ios",
          request: {
            url: "http://example.com/index.html",
            headers: {
              "user-agent": "Host UA",
              "sec-ch-ua": "Host CH",
              "sec-ch-ua-platform": "\"macOS\"",
              "sec-ch-ua-mobile": "?0"
            }
          },
          responseStatusCode: null,
        }
      }, fakeConn);
      return outHeaders;
    }

    // 1. iOS Persona
    const iosProfile = {
      platform: "iOS",
      platformNav: "iPhone",
      mobile: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      acceptLanguage: "en-US,en;q=0.9",
    };
    const iosHdrs = getHeaders(iosProfile);
    const iosChUa = iosHdrs.filter(h => h.name.toLowerCase().startsWith("sec-ch-ua"));
    assert.strictEqual(iosChUa.length, 0, "iOS must NOT send any sec-ch-ua* headers");

    // 2. Windows Persona (should send sec-ch-ua*)
    const winProfile = {
      platform: "Windows",
      mobile: false,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0",
      acceptLanguage: "en-US,en;q=0.9",
    };
    const winHdrs = getHeaders(winProfile);
    const winChUa = winHdrs.filter(h => h.name.toLowerCase().startsWith("sec-ch-ua"));
    assert.ok(winChUa.length >= 3, "Windows must send sec-ch-ua, platform, and mobile");
    const winPlat = winHdrs.find(h => h.name.toLowerCase() === "sec-ch-ua-platform");
    assert.strictEqual(winPlat?.value, "\"Windows\"");

    // 3. Android Persona (should send sec-ch-ua-mobile: ?1)
    const androidProfile = {
      platform: "Android",
      mobile: true,
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/128.0.0.0 Mobile",
      acceptLanguage: "en-US,en;q=0.9",
    };
    const androidHdrs = getHeaders(androidProfile);
    const androidMob = androidHdrs.find(h => h.name.toLowerCase() === "sec-ch-ua-mobile");
    assert.strictEqual(androidMob?.value, "?1");
  });

  // -------------------------------------------------------------
  // Test 3: applyEnvWindowTitle does not overwrite document.title (P2)
  // -------------------------------------------------------------
  check("【P2】applyEnvWindowTitle: does not overwrite document.title on about:blank or external pages", () => {
    const engine = new BrowserEngine({ getPath: () => "/tmp" });
    assert.strictEqual(engine.isStartPageUrl("about:blank"), false);
    assert.strictEqual(engine.isStartPageUrl("https://example.com"), false);
    assert.strictEqual(engine.isStartPageUrl("http://127.0.0.1:8080/test"), false);
  });

  // -------------------------------------------------------------
  // Test 4: Live E2E: Sandbox iframe <iframe sandbox="allow-scripts"> (P0)
  // -------------------------------------------------------------
  await asyncCheck("【P0】Live E2E: Sandbox iframe <iframe sandbox=\"allow-scripts\"> receives persona mock values", async () => {
    const profile = {
      id: "persona-sandbox-win",
      name: "Sandbox Win",
      platform: "Win32",
      fingerprint: {
        cores: 6,
        memory: 8,
        screenWidth: 1920,
        screenHeight: 1080,
      },
      privacy: {
        cores: 6,
        memory: 8,
      },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0 Safari/537.36",
    };
    const fp = buildFingerprint(profile);

    const b = await launchBrowserHelper(profile, fp);
    let srv, reportData = null;

    try {
      srv = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "*");
        res.setHeader("Access-Control-Allow-Headers", "*");
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
        if (req.url === "/report" && req.method === "POST") {
          let b = "";
          req.on("data", c => b += c);
          req.on("end", () => {
            reportData = JSON.parse(b);
            res.writeHead(200); res.end("ok");
          });
          return;
        }
        if (req.url === "/sandbox-content") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><body><h1>Sandbox</h1><script>
            fetch("http://127.0.0.1:${srvPort}/report", {
              method: "POST",
              headers: { "Content-Type": "text/plain" },
              body: JSON.stringify({
                platform: navigator.platform,
                hardwareConcurrency: navigator.hardwareConcurrency,
                deviceMemory: navigator.deviceMemory,
                userAgent: navigator.userAgent
              })
            });
          </script></body></html>`);
          return;
        }
        if (req.url === "/") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><body><iframe sandbox="allow-scripts" src="http://127.0.0.1:${srvPort}/sandbox-content"></iframe></body></html>`);
          return;
        }
        res.writeHead(404); res.end();
      });
      await new Promise(r => srv.listen(0, "127.0.0.1", r));
      const srvPort = srv.address().port;

      const engine = new BrowserEngine({ getPath: () => b.dir });
      const item = { port: b.devToolsPort, profile, nativeKernelFingerprint: false };
      const engineConn = await engine.startWorkerFingerprintInjection(item, fp);

      const tabs = await cdp.tabs(b.devToolsPort);
      await cdp.call(tabs[0].webSocketDebuggerUrl, "Page.enable", {});
      await cdp.call(tabs[0].webSocketDebuggerUrl, "Page.navigate", { url: `http://127.0.0.1:${srvPort}/` });

      for (let i = 0; i < 30; i++) {
        await sleep(200);
        if (reportData) break;
      }

      assert.ok(reportData, "Sandbox frame report must be received");
      assert.strictEqual(reportData.platform, "Win32", "Sandbox frame platform must be Win32");
      assert.strictEqual(reportData.hardwareConcurrency, 6, "Sandbox frame hardwareConcurrency must be 6");
      assert.strictEqual(reportData.deviceMemory, 8, "Sandbox frame deviceMemory must be 8");
      assert.ok(reportData.userAgent.includes("Windows NT 10.0"), "Sandbox frame userAgent must match Windows persona");

      if (engineConn) try { engineConn.close(); } catch (_) {}
    } finally {
      if (srv) srv.close();
      b.cleanup();
    }
  });

  // -------------------------------------------------------------
  // Test 5: Live E2E: DPR 1.5 & Media Query Consistency (P0)
  // -------------------------------------------------------------
  await asyncCheck("【P0】Live E2E: DPR 1.5 & CSS @media physical consistency matches", async () => {
    const profile = {
      id: "persona-dpr-15",
      name: "DPR 1.5 Consistency",
      os: "windows",
      screen: {
        width: 1920,
        height: 1080,
        devicePixelRatio: 1.5,
      },
      fingerprint: {
        screenWidth: 1920,
        screenHeight: 1080,
        devicePixelRatio: 1.5,
      }
    };
    const fp = buildFingerprint(profile);

    const b = await launchBrowserHelper(profile, fp);
    let srv, dprReport = null;

    try {
      srv = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "*");
        res.setHeader("Access-Control-Allow-Headers", "*");
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
        if (req.url === "/report" && req.method === "POST") {
          let b = "";
          req.on("data", c => b += c);
          req.on("end", () => {
            dprReport = JSON.parse(b);
            res.writeHead(200); res.end("ok");
          });
          return;
        }
        if (req.url === "/") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html>
          <head>
            <style>
              #testbox { color: rgb(0, 0, 0); }
              @media (min-resolution: 1.4dppx) {
                #testbox { color: rgb(0, 255, 0); }
              }
            </style>
          </head>
          <body>
            <div id="testbox">Box</div>
            <script>
              const color = getComputedStyle(document.getElementById("testbox")).color;
              const payload = {
                dpr: window.devicePixelRatio,
                res1dppx: window.matchMedia("(resolution: 1dppx)").matches,
                res1_5dppx: window.matchMedia("(resolution: 1.5dppx)").matches,
                minRes1_4dppx: window.matchMedia("(min-resolution: 1.4dppx)").matches,
                cssColor: color,
              };
              fetch("http://127.0.0.1:${srvPort}/report", {
                method: "POST",
                body: JSON.stringify(payload)
              });
            </script>
          </body></html>`);
          return;
        }
        res.writeHead(404); res.end();
      });
      await new Promise(r => srv.listen(0, "127.0.0.1", r));
      const srvPort = srv.address().port;

      const engine = new BrowserEngine({ getPath: () => b.dir });
      const item = { port: b.devToolsPort, profile, nativeKernelFingerprint: false };
      const engineConn = await engine.startWorkerFingerprintInjection(item, fp);

      const tabs = await cdp.tabs(b.devToolsPort);
      await cdp.call(tabs[0].webSocketDebuggerUrl, "Page.enable", {});
      await cdp.call(tabs[0].webSocketDebuggerUrl, "Page.navigate", { url: `http://127.0.0.1:${srvPort}/` });

      for (let i = 0; i < 30; i++) {
        await sleep(200);
        if (dprReport) break;
      }

      assert.ok(dprReport, "DPR report must be received");
      assert.strictEqual(dprReport.dpr, 1.5, "devicePixelRatio must be 1.5");
      assert.strictEqual(dprReport.res1dppx, false, "(resolution: 1dppx) must be false");
      assert.strictEqual(dprReport.res1_5dppx, true, "(resolution: 1.5dppx) must be true");
      assert.strictEqual(dprReport.minRes1_4dppx, true, "(min-resolution: 1.4dppx) must be true");
      assert.strictEqual(dprReport.cssColor, "rgb(0, 255, 0)", "CSS @media rule must apply green color");

      if (engineConn) try { engineConn.close(); } catch (_) {}
    } finally {
      if (srv) srv.close();
      b.cleanup();
    }
  });

  // -------------------------------------------------------------
  // Test 6: Live E2E: Service Worker Registration Duration (P1)
  // -------------------------------------------------------------
  await asyncCheck("【P1】Live E2E: Service Worker attaches without commands hang (registration < 2500ms)", async () => {
    const profile = {
      id: "persona-sw-test",
      name: "SW Test",
      platform: "Win32",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0",
    };
    const fp = buildFingerprint(profile);

    const b = await launchBrowserHelper(profile, fp);
    let srv, swReport = null;

    try {
      srv = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "*");
        res.setHeader("Access-Control-Allow-Headers", "*");
        if (req.url === "/sw.js") {
          res.writeHead(200, { "Content-Type": "application/javascript" });
          res.end("self.addEventListener(\"install\", e => self.skipWaiting()); self.addEventListener(\"activate\", e => e.waitUntil(self.clients.claim()));");
          return;
        }
        if (req.url === "/report" && req.method === "POST") {
          let b = "";
          req.on("data", c => b += c);
          req.on("end", () => {
            swReport = JSON.parse(b);
            res.writeHead(200); res.end("ok");
          });
          return;
        }
        if (req.url === "/") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><body><h1>SW Test</h1><script>
            (async () => {
              const t0 = performance.now();
              try {
                await navigator.serviceWorker.register("/sw.js");
                const duration = performance.now() - t0;
                fetch("http://127.0.0.1:${srvPort}/report", { method: "POST", body: JSON.stringify({ duration }) });
              } catch (e) {
                fetch("http://127.0.0.1:${srvPort}/report", { method: "POST", body: JSON.stringify({ error: e.message }) });
              }
            })();
          </script></body></html>`);
          return;
        }
        res.writeHead(404); res.end();
      });
      await new Promise(r => srv.listen(0, "127.0.0.1", r));
      const srvPort = srv.address().port;

      const engine = new BrowserEngine({ getPath: () => b.dir });
      const item = { port: b.devToolsPort, profile, nativeKernelFingerprint: false };
      const engineConn = await engine.startWorkerFingerprintInjection(item, fp);

      const tabs = await cdp.tabs(b.devToolsPort);
      await cdp.call(tabs[0].webSocketDebuggerUrl, "Page.enable", {});
      await cdp.call(tabs[0].webSocketDebuggerUrl, "Page.navigate", { url: `http://127.0.0.1:${srvPort}/` });

      for (let i = 0; i < 30; i++) {
        await sleep(200);
        if (swReport) break;
      }

      assert.ok(swReport, "SW report must be received");
      assert.ok(!swReport.error, "SW registration must not error: " + swReport.error);
      assert.ok(swReport.duration < 2500, "SW registration must be under 2500ms (actual: " + swReport.duration + "ms)");

      if (engineConn) try { engineConn.close(); } catch (_) {}
    } finally {
      if (srv) srv.close();
      b.cleanup();
    }
  });

  console.log("\n================================================================");
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`  Selftest Summary: Total: ${results.length} | PASS: ${passed} | FAIL: ${failed}`);
  console.log("================================================================\n");
  process.exit(failed > 0 ? 1 : 0);
})();
