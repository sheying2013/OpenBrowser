const path = require('path');
const fs = require('fs/promises');
const { BrowserEngine } = require('./engine');
const { launchInstaller, closeInstaller } = require('./extension-pipe');

async function waitForPort(root) {
  const file = path.join(root, 'DevToolsActivePort');
  for (let i = 0; i < 80; i++) { try { const text = await fs.readFile(file, 'utf8'); return Number(text.split(/\r?\n/)[0]); } catch (_) {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  return null;
}

async function main() {
  const root = path.join(__dirname, '..', 'extension-pipe-port-selftest-data'); await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  const engine = new BrowserEngine({ getPath: () => root }); const browser = engine.chooseBrowser();
  const installer = await launchInstaller(browser.path, root, [
    '--remote-debugging-port=0',
    '--remote-allow-origins=http://127.0.0.1,http://localhost',
  ]);
  try {
    const loaded = await installer.connection.command('Extensions.loadUnpacked', { path: path.join(__dirname, 'bundled-extension'), enableInIncognito: false });
    const port = await waitForPort(root);
    process.stdout.write(JSON.stringify({ success: Boolean(port), port, extensionId: loaded.id, processId: installer.child.pid }, null, 2));
    if (!port) process.exitCode = 4;
  } finally { await closeInstaller(installer); await fs.rm(root, { recursive: true, force: true }); }
}

main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
