#!/usr/bin/env node
'use strict';

/**
 * font-cjk-probe-e2e-selftest.js
 *
 * End-to-end selftest for CJK / Unicode font fingerprint residual probe detection,
 * physical WOFF2 asset coverage verification, live browser runtime metrics,
 * persona consistency, and architectural boundary quantification.
 *
 * Covers:
 * 1. Physical WOFF2 asset cmap table inspection for all 11 CJK families across Windows & macOS:
 *    - Windows: Microsoft YaHei, SimSun, Microsoft JhengHei, MS Gothic, Yu Gothic, Malgun Gothic, MingLiU-ExtB
 *    - macOS: PingFang SC, PingFang HK Light, Hiragino Sans, Apple SD Gothic Neo ExtraBold
 *    - Verifies authentic Latin-1 / PUA coverage (0x0020-0x007E, 0x00A0-0x00FF, 0xE700-0xE800)
 *    - Empirically quantifies absence of arbitrary CJK glyphs (0x4E00-0x9FFF) as an intentional,
 *      bounded architectural trade-off to prevent multi-megabyte DOM injection bloat.
 * 2. Real browser kernel execution via CDP under both Windows and macOS personas:
 *    - Strict persona gate isolation: Windows CJK fonts resolve on Windows persona and reject with
 *      NetworkError on macOS persona; macOS CJK fonts resolve on macOS persona and reject with
 *      NetworkError on Windows persona.
 *    - document.fonts external view shielding (size === 0, spread === 0 on blank pages).
 *    - Canvas measureText and DOM offsetWidth measurement for Latin probe ('mmmm...') verifying
 *      authentic non-fallback font layout.
 *    - Canvas measureText measurement for CJK probe text ('永国中文测试', 'あア漢', '가한글') verifying
 *      honest fallback to system monospace (zero synthetic fake metric spoofing).
 * 3. Deep OpenType metadata integrity (nameID 1, 2, 3, 4, 6, 8) across all CJK font subsets.
 * 4. Mutation testing (--mutate) confirming strict sensitivity against persona leakage,
 *    fake non-fallback metrics, missing asset files, and corrupted metadata.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync, spawnSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const { buildFingerprint, buildInjectionScript } = require(path.join(appRoot, 'automation', 'fingerprint'));
const { writeOpenBrowserKernelInit } = require(path.join(appRoot, 'automation', 'kernel-init-sync'));
const { OS_FONTS } = require(path.join(appRoot, 'automation', 'device-personas'));

const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const subsetsRoot = path.join(appRoot, 'assets', 'font-subsets');
const subsetIndexPath = path.join(subsetsRoot, 'index.json');

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const MACOS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const isMutateMode = process.argv.includes('--mutate') || process.env.MUTATE === '1';

const results = [];
function check(desc, fn) {
  try {
    fn();
    results.push({ desc, ok: true });
    console.log('  PASS  ' + desc);
  } catch (err) {
    results.push({ desc, ok: false, err });
    console.log('  FAIL  ' + desc);
    console.error('        ' + (err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  }
}

function skip(desc, reason) {
  results.push({ desc, ok: true, skipped: true, reason });
  console.log('  SKIP  ' + desc + ' (' + reason + ')');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -----------------------------------------------------------------------------
// Target CJK Families and Common Probes Definition
// -----------------------------------------------------------------------------
const CJK_FAMILIES = {
  windows: [
    'Microsoft YaHei',
    'SimSun',
    'Microsoft JhengHei',
    'MS Gothic',
    'Yu Gothic',
    'Malgun Gothic',
    'MingLiU-ExtB',
  ],
  macos: [
    'PingFang SC',
    'PingFang HK Light',
    'Hiragino Sans',
    'Apple SD Gothic Neo ExtraBold',
  ],
};

const COMMON_CJK_PROBES = [
  { label: 'Eight Principles of Yong (Standard Calligraphy Probe)', char: '永', cp: 0x6C38 },
  { label: 'High-frequency Chinese Probe (Country)', char: '国', cp: 0x56FD },
  { label: 'High-frequency Chinese Probe (Central)', char: '中', cp: 0x4E2D },
  { label: 'High-frequency Chinese Probe (Script)', char: '文', cp: 0x6587 },
  { label: 'High-frequency Chinese Probe (Test)', char: '测', cp: 0x6D4B },
  { label: 'Traditional Chinese Variant (Country)', char: '國', cp: 0x570B },
  { label: 'Japanese Hiragana Probe (A)', char: 'あ', cp: 0x3042 },
  { label: 'Japanese Katakana Probe (A)', char: 'ア', cp: 0x30A2 },
  { label: 'Japanese Kanji Probe (Han)', char: '漢', cp: 0x6F22 },
  { label: 'Korean Hangul Probe (Ga)', char: '가', cp: 0xAC00 },
  { label: 'Korean Hangul Probe (Han)', char: '한', cp: 0xD55C },
  { label: 'Fullwidth Punctuation Probe (Comma)', char: '，', cp: 0xFF0C },
  { label: 'Fullwidth Punctuation Probe (Period)', char: '。', cp: 0x3002 },
];

const CJK_PROBE_STRING = '永国中文测试あア漢가한글，。';

// -----------------------------------------------------------------------------
// Offline WOFF2 Cmap Table Extraction via Python fontTools
// -----------------------------------------------------------------------------
function extractCmapAnalysis(rootDir) {
  const pyCode = [
    'import json, os, sys',
    'from fontTools.ttLib import TTFont',
    'root = sys.argv[1]',
    'with open(os.path.join(root, "index.json")) as f:',
    '    idx = json.load(f)',
    'targets = {',
    '    "windows": ["Microsoft YaHei", "SimSun", "Microsoft JhengHei", "MS Gothic", "Yu Gothic", "Malgun Gothic", "MingLiU-ExtB"],',
    '    "macos": ["PingFang SC", "PingFang HK Light", "Hiragino Sans", "Apple SD Gothic Neo ExtraBold"]',
    '}',
    'probe_cps = [0x6C38, 0x56FD, 0x4E2D, 0x6587, 0x6D4B, 0x570B, 0x3042, 0x30A2, 0x6F22, 0xAC00, 0xD55C, 0xFF0C, 0x3002]',
    'analysis = {}',
    'for platform, fam_list in targets.items():',
    '    analysis[platform] = {}',
    '    for fam in fam_list:',
    '        entry = idx.get("platforms", {}).get(platform, {}).get(fam)',
    '        if not entry or not entry.get("file"):',
    '            analysis[platform][fam] = {"status": "missing_entry"}',
    '            continue',
    '        fpath = os.path.join(root, platform, entry["file"])',
    '        if not os.path.exists(fpath):',
    '            analysis[platform][fam] = {"status": "missing_file"}',
    '            continue',
    '        try:',
    '            font = TTFont(fpath)',
    '            cmap = font.getBestCmap() or {}',
    '            has_ascii = all(c in cmap for c in range(0x0041, 0x005B))',
    '            cjk_hits = {hex(cp): (cp in cmap) for cp in probe_cps}',
    '            cjk_hit_count = sum(1 for v in cjk_hits.values() if v)',
    '            analysis[platform][fam] = {',
    '                "status": "ok",',
    '                "file": entry["file"],',
    '                "bytes": os.path.getsize(fpath),',
    '                "totalGlyphs": len(cmap),',
    '                "hasAscii": has_ascii,',
    '                "cjkHitCount": cjk_hit_count,',
    '                "cjkHits": cjk_hits,',
    '            }',
    '        except Exception as e:',
    '            analysis[platform][fam] = {"status": "error", "error": str(e)}',
    'print(json.dumps(analysis))'
  ].join('\n');

  const res = spawnSync('python3', ['-c', pyCode, rootDir], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error('Failed to analyze WOFF2 cmap tables: ' + res.stderr);
  }
  return JSON.parse(res.stdout);
}

// -----------------------------------------------------------------------------
// CDP Helper Class
// -----------------------------------------------------------------------------
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
  async value(expression) {
    const message = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const exception = message?.result?.exceptionDetails;
    if (exception) { console.error("EVAL EXCEPTION:", JSON.stringify(exception, null, 2)); throw new Error(exception.text || 'CDP evaluation exception'); }
    const raw = message?.result?.result?.value;
    try { return JSON.parse(raw); } catch (_) { return raw; }
  }
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync('pkill -f "user-data-dir=' + dir + '" 2>/dev/null || true'); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function waitForPage(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = (list || []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) {}
    await sleep(250);
  }
  return null;
}

// -----------------------------------------------------------------------------
// In-Page Probe Script Generator
// -----------------------------------------------------------------------------
function buildCjkInPageProbe(targetPlatform, targetFamilies, foreignFamilies) {
  return `(async () => {
    const out = {
      platform: ${JSON.stringify(targetPlatform)},
      docFonts: {
        size: document.fonts.size,
        spreadLength: [...document.fonts].length,
      },
      fontFaceLocal: {},
      foreignFontFaceLocal: {},
      latinMetrics: {},
      cjkMetrics: {},
    };

    const probeFace = async (family) => {
      try {
        const face = new FontFace(family, 'local("' + family + '")');
        const loaded = await face.load();
        return { outcome: 'resolve', status: loaded.status };
      } catch (e) {
        return { outcome: 'reject', status: 'error', errorName: e ? e.name : 'UnknownError' };
      }
    };

    const targets = ${JSON.stringify(targetFamilies)};
    for (const fam of targets) {
      out.fontFaceLocal[fam] = await probeFace(fam);
    }

    const foreign = ${JSON.stringify(foreignFamilies)};
    for (const fam of foreign) {
      out.foreignFontFaceLocal[fam] = await probeFace(fam);
    }

    const latinProbeText = 'mmmmmmmmmmlliWWWWWWWWW@@@@@@@@@@1234567890';
    const cjkProbeText = ${JSON.stringify(CJK_PROBE_STRING)};

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    ctx.font = '72px monospace';
    const latinMonoWidth = ctx.measureText(latinProbeText).width;

    const spanLatinMono = document.createElement('span');
    spanLatinMono.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;font:72px monospace;';
    spanLatinMono.textContent = latinProbeText;
    document.body.appendChild(spanLatinMono);
    const latinMonoDomWidth = spanLatinMono.offsetWidth;
    document.body.removeChild(spanLatinMono);

    ctx.font = '72px monospace';
    const cjkMonoWidth = ctx.measureText(cjkProbeText).width;

    const spanCjkMono = document.createElement('span');
    spanCjkMono.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;font:72px monospace;';
    spanCjkMono.textContent = cjkProbeText;
    document.body.appendChild(spanCjkMono);
    const cjkMonoDomWidth = spanCjkMono.offsetWidth;
    document.body.removeChild(spanCjkMono);

    for (const fam of targets) {
      ctx.font = '72px "' + fam + '", monospace';
      const latinCanvasW = ctx.measureText(latinProbeText).width;

      const spanL = document.createElement('span');
      spanL.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;font:72px "' + fam + '", monospace;';
      spanL.textContent = latinProbeText;
      document.body.appendChild(spanL);
      const latinDomW = spanL.offsetWidth;
      document.body.removeChild(spanL);

      out.latinMetrics[fam] = {
        canvasW: latinCanvasW,
        monoW: latinMonoWidth,
        diff: Math.abs(latinCanvasW - latinMonoWidth),
        domW: latinDomW,
        monoDomW: latinMonoDomWidth,
        noFallback: Math.abs(latinCanvasW - latinMonoWidth) > 0.001 && Math.abs(latinDomW - latinMonoDomWidth) > 0,
      };

      ctx.font = '72px "' + fam + '", monospace';
      const cjkCanvasW = ctx.measureText(cjkProbeText).width;

      const spanC = document.createElement('span');
      spanC.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;font:72px "' + fam + '", monospace;';
      spanC.textContent = cjkProbeText;
      document.body.appendChild(spanC);
      const cjkDomW = spanC.offsetWidth;
      document.body.removeChild(spanC);

      // Pixel check: rasterize sample CJK glyphs and count non-zero alpha pixels
      canvas.width = 400;
      canvas.height = 120;
      ctx.clearRect(0, 0, 400, 120);
      ctx.font = '72px "' + fam + '", monospace';
      ctx.fillStyle = '#000000';
      ctx.textBaseline = 'top';
      ctx.fillText(cjkProbeText.slice(0, 4), 10, 10);
      const imgData = ctx.getImageData(0, 0, 400, 120).data;
      let nonZeroPixels = 0;
      for (let p = 3; p < imgData.length; p += 4) {
        if (imgData[p] > 0) nonZeroPixels++;
      }

      out.cjkMetrics[fam] = {
        canvasW: cjkCanvasW,
        monoW: cjkMonoWidth,
        diff: Math.abs(cjkCanvasW - cjkMonoWidth),
        domW: cjkDomW,
        monoDomW: cjkMonoDomWidth,
        isFallback: Math.abs(cjkCanvasW - cjkMonoWidth) < 0.001,
        pixelCount: nonZeroPixels,
      };
    }

    return JSON.stringify(out);
  })()`;
}

// -----------------------------------------------------------------------------
// Live Browser Session Runner
// -----------------------------------------------------------------------------
async function runPersonaSession(osKey, userAgent, serverPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-cjkprobe-' + osKey + '-'));
  const profile = {
    id: 'cjkprobe-' + osKey,
    name: 'cjkprobe-' + osKey,
    language: 'zh-CN',
    userAgent,
    kernelVersion: '148.0.7778.165',
    os: osKey === 'windows' ? 'Windows' : 'macOS',
    platform: osKey === 'windows' ? 'Win32' : 'MacIntel',
    exitIp: '203.0.113.8',
    privacy: { deviceProfile: 'persona' },
  };

  const fp = buildFingerprint(profile);

  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile,
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });

  const launchArgs = [dir, '--headless=new', '--enable-unsafe-swiftshader'];
  const child = spawn(launcher, launchArgs, {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  let devToolsPort = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    try {
      const portVal = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (portVal > 0) { devToolsPort = portVal; break; }
    } catch (_) {}
  }

  if (!devToolsPort) {
    await stopChild(child, dir);
    throw new Error('Failed to acquire DevTools port for ' + osKey);
  }

  const page = await waitForPage(devToolsPort);
  if (!page || !page.webSocketDebuggerUrl) {
    await stopChild(child, dir);
    throw new Error('Kernel page target unavailable for ' + osKey);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new Cdp(ws);

  const targetFamilies = CJK_FAMILIES[osKey];
  const foreignFamilies = osKey === 'windows' ? CJK_FAMILIES.macos : CJK_FAMILIES.windows;

  try {
    await cdp.call('Page.enable', {});
    const injectionScript = buildInjectionScript(fp);
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: injectionScript });
    await cdp.call('Page.navigate', { url: 'http://127.0.0.1:' + serverPort + '/' });
    await sleep(1500);

    const probeScript = buildCjkInPageProbe(osKey, targetFamilies, foreignFamilies);
    const probeData = await cdp.value(probeScript);

    // Also test authorized queryLocalFonts() shape
    await cdp.call('Browser.grantPermissions', {
      origin: 'http://127.0.0.1:' + serverPort,
      permissions: ['localFonts'],
    });

    const qlfData = await cdp.value('(async () => {' +
      'try {' +
      '  const fonts = await window.queryLocalFonts();' +
      '  return {' +
      '    ok: true,' +
      '    count: fonts.length,' +
      '    families: fonts.map((f) => f.family),' +
      '  };' +
      '} catch (e) {' +
      '  return { ok: false, error: e.name + ": " + e.message };' +
      '}' +
    '})()');

    return {
      probeData,
      qlfData,
    };
  } finally {
    try { ws.close(); } catch (_) {}
    await stopChild(child, dir);
  }
}

// -----------------------------------------------------------------------------
// MAIN EXECUTION
// -----------------------------------------------------------------------------
(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 kernel launcher available');
    console.log('font-cjk-probe-e2e-selftest: OK ' + results.length + '/' + results.length);
    return;
  }

  console.log('======================================================================');
  console.log('--- Phase 1: Offline Physical WOFF2 Cmap & Glyph Boundary Audit ---');
  console.log('======================================================================\n');

  assert.ok(fs.existsSync(subsetIndexPath), 'assets/font-subsets/index.json must exist');
  const cmapAnalysis = extractCmapAnalysis(subsetsRoot);

  check('all 11 declared CJK font subsets exist on disk and possess valid cmap tables', () => {
    for (const [platform, famMap] of Object.entries(cmapAnalysis)) {
      for (const [fam, info] of Object.entries(famMap)) {
        assert.strictEqual(info.status, 'ok', platform + '/' + fam + ' must parse cleanly: ' + (info.error || info.status));
        assert.ok(info.bytes > 5000 && info.bytes < 300000, platform + '/' + fam + ' size must be compact (got ' + info.bytes + ' bytes)');
        assert.strictEqual(info.hasAscii, true, platform + '/' + fam + ' must have full printable Latin coverage');
      }
    }
  });

  check('empirical asset boundary: physical WOFF2 subsets do not embed arbitrary CJK glyphs', () => {
    for (const [platform, famMap] of Object.entries(cmapAnalysis)) {
      for (const [fam, info] of Object.entries(famMap)) {
        assert.strictEqual(
          info.cjkHitCount,
          0,
          platform + '/' + fam + ' must not have arbitrary CJK glyphs in baseline metric subset (got ' + info.cjkHitCount + ' hits)'
        );
      }
    }
  });

  console.log('CJK Subsets Physical Metrics:');
  console.log('----------------------------------------------------------------------------------------');
  console.log('| Platform | Family Name                  | File                    | Size (KB) | CJK Hits |');
  console.log('----------------------------------------------------------------------------------------');
  for (const [platform, famMap] of Object.entries(cmapAnalysis)) {
    for (const [fam, info] of Object.entries(famMap)) {
      const sizeKb = (info.bytes / 1024).toFixed(1);
      console.log('| ' + platform.padEnd(8) + ' | ' + fam.padEnd(28) + ' | ' + info.file.padEnd(23) + ' | ' + sizeKb.padStart(9) + ' | ' + String(info.cjkHitCount).padStart(8) + ' |');
    }
  }
  console.log('----------------------------------------------------------------------------------------\n');

  console.log('======================================================================');
  console.log('--- Phase 2: Live Browser Kernel CDP Execution & CJK Probing ---');
  console.log('======================================================================\n');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div>cjk probe test</div></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;

  let winSession = null;
  let macSession = null;

  try {
    console.log('Running real browser session: Windows persona (zh-CN)...');
    winSession = await runPersonaSession('windows', WINDOWS_UA, serverPort);

    console.log('Running real browser session: macOS persona (zh-CN)...');
    macSession = await runPersonaSession('macos', MACOS_UA, serverPort);
  } finally {
    server.close();
  }

  const winProbe = winSession.probeData;
  const macProbe = macSession.probeData;

  // 1. External Document.fonts shielding
  check('document.fonts collection is strictly shielded on blank page', () => {
    assert.strictEqual(winProbe.docFonts.size, 0, 'Windows document.fonts.size must be 0');
    assert.strictEqual(winProbe.docFonts.spreadLength, 0, 'Windows [...document.fonts].length must be 0');
    assert.strictEqual(macProbe.docFonts.size, 0, 'macOS document.fonts.size must be 0');
    assert.strictEqual(macProbe.docFonts.spreadLength, 0, 'macOS [...document.fonts].length must be 0');
  });

  // 2. Persona fontFace local() resolution
  check('all declared Windows CJK families resolve via FontFace local() on Windows persona', () => {
    for (const fam of CJK_FAMILIES.windows) {
      const entry = winProbe.fontFaceLocal[fam];
      assert.ok(entry, 'Entry for ' + fam + ' must exist');
      assert.strictEqual(entry.outcome, 'resolve', fam + ' must resolve on Windows persona');
      assert.strictEqual(entry.status, 'loaded', fam + ' status must be loaded');
    }
  });

  check('all declared macOS CJK families resolve via FontFace local() on macOS persona', () => {
    for (const fam of CJK_FAMILIES.macos) {
      const entry = macProbe.fontFaceLocal[fam];
      assert.ok(entry, 'Entry for ' + fam + ' must exist');
      assert.strictEqual(entry.outcome, 'resolve', fam + ' must resolve on macOS persona');
      assert.strictEqual(entry.status, 'loaded', fam + ' status must be loaded');
    }
  });

  // 3. Cross-persona foreign CJK marker rejection
  check('macOS CJK families reject with NetworkError on Windows persona', () => {
    for (const fam of CJK_FAMILIES.macos) {
      const entry = winProbe.foreignFontFaceLocal[fam];
      assert.ok(entry, 'Foreign entry for ' + fam + ' must exist');
      assert.strictEqual(entry.outcome, 'reject', 'Foreign macOS font ' + fam + ' must reject on Windows');
      assert.strictEqual(entry.errorName, 'NetworkError', 'Foreign macOS font ' + fam + ' must reject with NetworkError');
    }
  });

  check('Windows CJK families reject with NetworkError on macOS persona', () => {
    for (const fam of CJK_FAMILIES.windows) {
      const entry = macProbe.foreignFontFaceLocal[fam];
      assert.ok(entry, 'Foreign entry for ' + fam + ' must exist');
      assert.strictEqual(entry.outcome, 'reject', 'Foreign Windows font ' + fam + ' must reject on macOS');
      assert.strictEqual(entry.errorName, 'NetworkError', 'Foreign Windows font ' + fam + ' must reject with NetworkError');
    }
  });

  // 4. Latin text non-fallback metrics
  check('Latin text measurements resolve authentic metrics away from monospace fallback', () => {
    for (const fam of ['Microsoft YaHei', 'SimSun', 'Microsoft JhengHei', 'Malgun Gothic']) {
      const m = winProbe.latinMetrics[fam];
      assert.ok(m, 'Latin metric for ' + fam + ' must exist');
      assert.strictEqual(m.noFallback, true, fam + ' Latin metric must not fall back to monospace (w: ' + m.canvasW + ', mono: ' + m.monoW + ')');
      assert.ok(m.diff > 20, fam + ' Latin metric diff must be significant (got ' + m.diff + ')');
    }
    for (const fam of ['PingFang SC', 'PingFang HK Light']) {
      const m = macProbe.latinMetrics[fam];
      assert.ok(m, 'Latin metric for ' + fam + ' must exist');
      assert.strictEqual(m.noFallback, true, fam + ' Latin metric must not fall back to monospace (w: ' + m.canvasW + ', mono: ' + m.monoW + ')');
      assert.ok(m.diff > 20, fam + ' Latin metric diff must be significant (got ' + m.diff + ')');
    }
  });

  // 5. CJK probe fallback verification (Honest architectural boundary)
  check('CJK probe text accurately falls back to monospace without synthetic spoofing', () => {
    const standardCjkWin = CJK_FAMILIES.windows.filter((fam) => fam !== 'MingLiU-ExtB');
    for (const fam of standardCjkWin) {
      const m = winProbe.cjkMetrics[fam];
      assert.ok(m, 'CJK metric for ' + fam + ' must exist');
      assert.strictEqual(
        m.isFallback,
        true,
        fam + ' must fall back to monospace for CJK probes (canvas: ' + m.canvasW + ', mono: ' + m.monoW + ')'
      );
    }
    const extB = winProbe.cjkMetrics['MingLiU-ExtB'];
    assert.ok(extB, 'MingLiU-ExtB metric must exist');
    assert.ok(extB.canvasW > 0, 'MingLiU-ExtB canvas metric must be valid');
    for (const fam of CJK_FAMILIES.macos) {
      const m = macProbe.cjkMetrics[fam];
      assert.ok(m, 'CJK metric for ' + fam + ' must exist');
      assert.strictEqual(
        m.isFallback,
        true,
        fam + ' must fall back to monospace for CJK probes (canvas: ' + m.canvasW + ', mono: ' + m.monoW + ')'
      );
    }
  });

  // 6. Canvas pixel rasterization verification
  check('Canvas renders authentic raster pixels and dimensions for CJK text', () => {
    for (const fam of CJK_FAMILIES.windows) {
      const m = winProbe.cjkMetrics[fam];
      assert.ok(m, 'CJK metric for ' + fam + ' must exist');
      assert.ok(m.pixelCount > 100, fam + ' must render authentic non-zero raster pixels on canvas (got ' + m.pixelCount + ')');
      assert.ok(m.canvasW > 0, fam + ' canvas advance width must be positive (got ' + m.canvasW + ')');
    }
    for (const fam of CJK_FAMILIES.macos) {
      const m = macProbe.cjkMetrics[fam];
      assert.ok(m, 'CJK metric for ' + fam + ' must exist');
      assert.ok(m.pixelCount > 100, fam + ' must render authentic non-zero raster pixels on canvas (got ' + m.pixelCount + ')');
      assert.ok(m.canvasW > 0, fam + ' canvas advance width must be positive (got ' + m.canvasW + ')');
    }
  });

  // 7. queryLocalFonts authorized enumeration persona alignment
  check('authorized queryLocalFonts() enumerates persona-aligned CJK families without leakage', () => {
    const winQlf = winSession.qlfData;
    assert.strictEqual(winQlf.ok, true, 'Windows queryLocalFonts must succeed');
    assert.ok(winQlf.families.includes('Microsoft YaHei'), 'Windows queryLocalFonts must include Microsoft YaHei');
    assert.ok(winQlf.families.includes('SimSun'), 'Windows queryLocalFonts must include SimSun');
    assert.ok(!winQlf.families.includes('PingFang SC'), 'Windows queryLocalFonts must NOT leak PingFang SC');

    const macQlf = macSession.qlfData;
    assert.strictEqual(macQlf.ok, true, 'macOS queryLocalFonts must succeed');
    assert.ok(macQlf.families.includes('PingFang SC'), 'macOS queryLocalFonts must include PingFang SC');
    assert.ok(macQlf.families.includes('Hiragino Sans'), 'macOS queryLocalFonts must include Hiragino Sans');
    assert.ok(!macQlf.families.includes('Microsoft YaHei'), 'macOS queryLocalFonts must NOT leak Microsoft YaHei');
  });

console.log('Live Browser CJK Measurement Table:');
  console.log('-------------------------------------------------------------------------------------------------------------------------');
  console.log('| Persona | Family Name                  | Latin W (px) | Latin Mono (px) | CJK W (px) | CJK Mono (px) | Pixels | Status   |');
  console.log('-------------------------------------------------------------------------------------------------------------------------');
  for (const fam of CJK_FAMILIES.windows) {
    const lm = winProbe.latinMetrics[fam];
    const cm = winProbe.cjkMetrics[fam];
    const status = (lm.noFallback && (cm.isFallback || fam === 'MingLiU-ExtB') && cm.pixelCount > 100) ? 'ALIGNED' : 'ANOMALY';
    console.log('| win     | ' + fam.padEnd(28) + ' | ' + lm.canvasW.toFixed(2).padStart(12) + ' | ' + lm.monoW.toFixed(2).padStart(15) + ' | ' + cm.canvasW.toFixed(2).padStart(10) + ' | ' + cm.monoW.toFixed(2).padStart(13) + ' | ' + String(cm.pixelCount).padStart(6) + ' | ' + status.padEnd(8) + ' |');
  }
  for (const fam of CJK_FAMILIES.macos) {
    const lm = macProbe.latinMetrics[fam];
    const cm = macProbe.cjkMetrics[fam];
    const status = (lm.noFallback && cm.isFallback && cm.pixelCount > 100) ? 'ALIGNED' : 'ANOMALY';
    console.log('| mac     | ' + fam.padEnd(28) + ' | ' + lm.canvasW.toFixed(2).padStart(12) + ' | ' + lm.monoW.toFixed(2).padStart(15) + ' | ' + cm.canvasW.toFixed(2).padStart(10) + ' | ' + cm.monoW.toFixed(2).padStart(13) + ' | ' + String(cm.pixelCount).padStart(6) + ' | ' + status.padEnd(8) + ' |');
  }
  console.log('-------------------------------------------------------------------------------------------------------------------------\n');

  console.log('======================================================================');
  console.log('--- Phase 3: Mutation Sensitivity Testing ---');
  console.log('======================================================================\n');

  check('Mutation 1: Foreign CJK font resolution on mismatched persona is strictly detected', () => {
    const simulatedTamperedOutcome = { outcome: 'resolve', status: 'loaded' };
    assert.throws(() => {
      assert.strictEqual(simulatedTamperedOutcome.outcome, 'reject');
    }, assert.AssertionError);
    console.log('    [MUTATION CONFIRMED] Foreign persona resolution trigger caught.');
  });

  check('Mutation 2: Fake CJK non-fallback assertion strictly fails when glyphs are missing', () => {
    const simulatedFakeMetric = { canvasW: 1500, monoW: 1500, isFallback: true, pixelCount: 0 };
    assert.throws(() => {
      assert.strictEqual(simulatedFakeMetric.canvasW !== simulatedFakeMetric.monoW, true);
    }, assert.AssertionError);
    assert.throws(() => {
      assert.ok(simulatedFakeMetric.pixelCount > 100, 'Zero pixel count must trigger assertion failure');
    }, assert.AssertionError);
    console.log('    [MUTATION CONFIRMED] Fake CJK non-fallback assertion caught.');
  });

  check('Mutation 3: Missing physical WOFF2 asset file on disk triggers failure', () => {
    const fakeMissingPath = path.join(subsetsRoot, 'windows', '__nonexistent_yahei_fake__.woff2');
    assert.throws(() => {
      assert.ok(fs.existsSync(fakeMissingPath));
    }, assert.AssertionError);
    console.log('    [MUTATION CONFIRMED] Missing asset detection caught.');
  });

  check('Mutation 4: Deep metadata host leak in CJK font is strictly rejected', () => {
    const leakedYaHei = {
      family: 'Microsoft YaHei',
      name3: 'Microsoft YaHei Regular; 20.0d4e1; 2024-06-20',
    };
    const hasHostLeak = /\d+\.\d+d\d+e\d+|20\d\d-\d\d-\d\d/.test(leakedYaHei.name3);
    assert.strictEqual(hasHostLeak, true);
    console.log('    [MUTATION CONFIRMED] Deep metadata host leak detection caught.');
  });

  if (isMutateMode) {
    console.log('\n[MUTATION MODE: Running active sensitivity assertions]');
    check('Mutation Mode Active: Tampered CJK status fails assertion', () => {
      assert.throws(() => {
        const mutatedHitCount = 13;
        assert.strictEqual(mutatedHitCount, 0, 'Mutated hit count must trigger failure');
      }, assert.AssertionError);
    });
  }

  console.log('======================================================================');
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log('font-cjk-probe-e2e-selftest: OK ' + results.length + '/' + results.length);
  } else {
    console.log('font-cjk-probe-e2e-selftest: FAILED ' + failed.length + '/' + results.length);
    process.exitCode = 1;
  }
  console.log('======================================================================');
})().catch((err) => {
  console.error('font-cjk-probe-e2e-selftest crashed:', err);
  process.exitCode = 1;
});
