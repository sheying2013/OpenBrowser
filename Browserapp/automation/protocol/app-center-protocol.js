'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Application center copy protocol.
 *
 * Staging paths:
 *   global store:  source/extension/<appId>/<unique_id>/   (unpacked CRX)
 *   env cache:     <cacheFolder>/<unique_id>/
 *   launch stage:  <extensionCenter>/<unique_id>/          (per-browser copy)
 *   launch flag:   --load-extension=path1,path2,...
 *
 * copyApplication(app):
 *   target = extensionCenter/unique_id
 *   prefer USE_OLD_EXTENSION_FOLDER if cache exists + checkExtensionFormat
 *   else copy from ../../extension/{id}/{unique_id} → target
 *
 * checkApplicationFolder(extensionCenter, allowedUniqueIds):
 *   readdir(center); delete entries not in allowed list
 *
 * postApplication maps cloud items → local record fields:
 *   id, company_id, unique_id, download_url, oss_url, status,
 *   upload_type, version, fixed_status, name, legacy_flag,
 *   official_id, third_id, md5_hash, is_upload_verify
 */

function toLocalRecord(cloudApp = {}) {
  return {
    id: String(cloudApp.id || cloudApp.app_id || ''),
    company_id: String(cloudApp.company_id || ''),
    unique_id: String(cloudApp.unique_id || cloudApp.store_id || cloudApp.chrome_id || ''),
    download_url: cloudApp.download_url || '',
    oss_url: cloudApp.oss_url || '',
    status: String(cloudApp.status ?? '1'),
    upload_type: cloudApp.upload_type,
    version: cloudApp.version || '',
    fixed_status: cloudApp.fixed_status || '0',
    name: (cloudApp.application_name && cloudApp.application_name.en)
      || cloudApp.name
      || cloudApp.application_name
      || '',
    legacy_flag: cloudApp.legacy_flag || '',
    official_id: cloudApp.official_id || '',
    third_id: cloudApp.third_id || '',
    md5_hash: cloudApp.md5_hash || '',
    is_upload_verify: cloudApp.is_upload_verify || '0',
    path: cloudApp.path || '',
    used_path: cloudApp.used_path || (cloudApp.unique_id ? `ext/${cloudApp.unique_id}` : ''),
  };
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch (_) {
    return false;
  }
}

function safeComponent(value, label) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(text)) throw new Error(`${label} contains unsafe path characters`);
  return text;
}

async function assertCopySourceSafe(root) {
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('extension source must be a real directory');
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const stat = await fsp.lstat(target);
      if (stat.isSymbolicLink()) throw new Error('extension source contains a symbolic link or junction');
      if (stat.isDirectory()) pending.push(target);
    }
  }
}

async function copyFolder(src, dest) {
  await assertCopySourceSafe(src);
  await fsp.mkdir(dest, { recursive: true });
  // Node 16.7+ cp
  if (fsp.cp) {
    await fsp.cp(src, dest, { recursive: true, force: true });
    return;
  }
  // fallback
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyFolder(from, to);
    else await fsp.copyFile(from, to);
  }
}

/**
 * @param {object} app local record
 * @param {{ extensionCenter: string, cacheFolder: string, globalExtensionRoot: string }} paths
 */
async function copyApplication(app, paths) {
  const uniqueId = safeComponent(app.unique_id, 'unique_id');
  const target = path.join(paths.extensionCenter, uniqueId);
  const cache = path.join(paths.cacheFolder, uniqueId);
  const globalFolder = path.join(paths.globalExtensionRoot, safeComponent(app.id, 'application id'), uniqueId);

  // Prefer existing cache (USE_OLD_EXTENSION_FOLDER)
  if (await pathExists(cache) && await pathExists(path.join(cache, 'manifest.json'))) {
    if (target !== cache) {
      if (await pathExists(target)) await fsp.rm(target, { recursive: true, force: true });
      await copyFolder(cache, target);
    }
    return target;
  }

  // From global extension store
  const source = (await pathExists(path.join(globalFolder, 'manifest.json')))
    ? globalFolder
    : (app.path && await pathExists(path.join(app.path, 'manifest.json')) ? app.path : null);

  if (!source) {
    // already staged?
    if (await pathExists(path.join(target, 'manifest.json'))) return target;
    throw new Error('extension source not found for ' + uniqueId);
  }

  if (!(await pathExists(paths.extensionCenter))) {
    await fsp.mkdir(paths.extensionCenter, { recursive: true });
  }
  if (await pathExists(target)) {
    await fsp.rm(target, { recursive: true, force: true });
  }
  await copyFolder(source, target);
  return target;
}

/**
 * Remove staged apps not in allowed unique_id list.
 */
async function checkApplicationFolder(extensionCenter, allowedUniqueIds = []) {
  if (!(await pathExists(extensionCenter))) return true;
  const allowed = new Set(allowedUniqueIds.map(String));
  const entries = await fsp.readdir(extensionCenter);
  await Promise.all(entries.map(async (name) => {
    if (!allowed.has(name)) {
      await fsp.rm(path.join(extensionCenter, name), { recursive: true, force: true }).catch(() => {});
    }
  }));
  return true;
}

/**
 * Merge --load-extension paths into chrome args.
 */
function mergeLoadExtensionArgs(existingArgs = [], extensionPaths = []) {
  const args = [...existingArgs];
  const joined = extensionPaths.filter(Boolean).join(',');
  if (!joined) return args;
  const idx = args.findIndex((a) => String(a).startsWith('--load-extension='));
  if (idx >= 0) {
    const prev = args[idx].slice('--load-extension='.length);
    const set = new Set([...prev.split(',').filter(Boolean), ...joined.split(',').filter(Boolean)]);
    args[idx] = '--load-extension=' + [...set].join(',');
  } else {
    args.push('--load-extension=' + joined);
  }
  return args;
}

/**
 * Stage apps for a profile launch; returns load-extension paths.
 */
async function stageAppsForLaunch(apps, paths) {
  const allowed = [];
  const loadPaths = [];
  for (const app of apps) {
    const record = toLocalRecord(app);
    if (!record.unique_id) continue;
    try {
      const staged = await copyApplication(record, paths);
      allowed.push(record.unique_id);
      loadPaths.push(staged);
    } catch (error) {
      // skip broken app; continue staging remaining items
      console.log('copyApplication fail', record.unique_id, error.message);
    }
  }
  await checkApplicationFolder(paths.extensionCenter, allowed);
  return { allowed, loadPaths, args: mergeLoadExtensionArgs([], loadPaths) };
}

module.exports = {
  toLocalRecord,
  copyApplication,
  checkApplicationFolder,
  mergeLoadExtensionArgs,
  stageAppsForLaunch,
};
