#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  WAYFERN_META,
  downloadFile,
  extractZip,
  extractDmg,
  extractTarXz,
  extractTarGz,
  archiveKindFromUrl,
  resolveWayfernBinary,
} = require('../automation/browser-kernel');

const appRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(appRoot, 'bundled-kernels', 'wayfern');

function packageArch() {
  const value = String(process.env.OPENBROWSER_PACKAGE_ARCH || process.arch).toLowerCase();
  if (value === 'x64' || value === 'amd64' || value === 'x86_64') return 'x64';
  if (value === 'aarch64') return 'arm64';
  return value;
}

function platformKey() {
  const arch = packageArch();
  if (process.platform === 'darwin') return `macos-${arch}`;
  if (process.platform === 'win32') return `windows-${arch}`;
  throw new Error(`Unsupported bundled kernel host: ${process.platform}/${arch}`);
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'OpenBrowser build/1.0.1' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function main() {
  const platform = platformKey();
  if (platform === 'macos-x64') {
    throw new Error('macOS x64 uses the checked-in OpenBrowser 148 kernel and does not need Wayfern bundling');
  }

  const feed = await fetchJson(WAYFERN_META);
  const version = String(feed.version || '').trim();
  const url = String(feed.downloads?.[platform] || '').trim();
  if (!version || !url) throw new Error(`Wayfern feed has no ${platform} package`);

  await fsp.rm(outputRoot, { recursive: true, force: true });
  await fsp.mkdir(outputRoot, { recursive: true });
  const kind = archiveKindFromUrl(url);
  const extension = kind === 'dmg' ? 'dmg' : kind === 'tar.xz' ? 'tar.xz' : kind === 'tar.gz' ? 'tar.gz' : 'zip';
  const archivePath = path.join(os.tmpdir(), `openbrowser-wayfern-${platform}-${version}.${extension}`);
  const extractRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'openbrowser-wayfern-'));

  try {
    console.log(`[kernel] downloading ${platform} Wayfern ${version}`);
    await downloadFile(url, archivePath, ({ percent }) => {
      if (percent % 10 === 0) process.stdout.write(`[kernel] ${percent}%\n`);
    });
    if (kind === 'dmg') await extractDmg(archivePath, extractRoot);
    else if (kind === 'zip') await extractZip(archivePath, extractRoot);
    else if (kind === 'tar.xz') await extractTarXz(archivePath, extractRoot);
    else if (kind === 'tar.gz') await extractTarGz(archivePath, extractRoot);
    else throw new Error(`Unsupported Wayfern archive type: ${kind}`);

    const binary = await resolveWayfernBinary(extractRoot);
    if (!binary) throw new Error('Wayfern archive does not contain a browser executable');
    await fsp.cp(extractRoot, outputRoot, { recursive: true, force: true, verbatimSymlinks: true });
    if (process.platform !== 'win32') await fsp.chmod(path.join(outputRoot, path.relative(extractRoot, binary)), 0o755);
    await fsp.writeFile(path.join(outputRoot, 'kernel.json'), JSON.stringify({
      source: 'donut-wayfern',
      version,
      platform,
      url,
    }, null, 2) + '\n', 'utf8');
    console.log(`[kernel] prepared ${platform} kernel at ${outputRoot}`);
  } finally {
    await fsp.rm(archivePath, { force: true }).catch(() => {});
    await fsp.rm(extractRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[kernel] ${error.message}`);
  process.exitCode = 1;
});
