'use strict';

/**
 * Self-test for the native window controller.
 * Runs offline: platform and command execution are injected, so no display
 * server or FFI binding is required.
 */

const assert = require('assert');
const {
  createWindowController,
  parseXdotoolGeometry,
  isValidHandle,
  BACKENDS,
} = require('./native-window');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

/** Fake exec surface: records commands and replays canned output. */
function fakeExec({ xdotool = true, geometry = 'WINDOW=1\nX=10\nY=20\nWIDTH=800\nHEIGHT=600\n' } = {}) {
  const syncCalls = [];
  const asyncCalls = [];
  return {
    syncCalls,
    asyncCalls,
    execSync(cmd) {
      syncCalls.push(cmd);
      if (String(cmd).startsWith('command -v')) {
        const tool = String(cmd).replace('command -v', '').trim();
        if (tool === 'xdotool' && !xdotool) throw new Error('not found');
        return '/usr/bin/' + tool;
      }
      if (String(cmd).includes('getwindowgeometry')) return geometry;
      return '';
    },
    exec(cmd, opts, cb) {
      asyncCalls.push(cmd);
      const callback = typeof opts === 'function' ? opts : cb;
      if (callback) callback(null, '', '');
      return { on() {} };
    },
  };
}

const noFfi = () => null;

(async () => {
// ---- parsing helpers ----

check('parseXdotoolGeometry reads the shell output', () => {
  const geo = parseXdotoolGeometry('WINDOW=123\nX=10\nY=20\nWIDTH=800\nHEIGHT=600\nSCREEN=0\n');
  assert.deepStrictEqual(geo, { x: 10, y: 20, width: 800, height: 600 });
});

check('parseXdotoolGeometry accepts negative coordinates', () => {
  const geo = parseXdotoolGeometry('X=-40\nY=-10\nWIDTH=400\nHEIGHT=300\n');
  assert.strictEqual(geo.x, -40);
  assert.strictEqual(geo.y, -10);
});

check('parseXdotoolGeometry defaults missing coordinates to zero', () => {
  const geo = parseXdotoolGeometry('WIDTH=100\nHEIGHT=50\n');
  assert.deepStrictEqual(geo, { x: 0, y: 0, width: 100, height: 50 });
});

check('parseXdotoolGeometry rejects incomplete output', () => {
  assert.strictEqual(parseXdotoolGeometry('WINDOW=1\nX=1\n'), null);
  assert.strictEqual(parseXdotoolGeometry(''), null);
  assert.strictEqual(parseXdotoolGeometry(null), null);
});

check('parseXdotoolGeometry ignores unrelated lines', () => {
  const geo = parseXdotoolGeometry('warning: something\nWIDTH=10\nHEIGHT=20\nSCREEN=0\n');
  assert.deepStrictEqual(geo, { x: 0, y: 0, width: 10, height: 20 });
});

check('isValidHandle rejects zero and junk', () => {
  assert.strictEqual(isValidHandle(123), true);
  assert.strictEqual(isValidHandle('123'), true);
  assert.strictEqual(isValidHandle(0), false);
  assert.strictEqual(isValidHandle(-5), false);
  assert.strictEqual(isValidHandle('abc'), false);
  assert.strictEqual(isValidHandle(null), false);
});

// ---- backend detection ----

check('macOS reports no native backend', () => {
  const c = createWindowController({ platform: 'darwin', execSync: () => {}, exec: () => {}, loadFfi: noFfi });
  assert.strictEqual(c.getBackend(), BACKENDS.NONE);
  assert.strictEqual(c.describe().canMoveResize, false);
});

check('linux uses xdotool when no ffi binding is present', () => {
  const fake = fakeExec();
  const c = createWindowController({ platform: 'linux', execSync: fake.execSync, exec: fake.exec, loadFfi: noFfi });
  assert.strictEqual(c.getBackend(), BACKENDS.XDOTOOL);
  assert.strictEqual(c.describe().ffiAvailable, false);
  assert.strictEqual(c.describe().xdotoolAvailable, true);
});

check('linux reports none when neither ffi nor xdotool exists', () => {
  const fake = fakeExec({ xdotool: false });
  const c = createWindowController({ platform: 'linux', execSync: fake.execSync, exec: fake.exec, loadFfi: noFfi });
  assert.strictEqual(c.getBackend(), BACKENDS.NONE);
});

check('windows reports none when no ffi binding is present', () => {
  const c = createWindowController({ platform: 'win32', execSync: () => '', exec: () => {}, loadFfi: noFfi });
  assert.strictEqual(c.getBackend(), BACKENDS.NONE);
});

check('backend detection is cached after the first probe', () => {
  let probes = 0;
  const c = createWindowController({
    platform: 'linux',
    execSync: (cmd) => {
      if (String(cmd).startsWith('command -v')) {
        probes += 1;
        return '/usr/bin/xdotool';
      }
      return '';
    },
    exec: () => {},
    loadFfi: noFfi,
  });
  c.getBackend();
  c.getBackend();
  c.getBackend();
  assert.strictEqual(probes, 1, 'probe runs once');
});

check('setBackend overrides detection for diagnostics', () => {
  const c = createWindowController({ platform: 'linux', execSync: () => '', exec: () => {}, loadFfi: noFfi });
  c.setBackend(BACKENDS.NONE);
  assert.strictEqual(c.getBackend(), BACKENDS.NONE);
  c.setBackend('nonsense');
  assert.strictEqual(c.getBackend(), BACKENDS.NONE);
});

// ---- geometry ----

check('getGeometry returns the parsed rectangle on the cli path', () => {
  const fake = fakeExec();
  const c = createWindowController({ platform: 'linux', execSync: fake.execSync, exec: fake.exec, loadFfi: noFfi });
  const geo = c.getGeometry(42);
  assert.deepStrictEqual(geo, { x: 10, y: 20, width: 800, height: 600 });
  assert.ok(fake.syncCalls.some((cmd) => cmd.includes('getwindowgeometry') && cmd.includes('42')));
});

check('getGeometry returns null for an invalid handle', () => {
  const fake = fakeExec();
  const c = createWindowController({ platform: 'linux', execSync: fake.execSync, exec: fake.exec, loadFfi: noFfi });
  assert.strictEqual(c.getGeometry(0), null);
  assert.strictEqual(c.getGeometry('nope'), null);
});

check('getGeometry returns null when nothing is available', () => {
  const c = createWindowController({ platform: 'darwin', execSync: () => '', exec: () => {}, loadFfi: noFfi });
  assert.strictEqual(c.getGeometry(1), null);
});

// ---- move / resize ----

await checkAsync('moveResize issues windowmove and windowsize', async () => {
  const fake = fakeExec();
  const c = createWindowController({ platform: 'linux', execSync: fake.execSync, exec: fake.exec, loadFfi: noFfi });
  const ok = await c.moveResize(77, { x: 100, y: 200, width: 640, height: 480 });
  assert.strictEqual(ok, true);
  const cmd = fake.asyncCalls.join(' ');
  assert.ok(cmd.includes('xdotool windowmove --sync 77 100 200'), 'move command issued');
  assert.ok(cmd.includes('xdotool windowsize --sync 77 640 480'), 'size command issued');
});

await checkAsync('moveResize clears the maximized state first', async () => {
  const fake = fakeExec();
  const c = createWindowController({ platform: 'linux', execSync: fake.execSync, exec: fake.exec, loadFfi: noFfi });
  await c.moveResize(88, { x: 0, y: 0, width: 800, height: 600 });
  assert.ok(
    fake.syncCalls.some((cmd) => cmd.includes('wmctrl') && cmd.includes('remove,maximized_vert,maximized_horz')),
    'maximized state cleared'
  );
});

await checkAsync('moveResize with noMove skips the move command', async () => {
  const fake = fakeExec();
  const c = createWindowController({ platform: 'linux', execSync: fake.execSync, exec: fake.exec, loadFfi: noFfi });
  await c.moveResize(99, { x: 5, y: 5, width: 1280, height: 720 }, { noMove: true });
  const cmd = fake.asyncCalls.join(' ');
  assert.ok(!cmd.includes('windowmove'), 'position preserved');
  assert.ok(cmd.includes('windowsize'), 'size still applied');
});

await checkAsync('moveResize rounds fractional sizes and floors them at one', async () => {
  const fake = fakeExec();
  const c = createWindowController({ platform: 'linux', execSync: fake.execSync, exec: fake.exec, loadFfi: noFfi });
  await c.moveResize(11, { x: 10.6, y: 20.4, width: 800.5, height: 0 });
  const cmd = fake.asyncCalls.join(' ');
  assert.ok(cmd.includes('windowmove --sync 11 11 20'), 'coordinates rounded');
  assert.ok(cmd.includes('windowsize --sync 11 801 1'), 'size rounded up and clamped to 1');
});

await checkAsync('moveResize returns false for an invalid handle', async () => {
  const fake = fakeExec();
  const c = createWindowController({ platform: 'linux', execSync: fake.execSync, exec: fake.exec, loadFfi: noFfi });
  assert.strictEqual(await c.moveResize(0, { x: 0, y: 0, width: 10, height: 10 }), false);
  assert.strictEqual(fake.asyncCalls.length, 0);
});

await checkAsync('moveResize returns false when no backend exists', async () => {
  const c = createWindowController({ platform: 'darwin', execSync: () => '', exec: () => {}, loadFfi: noFfi });
  assert.strictEqual(await c.moveResize(5, { x: 0, y: 0, width: 10, height: 10 }), false);
});

await checkAsync('moveResize reports failure when the command errors', async () => {
  const c = createWindowController({
    platform: 'linux',
    execSync: (cmd) => (String(cmd).startsWith('command -v') ? '/usr/bin/xdotool' : ''),
    exec: (cmd, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (callback) callback(new Error('window vanished'));
    },
    loadFfi: noFfi,
  });
  assert.strictEqual(await c.moveResize(3, { x: 0, y: 0, width: 10, height: 10 }), false);
});

// ---- visibility ----

await checkAsync('hideWindow unmaps the window', async () => {
  const fake = fakeExec();
  const c = createWindowController({ platform: 'linux', execSync: fake.execSync, exec: fake.exec, loadFfi: noFfi });
  assert.strictEqual(await c.hideWindow(55), true);
  assert.ok(fake.asyncCalls.join(' ').includes('xdotool windowunmap 55'));
});

await checkAsync('showWindow maps and activates the window', async () => {
  const fake = fakeExec();
  const c = createWindowController({ platform: 'linux', execSync: fake.execSync, exec: fake.exec, loadFfi: noFfi });
  assert.strictEqual(await c.showWindow(66), true);
  const cmd = fake.asyncCalls.join(' ');
  assert.ok(cmd.includes('xdotool windowmap 66'));
  assert.ok(cmd.includes('xdotool windowactivate 66'));
});

await checkAsync('bringToFront reuses the show path off Windows', async () => {
  const fake = fakeExec();
  const c = createWindowController({ platform: 'linux', execSync: fake.execSync, exec: fake.exec, loadFfi: noFfi });
  assert.strictEqual(await c.bringToFront(12), true);
  assert.ok(fake.asyncCalls.join(' ').includes('windowactivate 12'));
});

await checkAsync('setVisible rejects an invalid handle', async () => {
  const fake = fakeExec();
  const c = createWindowController({ platform: 'linux', execSync: fake.execSync, exec: fake.exec, loadFfi: noFfi });
  assert.strictEqual(await c.setVisible(0, true), false);
  assert.strictEqual(fake.asyncCalls.length, 0);
});

// ---- diagnostics ----

check('describe summarises platform capabilities', () => {
  const fake = fakeExec();
  const c = createWindowController({ platform: 'linux', execSync: fake.execSync, exec: fake.exec, loadFfi: noFfi });
  const info = c.describe();
  assert.strictEqual(info.platform, 'linux');
  assert.strictEqual(info.backend, BACKENDS.XDOTOOL);
  assert.strictEqual(info.canReadGeometry, true);
  assert.strictEqual(info.canMoveResize, true);
  assert.strictEqual(info.canSetVisibility, true);
});

check('describe reports a degraded mac environment', () => {
  const c = createWindowController({ platform: 'darwin', execSync: () => '', exec: () => {}, loadFfi: noFfi });
  const info = c.describe();
  assert.strictEqual(info.backend, BACKENDS.NONE);
  assert.strictEqual(info.canReadGeometry, false);
});

// ---- report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
console.log(`\nNATIVE_WINDOW_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
if (failed.length) process.exitCode = 1;
})();
