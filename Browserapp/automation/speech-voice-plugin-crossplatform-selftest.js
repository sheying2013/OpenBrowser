#!/usr/bin/env node
"use strict";

/**
 * Cross-platform speechSynthesis and navigator.plugins / mimeTypes selftest.
 *
 * Validates:
 *  A. speechSynthesis.getVoices() cross-platform consistency:
 *     - Windows personas return Microsoft & Google desktop voices (no Apple/Android leak).
 *     - macOS personas return Apple & Google desktop voices (no Microsoft/Android leak).
 *     - Android personas return Android TTS voices (e.g. "English (United States)").
 *     - SpeechSynthesisVoice instances keep authentic shape, brand (instanceof), and no own properties.
 *     - Cross-call stability (deterministic array and items).
 *     - Frames: main window, same-origin iframe, srcdoc iframe, about:blank iframe.
 *     - Illegal receiver: SpeechSynthesis.prototype.getVoices.call({}) throws native TypeError.
 *  B. navigator.plugins & navigator.mimeTypes surface verification:
 *     - Exact standard 5 Chrome PDF plugins and 2 PDF mimeTypes.
 *     - Plugin and MimeType brands, methods (item, namedItem, refresh, [Symbol.iterator]).
 *  C. No enumerable injection traces (native name, length, descriptor enumerability, toString).
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, execSync } = require("child_process");

const {
  buildFingerprint,
  buildInjectionScript,
  createSpeechVoicesFromSeed,
} = require("./fingerprint");
const { writeOpenBrowserKernelInit } = require("./kernel-init-sync");

const appRoot = path.join(__dirname, "..");
const kernelRoot = path.join(appRoot, "kernels", "macos-x64");
const launcher = path.join(kernelRoot, "launch_openbrowser.sh");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.callbacks = new Map();
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id && this.callbacks.has(msg.id)) {
          const cb = this.callbacks.get(msg.id);
          this.callbacks.delete(msg.id);
          cb(msg);
        }
      } catch (_) {}
    };
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve) => {
      const id = this.id++;
      this.callbacks.set(id, resolve);
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
}

async function startLoopbackServer() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!DOCTYPE html><html><head><title>selftest</title></head><body><h1>selftest</h1></body></html>");
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  return srv;
}

function stop(child, dir) {
  try { process.kill(-child.pid, "SIGKILL"); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
}

async function runKernelEvaluation(profile, expr) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-test-"));
  const fp = buildFingerprint(profile);
  await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, "init_template.json") });
  const child = spawn(launcher, [dir, "--headless=new"], { cwd: kernelRoot, detached: true, stdio: "ignore" });
  child.unref();
  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(500);
    try {
      const p = parseInt(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").trim().split("\n")[0], 10);
      if (p > 0) { port = p; break; }
    } catch (_) {}
  }
  if (!port) { stop(child, dir); return { error: "no devtools port" }; }

  const srv = await startLoopbackServer();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  let result = null;
  for (let i = 0; i < 25; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const v = await r.json();
      if (v && v.webSocketDebuggerUrl) {
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((res) => { ws.onopen = res; ws.onerror = res; });
        const cdp = new Cdp(ws);
        const created = await cdp.send("Target.createTarget", { url: "about:blank" });
        const targetId = created && created.result && created.result.targetId;
        const attached = targetId ? await cdp.send("Target.attachToTarget", { targetId, flatten: true }) : null;
        const sessionId = attached && attached.result && attached.result.sessionId;
        if (sessionId) {
          await cdp.send("Page.enable", {}, sessionId);
          await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: buildInjectionScript(fp) }, sessionId);
          await cdp.send("Page.navigate", { url }, sessionId);
          await sleep(1500);

          const evalRes = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
          result = evalRes && evalRes.result && evalRes.result.result ? evalRes.result.result.value : null;
          await cdp.send("Target.closeTarget", { targetId });
        }
        try { ws.close(); } catch (_) {}
        break;
      }
    } catch (_) {}
    await sleep(400);
  }
  try { srv.close(); } catch (_) {}
  stop(child, dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  return result;
}

// -----------------------------------------------------------------------------
// Unit tests (Fast, in-process)
// -----------------------------------------------------------------------------
function runUnitTests() {
  console.log("Running in-process unit tests...");

  // 1. Windows voices
  const winVoices = createSpeechVoicesFromSeed("seed-win", ["en-US", "zh-CN"], "noise", { os: "windows" });
  assert.ok(Array.isArray(winVoices) && winVoices.length >= 18, "Windows voices count >= 18");
  assert.ok(winVoices.some(v => v.name.startsWith("Microsoft")), "Windows voices include Microsoft voices");
  assert.ok(!winVoices.some(v => v.name === "Alex" || v.name === "Samantha"), "Windows voices must not contain Apple voices");
  assert.ok(!winVoices.some(v => v.name === "English (United States)"), "Windows voices must not contain Android TTS voices");

  // 2. macOS voices
  const macVoices = createSpeechVoicesFromSeed("seed-mac", ["en-US"], "noise", { os: "macos" });
  assert.ok(Array.isArray(macVoices) && macVoices.length >= 18, "macOS voices count >= 18");
  assert.ok(macVoices.some(v => v.name === "Samantha" || v.name === "Alex" || v.name === "Victoria"), "macOS voices include Apple voices");
  assert.ok(!macVoices.some(v => v.name.startsWith("Microsoft")), "macOS voices must not contain Microsoft voices");
  assert.ok(!macVoices.some(v => v.name === "English (United States)"), "macOS voices must not contain Android TTS voices");

  // 3. Android voices
  const androidVoices = createSpeechVoicesFromSeed("seed-android", ["en-US", "zh-CN"], "noise", { os: "android" });
  assert.ok(Array.isArray(androidVoices) && androidVoices.length >= 18, "Android voices count >= 18");
  assert.ok(androidVoices.some(v => v.name === "English (United States)"), "Android voices include Android TTS locale voices");
  assert.ok(!androidVoices.some(v => v.name.startsWith("Microsoft")), "Android voices must not contain Microsoft voices");
  assert.ok(!androidVoices.some(v => v.name === "Alex" || v.name === "Samantha"), "Android voices must not contain Apple voices");
  assert.ok(!androidVoices.some(v => v.name.startsWith("Google ")), "Android voices must not contain desktop Google network voices");

  // 4. Voice object shapes
  for (const v of [...winVoices, ...macVoices, ...androidVoices]) {
    assert.strictEqual(typeof v.name, "string", "name is string");
    assert.strictEqual(typeof v.lang, "string", "lang is string");
    assert.strictEqual(typeof v.voiceURI, "string", "voiceURI is string");
    assert.strictEqual(typeof v.default, "boolean", "default is boolean");
    assert.strictEqual(typeof v.localService, "boolean", "localService is boolean");
  }

  // 5. Default voice prioritization
  const zhWinVoices = createSpeechVoicesFromSeed("seed-zh", ["zh-CN", "en-US"], "noise", { os: "windows" });
  const defaultZhVoice = zhWinVoices.find(v => v.default);
  assert.ok(defaultZhVoice && defaultZhVoice.lang.toLowerCase().startsWith("zh"), "Primary language zh-CN gets default: true on Windows");

  const zhAndroidVoices = createSpeechVoicesFromSeed("seed-zh", ["zh-CN", "en-US"], "noise", { os: "android" });
  const defaultAndroidVoice = zhAndroidVoices.find(v => v.default);
  assert.ok(defaultAndroidVoice && defaultAndroidVoice.lang.toLowerCase().startsWith("zh"), "Primary language zh-CN gets default: true on Android");

  // 6. BuildFingerprint defaults
  const winFp = buildFingerprint({
    id: "win-persona-fp",
    os: "windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    privacy: { deviceProfile: "persona" }
  });
  assert.strictEqual(winFp.speech.mode, "noise", "Default speech mode for persona is noise");
  assert.ok(Array.isArray(winFp.speech.voices) && winFp.speech.voices.length >= 18, "Default persona receives generated voices");
  assert.ok(winFp.speech.voices.some(v => v.name.startsWith("Microsoft")), "Default Windows persona receives Microsoft voices");

  console.log("  PASS  Unit tests passed successfully!");
}

// -----------------------------------------------------------------------------
// End-to-End Kernel Tests
// -----------------------------------------------------------------------------
async function runKernelTests() {
  if (process.platform !== "darwin" || !fs.existsSync(launcher)) {
    console.log("  SKIP  macos-x64 launcher not available in this environment");
    return;
  }
  console.log("Running Chromium kernel end-to-end evaluation...");

  const E2E_PROBE = `(async () => {
    const out = {};

    // 1. Main window speech voices
    const voices = speechSynthesis.getVoices();
    out.voiceCount = voices.length;
    out.voices = voices.map(v => ({
      name: v.name,
      lang: v.lang,
      voiceURI: v.voiceURI,
      default: v.default,
      localService: v.localService,
      isVoice: v instanceof SpeechSynthesisVoice,
      ownProps: Object.getOwnPropertyNames(v)
    }));

    // 2. Stability check: 2nd call
    const voices2 = speechSynthesis.getVoices();
    out.stable = voices.length === voices2.length && voices.every((v, i) => v.name === voices2[i].name && v.lang === voices2[i].lang && v === voices2[i]);

    // 3. Illegal receiver checks
    try {
      SpeechSynthesis.prototype.getVoices.call({});
      out.receiverPlain = "did-not-throw";
    } catch (e) {
      out.receiverPlain = "threw:" + e.name + ":" + e.message;
    }
    try {
      SpeechSynthesis.prototype.getVoices.call(Object.create(SpeechSynthesis.prototype));
      out.receiverProto = "did-not-throw";
    } catch (e) {
      out.receiverProto = "threw:" + e.name + ":" + e.message;
    }

    // 4. Descriptor and metadata checks
    const spProto = SpeechSynthesis.prototype;
    const desc = Object.getOwnPropertyDescriptor(spProto, "getVoices");
    out.desc = desc ? {
      enumerable: desc.enumerable,
      configurable: desc.configurable,
      writable: desc.writable,
      name: desc.value ? desc.value.name : null,
      length: desc.value ? desc.value.length : null,
      toString: desc.value ? desc.value.toString() : null
    } : null;

    // 5. Frames check: same-origin iframe, srcdoc iframe, about:blank iframe
    const ifr = document.createElement("iframe");
    document.body.appendChild(ifr);
    out.iframeInitialSync = ifr.contentWindow.speechSynthesis.getVoices().length;

    const ifrSrcdoc = document.createElement("iframe");
    ifrSrcdoc.srcdoc = "<html><body></body></html>";
    document.body.appendChild(ifrSrcdoc);
    out.srcdocInitialSync = ifrSrcdoc.contentWindow.speechSynthesis.getVoices().length;

    // Await async release in subframes
    await new Promise(r => setTimeout(r, 1100));

    try {
      const ifrVoices = ifr.contentWindow.speechSynthesis.getVoices();
      out.iframe = {
        count: ifrVoices.length,
        first: ifrVoices[0] ? {
          name: ifrVoices[0].name,
          isVoice: ifrVoices[0] instanceof ifr.contentWindow.SpeechSynthesisVoice,
          ownProps: Object.getOwnPropertyNames(ifrVoices[0])
        } : null
      };
      // Illegal receiver on iframe
      try {
        ifr.contentWindow.SpeechSynthesis.prototype.getVoices.call({});
        out.iframe.receiverPlain = "did-not-throw";
      } catch (e) {
        out.iframe.receiverPlain = "threw:" + e.name + ":" + e.message;
      }
    } catch (e) { out.iframeErr = String(e); }

    try {
      out.srcdocCount = ifrSrcdoc.contentWindow.speechSynthesis.getVoices().length;
    } catch (e) { out.srcdocErr = String(e); }

    // 6. DedicatedWorker check
    out.workerHasSpeech = (typeof WorkerGlobalScope !== "undefined" && typeof speechSynthesis !== "undefined");

    // 7. Plugins and MimeTypes check
    out.plugins = {
      length: navigator.plugins.length,
      items: Array.from(navigator.plugins).map(p => ({
        name: p.name,
        filename: p.filename,
        description: p.description,
        length: p.length
      })),
      isPluginArray: navigator.plugins instanceof PluginArray,
      isPlugin0: navigator.plugins[0] instanceof Plugin,
      itemFn: typeof navigator.plugins.item === "function",
      namedItemFn: typeof navigator.plugins.namedItem === "function",
      refreshFn: typeof navigator.plugins.refresh === "function",
      iteratorFn: typeof navigator.plugins[Symbol.iterator] === "function"
    };

    out.mimeTypes = {
      length: navigator.mimeTypes.length,
      items: Array.from(navigator.mimeTypes).map(m => ({
        type: m.type,
        description: m.description,
        suffixes: m.suffixes,
        enabledPluginName: m.enabledPlugin ? m.enabledPlugin.name : null
      })),
      isMimeTypeArray: navigator.mimeTypes instanceof MimeTypeArray,
      isMimeType0: navigator.mimeTypes[0] instanceof MimeType,
      itemFn: typeof navigator.mimeTypes.item === "function",
      namedItemFn: typeof navigator.mimeTypes.namedItem === "function",
      iteratorFn: typeof navigator.mimeTypes[Symbol.iterator] === "function"
    };

    return out;
  })()`;

  const winProfile = {
    id: "win-e2e-persona",
    kernelVersion: "148.0.7778.165",
    os: "windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    privacy: { deviceProfile: "persona" }
  };

  const res = await runKernelEvaluation(winProfile, E2E_PROBE);
  assert.ok(res, "Kernel returned evaluation result");

  // Verify speechSynthesis
  console.log("  [E2E] Voice count:", res.voiceCount);
  assert.ok(res.voiceCount >= 18, `Voice count must be >= 18 (got ${res.voiceCount})`);
  assert.ok(res.voices.some(v => v.name.startsWith("Microsoft")), "Windows persona voices must contain Microsoft voices");
  assert.ok(!res.voices.some(v => v.name === "Alex" || v.name === "Samantha"), "Windows persona voices must not contain macOS host voices");
  assert.ok(!res.voices.some(v => v.name === "English (United States)"), "Windows persona voices must not contain Android voices");

  // Verify voice object integrity
  for (const v of res.voices) {
    assert.strictEqual(v.isVoice, true, "Voice must be instanceof SpeechSynthesisVoice");
    assert.deepStrictEqual(v.ownProps, [], "Voice instance must have 0 own properties (accessors on prototype)");
  }
  assert.strictEqual(res.stable, true, "Multiple getVoices() calls return identical stable objects");

  // Verify illegal receiver error
  assert.ok(res.receiverPlain.startsWith("threw:TypeError"), `Illegal receiver on {} must throw TypeError (got ${res.receiverPlain})`);
  assert.ok(res.receiverProto.startsWith("threw:TypeError"), `Illegal receiver on proto must throw TypeError (got ${res.receiverProto})`);

  // Verify getVoices metadata and descriptors
  assert.strictEqual(res.desc.name, "getVoices", "getVoices name must be getVoices");
  assert.strictEqual(res.desc.length, 0, "getVoices length must be 0");
  assert.strictEqual(res.desc.enumerable, true, "getVoices must be enumerable matching Web IDL native");
  assert.strictEqual(res.desc.writable, true, "getVoices must be writable");
  assert.strictEqual(res.desc.configurable, true, "getVoices must be configurable");
  assert.ok(res.desc.toString.includes("[native code]"), "getVoices toString must include [native code]");

  // Verify subframes
  assert.strictEqual(res.iframeInitialSync, 0, "Iframe initial sync call must be withheld (0)");
  assert.strictEqual(res.srcdocInitialSync, 0, "srcdoc iframe initial sync call must be withheld (0)");
  assert.ok(res.iframe && res.iframe.count >= 18, `Iframe must report populated voices matching main window (got ${res.iframe?.count})`);
  assert.strictEqual(res.iframe.first.isVoice, true, "Iframe voice must be instanceof iframe.SpeechSynthesisVoice");
  assert.deepStrictEqual(res.iframe.first.ownProps, [], "Iframe voice must have 0 own properties");
  assert.ok(res.iframe.receiverPlain.startsWith("threw:TypeError"), "Iframe illegal receiver must throw TypeError");
  assert.ok(res.srcdocCount >= 18, `srcdoc iframe must report populated voices (got ${res.srcdocCount})`);
  assert.strictEqual(res.workerHasSpeech, false, "Worker does not expose speechSynthesis");

  // Verify plugins & mimeTypes
  console.log("  [E2E] Plugins count:", res.plugins.length, "MimeTypes count:", res.mimeTypes.length);
  assert.strictEqual(res.plugins.length, 5, "navigator.plugins length must be 5");
  const expectedPluginNames = [
    "PDF Viewer",
    "Chrome PDF Viewer",
    "Chromium PDF Viewer",
    "Microsoft Edge PDF Viewer",
    "WebKit built-in PDF"
  ];
  assert.deepStrictEqual(res.plugins.items.map(p => p.name), expectedPluginNames, "5 standard PDF plugins");
  for (const p of res.plugins.items) {
    assert.strictEqual(p.filename, "internal-pdf-viewer", `Plugin ${p.name} filename must be internal-pdf-viewer`);
    assert.strictEqual(p.description, "Portable Document Format", `Plugin ${p.name} description must be Portable Document Format`);
    assert.strictEqual(p.length, 2, `Plugin ${p.name} length must be 2`);
  }
  assert.strictEqual(res.plugins.isPluginArray, true, "navigator.plugins instanceof PluginArray");
  assert.strictEqual(res.plugins.isPlugin0, true, "navigator.plugins[0] instanceof Plugin");
  assert.strictEqual(res.plugins.itemFn, true, "navigator.plugins.item is function");
  assert.strictEqual(res.plugins.namedItemFn, true, "navigator.plugins.namedItem is function");
  assert.strictEqual(res.plugins.refreshFn, true, "navigator.plugins.refresh is function");
  assert.strictEqual(res.plugins.iteratorFn, true, "navigator.plugins[Symbol.iterator] is function");

  assert.strictEqual(res.mimeTypes.length, 2, "navigator.mimeTypes length must be 2");
  const mimeTypes = res.mimeTypes.items.map(m => m.type);
  assert.ok(mimeTypes.includes("application/pdf"), "mimeTypes includes application/pdf");
  assert.ok(mimeTypes.includes("text/pdf"), "mimeTypes includes text/pdf");
  assert.strictEqual(res.mimeTypes.isMimeTypeArray, true, "navigator.mimeTypes instanceof MimeTypeArray");
  assert.strictEqual(res.mimeTypes.isMimeType0, true, "navigator.mimeTypes[0] instanceof MimeType");
  assert.strictEqual(res.mimeTypes.itemFn, true, "navigator.mimeTypes.item is function");
  assert.strictEqual(res.mimeTypes.namedItemFn, true, "navigator.mimeTypes.namedItem is function");
  assert.strictEqual(res.mimeTypes.iteratorFn, true, "navigator.mimeTypes[Symbol.iterator] is function");

  console.log("  PASS  Kernel end-to-end tests passed successfully!");
}

(async () => {
  runUnitTests();
  await runKernelTests();
  console.log("\nspeech-voice-plugin-crossplatform-selftest: ALL CHECKS PASSED!");
})();
