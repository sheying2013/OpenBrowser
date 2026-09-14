#!/usr/bin/env node
'use strict';

/**
 * font-deep-metadata-e2e-selftest.js
 *
 * Comprehensive end-to-end and offline verification for:
 * 1. Deep OpenType name table records (nameID 3 Unique ID, nameID 8 Manufacturer)
 *    across all 170 declared font subsets (macOS 76, Windows 60, Linux 24, Android 10).
 * 2. Absolute absence of host build artifacts, timestamps, and foreign foundry annotations.
 * 3. Strict alignment of deep metadata with primary name records (nameID 1, 2, 4, 6).
 * 4. Real browser kernel execution via CDP: authentic FontData.blob() resolution and
 *    successful FontFace.load() decoding.
 * 5. Mutation testing to ensure sensitivity against metadata leakage and corruption.
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
const { buildQueryLocalFontBlobGateSource } = require(path.join(appRoot, 'automation', 'query-local-font-blob-gate'));

const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const subsetsRoot = path.join(appRoot, 'assets', 'font-subsets');
const subsetIndexPath = path.join(subsetsRoot, 'index.json');

const MACOS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const results = [];
const isMutateMode = process.argv.includes('--mutate') || process.env.MUTATE === '1';

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

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, timer } = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(timer);
        resolve(message);
        return;
      }
      if (message.method) {
        this.events.push(message);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: `CDP timeout: ${method}` } });
      }, 30000);
      this.pending.set(id, { resolve, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }
}

// -----------------------------------------------------------------------------
// Offline Metadata Extraction via Python fontTools
// -----------------------------------------------------------------------------
function extractAllFontMetadata(rootDir) {
  const pyScript = `
import json, os, sys
from fontTools.ttLib import TTFont

root = sys.argv[1]
with open(os.path.join(root, "index.json")) as f:
    idx = json.load(f)

results = []
for platform in ["macos", "windows", "android", "linux"]:
    fonts = idx.get("platforms", {}).get(platform, {})
    for family, entry in fonts.items():
        fname = entry.get("file")
        if not fname:
            continue
        fpath = os.path.join(root, platform, fname)
        if not os.path.exists(fpath):
            results.append({"platform": platform, "family": family, "file": fname, "error": "file_missing"})
            continue
        try:
            font = TTFont(fpath)
            names_by_id = {}
            raw_records = []
            for r in font.get("name", {}).names:
                try:
                    val = r.toUnicode()
                except Exception:
                    val = str(r.string)
                names_by_id.setdefault(r.nameID, []).append(val)
                raw_records.append({"nameID": r.nameID, "platformID": r.platformID, "value": val})

            results.append({
                "platform": platform,
                "family": family,
                "file": fname,
                "size": os.path.getsize(fpath),
                "name1": names_by_id.get(1, [""])[0],
                "name2": names_by_id.get(2, [""])[0],
                "name3": names_by_id.get(3, [""])[0],
                "name4": names_by_id.get(4, [""])[0],
                "name5": names_by_id.get(5, [""])[0],
                "name6": names_by_id.get(6, [""])[0],
                "name8": names_by_id.get(8, [""])[0],
                "allRecords": raw_records,
            })
        except Exception as e:
            results.append({"platform": platform, "family": family, "file": fname, "error": str(e)})

print(json.dumps(results))
`;

  const res = spawnSync('python3', ['-c', pyScript, rootDir], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error('Failed to extract font metadata: ' + res.stderr);
  }
  return JSON.parse(res.stdout);
}

// -----------------------------------------------------------------------------
// Test HTTP Server
// -----------------------------------------------------------------------------
async function startServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!DOCTYPE html>
<html>
<head><title>Deep Metadata Font Blob Selftest</title></head>
<body>
<button id="btn" style="position:absolute;left:0;top:0;width:200px;height:100px;">Request Fonts</button>
<script>
  window.__marker = true;
  window.__clicked = false;
  window.__res = null;
  window.__pageErrors = [];
  window.addEventListener('error', (e) => window.__pageErrors.push(e.message || String(e)));
  window.addEventListener('unhandledrejection', (e) => window.__pageErrors.push(e.reason && (e.reason.message || e.reason.stack) || String(e.reason)));

  const btn = document.getElementById('btn');
  btn.addEventListener('click', async () => {
    window.__clicked = true;
    try {
      const fonts = await queryLocalFonts();
      const sampleTargets = [
        'PingFang SC',
        'PingFang HK Light',
        'Menlo',
        'Arial',
        'Helvetica',
        'Times',
        'American Typewriter',
        'Futura Bold',
        'Monaco',
        'Courier',
        'Geneva',
        'Zapfino',
        'Avenir',
        'Chalkboard',
      ];

      const items = [];
      for (const target of sampleTargets) {
        const f = fonts.find((x) => x.family === target);
        if (!f) continue;

        let blob = null;
        let blobSize = 0;
        let blobType = '';
        let headHex = '';
        let magicHex = '';
        let hash = '';
        let fontFaceOk = false;
        let fontFaceError = '';

        try {
          blob = await f.blob();
          blobSize = blob.size;
          blobType = blob.type;
          const buf = await blob.arrayBuffer();
          const u8 = new Uint8Array(buf);
          headHex = Array.from(u8.subarray(0, 16)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
          magicHex = Array.from(u8.subarray(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join(' ');

          const digest = await crypto.subtle.digest('SHA-256', buf);
          hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');

          try {
            const face = new FontFace('DeepMeta_' + f.postscriptName, buf);
            await face.load();
            fontFaceOk = (face.status === 'loaded');
          } catch (loadErr) {
            fontFaceError = loadErr ? loadErr.message : String(loadErr);
          }
        } catch (blobErr) {
          fontFaceError = 'blob_error: ' + (blobErr ? blobErr.message : String(blobErr));
        }

        items.push({
          family: f.family,
          fullName: f.fullName,
          postscriptName: f.postscriptName,
          blobSize,
          blobType,
          headHex,
          magicHex,
          hash,
          fontFaceOk,
          fontFaceError,
        });
      }

      window.__res = {
        totalCount: fonts.length,
        items,
      };
    } catch (e) {
      window.__res = { error: e.name + ': ' + e.message, stack: e.stack };
    }
  });
</script>
</body>
</html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, port };
}

// -----------------------------------------------------------------------------
// Live CDP Session Runner
// -----------------------------------------------------------------------------
async function runCdpSession({ serverPort }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-font-deepmeta-'));
  const profile = {
    id: 'font-deepmeta-macos',
    name: 'font-deepmeta-macos',
    language: 'en-US',
    userAgent: MACOS_UA,
    kernelVersion: '148.0.7778.165',
    os: 'macOS',
    platform: 'MacIntel',
    exitIp: '203.0.113.7',
    privacy: { deviceProfile: 'persona' },
  };

  const fp = buildFingerprint(profile);

  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile,
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });

  const launchArgs = [dir, '--headless=new'];
  const child = spawn(launcher, launchArgs, {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  let devToolsPort = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(400);
    try {
      const portVal = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (portVal > 0) {
        devToolsPort = portVal;
        break;
      }
    } catch (_) {}
  }

  if (!devToolsPort) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    return { error: 'Failed to obtain DevTools port' };
  }

  let ws = null;
  try {
    const ver = await (await fetch(`http://127.0.0.1:${devToolsPort}/json/version`)).json();
    ws = new globalThis.WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('CDP WebSocket connect failed'));
    });
    const cdp = new Cdp(ws);

    const targets = await cdp.send('Target.getTargets');
    const pageTarget = ((targets.result || {}).targetInfos || []).find((t) => t.type === 'page');
    if (!pageTarget) {
      throw new Error('No page target found');
    }

    const attachRes = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    const sessionId = attachRes?.result?.sessionId;
    if (!sessionId) {
      throw new Error('Failed to attach to page target');
    }

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    // Apply baseline fingerprint injection
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: buildInjectionScript(fp),
    }, sessionId);

    // Apply local font blob gate
    const gateSource = buildQueryLocalFontBlobGateSource(fp);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: gateSource,
    }, sessionId);

    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + serverPort + '/' }, sessionId);
    await sleep(1500);

    await cdp.send('Browser.grantPermissions', {
      permissions: ['localFonts'],
      origin: 'http://127.0.0.1:' + serverPort,
    });

    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 50 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 50, button: 'left', clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 50, button: 'left', clickCount: 1 }, sessionId);

    let probe = null;
    let clicked = false;
    let pageErrors = [];
    const deadline = Date.now() + 10000;

    while (Date.now() < deadline) {
      const clickCheck = await cdp.send('Runtime.evaluate', {
        expression: 'window.__clicked',
        returnByValue: true,
      }, sessionId);
      clicked = Boolean(clickCheck?.result?.result?.value);

      const evalRes = await cdp.send('Runtime.evaluate', {
        expression: 'window.__res',
        returnByValue: true,
      }, sessionId);
      probe = evalRes?.result?.result?.value;

      const errCheck = await cdp.send('Runtime.evaluate', {
        expression: 'window.__pageErrors || []',
        returnByValue: true,
      }, sessionId);
      pageErrors = errCheck?.result?.result?.value || [];

      if (probe !== null && probe !== undefined) {
        break;
      }
      await sleep(100);
    }

    return {
      clicked,
      probe,
      pageErrors,
    };
  } finally {
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
  }
}

// -----------------------------------------------------------------------------
// Deep Metadata Validation Helper
// -----------------------------------------------------------------------------
function validateDeepMetadata(item) {
  const { family, name1, name2, name3, name4, name6, name8 } = item;

  // Primary name checks
  if (name1 !== family) {
    return { ok: false, field: 'nameID 1', reason: `Expected nameID 1 "${family}", got "${name1}"` };
  }
  if (name2 !== 'Regular') {
    return { ok: false, field: 'nameID 2', reason: `Expected nameID 2 "Regular", got "${name2}"` };
  }
  if (!name4 || (!name4.includes(family) && !family.includes(name4))) {
    return { ok: false, field: 'nameID 4', reason: `Expected nameID 4 to contain "${family}", got "${name4}"` };
  }
  if (!name6) {
    return { ok: false, field: 'nameID 6', reason: `Missing nameID 6 for "${family}"` };
  }

  // Deep metadata nameID 3 (Unique identifier)
  if (!name3) {
    return { ok: false, field: 'nameID 3', reason: `Missing nameID 3 for "${family}"` };
  }
  if (!name3.includes(family) && !family.includes(name3)) {
    return { ok: false, field: 'nameID 3', reason: `nameID 3 "${name3}" does not align with family "${family}"` };
  }
  // Host OS build markers: e.g. 16.0d2e4, 20.0d4e1, 21.0d1e6
  if (/\d+\.\d+d\d+e\d+/i.test(name3)) {
    return { ok: false, field: 'nameID 3', reason: `nameID 3 "${name3}" leaks host OS build marker` };
  }
  // Host build date markers: e.g. 2020-07-06, 2024-06-20
  if (/\b20\d\d-\d\d-\d\d\b/.test(name3)) {
    return { ok: false, field: 'nameID 3', reason: `nameID 3 "${name3}" leaks build timestamp/date` };
  }
  // Cross-font alias leaks:
  const aliasLeaks = [
    { target: 'Droid Sans', forbidden: 'roboto' },
    { target: 'HoloLens MDL2 Assets', forbidden: 'segoe' },
    { target: 'Nirmala UI', forbidden: 'segoe' },
    { target: 'Carrois Gothic', forbidden: 'sc-regular' },
    { target: 'Sitka', forbidden: 'sitkatext' },
  ];
  for (const { target, forbidden } of aliasLeaks) {
    if (family === target && name3.toLowerCase().includes(forbidden)) {
      return { ok: false, field: 'nameID 3', reason: `nameID 3 "${name3}" leaks underlying alias "${forbidden}"` };
    }
  }
  // Host foundry / tool prefixes
  const badPrefixes = ['monotype:', 'b&h', 'pyrs', 'ascender', 'newt', 'dama', 'urw:', 'gnu:', 'fontforge', 'sil international:'];
  for (const bp of badPrefixes) {
    if (name3.toLowerCase().startsWith(bp)) {
      return { ok: false, field: 'nameID 3', reason: `nameID 3 "${name3}" starts with foreign foundry prefix "${bp}"` };
    }
  }

  // Deep metadata nameID 8 (Manufacturer)
  if (!name8) {
    return { ok: false, field: 'nameID 8', reason: `Missing nameID 8 for "${family}"` };
  }
  if (name8 !== family) {
    return { ok: false, field: 'nameID 8', reason: `nameID 8 "${name8}" does not equal family "${family}"` };
  }
  const foreignFoundries = [
    'the monotype corporation', 'monotype imaging inc.', 'linotype gmbh',
    'screen graphic solutions', 'dynacomware', 'canada type', 'bitstream',
    'sandoll', 'international typefounders', 'carter & cone', 'murasu systems',
    'indian type foundry', 'ek type', 'tiro typeworks', 'house industries',
    'james grieshaber', 'ralph du carrois',
  ];
  for (const ff of foreignFoundries) {
    if (name8.toLowerCase().includes(ff)) {
      return { ok: false, field: 'nameID 8', reason: `nameID 8 "${name8}" contains foreign foundry string "${ff}"` };
    }
  }

  return { ok: true };
}

// -----------------------------------------------------------------------------
// Main Execution Flow
// -----------------------------------------------------------------------------
(async () => {
  console.log('==================================================================');
  console.log('--- Phase 1: WOFF2 Deep Metadata Offline Audit (All 170 Subsets) ---');
  console.log('==================================================================');

  assert.ok(fs.existsSync(subsetIndexPath), 'index.json must exist');
  const fontIndex = JSON.parse(fs.readFileSync(subsetIndexPath, 'utf8'));
  const allSubsets = extractAllFontMetadata(subsetsRoot);

  check('Index declares exactly 170 font subsets across 4 platforms', () => {
    const total = Object.values(fontIndex.platforms).reduce((sum, p) => sum + Object.keys(p).length, 0);
    assert.strictEqual(total, 170, `Expected 170 fonts in index.json, got ${total}`);
    assert.strictEqual(allSubsets.length, 170, `Expected 170 extracted font subsets, got ${allSubsets.length}`);
  });

  check('All 170 WOFF2 assets exist on disk with valid wOF2 magic header (0x774f4632)', () => {
    for (const item of allSubsets) {
      assert.ok(!item.error, `Font ${item.platform}/${item.family} error: ${item.error}`);
      assert.ok(item.size > 0, `Font ${item.platform}/${item.family} size must be > 0`);
      const fullPath = path.join(subsetsRoot, item.platform, item.file);
      const header = fs.readFileSync(fullPath, { flag: 'r' }).subarray(0, 4).toString('ascii');
      assert.strictEqual(header, 'wOF2', `Font ${item.platform}/${item.family} magic header must be wOF2`);
    }
  });

  check('Primary name records (nameID 1, 2, 4, 6) strictly match declared family', () => {
    for (const item of allSubsets) {
      assert.strictEqual(item.name1, item.family, `nameID 1 mismatch for ${item.family}`);
      assert.strictEqual(item.name2, 'Regular', `nameID 2 mismatch for ${item.family}`);
      assert.ok(
        item.name4.includes(item.family) || item.family.includes(item.name4),
        `nameID 4 mismatch for ${item.family}: ${item.name4}`
      );
      assert.ok(item.name6 && item.name6.length > 0, `nameID 6 missing for ${item.family}`);
    }
  });

  check('Deep metadata nameID 3 is family-aligned and free of host build strings', () => {
    for (const item of allSubsets) {
      const res = validateDeepMetadata(item);
      assert.ok(res.ok, `Validation failed for ${item.platform}/${item.family} (${res.field}): ${res.reason}`);
    }
  });

  check('Deep metadata nameID 8 is family-aligned and free of foreign foundry annotations', () => {
    for (const item of allSubsets) {
      assert.strictEqual(item.name8, item.family, `nameID 8 for ${item.family} must be "${item.family}", got "${item.name8}"`);
    }
  });

  check('Zero extraneous leaky records (e.g. external vendor URLs or host paths)', () => {
    for (const item of allSubsets) {
      for (const rec of item.allRecords) {
        assert.ok(!rec.value.startsWith('http://') && !rec.value.startsWith('https://'),
          `Font ${item.family} contains URL in name record: ${rec.value}`);
      }
    }
  });

  console.log('\n[Sampled Deep OpenType Name Records Across Platforms]');
  console.log('  ' + 'Platform/Family'.padEnd(35) + 'nameID 1'.padEnd(25) + 'nameID 3'.padEnd(30) + 'nameID 8');
  console.log('  ' + '-'.repeat(110));
  const sampleSelection = [
    'PingFang SC', 'PingFang HK Light', 'American Typewriter', 'Arial',
    'Segoe UI', 'HoloLens MDL2 Assets', 'Nirmala UI', 'SimSun', 'Sitka',
    'Droid Sans', 'Carrois Gothic', 'Noto Sans', 'Ubuntu', 'FreeSans'
  ];
  for (const name of sampleSelection) {
    const s = allSubsets.find((x) => x.family === name);
    if (s) {
      console.log('  ' + `${s.platform}/${s.family}`.padEnd(35) + s.name1.padEnd(25) + s.name3.padEnd(30) + s.name8);
    }
  }

  console.log('\n==================================================================');
  console.log('--- Phase 2: Live Browser Kernel CDP Execution & FontFace.load() ---');
  console.log('==================================================================');

  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('Real kernel CDP test', 'Requires macOS kernel launcher');
  } else {
    const { server, port } = await startServer();
    let session = null;
    try {
      session = await runCdpSession({ serverPort: port });
    } finally {
      server.close();
    }

    const { clicked, probe } = session;
    assert.ok(probe, 'CDP session probe must return results');

    check('User activation via CDP click successfully enumerates fonts', () => {
      assert.strictEqual(clicked, true);
      assert.ok(probe.totalCount > 0, `Expected fonts, got ${probe.totalCount}`);
    });

    check('Live browser FontData.blob() returns authentic SFNT loadable via FontFace', () => {
      assert.ok(probe.items.length >= 10, `Expected at least 10 sampled items, got ${probe.items.length}`);
      for (const item of probe.items) {
        assert.strictEqual(item.blobType, '', `${item.family} blob type must be the native empty string`);
        assert.ok(['00 01 00 00', '4f 54 54 4f', '74 74 63 66'].includes(item.magicHex), `${item.family} must have an SFNT family header, got ${item.magicHex}`);
        assert.strictEqual(item.fontFaceOk, true, `${item.family} FontFace.load() failed: ${item.fontFaceError}`);
      }
    });

    check('Live browser font blob hashes match the served physical asset on disk (SFNT preferred)', () => {
      for (const item of probe.items) {
        const matchingAsset = allSubsets.find((s) => s.family === item.family);
        assert.ok(matchingAsset, `Missing matching asset for ${item.family}`);
        // The blob gate serves the SFNT sibling (.ttf/.otf) when present and only falls
        // back to the WOFF2 subset for CSS-only assets. Hash the same file the page received.
        const baseName = matchingAsset.file.replace(/\.woff2$/i, '');
        const candidates = ['.ttf', '.otf', '.woff2'].map((ext) => path.join(subsetsRoot, matchingAsset.platform, baseName + ext));
        const assetPath = candidates.find((c) => fs.existsSync(c));
        assert.ok(assetPath, `Missing served asset for ${item.family}`);
        const diskBuf = fs.readFileSync(assetPath);
        const crypto = require('crypto');
        const diskHash = crypto.createHash('sha256').update(diskBuf).digest('hex');
        assert.strictEqual(item.hash, diskHash, `Hash mismatch for ${item.family}: browser=${item.hash}, disk=${diskHash}`);
      }
    });
  }

  console.log('\n==================================================================');
  console.log('--- Phase 3: Mutation Sensitivity Testing ---');
  console.log('==================================================================');

  check('Mutation 1: Host OS build marker in nameID 3 is strictly detected and rejected', () => {
    const tampered = {
      family: 'PingFang SC',
      name1: 'PingFang SC',
      name2: 'Regular',
      name3: 'PingFang SC Regular; 20.0d4e1; 2024-06-20',
      name4: 'PingFang SC',
      name6: 'PingFangSC',
      name8: 'PingFang SC',
    };
    const res = validateDeepMetadata(tampered);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.field, 'nameID 3');
    console.log(`    [MUTATION SENSITIVITY CONFIRMED] Detected host OS build marker: ${res.reason}`);
  });

  check('Mutation 2: Alien alias in nameID 3 is strictly detected and rejected', () => {
    const tampered = {
      family: 'Droid Sans',
      name1: 'Droid Sans',
      name2: 'Regular',
      name3: 'Google:Roboto:2022',
      name4: 'Droid Sans',
      name6: 'DroidSans',
      name8: 'Droid Sans',
    };
    const res = validateDeepMetadata(tampered);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.field, 'nameID 3');
    console.log(`    [MUTATION SENSITIVITY CONFIRMED] Detected alien alias leak: ${res.reason}`);
  });

  check('Mutation 3: Foreign foundry string in nameID 8 is strictly detected and rejected', () => {
    const tampered = {
      family: 'Arial',
      name1: 'Arial',
      name2: 'Regular',
      name3: 'Arial Regular',
      name4: 'Arial',
      name6: 'Arial',
      name8: 'The Monotype Corporation',
    };
    const res = validateDeepMetadata(tampered);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.field, 'nameID 8');
    console.log(`    [MUTATION SENSITIVITY CONFIRMED] Detected foreign foundry string: ${res.reason}`);
  });

  check('Mutation 4: Empty or missing name records are strictly detected and rejected', () => {
    const tampered = {
      family: 'Segoe UI',
      name1: 'Segoe UI',
      name2: 'Regular',
      name3: '',
      name4: 'Segoe UI',
      name6: 'SegoeUI',
      name8: 'Segoe UI',
    };
    const res = validateDeepMetadata(tampered);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.field, 'nameID 3');
    console.log(`    [MUTATION SENSITIVITY CONFIRMED] Detected missing nameID 3: ${res.reason}`);
  });

  if (isMutateMode) {
    console.log('\n[MUTATION MODE: Running live sensitivity against intentionally corrupted records]');
    const corruptedSample = {
      family: 'HoloLens MDL2 Assets',
      name1: 'HoloLens MDL2 Assets',
      name2: 'Regular',
      name3: 'Segoe MDL2 Assets',
      name4: 'HoloLens MDL2 Assets',
      name6: 'HoloLensMDL2Assets',
      name8: 'Microsoft Corporation',
    };
    const res = validateDeepMetadata(corruptedSample);
    assert.strictEqual(res.ok, false, 'Mutation check must fail for corrupted records');
    console.log(`  PASS  Live mutation check rejected corrupted record as expected: ${res.reason}`);
  }

  // Summary
  const failed = results.filter((r) => !r.ok);
  console.log('\n==================================================================');
  if (failed.length === 0) {
    console.log(`font-deep-metadata-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`font-deep-metadata-e2e-selftest: FAIL (${failed.length} failed)`);
    process.exitCode = 1;
  }
  console.log('==================================================================');
})();
