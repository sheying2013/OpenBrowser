const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const { BrowserEngine } = require('./engine');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function targets(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/json/list`, { timeout: 2500 }, (response) => {
      let body = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('timeout', () => request.destroy(new Error('target list timeout'))); request.on('error', reject);
  });
}

async function main() {
  const root = path.join(__dirname, '..', 'extension-startup-target-data');
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  try {
    await engine.init(null);
    const extensionRoot = path.join(process.env.APPDATA || '', 'openbrowser', 'chrome-store-extensions');
    const extensionPaths = ['mcohilncbfahbmgdjkbpemcciiolgcge', 'cdmhpjjhnamicehbdojmlnnodfcgnehn'].map((id) => path.join(extensionRoot, id));
    const extensions = [];
    for (const extensionPath of extensionPaths) extensions.push(await engine.addExtension(extensionPath));
    const profile = { id: 'startup-extension-probe', number: 1, name: '1', browser: 'Google Chrome', proxy: 'Direct' };
    engine.syncProfiles([profile]);
    for (const extension of extensions) await engine.assignExtension(extension.id, [profile.id], true);
    const running = await engine.start(profile); const seen = new Map();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      for (const target of await targets(running.port)) {
        const key = [target.type, target.url, target.id].join('|');
        if (!seen.has(key)) seen.set(key, { atMs: attempt * 100, type: target.type, title: target.title, url: target.url, id: target.id });
      }
      await wait(100);
    }
    const values = [...seen.values()]; const finalTargets = await targets(running.port);
    const finalPages = finalTargets.filter((item) => item.type === 'page').map((item) => ({ title: item.title, url: item.url, id: item.id }));
    if (finalPages.length !== 1 || !/openbrowser-start\\.html/i.test(finalPages[0].url)) throw new Error('Startup extension page was not suppressed: ' + JSON.stringify(finalPages));
    process.stdout.write(JSON.stringify({ success: true, extensions: extensions.map((item) => item.name), pageTargets: values.filter((item) => item.type === 'page'), finalPageTargets: finalPages, extensionTargets: values.filter((item) => /^(chrome|edge)-extension:/i.test(item.url)) }, null, 2));
  } finally {
    await engine.stopAll().catch(() => {}); await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });