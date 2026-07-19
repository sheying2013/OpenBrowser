const fs = require('fs/promises');
const path = require('path');
const { addChromeStoreExtension, extractStoreId } = require('./store-extension');

async function readManifest(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (![2, 3].includes(manifest.manifest_version)) throw new Error('Unexpected manifest version');
  return { id: 'temporary', name: manifest.name, version: manifest.version, path: directory, manifestVersion: manifest.manifest_version };
}

async function main() {
  const url = 'https://chromewebstore.google.com/detail/google-translate/aapbdbdomjkkjkaonfhkkikfgjllcleb';
  const id = extractStoreId(url);
  const root = path.join(__dirname, '..', 'store-selftest-data');
  await fs.rm(root, { recursive: true, force: true });
  try {
    const extension = await addChromeStoreExtension(url, root, readManifest);
    const manifest = JSON.parse(await fs.readFile(path.join(extension.path, 'manifest.json'), 'utf8'));
    process.stdout.write(JSON.stringify({ success: true, id, name: manifest.name, version: manifest.version, manifestVersion: manifest.manifest_version, fileCount: (await fs.readdir(extension.path)).length }, null, 2));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
