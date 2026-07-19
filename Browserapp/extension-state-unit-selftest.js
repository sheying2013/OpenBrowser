const fs = require('fs/promises');
const path = require('path');
const { BrowserEngine } = require('./engine');

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function main() {
  const root = path.join(__dirname, '..', 'extension-state-unit-selftest-data');
  await fs.rm(root, { recursive: true, force: true });
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  const profileIds = ['env-001', 'env-002', 'env-003', 'env-004'];
  engine.syncProfiles(profileIds.map((id) => ({ id, name: id, browser: 'Google Chrome', proxy: 'Direct' })));
  engine.extensions.set('test-extension', {
    id: 'test-extension',
    name: 'Test Extension',
    version: '1.0.0',
    description: 'State test',
    manifestVersion: 3,
    path: __dirname,
    builtIn: false,
  });

  try {
    await engine.assignExtension('test-extension', profileIds, true);
    const all = engine.listExtensions()[0];
    assert(all.enabledAll === true, 'blue/all state was not reported');
    assert(all.assignedProfiles === 4, 'all state did not include four environments');
    assert(all.assignedProfileIds.length === 4, 'assignment dialog data did not include all environments');

    await engine.assignExtension('test-extension', ['env-004'], false);
    const partial = engine.listExtensions()[0];
    assert(partial.enabledAll === false, 'partial state was incorrectly reported as all');
    assert(partial.assignedProfiles === 3, 'partial state count is incorrect');
    assert(!partial.assignedProfileIds.includes('env-004'), 'assignment dialog kept a disabled environment checked');

    await engine.assignExtension('test-extension', profileIds, false);
    const none = engine.listExtensions()[0];
    assert(none.enabledAll === false, 'gray/none state was incorrectly reported as all');
    assert(none.assignedProfiles === 0, 'none state still has assigned environments');

    process.stdout.write(JSON.stringify({
      success: true,
      all: { enabledAll: all.enabledAll, assignedProfiles: all.assignedProfiles },
      partial: { enabledAll: partial.enabledAll, assignedProfiles: partial.assignedProfiles },
      none: { enabledAll: none.enabledAll, assignedProfiles: none.assignedProfiles },
    }, null, 2));
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(error.stack || error.message);
  process.exitCode = 1;
});
