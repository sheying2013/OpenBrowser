'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { ProxyStore } = require('./automation/proxy-store');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-proxy-persistence-'));
  const filePath = path.join(directory, 'proxy-library.json');

  try {
    await fs.writeFile(filePath, JSON.stringify({
      version: 1,
      items: [
        {
          id: 'encoded-auth',
          name: 'Encoded auth',
          raw: 'socks5://user%40mail:p%3Aa%2Fss%25@proxy.test:1080',
          username: '',
          password: '',
          create_time: '2026-01-01T00:00:00.000Z',
          update_time: '2026-01-02T00:00:00.000Z',
        },
        {
          id: 'legacy-fields',
          name: 'Legacy fields',
          proxy_type: 'http',
          proxy_host: 'legacy.test',
          proxy_port: '3128',
          proxy_user: 'legacy-user',
          proxy_password: 'legacy-pass',
        },
        {
          id: 'split-auth',
          name: 'Split auth',
          raw: 'socks5://split.test:1080',
          username: 'split-user',
          password: 'split-pass',
        },
      ],
    }, null, 2));

    const store = new ProxyStore(filePath);
    await store.load();
    const encoded = store.get('encoded-auth');
    assert.strictEqual(encoded.username, 'user@mail');
    assert.strictEqual(encoded.password, 'p:a/ss%');
    assert.strictEqual(encoded.update_time, '2026-01-02T00:00:00.000Z');
    assert.strictEqual(store.get('legacy-fields').raw, 'http://legacy-user:legacy-pass@legacy.test:3128');
    assert.strictEqual(store.get('split-auth').username, 'split-user');
    assert.strictEqual(store.get('split-auth').password, 'split-pass');
    assert.strictEqual(store.get('split-auth').raw, 'socks5://split-user:split-pass@split.test:1080');

    const migratedDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.strictEqual(migratedDisk.version, 2);
    assert.strictEqual(migratedDisk.items[0].username, 'user@mail');
    assert.strictEqual(migratedDisk.items[0].password, 'p:a/ss%');

    await store.update('encoded-auth', {
      name: 'Blank patch keeps auth',
      host: '',
      port: '',
      username: '',
      password: '',
      raw: '',
    });
    assert.strictEqual(store.get('encoded-auth').username, 'user@mail');
    assert.strictEqual(store.get('encoded-auth').password, 'p:a/ss%');

    await store.update('encoded-auth', {
      raw: 'socks5://proxy.test:1080',
      proxyAuthAction: 'clear',
    });
    assert.strictEqual(store.get('encoded-auth').username, '');
    assert.strictEqual(store.get('encoded-auth').password, '');
    assert.strictEqual(store.get('encoded-auth').authenticated, false);
    const clearRestart = new ProxyStore(filePath);
    await clearRestart.load();
    assert.strictEqual(clearRestart.get('encoded-auth').username, '');
    assert.strictEqual(clearRestart.get('encoded-auth').password, '');
    assert.strictEqual(clearRestart.get('encoded-auth').raw, 'socks5://proxy.test:1080');

    await store.update('encoded-auth', {
      raw: clearRestart.get('encoded-auth').raw,
      username: 'restart@user',
      password: 'restart:pass/100%',
    });

    const afterRestart = new ProxyStore(filePath);
    await afterRestart.load();
    const restarted = afterRestart.get('encoded-auth');
    assert.strictEqual(restarted.username, 'restart@user');
    assert.strictEqual(restarted.password, 'restart:pass/100%');
    assert.ok(restarted.raw.includes('restart%40user:restart%3Apass%2F100%25@'));

    const created = await Promise.all(Array.from({ length: 40 }, (_, index) => store.create({
      raw: `socks5://user-${index}:pass-${index}@proxy-${index}.test:${2000 + index}`,
      name: `Concurrent ${index}`,
    })));
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.update(created[0].id, {
      username: 'race-user',
      password: `race-pass-${index}`,
    })));

    const concurrentRestart = new ProxyStore(filePath);
    await concurrentRestart.load();
    assert.strictEqual(concurrentRestart.list().length, 43);
    assert.strictEqual(concurrentRestart.get(created[0].id).password, 'race-pass-19');
    JSON.parse(await fs.readFile(filePath, 'utf8'));
    const leftovers = (await fs.readdir(directory)).filter((name) => name.includes('.tmp-'));
    assert.deepStrictEqual(leftovers, []);

    const recoveryPath = path.join(directory, 'recovery.json');
    await fs.writeFile(recoveryPath + '.tmp', JSON.stringify({
      version: 1,
      items: [{ id: 'recovered', raw: 'http://recover-user:recover-pass@recovery.test:8080' }],
    }));
    const recoveredStore = new ProxyStore(recoveryPath);
    await recoveredStore.load();
    assert.strictEqual(recoveredStore.get('recovered').password, 'recover-pass');
    await fs.access(recoveryPath);
    await assert.rejects(fs.access(recoveryPath + '.tmp'));

    const uniqueRecoveryPath = path.join(directory, 'unique-recovery.json');
    const validUniqueTemp = uniqueRecoveryPath + '.tmp-123-valid';
    const invalidUniqueTemp = uniqueRecoveryPath + '.tmp-124-invalid';
    await fs.writeFile(validUniqueTemp, JSON.stringify({
      version: 2,
      items: [{ id: 'unique-recovered', raw: 'http://unique-user:unique-pass@unique.test:8081' }],
    }));
    await fs.writeFile(invalidUniqueTemp, '{broken-json');
    const nowSeconds = Date.now() / 1000;
    await fs.utimes(validUniqueTemp, nowSeconds - 10, nowSeconds - 10);
    await fs.utimes(invalidUniqueTemp, nowSeconds, nowSeconds);
    const uniqueRecoveredStore = new ProxyStore(uniqueRecoveryPath);
    await uniqueRecoveredStore.load();
    assert.strictEqual(uniqueRecoveredStore.get('unique-recovered').password, 'unique-pass');
    await fs.access(uniqueRecoveryPath);
    await fs.access(uniqueRecoveryPath + '.bak');
    assert.deepStrictEqual(
      (await fs.readdir(directory)).filter((name) => name.startsWith('unique-recovery.json.tmp-')),
      [],
    );

    const backupPath = path.join(directory, 'backup-recovery.json');
    const backupStore = new ProxyStore(backupPath);
    await backupStore.load();
    const backupItem = await backupStore.create({
      id: 'backup-item',
      raw: 'http://backup-user:old-pass@backup.test:8082',
    });
    await backupStore.update(backupItem.id, { password: 'new-pass' });
    assert.strictEqual(backupStore.get(backupItem.id).password, 'new-pass');
    await fs.writeFile(backupPath, '{corrupt-main');
    const corruptMainBytes = await fs.readFile(backupPath, 'utf8');
    const restoredBackupStore = new ProxyStore(backupPath);
    await restoredBackupStore.load();
    assert.strictEqual(restoredBackupStore.get(backupItem.id).password, 'old-pass');
    JSON.parse(await fs.readFile(backupPath, 'utf8'));
    const corruptSnapshots = (await fs.readdir(directory))
      .filter((name) => name.startsWith('backup-recovery.json.corrupt-'));
    assert.strictEqual(corruptSnapshots.length, 1);
    assert.strictEqual(
      await fs.readFile(path.join(directory, corruptSnapshots[0]), 'utf8'),
      corruptMainBytes,
    );

    const unrecoverablePath = path.join(directory, 'unrecoverable.json');
    await fs.writeFile(unrecoverablePath, '{still-corrupt');
    const unrecoverableStore = new ProxyStore(unrecoverablePath);
    await assert.rejects(
      unrecoverableStore.load(),
      (error) => error.code === 'ERR_PROXY_STORE_CORRUPT' && /损坏且没有可用备份/.test(error.message),
    );
    assert.strictEqual(await fs.readFile(unrecoverablePath, 'utf8'), '{still-corrupt');
    await assert.rejects(unrecoverableStore.create({
      raw: 'http://should-not-overwrite:secret@unrecoverable.test:8080',
    }), (error) => error.code === 'ERR_PROXY_STORE_CORRUPT' && /损坏且没有可用备份/.test(error.message));
    assert.strictEqual(await fs.readFile(unrecoverablePath, 'utf8'), '{still-corrupt');

    const invalidShapePath = path.join(directory, 'invalid-shape.json');
    const invalidShapeBytes = '{"version":2,"items":{}}';
    await fs.writeFile(invalidShapePath, invalidShapeBytes);
    const invalidShapeStore = new ProxyStore(invalidShapePath);
    await assert.rejects(
      invalidShapeStore.load(),
      (error) => error.code === 'ERR_PROXY_STORE_CORRUPT' && /损坏且没有可用备份/.test(error.message),
    );
    assert.strictEqual(await fs.readFile(invalidShapePath, 'utf8'), invalidShapeBytes);

    const rollbackPath = path.join(directory, 'rollback.json');
    const rollbackStore = new ProxyStore(rollbackPath);
    await rollbackStore.load();
    const rollbackItem = await rollbackStore.create({
      id: 'rollback-item',
      raw: 'socks5://rollback-user:rollback-pass@rollback.test:1080',
    });

    const assertRollback = async (label, operation) => {
      const beforeMemory = JSON.stringify(rollbackStore.list());
      const beforeDisk = await fs.readFile(rollbackPath, 'utf8');
      const persist = rollbackStore._persistData;
      rollbackStore._persistData = async () => { throw new Error('forced-persist-failure-' + label); };
      try {
        await assert.rejects(operation(), new RegExp('forced-persist-failure-' + label));
      } finally {
        rollbackStore._persistData = persist;
      }
      assert.strictEqual(JSON.stringify(rollbackStore.list()), beforeMemory, label + ' must roll back memory');
      assert.strictEqual(await fs.readFile(rollbackPath, 'utf8'), beforeDisk, label + ' must not change disk');
    };

    await assertRollback('create', () => rollbackStore.create({ raw: 'http://new-user:new-pass@new.test:8080' }));
    await assertRollback('create-many', () => rollbackStore.createMany([{ raw: 'http://many-user:many-pass@many.test:8080' }]));
    await assertRollback('update', () => rollbackStore.update(rollbackItem.id, { password: 'changed-pass' }));
    await assertRollback('remove', () => rollbackStore.remove(rollbackItem.id));
    await assertRollback('mark-check', () => rollbackStore.markCheck(rollbackItem.id, { ip: '203.0.113.9' }));
    await assertRollback('mark-check-error', () => rollbackStore.markCheckError(rollbackItem.id, { errorClass: 'auth' }));
    await assertRollback('replace-all', () => rollbackStore.replaceAll([{ id: 'replacement-failed', raw: 'http://u:p@failed.test:8080' }]));

    await rollbackStore.update(rollbackItem.id, { password: 'queue-recovered' });
    assert.strictEqual(rollbackStore.get(rollbackItem.id).password, 'queue-recovered');

    const pendingCreates = Array.from({ length: 12 }, (_, index) => rollbackStore.create({
      id: 'flush-' + index,
      raw: `http://flush-user-${index}:flush-pass-${index}@flush-${index}.test:${3000 + index}`,
    }));
    await rollbackStore.flush();
    await Promise.all(pendingCreates);
    const flushedStore = new ProxyStore(rollbackPath);
    await flushedStore.load();
    assert.strictEqual(flushedStore.list().filter((item) => item.id.startsWith('flush-')).length, 12);

    const longPassword = 'long-secret-' + 'x'.repeat(2048);
    const replacement = await rollbackStore.replaceAll([{
      id: 'long-credential',
      name: 'Long credential',
      raw: `http://long-user:${longPassword}@long.test:8088`,
    }]);
    assert.strictEqual(replacement.length, 1);
    assert.strictEqual(rollbackStore.get('long-credential').password, longPassword);
    assert.ok(rollbackStore.get('long-credential').raw.length > 500);
    const replacedRestart = new ProxyStore(rollbackPath);
    await replacedRestart.load();
    assert.strictEqual(replacedRestart.list().length, 1);
    assert.strictEqual(replacedRestart.get('long-credential').password, longPassword);

    console.log('PROXY_PERSISTENCE_SELFTEST_OK migration=1 restart=1 encoding=1 blank_patch=1 explicit_clear=1 clear_restart=1 mutation_queue=1 flush=1 tmp_scan=1 backup_recovery=1 corrupt_preserved=1 rollback=1 replace_all=1 long_credentials=1');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
