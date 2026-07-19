const path = require('path');
const fs = require('fs/promises');
const { BrowserEngine } = require('./engine');
const { reconcileUnpackedExtensions } = require('./extension-pipe');

async function main() {
  const root = path.join(__dirname, '..', 'extension-pipe-selftest-data'); await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  const browser = engine.chooseBrowser(); const extensionPath = path.join(__dirname, 'bundled-extension');
  const loaded = await reconcileUnpackedExtensions(browser.path, path.join(root, 'profile'), [{ id: 'marker', path: extensionPath }], [extensionPath]);
  if (!loaded.extensions.some((item) => path.resolve(item.path).toLowerCase() === path.resolve(extensionPath).toLowerCase() && item.enabled)) throw new Error('extension was not loaded by pipe');
  const removed = await reconcileUnpackedExtensions(browser.path, path.join(root, 'profile'), [], [extensionPath]);
  if (removed.extensions.some((item) => path.resolve(item.path).toLowerCase() === path.resolve(extensionPath).toLowerCase())) throw new Error('extension was not removed by pipe');
  process.stdout.write(JSON.stringify({ success: true, browser: browser.path, loaded: loaded.extensions, removed: removed.extensions }, null, 2));
  await fs.rm(root, { recursive: true, force: true });
}

main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
