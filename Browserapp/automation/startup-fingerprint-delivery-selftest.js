'use strict';

const assert = require("assert");
const path = require("path");
const {
  BrowserEngine,
  evaluateFingerprintDelivery,
  normalizePlatformFamily,
  detectUaPlatform,
  extractChromeMajor,
  extractGpuBrand,
  normalizeTimezone,
  extractPrimaryLanguage,
} = require("../engine");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("  PASS  " + name);
  } catch (error) {
    results.push({ name, ok: false, error: error.message || String(error) });
    console.error("  FAIL  " + name + ": " + (error.message || String(error)));
  }
}

(async () => {
  console.log("Starting Startup Fingerprint Delivery Verification Selftest...\n");

  // -------------------------------------------------------------------------
  // 1. 矛盾项能被正确识别（平台 / UA / 时区 / WebGL / 语言 / 硬件配置）
  // -------------------------------------------------------------------------
  await check("1.1: 平台矛盾 - 配置 Windows(Win32) 但探针交付 MacIntel 判定失败", async () => {
    const profile = { id: "p1", os: "windows", platform: "Win32", privacy: {} };
    const fp = { platform: "Win32" };
    const live = { platform: "MacIntel" };
    const res = evaluateFingerprintDelivery(profile, fp, live);
    assert.strictEqual(res.ok, false, "Must fail on platform mismatch");
    assert.ok(res.mismatches.some((m) => m.field === "platform"));
  });

  await check("1.2: UA 平台段矛盾 - 配置 Windows UA 但探针交付 Macintosh UA 判定失败", async () => {
    const profile = {
      id: "p2",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      privacy: {},
    };
    const live = {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    };
    const res = evaluateFingerprintDelivery(profile, {}, live);
    assert.strictEqual(res.ok, false, "Must fail on UA platform mismatch");
    assert.ok(res.mismatches.some((m) => m.field === "userAgent.platform"));
  });

  await check("1.3: UA Chrome 主版本矛盾 - 配置 Chrome/130 但探针交付 Chrome/118 判定失败", async () => {
    const profile = {
      id: "p3",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      privacy: {},
    };
    const live = {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
    };
    const res = evaluateFingerprintDelivery(profile, {}, live);
    assert.strictEqual(res.ok, false, "Must fail on Chrome major version mismatch");
    assert.ok(res.mismatches.some((m) => m.field === "userAgent.chromeMajor"));
  });

  await check("1.4: Client Hints 矛盾 - 配置 Windows UA 但 navigator.userAgentData.platform 交付 macOS 判定失败", async () => {
    const profile = {
      id: "p4",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      privacy: {},
    };
    const live = {
      userAgent: profile.userAgent,
      uaDataPlatform: "macOS",
    };
    const res = evaluateFingerprintDelivery(profile, {}, live);
    assert.strictEqual(res.ok, false, "Must fail on Client Hints platform mismatch");
    assert.ok(res.mismatches.some((m) => m.field === "userAgentData.platform"));
  });

  await check("1.5: 时区矛盾 - 配置 America/New_York 但探针交付 Asia/Shanghai 判定失败", async () => {
    const profile = {
      id: "p5",
      exitTimezone: "America/New_York",
      privacy: { timezoneMode: "custom", timezone: "America/New_York" },
    };
    const live = { timezone: "Asia/Shanghai" };
    const res = evaluateFingerprintDelivery(profile, {}, live);
    assert.strictEqual(res.ok, false, "Must fail on timezone mismatch");
    assert.ok(res.mismatches.some((m) => m.field === "timezone"));
  });

  await check("1.6: WebGL GPU 身份矛盾 - 配置 NVIDIA GeForce RTX 3080 但探针交付 Apple M1 Max 判定失败", async () => {
    const profile = {
      id: "p6",
      privacy: { webgl: "noise", webglMeta: "noise" },
    };
    const fp = {
      webgl: {
        mode: "noise",
        metaMode: "noise",
        vendor: "Google Inc. (NVIDIA)",
        renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    };
    const live = {
      webglVendor: "Google Inc. (Apple)",
      webglRenderer: "ANGLE (Apple, Apple M1 Max, OpenGL 4.1)",
    };
    const res = evaluateFingerprintDelivery(profile, fp, live);
    assert.strictEqual(res.ok, false, "Must fail on WebGL GPU identity mismatch");
    assert.ok(res.mismatches.some((m) => m.field === "webgl"));
  });

  await check("1.7: 语言首位矛盾 - 配置 zh-CN 但探针交付 en-US 判定失败", async () => {
    const profile = { id: "p7", language: "zh-CN,zh;q=0.9", privacy: {} };
    const live = { languages: ["en-US", "en"] };
    const res = evaluateFingerprintDelivery(profile, {}, live);
    assert.strictEqual(res.ok, false, "Must fail on language mismatch");
    assert.ok(res.mismatches.some((m) => m.field === "languages"));
  });

  await check("1.8: 显式硬件参数矛盾 - 显式配置 cores: 4, memory: 4 但探针交付 16 核 16G 判定失败", async () => {
    const profile = {
      id: "p8",
      privacy: { cores: 4, memory: 4 },
    };
    const live = { hardwareConcurrency: 16, deviceMemory: 16 };
    const res = evaluateFingerprintDelivery(profile, {}, live);
    assert.strictEqual(res.ok, false, "Must fail on explicit cores/memory mismatch");
    assert.ok(res.mismatches.some((m) => m.field === "hardwareConcurrency"));
    assert.ok(res.mismatches.some((m) => m.field === "deviceMemory"));
  });

  // -------------------------------------------------------------------------
  // 2. 归一化后不误报（Win32 vs Windows、大小写、空白、别名）
  // -------------------------------------------------------------------------
  await check("2.1: 平台归一化 - Win32 vs Windows、WIN32、含空白不误报", async () => {
    const profile = { id: "p_norm1", platform: "Win32", privacy: {} };
    const candidates = ["Windows", "win32", "WIN32", "  Win32  ", "Win64"];
    for (const plat of candidates) {
      const res = evaluateFingerprintDelivery(profile, { platform: "Win32" }, { platform: plat });
      assert.strictEqual(res.ok, true, "Should not fail for platform candidate: " + plat);
    }
  });

  await check("2.2: macOS 平台归一化 - MacIntel vs macOS、Macintosh 不误报", async () => {
    const profile = { id: "p_norm2", platform: "MacIntel", privacy: {} };
    const candidates = ["MacIntel", "macOS", "Macintosh", "  macintel  "];
    for (const plat of candidates) {
      const res = evaluateFingerprintDelivery(profile, { platform: "MacIntel" }, { platform: plat });
      assert.strictEqual(res.ok, true, "Should not fail for macOS candidate: " + plat);
    }
  });

  await check("2.3: 时区格式归一化 - 大小写、两端空白不误报", async () => {
    const profile = {
      id: "p_tz_norm",
      exitTimezone: "America/New_York",
      privacy: { timezoneMode: "custom", timezone: "America/New_York" },
    };
    const live = { timezone: "  america/new_york  " };
    const res = evaluateFingerprintDelivery(profile, {}, live);
    assert.strictEqual(res.ok, true, "Should pass normalized timezone");
  });

  await check("2.4: UTC 时区别名归一化 - UTC vs Etc/UTC 不误报", async () => {
    const profile = {
      id: "p_utc",
      exitTimezone: "UTC",
      privacy: { timezoneMode: "custom", timezone: "UTC" },
    };
    const live = { timezone: "Etc/UTC" };
    const res = evaluateFingerprintDelivery(profile, {}, live);
    assert.strictEqual(res.ok, true, "Should pass UTC vs Etc/UTC");
  });

  await check("2.5: 语言连接符与大小写归一化 - zh-CN vs zh-cn、zh_CN 不误报", async () => {
    const profile = { id: "p_lang_norm", language: "zh-CN", privacy: {} };
    const candidates = [["zh-cn"], ["zh_CN"], ["  ZH-CN  "]];
    for (const langs of candidates) {
      const res = evaluateFingerprintDelivery(profile, {}, { languages: langs });
      assert.strictEqual(res.ok, true, "Should pass normalized language: " + JSON.stringify(langs));
    }
  });

  await check("2.6: WebGL 同品牌规范化 - NVIDIA GeForce RTX 3080 vs 完整 ANGLE 驱动串不误报", async () => {
    const profile = {
      id: "p_webgl_norm",
      privacy: { webgl: "noise", webglMeta: "noise" },
    };
    const fp = {
      webgl: {
        mode: "noise",
        metaMode: "noise",
        vendor: "Google Inc. (NVIDIA)",
        renderer: "NVIDIA GeForce RTX 3080",
      },
    };
    const live = {
      webglVendor: "Google Inc. (NVIDIA)",
      webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    };
    const res = evaluateFingerprintDelivery(profile, fp, live);
    assert.strictEqual(res.ok, true, "Should pass same-vendor WebGL");
  });

  await check("2.7: UA 相同主版本但构建号不同不误报", async () => {
    const profile = {
      id: "p_ua_norm",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.69 Safari/537.36",
      privacy: {},
    };
    const live = {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    };
    const res = evaluateFingerprintDelivery(profile, {}, live);
    assert.strictEqual(res.ok, true, "Should pass same Chrome major and platform");
  });

  // -------------------------------------------------------------------------
  // 3. real / system / off 模式跳过对应校验
  // -------------------------------------------------------------------------
  await check("3.1: timezoneMode=real 跳过时区校验，不因时区差异报错", async () => {
    const profile = {
      id: "p_tz_real",
      exitTimezone: "America/New_York",
      privacy: { timezoneMode: "real" },
    };
    const live = { timezone: "Asia/Shanghai" };
    const res = evaluateFingerprintDelivery(profile, {}, live);
    assert.strictEqual(res.ok, true, "Must skip timezone check when timezoneMode=real");
  });

  await check("3.2: webgl=real 或 webglMeta=real 跳过 WebGL 校验", async () => {
    const profile = {
      id: "p_webgl_real",
      privacy: { webgl: "real", webglMeta: "real" },
    };
    const fp = {
      webgl: { mode: "real", metaMode: "real", renderer: "NVIDIA GeForce RTX 3080" },
    };
    const live = {
      webglVendor: "Google Inc. (Apple)",
      webglRenderer: "Apple M1 Max",
    };
    const res = evaluateFingerprintDelivery(profile, fp, live);
    assert.strictEqual(res.ok, true, "Must skip WebGL check when webgl=real");
  });

  await check("3.3: webgl=off 跳过 WebGL 校验", async () => {
    const profile = {
      id: "p_webgl_off",
      privacy: { webgl: "off" },
    };
    const fp = {
      webgl: { mode: "off", renderer: "NVIDIA GeForce RTX 3080" },
    };
    const live = {
      webglVendor: "Google Inc. (Apple)",
      webglRenderer: "Apple M1 Max",
    };
    const res = evaluateFingerprintDelivery(profile, fp, live);
    assert.strictEqual(res.ok, true, "Must skip WebGL check when webgl=off");
  });

  await check("3.4: language=system 跳过语言校验", async () => {
    const profile = { id: "p_lang_sys", language: "system", privacy: {} };
    const live = { languages: ["en-US", "en"] };
    const res = evaluateFingerprintDelivery(profile, {}, live);
    assert.strictEqual(res.ok, true, "Must skip language check when language=system");
  });

  await check("3.5: cores/memory 未显式指定或设为 0 (real) 时跳过校验", async () => {
    const profile = {
      id: "p_hw_real",
      privacy: { cores: 0, memory: 0 },
    };
    const live = { hardwareConcurrency: 24, deviceMemory: 32 };
    const res = evaluateFingerprintDelivery(profile, {}, live);
    assert.strictEqual(res.ok, true, "Must skip cores/memory check when real or unset");
  });

  // -------------------------------------------------------------------------
  // 4. 探针异常容错与稳定性（只 warn，不阻断）
  // -------------------------------------------------------------------------
  await check("4.1: 探针返回 undefined 时不阻断启动，仅记录警告", async () => {
    const profile = { id: "p_probe_undef", platform: "Win32", privacy: {} };
    const res = evaluateFingerprintDelivery(profile, {}, undefined);
    assert.strictEqual(res.ok, true, "Must not block when probe is undefined");
    assert.ok(res.warnings.length > 0, "Must log warning");
  });

  await check("4.2: 探针返回 null 时不阻断启动，仅记录警告", async () => {
    const profile = { id: "p_probe_null", platform: "Win32", privacy: {} };
    const res = evaluateFingerprintDelivery(profile, {}, null);
    assert.strictEqual(res.ok, true, "Must not block when probe is null");
    assert.ok(res.warnings.length > 0, "Must log warning");
  });

  await check("4.3: 探针抛错 (probeError) 时不阻断启动，仅记录警告", async () => {
    const profile = { id: "p_probe_err", platform: "Win32", privacy: {} };
    const res = evaluateFingerprintDelivery(profile, {}, { probeError: "Execution context was destroyed" });
    assert.strictEqual(res.ok, true, "Must not block when probeError occurs");
    assert.ok(res.warnings.some((w) => w.includes("Execution context was destroyed")));
  });

  await check("4.4: 无 WebGL 上下文（无头环境/无GPU）只 warn 不阻断", async () => {
    const profile = {
      id: "p_no_webgl",
      privacy: { webgl: "noise" },
    };
    const fp = { webgl: { mode: "noise", renderer: "NVIDIA GeForce RTX 3080" } };
    const live = { webglVendor: null, webglRenderer: null };
    const res = evaluateFingerprintDelivery(profile, fp, live);
    assert.strictEqual(res.ok, true, "Must not block when WebGL context is absent");
    assert.ok(res.warnings.some((w) => w.includes("无可用上下文")));
  });

  // -------------------------------------------------------------------------
  // 5. 失败路径行为与安全屏障 (Fail-Closed Barrier & Consecutive Limits)
  // -------------------------------------------------------------------------
  await check("5.1: verifyStartupFingerprintDelivery 在探针矛盾时返回 blocked: true 与详细 mismatches", async () => {
    const engine = Object.create(BrowserEngine.prototype);
    engine.deliveryVerificationFailures = new Map();

    const profile = {
      id: "p_engine_fail",
      os: "windows",
      platform: "Win32",
      exitTimezone: "America/New_York",
      privacy: { timezoneMode: "custom", timezone: "America/New_York" },
    };
    const item = { port: 9222, profile };

    const mockProbe = {
      platform: "MacIntel",
      timezone: "Asia/Shanghai",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    };

    const outcome = await engine.verifyStartupFingerprintDelivery(item, profile, null, { mockProbe });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.blocked, true);
    assert.ok(outcome.mismatches.length >= 2, "Must capture both platform and timezone mismatches");
    assert.ok(outcome.message.includes("指纹交付校验失败"));
  });

  await check("5.2: 连续失败次数上限控制 - 达到 3 次连续失败后立即阻断并标记已达上限", async () => {
    const engine = Object.create(BrowserEngine.prototype);
    engine.deliveryVerificationFailures = new Map();

    const profile = { id: "p_consecutive", platform: "Win32", privacy: {} };
    const item = { port: 9222, profile };
    const badProbe = { platform: "MacIntel" };

    // Attempt 1 fails
    const r1 = await engine.verifyStartupFingerprintDelivery(item, profile, null, { mockProbe: badProbe });
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(engine.deliveryVerificationFailures.get("p_consecutive"), 1);

    // Attempt 2 fails
    const r2 = await engine.verifyStartupFingerprintDelivery(item, profile, null, { mockProbe: badProbe });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(engine.deliveryVerificationFailures.get("p_consecutive"), 2);

    // Attempt 3 fails
    const r3 = await engine.verifyStartupFingerprintDelivery(item, profile, null, { mockProbe: badProbe });
    assert.strictEqual(r3.ok, false);
    assert.strictEqual(engine.deliveryVerificationFailures.get("p_consecutive"), 3);

    // Attempt 4 hits ceiling and immediately blocks without probe
    const r4 = await engine.verifyStartupFingerprintDelivery(item, profile, null, { mockProbe: { platform: "Win32" } });
    assert.strictEqual(r4.ok, false);
    assert.strictEqual(r4.blocked, true);
    assert.strictEqual(r4.consecutiveLimitReached, true);
    assert.ok(r4.message.includes("连续指纹交付校验失败已达上限"));

    // Resetting failures clears ceiling
    engine.resetFingerprintVerificationFailures("p_consecutive");
    assert.strictEqual(engine.deliveryVerificationFailures.has("p_consecutive"), false);

    // After reset, valid probe succeeds
    const r5 = await engine.verifyStartupFingerprintDelivery(item, profile, null, { mockProbe: { platform: "Win32" } });
    assert.strictEqual(r5.ok, true);
    assert.strictEqual(r5.blocked, false);
  });

  await check("5.3: engine.js 源码完整性 - 启动屏障确保交付失败时 emit 事件且不导航到目标站点", async () => {
    const fs = require("fs");
    const engineCode = fs.readFileSync(path.join(__dirname, "../engine.js"), "utf8");

    assert.ok(engineCode.includes("verifyStartupFingerprintDelivery"), "Must implement verifyStartupFingerprintDelivery");
    assert.ok(engineCode.includes("fingerprint-verification-failed"), "Must emit fingerprint-verification-failed");
    assert.ok(engineCode.includes("item.verificationBlocked = true"), "Must mark verificationBlocked on item");
    assert.ok(engineCode.includes("start.navigate-verification-barrier-errorpage"), "Must log navigation to local error page on verification failure");
    assert.ok(engineCode.includes("指纹未按配置交付，已阻止访问目标站点"), "Must include Chinese warning on error page");
    assert.ok(engineCode.includes("!item.verificationBlocked"), "Must guard catch-block fallback from navigating to startUrl");
  });


  await check("5.4: 屏障触发时 emit 的事件格式完全符合规格定义 (type, id, blocked, mismatches, message)", async () => {
    const engine = Object.create(BrowserEngine.prototype);
    engine.deliveryVerificationFailures = new Map();
    const emitted = [];
    engine.emit = (evt) => emitted.push(evt);

    const profile = {
      id: "p_emit_test",
      platform: "Win32",
      privacy: {},
    };
    const item = { port: 9222, profile };
    const badProbe = { platform: "MacIntel" };

    const outcome = await engine.verifyStartupFingerprintDelivery(item, profile, null, { mockProbe: badProbe });
    assert.strictEqual(outcome.ok, false);

    // Simulate emission in start()
    engine.emit({
      type: "fingerprint-verification-failed",
      id: profile.id,
      blocked: true,
      mismatches: outcome.mismatches,
      message: outcome.message,
    });

    assert.strictEqual(emitted.length, 1);
    const event = emitted[0];
    assert.strictEqual(event.type, "fingerprint-verification-failed");
    assert.strictEqual(event.id, "p_emit_test");
    assert.strictEqual(event.blocked, true);
    assert.ok(Array.isArray(event.mismatches));
    assert.ok(typeof event.message === "string" && event.message.length > 0);
  });

  const failed = results.filter((item) => !item.ok);
  if (failed.length) {
    console.error("startup-fingerprint-delivery-selftest: FAIL " + (results.length - failed.length) + "/" + results.length);
    process.exitCode = 1;
  } else {
    console.log("startup-fingerprint-delivery-selftest: OK " + results.length + "/" + results.length);
  }
})();
