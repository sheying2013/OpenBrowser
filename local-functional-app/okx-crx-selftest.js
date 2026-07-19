const fs = require('fs/promises');
const path = require('path');
const { addChromeStoreExtension } = require('./store-extension');

async function main() {
  const crxFile = 'C:/tmp/okx-wallet.crx'; const root = path.join(__dirname, '..', 'okx-crx-selftest-data');
  await fs.rm(root, { recursive: true, force: true });
  try {
    const extension = await addChromeStoreExtension('https://chromewebstore.google.com/detail/okx-wallet/mcohilncbfahbmgdjkbpemcciiolgcge', root, async (directory) => { const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')); return { id: 'temporary', name: manifest.name, version: manifest.version, path: directory, manifestVersion: manifest.manifest_version }; }, () => fs.readFile(crxFile));
    const manifest = JSON.parse(await fs.readFile(path.join(extension.path, 'manifest.json'), 'utf8'));
    process.stdout.write(JSON.stringify({ success: true, storeId: extension.storeId, name: manifest.name, version: manifest.version, manifestVersion: manifest.manifest_version, files: (await fs.readdir(extension.path)).length }, null, 2));
  } finally { await fs.rm(root, { recursive: true, force: true }).catch(() => {}); await fs.rm(crxFile, { force: true }).catch(() => {}); }
}
main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
