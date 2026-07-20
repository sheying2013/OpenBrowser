'use strict';

/**
 * Independent Chromium kernel manager.
 *
 * Runtime policy: resolve integrated seeds under Browserapp/kernels/ only.
 * Auto-download is disabled. Custom user-selected Chromium binaries remain allowed.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { execFile, spawn } = require('child_process');
const { createWriteStream } = require('fs');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { isSystemBrowserExecutable } = require('./isolation');

/** Optional remote kernel feed URL (unused when integrated seeds are present). */
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
  // Flat integrated layout: Browserapp/kernels/macos-x64/...
  // Compat: kernels/openbrowser -> macos-x64 symlink still works via candidates.
  return path.join(
    'macos-x64',
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
 * Preferred layout: kernels/macos-x64/chrome_148/openbrowser_148/OpenBrowser.app/Contents/MacOS/OpenBrowser
 * Compat layout:   kernels/openbrowser/... (symlink or legacy tree)
 * Returns null on non-macOS-x64 hosts so a stray kernels tree cannot be selected.
 */
function findOpenBrowserKernelBinary(kernelsRoot, extraRoots = []) {
  if (!isOpenBrowser148SupportedHost()) return null;
  const rel = openBrowserKernelBinaryRelative();
  const legacyRel = path.join(
    'openbrowser',
    'chrome_148',
    'openbrowser_148',
    'OpenBrowser.app',
    'Contents',
    'MacOS',
    'OpenBrowser'
  );
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
    // root is .../kernels → flat seed
    candidates.push(path.join(root, rel));
    // legacy kernels/openbrowser/...
    candidates.push(path.join(root, legacyRel));
    // root is the seed dir itself (macos-x64 or openbrowser)
    candidates.push(path.join(root, 'chrome_148', 'openbrowser_148', 'OpenBrowser.app', 'Contents', 'MacOS', 'OpenBrowser'));
    // root is app/source dir
    candidates.push(path.join(root, 'kernels', rel));
    candidates.push(path.join(root, 'kernels', legacyRel));
    // process.resourcesPath / resources/app
    candidates.push(path.join(root, 'app', 'kernels', rel));
    candidates.push(path.join(root, 'app', 'kernels', legacyRel));
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
  if (source === SOURCE_WAYFERN) return 'Independent kernel';
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
    // Flat integrated seeds (no "wayfern" segment in path)
    || /(?:^|\/)kernels\/(?:windows-x64|macos-arm64)(?:\/|$)/.test(binaryPath)
    || /(?:^|\/)(?:windows-x64|macos-arm64)\/(?:chrome\.exe|wayfern(?:\.exe)?|chromium(?:\.exe)?)$/.test(binaryPath)
    || /\bwayfern\b/.test(version);
}

/**
 * Locate companion library that hosts CDP session policy for integrated kernels.
 * Windows: chrome.dll next to chrome.exe
 * macOS arm64: Wayfern Framework inside .app
 */
function companionLibraryForKernelBinary(binaryPath = '') {
  const binary = path.resolve(String(binaryPath || ''));
  if (!binary || !fs.existsSync(binary)) return null;
  const dir = path.dirname(binary);
  const base = path.basename(binary).toLowerCase();
  if (process.platform === 'win32' || /\.exe$/i.test(binary)) {
    const dll = path.join(dir, 'chrome.dll');
    return fs.existsSync(dll) ? dll : null;
  }
  // .../Wayfern.app/Contents/MacOS/Wayfern → Frameworks/.../Wayfern Framework
  if (/\/Contents\/MacOS\//i.test(binary.replace(/\\/g, '/'))) {
    const contents = path.resolve(dir, '..');
    const versions = path.join(contents, 'Frameworks', 'Wayfern Framework.framework', 'Versions');
    if (fs.existsSync(versions)) {
      let ver = 'Current';
      try {
        const names = fs.readdirSync(versions).filter((n) => n !== 'Current');
        if (names.length) ver = names.sort().reverse()[0];
      } catch (_) {}
      const fw = path.join(versions, ver, 'Wayfern Framework');
      if (fs.existsSync(fw)) return fw;
      const cur = path.join(versions, 'Current', 'Wayfern Framework');
      if (fs.existsSync(cur)) return cur;
    }
  }
  // binary is already the framework dylib
  if (/Wayfern Framework$/i.test(base) || /Chromium Framework$/i.test(base)) return binary;
  return null;
}

/** Byte markers that must be present for local CDP session policy on integrated kernels. */
const INTEGRATED_KERNEL_CDP_MARKERS = Object.freeze({
  // chrome.dll 149.0.7827.114 (windows-x64 seed)
  'win-chrome-dll-149': [
    { fo: 0x37e6551, bytes: Buffer.from('909090909090', 'hex') },
    { fo: 0x41fddd0, bytes: Buffer.from('b001c3', 'hex') },
  ],
  // Wayfern Framework 149.0.7827.114 (macos-arm64 seed)
  'mac-framework-149': [
    { fo: 0x2d0c2d4, bytes: Buffer.from('1f2003d5', 'hex') },
    { fo: 0x3504df8, bytes: Buffer.from('20008052c0035fd6', 'hex') },
  ],
});

function readFileSlice(filePath, offset, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, offset);
    return n === length ? buf : null;
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

function markersMatch(filePath, markers) {
  if (!filePath || !fs.existsSync(filePath) || !Array.isArray(markers) || !markers.length) return false;
  try {
    const st = fs.statSync(filePath);
    for (const m of markers) {
      const fo = Number(m.fo);
      const expect = Buffer.isBuffer(m.bytes) ? m.bytes : Buffer.from(String(m.bytes || ''), 'hex');
      if (!Number.isFinite(fo) || fo < 0 || !expect.length) return false;
      if (st.size < fo + expect.length) return false;
      const got = readFileSlice(filePath, fo, expect.length);
      if (!got || !got.equals(expect)) return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * True when the integrated kernel binary is ready for local CDP / RPA.
 * openbrowser-148 and custom Chromium are treated as ready (no companion markers).
 * Windows/macOS-arm integrated seeds require companion library markers.
 */
function isIntegratedKernelCdpReady(candidate = {}) {
  const binary = String(candidate.path || candidate.binary || candidate || '').trim();
  if (!binary || !fs.existsSync(binary)) return false;
  const source = String(candidate.source || '').toLowerCase();
  if (source === SOURCE_OPENBROWSER || source === SOURCE_CUSTOM || source === SOURCE_CFT) return true;
  if (isOpenBrowser148SupportedHost() && /openbrowser_148|kernels[/\\](macos-x64|openbrowser)[/\\]/i.test(binary)) {
    return true;
  }
  if (!isWayfernKernel({ path: binary, source })) {
    // Unknown independent Chromium — allow (custom-like)
    return true;
  }
  const lib = companionLibraryForKernelBinary(binary);
  if (!lib) return false;
  const lower = lib.toLowerCase().replace(/\\/g, '/');
  if (lower.endsWith('chrome.dll')) {
    return markersMatch(lib, INTEGRATED_KERNEL_CDP_MARKERS['win-chrome-dll-149']);
  }
  if (/wayfern framework$|chromium framework$/i.test(path.basename(lib))) {
    return markersMatch(lib, INTEGRATED_KERNEL_CDP_MARKERS['mac-framework-149']);
  }
  return false;
}

function termsAcceptanceArgsForKernel(candidate = {}, versionOutput = '') {
  return isWayfernKernel(candidate, versionOutput) ? [WAYFERN_ACCEPT_TERMS_ARG] : [];
}

function wayfernLicenseAcceptedPath() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'Wayfern', 'license-accepted');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Wayfern', 'license-accepted');
  }
  return path.join(os.homedir(), '.config', 'Wayfern', 'license-accepted');
}

function wayfernTermsAlreadyAccepted() {
  try {
    return fs.existsSync(wayfernLicenseAcceptedPath());
  } catch (_) {
    return false;
  }
}

function looksLikeTermsAcceptedOutput(text = '') {
  return /Terms and Conditions accepted|License recorded|You can now run Wayfern normally/i.test(String(text || ''));
}

async function ensureKernelReadyForLaunch(candidate = {}, versionOutput = '') {
  const binary = String(candidate.path || candidate.binary || candidate || '').trim();
  if (!binary) throw new Error('内核不可用：缺少内核路径');

  // Integrated Windows/mac-arm seeds must be CDP-ready before spawn (RPA / Local API).
  if (isWayfernKernel({ ...candidate, path: binary }, versionOutput)
    && !isIntegratedKernelCdpReady({ ...candidate, path: binary })) {
    throw new Error(
      '独立内核未就绪（CDP 会话策略不匹配）。请使用安装包内 kernels/windows-x64 或 kernels/macos-arm64 的完整内核，'
      + '并删除 userData 下过期的 kernels 副本后重试。'
      + ` binary=${binary}`
    );
  }

  const args = termsAcceptanceArgsForKernel(candidate, versionOutput);
  if (!args.length) return false;

  const cacheKey = [path.resolve(binary), process.env.APPDATA || process.env.HOME || ''].join('\0');
  if (acceptedWayfernTerms.has(cacheKey) || wayfernTermsAlreadyAccepted()) {
    acceptedWayfernTerms.add(cacheKey);
    return true;
  }

  try {
    // One-shot accept process: it is expected to exit after writing license-accepted.
    // Do NOT pass this flag to the long-lived browser spawn.
    const { stdout, stderr } = await execFileAsync(binary, args, {
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    acceptedWayfernTerms.add(cacheKey);
    return true;
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' | ');
    // Some builds exit non-zero after successfully recording the license.
    if (looksLikeTermsAcceptedOutput(output) || wayfernTermsAlreadyAccepted()) {
      acceptedWayfernTerms.add(cacheKey);
      return true;
    }
    throw new Error('内核条款初始化失败：' + (output || 'accept-terms command failed'));
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
    const req = https.get(parsed, { headers: { 'User-Agent': 'OpenBrowser/1.0 (kernel)' }, timeout: 30000 }, (res) => {
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
      const req = https.get(parsed, { headers: { 'User-Agent': 'OpenBrowser/1.0 (kernel)' }, timeout: 60000 }, (res) => {
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
 * High-level DMG extract helper for macOS kernel archives.
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
    // Prefer .app → Contents/MacOS/{primary|Chromium}
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

/** Platform seed dir names under kernels/ (no cross-arch fallback on macOS). */
function wayfernSeedDirNames(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    // WoA can still run x64 builds under emulation in some setups; prefer native first.
    return arch === 'arm64' ? ['windows-arm64', 'windows-x64'] : ['windows-x64'];
  }
  if (platform === 'darwin') {
    // arm64 and x64 Mach-O are not interchangeable — never fall back across arch.
    return arch === 'arm64' ? ['macos-arm64'] : ['macos-x64'];
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? ['linux-arm64'] : ['linux-x64'];
  }
  return [];
}

function isForeignWayfernSeedDir(name, platform = process.platform, arch = process.arch) {
  const n = String(name || '').toLowerCase();
  if (!/^(windows|macos|linux)-(x64|arm64)$/.test(n)) return false;
  const allowed = new Set(wayfernSeedDirNames(platform, arch));
  return !allowed.has(n);
}

function findWayfernKernelBinary(root) {
  const base = path.resolve(String(root || ''));
  if (!fs.existsSync(base)) return null;
  const names = process.platform === 'win32'
    ? ['wayfern.exe', 'chromium.exe', 'chrome.exe']
    : ['wayfern', 'chromium', 'chrome', 'Wayfern', 'Chromium'];
  const walk = (dir, depth, skipForeignSeeds) => {
    if (depth > 8) return null;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && skipForeignSeeds && isForeignWayfernSeedDir(entry.name)) {
        continue;
      }
      if (entry.isDirectory() && entry.name.endsWith('.app')) {
        const macos = path.join(full, 'Contents', 'MacOS');
        const hit = fs.existsSync(macos) ? walk(macos, depth + 1, false) : null;
        if (hit) return hit;
      } else if (entry.isFile() && names.some((name) => entry.name.toLowerCase() === name.toLowerCase())) {
        return full;
      } else if (entry.isDirectory() && !['Frameworks', 'Helpers', 'resources', 'locales', 'Resources'].includes(entry.name)) {
        const hit = walk(full, depth + 1, false);
        if (hit) return hit;
      }
    }
    return null;
  };
  // Prefer nested platform seeds before a deep walk of the whole tree (avoids
  // picking the wrong arch seed when multiple seeds exist).
  for (const seed of wayfernSeedDirNames()) {
    const seedRoot = path.join(base, seed);
    if (!fs.existsSync(seedRoot)) continue;
    const hit = walk(seedRoot, 0, false);
    if (hit) return hit;
  }
  return walk(base, 0, true);
}

function findBundledWayfernKernel(resourceRoots = []) {
  const roots = [];
  const addRoot = (root) => {
    if (!root) return;
    const value = path.resolve(String(root));
    if (!roots.includes(value)) roots.push(value);
  };
  for (const root of resourceRoots || []) {
    // Preferred flat layout: Browserapp/kernels/{windows-x64|macos-arm64}
    for (const seed of wayfernSeedDirNames()) {
      addRoot(path.join(root, 'kernels', seed));
      addRoot(path.join(root, 'app', 'kernels', seed));
      addRoot(path.join(root, seed));
    }
    // Compat: legacy nested platform seed paths (symlink tree)
    addRoot(path.join(root, 'kernels', 'wayfern'));
    addRoot(path.join(root, 'app', 'kernels', 'wayfern'));
    for (const seed of wayfernSeedDirNames()) {
      addRoot(path.join(root, 'kernels', 'wayfern', seed));
      addRoot(path.join(root, 'app', 'kernels', 'wayfern', seed));
    }
    // Legacy staging directory (should not ship)
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
  const tryFiles = [];
  if (root) {
    tryFiles.push(path.join(root, 'kernel.json'));
    // binary may live one level deeper than seed root
    tryFiles.push(path.join(root, '..', 'kernel.json'));
  }
  for (const file of tryFiles) {
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      const version = String(manifest.version || '').trim();
      if (version) return version;
    } catch (_) {}
  }
  return 'bundled';
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
    // macOS x64 default only: OpenBrowser 148 under kernels/macos-x64/ (wrapper binary).
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

    // Prefer install-tree / resource integrated seeds that are CDP-ready.
    // Stale userData kernels (unpatched companion libs) must not win over the package seed.
    const bundled = findBundledWayfernKernel(this.resourceRoots);
    if (bundled) {
      const trustedBundled = safeInstalledBinary(bundled.binary, bundled.root);
      if (trustedBundled && isIntegratedKernelCdpReady({ path: trustedBundled, source: SOURCE_WAYFERN })) {
        return {
          name: kernelDisplayName(SOURCE_WAYFERN),
          path: trustedBundled,
          version: bundledKernelVersion(bundled.root),
          independent: true,
          source: SOURCE_WAYFERN,
        };
      }
    }

    if (this.meta.binary && fs.existsSync(this.meta.binary)) {
      const src = this.meta.source || SOURCE_WAYFERN;
      // Refuse stale openbrowser-148 meta on non-mac-x64 hosts.
      if (src === SOURCE_OPENBROWSER && !isOpenBrowser148SupportedHost()) {
        // fall through
      } else {
        const trusted = (src === SOURCE_CUSTOM || src === SOURCE_OPENBROWSER)
          ? this.safeCustomBinary(this.meta.binary)
          : safeInstalledBinary(this.meta.binary, this.kernelsRoot);
        if (trusted) {
          // Skip userData / meta binaries that fail CDP readiness when a better seed exists.
          const ready = isIntegratedKernelCdpReady({ path: trusted, source: src });
          if (ready || src === SOURCE_CUSTOM || src === SOURCE_CFT || src === SOURCE_OPENBROWSER) {
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
    }

    // Fall back to bundled even if marker check failed (still better than nothing; launch will re-check).
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

    // Scan integrated seeds under userData/kernels/{platform} (+ legacy compat paths)
    try {
      let found = null;
      let foundRoot = null;
      for (const seed of wayfernSeedDirNames()) {
        const seedRoot = path.join(this.kernelsRoot, seed);
        found = findWayfernKernelBinary(seedRoot);
        if (found) { foundRoot = seedRoot; break; }
        const compat = path.join(this.kernelsRoot, 'wayfern', seed);
        found = findWayfernKernelBinary(compat);
        if (found) { foundRoot = compat; break; }
      }
      if (!found) {
        const wayfernDir = path.join(this.kernelsRoot, 'wayfern');
        found = findWayfernKernelBinary(wayfernDir);
        if (found) foundRoot = wayfernDir;
      }
      const trusted = safeInstalledBinary(found, foundRoot || this.kernelsRoot);
      if (trusted && isIntegratedKernelCdpReady({ path: trusted, source: SOURCE_WAYFERN })) {
        return {
          name: kernelDisplayName(SOURCE_WAYFERN),
          path: trusted,
          version: this.meta.version || bundledKernelVersion(foundRoot || this.kernelsRoot),
          independent: true,
          source: SOURCE_WAYFERN,
        };
      }
    } catch (_) {}

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
    const wayfernIntegrated = !openBrowserDefault
      && Boolean(installed && installed.source === SOURCE_WAYFERN);
    return {
      platform: donutPlatformKey(),
      cftPlatform: cftPlatformKey(),
      kernelsRoot: this.kernelsRoot,
      installed: Boolean(installed),
      kernel: installed,
      meta: this.meta,
      autoDownload: false,
      channel: openBrowserDefault
        ? {
          name: 'OpenBrowser 148（macOS x86 内置）',
          metaUrl: null,
          site: null,
          engineSite: null,
        }
        : {
          name: '独立内核（安装包内置）',
          metaUrl: null,
          site: null,
          engineSite: null,
        },
      note: openBrowserDefault
        ? 'macOS x86 使用安装包/源码内置的 OpenBrowser 148（kernels/macos-x64/）。运行时不再自动下载内核。'
        : wayfernIntegrated
          ? 'Windows x64 / macOS arm64 使用安装包内置 Wayfern（kernels/windows-x64 或 kernels/macos-arm64）。运行时不再自动下载内核。'
          : '未发现内置独立内核。请确认安装包包含 kernels/{macos-x64|windows-x64|macos-arm64}/，或在本地设置中选择自定义 Chromium。运行时不会自动下载内核。',
    };
  }

  /**
   * Fetch optional remote kernel feed and resolve download for this platform.
   * @returns {{ version, url, platform, source }}
   */
  async fetchOfficialRelease() {
    this.onProgress({ phase: 'meta', message: '查询远程内核版本…' });
    let data;
    try {
      data = await fetchJson(WAYFERN_META);
    } catch (err) {
      throw new Error('无法访问远程内核源：' + (err.message || err));
    }
    const version = String(data.version || '').trim();
    if (!version) throw new Error('远程内核元数据缺少 version 字段');

    const platform = donutPlatformKey();
    const downloads = data.downloads || {};
    const url = downloads[platform] || null;

    if (url) {
      return { version, url, platform, source: SOURCE_WAYFERN, raw: data };
    }

    // Platform missing (e.g. macos-x64 null) → Chrome for Testing fallback
    this.onProgress({ phase: 'meta', message: `当前平台无专用内核包，回退 Chrome for Testing…` });
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

  /**
   * Resolve integrated / already-local independent kernel only.
   * Never downloads remote kernels or Chrome for Testing at runtime.
   * `force` is accepted for API compatibility but does not re-download.
   */
  async ensureIntegrated(force = false) {
    await this.loadMeta();
    const existing = this.resolveInstalled();
    if (existing) {
      this.meta.binary = existing.path;
      this.meta.version = existing.version || this.meta.version || null;
      this.meta.source = existing.source || this.meta.source || SOURCE_WAYFERN;
      this.meta.platform = donutPlatformKey();
      this.meta.downloadUrl = null;
      this.meta.updatedAt = new Date().toISOString();
      await this.saveMeta();
      this.onProgress({
        phase: 'done',
        message: `使用内置独立内核 ${existing.version || ''}`.trim(),
        version: existing.version,
        binary: existing.path,
      });
      return existing;
    }

    // macOS x86: seed openbrowser-148 from resource/source tree when present.
    if (isOpenBrowser148SupportedHost()) {
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
            message: `使用内置 OpenBrowser 148 内核 ${OPENBROWSER_KERNEL_VERSION}`,
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
        'macOS x86 内置内核 OpenBrowser 148 未找到。请确认安装包/源码包含 kernels/macos-x64，'
        + '或设置 OPENBROWSER_KERNEL_ROOT，或在本地设置中选择自定义内核。'
        + (force ? '（运行时已禁用自动下载，force 无效）' : '')
      );
    }

    // Windows / macOS arm64: only integrated seeds under kernels/{platform}.
    const bundled = findBundledWayfernKernel(this.resourceRoots);
    if (bundled) {
      const trusted = safeInstalledBinary(bundled.binary, bundled.root);
      if (trusted) {
        const version = bundledKernelVersion(bundled.root);
        this.meta.binary = trusted;
        this.meta.version = version;
        this.meta.source = SOURCE_WAYFERN;
        this.meta.platform = donutPlatformKey();
        this.meta.downloadUrl = null;
        this.meta.updatedAt = new Date().toISOString();
        await this.saveMeta();
        const resolved = {
          name: kernelDisplayName(SOURCE_WAYFERN),
          path: trusted,
          version,
          independent: true,
          source: SOURCE_WAYFERN,
        };
        this.onProgress({
          phase: 'done',
          message: `使用内置 Wayfern 内核 ${version}`,
          version,
          binary: trusted,
        });
        return resolved;
      }
    }

    throw new Error(
      '未找到内置独立内核（kernels/windows-x64 或 kernels/macos-arm64）。本版本不再自动下载内核；'
      + '请使用包含对应平台内核种子的安装包，或在本地设置中选择自定义 Chromium。'
      + (force ? '（force 不会触发下载）' : '')
    );
  }

  /** @deprecated Use ensureIntegrated — runtime download path removed. */
  async ensureLatest(force = false) {
    return this.ensureIntegrated(force);
  }

  async ensureLatestInternal(force = false) {
    return this.ensureIntegrated(force);
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
      message: `下载独立内核 ${version}…`,
      version,
      url,
    });
    await downloadFile(url, archivePath, (p) => this.onProgress({ phase: 'download', ...p, version }));

    this.onProgress({ phase: 'extract', message: '解压独立内核…', version });
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(work, { recursive: true });

    try {
      if (kind === 'dmg') await extractDmg(archivePath, work);
      else if (kind === 'tar.xz') await extractTarXz(archivePath, work);
      else if (kind === 'tar.gz') await extractTarGz(archivePath, work);
      else await extractZip(archivePath, work);
    } catch (err) {
      throw new Error('解压独立内核失败：' + (err.message || err));
    }

    const binary = await resolveWayfernBinary(work);
    const trustedBinary = safeInstalledBinary(binary, work);
    if (!trustedBinary) {
      throw new Error('解压后未找到独立内核可执行文件，请检查平台包是否完整');
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

    this.onProgress({ phase: 'done', message: '独立内核就绪', version, binary: trustedBinary });
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
      ], { detached: process.platform !== 'win32', windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
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

  /**
   * Kernel update check — integrated builds do not poll remote feeds.
   * Returns local integrated status only (needsUpdate always false).
   */
  async checkUpdate() {
    await this.loadMeta();
    const installed = this.resolveInstalled();
    if (!installed) {
      return {
        installed: null,
        remote: null,
        needsUpdate: false,
        upToDate: false,
        autoDownload: false,
        error: '未找到内置独立内核；本版本不从网络自动下载内核。',
      };
    }
    return {
      installed,
      remote: {
        version: installed.version || null,
        source: installed.source || null,
        url: null,
        platform: donutPlatformKey(),
      },
      needsUpdate: false,
      upToDate: true,
      autoDownload: false,
    };
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
  companionLibraryForKernelBinary,
  isIntegratedKernelCdpReady,
  INTEGRATED_KERNEL_CDP_MARKERS,
  termsAcceptanceArgsForKernel,
  ensureKernelReadyForLaunch,
  compareVersions,
  validateArchiveMemberName,
  safeInstalledBinary,
  findWayfernKernelBinary,
  findBundledWayfernKernel,
  wayfernSeedDirNames,
  bundledKernelVersion,
  downloadFile,
  extractZip,
  extractDmg,
  extractTarXz,
  extractTarGz,
  archiveKindFromUrl,
  resolveWayfernBinary,
};
