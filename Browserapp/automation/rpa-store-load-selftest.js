'use strict';

/** Offline self-test: a failed load must throw, keep the file and block save. */

const assert = require('assert');
const fsp = require('fs/promises');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RpaStore } = require('./rpa-store');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

const tempRoots = [];
async function tempRoot() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'openbrowser-rpa-store-load-'));
  tempRoots.push(dir);
  return dir;
}
function storePathIn(dir) {
  return path.join(dir, 'rpa-store.json');
}
async function expectReject(promise, pattern) {
  let error = null;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error, 'expected the operation to reject');
  if (pattern) assert.ok(pattern.test(error.message), `unexpected error message: ${error.message}`);
  return error;
}

async function withReadFile(fake, fn) {
  const original = fsp.readFile;
  fsp.readFile = fake;
  try { return await fn(); } finally { fsp.readFile = original; }
}

(async () => {
  // ---------- missing file: normal bootstrap ----------
  await checkAsync('a missing store file initialises normally and is created on save', async () => {
    const dir = await tempRoot();
    const store = new RpaStore(storePathIn(dir));
    const data = await store.load();
    assert.strictEqual(store.loadError, null, 'a missing file is not a load failure');
    assert.strictEqual(data.version, 4);
    assert.deepStrictEqual(data.plans, []);
    assert.deepStrictEqual(data.tasks, []);
    assert.ok(Array.isArray(data.templates) && data.templates.length > 0, 'builtin/catalog templates are seeded');
    assert.ok(fs.existsSync(storePathIn(dir)), 'the store is initialised on disk');
    const onDisk = JSON.parse(await fsp.readFile(storePathIn(dir), 'utf8'));
    assert.strictEqual(onDisk.version, 4);
  });

  // ---------- corrupt JSON ----------
  await checkAsync('corrupt JSON throws and is never overwritten', async () => {
    const dir = await tempRoot();
    const file = storePathIn(dir);
    const broken = '{"version":4,"plans":[{"id":"p-keep"}';
    await fsp.writeFile(file, broken, 'utf8');
    const before = await fsp.readFile(file, 'utf8');

    const store = new RpaStore(file);
    const error = await expectReject(store.load(), /JSON 解析失败/);
    assert.ok(store.loadError, 'loadError is recorded');
    assert.strictEqual(store.loadError, error);
    assert.strictEqual(await fsp.readFile(file, 'utf8'), before, 'corrupt file bytes are preserved');
    assert.ok(!fs.existsSync(file + '.tmp'), 'no temp file is left behind');

    await expectReject(store.save(), /拒绝写入/);
    assert.strictEqual(await fsp.readFile(file, 'utf8'), before, 'a save after a failed load must not overwrite');
    assert.ok(!fs.existsSync(file + '.tmp'), 'the refused save writes nothing');
  });

  // ---------- non-object top levels ----------
  for (const [label, raw] of [
    ['array', '[{"id":"x"}]'],
    ['null', 'null'],
    ['string', '"nope"'],
    ['number', '42'],
  ]) {
    await checkAsync(`a top-level ${label} throws and is never overwritten`, async () => {
      const dir = await tempRoot();
      const file = storePathIn(dir);
      await fsp.writeFile(file, raw, 'utf8');
      const store = new RpaStore(file);
      await expectReject(store.load(), /顶层必须是 JSON 对象/);
      assert.ok(store.loadError, 'loadError is recorded');
      assert.strictEqual(await fsp.readFile(file, 'utf8'), raw, 'original bytes are preserved');
      await expectReject(store.save(), /拒绝写入/);
      assert.strictEqual(await fsp.readFile(file, 'utf8'), raw, 'save after failure is refused');
    });
  }

  // ---------- read errors other than ENOENT ----------
  await checkAsync('an EACCES read preserves the file and blocks save', async () => {
    const dir = await tempRoot();
    const file = storePathIn(dir);
    const original = JSON.stringify({ version: 4, plans: [{ id: 'p-keep', plan_name: 'keep' }], tasks: [], templates: [], config: {} });
    await fsp.writeFile(file, original, 'utf8');

    const store = new RpaStore(file);
    const error = await withReadFile(
      async () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; },
      () => expectReject(store.load(), /读取失败 EACCES/)
    );
    assert.strictEqual(error.code, 'EACCES', 'the underlying code is kept for callers');
    assert.ok(store.loadError, 'loadError is recorded');
    assert.strictEqual(await fsp.readFile(file, 'utf8'), original, 'the unreadable file is left untouched');
    assert.deepStrictEqual(store.data.plans, [], 'the in-memory store is not seeded from a failed read');
    await expectReject(store.save(), /拒绝写入/);
    assert.strictEqual(await fsp.readFile(file, 'utf8'), original, 'save must not replace an unreadable store');
  });

  // ---------- success keeps plans/templates ----------
  await checkAsync('a valid store keeps custom plans, templates and config', async () => {
    const dir = await tempRoot();
    const file = storePathIn(dir);
    const seeded = {
      version: 4,
      plans: [{
        id: 'plan-keep',
        plan_name: 'kept plan',
        process_name: 'kept plan',
        profile_ids: ['p1'],
        steps: [{ type: 'noop' }],
        process_content: null,
        variables: { a: 1 },
        status: 'idle',
        create_time: '2026-01-01T00:00:00.000Z',
        update_time: '2026-01-01T00:00:00.000Z',
        ext: {},
        template_id: null,
      }],
      tasks: [],
      templates: [{
        id: 'tpl-keep',
        name: 'kept template',
        cat: '我的模版',
        desc: 'custom',
        tags: ['自定义'],
        steps: [{ type: 'noop' }],
        process_content: null,
        uses: 3,
        pay_type: 1,
        price: 0,
        developer: '',
        builtin: false,
        source: 'custom',
        create_time: '2026-01-01T00:00:00.000Z',
        update_time: '2026-01-01T00:00:00.000Z',
      }],
      config: { uiLanguage: 'zh-CN' },
    };
    await fsp.writeFile(file, JSON.stringify(seeded), 'utf8');

    const store = new RpaStore(file);
    const data = await store.load();
    assert.strictEqual(store.loadError, null, 'a successful load clears loadError');
    assert.strictEqual(data.plans.length, 1, 'custom plan survives load');
    assert.strictEqual(store.getPlan('plan-keep').plan_name, 'kept plan');
    const template = store.getStoredTemplate('tpl-keep');
    assert.ok(template, 'custom template survives load');
    assert.strictEqual(template.name, 'kept template');
    assert.strictEqual(Number(template.uses), 3, 'custom template usage survives');
    assert.strictEqual(store.getConfig().uiLanguage, 'zh-CN', 'config survives');
    const onDisk = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.ok(onDisk.plans.some((plan) => plan.id === 'plan-keep'));
    assert.ok(onDisk.templates.some((tpl) => tpl.id === 'tpl-keep'));
  });

  // ---------- recovery after failure clears the block ----------
  await checkAsync('a later successful load clears loadError and re-enables save', async () => {
    const dir = await tempRoot();
    const file = storePathIn(dir);
    await fsp.writeFile(file, '{oops', 'utf8');
    const store = new RpaStore(file);
    await expectReject(store.load(), /JSON 解析失败/);
    assert.ok(store.loadError);

    // Repair the file, then load again on the same instance.
    await fsp.writeFile(file, JSON.stringify({ version: 4, plans: [], tasks: [], templates: [], config: {} }), 'utf8');
    await store.load();
    assert.strictEqual(store.loadError, null, 'a successful load clears the recorded failure');
    await store.save();
    assert.strictEqual(JSON.parse(await fsp.readFile(file, 'utf8')).version, 4);
  });

  // ---------- existing usage: construct and save without load ----------
  await checkAsync('a fresh store can still save directly without load()', async () => {
    const dir = await tempRoot();
    const file = storePathIn(dir);
    const store = new RpaStore(file);
    store.data.plans.push({ id: 'direct', plan_name: 'direct', steps: [], update_time: '' });
    assert.strictEqual(store.loadError, null);
    await store.save();
    const onDisk = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.ok(onDisk.plans.some((plan) => plan.id === 'direct'), 'direct save persists the in-memory data');
  });

  // ================= report =================
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nRPA_STORE_LOAD_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${results.filter((r) => r.ok).length}/${results.length}`);
  if (failed.length) process.exitCode = 1;

  await Promise.all(tempRoots.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
})().catch((error) => {
  console.error('RPA_STORE_LOAD_SELFTEST CRASHED', error);
  process.exitCode = 1;
});
