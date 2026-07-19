const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const { BrowserEngine } = require('./engine');
const cdp = require('./cdp');

const storeUrl = 'https://chromewebstore.google.com/detail/okx-wallet/mcohilncbfahbmgdjkbpemcciiolgcge';

async function fetchViaSystemProxy(url) {
  const output = path.join(__dirname, '..', `okx-${process.pid}-${Date.now()}.crx`);
  await new Promise((resolve, reject) => {
    const child = spawn('curl.exe', ['-L', '--fail', '--silent', '--show-error', '--max-time', '180', '--proxy', 'http://127.0.0.1:7897', '--output', output, url], { windowsHide: true }); let error = '';
    child.stderr.on('data', (value) => { error += value; }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(error || `curl exited ${code}`)));
  });
  try { return await fs.readFile(output); } finally { await fs.rm(output, { force: true }).catch(() => {}); }
}

async function installedExtensions(session) {
  const socket = await cdp.browserSocket(session.port);
  return (await cdp.call(socket, 'Extensions.getExtensions')).extensions || [];
}

async function main() {
  const root = path.join(__dirname, '..', 'store-batch-four-selftest-data');
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  const profiles = Array.from({ length: 4 }, (_, index) => ({ id: `store-env-${index + 1}`, name: index ? `Store Slave ${index}` : 'Store Master', browser: 'Google Chrome', proxy: 'Direct' }));
  try {
    await engine.init(null); engine.syncProfiles(profiles);
    const extension = await engine.addStoreExtension(storeUrl, fetchViaSystemProxy);
    if (extension.storeId !== 'mcohilncbfahbmgdjkbpemcciiolgcge') throw new Error('unexpected store extension id');
    await engine.assignExtension(extension.id, profiles.map((item) => item.id), true);
    const enabledCard = engine.listExtensions().find((item) => item.id === extension.id);
    if (!enabledCard?.enabledAll || enabledCard.assignedProfiles !== 4) throw new Error('Application Center did not report the extension enabled for all four profiles');
    const enabledSessions = [];
    for (const profile of profiles) enabledSessions.push(await engine.start(profile));
    const enabledLists = await Promise.all(enabledSessions.map(installedExtensions));
    const enabledMatches = enabledLists.map((list) => list.find((item) => path.resolve(item.path).toLowerCase() === path.resolve(extension.path).toLowerCase()));
    if (enabledMatches.some((item) => !item || !item.enabled)) throw new Error('OKX extension was not enabled in all four Google Chrome profiles: ' + JSON.stringify(enabledLists));

    await engine.stopAll();
    await engine.assignExtension(extension.id, profiles.map((item) => item.id), false);
    const disabledCard = engine.listExtensions().find((item) => item.id === extension.id);
    if (disabledCard?.enabledAll || disabledCard?.assignedProfiles !== 0) throw new Error('Application Center did not report the extension disabled for all profiles');
    const disabledSessions = [];
    for (const profile of profiles) disabledSessions.push(await engine.start(profile));
    const disabledLists = await Promise.all(disabledSessions.map(installedExtensions));
    if (disabledLists.some((list) => list.some((item) => path.resolve(item.path).toLowerCase() === path.resolve(extension.path).toLowerCase()))) throw new Error('OKX extension remained after global disable');

    process.stdout.write(JSON.stringify({ success: true, extension: { name: extension.name, version: extension.version, storeId: extension.storeId, path: extension.path }, applicationCenter: { enabledAll: enabledCard.enabledAll, enabledAssignments: enabledCard.assignedProfiles, disabledAll: disabledCard.enabledAll, disabledAssignments: disabledCard.assignedProfiles }, enabled: enabledMatches, disabledCounts: disabledLists.map((list) => list.length), browsers: enabledSessions.map((item) => item.browser) }, null, 2));
  } finally {
    await engine.stopAll().catch(() => {}); await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
