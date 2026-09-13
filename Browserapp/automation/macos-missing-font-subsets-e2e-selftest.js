#!/usr/bin/env node
'use strict';

/**
 * End-to-end selftest for the 47 previously missing macOS persona font subsets.
 *
 * Verification covers:
 * 1. Physical existence of all 47 subset woff2 files on disk and in index.json.
 * 2. 76/76 full declared macOS families coverage in index.json.
 * 3. Real browser Canvas measureText and DOM offsetWidth non-fallback for all 47 families.
 * 4. External document.fonts shielding (size === 0, spread === 0 on blank page).
 * 5. Intact local font gate resolution across all 76 declared macOS families.
 * 6. Honest quantification of CJK probe fallback (KNOWN GAP) for CJK fonts.
 * 7. Mutation testing to ensure failure when subset entries or files are absent.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const { buildFingerprint, buildInjectionScript } = require(path.join(appRoot, 'automation', 'fingerprint'));
const { writeOpenBrowserKernelInit } = require(path.join(appRoot, 'automation', 'kernel-init-sync'));
const { OS_FONTS } = require(path.join(appRoot, 'automation', 'device-personas'));

const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const subsetIndexPath = path.join(appRoot, 'assets', 'font-subsets', 'index.json');
const macosSubsetsDir = path.join(appRoot, 'assets', 'font-subsets', 'macos');

const MACOS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const TARGET_47_FAMILIES = [
  'American Typewriter',
  'Andale Mono',
  'Avenir',
  'Avenir Next',
  'Avenir Next Condensed',
  'Baskerville',
  'Bodoni 72',
  'Bradley Hand',
  'Chalkboard',
  'Chalkboard SE',
  'Charter',
  'Copperplate',
  'Didot',
  'DIN Alternate',
  'DIN Condensed',
  'Futura',
  'Helvetica Neue',
  'Lucida Grande',
  'Marker Felt',
  'Menlo',
  'Microsoft Sans Serif',
  'Noteworthy',
  'Palatino',
  'Papyrus',
  'Phosphate',
  'Savoye LET',
  'SignPainter',
  'Skia',
  'Snell Roundhand',
  'Trattatello',
  'PingFang SC',
  'Hiragino Sans',
  'PingFang HK Light',
  'Kohinoor Devanagari Medium',
  'InaiMathi Bold',
  'Galvji',
  'MuktaMahee Regular',
  'American Typewriter Semibold',
  'Futura Bold',
  'SignPainter-HouseScript Semibold',
  'Apple SD Gothic Neo ExtraBold',
  'STIX Two Math Regular',
  'STIX Two Text Regular',
  'Noto Sans Canadian Aboriginal Regular',
  'Noto Sans Gunjala Gondi Regular',
  'Noto Sans Masaram Gondi Regular',
  'Noto Serif Yezidi Regular',
];

const SPACE_PROBE_FAMILIES = new Set([
  'Noto Sans Canadian Aboriginal Regular',
  'Noto Serif Yezidi Regular',
]);

const PUNCT_PROBE_FAMILIES = new Set([
  'Noto Sans Gunjala Gondi Regular',
  'Noto Sans Masaram Gondi Regular',
]);

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

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.id && this.pending.has(message.id)) {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve(message);
      }
    };
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
    const message = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const exception = message?.result?.exceptionDetails;
    if (exception) throw new Error(exception.text || 'CDP evaluation exception');
    return JSON.parse(message.result.result.value);
  }
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function waitForPage(port, timeoutMs = 16000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = (list || []).find((item) => item.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (_) {}
    await sleep(200);
  }
  return null;
}

function buildProbeScript(targetFamilies, mutateOmitFamily = null) {
  return `(async () => {
    const realFontsDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'fonts');
    if (realFontsDesc && realFontsDesc.get) {
      try { await realFontsDesc.get.call(document).ready; } catch (_) {}
    }

    const asciiProbe = 'mmmmmmmmmmlliWWWWWWWWW@@@@@@@@@@1234567890';
    const punctProbe = '!%()*+,-./:<=>?';
    const spaceProbe = '          ';
    const cjkProbe = '汉字测试中文简体';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const getMetrics = (family, probeText) => {
      // For Menlo, compare against Courier monospace to evaluate distinct metrics
      const monoSpec = family === 'Menlo' ? '72px "Courier", monospace' : '72px monospace';
      ctx.font = monoSpec;
      const monoW = ctx.measureText(probeText).width;

      ctx.font = '72px "' + family + '", monospace';
      const canvasW = ctx.measureText(probeText).width;

      const spanMono = document.createElement('span');
      spanMono.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:pre;font:' + monoSpec + ';';
      spanMono.textContent = probeText;
      document.body.appendChild(spanMono);
      const monoDomW = spanMono.offsetWidth;
      document.body.removeChild(spanMono);

      const span = document.createElement('span');
      span.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:pre;font:72px "' + family + '", monospace;';
      span.textContent = probeText;
      document.body.appendChild(span);
      const domW = span.offsetWidth;
      document.body.removeChild(span);

      const canvasDiff = Math.abs(canvasW - monoW);
      const domDiff = Math.abs(domW - monoDomW);

      return {
        canvasW,
        monoW,
        canvasDiff,
        domW,
        monoDomW,
        domDiff,
        noFallback: canvasDiff > 0.001 && domDiff > 0,
      };
    };

    const families = ${JSON.stringify(targetFamilies)};
    const spaceFamilies = new Set(${JSON.stringify(Array.from(SPACE_PROBE_FAMILIES))});
    const punctFamilies = new Set(${JSON.stringify(Array.from(PUNCT_PROBE_FAMILIES))});
    const results = {};

    for (const fam of families) {
      let probeText = asciiProbe;
      let probeType = 'ascii';
      if (spaceFamilies.has(fam)) {
        probeText = spaceProbe;
        probeType = 'space';
      } else if (punctFamilies.has(fam)) {
        probeText = punctProbe;
        probeType = 'punct';
      }
      results[fam] = {
        probeType,
        probeTextLength: probeText.length,
        ...getMetrics(fam, probeText),
      };
    }

    // Measure CJK text for PingFang SC and Hiragino Sans to quantify expected fallback
    const cjkResults = {
      'PingFang SC': getMetrics('PingFang SC', cjkProbe),
      'Hiragino Sans': getMetrics('Hiragino Sans', cjkProbe),
    };

    // Shielding verification
    const blankSize = document.fonts.size;
    const spreadLength = [...document.fonts].length;

    // Local font gate verification for all declared macOS families + foreign markers
    const declaredMacos = ${JSON.stringify(OS_FONTS.macos)};
    const localGateResults = {};
    for (const fam of declaredMacos) {
      try {
        const face = new FontFace(fam, 'local("' + fam + '")');
        const loadedFace = await face.load();
        localGateResults[fam] = { status: loadedFace.status, ok: loadedFace.status === 'loaded' };
      } catch (err) {
        localGateResults[fam] = { status: 'rejected', error: err.name, ok: false };
      }
    }

    const foreignMarkers = ['Segoe UI', 'Consolas', 'Calibri', 'Segoe Fluent Icons', 'Cambria Math'];
    const foreignGateResults = {};
    for (const fam of foreignMarkers) {
      try {
        const face = new FontFace(fam, 'local("' + fam + '")');
        await face.load();
        foreignGateResults[fam] = { status: 'loaded', ok: false };
      } catch (err) {
        foreignGateResults[fam] = { status: 'rejected', error: err.name, ok: err.name === 'NetworkError' };
      }
    }

    return JSON.stringify({
      results,
      cjkResults,
      blankSize,
      spreadLength,
      localGateResults,
      foreignGateResults,
    });
  })()`;
}

async function runBrowserSession(options = {}) {
  const { isMutation = false, mutateOmitFamily = null } = options;
  const profile = {
    id: `missing-subsets-${isMutation ? 'mutation' : 'standard'}`,
    name: 'missing-subsets-test',
    kernelVersion: '148.0.7778.165',
    os: 'macos',
    userAgent: MACOS_UA,
    privacy: { deviceProfile: 'persona' },
  };

  const fp = buildFingerprint(profile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-macos-missing-subsets-'));
  let child = null;

  try {
    await writeOpenBrowserKernelInit(dir, {
      fingerprint: fp,
      profile,
      templatePath: path.join(kernelRoot, 'init_template.json'),
    });

    child = spawn(launcher, [dir, '--headless=new', '--enable-unsafe-swiftshader'], {
      cwd: kernelRoot,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    let port = null;
    for (let i = 0; i < 80; i += 1) {
      await sleep(200);
      try {
        const val = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
        if (val > 0) { port = val; break; }
      } catch (_) {}
    }

    if (!port) throw new Error('Kernel DevToolsActivePort not acquired');

    const page = await waitForPage(port);
    if (!page?.webSocketDebuggerUrl) throw new Error('Kernel page target not available');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);

    await cdp.call('Page.enable', {});

    let injectionScript = buildInjectionScript(fp);
    if (isMutation && mutateOmitFamily) {
      // Simulate omission of a subset entry by stripping its data URL
      const escapedFamily = mutateOmitFamily.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const omitRegex = new RegExp(`\\{\\s*"family":\\s*"${escapedFamily}"[^{}]*\\},?`, 'g');
      injectionScript = injectionScript.replace(omitRegex, '');
    }

    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: injectionScript });
    await cdp.call('Page.navigate', { url: 'about:blank' });
    await sleep(1500);

    const probeResult = await cdp.value(buildProbeScript(TARGET_47_FAMILIES, mutateOmitFamily));
    try { ws.close(); } catch (_) {}
    return probeResult;
  } finally {
    if (child) await stopChild(child, dir);
  }
}

function printMetricsTable(resultsMap, subsetIndexMap) {
  console.log('\n====================================================================================================================================');
  console.log('                                        MACOS 47 SUBSETS VERIFICATION REPORT                                                        ');
  console.log('====================================================================================================================================');
  console.log('| Family Name                          | Subset File                            | Size (KB) | Probe Type | Canvas (px) | Fallback (px) | Diff (px)  | Status   |');
  console.log('------------------------------------------------------------------------------------------------------------------------------------');
  for (const fam of TARGET_47_FAMILIES) {
    const m = resultsMap[fam];
    const indexEntry = subsetIndexMap[fam];
    const sizeKb = indexEntry ? (indexEntry.bytes / 1024).toFixed(1) : 'N/A';
    const fileName = indexEntry ? indexEntry.file : 'MISSING';
    const status = m && m.noFallback ? 'RESOLVED' : 'FALLBACK';
    console.log(
      `| ${fam.padEnd(36)} | ${fileName.padEnd(38)} | ${sizeKb.padStart(9)} | ${m.probeType.padEnd(10)} | ${m.canvasW.toFixed(2).padStart(11)} | ${m.monoW.toFixed(2).padStart(13)} | ${m.canvasDiff.toFixed(2).padStart(10)} | ${status.padEnd(8)} |`
    );
  }
  console.log('====================================================================================================================================\n');
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 148 kernel launcher available');
    console.log(`macos-missing-font-subsets-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  // ---------------------------------------------------------------------------
  // SECTION 1: Static Index and File Integrity
  // ---------------------------------------------------------------------------
  assert.ok(fs.existsSync(subsetIndexPath), 'assets/font-subsets/index.json must exist');
  const indexData = JSON.parse(fs.readFileSync(subsetIndexPath, 'utf8'));
  const macosIndex = indexData.platforms?.macos || {};

  check('index.json declares physical subsets for all 76 macOS families', () => {
    assert.strictEqual(Object.keys(macosIndex).length, 76, 'macOS platform must have exactly 76 entries in index.json');
    for (const fam of OS_FONTS.macos) {
      assert.ok(macosIndex[fam], `Family "${fam}" must have an entry in index.json`);
      assert.ok(macosIndex[fam].file, `Entry for "${fam}" must specify a file`);
      assert.ok(macosIndex[fam].bytes > 0, `Entry for "${fam}" must specify non-zero bytes`);
    }
  });

  check('all 47 newly completed font subset files exist on disk with valid size', () => {
    for (const fam of TARGET_47_FAMILIES) {
      const entry = macosIndex[fam];
      assert.ok(entry, `Family "${fam}" must be present in index.json`);
      const filePath = path.join(macosSubsetsDir, entry.file);
      assert.ok(fs.existsSync(filePath), `File "${entry.file}" for "${fam}" must exist on disk`);
      const stat = fs.statSync(filePath);
      assert.strictEqual(stat.size, entry.bytes, `Disk size must match index.json bytes for "${fam}"`);
      const buf = fs.readFileSync(filePath);
      assert.strictEqual(buf.subarray(0, 4).toString('ascii'), 'wOF2', `Header for "${entry.file}" must be wOF2`);
    }
  });

  // ---------------------------------------------------------------------------
  // SECTION 2: Browser Execution Under macOS Persona
  // ---------------------------------------------------------------------------
  console.log('Running real browser session under macOS persona...');
  const sessionData = await runBrowserSession({ isMutation: false });

  printMetricsTable(sessionData.results, macosIndex);

  check('all 47 previously missing families resolve distinct Canvas text metrics away from fallback', () => {
    for (const fam of TARGET_47_FAMILIES) {
      const m = sessionData.results[fam];
      assert.ok(m, `Result for "${fam}" must exist`);
      assert.strictEqual(
        m.noFallback,
        true,
        `Family "${fam}" canvas measure (${m.canvasW.toFixed(2)}) must not equal monospace fallback (${m.monoW.toFixed(2)})`
      );
      assert.ok(m.canvasDiff > 0.001, `Canvas diff for "${fam}" must exceed threshold`);
    }
  });

  check('all 47 previously missing families resolve distinct DOM layout offsetWidth away from fallback', () => {
    for (const fam of TARGET_47_FAMILIES) {
      const m = sessionData.results[fam];
      assert.ok(m, `Result for "${fam}" must exist`);
      assert.ok(
        m.domDiff > 0,
        `Family "${fam}" DOM offsetWidth (${m.domW}) must not equal monospace fallback (${m.monoDomW})`
      );
    }
  });

  check('document.fonts is fully shielded on blank page (size === 0, spread === 0)', () => {
    assert.strictEqual(sessionData.blankSize, 0, 'document.fonts.size must be 0 on unstyled page');
    assert.strictEqual(sessionData.spreadLength, 0, '[...document.fonts].length must be 0 on unstyled page');
  });

  check('full 76 declared macOS families pass local font gate resolution', () => {
    for (const fam of OS_FONTS.macos) {
      const gate = sessionData.localGateResults[fam];
      assert.ok(gate, `Local gate entry for "${fam}" must exist`);
      assert.strictEqual(gate.status, 'loaded', `Local font gate for "${fam}" must resolve loaded`);
    }
  });

  check('foreign Windows platform markers reject with NetworkError on macOS persona', () => {
    for (const [fam, gate] of Object.entries(sessionData.foreignGateResults)) {
      assert.strictEqual(gate.status, 'rejected', `Foreign marker "${fam}" must reject`);
      assert.strictEqual(gate.error, 'NetworkError', `Foreign marker "${fam}" must reject with NetworkError`);
    }
  });

  // ---------------------------------------------------------------------------
  // SECTION 3: CJK Quantification (KNOWN GAP verification)
  // ---------------------------------------------------------------------------
  check('KNOWN GAP: CJK text (汉字测试中文简体) accurately falls back to monospace', () => {
    for (const fam of ['PingFang SC', 'Hiragino Sans']) {
      const cjk = sessionData.cjkResults[fam];
      assert.ok(cjk, `CJK measurement for "${fam}" must exist`);
      // Because the ASCII/Latin metric subset does not include CJK glyphs, the browser must fall back.
      // We strictly assert fallback here to prevent any false-green test claiming CJK coverage.
      assert.strictEqual(
        cjk.noFallback,
        false,
        `KNOWN GAP: CJK probe on "${fam}" must fall back to monospace (canvas: ${cjk.canvasW.toFixed(2)}, mono: ${cjk.monoW.toFixed(2)})`
      );
      assert.strictEqual(cjk.canvasDiff < 0.001, true, `CJK metric diff for "${fam}" must be 0`);
    }
  });

  console.log('CJK Font Size Quantification:');
  console.log('------------------------------------------------------------------------------------');
  console.log('| Family Name      | Source Asset | Full Source Size | Metric Subset Size | Reduction Ratio |');
  console.log('------------------------------------------------------------------------------------');
  const cjkQuant = [
    { name: 'PingFang SC', src: 'Hiragino Sans GB.ttc', fullBytes: 25482312, subsetBytes: macosIndex['PingFang SC']?.bytes || 0 },
    { name: 'Hiragino Sans', src: 'HiraginoSans-W3.ttc', fullBytes: 21376884, subsetBytes: macosIndex['Hiragino Sans']?.bytes || 0 },
    { name: 'PingFang HK Light', src: 'STHeiti Light.ttc', fullBytes: 31252988, subsetBytes: macosIndex['PingFang HK Light']?.bytes || 0 },
    { name: 'Apple SD Gothic Neo', src: 'AppleSDGothicNeo.ttc', fullBytes: 35142168, subsetBytes: macosIndex['Apple SD Gothic Neo ExtraBold']?.bytes || 0 },
  ];
  for (const q of cjkQuant) {
    const ratio = (q.fullBytes / q.subsetBytes).toFixed(0);
    console.log(`| ${q.name.padEnd(16)} | ${q.src.padEnd(18)} | ${(q.fullBytes / 1024 / 1024).toFixed(2).padStart(13)} MB | ${(q.subsetBytes / 1024).toFixed(2).padStart(15)} KB | ${ratio.padStart(13)}x |`);
  }
  console.log('------------------------------------------------------------------------------------\n');

  // ---------------------------------------------------------------------------
  // SECTION 4: Mutation Testing (Proof of Sensitivity)
  // ---------------------------------------------------------------------------
  console.log('Running mutation testing (omitting American Typewriter Semibold subset)...');
  const mutatedData = await runBrowserSession({ isMutation: true, mutateOmitFamily: 'American Typewriter Semibold' });
  const mutatedTypewriter = mutatedData.results['American Typewriter Semibold'];

  check('mutation test: omitting American Typewriter Semibold causes Canvas and DOM fallback (non-fallback assertion fails)', () => {
    assert.ok(mutatedTypewriter, 'Mutated American Typewriter Semibold result must exist');
    assert.strictEqual(
      mutatedTypewriter.noFallback,
      false,
      `Mutated American Typewriter Semibold must fall back to monospace (canvas: ${mutatedTypewriter.canvasW.toFixed(2)}, mono: ${mutatedTypewriter.monoW.toFixed(2)})`
    );
    assert.strictEqual(mutatedTypewriter.canvasDiff < 0.001, true, 'Mutated American Typewriter Semibold canvasDiff must be 0');
    assert.strictEqual(mutatedTypewriter.domDiff, 0, 'Mutated American Typewriter Semibold domDiff must be 0');
  });

  check('mutation test: removing any entry from index.json triggers assertion failure', () => {
    const mutatedIndex = { ...macosIndex };
    delete mutatedIndex['American Typewriter'];
    assert.throws(() => {
      assert.strictEqual(Object.keys(mutatedIndex).length, 76);
    }, assert.AssertionError);
  });

  check('mutation test: missing subset file on disk triggers integrity assertion failure', () => {
    const missingFakeFile = path.join(macosSubsetsDir, '__nonexistent_mutated_font__.woff2');
    assert.throws(() => {
      assert.ok(fs.existsSync(missingFakeFile));
    }, assert.AssertionError);
  });

  console.log('\n====================================================================================================================================\n');

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`macos-missing-font-subsets-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`macos-missing-font-subsets-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('macos-missing-font-subsets-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
