'use strict';

const assert = require('assert');
const { platformPreflight, WINDOWS_MAX_PATH } = require('./platform-preflight');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  PASS  ' + name);
  passed += 1;
}
function codes(result) { return result.warnings.map((w) => w.code); }

// --- Windows: deep default data root with long ids trips MAX_PATH ---
{
  const deepRoot = 'C:\\Users\\Administrator\\AppData\\Roaming\\openbrowser\\browser-profiles-v2';
  const r = platformPreflight({
    platform: 'win32', arch: 'x64',
    env: { USERPROFILE: 'C:\\Users\\Administrator', LOCALAPPDATA: 'C:\\Users\\Administrator\\AppData\\Local' },
    profileDataRoot: deepRoot, maxProfileIdLen: 64,
  });
  ok('win deep root + 64-char id flags long-path error', codes(r).includes('win-long-path'));
  ok('win long-path makes preflight not-ok', r.ok === false);
}

// --- Windows: short data root is safe ---
{
  const r = platformPreflight({
    platform: 'win32', arch: 'x64',
    env: { USERPROFILE: 'C:\\Users\\A', LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local' },
    profileDataRoot: 'C:\\ob', maxProfileIdLen: 32,
  });
  ok('win short root has no long-path error', !codes(r).includes('win-long-path'));
  ok('win short root is ok', r.ok === true);
}

// --- Windows: missing env vars surface warnings ---
{
  const r = platformPreflight({ platform: 'win32', arch: 'x64', env: {}, profileDataRoot: 'C:\\ob' });
  ok('win missing USERPROFILE warns', codes(r).includes('win-no-userprofile'));
  ok('win missing LOCALAPPDATA warns', codes(r).includes('win-no-localappdata'));
}

// --- Windows on ARM with x64-only kernel ---
{
  const r = platformPreflight({
    platform: 'win32', arch: 'arm64', env: { USERPROFILE: 'C:\\U', LOCALAPPDATA: 'C:\\U\\L' },
    profileDataRoot: 'C:\\ob', kernelRequiresX64: true,
  });
  ok('win arm64 + x64 kernel warns', codes(r).includes('win-arm-kernel'));
}

// --- macOS: quarantine info always; Rosetta only when x64 kernel on arm ---
{
  const base = platformPreflight({ platform: 'darwin', arch: 'arm64', env: { HOME: '/Users/a' } });
  ok('mac emits quarantine info', codes(base).includes('mac-quarantine'));
  ok('mac arm w/o x64 kernel: no rosetta note', !codes(base).includes('mac-arm-rosetta'));
  const ros = platformPreflight({ platform: 'darwin', arch: 'arm64', env: { HOME: '/Users/a' }, kernelRequiresX64: true });
  ok('mac arm + x64 kernel: rosetta note', codes(ros).includes('mac-arm-rosetta'));
  ok('mac info-only stays ok', base.ok === true);
}

// --- Linux: sandbox always; wayland only under wayland session ---
{
  const x11 = platformPreflight({ platform: 'linux', arch: 'x64', env: { HOME: '/home/a', XDG_SESSION_TYPE: 'x11' } });
  ok('linux emits sandbox info', codes(x11).includes('linux-sandbox'));
  ok('linux x11 has no wayland note', !codes(x11).includes('linux-wayland'));
  const way = platformPreflight({ platform: 'linux', arch: 'x64', env: { HOME: '/home/a', WAYLAND_DISPLAY: 'wayland-0' } });
  ok('linux wayland session flagged', codes(way).includes('linux-wayland'));
}

// --- Unknown platform ---
{
  const r = platformPreflight({ platform: 'sunos', arch: 'x64', env: {} });
  ok('unknown platform warns', codes(r).includes('unknown-platform'));
}

// --- boundary sanity ---
ok('WINDOWS_MAX_PATH is 260', WINDOWS_MAX_PATH === 260);

console.log(`\nplatform-preflight-selftest: ${passed} checks passed.`);
