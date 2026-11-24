'use strict';

/** Regressions for main.js quit cleanup, settings persistence and window creation; real function bodies run in a vm sandbox because main.js needs Electron. */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const MAIN_PATH = path.join(__dirname, '..', 'main.js');
const source = fs.readFileSync(MAIN_PATH, 'utf8');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e && e.message ? e.message : String(e) }); }
}

/** Slice `async function name(...) {...}` / `function name(...) {...}` from source. */
function extractFunction(name) {
  const startRe = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const match = startRe.exec(source);
  if (!match) throw new Error(`function ${name} not found in main.js`);
  const start = match.index;
  let depth = 0;
  let seenBrace = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') { depth += 1; seenBrace = true; }
    else if (ch === '}') {
      depth -= 1;
      if (seenBrace && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

const makeSleep = () => new Promise((resolve) => setTimeout(resolve, 0));

function realCrypto() {
  return require('../credential-crypto');
}

/** fs/promises wrapper over a real temp dir, with injectable faults. */
function makeFs(bottomDir, faults = {}) {
  const fsp = require('fs/promises');
  const calls = { rm: [], rename: [], write: [] };
  return {
    calls,
    fsp: {
      mkdir: (...a) => fsp.mkdir(...a),
      readFile: async (target) => {
        if (faults.readFile) {
          const result = faults.readFile(String(target));
          if (result instanceof Error) throw result;
          if (result !== undefined) return result;
        }
        return fsp.readFile(target);
      },
      writeFile: async (target, data) => {
        calls.write.push(String(target));
        if (faults.writeFile) {
          const result = faults.writeFile(String(target));
          if (result instanceof Error) throw result;
        }
        return fsp.writeFile(target, data);
      },
      rm: async (target, options) => {
        calls.rm.push(String(target));
        if (faults.rm) {
          const result = faults.rm(String(target));
          if (result instanceof Error) throw result;
        }
        return fsp.rm(target, options);
      },
      rename: async (from, to) => {
        calls.rename.push([String(from), String(to)]);
        if (faults.rename) {
          const result = faults.rename(String(from), String(to));
          if (result instanceof Error) throw result;
        }
        return fsp.rename(from, to);
      },
    },
  };
}

// ============ settings: load / write ============

function settingsSandbox({ home, faults }) {
  const fsWrap = makeFs(home, faults);
  const sandbox = {
    fsp: fsWrap.fsp,
    path,
    console: { warn: () => {}, log: () => {}, error: () => {} },
    credentialCrypto: realCrypto(),
    defaultProfileDataRoot: path.join(home, 'default-root'),
    localSettingsFile: path.join(home, 'openbrowser-local-settings.json'),
    cloudSync: { defaultCloudConfig: () => ({ enabled: false, provider: 'local' }) },
    normalizeProfileDataRoot: (value) => path.resolve(home, String(value || path.join(home, 'default-root'))),
    normalizeCloseAction: (value) => (['ask', 'tray', 'exit'].includes(value) ? value : 'ask'),
    setTimeout,
    fsWrap,
  };
  sandbox.__exports = {};
  const code = [
    extractFunction('defaultLocalSettings'),
    `let settingsLoadedFromDisk = false;`,
    `let localSettingsCache = defaultLocalSettings();`,
    extractFunction('readLocalSettingsPayload'),
    extractFunction('cacheFromSavedSettings'),
    extractFunction('loadLocalSettings'),
    extractFunction('renameReplacing'),
    extractFunction('writeLocalSettingsFile'),
    `let persistedSettingsSnapshot = null;`,
    extractFunction('saveLocalSettings'),
    `__exports.getCache = () => localSettingsCache;`,
    `__exports.setCache = (v) => { localSettingsCache = v; };`,
    `__exports.getSnapshot = () => persistedSettingsSnapshot;`,
    `__exports.load = loadLocalSettings;`,
    `__exports.write = writeLocalSettingsFile;`,
    `__exports.save = saveLocalSettings;`,
    `__exports.isLoaded = () => settingsLoadedFromDisk;`,
  ].join('\n');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'main.js[settings]' });
  return sandbox;
}

const tmpRoots = [];
function tmpDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-${label}-`));
  tmpRoots.push(dir);
  return dir;
}

function writeEncrypted(target, value) {
  fs.writeFileSync(target, realCrypto().encryptCredential(JSON.stringify(value)));
}

(async () => {
  // ---------- golden: load reads the file once, cache becomes the source ----------
  await check('settings: first load reads the file, later loads use the cache', async () => {
    const home = tmpDir('settings-golden');
    const file = path.join(home, 'openbrowser-local-settings.json');
    writeEncrypted(file, { version: 2, profileDataRoot: path.join(home, 'custom-root'), uiGroups: ['g1'], closeAction: 'tray', cloud: { enabled: true, provider: 'local' } });

    let reads = 0;
    const box = settingsSandbox({
      home,
      faults: {
        readFile: (target) => {
          if (target === file) reads += 1;
          return undefined;
        },
      },
    });
    const first = await box.__exports.load();
    assert.strictEqual(first.profileDataRoot, path.join(home, 'custom-root'));
    assert.deepStrictEqual([...first.uiGroups], ['g1']);
    assert.strictEqual(first.closeAction, 'tray');
    assert.strictEqual(reads, 1, 'primary should be read exactly once');

    // A not-yet-flushed cache change must survive later loads (the cloud:get/set bug).
    box.__exports.setCache({ ...box.__exports.getCache(), uiGroups: ['pending'] });
    await box.__exports.load();
    assert.deepStrictEqual([...box.__exports.getCache().uiGroups], ['pending'], 'load re-read the disk and lost the in-memory change');
    assert.strictEqual(reads, 1, 'second load must not touch the disk');
  });

  // ---------- golden: write never deletes the live target ----------
  await check('settings: write replaces via temp+rename and never removes the target', async () => {
    const home = tmpDir('settings-write');
    const file = path.join(home, 'openbrowser-local-settings.json');
    writeEncrypted(file, { version: 2, profileDataRoot: path.join(home, 'a'), uiGroups: [], closeAction: 'ask', cloud: {} });
    const box = settingsSandbox({ home, faults: {} });
    await box.__exports.load();
    await box.__exports.write();
    const removed = box.fsWrap.calls.rm.map(String);
    assert.ok(!removed.includes(file), `live settings file was removed: ${removed.join(', ')}`);
    const renames = box.fsWrap.calls.rename.map(([f, t]) => `${f}->${t}`);
    assert.ok(renames.includes(`${file}.tmp->${file}`), `expected temp->file rename, saw ${renames.join(', ')}`);
    // The freshly written file must be readable again.
    const reread = await realCrypto().decryptCredential(fs.readFileSync(file));
    assert.ok(JSON.parse(reread).version === 2);
  });

  // ---------- golden: second-instance before startup must not build a window ----------
  await check('window: showMainWindow during startup does not create a window', async () => {
    const sandbox = {
      mainWindow: null,
      startupWindowReady: false,
      createWindowCalls: 0,
      createWindow: () => { sandbox.createWindowCalls += 1; return Promise.resolve(); },
      console: { warn: () => {} },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${extractFunction('showMainWindow')}\n__show = showMainWindow;`, sandbox);
    sandbox.__show();
    assert.strictEqual(sandbox.createWindowCalls, 0, 'startup show built a window before IPC was ready');

    sandbox.startupWindowReady = true;
    sandbox.__show();
    assert.strictEqual(sandbox.createWindowCalls, 1, 'post-startup show must be able to rebuild after close');

    // Reuse of a live window must not create another one.
    sandbox.mainWindow = { isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {} };
    sandbox.__show();
    assert.strictEqual(sandbox.createWindowCalls, 1, 'a live window must be reused');
  });

  await check('window: createWindow returns the live window instead of creating a second', async () => {
    const body = extractFunction('createWindow');
    const guardBody = body.slice(body.indexOf('{') + 1, body.indexOf('const isMac'));
    const snippet = `
      async function createWindow() {
        ${guardBody}
        created += 1;
        return null;
      }
    `;
    const box = { mainWindow: null, created: 0, path };
    vm.createContext(box);
    vm.runInContext(`${snippet}\n__exports = { count: () => created, call: createWindow };`, box, { filename: 'main.js[createWindow-guard]' });

    await box.__exports.call();
    assert.strictEqual(box.__exports.count(), 1, 'first call must proceed past the guard');

    const live = { isDestroyed: () => false, isMinimized: () => false, showCalls: 0, focusCalls: 0,
      show() { this.showCalls += 1; }, focus() { this.focusCalls += 1; } };
    box.mainWindow = live;
    const returned = await box.__exports.call();
    assert.strictEqual(box.__exports.count(), 1, 'a live window must not be created twice');
    assert.strictEqual(returned, live, 'createWindow must return the live window');
    assert.strictEqual(live.showCalls, 1);
    assert.strictEqual(live.focusCalls, 1);
  });

  // ---------- errors: stopAllForQuit keeps going through every remaining root ----------
  await check('quit: one failing profile cleanup does not abort the remaining loop', async () => {
    const seen = [];
    const sandbox = {
      process: { kill: () => {}, platform: 'linux' },
      console: { warn: () => {}, log: () => {} },
      sleep: makeSleep,
      terminateProcessesUsingProfile: (root) => {
        seen.push(root);
        if (root === 'root-bad') throw new Error('scan failed');
        return { known: true, pids: [] };
      },
      engine: {
        running: new Map([
          ['p1', { pid: 101, root: 'root-bad' }],
          ['p2', { pid: 102, root: 'root-good' }],
        ]),
        starting: new Map(),
        stopping: new Map(),
        stopAll: async () => ({ remaining: ['p1', 'p2'], errors: [] }),
        stop: async () => {},
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${extractFunction('stopAllForQuit')}\n__stopAll = stopAllForQuit;`, sandbox);
    const result = await sandbox.__stopAll();
    assert.deepStrictEqual(seen, ['root-bad', 'root-good'], 'the loop stopped after the first failing root');
    assert.deepStrictEqual([...result.remaining], ['p1', 'p2']);
    assert.strictEqual(result.stopped, false);
    assert.ok(result.errors.some((e) => /profile-cleanup p1/.test(e)), `failing root not reported: ${result.errors.join('|')}`);
  });

  await check('quit: a bad root no longer throws out of stopAllForQuit (no undefined isolation)', async () => {
    const sandbox = {
      process: { kill: () => {}, platform: 'linux' },
      console: { warn: () => {}, log: () => {} },
      sleep: makeSleep,
      terminateProcessesUsingProfile: () => ({ known: false, pids: [] }),
      engine: {
        running: new Map([['p1', { pid: 1, root: 'root-a' }]]),
        starting: new Map(), stopping: new Map(),
        stopAll: async () => ({ remaining: ['p1'], errors: [] }),
        stop: async () => {},
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${extractFunction('stopAllForQuit')}\n__stopAll = stopAllForQuit;`, sandbox);
    const result = await sandbox.__stopAll();
    assert.strictEqual(result.stopped, false);
  });

  // ---------- errors: beginQuitCleanup runs every phase, backup gated on stopped ----------
  await check('quit: a failing phase still runs live-sync/automation and never backs up a live env', async () => {
    const order = [];
    const sandbox = {
      quitting: true,
      quitCleanupPromise: null,
      destroyTray: () => order.push('tray'),
      app: { quit: () => order.push('app.quit') },
      localSettingsCache: { cloud: { enabled: true, autoSyncOnQuit: true }, uiGroups: [] },
      console: { warn: () => {}, log: () => {} },
      engine: {
        flushPersistence: async () => { order.push('engine.flush'); throw new Error('flush boom'); },
        profiles: new Map(),
      },
      localSettingsWriter: { flushNow: async () => { order.push('settings.flush'); throw new Error('settings boom'); } },
      liveSync: { stop: () => order.push('live-sync') },
      automation: { stop: async () => { order.push('automation'); } },
      stopAllForQuit: async () => { order.push('stop-all'); return { stopped: false, remaining: ['p1'], errors: [] }; },
      runCloudBackup: async () => { order.push('BACKUP'); },
      saveLocalSettings: async () => { order.push('save'); },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${extractFunction('beginQuitCleanup')}\n__cleanup = beginQuitCleanup;`, sandbox);
    await sandbox.__cleanup();
    // Every phase must run despite earlier failures, and app.quit is last.
    const expected = ['tray', 'stop-all', 'engine.flush', 'settings.flush', 'live-sync', 'automation', 'app.quit'];
    assert.deepStrictEqual(order, expected, `phase order was ${order.join(',')}`);
    assert.ok(!order.includes('BACKUP'), 'automatic backup ran with an environment still running');
  });

  await check('quit: a throwing stopAllForQuit still runs every phase and skips the backup', async () => {
    const order = [];
    const sandbox = {
      quitting: true,
      quitCleanupPromise: null,
      destroyTray: () => order.push('tray'),
      app: { quit: () => order.push('app.quit') },
      localSettingsCache: { cloud: { enabled: true, autoSyncOnQuit: true }, uiGroups: [] },
      console: { warn: () => {}, log: () => {} },
      engine: { flushPersistence: async () => order.push('engine.flush'), profiles: new Map() },
      localSettingsWriter: { flushNow: async () => order.push('settings.flush') },
      liveSync: { stop: () => order.push('live-sync') },
      automation: { stop: async () => order.push('automation') },
      stopAllForQuit: async () => { order.push('stop-all'); throw new Error('stopAll exploded'); },
      runCloudBackup: async () => order.push('BACKUP'),
      saveLocalSettings: async () => order.push('save'),
    };
    vm.createContext(sandbox);
    vm.runInContext(`${extractFunction('beginQuitCleanup')}\n__cleanup = beginQuitCleanup;`, sandbox);
    await sandbox.__cleanup();
    assert.deepStrictEqual(order, ['tray', 'stop-all', 'engine.flush', 'settings.flush', 'live-sync', 'automation', 'app.quit'],
      `phase order was ${order.join(',')}`);
    assert.ok(!order.includes('BACKUP'), 'a thrown stopAllForQuit was treated as "all stopped" and backed up');
  });

  await check('quit: backup runs only when every environment stopped', async () => {
    const order = [];
    const sandbox = {
      quitting: true,
      quitCleanupPromise: null,
      destroyTray: () => {},
      app: { quit: () => order.push('app.quit') },
      localSettingsCache: { cloud: { enabled: true, autoSyncOnQuit: true }, uiGroups: [] },
      console: { warn: () => {}, log: () => {} },
      engine: { flushPersistence: async () => {}, profiles: new Map() },
      localSettingsWriter: { flushNow: async () => {} },
      liveSync: { stop: () => {} },
      automation: { stop: async () => {} },
      stopAllForQuit: async () => ({ stopped: true, remaining: [], errors: [] }),
      runCloudBackup: async () => { order.push('BACKUP'); },
      saveLocalSettings: async () => {},
    };
    vm.createContext(sandbox);
    vm.runInContext(`${extractFunction('beginQuitCleanup')}\n__cleanup = beginQuitCleanup;`, sandbox);
    await sandbox.__cleanup();
    assert.deepStrictEqual(order, ['BACKUP', 'app.quit'], `order was ${order.join(',')}`);

    // stopped:true but a non-empty remaining list must still suppress the backup.
    const sandbox2 = { ...sandbox, quitCleanupPromise: null, runCloudBackup: async () => { order.push('BACKUP2'); } };
    order.length = 0;
    sandbox2.stopAllForQuit = async () => ({ stopped: true, remaining: ['x'], errors: [] });
    sandbox2.app = { quit: () => order.push('app.quit') };
    vm.createContext(sandbox2);
    vm.runInContext(`${extractFunction('beginQuitCleanup')}\n__cleanup = beginQuitCleanup;`, sandbox2);
    await sandbox2.__cleanup();
    assert.deepStrictEqual(order, ['app.quit'], 'backup ran despite a non-empty remaining list');
  });

  // ---------- errors: settings load fallback / refusal ----------
  await check('settings: primary corrupt falls back to .bak', async () => {
    const home = tmpDir('settings-bak');
    const file = path.join(home, 'openbrowser-local-settings.json');
    fs.writeFileSync(file, 'not-json-and-not-encrypted');
    writeEncrypted(file + '.bak', { version: 2, profileDataRoot: path.join(home, 'from-bak'), uiGroups: [], closeAction: 'ask', cloud: {} });
    const box = settingsSandbox({ home, faults: {} });
    const loaded = await box.__exports.load();
    assert.strictEqual(loaded.profileDataRoot, path.join(home, 'from-bak'));
  });

  await check('settings: both primary and backup unreadable refuses instead of using defaults', async () => {
    const home = tmpDir('settings-broken');
    const file = path.join(home, 'openbrowser-local-settings.json');
    fs.writeFileSync(file, 'garbage');
    fs.writeFileSync(file + '.bak', 'also-garbage');
    const box = settingsSandbox({ home, faults: {} });
    await assert.rejects(() => box.__exports.load(), /refusing to fall back to defaults/);
    assert.strictEqual(box.__exports.isLoaded(), false, 'a failed load must not latch the cache');
  });

  await check('settings: a fresh install with neither file may use defaults', async () => {
    const home = tmpDir('settings-fresh');
    const box = settingsSandbox({ home, faults: {} });
    const loaded = await box.__exports.load();
    assert.strictEqual(loaded.profileDataRoot, path.join(home, 'default-root'));
    assert.strictEqual(box.__exports.isLoaded(), true);
  });

  await check('settings: a non-object top level (array/null) falls back to .bak', async () => {
    for (const bad of ['[]', 'null', '"a string"']) {
      const home = tmpDir('settings-toplevel');
      const file = path.join(home, 'openbrowser-local-settings.json');
      writeEncrypted(file, JSON.parse(bad));
      writeEncrypted(file + '.bak', { version: 2, profileDataRoot: path.join(home, 'from-bak'), uiGroups: [], closeAction: 'ask', cloud: {} });
      const box = settingsSandbox({ home, faults: {} });
      const loaded = await box.__exports.load();
      assert.strictEqual(loaded.profileDataRoot, path.join(home, 'from-bak'), `${bad} was accepted as settings`);
    }
  });

  await check('settings: a cache change during a slow rename is not marked as persisted', async () => {
    const home = tmpDir('settings-snapshot');
    const file = path.join(home, 'openbrowser-local-settings.json');
    writeEncrypted(file, { version: 2, profileDataRoot: path.join(home, 'root'), uiGroups: ['old'], closeAction: 'ask', cloud: {} });
    const box = settingsSandbox({ home, faults: {} });
    await box.__exports.load();
    // Hold the rename so the cache changes while the write is in flight.
    const originalRename = box.fsp.rename;
    let releaseRename;
    const gate = new Promise((resolve) => { releaseRename = resolve; });
    let held = false;
    box.fsp.rename = async (from, to) => {
      if (!held) { held = true; await gate; }
      return originalRename(from, to);
    };
    const writePromise = box.__exports.write();
    await new Promise((r) => setTimeout(r, 5));
    box.__exports.setCache({ ...box.__exports.getCache(), uiGroups: ['new'] });
    releaseRename();
    await writePromise;
    const snapshot = box.__exports.getSnapshot();
    assert.deepStrictEqual([...snapshot.uiGroups], ['old'], 'the snapshot claims a cache value that never hit disk');
    // The on-disk file must match the snapshot, not the in-flight cache change.
    const onDisk = JSON.parse(await realCrypto().decryptCredential(fs.readFileSync(file)));
    assert.deepStrictEqual(onDisk.uiGroups, ['old']);
  });

  await check('settings: a corrupt primary never overwrites a good backup', async () => {
    const home = tmpDir('settings-bak-safe');
    const file = path.join(home, 'openbrowser-local-settings.json');
    writeEncrypted(file, { version: 2, profileDataRoot: path.join(home, 'original'), uiGroups: [], closeAction: 'ask', cloud: {} });
    const box = settingsSandbox({ home, faults: {} });
    await box.__exports.load();
    // A first write seeds .bak from a healthy primary.
    await box.__exports.write();
    const goodBak = fs.readFileSync(file + '.bak');
    fs.writeFileSync(file, 'corrupted-after-load');
    await box.__exports.write();
    assert.deepStrictEqual(fs.readFileSync(file + '.bak'), goodBak, 'the corrupted primary replaced the good backup');
  });

  // ---------- report ----------
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\nMAIN_LIFECYCLE_SETTINGS_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${results.filter((r) => r.ok).length}/${results.length}`);
  if (failed.length) process.exitCode = 1;
  for (const dir of tmpRoots) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
})();
