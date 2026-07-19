const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { BrowserEngine } = require('./engine');

async function run() {
  const root = path.join(__dirname, '.tmp-profile-batch-selftest-' + process.pid);
  await fsp.rm(root, { recursive: true, force: true });
  const engine = new BrowserEngine({ getPath: () => root });
  const existing = [1, 2, 3, 4].map((number) => ({ id: 'env-' + String(number).padStart(3, '0'), name: 'Existing ' + number }));
  engine.syncProfiles(existing);
  engine.extensions.set('ext-global', { id: 'ext-global', name: 'Global Test', version: '1.0.0', path: root, builtIn: false });
  await engine.assignExtension('ext-global', existing.map((item) => item.id), true);

  const added = [5, 6, 7].map((number) => ({ id: 'env-' + String(number).padStart(3, '0'), name: 'Batch ' + number }));
  engine.syncProfiles([...existing, ...added]);
  for (const profile of added) assert(engine.assignments.get(profile.id).has('ext-global'), profile.id + ' did not inherit the global extension');

  for (const id of ['env-005', 'env-006', 'env-007']) {
    await fsp.mkdir(engine.profileRoot(id), { recursive: true });
    await fsp.writeFile(path.join(engine.profileRoot(id), 'marker.txt'), id);
  }
  const stopped = [];
  engine.running.set('env-005', { pid: 12345 });
  engine.stop = async (id) => { stopped.push(id); engine.running.delete(id); return { id, running: false }; };

  const deleted = await engine.deleteProfiles(['env-005', 'env-006'], true);
  assert.strictEqual(deleted.deleted, 2);
  assert.strictEqual(deleted.stopped, 1);
  assert.deepStrictEqual(stopped, ['env-005']);
  assert(!engine.profiles.has('env-005') && !engine.profiles.has('env-006'));
  assert(!engine.assignments.has('env-005') && !engine.assignments.has('env-006'));
  assert(!fs.existsSync(engine.profileRoot('env-005')) && !fs.existsSync(engine.profileRoot('env-006')));
  assert(engine.listExtensions().find((item) => item.id === 'ext-global').enabledAll);

  const retained = await engine.deleteProfiles(['env-007'], false);
  assert.strictEqual(retained.deleted, 1);
  assert(fs.existsSync(engine.profileRoot('env-007')), 'Browser data should be retained when deleteData is false');
  assert.strictEqual(engine.status().length, 4);
  await fsp.rm(root, { recursive: true, force: true });
  console.log('PROFILE_BATCH_SELFTEST_OK created=3 deleted=3 stopped=1 data_delete=2 data_retain=1 extension_inheritance=3');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
