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

const { fontsForOs } = require('./device-personas');

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
  // "real" must remain the absence of a native override, and "blocked" must let the page see no
  // adapter. Only "webgl" asks the kernel to publish a synthetic adapter identity, so do not write
  // webgpu_parameter for the other two modes.
  if (String(fp?.webgpu?.mode || 'real') !== 'webgl') return null;
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
  const privacy = profile.privacy || {};
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
  const fontMode = String(privacy.fontMode || privacy.fonts || fp.fontMode || 'default').toLowerCase();
  const fontFingerprinting = fontMode === 'noise' || fontMode === 'spoof'
    || privacy.fontFingerprinting === true
    || privacy.isFontFingerprinting === true
    || fp.fontFingerprinting === true;

  const fields = {
    platform: String(fp.platform || meta.platform || 'Win32'),
    accept_languages: accept,
    is_webrtc_enable: webrtcMode !== 'disabled',
    webrtc_policy: webrtcPolicy,
    is_canvas_finger_printing_enable: canvasMode === 'noise',
    is_webgl_finger_printing_enable: webglMode === 'noise',
    is_audio_finger_printing_enable: audioMode === 'noise',
    is_clientrects_finger_printing_enable: clientRectsMode === 'noise',
    is_enumerate_devices_enable: mediaMode !== 'real',
    is_font_finger_printing_enable: fontFingerprinting,
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

  // Device / host name surface used by native identity fields.
  const deviceName = String(fp.deviceName || fp.staticConfig?.deviceName || '').trim();
  if (deviceName && fp.deviceNameMode !== 'real') {
    fields.machine = deviceName.slice(0, 120);
  }

  // WebRTC IP surfaces: public (proxy/exit) + private local candidate.
  const publicIp = String(
    fp.webrtcAddress
    || fp.dynamicConfig?.webrtcAddress
    || privacy.webrtcAddress
    || profile.exitIp
    || profile.exitIP
    || ''
  ).trim();
  const localIp = String(
    fp.webrtcLocalIp
    || fp.staticConfig?.webrtcLocalIp
    || fp.dynamicConfig?.webrtcLocalIp
    || privacy.webrtcLocalIp
    || ''
  ).trim();
  if (webrtcMode === 'disabled') {
    fields.webrtc_fake_ip = '';
    fields.webrtc_local_ip = '';
  } else {
    if (publicIp) fields.webrtc_fake_ip = publicIp;
    if (localIp) fields.webrtc_local_ip = localIp;
  }
  const stunServers = Array.isArray(privacy.webrtcStunServers)
    ? privacy.webrtcStunServers
    : (Array.isArray(fp.webrtcStunServers) ? fp.webrtcStunServers : null);
  if (stunServers && stunServers.length) {
    fields.webrtc_stun_servers = stunServers.map((item) => String(item || '').trim()).filter(Boolean);
  }

  // Geo as "lat,lon,accuracy" string accepted by Framework geoposition parser.
  const geoObj = fp.dynamicConfig?.geoposition || fp.geoposition || null;
  let geoText = String(fp.dynamicConfig?.geopositionText || '').trim();
  if (!geoText && geoObj && typeof geoObj === 'object') {
    const lat = Number(geoObj.latitude);
    const lon = Number(geoObj.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const accuracy = Number.isFinite(Number(geoObj.accuracy)) ? Number(geoObj.accuracy) : 1000;
      geoText = `${lat},${lon},${accuracy}`;
    }
  }
  if (!geoText) {
    const lat = Number(privacy.latitude ?? profile.exitLatitude);
    const lon = Number(privacy.longitude ?? profile.exitLongitude);
    if (Number.isFinite(lat) && Number.isFinite(lon) && privacy.geoMode !== 'disabled' && privacy.geoMode !== 'prompt') {
      const accuracy = Number.isFinite(Number(privacy.accuracy)) ? Number(privacy.accuracy) : 1000;
      geoText = `${lat},${lon},${accuracy}`;
    }
  }
  if (geoText) fields.geoposition = geoText;

  // Preserve existing check_url lists when merging; only patch enable/metrics.
  fields._canvasConsistencyPatch = consistencyFromFp(fp, 'canvas');
  fields._webglConsistencyPatch = consistencyFromFp(fp, 'webgl');
  const skipHosts = canvasSkipHostsFromFp(fp);
  if (skipHosts.length) {
    fields._canvasSkipHosts = skipHosts;
    // Canvas 与 WebGL 的豁免列表在内核里是两个独立字段，任何一层漏写都会让同一站点
    // 在两条渲染路径上得到不同答案，因此两者必须同源同值。
    fields._webglSkipHosts = skipHosts;
  }
  // The switch and its list travel together: a switch with nothing to answer from leaves the
  // native layer undefined, while a list without the switch could activate a build that reads the
  // list on its own.
  const fontList = fontFingerprinting ? fontListFromFp(fp) : [];
  if (fontList.length) fields.font_list = fontList;

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
  // Keep the unknown DOM-trust mutation off. Automation paths use native Input.* events
  // instead of rewriting isTrusted, which is non-configurable on real event instances.
  init.is_garble_dom_event_trusted = false;
  // A watermark burns the machine id / window name into every screenshot, which is the opposite
  // of what an isolated profile is for, so it is forced off instead of inherited from a payload.
  init.is_watermark_with_machine_id = false;
  init.is_watermark_with_window_name = false;
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
  // A token object carrying account fields comes from the bundled template's origin rather than from
  // this build, so it is replaced by the local token this build uses instead of being carried into
  // every profile.
  // The platform service requires a token blob of this shape at startup (a plain string aborts the
  // process), so this build generates its own instead of carrying an inherited account-bound blob
  // into every profile. Only account-bound blobs are replaced, which keeps the value stable once a
  // profile has been migrated.
  if (!init.token || typeof init.token !== 'object' || init.token.user_id) {
    const b64 = (n) => crypto.randomBytes(n).toString('base64').replace(/=+$/, '');
    init.token = {
      app_token: crypto.randomBytes(12).toString('hex').slice(0, 20),
      browser_token: b64(32),
      user_id: '',
      user_token: b64(64),
    };
  }
  init.native_messaging = [];
  // A bypass list whose feature switch is off is a latent direct-connection path: hosts in it would
  // skip the proxy if any layer read the list on its own. The list is cleared with the switch.
  init.async_proxy_data_exception_list = [];
  // Local managed profiles keep CDP / automation flags enabled in init.json.
  init.can_webdriver = true;
  init.allow_remote_debugging = true;
  init.is_debug = 1;
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
 * Font families the kernel may hand out for this profile.
 *
 * The kernel exposes a font switch and a font list; enabling the switch without a list leaves the
 * native layer with nothing to answer from, so the list always accompanies the switch. It follows
 * the same platform the UA and Client Hints claim, which keeps the font surface on the same side
 * as every other OS signal.
 */
function fontListFromFp(fp) {
  const personaList = fp && fp.fonts && Array.isArray(fp.fonts.list) ? fp.fonts.list : null;
  const list = personaList && personaList.length
    ? personaList
    : fontsForOs((fp && fp.uaProfile && fp.uaProfile.os) || (fp && fp.platform) || 'windows');
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const family = String(raw || '').trim();
    if (!family || seen.has(family.toLowerCase())) continue;
    seen.add(family.toLowerCase());
    out.push(family);
  }
  return out;
}

/**
 * Sites a rendering layer must leave alone. The page script and the native layer have to agree on
 * this list: if the script exempts a host but the kernel still perturbs its pixels (or the other
 * way round) the same surface answers differently depending on which layer produced it.
 */
function canvasSkipHostsFromFp(fp) {
  const policy = (fp && fp.stability) || {};
  const list = Array.isArray(policy.skipHosts) ? policy.skipHosts : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const host = String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^\*\./, '');
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

/**
 * Apply mapped fingerprint fields onto an init object (mutates).
 */
function applyFingerprintFields(init, fields) {
  const skip = new Set([
    '_canvasConsistencyPatch',
    '_webglConsistencyPatch',
    '_canvasSkipHosts',
    '_webglSkipHosts',
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
  if (Array.isArray(fields._canvasSkipHosts)) {
    init.canvas_fingerprint_skip_hosts = fields._canvasSkipHosts;
  }
  if (Array.isArray(fields._webglSkipHosts)) {
    init.webgl_fingerprint_skip_hosts = fields._webglSkipHosts;
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
 * Native pixel-noise handoff.
 *
 * The bundled 148 kernel only applies canvas / webgl / audio / clientRects pixel noise while the
 * server-issued payloads (canvas_fingerprint_info / webgl_fingerprint_info) are present. Those
 * payloads are not available to this build, and a runtime A/B with the init switches on vs off
 * measured byte-identical canvas, WebGL, clientRects and AudioContext output, i.e. the native
 * pixel-noise path is inert. Stripping the CDP/JS noise would leave those surfaces at the real
 * hardware value, so the fingerprint passes through untouched.
 *
 * WebGL metadata (vendor / renderer / metaMode) keeps working through the CDP inject.
 */
function fingerprintForNativeKernelInject(fp) {
  if (!fp || typeof fp !== 'object') return fp;
  return fp;
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
  canvasSkipHostsFromFp,
  fontListFromFp,
  loadInitObject,
  encodeInitObject,
  resolveInitTemplate,
};
