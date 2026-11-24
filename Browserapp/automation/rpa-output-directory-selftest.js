'use strict';

/**
 * Per-instance RPA output directory: file-only, no CDP, no browser, no network.
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { RpaEngine } = require('./rpa-engine');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

const makeEngine = (options) => new RpaEngine({ engine: {}, store: null, emit: () => {}, ...options });
const scratchRoots = [];

function makeScratch(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchRoots.push(dir);
  return dir;
}

// Steps that write/read without a page: savedata, exportexcel, importText.
const savedataStep = (name, content) => ({ type: 'savedata', params: { name, content } });
const exportStep = (name, data) => ({ type: 'exportexcel', params: { name, data } });
const importTextStep = (file, variable = 'lines') => ({ type: 'importtext', params: { path: file, variable } });

(async () => {
  const userDataA = makeScratch('ob-rpa-out-a-');
  const userDataB = makeScratch('ob-rpa-out-b-');

  check('constructor derives the output directory from userDataPath', () => {
    const engine = makeEngine({ userDataPath: userDataA });
    assert.strictEqual(engine.outputDirectory, path.resolve(userDataA, 'rpa-output'));
    assert.ok(path.isAbsolute(engine.outputDirectory));
  });

  check('without userDataPath the cwd default is kept', () => {
    const engine = makeEngine({});
    assert.strictEqual(engine.outputDirectory, path.resolve(process.cwd(), 'rpa-output'));
  });

  check('two instances with different userData roots stay isolated', () => {
    const a = makeEngine({ userDataPath: userDataA });
    const b = makeEngine({ userDataPath: userDataB });
    assert.notStrictEqual(a.outputDirectory, b.outputDirectory);
    assert.ok(!a.outputDirectory.startsWith(b.outputDirectory + path.sep));
    assert.strictEqual(a.outputPath('same.txt', '.txt'), path.join(path.resolve(userDataA, 'rpa-output'), 'same.txt'));
    assert.strictEqual(b.outputPath('same.txt', '.txt'), path.join(path.resolve(userDataB, 'rpa-output'), 'same.txt'));
  });

  await checkAsync('savedata writes under the instance output directory', async () => {
    const engine = makeEngine({ userDataPath: userDataA });
    await engine.executeStep(0, savedataStep('rows', 'a,b'), { variables: {} });
    const target = path.join(engine.outputDirectory, 'rows.txt');
    assert.strictEqual(await fsp.readFile(target, 'utf8'), 'a,b\n');
  });

  await checkAsync('exportexcel writes under the instance output directory', async () => {
    const engine = makeEngine({ userDataPath: userDataA });
    await engine.executeStep(0, exportStep('sheet', [{ a: 1, b: 2 }]), { variables: {} });
    const csv = await fsp.readFile(path.join(engine.outputDirectory, 'sheet.csv'), 'utf8');
    assert.ok(csv.includes('"a","b"'), csv);
    assert.ok(csv.includes('"1","2"'), csv);
  });

  await checkAsync('importText resolves relative paths against the instance directory', async () => {
    const engine = makeEngine({ userDataPath: userDataA });
    await fsp.mkdir(engine.outputDirectory, { recursive: true });
    await fsp.writeFile(path.join(engine.outputDirectory, 'names.txt'), 'one\ntwo\n', 'utf8');
    const ctx = { variables: {} };
    await engine.executeStep(0, importTextStep('names.txt'), ctx);
    assert.deepStrictEqual(ctx.variables.lines, ['one', 'two']);
  });

  await checkAsync('importText rejects another instance directory and host paths', async () => {
    const a = makeEngine({ userDataPath: userDataA });
    const b = makeEngine({ userDataPath: userDataB });
    await fsp.mkdir(b.outputDirectory, { recursive: true });
    const foreign = path.join(b.outputDirectory, 'foreign.txt');
    await fsp.writeFile(foreign, 'x\n', 'utf8');
    await assert.rejects(a.executeStep(0, importTextStep(foreign), { variables: {} }), /RPA file path/);
    await assert.rejects(a.executeStep(0, importTextStep('/etc/passwd'), { variables: {} }), /RPA file path/);
    // ...while the owning instance still reads its own file.
    await b.executeStep(0, importTextStep('foreign.txt'), { variables: {} });
  });

  await checkAsync('an unwritable cwd does not silently redirect output', async () => {
    const readOnlyCwd = makeScratch('ob-rpa-ro-cwd-');
    const engine = makeEngine({}); // no userDataPath: cwd fallback
    const previousCwd = process.cwd();
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    try {
      process.chdir(readOnlyCwd);
      const cwdEngine = makeEngine({});
      // process.cwd() returns the realpath (/private/var on macOS), not mkdtemp's /var.
      assert.strictEqual(cwdEngine.outputDirectory, path.resolve(fs.realpathSync(readOnlyCwd), 'rpa-output'));
      fs.chmodSync(readOnlyCwd, 0o500);
      if (!isRoot) {
        await assert.rejects(
          cwdEngine.executeStep(0, savedataStep('denied', 'x'), { variables: {} }),
          (error) => error && (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EROFS')
        );
      }
    } finally {
      try { process.chdir(previousCwd); } catch (_) {}
      try { fs.chmodSync(readOnlyCwd, 0o700); } catch (_) {}
    }
    // The instance built before the chdir is unaffected.
    assert.strictEqual(engine.outputDirectory, path.resolve(previousCwd, 'rpa-output'));
  });

  await checkAsync('a root cwd only computes a lexical path (packaged macOS case)', async () => {
    const previousCwd = process.cwd();
    try {
      process.chdir('/');
      const engine = makeEngine({});
      assert.strictEqual(engine.outputPath('shot', '.png'), path.join('/rpa-output', 'shot.png'));
      // No write is attempted here: '/' is read-only on a packaged Mac.
    } finally {
      process.chdir(previousCwd);
    }
  });

  await checkAsync('a read-only cwd still writes through the userData root', async () => {
    const readOnlyCwd = makeScratch('ob-rpa-ro-cwd-ok-');
    const previousCwd = process.cwd();
    try {
      process.chdir(readOnlyCwd);
      fs.chmodSync(readOnlyCwd, 0o500);
      const engine = makeEngine({ userDataPath: userDataB });
      await engine.executeStep(0, savedataStep('ro', 'ok'), { variables: {} });
      await engine.executeStep(0, exportStep('ro', [{ a: 7 }]), { variables: {} });
      const out = path.resolve(userDataB, 'rpa-output');
      assert.strictEqual(await fsp.readFile(path.join(out, 'ro.txt'), 'utf8'), 'ok\n');
      assert.ok((await fsp.readFile(path.join(out, 'ro.csv'), 'utf8')).includes('"7"'));
      assert.ok(!fs.existsSync(path.join(readOnlyCwd, 'rpa-output')));
    } finally {
      try { process.chdir(previousCwd); } catch (_) {}
      try { fs.chmodSync(readOnlyCwd, 0o700); } catch (_) {}
    }
  });

  await checkAsync('a root cwd still writes through the userData root', async () => {
    const previousCwd = process.cwd();
    try {
      process.chdir('/');
      const engine = makeEngine({ userDataPath: userDataA });
      await engine.executeStep(0, savedataStep('root-cwd', 'still'), { variables: {} });
      const target = path.join(path.resolve(userDataA, 'rpa-output'), 'root-cwd.txt');
      assert.strictEqual(await fsp.readFile(target, 'utf8'), 'still\n');
      assert.ok(!fs.existsSync('/rpa-output/root-cwd.txt'));
    } finally {
      process.chdir(previousCwd);
    }
  });

  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  for (const dir of scratchRoots) {
    try { fs.chmodSync(dir, 0o700); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nRPA_OUTPUT_DIRECTORY_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${results.filter((r) => r.ok).length}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})().catch((error) => {
  console.error('RPA_OUTPUT_DIRECTORY_SELFTEST CRASHED', error);
  process.exitCode = 1;
});
