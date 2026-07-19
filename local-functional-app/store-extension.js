const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');

function extractStoreId(value) {
  const text = String(value || '').trim();
  const direct = text.match(/^[a-p]{32}$/i);
  if (direct) return direct[0].toLowerCase();
  let parsed;
  try { parsed = new URL(text); } catch (_) { throw new Error('请输入有效的 Chrome 应用商店 URL'); }
  if (!/(^|\.)chromewebstore\.google\.com$/i.test(parsed.hostname)) throw new Error('只支持 Chrome 应用商店链接');
  const match = parsed.pathname.match(/(?:^|\/)([a-p]{32})(?:\/|$)/i);
  if (!match) throw new Error('链接中没有找到 32 位扩展 ID');
  return match[1].toLowerCase();
}

function download(url, redirects = 0) {
  if (redirects > 6) return Promise.reject(new Error('Chrome 商店下载重定向过多'));
  const parsed = new URL(url);
  const allowed = ['clients2.google.com', 'clients2.googleusercontent.com'];
  if (parsed.protocol !== 'https:' || !allowed.includes(parsed.hostname.toLowerCase())) return Promise.reject(new Error('Chrome 商店返回了不受信任的下载地址'));
  return new Promise((resolve, reject) => {
    const request = https.get(parsed, { headers: { 'user-agent': 'Mozilla/5.0 OpenBrowserLocal/3.0' }, timeout: 25000 }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return resolve(download(new URL(response.headers.location, parsed).toString(), redirects + 1));
      }
      if (response.statusCode !== 200) { response.resume(); return reject(new Error(`Chrome 商店下载失败（HTTP ${response.statusCode}）`)); }
      const chunks = []; let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > 120 * 1024 * 1024) request.destroy(new Error('扩展包超过 120 MB 限制')); else chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('timeout', () => request.destroy(new Error('Chrome 商店下载超时')));
    request.on('error', reject);
  });
}

function readVarint(buffer, state) {
  let value = 0; let shift = 0;
  while (state.offset < buffer.length && shift < 35) { const byte = buffer[state.offset++]; value |= (byte & 0x7f) << shift; if ((byte & 0x80) === 0) return value >>> 0; shift += 7; }
  throw new Error('CRX3 protobuf varint is invalid');
}

function protobufFields(buffer) {
  const fields = []; const state = { offset: 0 };
  while (state.offset < buffer.length) {
    const tag = readVarint(buffer, state); const field = tag >>> 3; const wire = tag & 7;
    if (wire === 2) { const length = readVarint(buffer, state); const end = state.offset + length; if (end > buffer.length) throw new Error('CRX3 protobuf field is truncated'); fields.push({ field, value: buffer.subarray(state.offset, end) }); state.offset = end; }
    else if (wire === 0) readVarint(buffer, state);
    else if (wire === 1) state.offset += 8;
    else if (wire === 5) state.offset += 4;
    else throw new Error('CRX3 protobuf wire type is unsupported');
  }
  return fields;
}

function extensionIdFromKey(publicKey) {
  const bytes = crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16); let result = '';
  for (const byte of bytes) result += String.fromCharCode(97 + (byte >>> 4), 97 + (byte & 15));
  return result;
}

function extensionIdFromBytes(bytes) {
  let result = '';
  for (const byte of bytes) result += String.fromCharCode(97 + (byte >>> 4), 97 + (byte & 15));
  return result;
}

function crxDetails(buffer) {
  if (buffer.length < 16 || buffer.subarray(0, 4).toString('ascii') !== 'Cr24') throw new Error('下载内容不是有效的 CRX 文件');
  const version = buffer.readUInt32LE(4); let offset; let publicKey = null; let extensionId = null;
  if (version === 2) {
    const keyLength = buffer.readUInt32LE(8);
    offset = 16 + keyLength + buffer.readUInt32LE(12);
    publicKey = buffer.subarray(16, 16 + keyLength);
    extensionId = extensionIdFromKey(publicKey);
  }
  else if (version === 3) {
    const headerLength = buffer.readUInt32LE(8);
    const header = buffer.subarray(12, 12 + headerLength);
    const fields = protobufFields(header);
    offset = 12 + headerLength;
    const signedHeader = fields.find((item) => item.field === 10000);
    const crxId = signedHeader ? protobufFields(signedHeader.value).find((item) => item.field === 1)?.value : null;
    if (!crxId || crxId.length !== 16) throw new Error('CRX3 signed header does not contain a valid extension id');
    extensionId = extensionIdFromBytes(crxId);
    const proofKeys = fields.filter((item) => item.field === 2 || item.field === 3)
      .map((item) => protobufFields(item.value).find((field) => field.field === 1)?.value)
      .filter((value) => value?.length);
    publicKey = proofKeys.find((value) => extensionIdFromKey(value) === extensionId) || null;
    if (!publicKey) throw new Error('CRX3 does not contain a public key matching its signed extension id');
  } else throw new Error('Unsupported CRX version: ' + version);
  if (offset < 12 || offset + 4 > buffer.length || buffer.subarray(offset, offset + 2).toString('ascii') !== 'PK') throw new Error('CRX 内没有有效 ZIP 数据');
  return { zip: buffer.subarray(offset), publicKey, extensionId };
}

function crxZip(buffer) { return crxDetails(buffer).zip; }

function tarCommand() {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const candidates = [
      path.join(systemRoot, 'System32', 'tar.exe'),
      'tar.exe',
      'tar'
    ];
    for (const candidate of candidates) {
      if (candidate.includes(path.sep)) {
        if (fs.existsSync(candidate)) return candidate;
      } else {
        return candidate;
      }
    }
  }
  return 'tar';
}

async function assertExtractedTreeSafe(root) {
  const pending = [root];
  let count = 0;
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      count += 1;
      if (count > 20000) throw new Error('扩展包文件数量超过安全限制');
      const target = path.join(current, entry.name);
      const stat = await fsp.lstat(target);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('扩展包包含链接或特殊文件');
      if (stat.isDirectory()) pending.push(target);
    }
  }
}

function run(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore' });
    let output = ''; let error = '';
    if (capture) { child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { error += chunk; }); }
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(error.trim() || `${command} 执行失败（${code}）`)));
  });
}

async function addChromeStoreExtension(input, root, readManifest, fetchPackage = download) {
  const storeId = extractStoreId(input);
  const query = new URLSearchParams({ response: 'redirect', prodversion: '150.0.0.0', acceptformat: 'crx2,crx3', x: `id=${storeId}&installsource=ondemand&uc` });
  const crx = await fetchPackage(`https://clients2.google.com/service/update2/crx?${query}`);
  const details = crxDetails(crx);
  if (details.extensionId && details.extensionId !== storeId) throw new Error(`CRX 签名 ID ${details.extensionId} 与商店 ID ${storeId} 不一致`);
  const zip = details.zip;
  const base = path.join(root, 'chrome-store-extensions');
  const directory = path.join(base, storeId);
  const temporary = path.join(base, `.${storeId}-${process.pid}-${Date.now()}`);
  const zipFile = `${temporary}.zip`;
  await fsp.mkdir(base, { recursive: true });
  await fsp.mkdir(temporary, { recursive: true });
  await fsp.writeFile(zipFile, zip);
  try {
    const tar = tarCommand();
    const listing = await run(tar, ['-tf', zipFile], true);
    for (const entry of listing.split(/\r?\n/).filter(Boolean)) {
      const normalized = entry.replace(/\\/g, '/');
      if (normalized.startsWith('/') || normalized.split('/').includes('..')) throw new Error('扩展包包含不安全的文件路径');
    }
    await run(tar, ['-xf', zipFile, '-C', temporary]);
    await assertExtractedTreeSafe(temporary);
    if (!fs.existsSync(path.join(temporary, 'manifest.json'))) throw new Error('扩展包缺少 manifest.json');
    if (details.publicKey) { const manifestFile = path.join(temporary, 'manifest.json'); const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8')); if (!manifest.key) { manifest.key = details.publicKey.toString('base64'); await fsp.writeFile(manifestFile, JSON.stringify(manifest), 'utf8'); } }
    await fsp.rm(directory, { recursive: true, force: true });
    await fsp.rename(temporary, directory);
    const extension = await readManifest(directory, false);
    return { ...extension, id: `store-${storeId}`, storeId, source: 'Chrome Web Store', storeUrl: `https://chromewebstore.google.com/detail/${storeId}` };
  } finally {
    await fsp.rm(zipFile, { force: true }).catch(() => {});
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { extractStoreId, crxZip, crxDetails, extensionIdFromKey, addChromeStoreExtension };
