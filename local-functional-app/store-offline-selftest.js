const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { addChromeStoreExtension } = require('./store-extension');

function run(command, args) { return new Promise((resolve, reject) => { const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${code}`))); }); }

async function main() {
  const root = path.join(__dirname, '..', 'store-offline-selftest-data');
  const source = path.join(root, 'source'); const zipFile = path.join(root, 'fixture.zip');
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Store Fixture', version: '1.2.3' }), 'utf8');
  await fs.writeFile(path.join(source, 'worker.js'), 'console.log("fixture")', 'utf8');
  await run('tar.exe', ['-a', '-cf', zipFile, '-C', source, '.']);
  const zip = await fs.readFile(zipFile); const header = Buffer.alloc(12); header.write('Cr24', 0, 'ascii'); header.writeUInt32LE(3, 4); header.writeUInt32LE(0, 8); const crx = Buffer.concat([header, zip]);
  try {
    const result = await addChromeStoreExtension('https://chromewebstore.google.com/detail/fixture/aapbdbdomjkkjkaonfhkkikfgjllcleb', path.join(root, 'user-data'), async (directory) => { const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')); return { id: 'temp', name: manifest.name, version: manifest.version, path: directory, manifestVersion: manifest.manifest_version }; }, async () => crx);
    process.stdout.write(JSON.stringify({ success: true, id: result.storeId, name: result.name, version: result.version, source: result.source }, null, 2));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
