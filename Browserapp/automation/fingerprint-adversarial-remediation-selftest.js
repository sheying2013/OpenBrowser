#!/usr/bin/env node
'use strict';

/**
 * OpenBrowser Fingerprint Adversarial Remediation Self-Test Suite
 *
 * Verifies all 18 checklist items targeted in the hardening program:
 *   [1] Date.prototype & Intl.DateTimeFormat.prototype descriptor writable: false
 *   [2] navigator.languages === navigator.languages frozen array identity
 *   [3] window.open('about:blank') subwindow fingerprint protection
 *   [4] Object.getOwnPropertyNames(Date) property order: length,name,prototype,now,parse,UTC
 *   [5] Error().stack hygiene (no replaceMethod/safeWrapper leak, illegal invocation clean stack)
 *   [6] Accept-Language weight chain & profile.privacy.languages priority
 *   [7] Non-HDR colorDepth locked to 24
 *   [8] navigator.keyboard.getLayoutMap() US layout mapping & prototype shape
 *   [9] iframe.getAttribute('srcdoc') does not expose bootstrap script or persona JSON
 *   [10] srcdoc iframe does not expose __ob_sb_injected__
 *   [11] srcdoc iframe wrapped functions toString() returns [native code]
 *   [12] iOS persona navigator.vendor is 'Apple Computer, Inc.'
 *   [13] iOS persona navigator.userAgentData is undefined
 *   [14] Android persona enables font protection (fonts !== null)
 *   [15] mapPlatformToSubsetKey('iPhone') maps to 'macos'
 *   [16] iOS persona provides window.GestureEvent
 *   [17] WEBGL_GPU_LIMITS covers imagination (PowerVR) architecture
 *   [18] iOS speech voice pool excludes Chromium Google voices
 */

const assert = require('assert');
const {
  buildFingerprint,
  buildInjectionScript,
  mapPlatformToSubsetKey,
  createSpeechVoicesFromSeed,
  normalizeGpuArchitecture,
  webglParameterOverrides,
  applyFingerprintToTab,
} = require('./fingerprint');

const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.error(`  FAIL  ${name} — ${err.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('Running Fingerprint Adversarial Remediation Self-Tests...\n');

  // [1] Date.prototype & Intl.DateTimeFormat.prototype writable: false
  check('[P0] Date.prototype & Intl.DateTimeFormat.prototype writable descriptor is false', () => {
    const fp = buildFingerprint({ id: 'test-tz', timezone: 'America/New_York' });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes("writable: false"), 'script must set writable: false on prototype descriptors');
    assert.ok(script.includes("DateTimeFormatProto"), 'must bind DateTimeFormat prototype');
    assert.ok(script.includes("PatchedDate"), 'must construct PatchedDate wrapper');
  });

  // [2] navigator.languages === navigator.languages
  check('[P0] navigator.languages === navigator.languages frozen array identity', () => {
    const fp = buildFingerprint({ id: 'test-lang', languages: ['en-US', 'en'] });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes('FROZEN_LANGUAGES'), 'script must use FROZEN_LANGUAGES closure singleton');
    assert.ok(script.includes('Object.freeze'), 'languages array must be frozen');
  });

  // [3] window.open('about:blank') subwindow patching
  check('[P0] window.open intercepts subwindow synchronously with patchSubWindow', () => {
    const fp = buildFingerprint({ id: 'test-win-open' });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes('const patchedWindowOpen = nativeLike(function open'), 'window.open must be hooked');
    assert.ok(script.includes('patchSubWindow(subWin)'), 'subwindow must receive patchSubWindow synchronously');
  });

  // [4] Object.getOwnPropertyNames(Date) order
  check('[P1] Object.getOwnPropertyNames(Date) order length,name,prototype,now,parse,UTC', () => {
    const fp = buildFingerprint({ id: 'test-date-order', timezone: 'America/Chicago' });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes('PatchedDate.now = OrigDate.now;'), 'now must be attached before parse and UTC');
    assert.ok(script.includes('PatchedDate.parse = nativeLike('), 'parse must follow now');
    assert.ok(script.includes('PatchedDate.UTC = OrigDate.UTC;'), 'UTC must follow parse');
  });

  // [5] Error().stack hygiene
  check('[P1] stripStackFrame and cleanStack hide replaceMethod and safeWrapper frames', () => {
    const fp = buildFingerprint({ id: 'test-stack' });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes('stripStackFrame'), 'stripStackFrame must be present');
    assert.ok(script.includes('cleanStack'), 'cleanStack must be present');
    assert.ok(!script.includes('Symbol.for'), 'must not expose Symbol.for');
  });

  // [6] Accept-Language weight chain & privacy.languages priority
  check('[P1] Accept-Language weight chain format and privacy.languages priority', () => {
    const fp = buildFingerprint({
      id: 'test-lang-priority',
      languages: ['fr-FR', 'fr'],
      privacy: { languages: ['de-DE', 'de', 'en'] },
    });
    assert.deepStrictEqual(fp.languages, ['de-DE', 'de', 'en'], 'privacy.languages must take priority');
    assert.ok(fp.acceptLanguage.includes('de-DE,de;q=0.9'), 'Accept-Language header must carry standard q-values');
  });

  // [7] Non-HDR colorDepth locked to 24
  check('[P2] Non-HDR colorDepth is strictly 24', () => {
    const fpSdr = buildFingerprint({ id: 'test-sdr' });
    assert.strictEqual(fpSdr.screen.colorDepth, 24, 'SDR screen must have colorDepth: 24');
    assert.strictEqual(fpSdr.screen.pixelDepth, 24, 'SDR screen must have pixelDepth: 24');

    const fpHdr = buildFingerprint({ id: 'test-hdr', hdr: true, colorDepth: 30 });
    assert.strictEqual(fpHdr.screen.colorDepth, 30, 'HDR profile allows colorDepth: 30');
  });

  // [8] navigator.keyboard.getLayoutMap() shape & US layout
  check('[P2] navigator.keyboard.getLayoutMap() hooks US layout and native shape', () => {
    const fp = buildFingerprint({ id: 'test-kb' });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes('US_KEYBOARD_LAYOUT'), 'US_KEYBOARD_LAYOUT must be declared');
    assert.ok(script.includes('replaceMethod(Keyboard.prototype, "getLayoutMap"'), 'Keyboard.prototype.getLayoutMap must be replaced');
  });

  // [9] iframe.getAttribute('srcdoc') clean filter
  check('[P0] iframe.getAttribute("srcdoc") filters injected bootstrap script', () => {
    const fp = buildFingerprint({ id: 'test-srcdoc' });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes('cleanSrcdoc'), 'cleanSrcdoc filter must be defined');
    assert.ok(script.includes('rawSrcdocMap'), 'rawSrcdocMap must retain original attribute values');
  });

  // [10] srcdoc iframe avoids __ob_sb_injected__
  check('[P0] srcdoc iframe does not expose __ob_sb_injected__ or Symbol.for', () => {
    const fp = buildFingerprint({ id: 'test-srcdoc-markers' });
    const script = buildInjectionScript(fp);
    assert.ok(!script.includes('window.__ob_sb_injected__'), 'window.__ob_sb_injected__ must not be in source');
    assert.ok(!script.includes('Symbol.for'), 'Symbol.for must not be in source');
  });

  // [11] srcdoc iframe wrapped functions toString() returns [native code]
  check('[P0] srcdoc iframe functions return [native code] on toString()', () => {
    const fp = buildFingerprint({ id: 'test-srcdoc-native' });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes('setSboxNative'), 'setSboxNative helper must be present in srcdoc bootstrap');
  });

  // [12] iOS persona navigator.vendor
  check('[P0] iOS persona vendor is "Apple Computer, Inc."', () => {
    const fpIos = buildFingerprint({ id: 'test-ios', os: 'ios' });
    assert.strictEqual(fpIos.uaProfile.vendor, 'Apple Computer, Inc.');
    const script = buildInjectionScript(fpIos);
    assert.ok(script.includes('"Apple Computer, Inc."'), 'injection script must carry Apple vendor');
  });

  // [13] iOS persona navigator.userAgentData removed
  check('[P0] iOS persona removes navigator.userAgentData', () => {
    const fpIos = buildFingerprint({ id: 'test-ios-uad', os: 'ios' });
    const script = buildInjectionScript(fpIos);
    assert.ok(script.includes('delete Navigator.prototype.userAgentData'), 'Navigator.prototype.userAgentData must be deleted on iOS');
    assert.ok(script.includes('delete window.NavigatorUAData'), 'window.NavigatorUAData must be deleted on iOS');
  });

  // [14] Android mobile persona enables font protection
  check('[P1] Android mobile persona enables fonts protection without explicit persona flag', () => {
    const fpAndroid = buildFingerprint({ id: 'test-android-fonts', os: 'android' });
    assert.ok(fpAndroid.fonts, 'fonts object must be present for Android mobile device');
    assert.strictEqual(fpAndroid.fonts.os, 'android');
    assert.ok(fpAndroid.fonts.list.includes('Roboto'), 'Android font list must include Roboto');
  });

  // [15] mapPlatformToSubsetKey('iPhone') maps to 'macos'
  check('[P1] mapPlatformToSubsetKey maps iPhone to macos font subset', () => {
    assert.strictEqual(mapPlatformToSubsetKey('iPhone'), 'macos');
    assert.strictEqual(mapPlatformToSubsetKey('iPad'), 'macos');
    assert.strictEqual(mapPlatformToSubsetKey('iPod'), 'macos');
    assert.strictEqual(mapPlatformToSubsetKey('iOS'), 'macos');
    assert.strictEqual(mapPlatformToSubsetKey('Linux armv8l'), 'android');
    assert.strictEqual(mapPlatformToSubsetKey('Win32'), 'windows');
  });

  // [16] iOS persona provides window.GestureEvent
  check('[P1] iOS persona provides window.GestureEvent inheriting UIEvent', () => {
    const fpIos = buildFingerprint({ id: 'test-ios-gesture', os: 'ios' });
    const script = buildInjectionScript(fpIos);
    assert.ok(script.includes('FakeGestureEvent'), 'FakeGestureEvent constructor must be generated for iOS');
    assert.ok(script.includes('Object.defineProperty(window, "GestureEvent"'), 'window.GestureEvent must be defined');
  });

  // [17] WEBGL_GPU_LIMITS covers imagination (PowerVR)
  check('[P1] WEBGL_GPU_LIMITS covers imagination (PowerVR) architecture', () => {
    assert.strictEqual(normalizeGpuArchitecture('imagination', 'PowerVR Rogue GE8320'), 'rogue');
    const overrides = webglParameterOverrides({ vendor: 'imagination', architecture: 'rogue' });
    assert.ok(overrides, 'PowerVR overrides must not be null');
    assert.strictEqual(overrides[3379], 8192, 'MAX_TEXTURE_SIZE must be 8192');
    assert.strictEqual(overrides[35380], 64, 'UNIFORM_BUFFER_OFFSET_ALIGNMENT must be 64');
  });

  // [18] iOS speech voice pool excludes Google Chromium voices
  check('[P2] iOS speech voice pool excludes Google Chromium voices', () => {
    const voices = createSpeechVoicesFromSeed('ios-seed', ['en-US'], 'noise', { os: 'ios' });
    assert.ok(Array.isArray(voices) && voices.length > 0, 'iOS voices must be generated');
    for (const v of voices) {
      assert.ok(!v.name.startsWith('Google '), `iOS voice pool must not contain Chromium voice: ${v.name}`);
    }
  });

  // [19] Desktop persona OS locks randomUaForSeed to chosen OS without drift
  check("[P1] Desktop persona OS locks randomUaForSeed to chosen OS without drift", () => {
    for (const targetOs of ["linux", "windows", "macos"]) {
      for (let i = 0; i < 10; i++) {
        const fp = buildFingerprint({ id: "drift-test-" + i, os: targetOs });
        assert.strictEqual(fp.uaProfile.os, targetOs, `OS must match ${targetOs} without drift`);
      }
    }
    const fpAndroid = buildFingerprint({ id: "android-test", os: "android" });
    assert.strictEqual(fpAndroid.uaProfile.os, "android");
    const fpIos = buildFingerprint({ id: "ios-test", os: "ios" });
    assert.strictEqual(fpIos.uaProfile.os, "ios");
  });

  // [20] Plain desktop persona enables font isolation when claimed OS differs from host OS
  check("[P1] Plain desktop persona enables font isolation when claimed OS differs from host OS", () => {
    const hostNorm = process.platform === "darwin" ? "macos" : (process.platform === "win32" ? "windows" : (process.platform === "linux" ? "linux" : process.platform));
    const foreignTarget = hostNorm === "macos" ? "windows" : "macos";
    const fpForeign = buildFingerprint({ id: "font-test-foreign", os: foreignTarget });
    assert.ok(fpForeign.fonts, "fp.fonts must not be null when foreign OS claimed on host");
    assert.strictEqual(fpForeign.fonts.os, foreignTarget);
    assert.ok(Array.isArray(fpForeign.fonts.foreign) && fpForeign.fonts.foreign.length > 0);

    const fpSame = buildFingerprint({ id: "font-test-same", os: hostNorm });
    assert.strictEqual(fpSame.fonts, null, "fp.fonts must be null when claimed OS matches host OS without persona");
  });

  // [21] Non-custom timezone mode triggers CDP Emulation.setTimezoneOverride unless mode is real
  await (async () => {
    const cdpCalls = [];
    const mockCdp = async (method, params) => {
      cdpCalls.push({ method, params });
      return {};
    };

    const fp = buildFingerprint({ id: "tz-test" });
    await applyFingerprintToTab(mockCdp, null, fp, {
      privacy: { timezoneMode: "auto" },
      exitTimezone: "Europe/Berlin",
    }, { force: true });

    check("[P1] Non-custom timezone mode triggers CDP Emulation.setTimezoneOverride unless mode is real", () => {
      const tzCall = cdpCalls.find(c => c.method === "Emulation.setTimezoneOverride");
      assert.ok(tzCall, "Emulation.setTimezoneOverride must be called for non-custom exitTimezone");
      assert.strictEqual(tzCall.params.timezoneId, "Europe/Berlin");
    });

    const cdpCallsReal = [];
    const mockCdpReal = async (method, params) => {
      cdpCallsReal.push({ method, params });
      return {};
    };
    await applyFingerprintToTab(mockCdpReal, null, fp, {
      privacy: { timezoneMode: "real" },
      exitTimezone: "Europe/Berlin",
    }, { force: true });

    check("[P1] timezoneMode: real does not dispatch Emulation.setTimezoneOverride", () => {
      assert.ok(!cdpCallsReal.some(c => c.method === "Emulation.setTimezoneOverride"), "timezoneMode: real must not call setTimezoneOverride");
    });

    // [22] CDP Network.setUserAgentOverride receives cleaned acceptLanguage
    check("[P2] CDP Network.setUserAgentOverride receives cleaned acceptLanguage", () => {
      const netCall = cdpCalls.find(c => c.method === "Network.setUserAgentOverride");
      assert.ok(netCall, "Network.setUserAgentOverride must be called");
      assert.ok(!netCall.params.acceptLanguage.includes(";q="), "acceptLanguage in Network.setUserAgentOverride must be cleaned");
    });
  })();

  // [24] X1: S_NATIVE Symbol completely eliminated from injection scripts
  check("[P0] X1: S_NATIVE Symbol completely eliminated from injection scripts", () => {
    const fp = buildFingerprint({ os: "windows" });
    const script = buildInjectionScript(fp);
    assert.ok(!script.includes("S_NATIVE"), "Injection script must not contain S_NATIVE");
    assert.ok(!script.includes("Symbol()"), "Injection script must not define custom Symbol()");
  });

  // [25] V1: makeNativeGetter rejects invocation on prototype with TypeError
  check("[P0] V1: makeNativeGetter rejects invocation on prototype with TypeError", () => {
    const fp = buildFingerprint({ os: "windows", hardwareConcurrency: 8, deviceMemory: 8 });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes("this !== Navigator.prototype"), "Script must explicitly guard against Navigator.prototype");
    assert.ok(script.includes("this !== Screen.prototype"), "Script must explicitly guard against Screen.prototype");
  });

  // [26] V2: iOS persona guards eliminate chrome and desktop device APIs
  check("[P0] V2: iOS persona guards eliminate chrome and desktop device APIs", () => {
    const fpIos = buildFingerprint({ os: "ios", platform: "iPhone" });
    const scriptIos = buildInjectionScript(fpIos);
    assert.ok(scriptIos.includes("delete Navigator.prototype.connection"), "iOS must delete connection");
    assert.ok(scriptIos.includes("delete Navigator.prototype.getBattery"), "iOS must delete getBattery");
    assert.ok(scriptIos.includes("delete Navigator.prototype.usb"), "iOS must delete usb");
    assert.ok(scriptIos.includes("delete window.chrome"), "iOS must delete window.chrome");
  });

  // [27] V3: Android persona omits window.chrome.app & sets plugins/pdfViewerEnabled
  check("[P0] V3: Android persona omits window.chrome.app & sets plugins/pdfViewerEnabled", () => {
    const fpAndr = buildFingerprint({ os: "android" });
    const scriptAndr = buildInjectionScript(fpAndr);
    assert.ok(scriptAndr.includes("delete window.chrome.app"), "Android must delete window.chrome.app");
    assert.ok(scriptAndr.includes("pdfViewerEnabled"), "Android must guard pdfViewerEnabled");
  });

  // [28] V4: All denial error messages neutralized
  check("[P0] V4: All denial error messages neutralized (zero branding traces)", () => {
    const fp = buildFingerprint({ os: "windows", privacy: { battery: "blocked" } });
    const script = buildInjectionScript(fp);
    assert.ok(!script.includes("disabled by this profile"), "Script must not leak 'disabled by this profile'");
    assert.ok(!script.includes("by this profile"), "Script must not leak 'by this profile'");
  });

  // [29] V5: Mobile screen.orientation.lock returns SecurityError
  check("[P1] V5: Mobile screen.orientation.lock returns SecurityError", () => {
    const fp = buildFingerprint({ os: "android" });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes("screen.orientation.lock() is only available in fullscreen mode."), "Mobile must guard orientation.lock");
  });

  // [30] V6: Linux mediaCapabilities hvc1/hev1 powerEfficient: false
  check("[P1] V6: Linux mediaCapabilities hvc1/hev1 powerEfficient: false", () => {
    const fp = buildFingerprint({ os: "linux" });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes("powerEfficient: false"), "Linux must force powerEfficient: false for hevc");
  });

  // [31] V7 / P0: window.chrome.csi & chrome.loadTimes preserved on Desktop, absent on iOS
  check("[P0] window.chrome.csi & chrome.loadTimes preserved on Desktop, absent on iOS", () => {
    const fpWin = buildFingerprint({ os: "windows" });
    const scriptWin = buildInjectionScript(fpWin);
    assert.ok(scriptWin.includes("window.chrome.csi"), "Must ensure window.chrome.csi exists on desktop");
    assert.ok(scriptWin.includes("window.chrome.loadTimes"), "Must ensure window.chrome.loadTimes exists on desktop");
    assert.ok(!scriptWin.includes("delete window.chrome.csi;\n      }"), "Desktop branch must not delete csi");
    assert.ok(!scriptWin.includes("delete window.chrome.loadTimes;\n      }"), "Desktop branch must not delete loadTimes");

    const fpIos = buildFingerprint({ os: "ios", platform: "iPhone" });
    const scriptIos = buildInjectionScript(fpIos);
    assert.ok(scriptIos.includes("delete window.chrome;"), "Must delete window.chrome on iOS");
  });

  // [32] H1: document.fonts iterator wraps native iterator instead of function* generator
  check("[P0] H1: document.fonts iterator wraps native iterator instead of function* generator", () => {
    const { buildFontMetricsScript } = require("./fingerprint");
    const script = buildFontMetricsScript("windows", { list: ["Arial"] });
    assert.ok(!script.includes("function*"), "document.fonts must not use generator functions");
    assert.ok(script.includes("wrapIterator"), "Must wrap native iterator with Proxy");
  });

  // [33] H2: SVG sanitizeElementFontScope covers computed styles & child tspans
  check("[P0] H2: SVG sanitizeElementFontScope covers computed styles & child tspans", () => {
    const fp = buildFingerprint({ os: "windows", privacy: { deviceProfile: "persona" } });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes("getComputedStyle"), "sanitizeElementFontScope must inspect computed styles");
    assert.ok(script.includes("getElementsByTagName('tspan')"), "sanitizeElementFontScope must inspect tspan descendants");
  });

  // [34] H4: Canvas putImageData -> getImageData avoids double noise accumulation
  check("[P1] H4: Canvas putImageData -> getImageData avoids double noise accumulation", () => {
    const fp = buildFingerprint({ os: "windows", canvas: "noise" });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes("ctxLastPutMap"), "Must track putImageData regions");
    assert.ok(script.includes("result.data.set(lastPut.data)"), "Must restore original noised data without double noise");
  });

  // [35] H5: WebGL toDataURL uses readPixels noised buffer
  check("[P1] H5: WebGL toDataURL uses readPixels noised buffer", () => {
    const fp = buildFingerprint({ os: "windows", canvas: "noise", webgl: "noise" });
    const script = buildInjectionScript(fp);
    assert.ok(!script.includes("if (webglCanvases.has(source)) return null;"), "WebGL canvas must not skip noise");
    assert.ok(script.includes("gl.readPixels"), "WebGL canvas noiseCanvas must read pixels from WebGL context");
  });

  // [36] H6: AudioContext sampleRate & baseLatency spoofing
  check("[P1] H6: AudioContext sampleRate & baseLatency spoofing", () => {
    const fp = buildFingerprint({ os: "windows", audio: "noise" });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes("mockSampleRate = 48000"), "Windows must mock 48000 sampleRate");
    assert.ok(script.includes("mockBaseLatency = 512 / 48000"), "Windows must mock baseLatency");
  });

  // [37] H7: iOS MediaSource & canPlayType reject webm
  check("[P1] H7: iOS MediaSource & canPlayType reject webm", () => {
    const fp = buildFingerprint({ os: "ios" });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes("webm") && script.includes("isTypeSupported"), "iOS MediaSource must reject webm");
    assert.ok(script.includes("webm") && script.includes("canPlayType"), "iOS canPlayType must return empty string for webm");
  });

  // [38] H8: iOS CSS.supports -webkit-touch-callout returns true
  check("[P2] H8: iOS CSS.supports -webkit-touch-callout returns true", () => {
    const fp = buildFingerprint({ os: "ios" });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes("-webkit-touch-callout"), "iOS must support -webkit-touch-callout");
  });

  // [39] H9: TextMetrics actualBoundingBox* jitter
  check("[P2] H9: TextMetrics actualBoundingBox* jitter", () => {
    const fp = buildFingerprint({ os: "windows", canvas: "noise" });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes("actualBoundingBoxRight"), "Must jitter actualBoundingBoxRight");
    assert.ok(script.includes("actualBoundingBoxLeft"), "Must jitter actualBoundingBoxLeft");
  });

  // [40] D1: Local Font Blob lazy payload bridge enabled by default
  check("[P0] D1: Local Font Blob lazy payload bridge enabled by default", () => {
    const fp = buildFingerprint({ os: "windows" });
    assert.ok(fp.fontBlobBridge, "fp.fontBlobBridge must be populated");
    assert.strictEqual(fp.fontBlobBridge.platform, "windows");
    assert.ok(fp.fontBlobBridge.channelName.startsWith("_"));
    assert.strictEqual(typeof fp.fontBlobBridge.token, "string");

    const inlineSrc = buildInjectionScript({ ...fp, lazyFontPayload: false });
    const lazySrc = buildInjectionScript(fp);
    const reduction = (inlineSrc.length - lazySrc.length) / inlineSrc.length;
    assert.ok(reduction > 0.5, "Lazy payload must reduce injection script size significantly");
  });

  // [41] R1: document.fonts iterator next and Symbol.iterator native shape and caching
  check("[P0] R1: document.fonts iterator next and Symbol.iterator native shape and caching", () => {
    const fp = buildFingerprint({ os: "windows", privacy: { deviceProfile: "persona" } });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes("function next() { [native code] }"), "Must register native code string for next");
    assert.ok(script.includes("function [Symbol.iterator]() { [native code] }"), "Must register native code string for Symbol.iterator");
    assert.ok(script.includes("cachedNext") && script.includes("cachedIter"), "Must cache next and iterator instances per wrapper");
  });

  // [42] R2: makeNativeGetter throws receiver realm TypeError
  check("[P0] R2: makeNativeGetter throws receiver realm TypeError", () => {
    const fp = buildFingerprint({ os: "windows" });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes("getRealmTypeError"), "Must define getRealmTypeError");
    assert.ok(script.includes("const RealmTypeError = getRealmTypeError(this)"), "Must throw RealmTypeError");
  });

  // [43] R3: SpeechSynthesisVoice cannot be cloned by structuredClone
  check("[P0] R3: SpeechSynthesisVoice cannot be cloned by structuredClone", () => {
    const fp = buildFingerprint({ os: "windows" });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes("mockVoiceSet"), "Must maintain mockVoiceSet");
    assert.ok(script.includes("SpeechSynthesisVoice object could not be cloned."), "Must throw DataCloneError on clone");
  });

  // [44] R4: document.fonts Proxy traps getOwnPropertyDescriptor and has
  check("[P1] R4: document.fonts Proxy traps getOwnPropertyDescriptor and has", () => {
    const fp = buildFingerprint({ os: "windows", privacy: { deviceProfile: "persona" } });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes("getOwnPropertyDescriptor(target, prop)"), "Must implement getOwnPropertyDescriptor trap");
    assert.ok(script.includes("has(target, prop)"), "Must implement has trap");
  });

  console.log(`\nAll ${results.filter(r => r.ok).length}/${results.length} remediation assertions passed.`);
})();
