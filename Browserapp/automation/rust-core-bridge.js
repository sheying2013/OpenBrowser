'use strict';
const { spawn, execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const execFileAsync = promisify(execFile);
const CONTROL_PROTOCOL = 1;
const MAX_FRAME_BYTES = 65_536;

function findRustCoreBinary() {
  const executable = process.platform === 'win32' ? 'openbrowser-core.exe' : 'openbrowser-core';
  const root = path.resolve(__dirname, '../..');
  const override = process.env.OPENBROWSER_RUST_CORE_BINARY;
  const candidates = override ? [path.resolve(override)] : [
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'rust-core', executable)] : []),
    path.join(root, 'target/debug', executable),
    path.join(root, 'target/release', executable),
  ];
  return candidates.find(candidate => {
    try { return fs.statSync(candidate).isFile(); } catch (_) { return false; }
  }) || null;
}

function binary() {
  const found = findRustCoreBinary();
  if (!found) throw new Error('Rust core binary is unavailable; retain the existing JS backend');
  return found;
}

function query(command, args = []) {
  return JSON.parse(execFileSync(binary(), [command, ...args], {
    encoding: 'utf8', timeout: 5000, maxBuffer: MAX_FRAME_BYTES, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim());
}

function getRustCoreVersion() {
  try { return query('version'); } catch (_) { return null; }
}

// Offline diagnostic, not a replacement for Chromium TLS transport.
function getRustTlsProfile(sni = 'example.com') {
  return query('tls', ['--sni', String(sni)]);
}

function calculateRustTileGrid(options = {}) {
  const values = {
    '--screen-w': options.screenWidth ?? 1920,
    '--screen-h': options.screenHeight ?? 1080,
    '--taskbar': options.taskbarHeight ?? 40,
    '--count': options.count ?? 4,
    '--margin': options.margin ?? 8,
    '--gap': options.gap ?? 8,
  };
  return query('layout', Object.entries(values).flatMap(([key, value]) => [key, String(value)]));
}

async function startRustProxyBridge(proxyConfig = {}, onStatus = () => {}, signal) {
  const bin = binary();
  const versionResult = await execFileAsync(bin, ['version'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: MAX_FRAME_BYTES, windowsHide: true, signal,
  });
  if (signal?.aborted) throw new Error('Proxy probe cancelled');
  const version = JSON.parse(versionResult.stdout.trim());
  if (version.name !== 'openbrowser-core' || version.control_protocol !== CONTROL_PROTOCOL) {
    throw new Error('Rust core control protocol mismatch; retain the existing JS backend');
  }
  const config = JSON.stringify({
    protocol: proxyConfig.protocol,
    host: proxyConfig.host,
    port: proxyConfig.port,
    username: proxyConfig.username ?? null,
    password: proxyConfig.password ?? null,
    remark: null,
    name: null,
  });
  if (Buffer.byteLength(config) + 1 > MAX_FRAME_BYTES) throw new Error('Rust proxy configuration exceeds 64 KiB');
  const child = spawn(bin, ['bridge'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let closed = false;
  let closing;
  let readyResolve, readyReject;
  let startupTimer;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise(resolve => {
    child.once('close', (code, exitSignal) => {
      closed = true;
      clearTimeout(startupTimer);
      signal?.removeEventListener('abort', abort);
      if (listening && !closing) notify('LOCAL_PROXY_FAILED', 'Rust bridge exited');
      readyReject(new Error('Rust bridge exited before readiness'));
      resolve({ code, signal: exitSignal });
    });
  });
  function notify(code, message) {
    try { onStatus({ code, message }); } catch (_) { /* Observer errors never own the session. */ }
  }
  function stop() {
    if (closing) return closing;
    closing = (async () => {
      if (closed) return;
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end('stop\n');
      const term = setTimeout(() => { if (!closed) child.kill('SIGTERM'); }, 1000);
      const kill = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 2000);
      let expiry;
      try {
        await Promise.race([
          done,
          new Promise((_, reject) => { expiry = setTimeout(() => reject(new Error('Rust bridge did not exit')), 4000); }),
        ]);
      } finally { clearTimeout(term); clearTimeout(kill); clearTimeout(expiry); }
    })();
    return closing;
  }
  const fail = error => {
    readyReject(error);
    if (!closing) stop().catch(() => {});
  };
  const abort = () => fail(new Error('Proxy probe cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  child.once('error', fail);
  child.stdin.on('error', error => { if (!closing) fail(error); });
  child.stderr.on('data', () => {}); // Drain diagnostics without forwarding credentials or untrusted text.
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let listening = false;
  child.stdout.on('data', chunk => {
    pending += decoder.write(chunk);
    if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) { fail(new Error('Oversized Rust control frame')); return; }
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let value;
      try { value = JSON.parse(line); } catch (_) { fail(new Error('Invalid Rust control frame')); return; }
      if (value.status === 'listening' && !listening) {
        if (value.control_protocol !== CONTROL_PROTOCOL || value.host !== '127.0.0.1' ||
            !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || value.pid !== child.pid) {
          fail(new Error('Invalid Rust bridge readiness')); return;
        }
        listening = true;
        clearTimeout(startupTimer);
        readyResolve({ port: value.port, chromeUrl: 'http://127.0.0.1:' + value.port,
          pid: child.pid, stop, child, done });
      } else if (value.event === 'status' && typeof value.code === 'string') {
        notify(value.code, typeof value.message === 'string' ? value.message : value.code);
      }
    }
  });
  startupTimer = setTimeout(() => fail(new Error('Rust bridge startup timed out')), 10000);
  // Credentials travel over a private pipe, never argv/environment or diagnostics.
  if (signal?.aborted) abort();
  else child.stdin.write(config + '\n');
  try { return await ready; } catch (error) { await stop(); throw error; }
}

module.exports = { findRustCoreBinary, getRustCoreVersion, getRustTlsProfile,
  calculateRustTileGrid, startRustProxyBridge };
