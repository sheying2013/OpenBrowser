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
  const stats = fs.statSync(source);
  if (stats.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function removeIfExists(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function nsisPath(value) {
  return String(value).replace(/"/g, '$\\"');
}

function nsisGlob(value) {
  return nsisPath(path.join(value, '*'));
}

function packageWindowsInstaller(packageRoot) {
  const output = path.join(distRoot, `OpenBrowser-Windows-${packageArch}.exe`);
  const script = path.join(distRoot, 'OpenBrowser-Windows-installer.nsi');
  const installSource = nsisGlob(packageRoot);
  const installDir = '$LOCALAPPDATA\\OpenBrowser';
  writeText(script, [
    '!include "MUI2.nsh"',
    'Name "OpenBrowser"',
    `OutFile "${nsisPath(output)}"`,
    `InstallDir "${installDir}"`,
    'RequestExecutionLevel user',
    'Unicode true',
    'SetCompressor /SOLID lzma',
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
    'SectionEnd',
    'Section "Uninstall"',
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
    throw new Error(`NSIS 安装程序生成失败。请安装 NSIS 并确保 makensis 在 PATH 中：${error.message}`);
  }
  removeIfExists(script);
  if (!fs.existsSync(output)) throw new Error('NSIS 未生成 Windows 安装程序：' + output);
  console.log('Windows 安装程序：' + output);
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

  const packageRoot = path.join(distRoot, `OpenBrowser-Windows-${packageArch}`);
  const runtimeRoot = path.join(packageRoot, 'runtime');
  const resourceApp = path.join(runtimeRoot, 'resources', 'app');
  removeIfExists(packageRoot);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  copyRecursive(resolvedHostDist, runtimeRoot);

  const mainExe = path.join(runtimeRoot, 'OpenBrowser.exe');
  const copiedHostExe = path.join(runtimeRoot, path.basename(hostExe));
  fs.renameSync(copiedHostExe, mainExe);
  run(process.execPath, [path.join(__dirname, 'brand-exe.mjs'), mainExe, path.join(appRoot, 'assets', 'logo.ico')]);

  fs.mkdirSync(resourceApp, { recursive: true });
  const excluded = new Set(['node_modules', 'dist', '.git', 'CODE_OVERVIEW.md']);
  for (const entry of fs.readdirSync(appRoot)) {
    if (excluded.has(entry)) continue;
    copyRecursive(path.join(appRoot, entry), path.join(resourceApp, entry));
  }

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
    '4. 浏览器环境默认使用在“本地设置”下载或选择的独立内核；仅在手动开启回退时使用本机浏览器。',
    '5. 环境数据默认保存在当前 Windows 用户的 AppData\\Roaming\\openbrowser 中；也可在“本地设置”修改。',
    '6. 请勿把 Cookies、代理密码或浏览器 Profile 上传到 GitHub。',
    '',
    '本便携包不包含任何第三方商业浏览器二进制。',
    '',
  ].join('\r\n'));

  const zip = path.join(distRoot, `OpenBrowser-Windows-${packageArch}.zip`);
  removeIfExists(zip);
  run('powershell', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath '${packageRoot.replace(/'/g, "''")}' -DestinationPath '${zip.replace(/'/g, "''")}' -CompressionLevel Optimal`]);
  console.log('便携版压缩包：' + zip);
  packageWindowsInstaller(packageRoot);
  console.log('便携版目录：' + packageRoot);
}

function packageMac() {
  const resolvedHostDist = ensureResolvedHostDist();
  const hostApp = findHostAppBundle(resolvedHostDist);

  run(process.execPath, [path.join(__dirname, 'build-native.js'), appRoot]);

  const packageRoot = path.join(distRoot, `OpenBrowser-macOS-${packageArch}`);
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

  const infoPlist = path.join(contents, 'Info.plist');
  if (fs.existsSync(infoPlist)) {
    let plist = fs.readFileSync(infoPlist, 'utf8');
    plist = plist
      .replace(/<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleDisplayName</key>\n\t<string>OpenBrowser</string>')
      .replace(/<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleName</key>\n\t<string>OpenBrowser</string>')
      .replace(/<key>CFBundleExecutable<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleExecutable</key>\n\t<string>OpenBrowser</string>')
      .replace(/<key>CFBundleIdentifier<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleIdentifier</key>\n\t<string>com.openbrowser.app</string>')
      .replace(/<key>CFBundleIconFile<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleIconFile</key>\n\t<string>logo</string>');
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
  fs.mkdirSync(resourceApp, { recursive: true });
  const excluded = new Set(['node_modules', 'dist', '.git', 'CODE_OVERVIEW.md']);
  for (const entry of fs.readdirSync(appRoot)) {
    if (excluded.has(entry)) continue;
    copyRecursive(path.join(appRoot, entry), path.join(resourceApp, entry));
  }

  const repoRoot = path.resolve(appRoot, '..');
  for (const document of ['README.md', 'DISCLAIMER.md', 'LICENSE']) {
    const source = path.join(repoRoot, document);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(packageRoot, document));
  }
  const notice = path.join(appRoot, 'THIRD-PARTY-NOTICES.md');
  if (fs.existsSync(notice)) fs.copyFileSync(notice, path.join(packageRoot, 'THIRD-PARTY-NOTICES.md'));

  writeText(path.join(packageRoot, '启动.command'), [
    '#!/bin/bash',
    'cd "$(dirname "$0")"',
    'open "./OpenBrowser.app"',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(packageRoot, '启动.command'), 0o755);
  if (fs.existsSync(appBinary)) fs.chmodSync(appBinary, 0o755);

  writeText(path.join(packageRoot, '运行说明.txt'), [
    'OpenBrowser macOS 版',
    '',
    '1. 双击“启动.command”，或直接打开“OpenBrowser.app”。',
    '2. 首次打开若被 Gatekeeper 拦截，请到“系统设置 > 隐私与安全性”允许运行，或执行：',
    '   xattr -dr com.apple.quarantine "OpenBrowser.app"',
    '3. 浏览器环境默认使用在“本地设置”下载或选择的独立内核；仅在手动开启回退时使用本机浏览器。',
    '4. 环境数据默认保存在 ~/Library/Application Support/openbrowser。',
    '5. 窗口同步在 macOS 使用 CDP 页面同步 + 全局快捷键；Chrome 原生 UI（地址栏/标签栏）的原生输入镜像仅 Windows 可用。',
    '6. 请勿把 Cookies、代理密码或浏览器 Profile 上传到 GitHub。',
    '',
  ].join('\n'));

  const dmg = path.join(distRoot, `OpenBrowser-macOS-${packageArch}.dmg`);
  removeIfExists(dmg);
  run('hdiutil', ['create', '-volname', 'OpenBrowser', '-srcfolder', packageRoot, '-ov', '-format', 'UDZO', dmg]);
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
