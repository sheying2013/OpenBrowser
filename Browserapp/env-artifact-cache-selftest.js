'use strict';

// The per-environment icon extension and the macOS Dock wrapper were rebuilt from scratch on
// every launch, and rebuilding shells out to python3/Pillow (plus sips, iconutil and
// lsregister on macOS). Measured on this machine that was ~2.9s of a 7.1s warm start, all of
// it before the browser process is spawned.
//
// Both outputs are a pure function of the environment number and the kernel being wrapped, so
// they are stamped and reused. What matters is that reuse never goes stale: these checks pin
// down that the first build is complete, an unchanged environment skips the work, and any
// change to the inputs — or any missing output — forces a rebuild.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { prepareMarkerExtension } = require('./automation/env-icon');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  PASS  ' + n); passed += 1; };

(async () => {
  const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-art-'));
  const args = { profileId: 'p1', envNumber: 7, userDataPath, templateDir: null };

  // --- first build produces the full artifact ---
  const dest = await prepareMarkerExtension(args);
  const icons = [16, 32, 48, 128].map((s) => path.join(dest, `icon-${s}.png`));
  const manifest = path.join(dest, 'manifest.json');
  const stamp = path.join(dest, '.artifact-stamp');

  const built = icons.every((f) => fs.existsSync(f)) && fs.existsSync(manifest);
  if (!built) {
    // Icon generation needs python3 + Pillow; without them there is nothing to cache.
    console.log('  SKIP  icon toolchain unavailable on this host — cache behaviour not exercised');
    await fsp.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
    console.log(`\nenv-artifact-cache-selftest: ${passed} checks passed (skipped).`);
    return;
  }
  ok('first build writes all icon sizes and the manifest', built);
  ok('first build records a stamp', fs.existsSync(stamp));

  // --- an unchanged environment reuses what is on disk ---
  const before = icons.map((f) => fs.statSync(f).mtimeMs);
  const t0 = Date.now();
  await prepareMarkerExtension(args);
  const reuseMs = Date.now() - t0;
  const after = icons.map((f) => fs.statSync(f).mtimeMs);
  ok('second call does not rewrite the icons', JSON.stringify(before) === JSON.stringify(after));
  ok(`second call is fast (${reuseMs}ms — no python spawns)`, reuseMs < 250);

  // --- a different environment number must not reuse another number's icons ---
  const other = await prepareMarkerExtension({ ...args, profileId: 'p2', envNumber: 8 });
  ok('a different profile builds its own artifact', other !== dest && fs.existsSync(path.join(other, 'manifest.json')));
  const manifest8 = JSON.parse(fs.readFileSync(path.join(other, 'manifest.json'), 'utf8'));
  ok('the new artifact carries its own environment number', /8/.test(manifest8.name));

  // --- renumbering the same profile invalidates the stamp ---
  await prepareMarkerExtension({ ...args, envNumber: 9 });
  const manifest9 = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  ok('changing the environment number rebuilds', /9/.test(manifest9.name));

  // --- a missing output forces a rebuild even when the stamp is present ---
  await fsp.rm(icons[0], { force: true });
  await prepareMarkerExtension({ ...args, envNumber: 9 });
  ok('a deleted icon is regenerated', fs.existsSync(icons[0]));

  // --- a stale stamp version forces a rebuild ---
  await fsp.writeFile(stamp, 'stale', 'utf8');
  const mtimeBefore = fs.statSync(manifest).mtimeMs;
  await new Promise((r) => setTimeout(r, 15));
  await prepareMarkerExtension({ ...args, envNumber: 9 });
  ok('an unrecognised stamp forces a rebuild', fs.statSync(manifest).mtimeMs !== mtimeBefore);

  // --- macOS Dock wrapper: the environment number must be what the Dock actually draws ---
  // The wrapper copies the kernel's Info.plist to keep its bundle identity, and that plist
  // carries CFBundleIconName pointing into Assets.car. That asset-catalog key outranks
  // CFBundleIconFile, so leaving it in means the Dock keeps showing the kernel's plain icon
  // while the tooltip says 环境 N — the number never appears on the icon itself.
  if (process.platform === 'darwin') {
    const { prepareMacDockWrapper } = require('./automation/env-icon');
    const kernel = path.join(__dirname, 'kernels/macos-x64/chrome_148/openbrowser_148/OpenBrowser.app/Contents/MacOS/OpenBrowser');
    if (fs.existsSync(kernel)) {
      const launcher = await prepareMacDockWrapper({ profileId: 'dock1', envNumber: 24, userDataPath, realBinary: kernel });
      ok('Dock wrapper is built', Boolean(launcher) && fs.existsSync(launcher));
      const appRoot = path.join(userDataPath, 'env-apps', 'dock1', '环境 24.app');
      const plist = fs.readFileSync(path.join(appRoot, 'Contents', 'Info.plist'), 'utf8');
      ok('wrapper points at the generated icon', /<key>CFBundleIconFile<\/key>\s*<string>app\.icns<\/string>/.test(plist));
      ok('wrapper drops CFBundleIconName so the asset catalog cannot win', !/<key>CFBundleIconName<\/key>/.test(plist));
      ok('wrapper keeps the kernel bundle identity', /<key>CFBundleIdentifier<\/key>/.test(plist));
      ok('wrapper shows the environment name', /<key>CFBundleName<\/key>\s*<string>环境 24<\/string>/.test(plist));
      const icns = path.join(appRoot, 'Contents', 'Resources', 'app.icns');
      ok('generated icon is a real file, not the kernel symlink', fs.existsSync(icns) && !fs.lstatSync(icns).isSymbolicLink() && fs.statSync(icns).size > 1000);
      const launcherSrc = fs.readFileSync(launcher, 'utf8');
      ok(
        'Dock wrapper does not inject --no-proxy-server (would override --proxy-server)',
        !launcherSrc.includes('EXTRA+=(--no-proxy-server)'),
      );
    } else {
      console.log('  SKIP  macOS kernel not present — Dock wrapper checks not exercised');
    }
  }

  await fsp.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
  console.log(`\nenv-artifact-cache-selftest: ${passed} checks passed.`);
})().catch((e) => { console.error('env-artifact-cache-selftest FAILED:', e); process.exit(1); });
