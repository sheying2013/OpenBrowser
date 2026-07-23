#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  resolveHostDist,
  findHostAppBundle,
  findHostWindowsExe,
  findMacBinary,
} = require('./resolve-host-dist');
const { ensureHostRuntime } = require('./ensure-host-runtime');
const {
  findBundledWayfernKernel,
  isIntegratedKernelCdpReady,
  companionLibraryForKernelBinary,
} = require('../automation/browser-kernel');

const appRoot = path.resolve(__dirname, '..');
const packageArch = resolvePackageArch();
let hostDist = (() => {
  try {
    return resolveHostDist(appRoot);
  } catch (_) {
    return null;
  }
})();
const distRoot = path.join(appRoot, 'dist');

/**
 * Default packaging always ships the integrated kernel.
 * Opt out only with OPENBROWSER_PACKAGE_VARIANT=without-kernel or OPENBROWSER_BUNDLE_KERNEL=false.
 */
function packageVariant() {
  const variant = String(process.env.OPENBROWSER_PACKAGE_VARIANT || '').trim().toLowerCase();
  if (variant === 'without-kernel' || variant === 'no-kernel' || variant === 'kernel-free') {
    return 'without-kernel';
  }
  if (variant === 'with-kernel' || variant === 'kernel' || variant === '') {
    // Empty defaults to with-kernel (product default).
    if (variant === '' && String(process.env.OPENBROWSER_BUNDLE_KERNEL || 'true').toLowerCase() === 'false') {
      return 'without-kernel';
    }
    return 'with-kernel';
  }
  throw new Error('OPENBROWSER_PACKAGE_VARIANT must be with-kernel (default) or without-kernel');
}

function bundleKernelVariantEnabled() {
  return packageVariant() === 'with-kernel';
}

function packageVariantSuffix(platform = process.platform, arch = packageArch) {
  const p = String(platform || '').toLowerCase();
  const a = String(arch || '').toLowerCase();
  const isVariantPlatform = p === 'win32' || (p === 'darwin' && a === 'arm64');
  if (!isVariantPlatform) return '';
  // Default product SKU is with-kernel; keep stable artifact suffix for CI/release assets.
  return packageVariant() === 'without-kernel' ? '-without-kernel' : '-with-kernel';
}

function packageArtifactStem(platform = process.platform, arch = packageArch) {
  const p = String(platform || '').toLowerCase();
  const productPlatform = p === 'win32' ? 'Windows' : 'macOS';
  return `OpenBrowser-${productPlatform}-${arch}${packageVariantSuffix(platform, arch)}`;
}

function resolvePackageArch() {
  const raw = process.env.OPENBROWSER_PACKAGE_ARCH
    || process.env.npm_config_target_arch
    || process.env.npm_config_arch
    || process.env.ELECTRON_INSTALL_ARCH
    || os.arch();
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'x64' || normalized === 'amd64') return 'x86_64';
  if (normalized === 'aarch64') return 'arm64';
  return normalized || os.arch();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

function copyRecursive(source, destination) {
  const stats = fs.lstatSync(source);
  if (stats.isSymbolicLink()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (stats.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, stats.mode & 0o777);
}

function removeIfExists(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

/** openbrowser-148 ships only in macOS x86_64 packages. */
function shouldShipOpenBrowser148Kernel(platform = process.platform, arch = packageArch) {
  const p = String(platform || '').toLowerCase();
  const a = String(arch || '').toLowerCase();
  const isX64 = a === 'x64' || a === 'x86_64' || a === 'amd64';
  return p === 'darwin' && isX64;
}

function shouldShipIntegratedWayfern(platform = process.platform, arch = packageArch) {
  const p = String(platform || '').toLowerCase();
  const a = String(arch || '').toLowerCase();
  const supportedPlatform = (p === 'win32' && ['x86_64', 'x64', 'amd64'].includes(a))
    || (p === 'darwin' && a === 'arm64');
  return supportedPlatform && bundleKernelVariantEnabled();
}

/** @deprecated alias for shouldShipIntegratedWayfern. */
function shouldShipBundledWayfern(platform = process.platform, arch = packageArch) {
  return shouldShipIntegratedWayfern(platform, arch);
}

/**
 * App tree entries NOT copied into resources/app for this package.
 *
 * Integrated independent kernels live side-by-side under Browserapp/kernels/:
 *   - macos-x64/    OpenBrowser 148 (macOS Intel)
 *   - windows-x64/  Windows independent kernel
 *   - macos-arm64/  macOS arm64 independent kernel
 *
 * Always copy kernels/, then prune foreign platform seeds after copy.
 * Legacy bundled-kernels/ is never shipped.
 */
function appResourceExcludes() {
  return new Set(['node_modules', 'dist', '.git', 'CODE_OVERVIEW.md', 'bundled-kernels']);
}

function pruneForeignKernelSeeds(resourceApp, platform = process.platform, arch = packageArch) {
  const kernelsDir = path.join(resourceApp, 'kernels');
  if (!fs.existsSync(kernelsDir)) return;
  const shipOpenBrowser = shouldShipOpenBrowser148Kernel(platform, arch);
  const shipWayfern = shouldShipIntegratedWayfern(platform, arch);
  const a = String(arch || '').toLowerCase();
  const isWin = String(platform || '').toLowerCase() === 'win32';
  const isDarwin = String(platform || '').toLowerCase() === 'darwin';
  const isArm64 = a === 'arm64' || a === 'aarch64';

  // Keep only the platform seed for this SKU (+ shared meta/README if present).
  const keep = new Set(['meta', 'README.md']);
  if (shipOpenBrowser) {
    keep.add('macos-x64');
    keep.add('openbrowser'); // compat symlink/name
  }
  if (shipWayfern) {
    if (isWin) keep.add('windows-x64');
    if (isDarwin && isArm64) keep.add('macos-arm64');
    keep.add('wayfern'); // legacy compat path; pruned below if empty
  }

  for (const entry of fs.readdirSync(kernelsDir)) {
    if (keep.has(entry)) continue;
    fs.rmSync(path.join(kernelsDir, entry), { recursive: true, force: true });
  }

  // Strip legacy nested seed dirs to only the shipped platform.
  const wayfernDir = path.join(kernelsDir, 'wayfern');
  if (fs.existsSync(wayfernDir)) {
    if (!shipWayfern) {
      fs.rmSync(wayfernDir, { recursive: true, force: true });
    } else {
      const wayKeep = new Set(['meta', 'README.md']);
      if (isWin) wayKeep.add('windows-x64');
      if (isDarwin && isArm64) wayKeep.add('macos-arm64');
      for (const entry of fs.readdirSync(wayfernDir)) {
        if (wayKeep.has(entry)) continue;
        fs.rmSync(path.join(wayfernDir, entry), { recursive: true, force: true });
      }
    }
  }

  // Without-kernel / wrong-platform packages should not retain empty husks.
  if (!shipOpenBrowser) {
    for (const name of ['macos-x64', 'openbrowser']) {
      const p = path.join(kernelsDir, name);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
  }
  if (!shipWayfern) {
    for (const name of ['windows-x64', 'macos-arm64', 'wayfern']) {
      const p = path.join(kernelsDir, name);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
  }

  try {
    if (fs.existsSync(kernelsDir) && fs.readdirSync(kernelsDir).length === 0) {
      fs.rmSync(kernelsDir, { recursive: true, force: true });
    }
  } catch (_) {}
}

const OPENBROWSER_148_REL = path.join(
  'kernels',
  'macos-x64',
  'chrome_148',
  'openbrowser_148',
  'OpenBrowser.app',
  'Contents',
  'MacOS',
  'OpenBrowser'
);
const OPENBROWSER_148_LEGACY_REL = path.join(
  'kernels',
  'openbrowser',
  'chrome_148',
  'openbrowser_148',
  'OpenBrowser.app',
  'Contents',
  'MacOS',
  'OpenBrowser'
);

/**
 * Hard assert after copy: integrated kernels only, correct platform seed, no remote staging tree.
 */
function assertKernelPackagePolicy(resourceApp) {
  const shipOpenBrowser = shouldShipOpenBrowser148Kernel();
  const shipWayfern = shouldShipIntegratedWayfern();
  const kernelsDir = path.join(resourceApp, 'kernels');
  const openBrowserBin = fs.existsSync(path.join(resourceApp, OPENBROWSER_148_REL))
    ? path.join(resourceApp, OPENBROWSER_148_REL)
    : path.join(resourceApp, OPENBROWSER_148_LEGACY_REL);
  const integrated = findBundledWayfernKernel([resourceApp, path.join(resourceApp, 'kernels')]);
  if (fs.existsSync(path.join(resourceApp, 'bundled-kernels'))) {
    throw new Error('[package] FATAL: legacy bundled-kernels/ must not ship (use kernels/{platform} seeds)');
  }
  if (shipOpenBrowser) {
    if (!fs.existsSync(openBrowserBin)) {
      throw new Error(
        '[package] FATAL: macOS x86_64 package missing openbrowser-148 binary under kernels/macos-x64: '
        + openBrowserBin
      );
    }
    for (const foreign of ['windows-x64', 'macos-arm64']) {
      if (fs.existsSync(path.join(kernelsDir, foreign))) {
        throw new Error(`[package] FATAL: macOS x86_64 package must not include kernels/${foreign}`);
      }
    }
  } else {
    for (const name of ['macos-x64', 'openbrowser']) {
      if (fs.existsSync(path.join(kernelsDir, name))) {
        throw new Error(
          `[package] FATAL: ${name} present but this SKU is not macOS x86_64`
          + ' (platform=' + process.platform + ' arch=' + packageArch + ')'
        );
      }
    }
  }
  if (shipWayfern) {
    const expected = process.platform === 'win32' ? 'windows-x64' : 'macos-arm64';
    if (!integrated && !fs.existsSync(path.join(kernelsDir, expected))) {
      throw new Error(`[package] FATAL: missing integrated kernel seed under kernels/${expected}`);
    }
    if (!integrated) {
      throw new Error(`[package] FATAL: kernel binary not discovered under kernels/${expected}`);
    }
    // Fail packaging if companion library CDP readiness markers are missing.
    if (!isIntegratedKernelCdpReady({ path: integrated.binary || integrated.path, source: 'donut-wayfern' })) {
      const lib = companionLibraryForKernelBinary(integrated.binary || integrated.path);
      throw new Error(
        '[package] FATAL: integrated kernel is not CDP-ready for RPA/Local API'
        + ` (seed=${expected} companion=${lib || 'missing'})`
      );
    }
  } else {
    for (const name of ['windows-x64', 'macos-arm64', 'wayfern']) {
      if (fs.existsSync(path.join(kernelsDir, name))) {
        throw new Error(`[package] FATAL: kernels/${name} present on unsupported/without-kernel package`);
      }
    }
  }
}

function copyAppResources(resourceApp) {
  const excluded = appResourceExcludes();
  fs.mkdirSync(resourceApp, { recursive: true });
  for (const entry of fs.readdirSync(appRoot)) {
    if (excluded.has(entry)) continue;
    copyRecursive(path.join(appRoot, entry), path.join(resourceApp, entry));
  }
  pruneForeignKernelSeeds(resourceApp);
  // Never ship local-only kernel notes / backups / private markers
  (function stripLocalKernelNotes(root) {
    const fs = require('fs');
    const path = require('path');
    const kernels = path.join(root, 'kernels');
    if (!fs.existsSync(kernels)) return;
    const kill = (file) => { try { fs.rmSync(file, { recursive: true, force: true }); } catch (_) {} };
    kill(path.join(kernels, 'README.md'));
    const walk = (dir) => {
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/readme\.md$/i.test(ent.name) || /\.orig$/i.test(ent.name) || /unlock/i.test(ent.name) || /^OPENBROWSER_/i.test(ent.name)) kill(full);
      }
    };
    walk(kernels);
  })(resourceApp);

  console.log('[package] kernel policy: openbrowser-148=' + shouldShipOpenBrowser148Kernel()
    + ' integrated-kernel=' + shouldShipIntegratedWayfern()
    + ' auto-download=false'
    + ' arch=' + packageArch + ' platform=' + process.platform);
  assertKernelPackagePolicy(resourceApp);
}

function nsisPath(value) {
  return String(value).replace(/"/g, '$\\"');
}

function nsisGlob(value) {
  return nsisPath(path.join(value, '*'));
}

function packageWindowsInstaller(packageRoot) {
  const appVersion = require('../package.json').version || '1.0.0';
  const output = path.join(distRoot, `${packageArtifactStem()}.exe`);
  const script = path.join(distRoot, 'OpenBrowser-Windows-installer.nsi');
  const installSource = nsisGlob(packageRoot);
  const installDir = '$LOCALAPPDATA\\OpenBrowser';
  // Integrated kernels make the payload multi-hundred-MB. SOLID lzma often hits
  // NSIS "error mmapping datablock" on CI runners; zlib is larger but reliable.
  writeText(script, [
    '!include "MUI2.nsh"',
    'Name "OpenBrowser"',
    `OutFile "${nsisPath(output)}"`,
    `InstallDir "${installDir}"`,
    'RequestExecutionLevel user',
    'Unicode true',
    'SetCompressor /FINAL zlib',
    'SetDatablockOptimize off',
    '!define MUI_ABORTWARNING',
    '!insertmacro MUI_PAGE_WELCOME',
    '!insertmacro MUI_PAGE_DIRECTORY',
    '!insertmacro MUI_PAGE_INSTFILES',
    '!insertmacro MUI_PAGE_FINISH',
    '!insertmacro MUI_LANGUAGE "English"',
    'Section "OpenBrowser" SEC_MAIN',
    '  SetOutPath "$INSTDIR"',
    `  File /r "${installSource}"`,
    '  CreateDirectory "$SMPROGRAMS\\OpenBrowser"',
    '  CreateShortCut "$SMPROGRAMS\\OpenBrowser\\OpenBrowser.lnk" "$INSTDIR\\runtime\\OpenBrowser.exe" "" "$INSTDIR\\runtime\\OpenBrowser.exe" 0',
    '  CreateShortCut "$DESKTOP\\OpenBrowser.lnk" "$INSTDIR\\runtime\\OpenBrowser.exe" "" "$INSTDIR\\runtime\\OpenBrowser.exe" 0',
    '  WriteUninstaller "$INSTDIR\\Uninstall.exe"',
    '  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenBrowser" "DisplayName" "OpenBrowser"',
    '  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenBrowser" "UninstallString" \'"$INSTDIR\\Uninstall.exe"\'',
    '  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenBrowser" "QuietUninstallString" \'"$INSTDIR\\Uninstall.exe" /S\'',
    '  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenBrowser" "InstallLocation" "$INSTDIR"',
    '  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenBrowser" "DisplayIcon" "$INSTDIR\\runtime\\OpenBrowser.exe,0"',
    '  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenBrowser" "Publisher" "OpenBrowser"',
    `  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenBrowser" "DisplayVersion" "${appVersion}"`,
    '  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenBrowser" "NoModify" 1',
    '  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenBrowser" "NoRepair" 1',
    'SectionEnd',
    'Section "Uninstall"',
    '  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenBrowser"',
    '  Delete "$SMPROGRAMS\\OpenBrowser\\OpenBrowser.lnk"',
    '  RMDir "$SMPROGRAMS\\OpenBrowser"',
    '  Delete "$DESKTOP\\OpenBrowser.lnk"',
    '  RMDir /r "$INSTDIR"',
    'SectionEnd',
    '',
  ].join('\r\n'));
  try {
    run('makensis', ['/V2', script]);
  } catch (error) {
    removeIfExists(script);
    throw new Error(`NSIS installer generation failed (makensis): ${error.message}`);
  }
  removeIfExists(script);
  if (!fs.existsSync(output)) throw new Error('NSIS did not produce Windows installer: ' + output);
  console.log('Windows installer: ' + output);
}

function ensureResolvedHostDist() {
  if (!hostDist) {
    ensureHostRuntime(appRoot);
    hostDist = resolveHostDist(appRoot);
  }
  return hostDist;
}

function packageWindows() {
  const resolvedHostDist = ensureResolvedHostDist();
  const hostExe = findHostWindowsExe(resolvedHostDist);

  run(process.execPath, [path.join(__dirname, 'build-native.js'), appRoot]);

  const packageRoot = path.join(distRoot, packageArtifactStem());
  const runtimeRoot = path.join(packageRoot, 'runtime');
  const resourceApp = path.join(runtimeRoot, 'resources', 'app');
  removeIfExists(packageRoot);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  copyRecursive(resolvedHostDist, runtimeRoot);

  const mainExe = path.join(runtimeRoot, 'OpenBrowser.exe');
  const copiedHostExe = path.join(runtimeRoot, path.basename(hostExe));
  fs.renameSync(copiedHostExe, mainExe);
  run(process.execPath, [path.join(__dirname, 'brand-exe.mjs'), mainExe, path.join(appRoot, 'assets', 'logo.ico')]);

  copyAppResources(resourceApp);

  const repoRoot = path.resolve(appRoot, '..');
  for (const document of ['README.md', 'DISCLAIMER.md', 'LICENSE']) {
    const source = path.join(repoRoot, document);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(packageRoot, document));
  }
  const notice = path.join(appRoot, 'THIRD-PARTY-NOTICES.md');
  if (fs.existsSync(notice)) fs.copyFileSync(notice, path.join(packageRoot, 'THIRD-PARTY-NOTICES.md'));

  writeText(path.join(packageRoot, 'START.cmd'), [
    '@echo off',
    'setlocal',
    'for %%F in ("%~dp0runtime\\*.exe") do (',
    '  start "" "%%~fF"',
    '  exit /b 0',
    ')',
    'echo Runtime executable was not found.',
    'pause',
    'exit /b 1',
    '',
  ].join('\r\n'));

  writeText(path.join(packageRoot, '运行说明.txt'), [
    'OpenBrowser Windows 便携版',
    '',
    '1. 解压完整压缩包，不要只复制单个 EXE。',
    '2. 双击 START.cmd 启动。',
    '3. 本目录 runtime 内含 OpenBrowser 桌面主机与 Chromium 组件。',
    bundleKernelVariantEnabled()
      ? '4. 本 Windows x64 包已内置独立内核（kernels/windows-x64）；运行时不再自动下载内核。默认不会回退本机浏览器，如需回退请在“本地设置”手动选择并开启。'
      : '4. 本 Windows x64 包未启用内核变体；请使用包含内置内核的正式安装包，或在“本地设置”选择自定义 Chromium。运行时不会自动下载内核。',
    '5. 环境数据默认保存在当前 Windows 用户的 AppData\\Roaming\\openbrowser 中；也可在“本地设置”修改。',
    '6. 请勿把 Cookies、代理密码或浏览器 Profile 上传到 GitHub。',
    '',
    '本便携包不包含任何第三方商业浏览器二进制。',
    '',
  ].join('\r\n'));

  const zip = path.join(distRoot, `${packageArtifactStem()}.zip`);
  removeIfExists(zip);
  run('powershell', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath '${packageRoot.replace(/'/g, "''")}' -DestinationPath '${zip.replace(/'/g, "''")}' -CompressionLevel Optimal`]);
  console.log('便携版压缩包：' + zip);
  try {
    packageWindowsInstaller(packageRoot);
  } catch (error) {
    // Portable zip is the required artifact. Keep CI green if NSIS still chokes on huge kernels.
    console.warn('[package] NSIS installer skipped: ' + (error.message || error));
    console.warn('[package] portable zip remains available: ' + zip);
  }
  console.log('便携版目录：' + packageRoot);
}


function readProductVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
    return String(pkg.version || '1.0.0').trim() || '1.0.0';
  } catch (_) {
    return '1.0.0';
  }
}

/**
 * After rewriting Info.plist / Resources, the stock Electron linker-signed
 * signature is invalid ("code has no resources but signature indicates they
 * must be present"). Re-sign ad-hoc so Gatekeeper can open the app on Apple Silicon.
 * Optional: set OPENBROWSER_CODESIGN_IDENTITY to a Developer ID for production.
 */
function signMacAppBundle(appBundle) {
  if (process.platform !== 'darwin') return;
  if (!fs.existsSync(appBundle)) throw new Error('Missing app bundle for codesign: ' + appBundle);
  const identity = String(process.env.OPENBROWSER_CODESIGN_IDENTITY || '-').trim() || '-';
  const args = ['--force', '--deep', '--sign', identity, '--timestamp=none'];
  if (identity === '-') {
    // ad-hoc: no hardened runtime / entitlements required
  } else {
    args.push('--options', 'runtime');
  }
  args.push(appBundle);
  console.log('[package] codesign', identity === '-' ? 'ad-hoc' : identity, appBundle);
  run('codesign', args);
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', appBundle], { encoding: 'utf8' });
  if (verify.status !== 0) {
    throw new Error('codesign verify failed: ' + String(verify.stderr || verify.stdout || verify.status));
  }
  console.log('[package] codesign verify ok');
}

function packageMac() {
  const resolvedHostDist = ensureResolvedHostDist();
  const hostApp = findHostAppBundle(resolvedHostDist);

  run(process.execPath, [path.join(__dirname, 'build-native.js'), appRoot]);

  const packageRoot = path.join(distRoot, packageArtifactStem());
  const appBundle = path.join(packageRoot, 'OpenBrowser.app');
  const contents = path.join(appBundle, 'Contents');
  const macosDir = path.join(contents, 'MacOS');
  const resourcesDir = path.join(contents, 'Resources');
  const resourceApp = path.join(resourcesDir, 'app');

  removeIfExists(packageRoot);
  fs.mkdirSync(packageRoot, { recursive: true });
  copyRecursive(hostApp, appBundle);

  const hostBinary = findMacBinary(macosDir);
  const appBinary = path.join(macosDir, 'OpenBrowser');
  if (path.basename(hostBinary) !== 'OpenBrowser' && fs.existsSync(hostBinary)) {
    fs.renameSync(hostBinary, appBinary);
  }

  const productVersion = readProductVersion();
  const infoPlist = path.join(contents, 'Info.plist');
  if (fs.existsSync(infoPlist)) {
    let plist = fs.readFileSync(infoPlist, 'utf8');
    plist = plist
      .replace(/<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleDisplayName</key>\n\t<string>OpenBrowser</string>')
      .replace(/<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleName</key>\n\t<string>OpenBrowser</string>')
      .replace(/<key>CFBundleExecutable<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleExecutable</key>\n\t<string>OpenBrowser</string>')
      .replace(/<key>CFBundleIdentifier<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleIdentifier</key>\n\t<string>com.openbrowser.app</string>')
      .replace(/<key>CFBundleIconFile<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleIconFile</key>\n\t<string>logo</string>')
      .replace(/<key>CFBundleShortVersionString<\/key>\s*<string>[^<]*<\/string>/, `<key>CFBundleShortVersionString</key>\n\t<string>${productVersion}</string>`)
      .replace(/<key>CFBundleVersion<\/key>\s*<string>[^<]*<\/string>/, `<key>CFBundleVersion</key>\n\t<string>${productVersion}</string>`);
    if (!plist.includes('CFBundleIconFile')) {
      plist = plist.replace('</dict>\n</plist>', '\t<key>CFBundleIconFile</key>\n\t<string>logo</string>\n</dict>\n</plist>');
    }
    fs.writeFileSync(infoPlist, plist, 'utf8');
  }
  // App icon for Dock / Finder
  const icnsSrc = path.join(appRoot, 'assets', 'logo.icns');
  if (fs.existsSync(icnsSrc)) {
    fs.copyFileSync(icnsSrc, path.join(resourcesDir, 'logo.icns'));
    for (const name of fs.readdirSync(resourcesDir)) {
      if (name.endsWith('.icns') && name !== 'logo.icns') {
        fs.copyFileSync(icnsSrc, path.join(resourcesDir, name));
      }
    }
  }

  removeIfExists(resourceApp);
  copyAppResources(resourceApp);

  const repoRoot = path.resolve(appRoot, '..');
  for (const document of ['README.md', 'DISCLAIMER.md', 'LICENSE']) {
    const source = path.join(repoRoot, document);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(packageRoot, document));
  }
  const notice = path.join(appRoot, 'THIRD-PARTY-NOTICES.md');
  if (fs.existsSync(notice)) fs.copyFileSync(notice, path.join(packageRoot, 'THIRD-PARTY-NOTICES.md'));

  writeText(path.join(packageRoot, '启动.command'), [
    '#!/bin/bash',
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    'APP="./OpenBrowser.app"',
    'if [ ! -d "$APP" ]; then',
    '  echo "未找到 OpenBrowser.app"',
    '  exit 1',
    'fi',
    '# Clear quarantine from browser-downloaded copies (common "无法打开/已损坏" cause).',
    'xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true',
    'xattr -dr com.apple.quarantine "$0" 2>/dev/null || true',
    'open "$APP"',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(packageRoot, '启动.command'), 0o755);
  if (fs.existsSync(appBinary)) fs.chmodSync(appBinary, 0o755);

  // Must re-sign AFTER Info.plist / Resources mutations, otherwise Apple Silicon Gatekeeper rejects the app.
  signMacAppBundle(appBundle);

  const kernelNote = packageArch === 'x86_64'
    ? '3. 本包（macOS x86_64 / Intel）已内置 OpenBrowser 148 独立内核（kernels/macos-x64）；运行时不再自动下载内核。'
    : bundleKernelVariantEnabled()
      ? '3. 本包（macOS arm64）已内置独立内核（kernels/macos-arm64）；运行时不再自动下载内核。'
      : '3. 本包（macOS arm64）未启用内核变体；请使用包含内置内核的正式安装包，或在“本地设置”选择自定义 Chromium。运行时不会自动下载内核。';
  writeText(path.join(packageRoot, '运行说明.txt'), [
    'OpenBrowser macOS 版（' + packageArch + '）',
    '',
    '1. 推荐双击“启动.command”（会自动清除隔离属性），或把 OpenBrowser.app 拖到“应用程序”后再打开。',
    '2. 若提示“已损坏/无法打开”：',
    '   a) 先运行“启动.command”',
    '   b) 或在终端执行：xattr -dr com.apple.quarantine "/Applications/OpenBrowser.app"',
    '   c) 或：右键 OpenBrowser.app → 打开 → 仍要打开',
    '   d) 系统设置 → 隐私与安全性 → 仍要打开',
    kernelNote,
    '4. 默认不会自动回退到本机浏览器；如需回退，请在“本地设置”手动选择浏览器并开启。',
    '5. 环境数据默认保存在 ~/Library/Application Support/openbrowser。',
    '6. 窗口同步在 macOS 使用 CDP 页面同步 + 全局快捷键；Chrome 原生 UI（地址栏/标签栏）的原生输入镜像仅 Windows 可用。',
    '7. 请勿把 Cookies、代理密码或浏览器 Profile 上传到 GitHub。',
    '',
  ].join('\n'));

  const dmg = path.join(distRoot, `${packageArtifactStem()}.dmg`);
  removeIfExists(dmg);
  const dmgFormat = String(process.env.OPENBROWSER_MAC_DMG_FORMAT || 'UDZO').trim().toUpperCase();
  if (!['UDZO', 'ULMO'].includes(dmgFormat)) {
    throw new Error(`Unsupported macOS DMG format: ${dmgFormat}`);
  }
  run('hdiutil', ['create', '-volname', 'OpenBrowser', '-srcfolder', packageRoot, '-ov', '-format', dmgFormat, dmg]);
  console.log('macOS 安装映像：' + dmg);
  console.log('macOS 打包目录：' + packageRoot);
  console.log('主机：' + os.platform() + ' ' + os.arch());
}

if (process.platform === 'win32') packageWindows();
else if (process.platform === 'darwin') packageMac();
else {
  console.error('当前平台暂不支持 package:portable：' + process.platform);
  process.exit(1);
}
