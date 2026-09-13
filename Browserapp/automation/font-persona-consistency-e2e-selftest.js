#!/usr/bin/env node
'use strict';

/**
 * End-to-end selftest for font persona declaration, runtime registration,
 * detection release markers, and cross-layer consistency verification.
 *
 * Covers:
 * 1. Persona font declaration vs FontFace local() resolution & foreign marker rejection.
 * 2. Operating system release version marker deduction table for platform versions.
 * 3. queryLocalFonts() behavior under unauthenticated vs authorized contexts.
 * 4. Canvas and DOM layout metrics non-fallback for registered subsets and KNOWN GAPs for missing fonts.
 * 5. Full cross-check of declared fonts vs subset coverage across Windows, macOS, and Linux.
 * 6. document.fonts external view shielding and native descriptor integrity.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildFingerprint, buildInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const { OS_FONTS, fontsForOs, exclusiveFontsForOtherOs } = require('./device-personas');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const subsetIndexPath = path.join(appRoot, 'assets', 'font-subsets', 'index.json');
const subsetIndex = JSON.parse(fs.readFileSync(subsetIndexPath, 'utf8'));

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const results = [];
const check = (name, fn) => {
  try {
    fn();
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
  console.log(`  SKIP  ${name}${why ? ' - ' + why : ''}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Operating system release version marker lookup tables.
 * Used by modern fingerprinting probes to infer the underlying operating system release.
 */
const WINDOWS_RELEASE_TABLE = [
  { version: 'Windows 11', marker: 'Segoe Fluent Icons' },
  { version: 'Windows 10', marker: 'HoloLens MDL2 Assets' },
  { version: 'Windows 8.1', marker: 'Aldhabi' },
  { version: 'Windows 7', marker: 'Segoe UI' },
];

const MACOS_RELEASE_TABLE = [
  { version: 'macOS 14+ (Sonoma/Sequoia)', marker: 'Noto Serif Yezidi Regular' },
  { version: 'macOS 13 (Ventura)', marker: 'Noto Sans Canadian Aboriginal Regular' },
  { version: 'macOS 12 (Monterey)', marker: 'STIX Two Math Regular' },
  { version: 'macOS 11 (Big Sur)', marker: 'Apple SD Gothic Neo ExtraBold' },
  { version: 'macOS 10.15 (Catalina)', marker: 'Galvji' },
  { version: 'macOS 10.14 (Mojave)', marker: 'InaiMathi Bold' },
  { version: 'macOS 10.13 (High Sierra)', marker: 'Kohinoor Devanagari Medium' },
  { version: 'macOS 10.12 (Sierra)', marker: 'PingFang HK Light' },
  { version: 'macOS 10.11 (El Capitan)', marker: 'PingFang SC' },
];

function evaluateWindowsRelease(resultsMap) {
  for (const item of WINDOWS_RELEASE_TABLE) {
    if (resultsMap[item.marker]?.outcome === 'resolve') {
      return item.version;
    }
  }
  return undefined;
}

function evaluateMacosRelease(resultsMap) {
  for (const item of MACOS_RELEASE_TABLE) {
    if (resultsMap[item.marker]?.outcome === 'resolve') {
      return item.version;
    }
  }
  return undefined;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
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
        resolve({ error: { message: 'CDP timeout: ' + method } });
      }, 30000);
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  call(method, params = {}) { return this.send(method, params); }
  async value(expression, options = {}) {
    const message = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...options,
    });
    const exception = message?.result?.exceptionDetails;
    if (exception) return { error: exception.text || JSON.stringify(exception) };
    const raw = message?.result?.result?.value;
    try { return JSON.parse(raw); } catch (_) { return raw; }
  }
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function waitForPage(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = (list || []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) {}
    await sleep(300);
  }
  return null;
}

function buildInPageProbe(declaredFamilies, foreignMarkers, subsetFamilies, missingFamilies) {
  return `(async () => {
    const out = {
      marker: window.__marker === true,
      docFonts: {},
      fontFaceLocal: {},
      canvasMeasure: {},
      domOffsetWidth: {},
      cjkMeasure: {},
      queryLocalFontsUnauth: null,
    };

    // 1. document.fonts external view shielding
    try {
      const fontsObj = document.fonts;
      out.docFonts = {
        size: fontsObj ? fontsObj.size : null,
        spreadLength: fontsObj ? [...fontsObj].length : null,
        hasOwnCheck: Object.prototype.hasOwnProperty.call(fontsObj, 'check'),
        checkSegoe: fontsObj ? fontsObj.check('16px "Segoe UI"') : null,
        checkHelvetica: fontsObj ? fontsObj.check('16px "Helvetica Neue"') : null,
      };
      const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'fonts');
      out.docFonts.getterToString = desc && desc.get ? Function.prototype.toString.call(desc.get) : null;
    } catch (e) {
      out.docFonts.error = e.name + ': ' + e.message;
    }

    // 2. queryLocalFonts unauthenticated probe (should reject with SecurityError)
    try {
      if (typeof window.queryLocalFonts !== 'function') {
        out.queryLocalFontsUnauth = { status: 'not_a_function' };
      } else {
        await window.queryLocalFonts();
        out.queryLocalFontsUnauth = { status: 'resolved_unexpectedly' };
      }
    } catch (e) {
      out.queryLocalFontsUnauth = {
        status: 'rejected',
        name: e.name,
        message: e.message,
      };
    }

    // 3. FontFace local() probes on all declared families
    const probeFace = async (family) => {
      try {
        const face = new FontFace(family, 'local("' + family + '")');
        await face.load();
        return { outcome: 'resolve', status: face.status, errName: null };
      } catch (e) {
        return { outcome: 'reject', status: 'error', errName: e ? e.name : 'UnknownError' };
      }
    };

    const declared = ${JSON.stringify(declaredFamilies)};
    for (const fam of declared) {
      out.fontFaceLocal[fam] = await probeFace(fam);
    }

    const foreign = ${JSON.stringify(foreignMarkers)};
    for (const fam of foreign) {
      out.fontFaceLocal[fam] = await probeFace(fam);
    }

    // 4. Canvas text measurement & DOM layout fallback inspection
    const testText = 'mmmmmmmmmmlliWWWWWWWWW@@@@@@@@@@1234567890';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = '72px monospace';
    const monoWidth = ctx.measureText(testText).width;

    const spanMono = document.createElement('span');
    spanMono.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;font:72px monospace;';
    spanMono.textContent = testText;
    document.body.appendChild(spanMono);
    const monoDomWidth = spanMono.offsetWidth;

    const testFamilies = ${JSON.stringify([...subsetFamilies, ...missingFamilies])};
    for (const fam of testFamilies) {
      // Canvas measurement
      ctx.font = '72px "' + fam + '", monospace';
      const w = ctx.measureText(testText).width;
      out.canvasMeasure[fam] = {
        width: w,
        monoWidth,
        diff: Math.abs(w - monoWidth),
        noFallback: Math.abs(w - monoWidth) > 0.001,
      };

      // DOM offsetWidth measurement
      const span = document.createElement('span');
      span.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;font:72px "' + fam + '", monospace;';
      span.textContent = testText;
      document.body.appendChild(span);
      out.domOffsetWidth[fam] = {
        width: span.offsetWidth,
        monoWidth: monoDomWidth,
        noFallback: Math.abs(span.offsetWidth - monoDomWidth) > 0,
      };
      document.body.removeChild(span);
    }
    document.body.removeChild(spanMono);

    // 5. CJK probe text measurement to quantify architectural subset bounding
    const cjkTestText = '永国中文测试';
    ctx.font = '72px monospace';
    const cjkMonoWidth = ctx.measureText(cjkTestText).width;
    const cjkTargetFamilies = ['Microsoft YaHei', 'SimSun', 'Microsoft JhengHei', 'PingFang SC', 'Hiragino Sans', 'PingFang HK Light'];
    for (const fam of cjkTargetFamilies) {
      ctx.font = '72px "' + fam + '", monospace';
      const w = ctx.measureText(cjkTestText).width;
      out.cjkMeasure[fam] = {
        width: w,
        monoWidth: cjkMonoWidth,
        diff: Math.abs(w - cjkMonoWidth),
        noFallback: Math.abs(w - cjkMonoWidth) > 0.001,
      };
    }

    return JSON.stringify(out);
  })()`;
}

async function runPersonaE2E(label, userAgent, osName, serverPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-fontconsistency-${label}-`));
  const profile = {
    id: `fontconsistency-${label}`,
    name: `fontconsistency-${label}`,
    language: 'en-US',
    userAgent,
    kernelVersion: '148.0.7778.165',
    os: osName,
    exitIp: '203.0.113.8',
    privacy: { deviceProfile: 'persona' },
  };
  const fp = buildFingerprint(profile);
  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile,
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });

  const child = spawn(launcher, [dir, '--headless=new'], {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(300);
    try {
      const val = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (val > 0) { port = val; break; }
    } catch (_) {}
  }
  if (!port) {
    await stopChild(child, dir);
    throw new Error(`Failed to obtain DevToolsActivePort for persona ${label}`);
  }

  const page = await waitForPage(port);
  if (!page?.webSocketDebuggerUrl) {
    await stopChild(child, dir);
    throw new Error(`Failed to find page target with webSocketDebuggerUrl for persona ${label}`);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`WebSocket connection failed for persona ${label}`));
  });
  const cdp = new Cdp(ws);

  const origin = `http://127.0.0.1:${serverPort}`;
  const declaredFamilies = fp.fonts.list;
  const osKey = osName.toLowerCase() === 'windows' ? 'windows' : 'macos';
  const platformSubsets = subsetIndex.platforms[osKey] || {};
  const subsetFamilies = declaredFamilies.filter((f) => !!platformSubsets[f]);
  const missingFamilies = declaredFamilies.filter((f) => !platformSubsets[f]);

  const foreignMarkers = osKey === 'windows'
    ? [
        'Helvetica Neue', 'Luminari', 'PingFang HK Light', 'Galvji',
        'InaiMathi Bold', 'MuktaMahee Regular', 'Apple SD Gothic Neo ExtraBold',
        'STIX Two Math Regular', 'Noto Serif Yezidi Regular', 'Liberation Sans',
      ]
    : [
        'Segoe UI', 'Cambria Math', 'Nirmala UI', 'Leelawadee UI',
        'Aldhabi', 'HoloLens MDL2 Assets', 'Segoe Fluent Icons', 'Liberation Sans',
      ];

  try {
    await cdp.call('Page.enable', {});
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__marker = true;' });
    const injectionScript = buildInjectionScript(fp);
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: injectionScript });
    await cdp.call('Page.navigate', { url: origin + '/' });
    await sleep(2000);

    // Initial in-page probe before permission grant
    const probeScript = buildInPageProbe(declaredFamilies, foreignMarkers, subsetFamilies, missingFamilies);
    const inPageData = await cdp.value(probeScript);

    // Now grant localFonts permission via CDP and probe queryLocalFonts() with authorized context
    await cdp.call('Browser.grantPermissions', { origin, permissions: ['localFonts'] });
    const authQlfData = await cdp.value(`(async () => {
      try {
        const list = await window.queryLocalFonts();
        if (!Array.isArray(list)) return { ok: false, reason: 'not_array' };
        const f = list[0] || {};
        return {
          ok: true,
          count: list.length,
          families: list.map((x) => x.family),
          hasSegoe: list.some((x) => x.family === 'Segoe UI'),
          hasHelvetica: list.some((x) => x.family === 'Helvetica Neue'),
          sampleFirst: {
            family: f.family,
            fullName: f.fullName,
            postscriptName: f.postscriptName,
            style: f.style,
          },
          tag: Object.prototype.toString.call(f),
          ownKeys: Object.keys(f),
          ownNames: Object.getOwnPropertyNames(f),
          json: JSON.stringify(f),
        };
      } catch (e) {
        return { ok: false, errorName: e.name, errorMessage: e.message };
      }
    })()`);

    return {
      label,
      osKey,
      fp,
      declaredFamilies,
      foreignMarkers,
      subsetFamilies,
      missingFamilies,
      inPageData,
      authQlfData,
    };
  } finally {
    try { ws.close(); } catch (_) {}
    await stopChild(child, dir);
  }
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 kernel launcher available');
    console.log(`font-persona-consistency-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  // Calculate cross-platform audit metrics early
  const crossAudit = {};
  for (const platform of ['windows', 'macos', 'linux']) {
    const declared = OS_FONTS[platform] || [];
    const pSubsets = subsetIndex.platforms[platform] || {};
    const covered = [];
    const missing = [];
    for (const fam of declared) {
      if (pSubsets[fam]) covered.push(fam);
      else missing.push(fam);
    }
    crossAudit[platform] = {
      declaredCount: declared.length,
      coveredCount: covered.length,
      missingCount: missing.length,
      coveragePercent: (covered.length / declared.length) * 100,
      coveredList: covered,
      missingList: missing,
    };
  }

  const totalDeclared = crossAudit.windows.declaredCount + crossAudit.macos.declaredCount + crossAudit.linux.declaredCount;
  const totalCovered = crossAudit.windows.coveredCount + crossAudit.macos.coveredCount + crossAudit.linux.coveredCount;
  const totalMissing = crossAudit.windows.missingCount + crossAudit.macos.missingCount + crossAudit.linux.missingCount;

  // Spin up local HTTP fixture server
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root">font persona consistency</div></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;

  let win = null;
  let mac = null;

  try {
    console.log('Running real browser session: Windows persona...');
    win = await runPersonaE2E('win', WINDOWS_UA, 'Windows', serverPort);

    console.log('Running real browser session: macOS persona...');
    mac = await runPersonaE2E('mac', MAC_UA, 'macOS', serverPort);
  } finally {
    server.close();
  }

  console.log('\n======================================================================');
  console.log('                 FONT PERSONA CONSISTENCY AUDIT REPORT                ');
  console.log('======================================================================\n');

  // -------------------------------------------------------------------------
  // SECTION 1: Self-Proof & document.fonts Shielding
  // -------------------------------------------------------------------------
  check('window.__marker evaluates to true in both Windows and macOS personas', () => {
    assert.strictEqual(win.inPageData.marker, true, 'Windows persona must have window.__marker === true');
    assert.strictEqual(mac.inPageData.marker, true, 'macOS persona must have window.__marker === true');
  });

  check('document.fonts collection is shielded on blank page (size === 0, spread === 0)', () => {
    assert.strictEqual(win.inPageData.docFonts.size, 0, 'win document.fonts.size must be 0');
    assert.strictEqual(win.inPageData.docFonts.spreadLength, 0, 'win [...document.fonts].length must be 0');
    assert.strictEqual(mac.inPageData.docFonts.size, 0, 'mac document.fonts.size must be 0');
    assert.strictEqual(mac.inPageData.docFonts.spreadLength, 0, 'mac [...document.fonts].length must be 0');
  });

  check('Document.prototype.fonts getter retains native code appearance', () => {
    assert.strictEqual(win.inPageData.docFonts.getterToString, 'function get fonts() { [native code] }');
    assert.strictEqual(mac.inPageData.docFonts.getterToString, 'function get fonts() { [native code] }');
  });

  // -------------------------------------------------------------------------
  // SECTION 2: FontFace local() Persona Resolution & Foreign Marker Rejection
  // -------------------------------------------------------------------------
  check('all 60 declared Windows families resolve via FontFace local() in Windows persona', () => {
    const list = win.declaredFamilies;
    assert.strictEqual(list.length, 60, 'Windows persona must declare exactly 60 families');
    for (const fam of list) {
      const entry = win.inPageData.fontFaceLocal[fam];
      assert.ok(entry, `Entry for ${fam} must exist`);
      assert.strictEqual(entry.outcome, 'resolve', `${fam} must resolve on Windows persona, got ${entry.outcome}`);
      assert.strictEqual(entry.status, 'loaded', `${fam} status must be loaded`);
    }
  });

  check('all 76 declared macOS families resolve via FontFace local() in macOS persona', () => {
    const list = mac.declaredFamilies;
    assert.strictEqual(list.length, 76, 'macOS persona must declare exactly 76 families');
    for (const fam of list) {
      const entry = mac.inPageData.fontFaceLocal[fam];
      assert.ok(entry, `Entry for ${fam} must exist`);
      assert.strictEqual(entry.outcome, 'resolve', `${fam} must resolve on macOS persona, got ${entry.outcome}`);
      assert.strictEqual(entry.status, 'loaded', `${fam} status must be loaded`);
    }
  });

  check('stratified Windows buckets (version markers, exclusive, shared) resolve on Windows persona', () => {
    const versionMarkers = ['Segoe Fluent Icons', 'HoloLens MDL2 Assets', 'Aldhabi'];
    const exclusive = ['Segoe UI', 'Calibri', 'Consolas', 'Constantia', 'Corbel', 'Bahnschrift'];
    const shared = ['Arial', 'Times New Roman', 'Courier New', 'Georgia', 'Verdana'];

    for (const fam of [...versionMarkers, ...exclusive, ...shared]) {
      const entry = win.inPageData.fontFaceLocal[fam];
      assert.strictEqual(entry.outcome, 'resolve', `${fam} must resolve in stratified check`);
    }
  });

  check('stratified macOS buckets (version markers, exclusive, shared) resolve on macOS persona', () => {
    const versionMarkers = [
      'Noto Serif Yezidi Regular', 'Noto Sans Canadian Aboriginal Regular',
      'Apple SD Gothic Neo ExtraBold', 'Galvji', 'InaiMathi Bold',
      'Kohinoor Devanagari Medium', 'PingFang HK Light',
    ];
    const exclusive = ['Helvetica Neue', 'Menlo', 'Monaco', 'Geneva', 'Optima', 'Baskerville'];
    const shared = ['Arial', 'Times New Roman', 'Courier New', 'Georgia', 'Verdana'];

    for (const fam of [...versionMarkers, ...exclusive, ...shared]) {
      const entry = mac.inPageData.fontFaceLocal[fam];
      assert.strictEqual(entry.outcome, 'resolve', `${fam} must resolve in stratified check`);
    }
  });

  check('foreign markers reject with NetworkError on Windows persona', () => {
    for (const fam of win.foreignMarkers) {
      const entry = win.inPageData.fontFaceLocal[fam];
      assert.ok(entry, `Foreign entry for ${fam} must exist`);
      assert.strictEqual(entry.outcome, 'reject', `${fam} must reject on Windows persona, got ${entry.outcome}`);
      assert.strictEqual(entry.errName, 'NetworkError', `${fam} error must be NetworkError`);
    }
  });

  check('foreign markers reject with NetworkError on macOS persona', () => {
    for (const fam of mac.foreignMarkers) {
      const entry = mac.inPageData.fontFaceLocal[fam];
      assert.ok(entry, `Foreign entry for ${fam} must exist`);
      assert.strictEqual(entry.outcome, 'reject', `${fam} must reject on macOS persona, got ${entry.outcome}`);
      assert.strictEqual(entry.errName, 'NetworkError', `${fam} error must be NetworkError`);
    }
  });

  // -------------------------------------------------------------------------
  // SECTION 3: Operating System Release Version Marker Deduction
  // -------------------------------------------------------------------------
  check('release version marker table deduces a valid Windows platform release (not undefined)', () => {
    const detectedWinVer = evaluateWindowsRelease(win.inPageData.fontFaceLocal);
    assert.strictEqual(detectedWinVer, 'Windows 11',
      `Windows persona must deduce Windows 11 via Segoe Fluent Icons, got ${detectedWinVer}`);

    const foreignMacVer = evaluateMacosRelease(win.inPageData.fontFaceLocal);
    assert.strictEqual(foreignMacVer, undefined,
      `Windows persona must NOT match any macOS release markers, got ${foreignMacVer}`);
  });

  check('release version marker table deduces a valid macOS platform release (not undefined)', () => {
    const detectedMacVer = evaluateMacosRelease(mac.inPageData.fontFaceLocal);
    assert.strictEqual(detectedMacVer, 'macOS 14+ (Sonoma/Sequoia)',
      `macOS persona must deduce macOS 14+ via Noto Serif Yezidi Regular, got ${detectedMacVer}`);

    const foreignWinVer = evaluateWindowsRelease(mac.inPageData.fontFaceLocal);
    assert.strictEqual(foreignWinVer, undefined,
      `macOS persona must NOT match any Windows release markers, got ${foreignWinVer}`);
  });

  // -------------------------------------------------------------------------
  // SECTION 4: queryLocalFonts() SecurityError & Authorized List Shape
  // -------------------------------------------------------------------------
  check('queryLocalFonts() rejects with native SecurityError when unactivated', () => {
    const winUnauth = win.inPageData.queryLocalFontsUnauth;
    assert.strictEqual(winUnauth.status, 'rejected');
    assert.strictEqual(winUnauth.name, 'SecurityError');
    assert.ok(/User activation is required/i.test(winUnauth.message),
      `Expected User activation error message, got: ${winUnauth.message}`);

    const macUnauth = mac.inPageData.queryLocalFontsUnauth;
    assert.strictEqual(macUnauth.status, 'rejected');
    assert.strictEqual(macUnauth.name, 'SecurityError');
    assert.ok(/User activation is required/i.test(macUnauth.message),
      `Expected User activation error message, got: ${macUnauth.message}`);
  });

  check('authorized queryLocalFonts() returns aligned list shape for Windows persona', () => {
    const data = win.authQlfData;
    assert.strictEqual(data.ok, true, `Authorized queryLocalFonts must succeed: ${data.errorMessage}`);
    assert.strictEqual(data.count, 60, `Windows font list length must be 60, got ${data.count}`);
    assert.strictEqual(data.hasSegoe, true, 'Windows font list must include Segoe UI');
    assert.strictEqual(data.hasHelvetica, false, 'Windows font list must not include Helvetica Neue');

    // FontData prototype & property characteristics
    assert.strictEqual(data.tag, '[object FontData]', 'Brand tag must be [object FontData]');
    assert.deepStrictEqual(data.ownKeys, [], 'FontData must have no own enumerable keys');
    assert.deepStrictEqual(data.ownNames, [], 'FontData must have no own property names');
    assert.strictEqual(data.json, '{}', 'JSON.stringify(FontData) must produce "{}"');
    assert.strictEqual(data.sampleFirst.style, 'Regular', 'FontData.style normalized to Regular');
    assert.strictEqual(typeof data.sampleFirst.family, 'string', 'FontData.family is string');
    assert.strictEqual(typeof data.sampleFirst.postscriptName, 'string', 'FontData.postscriptName is string');
  });

  check('authorized queryLocalFonts() returns aligned list shape for macOS persona', () => {
    const data = mac.authQlfData;
    assert.strictEqual(data.ok, true, `Authorized queryLocalFonts must succeed: ${data.errorMessage}`);
    assert.strictEqual(data.count, 76, `macOS font list length must be 76, got ${data.count}`);
    assert.strictEqual(data.hasHelvetica, true, 'macOS font list must include Helvetica Neue');
    assert.strictEqual(data.hasSegoe, false, 'macOS font list must not include Segoe UI');

    assert.strictEqual(data.tag, '[object FontData]');
    assert.deepStrictEqual(data.ownKeys, []);
    assert.deepStrictEqual(data.ownNames, []);
    assert.strictEqual(data.json, '{}');
  });

  // -------------------------------------------------------------------------
  // SECTION 5: Canvas/DOM Non-Fallback vs Subset-Missing KNOWN GAPs
  // -------------------------------------------------------------------------
  check('canvas and DOM text measurement do not fall back for registered Windows font subsets', () => {
    // Exclude symbol/icon fonts lacking ASCII letters and monospace fonts whose advance equals monospace
    const nonProportionalOrSymbol = [
      'Marlett', 'Mongolian Baiti',
      'Segoe MDL2 Assets', 'HoloLens MDL2 Assets', 'Segoe Fluent Icons', 'Segoe UI Emoji',
      'Consolas', 'Courier New', 'Lucida Console',
    ];
    const textSubsets = win.subsetFamilies.filter((f) => !nonProportionalOrSymbol.includes(f));
    assert.ok(textSubsets.length >= 45, `Must test at least 45 Windows proportional text subsets, got ${textSubsets.length}`);
    for (const fam of textSubsets) {
      const c = win.inPageData.canvasMeasure[fam];
      assert.ok(c, `Canvas measurement for ${fam} must exist`);
      assert.strictEqual(c.noFallback, true,
        `Canvas measureText for subset font ${fam} must not fall back to monospace (w: ${c.width}, mono: ${c.monoWidth})`);

      const d = win.inPageData.domOffsetWidth[fam];
      assert.ok(d, `DOM measurement for ${fam} must exist`);
      assert.strictEqual(d.noFallback, true,
        `DOM offsetWidth for subset font ${fam} must not fall back to monospace (w: ${d.width}, mono: ${d.monoWidth})`);
    }
  });

  check('canvas and DOM text measurement do not fall back for registered macOS font subsets', () => {
    // Exclude non-latin script subsets without ASCII letters and monospace fonts whose advance matches generic monospace fallback
    const macMonospaceOrNonLatin = [
      'Courier', 'Courier New', 'Menlo', 'Monaco', 'Apple Color Emoji',
      'Noto Sans Canadian Aboriginal Regular', 'Noto Serif Yezidi Regular',
      'Noto Sans Gunjala Gondi Regular', 'Noto Sans Masaram Gondi Regular',
    ];
    const textSubsets = mac.subsetFamilies.filter((f) => !macMonospaceOrNonLatin.includes(f));
    assert.ok(textSubsets.length >= 65, `Must test at least 65 macOS proportional text subsets, got ${textSubsets.length}`);
    for (const fam of textSubsets) {
      const c = mac.inPageData.canvasMeasure[fam];
      assert.ok(c, `Canvas measurement for ${fam} must exist`);
      assert.strictEqual(c.noFallback, true,
        `Canvas measureText for subset font ${fam} must not fall back to monospace`);

      const d = mac.inPageData.domOffsetWidth[fam];
      assert.ok(d, `DOM measurement for ${fam} must exist`);
      assert.strictEqual(d.noFallback, true,
        `DOM offsetWidth for subset font ${fam} must not fall back to monospace`);
    }
  });

  check('KNOWN GAP: CJK probe text (永国中文测试) accurately falls back to monospace due to Latin/PUA subsetting', () => {
    // Windows CJK fonts
    for (const fam of ['Microsoft YaHei', 'SimSun']) {
      const c = win.inPageData.cjkMeasure[fam];
      assert.ok(c, `CJK canvas measurement for ${fam} must exist`);
      assert.strictEqual(c.noFallback, false,
        `KNOWN GAP: CJK probe on Windows font ${fam} must fall back to monospace (w: ${c.width}, mono: ${c.monoWidth})`);
    }
    // macOS CJK fonts
    for (const fam of ['PingFang SC', 'Hiragino Sans']) {
      const c = mac.inPageData.cjkMeasure[fam];
      assert.ok(c, `CJK canvas measurement for ${fam} must exist`);
      assert.strictEqual(c.noFallback, false,
        `KNOWN GAP: CJK probe on macOS font ${fam} must fall back to monospace (w: ${c.width}, mono: ${c.monoWidth})`);
    }
  });

  check('KNOWN GAP: platform families lacking font subsets are accurately quantified', () => {
    assert.strictEqual(win.missingFamilies.length, 0, 'Windows missing subsets count must equal 0 (100% covered)');
    assert.strictEqual(mac.missingFamilies.length, 0, 'macOS missing subsets count must equal 0 (100% covered)');
    assert.strictEqual(crossAudit.linux.missingCount, 9, 'Linux missing subsets count must equal 9');
    assert.strictEqual(totalMissing, 9, 'Total missing families count across all platforms must equal 9');
  });

  // -------------------------------------------------------------------------
  // SECTION 6: Full Cross-Platform Declaration vs Subset Index Metrics
  // -------------------------------------------------------------------------
  check('cross-platform audit accurately quantifies font coverage and KNOWN GAPs', () => {
    assert.strictEqual(crossAudit.windows.declaredCount, 60);
    assert.strictEqual(crossAudit.windows.coveredCount, 60);
    assert.strictEqual(crossAudit.windows.missingCount, 0);

    assert.strictEqual(crossAudit.macos.declaredCount, 76);
    assert.strictEqual(crossAudit.macos.coveredCount, 76);
    assert.strictEqual(crossAudit.macos.missingCount, 0);

    assert.strictEqual(crossAudit.linux.declaredCount, 33);
    assert.strictEqual(crossAudit.linux.coveredCount, 24);
    assert.strictEqual(crossAudit.linux.missingCount, 9);

    assert.strictEqual(totalDeclared, 169);
    assert.strictEqual(totalCovered, 160);
    assert.strictEqual(totalMissing, 9);
  });

  check('all registered font subset files referenced in index.json exist on disk', () => {
    const root = path.join(appRoot, 'assets', 'font-subsets');
    for (const [platform, fonts] of Object.entries(subsetIndex.platforms)) {
      for (const [fam, info] of Object.entries(fonts)) {
        const filePath = path.join(root, platform, info.file);
        assert.ok(fs.existsSync(filePath), `Font subset file must exist: ${filePath} (${fam})`);
      }
    }
  });

  // -------------------------------------------------------------------------
  // PRINT METRICS SUMMARY TABLE
  // -------------------------------------------------------------------------
  console.log('Platform Coverage Breakdown:');
  console.log('------------------------------------------------------------------------------');
  console.log('| Platform | Declared | Subset Registered | Missing (KNOWN GAP) | Coverage % |');
  console.log('------------------------------------------------------------------------------');
  for (const [p, stat] of Object.entries(crossAudit)) {
    console.log(`| ${p.padEnd(8)} | ${String(stat.declaredCount).padStart(8)} | ${String(stat.coveredCount).padStart(17)} | ${String(stat.missingCount).padStart(19)} | ${stat.coveragePercent.toFixed(2).padStart(9)}% |`);
  }
  console.log('------------------------------------------------------------------------------');
  console.log(`| TOTAL    | ${String(totalDeclared).padStart(8)} | ${String(totalCovered).padStart(17)} | ${String(totalMissing).padStart(19)} | ${((totalCovered / totalDeclared) * 100).toFixed(2).padStart(9)}% |`);
  console.log('------------------------------------------------------------------------------\n');

  console.log('Uncovered Families by Platform (KNOWN GAPs):');
  for (const [p, stat] of Object.entries(crossAudit)) {
    console.log(`\n  [${p.toUpperCase()}] (${stat.missingCount} families lacking physical subsets):`);
    console.log('    ' + stat.missingList.join(', '));
  }
  console.log('\n======================================================================\n');

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`font-persona-consistency-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`font-persona-consistency-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('font-persona-consistency-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
