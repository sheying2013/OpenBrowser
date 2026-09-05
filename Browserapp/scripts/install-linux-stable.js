#!/usr/bin/env node
'use strict';

/** Prepare the official Google Chrome Stable .deb for Ubuntu x86_64 packages. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const {
  CHROME_STABLE_PACKAGES,
  downloadFile,
  extractDeb,
} = require('../automation/browser-kernel');

const appRoot = path.resolve(__dirname, '..');
const kernelsRoot = path.join(appRoot, 'kernels');
const targetRoot = path.join(kernelsRoot, 'chrome-stable');
const targetBinary = path.join(targetRoot, 'opt', 'google', 'chrome', 'chrome');

function assertLinuxX64() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`Linux kernel preparation requires linux/x64, got ${process.platform}/${process.arch}`);
  }
}

function configuredProxy() {
  return String(process.env.https_proxy || process.env.HTTPS_PROXY || '').trim();
}

function downloadWithConfiguredProxy(url, destination, proxy) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', [
      '--fail', '--location', '--retry', '3', '--connect-timeout', '30', '--silent', '--show-error',
      '--proxy', proxy, '--output', destination, url,
    ], { stdio: 'inherit' });
    child.on('error', (error) => reject(new Error(`Unable to start curl for proxy download: ${error.message}`)));
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Proxy kernel download failed (exit=${code == null ? signal : code})`));
    });
  });
}

function packageVersion(archive) {
  try {
    return String(execFileSync('dpkg-deb', ['-f', archive, 'Version'], { encoding: 'utf8' })).trim() || 'stable';
  } catch (_) {
    return 'stable';
  }
}

async function existingVersion() {
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(targetRoot, 'kernel.json'), 'utf8'));
    await fsp.access(targetBinary, fs.constants.X_OK);
    return String(manifest.version || '').trim() || null;
  } catch (_) {
    return null;
  }
}

async function main() {
  assertLinuxX64();
  const packageInfo = CHROME_STABLE_PACKAGES['linux:x64'];
  if (!packageInfo) throw new Error('Google Chrome Stable linux-x64 package is unavailable');

  if (await existingVersion()) {
    console.log(`[kernel] Google Chrome Stable is already prepared at ${targetBinary}`);
    return;
  }

  await fsp.mkdir(kernelsRoot, { recursive: true });
  const work = await fsp.mkdtemp(path.join(kernelsRoot, '.linux-stable-download-'));
  const archive = path.join(work, 'google-chrome-stable.deb');
  const extracted = path.join(work, 'extracted');
  const stage = path.join(kernelsRoot, `.chrome-stable-stage-${process.pid}`);
  try {
    console.log('[kernel] downloading Google Chrome Stable for linux-x64');
    const proxy = configuredProxy();
    if (proxy) await downloadWithConfiguredProxy(packageInfo.url, archive, proxy);
    else await downloadFile(packageInfo.url, archive, ({ percent }) => console.log(`[kernel] download ${percent}%`));

    await fsp.mkdir(extracted, { recursive: true });
    await extractDeb(archive, extracted);
    const extractedBinary = path.join(extracted, 'opt', 'google', 'chrome', 'chrome');
    await fsp.chmod(extractedBinary, 0o755);
    await fsp.access(extractedBinary, fs.constants.X_OK);

    await fsp.rm(stage, { recursive: true, force: true });
    await fsp.rename(extracted, stage);
    const version = packageVersion(archive);
    await fsp.writeFile(path.join(stage, 'kernel.json'), JSON.stringify({
      version,
      source: 'chrome-stable',
      platform: 'linux-x64',
      downloadUrl: packageInfo.url,
    }, null, 2) + '\n', 'utf8');
    await fsp.rm(targetRoot, { recursive: true, force: true });
    await fsp.rename(stage, targetRoot);
    console.log(`[kernel] prepared Google Chrome Stable ${version} at ${targetBinary}`);
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[kernel] ${error.message || error}`);
  process.exitCode = 1;
});
