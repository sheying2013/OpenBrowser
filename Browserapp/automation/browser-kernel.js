'use strict';

/**
 * Independent Chromium kernel manager.
 *
 * Primary channel (Donut Browser official):
 *   https://donutbrowser.com/wayfern.json  →  Wayfern anti-detect Chromium
 *   binaries from download.wayfern.com (same feed Donut uses)
 *
 * Fallbacks:
 *   - Chrome for Testing (Google official) if Wayfern has no package for this OS/arch
 *   - User-supplied custom binary
 *
 * Wayfern is a third-party binary distributed by Wayfern/Donut; first use is
 * subject to Wayfern Terms of Service (https://wayfern.com/tos). OpenBrowser
 * obtains it from the official feed for local installation or platform builds.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFile, spawn } = require('child_process');
const { createWriteStream } = require('fs');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { isSystemBrowserExecutable } = require('./isolation');

/** Donut Browser official Wayfern version feed (same URL as Donut src-tauri). */
const WAYFERN_META = 'https://donutbrowser.com/wayfern.json';
/** Fallback: Google Chrome for Testing last-known-good. */
const CFT_META = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

const SOURCE_WAYFERN = 'donut-wayfern';
const SOURCE_CFT = 'chrome-for-testing';
const SOURCE_CUSTOM = 'custom';
/** Bundled / userData OpenBrowser 148 independent kernel. Default on macOS x64. */
const SOURCE_OPENBROWSER = 'openbrowser-148';
const OPENBROWSER_KERNEL_VERSION = '148.0.7778.165';
const WAYFERN_ACCEPT_TERMS_ARG = '--accept-terms-and-conditions';
const MAX_META_BYTES = 2 * 1024 * 1024;
const MAX_KERNEL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_REDIRECTS = 6;
const MAX_ARCHIVE_ENTRIES = 100000;
const KERNEL_HOSTS = new Set([
  'donutbrowser.com',
  'download.wayfern.com',
  'googlechromelabs.github.io',
  'storage.googleapis.com',
]);
const acceptedWayfernTerms = new Set();

function trustedKernelUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || !KERNEL_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Untrusted kernel download URL: ${parsed.origin}`);
  }
  return parsed;
}

function validateArchiveMemberName(value) {
  const name = String(value || '').replace(/\\/g, '/');
  if (!name || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:\//.test(name)) {
    throw new Error('Kernel archive contains an absolute or invalid path');
  }
  const parts = name.split('/').filter(Boolean);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (parts.some((part) => part === '..' || part.includes(':') || /[. ]$/.test(part) || reserved.test(part))) {
    throw new Error('Kernel archive contains an unsafe path segment');
  }
  return name;
}

async function preflightArchiveMembers(archivePath, kind) {
  if (kind === 'dmg') return;
  let stdout;
  if (kind === 'zip') {
    if (process.platform === 'win32') {
      const escaped = archivePath.replace(/'/g, "''");
      const script = [
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `$z=[System.IO.Compression.ZipFile]::OpenRead('${escaped}')`,
        "try { $z.Entries | ForEach-Object { $mode=($_.ExternalAttributes -shr 16) -band 0xF000; \"$($_.FullName)`t$mode\" } } finally { $z.Dispose() }",
      ].join('; ');
      ({ stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      }));
      const rows = String(stdout || '').split(/\r?\n/).filter(Boolean);
      if (!rows.length || rows.length > MAX_ARCHIVE_ENTRIES) throw new Error('Kernel archive entry count is invalid');
      for (const row of rows) {
        const split = row.lastIndexOf('\t');
        const name = split >= 0 ? row.slice(0, split) : row;
        const mode = split >= 0 ? Number(row.slice(split + 1)) : 0;
        validateArchiveMemberName(name);
        if (mode === 0xA000) throw new Error('Kernel ZIP contains a symbolic link');
      }
      return;
    } else {
      ({ stdout } = await execFileAsync('unzip', ['-Z1', archivePath], { maxBuffer: 32 * 1024 * 1024 }));
      const names = String(stdout || '').split(/\r?\n/).filter(Boolean);
      if (!names.length || names.length > MAX_ARCHIVE_ENTRIES) throw new Error('Kernel archive entry count is invalid');
      for (const name of names) validateArchiveMemberName(name);
      const listing = await execFileAsync('unzip', ['-Z', '-l', archivePath], { maxBuffer: 32 * 1024 * 1024 });
      if (String(listing.stdout || '').split(/\r?\n/).some((line) => /^l[rwx-]{9}\s/.test(line))) {
        throw new Error('Kernel ZIP contains a symbolic link');
      }
      return;
    }
  } else {
    ({ stdout } = await execFileAsync('tar', ['-tf', archivePath], { maxBuffer: 32 * 1024 * 1024 }));
    const names = String(stdout || '').split(/\r?\n/).filter(Boolean);
    if (!names.length || names.length > MAX_ARCHIVE_ENTRIES) throw new Error('Kernel archive entry count is invalid');
    for (const name of names) validateArchiveMemberName(name);
    const listing = await execFileAsync('tar', ['-tvf', archivePath], { maxBuffer: 32 * 1024 * 1024 });
    if (String(listing.stdout || '').split(/\r?\n/).some((line) => line[0] === 'l' || line[0] === 'h')) {
      throw new Error('Kernel TAR contains a link');
    }
    return;
  }
}

async function assertSafeExtractedTree(root) {
  const base = await fsp.realpath(root);
  const stack = [base];
  let count = 0;
  while (stack.length) {
    const dir = stack.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      count += 1;
      if (count > MAX_ARCHIVE_ENTRIES) throw new Error('Extracted kernel contains too many files');
      const full = path.join(dir, entry.name);
      const stat = await fsp.lstat(full);
      if (stat.isSymbolicLink()) {
        const target = await fsp.realpath(full).catch(() => null);
        if (!target || !isPathInsideRoot(target, base)) throw new Error('Extracted kernel contains an unsafe link');
        continue;
      }
      if (stat.isDirectory()) stack.push(full);
      else if (!stat.isFile()) throw new Error('Extracted kernel contains a special file');
    }
  }
}

function isPathInsideRoot(candidate, root) {
  const child = path.resolve(candidate);
  const base = path.resolve(root);
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  return normalize(child) === normalize(base) || normalize(child).startsWith(normalize(base) + path.sep);
}

function safeInstalledBinary(candidate, root) {
  if (!candidate || !root) return null;
  const lexical = path.resolve(candidate);
  const base = path.resolve(root);
  if (!isPathInsideRoot(lexical, base)) return null;
  try {
    const linkStat = fs.lstatSync(lexical);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) return null;
    const real = fs.realpathSync.native(lexical);
    const realBase = fs.realpathSync.native(base);
    return isPathInsideRoot(real, realBase) ? lexical : null;
  } catch (_) {
    return null;
  }
}

function donutPlatformKey() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `macos-${arch}`;
  if (process.platform === 'win32') return `windows-${arch}`;
  return `linux-${arch}`;
}

function cftPlatformKey() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (process.platform === 'win32') return 'win64';
  return 'linux64';
}

function chromeForTestingBinaryRelative(platform) {
  if (platform.startsWith('mac-')) {
    return path.join(
      platform === 'mac-arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing'
    );
  }
  if (platform === 'win64') return path.join('chrome-win64', 'chrome.exe');
  return path.join('chrome-linux64', 'chrome');
}

/** Relative path of the OpenBrowser 148 launcher (shell wrapper → OpenBrowser.bin). */
function openBrowserKernelBinaryRelative() {
  return path.join(
    'openbrowser',
    'chrome_148',
    'openbrowser_148',
    'OpenBrowser.app',
    'Contents',
    'MacOS',
    'OpenBrowser'
  );
}

function isMacX64Host() {
  return process.platform === 'darwin' && process.arch === 'x64';
}

/**
 * openbrowser-148 is a macOS Intel (x86_64) kernel only.
 * Never package it for other platforms; never auto-select it at runtime elsewhere.
 * @param {string} [platform=process.platform]
 * @param {string} [arch=process.arch] node arch (x64/arm64) or package arch (x86_64/arm64)
 */
function isOpenBrowser148SupportedHost(platform = process.platform, arch = process.arch) {
  const p = String(platform || '').toLowerCase();
  const a = String(arch || '').toLowerCase();
  const isX64 = a === 'x64' || a === 'x86_64' || a === 'amd64';
  return p === 'darwin' && isX64;
}

/**
 * Locate OpenBrowser 148 kernel under kernelsRoot or optional resource roots.
 * Layout: kernels/openbrowser/chrome_148/openbrowser_148/OpenBrowser.app/Contents/MacOS/OpenBrowser
 * Returns null on non-macOS-x64 hosts so a stray kernels tree cannot be selected.
 */
function findOpenBrowserKernelBinary(kernelsRoot, extraRoots = []) {
  if (!isOpenBrowser148SupportedHost()) return null;
  const rel = openBrowserKernelBinaryRelative();
  const roots = [];
  const push = (r) => {
    if (!r) return;
    const s = String(r).trim();
    if (s && !roots.includes(s)) roots.push(s);
  };
  push(kernelsRoot);
  for (const r of extraRoots || []) push(r);
  try {
    push(process.env.OPENBROWSER_KERNEL_ROOT);
  } catch (_) {}

  const candidates = [];
  for (const root of roots) {
    // root is .../kernels  →  root/openbrowser/chrome_148/...
    candidates.push(path.join(root, rel));
    // root is .../kernels/openbrowser  →  root/chrome_148/...
    candidates.push(path.join(root, 'chrome_148', 'openbrowser_148', 'OpenBrowser.app', 'Contents', 'MacOS', 'OpenBrowser'));
    // root is app/source dir  →  root/kernels/openbrowser/...
    candidates.push(path.join(root, 'kernels', rel));
    // root is process.resourcesPath with nested kernels
    candidates.push(path.join(root, 'app', 'kernels', rel));
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch (_) {}
  }
  return null;
}

function kernelDisplayName(source) {
  if (source === SOURCE_OPENBROWSER) return 'OpenBrowser 148';
  if (source === SOURCE_WAYFERN) return 'Wayfern (Donut)';
  if (source === SOURCE_CUSTOM) return 'Custom Chromium';
  if (source === SOURCE_CFT) return 'Chrome for Testing';
  return 'Independent Chromium';
}

function isWayfernKernel(candidate = {}, versionOutput = '') {
  const source = String(candidate.source || '').toLowerCase();
  const binaryPath = String(candidate.path || candidate.binary || candidate || '').toLowerCase().replace(/\\/g, '/');
  const version = String(versionOutput || candidate.versionOutput || '').toLowerCase();
  return source === SOURCE_WAYFERN
    || /(?:^|\/)wayfern(?:\/|$)/.test(binaryPath)
    || /\bwayfern\b/.test(version);
}

function termsAcceptanceArgsForKernel(candidate = {}, versionOutput = '') {
  return isWayfernKernel(candidate, versionOutput) ? [WAYFERN_ACCEPT_TERMS_ARG] : [];
}

async function ensureKernelReadyForLaunch(candidate = {}, versionOutput = '') {
  const args = termsAcceptanceArgsForKernel(candidate, versionOutput);
  if (!args.length) return false;
  const binary = String(candidate.path || candidate.binary || candidate || '').trim();
  if (!binary) throw new Error('Wayfern 条款初始化失败：缺少内核路径');

  const cacheKey = [path.resolve(binary), process.env.APPDATA || process.env.HOME || ''].join('\0');
  if (acceptedWayfernTerms.has(cacheKey)) return true;

  try {
    await execFileAsync(binary, args, { timeout: 15000, windowsHide: true, maxBuffer: 128 * 1024 });
    acceptedWayfernTerms.add(cacheKey);
    return true;
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' | ');
    throw new Error('Wayfern 条款初始化失败：' + (output || 'accept-terms command failed'));
  }
}

function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split(/[^\d]+/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split(/[^\d]+/).map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function fetchJson(url, redirects = 0) {
  if (redirects > MAX_REDIRECTS) return Promise.reject(new Error('Kernel metadata redirected too many times'));
  const parsed = trustedKernelUrl(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    const req = https.get(parsed, { headers: { 'User-Agent': 'OpenBrowser/1.0 (kernel; Donut Wayfern channel)' }, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchJson(new URL(res.headers.location, parsed).toString(), redirects + 1)
          .then((value) => finish(resolve, value), (error) => finish(reject, error));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return finish(reject, new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      const chunks = []; let size = 0;
      res.on('data', (c) => {
        if (settled) return;
        size += c.length;
        if (size > MAX_META_BYTES) {
          const error = new Error('Kernel metadata exceeds 2 MiB');
          finish(reject, error);
          res.destroy(error);
          req.destroy(error);
        } else {
          chunks.push(c);
        }
      });
      res.on('error', (error) => finish(reject, error));
      res.on('end', () => {
        if (settled) return;
        try { finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { finish(reject, e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Kernel metadata request timed out')));
    req.on('error', (error) => finish(reject, error));
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let activeOutput = null;
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (activeOutput && !activeOutput.destroyed) activeOutput.destroy();
      fsp.rm(dest, { force: true }).catch(() => {}).finally(() => reject(error));
    };
    const doGet = (value, redirects = 0) => {
      if (settled) return;
      if (redirects > MAX_REDIRECTS) return fail(new Error('Kernel download redirected too many times'));
      let parsed;
      try { parsed = trustedKernelUrl(value); } catch (error) { return fail(error); }
      const req = https.get(parsed, { headers: { 'User-Agent': 'OpenBrowser/1.0 (kernel; Donut Wayfern channel)' }, timeout: 60000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return doGet(new URL(res.headers.location, parsed).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error('Download HTTP ' + res.statusCode));
        }
        const total = Number(res.headers['content-length']) || 0;
        if (total > MAX_KERNEL_BYTES) { res.resume(); return fail(new Error('Kernel archive exceeds 2 GiB')); }
        let received = 0;
        try { fs.rmSync(dest, { force: true }); } catch (_) {}
        const out = createWriteStream(dest, { flags: 'w', mode: 0o600 });
        activeOutput = out;
        res.on('data', (chunk) => {
          if (settled) return;
          received += chunk.length;
          if (received > MAX_KERNEL_BYTES) {
            const error = new Error('Kernel archive exceeds 2 GiB');
            res.destroy(error);
            req.destroy(error);
            fail(error);
            return;
          }
          if (onProgress && total) onProgress({ received, total, percent: Math.floor((received / total) * 100) });
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => succeed({ path: dest, bytes: received })));
        out.on('error', fail);
        res.on('error', fail);
      });
      req.on('timeout', () => req.destroy(new Error('Kernel download timed out')));
      req.on('error', fail);
    };
    doGet(url);
  });
}

function requestJson(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('CDP probe timed out')));
    req.on('error', reject);
  });
}

async function waitForDevToolsPort(root, timeout = 12000) {
  const file = path.join(root, 'DevToolsActivePort');
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const value = await fsp.readFile(file, 'utf8');
      const port = Number(value.split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('浏览器未在限定时间内提供 CDP 调试端口');
}

function startupOutput(child) {
  return [child?._startupStdout, child?._startupStderr]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' | ');
}

async function stopProbeProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function extractZip(zipPath, destDir) {
  await preflightArchiveMembers(zipPath, 'zip');
  await new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      const ps = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
      execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
      return;
    }
    execFile('unzip', ['-o', '-q', zipPath, '-d', destDir], (err) => {
      if (err) {
        if (process.platform === 'darwin') {
          execFile('ditto', ['-x', '-k', zipPath, destDir], (e2) => (e2 ? reject(err) : resolve()));
          return;
        }
        return reject(err);
      }
      resolve();
    });
  });
  await assertSafeExtractedTree(destDir);
}

async function extractTarXz(archivePath, destDir) {
  await preflightArchiveMembers(archivePath, 'tar.xz');
  await execFileAsync('tar', ['-xJf', archivePath, '-C', destDir]);
  await assertSafeExtractedTree(destDir);
}

async function extractTarGz(archivePath, destDir) {
  await preflightArchiveMembers(archivePath, 'tar.gz');
  await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir]);
  await assertSafeExtractedTree(destDir);
}

/**
 * macOS: mount DMG, copy first .app into destDir, detach.
 * Mirrors Donut's extract_dmg approach at a high level.
 */
async function extractDmg(dmgPath, destDir) {
  if (process.platform !== 'darwin') throw new Error('DMG 仅支持 macOS');
  const mountRoot = path.join(destDir, '_dmg_mount');
  await fsp.mkdir(mountRoot, { recursive: true });
  let mountPoint = null;
  try {
    const { stdout } = await execFileAsync('hdiutil', [
      'attach', dmgPath, '-nobrowse', '-readonly', '-mountroot', mountRoot,
    ], { maxBuffer: 4 * 1024 * 1024 });
    // Prefer scanning mountRoot for .app; fallback parse plist-ish output for /Volumes/
    const entries = await fsp.readdir(mountRoot, { withFileTypes: true }).catch(() => []);
    const vol = entries.find((e) => e.isDirectory());
    if (vol) mountPoint = path.join(mountRoot, vol.name);
    if (!mountPoint) {
      const m = String(stdout || '').match(/\/Volumes\/[^\n\t]+/);
      if (m) mountPoint = m[0].trim();
    }
    if (!mountPoint || !fs.existsSync(mountPoint)) throw new Error('无法挂载 DMG');

    const apps = (await fsp.readdir(mountPoint, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.endsWith('.app'))
      .map((e) => path.join(mountPoint, e.name));
    if (!apps.length) throw new Error('DMG 内未找到 .app');

    const appName = path.basename(apps[0]);
    const targetApp = path.join(destDir, appName);
    await fsp.rm(targetApp, { recursive: true, force: true }).catch(() => {});
    // ditto preserves resource forks / codesign better than cp -R
    await execFileAsync('ditto', [apps[0], targetApp]);
    await assertSafeExtractedTree(targetApp);
  } finally {
    // detach everything under mountRoot
    try {
      const kids = await fsp.readdir(mountRoot).catch(() => []);
      for (const name of kids) {
        await execFileAsync('hdiutil', ['detach', path.join(mountRoot, name), '-quiet']).catch(() => {});
      }
      await execFileAsync('hdiutil', ['detach', mountRoot, '-quiet']).catch(() => {});
    } catch (_) {}
    await fsp.rm(mountRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function findExecutable(root, preferredNames) {
  const stack = [root];
  const found = [];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Prefer walking into .app/Contents/MacOS
        if (ent.name.endsWith('.app')) {
          const macosDir = path.join(full, 'Contents', 'MacOS');
          if (fs.existsSync(macosDir)) stack.push(macosDir);
          else stack.push(full);
        } else if (!['Frameworks', 'Helpers', 'resources', 'locales', 'Resources'].includes(ent.name)) {
          stack.push(full);
        }
      } else {
        const lower = ent.name.toLowerCase();
        for (const pref of preferredNames) {
          if (lower === pref.toLowerCase() || ent.name.includes(pref)) {
            found.push({ full, score: lower === pref.toLowerCase() ? 0 : 1, name: ent.name });
          }
        }
      }
    }
  }
  found.sort((a, b) => a.score - b.score);
  // Skip crashpad helpers
  const cleaned = found.filter((f) => !/crashpad|helper|nacl|chrome_crash/i.test(f.name));
  return (cleaned[0] || found[0] || null)?.full || null;
}

async function resolveWayfernBinary(installDir) {
  if (process.platform === 'darwin') {
    // Prefer .app → Contents/MacOS/{Wayfern|Chromium}
    try {
      const entries = await fsp.readdir(installDir, { withFileTypes: true });
      const app = entries.find((e) => e.isDirectory() && e.name.endsWith('.app'));
      if (app) {
        const macosDir = path.join(installDir, app.name, 'Contents', 'MacOS');
        if (fs.existsSync(macosDir)) {
          const bins = await fsp.readdir(macosDir);
          const pick = bins.find((n) => /Wayfern/i.test(n))
            || bins.find((n) => /Chromium/i.test(n))
            || bins.find((n) => /Chrome/i.test(n) && !/helper|crash/i.test(n));
          if (pick) return path.join(macosDir, pick);
        }
      }
    } catch (_) {}
  }
  const names = process.platform === 'win32'
    ? ['wayfern.exe', 'chromium.exe', 'chrome.exe']
    : ['wayfern', 'chromium', 'chrome', 'Wayfern', 'Chromium'];
  // direct candidates
  for (const name of names) {
    for (const rel of ['', 'wayfern', 'wayfern-linux', 'chrome-linux', 'Wayfern']) {
      const candidate = path.join(installDir, rel, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return findExecutable(installDir, names.map((n) => n.replace(/\.exe$/i, '')));
}

function findWayfernKernelBinary(root) {
  const base = path.resolve(String(root || ''));
  if (!fs.existsSync(base)) return null;
  const names = process.platform === 'win32'
    ? ['wayfern.exe', 'chromium.exe', 'chrome.exe']
    : ['wayfern', 'chromium', 'chrome', 'Wayfern', 'Chromium'];
  const walk = (dir, depth) => {
    if (depth > 8) return null;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name.endsWith('.app')) {
        const macos = path.join(full, 'Contents', 'MacOS');
        const hit = fs.existsSync(macos) ? walk(macos, depth + 1) : null;
        if (hit) return hit;
      } else if (entry.isFile() && names.some((name) => entry.name.toLowerCase() === name.toLowerCase())) {
        return full;
      } else if (entry.isDirectory() && !['Frameworks', 'Helpers', 'resources', 'locales', 'Resources'].includes(entry.name)) {
        const hit = walk(full, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(base, 0);
}

function findBundledWayfernKernel(resourceRoots = []) {
  const roots = [];
  const addRoot = (root) => {
    if (!root) return;
    const value = path.resolve(String(root));
    if (!roots.includes(value)) roots.push(value);
  };
  for (const root of resourceRoots || []) {
    addRoot(path.join(root, 'kernels', 'wayfern'));
    addRoot(path.join(root, 'app', 'kernels', 'wayfern'));
    addRoot(path.join(root, 'bundled-kernels', 'wayfern'));
    addRoot(path.join(root, 'app', 'bundled-kernels', 'wayfern'));
  }
  for (const root of roots) {
    const binary = findWayfernKernelBinary(root);
    if (binary) return { binary, root };
  }
  return null;
}

function bundledKernelVersion(root) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'kernel.json'), 'utf8'));
    return String(manifest.version || '').trim() || 'bundled';
  } catch (_) {
    return 'bundled';
  }
}

function archiveKindFromUrl(url) {
  const u = String(url || '').toLowerCase();
  if (u.endsWith('.dmg')) return 'dmg';
  if (u.endsWith('.tar.xz') || u.endsWith('.txz')) return 'tar.xz';
  if (u.endsWith('.tar.gz') || u.endsWith('.tgz')) return 'tar.gz';
  if (u.endsWith('.zip')) return 'zip';
  if (u.includes('.dmg')) return 'dmg';
  if (u.includes('.tar.xz')) return 'tar.xz';
  if (u.includes('.zip')) return 'zip';
  return 'zip';
}

class BrowserKernelManager {
  constructor(userDataPath, options = {}) {
    this.userData = userDataPath;
    this.kernelsRoot = path.join(userDataPath, 'kernels');
    this.metaFile = path.join(this.kernelsRoot, 'kernel-meta.json');
    this.onProgress = options.onProgress || (() => {});
    this.installPromise = null;
    // Optional extra roots (e.g. process.resourcesPath) for bundled mac x64 kernel seed
    this.resourceRoots = Array.isArray(options.resourceRoots)
      ? options.resourceRoots.filter(Boolean)
      : (options.resourceRoot ? [options.resourceRoot] : []);
    this.meta = {
      version: null,
      platform: donutPlatformKey(),
      binary: null,
      updatedAt: null,
      source: null,
      remoteVersion: null,
      downloadUrl: null,
    };
  }

  async loadMeta() {
    try {
      this.meta = { ...this.meta, ...JSON.parse(await fsp.readFile(this.metaFile, 'utf8')) };
    } catch (_) {}
    // Reconcile the metadata with a kernel discovered in the current data root.
    const installed = this.resolveInstalled();
    if (installed && (this.meta.binary !== installed.path || this.meta.source !== installed.source)) {
      this.meta.binary = installed.path;
      this.meta.source = installed.source;
      if (installed.version) this.meta.version = installed.version;
      this.meta.updatedAt = new Date().toISOString();
      await this.saveMeta();
    }
    return this.meta;
  }

  async saveMeta() {
    await fsp.mkdir(this.kernelsRoot, { recursive: true });
    await fsp.writeFile(this.metaFile, JSON.stringify(this.meta, null, 2), 'utf8');
  }

  resolveInstalled() {
    // macOS x64 default only: OpenBrowser 148 under kernels/openbrowser/ (wrapper binary).
    // Other hosts must never auto-select this kernel even if a stray tree exists.
    if (isOpenBrowser148SupportedHost()) {
      const openBrowserBin = findOpenBrowserKernelBinary(this.kernelsRoot, this.resourceRoots);
      if (openBrowserBin) {
        const trustedOb = this.safeCustomBinary(openBrowserBin);
        if (trustedOb) {
          return {
            name: kernelDisplayName(SOURCE_OPENBROWSER),
            path: trustedOb,
            version: this.meta.version || OPENBROWSER_KERNEL_VERSION,
            independent: true,
            source: SOURCE_OPENBROWSER,
          };
        }
      }
    }

    if (this.meta.binary && fs.existsSync(this.meta.binary)) {
      const src = this.meta.source || SOURCE_WAYFERN;
      // Refuse stale openbrowser-148 meta on non-mac-x64 hosts.
      if (src === SOURCE_OPENBROWSER && !isOpenBrowser148SupportedHost()) {
        // fall through to Wayfern/CfT/custom
      } else {
        const trusted = (src === SOURCE_CUSTOM || src === SOURCE_OPENBROWSER)
          ? this.safeCustomBinary(this.meta.binary)
          : safeInstalledBinary(this.meta.binary, this.kernelsRoot);
        if (trusted) {
          return {
            name: kernelDisplayName(src),
            path: trusted,
            version: this.meta.version || 'unknown',
            independent: true,
            source: src,
          };
        }
      }
    }

    const bundled = findBundledWayfernKernel(this.resourceRoots);
    if (bundled) {
      const trustedBundled = safeInstalledBinary(bundled.binary, bundled.root);
      if (trustedBundled) {
        return {
          name: kernelDisplayName(SOURCE_WAYFERN),
          path: trustedBundled,
          version: bundledKernelVersion(bundled.root),
          independent: true,
          source: SOURCE_WAYFERN,
        };
      }
    }

    // Scan Wayfern install dir
    const wayfernDir = path.join(this.kernelsRoot, 'wayfern');
    if (fs.existsSync(wayfernDir)) {
      // sync find: try common layouts quickly
      const tryNames = process.platform === 'win32'
        ? ['wayfern.exe', 'chromium.exe', 'chrome.exe']
        : ['wayfern', 'chromium', 'chrome'];
      try {
        const walk = (dir, depth) => {
          if (depth > 5) return null;
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
          for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory() && ent.name.endsWith('.app')) {
              const macos = path.join(full, 'Contents', 'MacOS');
              if (fs.existsSync(macos)) {
                const bins = fs.readdirSync(macos);
                const pick = bins.find((n) => /Wayfern|Chromium/i.test(n) && !/helper|crash/i.test(n));
                if (pick) return path.join(macos, pick);
              }
            } else if (ent.isFile() && tryNames.some((n) => ent.name.toLowerCase() === n.toLowerCase())) {
              return full;
            } else if (ent.isDirectory() && !['Frameworks', 'Helpers', 'resources', 'locales'].includes(ent.name)) {
              const hit = walk(full, depth + 1);
              if (hit) return hit;
            }
          }
          return null;
        };
        const found = walk(wayfernDir, 0);
        const trusted = safeInstalledBinary(found, wayfernDir);
        if (trusted) {
          return {
            name: kernelDisplayName(SOURCE_WAYFERN),
            path: trusted,
            version: this.meta.version || 'unknown',
            independent: true,
            source: SOURCE_WAYFERN,
          };
        }
      } catch (_) {}
    }

    // Legacy Chrome for Testing path
    const plat = cftPlatformKey();
    const cft = path.join(this.kernelsRoot, 'chrome-for-testing', chromeForTestingBinaryRelative(plat));
    const trustedCft = safeInstalledBinary(cft, this.kernelsRoot);
    if (trustedCft) {
      return {
        name: kernelDisplayName(SOURCE_CFT),
        path: trustedCft,
        version: this.meta.version || 'unknown',
        independent: true,
        source: SOURCE_CFT,
      };
    }

    const custom = path.join(this.kernelsRoot, 'custom', 'chrome');
    const trustedCustom = this.safeCustomBinary(custom);
    if (trustedCustom) {
      return {
        name: kernelDisplayName(SOURCE_CUSTOM),
        path: trustedCustom,
        version: this.meta.version || 'custom',
        independent: true,
        source: SOURCE_CUSTOM,
      };
    }
    return null;
  }

  safeCustomBinary(candidate) {
    const resolved = path.resolve(String(candidate || ''));
    try {
      const stat = fs.lstatSync(resolved);
      if (stat.isSymbolicLink() || !stat.isFile() || isSystemBrowserExecutable(resolved)) return null;
      const real = fs.realpathSync.native(resolved);
      return isSystemBrowserExecutable(real) ? null : resolved;
    } catch (_) {
      return null;
    }
  }

  status() {
    const installed = this.resolveInstalled();
    // Channel label only claims openbrowser-148 default on the supported host.
    const openBrowserDefault = isOpenBrowser148SupportedHost()
      && (!installed || installed.source === SOURCE_OPENBROWSER);
    return {
      platform: donutPlatformKey(),
      cftPlatform: cftPlatformKey(),
      kernelsRoot: this.kernelsRoot,
      installed: Boolean(installed),
      kernel: installed,
      meta: this.meta,
      channel: openBrowserDefault
        ? {
          name: 'OpenBrowser 148 (macOS x86 默认)',
          metaUrl: null,
          site: null,
          engineSite: null,
        }
        : {
          name: 'Donut Browser / Wayfern',
          metaUrl: WAYFERN_META,
          site: 'https://donutbrowser.com',
          engineSite: 'https://wayfern.com',
        },
      note: openBrowserDefault
        ? 'macOS x86 默认使用 OpenBrowser 148 独立内核（kernels/openbrowser/）。无需从 Donut 下载 Wayfern。'
        : '独立内核默认对接 Donut 官方 Wayfern 更新源（donutbrowser.com/wayfern.json）。引擎由 Wayfern 分发，使用即表示同意其服务条款。',
    };
  }

  /**
   * Fetch Donut official feed and resolve download for this platform.
   * @returns {{ version, url, platform, source }}
   */
  async fetchOfficialRelease() {
    this.onProgress({ phase: 'meta', message: '查询 Donut 官方 Wayfern 版本…' });
    let data;
    try {
      data = await fetchJson(WAYFERN_META);
    } catch (err) {
      throw new Error('无法访问 Donut 官方内核源：' + (err.message || err));
    }
    const version = String(data.version || '').trim();
    if (!version) throw new Error('Donut wayfern.json 缺少 version 字段');

    const platform = donutPlatformKey();
    const downloads = data.downloads || {};
    const url = downloads[platform] || null;

    if (url) {
      return { version, url, platform, source: SOURCE_WAYFERN, raw: data };
    }

    // Platform missing (e.g. macos-x64 null) → Chrome for Testing fallback
    this.onProgress({ phase: 'meta', message: `Wayfern 暂无 ${platform} 包，回退 Chrome for Testing…` });
    const cft = await fetchJson(CFT_META);
    const stable = cft.channels?.Stable;
    if (!stable) throw new Error('无法获取 Chrome for Testing 稳定版信息');
    const cftPlat = cftPlatformKey();
    const entry = (stable.downloads?.chrome || []).find((d) => d.platform === cftPlat);
    if (!entry?.url) {
      throw new Error(
        `当前平台无可用内核：Wayfern 无 ${platform} 下载，Chrome for Testing 也无 ${cftPlat}。`
      );
    }
    return {
      version: stable.version,
      url: entry.url,
      platform: cftPlat,
      source: SOURCE_CFT,
      raw: { wayfern: data, cft: stable },
    };
  }

  async ensureLatest(force = false) {
    if (!this.installPromise) {
      this.installPromise = this.ensureLatestInternal(force).finally(() => { this.installPromise = null; });
    }
    return this.installPromise;
  }

  async ensureLatestInternal(force = false) {
    await this.loadMeta();
    const existing = this.resolveInstalled();

    // macOS x86 default kernel: never auto-replace OpenBrowser 148 with Wayfern/CfT
    // unless the caller force-downloads (manual "下载/更新" with force).
    if (existing && existing.source === SOURCE_OPENBROWSER && !force) {
      this.meta.binary = existing.path;
      this.meta.version = existing.version || OPENBROWSER_KERNEL_VERSION;
      this.meta.source = SOURCE_OPENBROWSER;
      this.meta.platform = donutPlatformKey();
      this.meta.downloadUrl = null;
      this.meta.updatedAt = new Date().toISOString();
      await this.saveMeta();
      this.onProgress({
        phase: 'done',
        message: `使用 OpenBrowser 148 默认内核 ${existing.version || OPENBROWSER_KERNEL_VERSION}`,
        version: existing.version || OPENBROWSER_KERNEL_VERSION,
        binary: existing.path,
      });
      return existing;
    }

    // macOS x86 with no kernel yet: do not silently download Wayfern/CfT as default.
    // Prefer in-repo / resourceRoots kernels/openbrowser (source-tree testing).
    // Never seed openbrowser-148 on other platforms.
    if (!existing && isOpenBrowser148SupportedHost() && !force) {
      const seed = findOpenBrowserKernelBinary(this.kernelsRoot, this.resourceRoots);
      if (seed) {
        const trusted = this.safeCustomBinary(seed);
        if (trusted) {
          this.meta.binary = trusted;
          this.meta.version = OPENBROWSER_KERNEL_VERSION;
          this.meta.source = SOURCE_OPENBROWSER;
          this.meta.platform = donutPlatformKey();
          this.meta.downloadUrl = null;
          this.meta.updatedAt = new Date().toISOString();
          await this.saveMeta();
          this.onProgress({
            phase: 'done',
            message: `使用源码/资源树 OpenBrowser 148 内核 ${OPENBROWSER_KERNEL_VERSION}`,
            version: OPENBROWSER_KERNEL_VERSION,
            binary: trusted,
          });
          return {
            name: kernelDisplayName(SOURCE_OPENBROWSER),
            path: trusted,
            version: OPENBROWSER_KERNEL_VERSION,
            independent: true,
            source: SOURCE_OPENBROWSER,
          };
        }
      }
      throw new Error(
        'macOS x86 默认内核 OpenBrowser 148 未安装。请将内核放到：'
        + path.join(this.kernelsRoot, 'openbrowser')
        + ' 或源码目录 Browserapp/kernels/openbrowser，'
        + '或设置环境变量 OPENBROWSER_KERNEL_ROOT，'
        + '或在本地设置中选择自定义内核。'
      );
    }

    let release;
    try {
      release = await this.fetchOfficialRelease();
    } catch (err) {
      if (existing && !force) {
        this.onProgress({ phase: 'done', message: '离线：使用已安装内核', version: existing.version });
        return existing;
      }
      throw err;
    }

    this.meta.remoteVersion = release.version;

    if (existing && !force) {
      // Skip re-download when same channel version already present
      if (
        existing.source === release.source
        && existing.version
        && compareVersions(existing.version, release.version) >= 0
      ) {
        this.onProgress({
          phase: 'done',
          message: `已是最新 ${existing.version}（${release.source === SOURCE_WAYFERN ? 'Donut Wayfern' : 'CfT'}）`,
          version: existing.version,
          binary: existing.path,
        });
        await this.saveMeta();
        return existing;
      }
      // Older install → upgrade
      if (existing.version && compareVersions(release.version, existing.version) > 0) {
        this.onProgress({
          phase: 'meta',
          message: `发现新版本 ${existing.version} → ${release.version}，开始更新…`,
          version: release.version,
        });
      }
    }

    if (release.source === SOURCE_WAYFERN) {
      return this.installWayfern(release);
    }
    return this.installChromeForTesting(release);
  }

  async installWayfern(release) {
    const { version, url, platform } = release;
    const work = path.join(this.kernelsRoot, 'wayfern');
    await fsp.mkdir(this.kernelsRoot, { recursive: true });

    const kind = archiveKindFromUrl(url);
    const ext = kind === 'dmg' ? 'dmg' : kind === 'tar.xz' ? 'tar.xz' : kind === 'tar.gz' ? 'tar.gz' : 'zip';
    const archivePath = path.join(this.kernelsRoot, `wayfern-${version}-${platform}.${ext}`);

    this.onProgress({
      phase: 'download',
      message: `下载 Wayfern ${version}（Donut 官方源）…`,
      version,
      url,
    });
    await downloadFile(url, archivePath, (p) => this.onProgress({ phase: 'download', ...p, version }));

    this.onProgress({ phase: 'extract', message: '解压 Wayfern 内核…', version });
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(work, { recursive: true });

    try {
      if (kind === 'dmg') await extractDmg(archivePath, work);
      else if (kind === 'tar.xz') await extractTarXz(archivePath, work);
      else if (kind === 'tar.gz') await extractTarGz(archivePath, work);
      else await extractZip(archivePath, work);
    } catch (err) {
      throw new Error('解压 Wayfern 失败：' + (err.message || err));
    }

    const binary = await resolveWayfernBinary(work);
    const trustedBinary = safeInstalledBinary(binary, work);
    if (!trustedBinary) {
      throw new Error('解压后未找到 Wayfern 可执行文件，请检查平台包是否完整');
    }

    if (process.platform !== 'win32') {
      try { await fsp.chmod(trustedBinary, 0o755); } catch (_) {}
    }

    this.onProgress({ phase: 'validate', message: '验证已下载内核兼容性…', version, binary: trustedBinary });
    await this.probeBrowserBinary(trustedBinary);

    this.meta.binary = trustedBinary;
    this.meta.version = version;
    this.meta.platform = platform;
    this.meta.updatedAt = new Date().toISOString();
    this.meta.source = SOURCE_WAYFERN;
    this.meta.downloadUrl = url;
    this.meta.remoteVersion = version;
    await this.saveMeta();

    await fsp.rm(archivePath, { force: true }).catch(() => {});

    this.onProgress({ phase: 'done', message: 'Wayfern 内核就绪（Donut 官方）', version, binary: trustedBinary });
    return this.resolveInstalled();
  }

  async installChromeForTesting(release) {
    const { version, url } = release;
    const plat = cftPlatformKey();
    const work = path.join(this.kernelsRoot, 'chrome-for-testing');
    await fsp.mkdir(this.kernelsRoot, { recursive: true });
    const zipPath = path.join(this.kernelsRoot, `chrome-${version}-${plat}.zip`);

    this.onProgress({ phase: 'download', message: '下载 Chrome for Testing ' + version, version, url });
    await downloadFile(url, zipPath, (p) => this.onProgress({ phase: 'download', ...p, version }));

    this.onProgress({ phase: 'extract', message: '解压内核…', version });
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(work, { recursive: true });
    await extractZip(zipPath, work);

    let binary = path.join(work, chromeForTestingBinaryRelative(plat));
    if (!fs.existsSync(binary)) {
      const found = await findExecutable(work, process.platform === 'win32' ? ['chrome.exe'] : ['Google Chrome for Testing', 'chrome']);
      if (!found) throw new Error('解压后未找到浏览器可执行文件');
      binary = found;
    }
    binary = safeInstalledBinary(binary, work);
    if (!binary) throw new Error('内核可执行文件逃逸出安装目录或是符号链接');

    if (process.platform !== 'win32') {
      try { await fsp.chmod(binary, 0o755); } catch (_) {}
    }

    this.onProgress({ phase: 'validate', message: '验证已下载内核兼容性…', version, binary });
    await this.probeBrowserBinary(binary);

    this.meta.binary = binary;
    this.meta.version = version;
    this.meta.platform = plat;
    this.meta.updatedAt = new Date().toISOString();
    this.meta.source = SOURCE_CFT;
    this.meta.downloadUrl = url;
    this.meta.remoteVersion = version;
    await this.saveMeta();
    await fsp.rm(zipPath, { force: true }).catch(() => {});

    this.onProgress({ phase: 'done', message: 'Chrome for Testing 就绪', version, binary });
    return this.resolveInstalled();
  }

  async probeBrowserBinary(binaryPath) {
    const resolved = path.resolve(String(binaryPath || ''));
    if (isSystemBrowserExecutable(resolved)) throw new Error('不能选择本机已安装的 Chrome、Edge 或 Chromium 作为指纹浏览器内核');
    let stat;
    try { stat = await fsp.stat(resolved); } catch (_) { throw new Error('文件不存在: ' + resolved); }
    if (!stat.isFile()) throw new Error('内核路径必须是可执行文件: ' + resolved);
    if (process.platform !== 'win32') {
      try { await fsp.access(resolved, fs.constants.X_OK); } catch (_) { throw new Error('内核文件没有执行权限: ' + resolved); }
    }

    let versionOutput;
    try {
      const result = await execFileAsync(resolved, ['--version'], { timeout: 8000, windowsHide: true, maxBuffer: 64 * 1024 });
      versionOutput = String(result.stdout || result.stderr || '').trim();
    } catch (error) {
      throw new Error('无法执行内核版本检查：' + (error.message || error));
    }
    if (!/\b(chrome|chromium|wayfern)\b/i.test(versionOutput)) {
      throw new Error('所选文件不是受支持的 Chromium 内核: ' + (versionOutput || '未返回版本信息'));
    }

    await fsp.mkdir(this.kernelsRoot, { recursive: true });
    const probeRoot = await fsp.mkdtemp(path.join(this.kernelsRoot, '.probe-'));
    let child;
    try {
      this.onProgress({ phase: 'validate', message: '验证自定义 Chromium 内核兼容性…', binary: resolved });
      await ensureKernelReadyForLaunch({ path: resolved }, versionOutput);
      child = spawn(resolved, [
        `--user-data-dir=${probeRoot}`,
        `--disk-cache-dir=${path.join(probeRoot, 'OpenBrowserCache')}`,
        `--crash-dumps-dir=${path.join(probeRoot, 'OpenBrowserCrashReports')}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-mode',
        'about:blank',
      ], { detached: process.platform !== 'win32', windowsHide: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child._startupStdout = '';
      child._startupStderr = '';
      child.stdout?.on('data', (chunk) => { child._startupStdout = String(child._startupStdout + chunk).slice(-16 * 1024); });
      child.stderr?.on('data', (chunk) => { child._startupStderr = String(child._startupStderr + chunk).slice(-16 * 1024); });
      const port = await waitForDevToolsPort(probeRoot);
      const details = await requestJson(`http://127.0.0.1:${port}/json/version`);
      if (!/\b(chrome|chromium|wayfern)\b/i.test(String(details.Browser || ''))) {
        throw new Error('CDP 返回的浏览器不是 Chromium 兼容内核');
      }
      const version = String(details.Browser || versionOutput).match(/(\d+(?:\.\d+){1,3})/)?.[1] || 'custom';
      return { path: resolved, version, browser: String(details.Browser), protocolVersion: String(details['Protocol-Version'] || '') };
    } catch (error) {
      const output = startupOutput(child);
      const status = child && child.exitCode !== null && child.exitCode !== undefined
        ? ` exitCode=${child.exitCode}${child.signalCode ? ` signal=${child.signalCode}` : ''}`
        : '';
      throw new Error('内核兼容性验证失败：' + (error.message || error) + status + (output ? ` browserOutput=${output}` : ''));
    } finally {
      await stopProbeProcess(child).catch(() => {});
      await fsp.rm(probeRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async setCustomBinary(binaryPath) {
    const probe = await this.probeBrowserBinary(binaryPath);
    const isOpenBrowser = /[/\\]openbrowser[/\\]chrome_148[/\\]/i.test(probe.path)
      || path.basename(path.dirname(probe.path)) === 'MacOS' && /OpenBrowser$/i.test(path.basename(probe.path));
    this.meta.binary = probe.path;
    this.meta.version = probe.version || (isOpenBrowser ? OPENBROWSER_KERNEL_VERSION : probe.version);
    this.meta.source = isOpenBrowser ? SOURCE_OPENBROWSER : SOURCE_CUSTOM;
    this.meta.updatedAt = new Date().toISOString();
    this.meta.platform = donutPlatformKey();
    this.meta.downloadUrl = null;
    await this.saveMeta();
    return { ...this.resolveInstalled(), validation: probe };
  }

  /** Check remote without downloading. */
  async checkUpdate() {
    await this.loadMeta();
    const installed = this.resolveInstalled();
    // OpenBrowser 148 is the pinned default on mac x64 — not auto-updated via Wayfern feed
    if (installed?.source === SOURCE_OPENBROWSER) {
      return {
        installed,
        remote: {
          version: installed.version || OPENBROWSER_KERNEL_VERSION,
          source: SOURCE_OPENBROWSER,
          url: null,
          platform: donutPlatformKey(),
        },
        needsUpdate: false,
        upToDate: true,
      };
    }
    try {
      const release = await this.fetchOfficialRelease();
      this.meta.remoteVersion = release.version;
      await this.saveMeta();
      const needsUpdate = !installed
        || installed.source !== release.source
        || compareVersions(release.version, installed.version || '0') > 0;
      return {
        installed,
        remote: { version: release.version, source: release.source, url: release.url, platform: release.platform },
        needsUpdate,
        upToDate: Boolean(installed) && !needsUpdate,
      };
    } catch (error) {
      return { installed, remote: null, needsUpdate: false, upToDate: Boolean(installed), error: error.message };
    }
  }
}

module.exports = {
  BrowserKernelManager,
  platformKey: donutPlatformKey,
  donutPlatformKey,
  cftPlatformKey,
  chromeBinaryRelative: chromeForTestingBinaryRelative,
  openBrowserKernelBinaryRelative,
  findOpenBrowserKernelBinary,
  isMacX64Host,
  isOpenBrowser148SupportedHost,
  WAYFERN_META,
  CFT_META,
  SOURCE_WAYFERN,
  SOURCE_CFT,
  SOURCE_CUSTOM,
  SOURCE_OPENBROWSER,
  OPENBROWSER_KERNEL_VERSION,
  isWayfernKernel,
  termsAcceptanceArgsForKernel,
  ensureKernelReadyForLaunch,
  compareVersions,
  validateArchiveMemberName,
  safeInstalledBinary,
  findWayfernKernelBinary,
  findBundledWayfernKernel,
  bundledKernelVersion,
  downloadFile,
  extractZip,
  extractDmg,
  extractTarXz,
  extractTarGz,
  archiveKindFromUrl,
  resolveWayfernBinary,
};
