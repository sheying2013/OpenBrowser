'use strict';

/**
 * Append-only diagnostic log for fingerprint inject / welcome-page reads.
 * Default path (macOS):
 *   ~/Library/Application Support/openbrowser/logs/fingerprint-inject.log
 * Override: OPENBROWSER_FP_LOG=/path/to/file.log
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

function defaultLogPath() {
  if (process.env.OPENBROWSER_FP_LOG) return String(process.env.OPENBROWSER_FP_LOG);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'openbrowser', 'logs', 'fingerprint-inject.log');
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'openbrowser', 'logs', 'fingerprint-inject.log');
  }
  return path.join(os.homedir(), '.config', 'openbrowser', 'logs', 'fingerprint-inject.log');
}

const FALLBACK_LOG = path.join(os.tmpdir(), 'openbrowser-fingerprint-inject.log');
let cachedPath = null;
let writeFailCount = 0;

function logPath() {
  if (!cachedPath) cachedPath = defaultLogPath();
  return cachedPath;
}

function summarizeFp(fp = {}) {
  if (!fp || typeof fp !== 'object') return null;
  return {
    userAgent: fp.userAgent || null,
    platform: fp.platform || null,
    hardwareConcurrency: fp.hardwareConcurrency ?? null,
    deviceMemory: fp.deviceMemory ?? null,
    webglMode: fp.webgl?.mode || null,
    webglMetaMode: fp.webgl?.metaMode || null,
    webglVendor: fp.webgl?.vendor || null,
    webglRenderer: fp.webgl?.renderer || null,
    canvasMode: fp.canvas?.mode || null,
    languages: Array.isArray(fp.languages) ? fp.languages.slice(0, 4) : null,
  };
}

async function fpLog(event, payload = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event: String(event || 'log'),
    ...payload,
  }) + '\n';
  const primary = logPath();
  try {
    await fsp.mkdir(path.dirname(primary), { recursive: true });
    // If an old root-owned empty file blocks us, replace it once.
    try {
      await fsp.appendFile(primary, line, { encoding: 'utf8', flag: 'a' });
      return;
    } catch (err) {
      if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
        try {
          await fsp.unlink(primary).catch(() => {});
          await fsp.writeFile(primary, line, { encoding: 'utf8', mode: 0o644 });
          return;
        } catch (_) { /* fall through */ }
      }
      throw err;
    }
  } catch (_) {
    writeFailCount += 1;
    try {
      await fsp.appendFile(FALLBACK_LOG, line, 'utf8');
      if (writeFailCount <= 3) {
        try {
          await fsp.appendFile(FALLBACK_LOG, JSON.stringify({
            ts: new Date().toISOString(),
            event: 'log.fallback',
            primary,
            fallback: FALLBACK_LOG,
          }) + '\n', 'utf8');
        } catch (__) {}
      }
    } catch (__) {
      // never break startup for diagnostics
    }
  }
}

/** CDP expression: read live surfaces after inject (must run in page main world). */
const LIVE_PROBE_EXPRESSION = `(() => {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    let webglVendor = null, webglRenderer = null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      webglVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      webglRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    }
    return {
      href: String(location.href || ''),
      userAgent: String(navigator.userAgent || ''),
      platform: String(navigator.platform || ''),
      language: String(navigator.language || ''),
      languages: Array.from(navigator.languages || []),
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      webglVendor: webglVendor,
      webglRenderer: webglRenderer,
      webdriver: navigator.webdriver === true,
      timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; } })(),
      uaDataPlatform: navigator.userAgentData && navigator.userAgentData.platform || null,
    };
  } catch (error) {
    return { probeError: String(error && error.message || error) };
  }
})()`;

module.exports = {
  fpLog,
  logPath,
  summarizeFp,
  LIVE_PROBE_EXPRESSION,
  defaultLogPath,
  FALLBACK_LOG,
};
