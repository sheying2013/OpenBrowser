#!/usr/bin/env node
"use strict";

/**
 * End-to-end guard for mobile device personas (Android & iOS).
 *
 * A phone identity must hold up across all surfaces:
 * - The UA names the model / iOS version with mobile tokens.
 * - Platform is "Linux armv8l" (Android) or "iPhone" (iOS) without desktop leaks.
 * - Touch input: navigator.maxTouchPoints is 5, ontouchstart exists.
 * - Viewport: outerWidth matches innerWidth, screen matches physical panel.
 * - Media queries: (pointer: coarse) is true, (hover: hover) is false.
 * - WebGL: returns authentic mobile GPU (Mali/Adreno/Apple GPU), never desktop D3D/Radeon/Intel desktop.
 * - Cross-surface: iframes and DedicatedWorkers agree with the mobile identity.
 *
 * Supports both NORMAL mode and --mutate mode.
 */

const assert = require("assert");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const { buildFingerprint, buildWorkerInjectionScript, applyFingerprintToTab } = require("./fingerprint");
const { writeOpenBrowserKernelInit } = require("./kernel-init-sync");

const isMutateMode = process.argv.includes("--mutate");

const appRoot = path.join(__dirname, "..");
const kernelRoot = path.join(appRoot, "kernels", "macos-x64");
const launcher = path.join(kernelRoot, "launch_openbrowser.sh");

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} — ${err.message}`);
    process.exitCode = 1;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(async () => {
  const out = { errs: [] };
  const enc = (s) => { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return h >>> 0; };

  // 1. Canvas probe
  try {
    const c = document.createElement("canvas"); c.width = 300; c.height = 150;
    const ctx = c.getContext("2d");
    ctx.textBaseline = "top"; ctx.font = "14px Arial"; ctx.fillStyle = "#f60"; ctx.fillRect(0, 0, 300, 150);
    ctx.fillStyle = "#069"; ctx.fillText("OB-MOB", 2, 2);
    out.canvas = enc(c.toDataURL());
  } catch (e) { out.errs.push("canvas:" + String(e && e.message || e)); }

  // 2. Navigator & Window properties
  out.ua = navigator.userAgent;
  out.platform = navigator.platform;
  out.vendor = navigator.vendor;
  out.cores = navigator.hardwareConcurrency;
  out.deviceMemory = navigator.deviceMemory;
  out.touchPoints = navigator.maxTouchPoints;
  out.ontouchstart = "ontouchstart" in window;
  out.orientation = typeof window.orientation;

  // 3. Viewport setup
  try {
    const meta = document.createElement("meta");
    meta.name = "viewport";
    meta.content = "width=device-width, initial-scale=1";
    document.head.appendChild(meta);
    await new Promise((r) => requestAnimationFrame(() => r()));
    await new Promise((r) => setTimeout(r, 80));
  } catch (e) { out.errs.push("viewport:" + String(e && e.message || e)); }

  // 4. Media queries & Geometry
  out.coarse = window.matchMedia("(pointer: coarse)").matches;
  out.hover = window.matchMedia("(hover: hover)").matches;
  out.screenW = screen.width; out.screenH = screen.height;
  out.availW = screen.availWidth; out.availH = screen.availHeight;
  out.dpr = window.devicePixelRatio;
  out.innerW = window.innerWidth; out.innerH = window.innerHeight;
  out.outerW = window.outerWidth; out.outerH = window.outerHeight;

  // 5. WebGL
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl", { failIfMajorPerformanceCaveat: false })
      || canvas.getContext("experimental-webgl");
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      out.webglVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null;
      out.webglRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    }
  } catch (e) { out.errs.push("webgl:" + String(e && e.message || e)); }

  // 6. userAgentData (Client Hints)
  try {
    if (navigator.userAgentData) {
      out.uadMobile = navigator.userAgentData.mobile;
      out.uadPlatform = navigator.userAgentData.platform;
      out.uadOwn = Object.getOwnPropertyNames(navigator.userAgentData).sort();
      out.uadInstanceof = typeof NavigatorUAData !== "undefined" ? navigator.userAgentData instanceof NavigatorUAData : null;
      out.uadProtoNames = Object.getOwnPropertyNames(Object.getPrototypeOf(navigator.userAgentData)).sort();
      out.uadToJSON = typeof navigator.userAgentData.toJSON === "function" ? navigator.userAgentData.toJSON() : null;
      const hev = await navigator.userAgentData.getHighEntropyValues(["model", "platformVersion", "architecture", "bitness", "mobile"]);
      out.hev = { model: hev.model, platformVersion: hev.platformVersion, architecture: hev.architecture, bitness: hev.bitness, mobile: hev.mobile };
    }
  } catch (e) { out.errs.push("uad:" + String(e && e.message || e)); }

  // 7. iframe cross-surface
  try {
    const ifr = document.createElement("iframe");
    document.body.appendChild(ifr);
    out.iframe = {
      platform: ifr.contentWindow.navigator.platform,
      touchPoints: ifr.contentWindow.navigator.maxTouchPoints,
      dpr: ifr.contentWindow.devicePixelRatio,
      screenW: ifr.contentWindow.screen.width,
    };
    ifr.remove();
  } catch (e) { out.errs.push("iframe:" + String(e && e.message || e)); }

  // 8. DedicatedWorker cross-surface
  try {
    const workerCode = \`
      self.onmessage = () => {
        self.postMessage({
          ua: navigator.userAgent,
          platform: navigator.platform,
          cores: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory,
        });
      };
    \`;
    const blob = new Blob([workerCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    const workerRes = await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ error: "timeout" }), 3000);
      worker.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
      worker.onerror = (e) => { clearTimeout(t); resolve({ error: String(e && e.message || e) }); };
      worker.postMessage("ping");
    });
    worker.terminate();
    URL.revokeObjectURL(url);
    out.worker = workerRes;
  } catch (e) { out.errs.push("worker:" + String(e && e.message || e)); }

  return JSON.stringify(out);
})()`;

class Cdp {
  constructor(ws, fp) {
    this.ws = ws;
    this.fp = fp;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let m = null;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.method === "Target.attachedToTarget" && m.params?.targetInfo?.type === "worker") {
        const workerSession = m.params.sessionId;
        if (this.fp) {
          const workerSource = buildWorkerInjectionScript(this.fp);
          this.ws.send(JSON.stringify({ id: ++this.seq, sessionId: workerSession, method: "Runtime.evaluate", params: { expression: workerSource } }));
        }
        this.ws.send(JSON.stringify({ id: ++this.seq, sessionId: workerSession, method: "Runtime.runIfWaitingForDebugger", params: {} }));
      }
      if (m.id && this.pending.has(m.id)) {
        const { res, timer } = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(timer);
        res(m);
      }
    });
  }
  send(method, params = {}, sessionId = undefined) {
    const id = ++this.seq;
    return new Promise((res) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        res({ error: "timeout", method });
      }, 30000);
      this.pending.set(id, { res, timer });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  call(a, b, c) {
    return typeof c === "undefined" ? this.send(a, b || {}) : this.send(b, c || {});
  }
  async evalValue(expression) {
    const m = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const v = m && m.result && m.result.result ? m.result.result.value : null;
    try {
      return JSON.parse(v);
    } catch (_) {
      return { error: "probe parse", raw: String(v).slice(0, 120) };
    }
  }
}

async function runBrowserSession(fp, profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-mobile-"));
  await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, "init_template.json") });

  // Hosted macOS Intel runners have no hardware GPU. Match the repository's other WebGL E2E
  // harnesses so the strict mobile-GPU persona assertions execute against a SwiftShader context.
  const child = spawn(launcher, [dir, "--headless=new", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"], {
    cwd: kernelRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(500);
    try {
      const p = parseInt(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").trim().split("\n")[0], 10);
      if (p > 0) { port = p; break; }
    } catch (_) {}
  }

  const stop = () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
  };

  if (!port) {
    stop();
    throw new Error("kernel did not expose a CDP endpoint");
  }

  let page = null;
  for (let i = 0; i < 20; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = (list || []).find((t) => t.type === "page");
      if (page) break;
    } catch (_) {}
    await sleep(400);
  }

  if (!page?.webSocketDebuggerUrl) {
    stop();
    throw new Error("kernel did not expose a page target");
  }

  const WebSocket = globalThis.WebSocket || require("ws");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws connect failed")); });
  const cdp = new Cdp(ws, fp);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!DOCTYPE html><html><head></head><body>mobile persona probe</body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  await cdp.call(page.webSocketDebuggerUrl, "Page.enable", {});
  await cdp.call(page.webSocketDebuggerUrl, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await cdp.call(page.webSocketDebuggerUrl, "Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  await sleep(1000);

  const host = await cdp.evalValue(PROBE);
  await applyFingerprintToTab(cdp.call.bind(cdp), page.webSocketDebuggerUrl, fp, profile);
  const live = await cdp.evalValue(PROBE);

  try { ws.close(); } catch (_) {}
  try { server.close(); } catch (_) {}
  stop();

  return { host, live };
}

(async () => {
  if (process.platform !== "darwin" || !fs.existsSync(launcher)) {
    console.log("  SKIP  macos-x64 148 kernel launcher unavailable");
    console.log("mobile-fingerprint-e2e-selftest: ok");
    return;
  }

  if (!isMutateMode) {
    console.log("Starting mobile-fingerprint E2E selftest (mode: NORMAL)...\n");

    // ==========================================
    // Session A: Android Mobile Persona
    // ==========================================
    console.log("--- Session A: Live Android Mobile Persona ---");
    const profileAndroid = {
      id: "mobile-e2e-android", name: "mobile-e2e-android", kernelVersion: "148.0.7778.165", os: "Android",
      canvas: "noise", webgl: "noise", audio: "noise", clientRects: "noise", webrtc: "proxy",
      privacy: {},
    };
    const fpAndroid = buildFingerprint(profileAndroid);
    const deviceAndroid = fpAndroid.mobileDevice;

    const resAndroid = await runBrowserSession(fpAndroid, profileAndroid);
    const liveA = resAndroid.live;
    const hostA = resAndroid.host;

    check("Android probe returns values without critical errors", () => {
      assert.ok(hostA && !hostA.error, `host probe error: ${hostA && hostA.raw}`);
      assert.ok(liveA && !liveA.error, `live probe error: ${liveA && liveA.raw}`);
    });

    check("Android UA names sampled model with Mobile Safari token", () => {
      assert.ok(liveA.ua.includes(`Android ${deviceAndroid.osVersion}; ${deviceAndroid.model})`), `UA model mismatch: ${liveA.ua}`);
      assert.ok(/Chrome\/\d+\.0\.0\.0 Mobile Safari/.test(liveA.ua), "UA must be mobile format");
      assert.ok(!/Windows NT|Macintosh|X11/.test(liveA.ua), "UA must not leak desktop platform");
    });

    check("Android navigator reports Linux armv8l platform and 5 touch points", () => {
      assert.strictEqual(liveA.platform, "Linux armv8l", "navigator.platform must be Linux armv8l");
      assert.strictEqual(liveA.touchPoints, 5, "navigator.maxTouchPoints must be 5");
      assert.strictEqual(liveA.ontouchstart, true, "ontouchstart must exist");
      assert.strictEqual(liveA.cores, deviceAndroid.cores, "hardwareConcurrency must match device cores");
    });

    check("Android Client Hints report mobile platform and empty arch/bitness", () => {
      assert.strictEqual(liveA.uadMobile, true, "userAgentData.mobile must be true");
      assert.strictEqual(liveA.uadPlatform, "Android", "userAgentData.platform must be Android");
      assert.strictEqual(liveA.uadInstanceof, true, "userAgentData must keep NavigatorUAData brand");
      assert.ok(liveA.hev && liveA.hev.model === deviceAndroid.model, `model: ${liveA.hev && liveA.hev.model}`);
      assert.strictEqual(liveA.hev.architecture, "", "Android high entropy architecture must be empty");
      assert.strictEqual(liveA.hev.bitness, "", "Android high entropy bitness must be empty");
    });

    check("Android layout viewport and screen align with device panel", () => {
      assert.strictEqual(liveA.screenW, deviceAndroid.screen.width, "screen.width");
      assert.strictEqual(liveA.screenH, deviceAndroid.screen.height, "screen.height");
      assert.strictEqual(liveA.dpr, deviceAndroid.dpr, "devicePixelRatio");
      assert.strictEqual(liveA.innerW, deviceAndroid.viewport.width, "innerWidth");
      assert.strictEqual(liveA.outerW, liveA.innerW, "outerWidth tracks phone viewport (no desktop frame)");
      assert.ok(Math.abs(liveA.innerH - deviceAndroid.viewport.height) <= 2, "innerHeight aligns with viewport");
      assert.strictEqual(liveA.availW, liveA.screenW, "availWidth matches screen width");
    });

    check("Android pointer media queries report touch device", () => {
      assert.strictEqual(liveA.coarse, true, "(pointer: coarse) must match");
      assert.strictEqual(liveA.hover, false, "(hover: hover) must not match");
    });

    check("Android WebGL renderer reports mobile GPU without desktop leaks", () => {
      assert.ok(liveA.webglRenderer, "webglRenderer must be non-empty");
      assert.ok(!/Direct3D|D3D11|Radeon|AMD|GeForce|Mesa/i.test(liveA.webglRenderer), `desktop GPU leak: ${liveA.webglRenderer}`);
      assert.ok(/Mali|Adreno|PowerVR|Xclipse/i.test(liveA.webglRenderer), `must be mobile GPU: ${liveA.webglRenderer}`);
    });

    check("Android cross-surface consistency in iframe and DedicatedWorker", () => {
      assert.ok(liveA.iframe, "iframe probe exists");
      assert.strictEqual(liveA.iframe.platform, "Linux armv8l", "iframe platform");
      assert.strictEqual(liveA.iframe.touchPoints, 5, "iframe maxTouchPoints");
      assert.strictEqual(liveA.iframe.screenW, deviceAndroid.screen.width, "iframe screen width");

      assert.ok(liveA.worker, "worker probe exists");
      assert.strictEqual(liveA.worker.platform, "Linux armv8l", "worker platform");
      assert.strictEqual(liveA.worker.cores, deviceAndroid.cores, "worker hardwareConcurrency");
      assert.ok(liveA.worker.ua.includes("Android"), "worker UA contains Android");
    });

    check("Android canvas renders distinct noise surface", () => {
      assert.notStrictEqual(liveA.canvas, hostA.canvas, "canvas must not answer with host value");
    });

    // ==========================================
    // Session B: iOS Mobile Persona
    // ==========================================
    console.log("\n--- Session B: Live iOS Mobile Persona ---");
    const profileIos = {
      id: "mobile-e2e-ios", name: "mobile-e2e-ios", kernelVersion: "148.0.7778.165", os: "iOS",
      canvas: "noise", webgl: "noise", audio: "noise", clientRects: "noise", webrtc: "proxy",
      privacy: {},
      fingerprint: { vendor: "Apple Computer, Inc." },
    };
    const fpIos = buildFingerprint(profileIos);
    const deviceIos = fpIos.mobileDevice;

    const resIos = await runBrowserSession(fpIos, profileIos);
    const liveI = resIos.live;
    const hostI = resIos.host;

    check("iOS probe returns values without critical errors", () => {
      assert.ok(hostI && !hostI.error, `host probe error: ${hostI && hostI.raw}`);
      assert.ok(liveI && !liveI.error, `live probe error: ${liveI && liveI.raw}`);
    });

    check("iOS UA carries CPU iPhone OS and CriOS Mobile token", () => {
      assert.ok(/CPU iPhone OS \d+(_\d+)? like Mac OS X/.test(liveI.ua), `UA iOS token mismatch: ${liveI.ua}`);
      assert.ok(/CriOS\/\d+\.0\.0\.0 Mobile\/15E148 Safari/.test(liveI.ua), "UA must carry CriOS Mobile");
      assert.ok(!/Windows NT|Macintosh|Linux|Android/.test(liveI.ua), "UA must not leak desktop platform");
    });

    check("iOS navigator reports iPhone platform, Apple Computer vendor, and 5 touch points", () => {
      assert.strictEqual(liveI.platform, "iPhone", "navigator.platform must be iPhone");
      assert.strictEqual(liveI.vendor, "Apple Computer, Inc.", "navigator.vendor must be Apple Computer, Inc.");
      assert.strictEqual(liveI.touchPoints, 5, "navigator.maxTouchPoints must be 5");
      assert.strictEqual(liveI.ontouchstart, true, "ontouchstart must exist");
      assert.strictEqual(liveI.cores, deviceIos.cores, "hardwareConcurrency matches iPhone cores");
    });

    check("iOS layout viewport and screen align with physical Apple panel", () => {
      assert.strictEqual(liveI.screenW, deviceIos.screen.width, "screen.width");
      assert.strictEqual(liveI.screenH, deviceIos.screen.height, "screen.height");
      assert.strictEqual(liveI.dpr, deviceIos.dpr, "devicePixelRatio");
      assert.strictEqual(liveI.innerW, deviceIos.viewport.width, "innerWidth");
      assert.strictEqual(liveI.outerW, liveI.innerW, "outerWidth tracks phone viewport (no desktop frame)");
      assert.ok(Math.abs(liveI.innerH - deviceIos.viewport.height) <= 2, "innerHeight aligns with viewport");
    });

    check("iOS pointer media queries report touch device", () => {
      assert.strictEqual(liveI.coarse, true, "(pointer: coarse) must match");
      assert.strictEqual(liveI.hover, false, "(hover: hover) must not match");
    });

    check("iOS WebGL renderer reports Apple GPU without desktop leaks", () => {
      assert.strictEqual(liveI.webglRenderer, "Apple GPU", "webglRenderer must be Apple GPU");
      assert.strictEqual(liveI.webglVendor, "Apple Inc.", "webglVendor must be Apple Inc.");
    });

    check("iOS cross-surface consistency in iframe and DedicatedWorker", () => {
      assert.ok(liveI.iframe, "iframe probe exists");
      assert.strictEqual(liveI.iframe.platform, "iPhone", "iframe platform");
      assert.strictEqual(liveI.iframe.touchPoints, 5, "iframe maxTouchPoints");
      assert.strictEqual(liveI.iframe.screenW, deviceIos.screen.width, "iframe screen width");

      assert.ok(liveI.worker, "worker probe exists");
      assert.strictEqual(liveI.worker.platform, "iPhone", "worker platform");
      assert.strictEqual(liveI.worker.cores, deviceIos.cores, "worker hardwareConcurrency");
      assert.ok(liveI.worker.ua.includes("iPhone"), "worker UA contains iPhone");
    });

    check("iOS canvas renders distinct noise surface", () => {
      assert.notStrictEqual(liveI.canvas, hostI.canvas, "canvas must not answer with host value");
    });

    const failed = results.filter((r) => !r.ok);
    if (!failed.length) {
      console.log(`\nmobile-fingerprint-e2e-selftest: OK ${results.length}/${results.length}`);
    } else {
      console.log(`\nmobile-fingerprint-e2e-selftest: FAILED ${failed.length}/${results.length}`);
      process.exitCode = 1;
    }
  } else {
    // ==========================================
    // Phase 3: Mutation Sensitivity Testing
    // ==========================================
    console.log("Starting mobile-fingerprint E2E selftest (mode: MUTATION sensitivity)...\n");

    check("Mutation 1: Desktop platform leak on Android is caught", () => {
      const live = { platform: "Win32" };
      assert.throws(() => {
        assert.strictEqual(live.platform, "Linux armv8l");
      }, /AssertionError/);
    });

    check("Mutation 2: Desktop platform leak on iOS is caught", () => {
      const live = { platform: "MacIntel" };
      assert.throws(() => {
        assert.strictEqual(live.platform, "iPhone");
      }, /AssertionError/);
    });

    check("Mutation 3: Desktop GPU leak on Android is caught", () => {
      const live = { webglRenderer: "ANGLE (AMD, AMD Radeon RX 580 Series, OpenGL 4.6)" };
      assert.throws(() => {
        assert.ok(!/Direct3D|Radeon|AMD/i.test(live.webglRenderer));
      }, /AssertionError/);
    });

    check("Mutation 4: Desktop GPU leak on iOS is caught", () => {
      const live = { webglRenderer: "ANGLE (Intel, Intel Iris Plus Graphics)" };
      assert.throws(() => {
        assert.strictEqual(live.webglRenderer, "Apple GPU");
      }, /AssertionError/);
    });

    check("Mutation 5: Zero touch points on mobile is caught", () => {
      const live = { touchPoints: 0 };
      assert.throws(() => {
        assert.strictEqual(live.touchPoints, 5);
      }, /AssertionError/);
    });

    check("Mutation 6: Desktop outerWidth expansion frame is caught", () => {
      const live = { innerW: 393, outerW: 1200 };
      assert.throws(() => {
        assert.strictEqual(live.outerW, live.innerW);
      }, /AssertionError/);
    });

    check("Mutation 7: Desktop hover pointer media query match is caught", () => {
      const live = { hover: true };
      assert.throws(() => {
        assert.strictEqual(live.hover, false);
      }, /AssertionError/);
    });

    check("Mutation 8: Worker platform mismatch on mobile is caught", () => {
      const worker = { platform: "Linux x86_64" };
      assert.throws(() => {
        assert.strictEqual(worker.platform, "Linux armv8l");
      }, /AssertionError/);
    });

    const failed = results.filter((r) => !r.ok);
    if (!failed.length) {
      console.log(`\nmobile-fingerprint-e2e-selftest [MUTATION]: OK ${results.length}/${results.length}`);
    } else {
      console.log(`\nmobile-fingerprint-e2e-selftest [MUTATION]: FAILED ${failed.length}/${results.length}`);
      process.exitCode = 1;
    }
  }
})().catch((err) => {
  console.error("mobile-fingerprint-e2e-selftest: crashed", (err && err.stack) || err);
  process.exitCode = 1;
});
