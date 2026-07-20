'use strict';

/**
 * Map OpenBrowser profile fingerprint → openbrowser-148 init.json fields.
 * Written before spawn so the kernel Framework reads the same identity as CDP/JS.
 * Merge carefully: never wipe ipc/token when updating an existing init.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const SOURCE_OPENBROWSER = 'openbrowser-148';

function isOpenBrowser148(browser = {}) {
  if (!browser) return false;
  if (browser.source === SOURCE_OPENBROWSER) return true;
  const p = String(browser.path || '');
  return /openbrowser_148|kernels[/\\](macos-x64|openbrowser)[/\\]/i.test(p);
}

/** Stable ipc / --browser_id window name (SB + 9 digits). */
function stableBrowserWindowName(profileId) {
  const h = crypto.createHash('sha1').update(String(profileId || 'default')).digest('hex');
  const n = parseInt(h.slice(0, 8), 16) % 1000000000;
  return `SB${String(n).padStart(9, '0')}`;
}

function loadInitObject(rawBuf) {
  if (!rawBuf || !rawBuf.length) return null;
  const raw = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(String(rawBuf));
  const stripped = raw.toString('utf8').trim();
  try {
    const data = Buffer.from(stripped, 'base64');
    if (data[0] === 0x7b) return JSON.parse(data.toString('utf8'));
  } catch (_) {}
  try {
    if (stripped[0] === '{') return JSON.parse(stripped);
  } catch (_) {}
  return null;
}

function encodeInitObject(init) {
  const plain = JSON.stringify(init, null, 0);
  return Buffer.from(plain, 'utf8').toString('base64');
}

function brandsForInit(fp) {
  const meta = fp.userAgentMetadata || fp.uaProfile?.metadata || {};
  const major = Number(fp.uaProfile?.chromeMajor || meta.brands?.[0]?.version) || 148;
  const full = String(meta.uaFullVersion || meta.fullVersion || `${major}.0.0.0`);
  const list = Array.isArray(meta.fullVersionList) && meta.fullVersionList.length
    ? meta.fullVersionList
    : (Array.isArray(meta.brands) ? meta.brands : []);
  if (!list.length) {
    return [
      { brand: 'Google Chrome', fullVersion: full, version: String(major) },
      { brand: 'Not.A/Brand', fullVersion: '8.0.0.0', version: '8' },
      { brand: 'Chromium', fullVersion: full, version: String(major) },
    ];
  }
  return list.map((b) => {
    const brand = String(b.brand || 'Chromium');
    const ver = String(b.version || major);
    const isGrease = /not/i.test(brand) && !/chrome|chromium/i.test(brand);
    const fullVersion = isGrease
      ? (ver.includes('.') ? ver : `${ver}.0.0.0`)
      : (ver.split('.').length >= 3 ? ver : full);
    return {
      brand,
      fullVersion,
      version: fullVersion.split('.')[0] || String(major),
    };
  });
}

function webgpuFromFp(fp) {
  const gpu = fp.webgpu?.gpu || fp.webgl?.gpu || null;
  if (!gpu || typeof gpu !== 'object') return null;
  return {
    vendor: String(gpu.vendor || 'intel').toLowerCase(),
    architecture: String(gpu.architecture || ''),
    description: String(gpu.description || gpu.architecture || ''),
    device: String(gpu.device || ''),
    driver: String(gpu.driver || ''),
  };
}

function batteryFromFp(fp) {
  const v = fp.battery?.value;
  if (!v || v.blocked || typeof v !== 'object') {
    return { charging: true, chargingTime: 0, dischargingTime: -1, level: 1 };
  }
  return {
    charging: v.charging !== false,
    chargingTime: Number.isFinite(Number(v.chargingTime)) ? Number(v.chargingTime) : 0,
    dischargingTime: Number.isFinite(Number(v.dischargingTime)) ? Number(v.dischargingTime) : -1,
    level: Number.isFinite(Number(v.level)) ? Math.min(1, Math.max(0, Number(v.level))) : 1,
  };
}

function mediaLabelsFromFp(fp) {
  const labels = fp.mediaDevices?.labels;
  if (labels && typeof labels === 'object') {
    return {
      audio_input_labels: Array.isArray(labels.audio_input_labels) ? labels.audio_input_labels : [''],
      audio_output_labels: Array.isArray(labels.audio_output_labels) ? labels.audio_output_labels : [''],
      communications_text: String(labels.communications_text || 'Communications - '),
      default_text: String(labels.default_text || 'Default - '),
      video_input_labels: Array.isArray(labels.video_input_labels) ? labels.video_input_labels : [''],
    };
  }
  return {
    audio_input_labels: [''],
    audio_output_labels: [''],
    communications_text: 'Communications - ',
    default_text: 'Default - ',
    video_input_labels: [''],
  };
}

function consistencyFromFp(fp, kind) {
  const stability = fp.stability || fp.canvas?.stability || {};
  const square = Math.min(64, Math.max(2, Number(stability.square) || 8));
  const hamming = Math.min(64, Math.max(1, Number(stability.hammingThreshold) || 12));
  const noiseOn = kind === 'canvas'
    ? fp.canvas?.mode === 'noise'
    : fp.webgl?.mode === 'noise';
  // stabilityMode=off only disables site-aware locking; native noise still runs when mode is noise.
  // (CDP inject is stripped via fingerprintForNativeKernelInject to avoid double noise.)
  const enable = noiseOn;
  return {
    enable: Boolean(enable),
    hanming_distance: hamming,
    max_height: 600,
    max_width: 600,
    square_side_length: square,
  };
}

/**
 * Build fingerprint-related init fields from OpenBrowser buildFingerprint() output.
 */
function mapFingerprintToInitFields(fp = {}, profile = {}) {
  const meta = fp.userAgentMetadata || fp.uaProfile?.metadata || {};
  const langs = Array.isArray(fp.languages) && fp.languages.length
    ? fp.languages
    : String(profile.language || 'en-US').split(',').map((s) => s.trim()).filter(Boolean);
  const accept = langs.join(',') || 'en-US';
  const webrtcMode = fp.webrtc || 'proxy';
  const webrtcPolicy = webrtcMode === 'disabled' ? 0 : (webrtcMode === 'proxy' ? 3 : 1);
  const canvasMode = fp.canvas?.mode || 'noise';
  const webglMode = fp.webgl?.mode || 'noise';
  const audioMode = fp.audio?.mode || 'noise';
  const clientRectsMode = fp.clientRects?.mode || 'noise';
  const mediaMode = fp.mediaDevices?.mode || 'noise';
  const speechMode = fp.speech?.mode || 'real';

  const fields = {
    platform: String(fp.platform || meta.platform || 'Win32'),
    accept_languages: accept,
    is_webrtc_enable: webrtcMode !== 'disabled',
    webrtc_policy: webrtcPolicy,
    is_webgl_finger_printing_enable: webglMode === 'noise',
    is_audio_finger_printing_enable: audioMode === 'noise',
    is_clientrects_finger_printing_enable: clientRectsMode === 'noise',
    is_enumerate_devices_enable: mediaMode !== 'real',
    is_font_finger_printing_enable: false,
    GoogleSpeechSynthesis: speechMode !== 'blocked',
    webrtc_media_labels: mediaLabelsFromFp(fp),
    battery: batteryFromFp(fp),
    user_agent_data: {
      architecture: String(meta.architecture || 'x86'),
      bitness: String(meta.bitness || '64'),
      mobile: Boolean(meta.mobile),
      model: String(meta.model || ''),
      platform: String(meta.platform || 'Windows'),
      platformVersion: String(meta.platformVersion || '15.0.0'),
      wow64: Boolean(meta.wow64),
      uaFullVersion: String(meta.uaFullVersion || meta.fullVersion || '148.0.0.0'),
      brands: brandsForInit(fp),
    },
  };

  if (fp.hardwareConcurrency != null && Number(fp.hardwareConcurrency) > 0) {
    fields.hardwareConcurrency = Math.min(64, Math.max(1, Math.round(Number(fp.hardwareConcurrency))));
  }
  if (fp.deviceMemory != null && Number(fp.deviceMemory) > 0) {
    fields.deviceMemory = Math.min(128, Math.max(1, Math.round(Number(fp.deviceMemory))));
  }

  if (webglMode === 'blocked') {
    fields.webgl_vendor = '';
    fields.webgl_renderer = '';
    fields.is_webgl_finger_printing_enable = false;
  } else if (webglMode === 'real' && (fp.webgl?.metaMode === 'real' || !fp.webgl?.vendor)) {
    // leave vendor/renderer to host when both image and meta are real
  } else {
    if (fp.webgl?.vendor != null) fields.webgl_vendor = String(fp.webgl.vendor);
    if (fp.webgl?.renderer != null) fields.webgl_renderer = String(fp.webgl.renderer);
  }

  const webgpu = webgpuFromFp(fp);
  if (webgpu) fields.webgpu_parameter = webgpu;

  // Preserve existing check_url lists when merging; only patch enable/metrics.
  fields._canvasConsistencyPatch = consistencyFromFp(fp, 'canvas');
  fields._webglConsistencyPatch = consistencyFromFp(fp, 'webgl');

  // cmd_line identity (kernel also reads these)
  fields._cmdLinePatch = {
    'user-agent': String(fp.userAgent || ''),
    lange: accept.split(',')[0] || 'en-US',
    'remote-debugging-port': '0',
  };

  fields._windowName = stableBrowserWindowName(profile.id || fp.profileId);
  fields._browserTitle = String(profile.name || profile.number || profile.id || 'OpenBrowser');

  return fields;
}

function applySafetyFields(init) {
  init.proxy = init.proxy && typeof init.proxy === 'object' ? init.proxy : {};
  // Empty proxy object when no explicit proxy config was written by engine.
  if (!init.proxy || typeof init.proxy !== 'object') init.proxy = {};
  init.async_proxy_data = 0;
  init.async_proxy_data_wait_page = '';
  init.is_garble_dom_event_trusted = false;
  init.is_hubstudio = false;
  init.black_white_list = { black_list: [], exception_list: [], tips: '', type: 1 };
  init.local_port = { type: 0, black_list: [], white_list: [] };
  init.launcher_page = 'about:blank';
  init.home_page = '';
  init.page_info_enabled = false;
  init.address_bar_custom = [];
  init.framework_url_entry = {
    password_manage: 'chrome://password-manager/',
    history: 'chrome://history/',
    extension_management: 'chrome://extensions/',
    setting: 'chrome://settings/',
    app_center: 'chrome://extensions/',
  };
  init.product_infos = { ...(init.product_infos || {}), product_name: 'OpenBrowser' };
  init.sa_analysis = {
    ...(init.sa_analysis || {}),
    sa_product: 'chromium',
    sa_productVer: String((init.sa_analysis && init.sa_analysis.sa_productVer) || '148.0.0.0'),
  };
  init.required_enabled_extension_id_list = [];
  if (!init.token) init.token = 'openbrowser-token';
  // Local managed profiles keep CDP / automation flags enabled in init.json.
  init.can_webdriver = true;
  init.allow_remote_debugging = true;
  init.is_debug = Number(init.is_debug) === 1 ? 1 : 0;
  return init;
}

function applyIpc(init, windowName) {
  const prev = init.ipc && typeof init.ipc === 'object' ? init.ipc : {};
  const win = String(windowName || prev.browser_window_name || 'SB171550832').trim() || 'SB171550832';
  init.ipc = {
    browser_window_name: win,
    from_client: `/tmp/${win}`,
    from_client_pipe: win,
    is_pipe: true,
    rnclient_window_name: `${win}listen`,
    to_client: `/tmp/${win}listen`,
    to_client_pipe: `${win}listen`,
  };
  return win;
}

function mergeConsistency(existing, patch) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  if (!Array.isArray(base.check_url)) base.check_url = Array.isArray(existing?.check_url) ? existing.check_url : [];
  base.enable = Boolean(patch.enable);
  base.hanming_distance = patch.hanming_distance;
  base.max_height = patch.max_height;
  base.max_width = patch.max_width;
  base.square_side_length = patch.square_side_length;
  return base;
}

/**
 * Apply mapped fingerprint fields onto an init object (mutates).
 */
function applyFingerprintFields(init, fields) {
  const skip = new Set([
    '_canvasConsistencyPatch',
    '_webglConsistencyPatch',
    '_cmdLinePatch',
    '_windowName',
    '_browserTitle',
  ]);
  for (const [k, v] of Object.entries(fields)) {
    if (skip.has(k) || v === undefined) continue;
    init[k] = v;
  }
  if (fields._canvasConsistencyPatch) {
    init.canvas_fingerprint_keep_consistent_setting = mergeConsistency(
      init.canvas_fingerprint_keep_consistent_setting,
      fields._canvasConsistencyPatch
    );
  }
  if (fields._webglConsistencyPatch) {
    init.webgl_fingerprint_keep_consistent_setting = mergeConsistency(
      init.webgl_fingerprint_keep_consistent_setting,
      fields._webglConsistencyPatch
    );
  }
  const cl = init.cmd_line && typeof init.cmd_line === 'object' ? { ...init.cmd_line } : {};
  if (fields._cmdLinePatch) {
    for (const [k, v] of Object.entries(fields._cmdLinePatch)) {
      if (v !== '' && v != null) cl[k] = v;
    }
  }
  cl['remote-debugging-port'] = '0';
  // Keep CDP reachable for Local API / RPA / window sync regardless of template defaults.
  if (cl['enable-automation'] === undefined) cl['enable-automation'] = '';
  init.cmd_line = cl;
  init.can_webdriver = true;
  init.allow_remote_debugging = true;
  if (fields._browserTitle) init.browser_title = String(fields._browserTitle).slice(0, 120);
  applyIpc(init, fields._windowName);
  return init;
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function resolveInitTemplate(browserPath = '', resourceRoots = []) {
  const candidates = [];
  if (browserPath) {
    // .../openbrowser_148/OpenBrowser.app/Contents/MacOS/OpenBrowser
    // → kernels/openbrowser/
    candidates.push(path.resolve(browserPath, '../../../../../../init_template.json'));
    candidates.push(path.resolve(browserPath, '../../../../../../chrome_148/init_clean_standalone.json'));
    candidates.push(path.resolve(browserPath, '../../../../../init_template.json'));
  }
  for (const root of resourceRoots || []) {
    candidates.push(path.join(root, 'kernels/macos-x64/init_template.json'));
    candidates.push(path.join(root, 'kernels/openbrowser/init_template.json')); // compat symlink
    candidates.push(path.join(root, 'macos-x64/init_template.json'));
    candidates.push(path.join(root, 'openbrowser/init_template.json'));
    candidates.push(path.join(root, 'init_template.json'));
  }
  const home = process.env.HOME || '';
  if (home) {
    candidates.push(path.join(home, 'Library/Application Support/openbrowser/kernels/macos-x64/init_template.json'));
    candidates.push(path.join(home, 'Library/Application Support/openbrowser/kernels/openbrowser/init_template.json'));
  }
  for (const file of candidates) {
    if (file && fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Write profile/init.json for openbrowser-148 from OpenBrowser fingerprint.
 * @returns {{ windowName: string, path: string, fields: object }}
 */
async function writeOpenBrowserKernelInit(profileRoot, options = {}) {
  const {
    fingerprint,
    profile = {},
    browserPath = '',
    resourceRoots = [],
    templatePath = null,
  } = options;
  if (!profileRoot) throw new Error('profileRoot required');
  await fsp.mkdir(profileRoot, { recursive: true });

  const initPath = path.join(profileRoot, 'init.json');
  let init = null;
  try {
    init = loadInitObject(await fsp.readFile(initPath));
  } catch (_) {
    init = null;
  }
  if (!init || typeof init !== 'object') {
    const tpl = templatePath || await resolveInitTemplate(browserPath, resourceRoots);
    if (tpl) init = await readJsonIfExists(tpl);
  }
  if (!init || typeof init !== 'object') init = {};

  const fields = mapFingerprintToInitFields(fingerprint || {}, profile);
  applySafetyFields(init);
  applyFingerprintFields(init, fields);
  // Do not force empty proxy here if caller already set init.proxy for bridge — safety only zeros async.
  // Engine may set proxy after; for now leave {} and rely on Chromium --proxy-server.

  const encoded = encodeInitObject(init);
  await fsp.writeFile(initPath, encoded, 'utf8');
  return {
    path: initPath,
    windowName: init.ipc.browser_window_name,
    fields,
    init,
  };
}

/**
 * When native kernel owns canvas/webgl/audio/clientRects *image* noise, strip
 * those pixel-noise modes from the CDP inject payload so the two stacks do not
 * double-noise. Keep WebGL *metadata* spoof (vendor/renderer / metaMode) so
 * UNMASKED_* still works if Framework misses debug-renderer strings.
 */
function fingerprintForNativeKernelInject(fp) {
  if (!fp || typeof fp !== 'object') return fp;
  const out = { ...fp };
  if (fp.canvas?.mode === 'noise') out.canvas = { ...fp.canvas, mode: 'real' };
  if (fp.webgl?.mode === 'noise') {
    const metaMode = fp.webgl.metaMode === 'real' ? 'real' : (fp.webgl.metaMode || 'noise');
    out.webgl = {
      ...fp.webgl,
      // Skip JS readPixels noise (native owns image); keep meta spoof hooks.
      mode: 'real',
      metaMode,
      vendor: metaMode === 'real' ? fp.webgl.vendor : (fp.webgl.vendor ?? null),
      renderer: metaMode === 'real' ? fp.webgl.renderer : (fp.webgl.renderer ?? null),
    };
  }
  if (fp.audio?.mode === 'noise') out.audio = { ...fp.audio, mode: 'real' };
  if (fp.clientRects?.mode === 'noise') out.clientRects = { ...fp.clientRects, mode: 'real' };
  return out;
}

module.exports = {
  SOURCE_OPENBROWSER,
  isOpenBrowser148,
  stableBrowserWindowName,
  mapFingerprintToInitFields,
  applySafetyFields,
  applyFingerprintFields,
  writeOpenBrowserKernelInit,
  fingerprintForNativeKernelInject,
  loadInitObject,
  encodeInitObject,
  resolveInitTemplate,
};
