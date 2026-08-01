#!/usr/bin/env node
'use strict';

/**
 * Prepare the Chrome for Testing kernel that ships in Ubuntu x86_64 packages.
 * This is a packaging/CI helper only. The application never downloads a
 * browser kernel at runtime.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const {
  CFT_META,
  downloadFile,
  extractZip,
} = require('../automation/browser-kernel');

const appRoot = path.resolve(__dirname, '..');
const kernelsRoot = path.join(appRoot, 'kernels');
const targetRoot = path.join(kernelsRoot, 'chrome-for-testing');
const targetBinary = path.join(targetRoot, 'chrome-linux64', 'chrome');
const maxMetadataBytes = 2 * 1024 * 1024;

function assertLinuxX64() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`Linux kernel preparation requires linux/x64, got ${process.platform}/${process.arch}`);
  }
}

async function readMetadata() {
  const response = await fetch(CFT_META, {
    headers: { 'User-Agent': 'OpenBrowser/1.0 (package kernel)' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Chrome for Testing metadata request failed (${response.status})`);
  const length = Number(response.headers.get('content-length')) || 0;
  if (length > maxMetadataBytes) throw new Error('Chrome for Testing metadata exceeds 2 MiB');
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maxMetadataBytes) throw new Error('Chrome for Testing metadata exceeds 2 MiB');
  return JSON.parse(raw);
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

async function main() {
  assertLinuxX64();
  const metadata = await readMetadata();
  const stable = metadata?.channels?.Stable;
  const version = String(stable?.version || '').trim();
  const entry = (stable?.downloads?.chrome || []).find((item) => item?.platform === 'linux64');
  const url = String(entry?.url || '').trim();
  if (!version || !url) throw new Error('Chrome for Testing stable linux64 download is unavailable');

  if (await existingVersion() === version) {
    console.log(`[kernel] Linux Chrome for Testing ${version} is already prepared`);
    return;
  }

  // Keep extraction and the final staging directory on the same filesystem so
  // the final rename is atomic even when /tmp is a separate tmpfs.
  await fsp.mkdir(kernelsRoot, { recursive: true });
  const work = await fsp.mkdtemp(path.join(kernelsRoot, '.linux-cft-download-'));
  const archive = path.join(work, 'chrome-linux64.zip');
  const extracted = path.join(work, 'extracted');
  const stage = path.join(kernelsRoot, `.chrome-for-testing-stage-${process.pid}`);
  let previousPercent = -10;
  try {
    console.log(`[kernel] downloading Chrome for Testing ${version} for linux64`);
    const proxy = configuredProxy();
    if (proxy) {
      console.log('[kernel] downloading through configured HTTPS proxy');
      await downloadWithConfiguredProxy(url, archive, proxy);
    } else {
      await downloadFile(url, archive, ({ percent }) => {
        if (percent >= previousPercent + 10) {
          previousPercent = percent;
          console.log(`[kernel] download ${percent}%`);
        }
      });
    }
    await fsp.mkdir(extracted, { recursive: true });
    await extractZip(archive, extracted);

    const extractedRoot = path.join(extracted, 'chrome-linux64');
    const extractedBinary = path.join(extractedRoot, 'chrome');
    // Some ZIP extractors do not retain POSIX modes. The archive contents have
    // already passed the shared path/symlink safety checks in extractZip().
    await fsp.chmod(extractedBinary, 0o755);
    await fsp.access(extractedBinary, fs.constants.X_OK);

    await fsp.rm(stage, { recursive: true, force: true });
    await fsp.mkdir(stage, { recursive: true });
    await fsp.rename(extractedRoot, path.join(stage, 'chrome-linux64'));
    await fsp.writeFile(path.join(stage, 'kernel.json'), JSON.stringify({
      version,
      source: 'chrome-for-testing',
      platform: 'linux-x64',
      downloadUrl: url,
    }, null, 2) + '\n', 'utf8');
    await fsp.rm(targetRoot, { recursive: true, force: true });
    await fsp.rename(stage, targetRoot);
    console.log(`[kernel] prepared Linux Chrome for Testing ${version} at ${targetBinary}`);
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[kernel] ${error.message || error}`);
  process.exitCode = 1;
});
