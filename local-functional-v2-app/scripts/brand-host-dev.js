#!/usr/bin/env node
/**
 * Fully rebrand the local desktop host bundle for development:
 *   *.app → OpenBrowser.app
 *   MacOS binary → OpenBrowser
 *   Info.plist + icons + path.txt
 * So Dock / Cmd-Tab show OpenBrowser, not the stock host name.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const appRoot = path.join(__dirname, '..');
const logoIcns = path.join(appRoot, 'assets', 'logo.icns');
const shellRoot = path.join(appRoot, 'node_modules', 'desktop-shell');
const distRoot = path.join(shellRoot, 'dist');
const pathFile = path.join(shellRoot, 'path.txt');

function log(msg) {
  console.log('[brand]', msg);
}

function findApp(dist) {
  if (!fs.existsSync(dist)) return null;
  const names = fs.readdirSync(dist).filter((n) => n.endsWith('.app'));
  // Prefer already-branded
  const preferred = names.find((n) => n === 'OpenBrowser.app') || names[0];
  return preferred ? path.join(dist, preferred) : null;
}

function rewritePlist(plistPath) {
  let plist = fs.readFileSync(plistPath, 'utf8');
  const pairs = [
    ['CFBundleDisplayName', 'OpenBrowser'],
    ['CFBundleName', 'OpenBrowser'],
    ['CFBundleExecutable', 'OpenBrowser'],
    ['CFBundleIdentifier', 'com.openbrowser.app'],
    ['CFBundleIconFile', 'logo'],
  ];
  for (const [key, value] of pairs) {
    const re = new RegExp(`<key>${key}<\\/key>\\s*<string>[^<]*<\\/string>`);
    if (re.test(plist)) {
      plist = plist.replace(re, `<key>${key}</key>\n\t<string>${value}</string>`);
    } else if (key === 'CFBundleIconFile') {
      plist = plist.replace('</dict>\n</plist>', `\t<key>${key}</key>\n\t<string>${value}</string>\n</dict>\n</plist>`);
    }
  }
  fs.writeFileSync(plistPath, plist, 'utf8');
}

function brand() {
  if (process.platform !== 'darwin') {
    log('non-macOS host; skip');
    return;
  }

  if (!fs.existsSync(distRoot)) {
    log('dist missing; skip');
    return;
  }

  let hostApp = findApp(distRoot);
  if (!hostApp) {
    log('no .app bundle; skip');
    return;
  }

  // 1) Rename bundle → OpenBrowser.app
  const targetApp = path.join(distRoot, 'OpenBrowser.app');
  if (path.basename(hostApp) !== 'OpenBrowser.app') {
    if (fs.existsSync(targetApp)) fs.rmSync(targetApp, { recursive: true, force: true });
    fs.renameSync(hostApp, targetApp);
    log(`renamed ${path.basename(hostApp)} → OpenBrowser.app`);
    hostApp = targetApp;
  }

  const macosDir = path.join(hostApp, 'Contents', 'MacOS');
  const resourcesDir = path.join(hostApp, 'Contents', 'Resources');
  const plistPath = path.join(hostApp, 'Contents', 'Info.plist');

  // 2) Rename executable → OpenBrowser
  if (fs.existsSync(macosDir)) {
    const bins = fs.readdirSync(macosDir);
    const openBin = path.join(macosDir, 'OpenBrowser');
    if (!fs.existsSync(openBin)) {
      const source = bins.find((n) => n !== 'OpenBrowser') || bins[0];
      if (source) {
        fs.renameSync(path.join(macosDir, source), openBin);
        log(`renamed binary ${source} → OpenBrowser`);
      }
    }
    try {
      fs.chmodSync(openBin, 0o755);
    } catch (_) { /* ignore */ }
  }

  // 3) Info.plist
  if (fs.existsSync(plistPath)) {
    rewritePlist(plistPath);
    log('Info.plist → OpenBrowser');
  }

  // 4) Icons
  if (fs.existsSync(logoIcns) && fs.existsSync(resourcesDir)) {
    fs.copyFileSync(logoIcns, path.join(resourcesDir, 'logo.icns'));
    for (const name of fs.readdirSync(resourcesDir)) {
      if (name.endsWith('.icns')) {
        try {
          fs.copyFileSync(logoIcns, path.join(resourcesDir, name));
        } catch (_) { /* ignore */ }
      }
    }
    log('icons updated');
  }

  // 5) path.txt so require('desktop-shell') points at branded binary
  const relative = 'OpenBrowser.app/Contents/MacOS/OpenBrowser';
  fs.writeFileSync(pathFile, relative, 'utf8');
  log(`path.txt → ${relative}`);

  // 6) Refresh LaunchServices so Dock picks up the new name
  try {
    spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', [
      '-f',
      '-R',
      '-trusted',
      hostApp,
    ], { stdio: 'ignore' });
    log('LaunchServices refreshed');
  } catch (_) { /* ignore */ }
}

brand();
module.exports = { brand };
