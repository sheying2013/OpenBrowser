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
  // webgpu_parameter for the other two modes. The resolved mode already folds an unset choice into
  // the product default, and the fallback keeps the same default if the record predates that field.
  if (String(fp?.webgpu?.mode || 'webgl') !== 'webgl') return null;
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

function isValidPrivateIpv4(ip) {
  if (typeof ip !== 'string') return false;
  const trimmed = ip.trim();
  if (!trimmed || trimmed === '0.0.0.0') return false;
  const parts = trimmed.split('.');
  if (parts.length !== 4) return false;
  const nums = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return false;
    if (p.length > 1 && p.startsWith('0')) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
    nums.push(n);
  }
  const [a, b, c, d] = nums;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function fallbackPrivateIp(seedStr) {
  const h = crypto.createHash('sha256').update(String(seedStr || 'webrtc-local-ip')).digest();
  const pick = h[0] % 3;
  if (pick === 0) return `10.${h[1]}.${h[2]}.${1 + (h[3] % 254)}`;
  if (pick === 1) return `192.168.${h[1]}.${1 + (h[2] % 254)}`;
  return `172.${16 + (h[1] % 16)}.${h[2]}.${1 + (h[3] % 254)}`;
}

function detectOs(fp = {}, profile = {}, init = {}) {
  const p = String(
    fp.os
    || fp.uaProfile?.os
    || profile.os
    || init.user_agent_data?.platform
    || fp.platform
    || init.platform
    || profile.userAgent
    || ''
  ).toLowerCase();
  if (p.includes('ios') || p.includes('iphone') || p.includes('ipad')) return 'ios';
  if (p.includes('mac') || p.includes('darwin')) return 'macos';
  if (p.includes('android')) return 'android';
  if (p.includes('linux')) return 'linux';
  return 'windows';
}

function detectInitOs(init = {}) {
  const p = String(
    init?.user_agent_data?.platform
    || init?.platform
    || init?.cmd_line?.['user-agent']
    || ''
  ).toLowerCase();
  if (p.includes('ios') || p.includes('iphone') || p.includes('ipad')) return 'ios';
  if (p.includes('mac') || p.includes('darwin')) return 'macos';
  if (p.includes('android')) return 'android';
  if (p.includes('linux')) return 'linux';
  return 'windows';
}

const MEDIA_POOLS_BY_OS = Object.freeze({
  windows: Object.freeze({
    audio_input: ['Microphone Array (Realtek High Definition Audio)'],
    audio_output: ['Speaker/Headphone (Realtek High Definition Audio)'],
    video_input: ['Integrated Camera'],
  }),
  macos: Object.freeze({
    audio_input: ['Built-in Microphone'],
    audio_output: ['MacBook Pro Speakers'],
    video_input: ['FaceTime HD Camera'],
  }),
  ios: Object.freeze({
    audio_input: ['Built-in Microphone'],
    audio_output: ['Built-in Speaker'],
    video_input: ['Back Camera', 'Front Camera'],
  }),
  android: Object.freeze({
    audio_input: ['Built-in Microphone'],
    audio_output: ['Built-in Speaker'],
    video_input: ['Back Camera'],
  }),
  linux: Object.freeze({
    audio_input: ['Built-in Audio Analog Stereo'],
    audio_output: ['Built-in Audio Analog Stereo'],
    video_input: ['USB 2.0 Camera'],
  }),
});

function mediaLabelsFromFp(fp = {}, profile = {}, isEnumerateDevices = true) {
  const os = detectOs(fp, profile);
  const explicit = fp.mediaDevices?.labels;
  const commsText = String(explicit?.communications_text || 'Communications - ');
  const defaultText = String(explicit?.default_text || 'Default - ');

  if (!isEnumerateDevices) {
    return {
      audio_input_labels: [],
      audio_output_labels: [],
      communications_text: commsText,
      default_text: defaultText,
      video_input_labels: [],
    };
  }

  if (explicit && typeof explicit === 'object' &&
      (Array.isArray(explicit.audio_input_labels) || Array.isArray(explicit.video_input_labels))) {
    return {
      audio_input_labels: Array.isArray(explicit.audio_input_labels) ? explicit.audio_input_labels.map(String) : [],
      audio_output_labels: Array.isArray(explicit.audio_output_labels) ? explicit.audio_output_labels.map(String) : [],
      communications_text: commsText,
      default_text: defaultText,
      video_input_labels: Array.isArray(explicit.video_input_labels) ? explicit.video_input_labels.map(String) : [],
    };
  }

  const fallback = MEDIA_POOLS_BY_OS[os] || MEDIA_POOLS_BY_OS.windows;

  const isLabelCompatible = (label) => {
    if (!label) return false;
    if (os === 'windows') {
      if (/facetime|macbook|mac mini/i.test(label)) return false;
      if (/back camera|front camera|rear camera/i.test(label)) return false;
    } else if (os === 'macos') {
      if (/realtek|conexant|synaptics/i.test(label)) return false;
      if (/back camera|front camera|rear camera/i.test(label)) return false;
    } else if (os === 'android') {
      if (/realtek|conexant|synaptics/i.test(label)) return false;
      if (/facetime|macbook|mac mini/i.test(label)) return false;
    } else if (os === 'ios') {
      if (/realtek|conexant|synaptics|integrated camera/i.test(label)) return false;
      if (/macbook|mac mini|facetime/i.test(label)) return false;
    } else if (os === 'linux') {
      if (/realtek|conexant|synaptics|integrated camera/i.test(label)) return false;
      if (/facetime|macbook|mac mini|\bmac\b/i.test(label)) return false;
    }
    return true;
  };

  const devices = Array.isArray(fp.mediaDevices?.devices) ? fp.mediaDevices.devices : [];
  const audioIn = devices.filter((d) => d && d.kind === 'audioinput').map((d) => String(d.label || '').trim()).filter(isLabelCompatible);
  const audioOut = devices.filter((d) => d && d.kind === 'audiooutput').map((d) => String(d.label || '').trim()).filter(isLabelCompatible);
  const videoIn = devices.filter((d) => d && d.kind === 'videoinput').map((d) => String(d.label || '').trim()).filter(isLabelCompatible);

  return {
    audio_input_labels: audioIn.length ? audioIn : [...fallback.audio_input],
    audio_output_labels: audioOut.length ? audioOut : [...fallback.audio_output],
    communications_text: commsText,
    default_text: defaultText,
    video_input_labels: videoIn.length ? videoIn : [...fallback.video_input],
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
  const rawWebrtc = fp.webrtc || privacy.webrtc || 'proxy';
  const webrtcMode = rawWebrtc === 'disabled' ? 'disabled' : (rawWebrtc === 'real' ? 'real' : 'proxy');
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
  const fontList = fontFingerprinting ? fontListFromFp(fp) : [];
  const effectiveFontEnable = Boolean(fontFingerprinting && fontList.length > 0);
  const isEnumerateDevicesEnable = mediaMode !== 'real';

  const exitIp = String(
    profile.exitIp
    || profile.exitIP
    || fp.webrtcAddress
    || fp.dynamicConfig?.webrtcAddress
    || privacy.webrtcAddress
    || ''
  ).trim();
  let localIp = String(
    fp.webrtcLocalIp
    || fp.staticConfig?.webrtcLocalIp
    || fp.dynamicConfig?.webrtcLocalIp
    || privacy.webrtcLocalIp
    || ''
  ).trim();

  let isWebrtcEnable = webrtcMode !== 'disabled';
  let webrtcPolicy = 0;
  let webrtcFakeIp = undefined;
  let webrtcLocalIp = undefined;

  if (isWebrtcEnable) {
    if (webrtcMode === 'proxy') {
      if (exitIp && exitIp !== '0.0.0.0') {
        webrtcPolicy = 3;
        webrtcFakeIp = exitIp;
      } else {
        // Exit IP is missing: cannot fake exit IP; downgrade to real mode (policy 1)
        // Never write empty or placeholder fake IP (e.g. 0.0.0.0)
        webrtcPolicy = 1;
      }
    } else {
      // Real mode
      webrtcPolicy = 1;
    }

    if (!isValidPrivateIpv4(localIp)) {
      localIp = fallbackPrivateIp(profile.id || fp.profileId || 'webrtc-local');
    }
    webrtcLocalIp = localIp;
  } else {
    isWebrtcEnable = false;
    webrtcPolicy = 0;
  }

  const fields = {
    platform: String(fp.platform || meta.platform || 'Win32'),
    accept_languages: accept,
    is_webrtc_enable: isWebrtcEnable,
    webrtc_policy: webrtcPolicy,
    is_canvas_finger_printing_enable: canvasMode === 'noise',
    is_webgl_finger_printing_enable: webglMode === 'noise',
    is_audio_finger_printing_enable: audioMode === 'noise',
    is_clientrects_finger_printing_enable: clientRectsMode === 'noise',
    is_enumerate_devices_enable: isEnumerateDevicesEnable,
    is_font_finger_printing_enable: effectiveFontEnable,
    GoogleSpeechSynthesis: speechMode !== 'blocked',
    webrtc_media_labels: mediaLabelsFromFp(fp, profile, isEnumerateDevicesEnable),
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

  if (webrtcFakeIp !== undefined) fields.webrtc_fake_ip = webrtcFakeIp;
  if (webrtcLocalIp !== undefined) fields.webrtc_local_ip = webrtcLocalIp;

  if (isWebrtcEnable) {
    const stunServers = Array.isArray(privacy.webrtcStunServers)
      ? privacy.webrtcStunServers
      : (Array.isArray(fp.webrtcStunServers) ? fp.webrtcStunServers : null);
    if (stunServers && stunServers.length) {
      fields.webrtc_stun_servers = stunServers.map((item) => String(item || '').trim()).filter(Boolean);
    }
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
  if (skipHosts.length || Array.isArray(fp?.stability?.skipHosts) || Array.isArray(privacy?.stabilitySkipHosts)) {
    fields._canvasSkipHosts = skipHosts;
    // Canvas 与 WebGL 的豁免列表在内核里是两个独立字段，任何一层漏写都会让同一站点
    // 在两条渲染路径上得到不同答案，因此两者必须同源同值。
    fields._webglSkipHosts = skipHosts;
  }
  // The switch and its list travel together: a switch with nothing to answer from leaves the
  // native layer undefined, while a list without the switch could activate a build that reads the
  // list on its own.
  if (effectiveFontEnable) fields.font_list = fontList;

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
  const seen = new Set();
  const out = [];
  const collect = (arr) => {
    for (const raw of Array.isArray(arr) ? arr : []) {
      const family = String(raw || '').trim();
      if (!family || seen.has(family.toLowerCase())) continue;
      seen.add(family.toLowerCase());
      out.push(family);
    }
  };
  if (personaList && personaList.length) {
    collect(personaList);
  }
  if (!out.length) {
    const osFonts = fontsForOs((fp && fp.uaProfile && fp.uaProfile.os) || (fp && fp.platform) || 'windows');
    collect(osFonts);
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
    if (raw == null) continue;
    if (typeof raw === 'boolean' || (typeof raw === 'object' && raw !== null)) continue;
    const host = String(raw)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^\*\./, '');
    if (!host || seen.has(host) || /\s/.test(host)) continue;
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
  // Canvas 与 WebGL 的豁免列表在内核里是两个独立字段，任何一层漏写都会让同一站点
  // 在两条渲染路径上得到不同答案，因此两者必须同源同值。
  const explicitSkipHosts = Array.isArray(fields._canvasSkipHosts)
    ? fields._canvasSkipHosts
    : (Array.isArray(fields._webglSkipHosts) ? fields._webglSkipHosts : null);
  if (explicitSkipHosts !== null) {
    init.canvas_fingerprint_skip_hosts = [...explicitSkipHosts];
    init.webgl_fingerprint_skip_hosts = [...explicitSkipHosts];
  } else if (Array.isArray(init.canvas_fingerprint_skip_hosts) || Array.isArray(init.webgl_fingerprint_skip_hosts)) {
    const fallbackHosts = Array.isArray(init.canvas_fingerprint_skip_hosts)
      ? init.canvas_fingerprint_skip_hosts
      : init.webgl_fingerprint_skip_hosts;
    init.canvas_fingerprint_skip_hosts = [...fallbackHosts];
    init.webgl_fingerprint_skip_hosts = [...fallbackHosts];
  }

  // 字体指纹开关与列表配对不变量：开关为 true 必须有非空列表，开关为 false 绝不保留列表
  if (init.is_font_finger_printing_enable && Array.isArray(fields.font_list) && fields.font_list.length > 0) {
    init.font_list = [...fields.font_list];
  } else {
    init.is_font_finger_printing_enable = false;
    delete init.font_list;
    delete init.full_font_list;
  }

  // WebRTC 互洽不变量：
  // 1. is_webrtc_enable === false 时强制归零策略并清除所有 IP / STUN 残留
  if (init.is_webrtc_enable === false) {
    init.webrtc_policy = 0;
    delete init.webrtc_fake_ip;
    delete init.webrtc_local_ip;
    delete init.webrtc_stun_servers;
  } else if (init.is_webrtc_enable === true) {
    // 2. 策略为伪造出口 IP 时必须具备合法的出口 IP，否则降级为 real (策略 1) 且不写入占位/空 fake ip
    if (init.webrtc_policy === 3) {
      if (fields.webrtc_fake_ip && fields.webrtc_fake_ip !== '0.0.0.0') {
        init.webrtc_fake_ip = fields.webrtc_fake_ip;
      } else if (!init.webrtc_fake_ip || init.webrtc_fake_ip === '0.0.0.0') {
        init.webrtc_policy = 1;
        delete init.webrtc_fake_ip;
      }
    } else if (init.webrtc_policy === 1 || init.webrtc_policy === 0) {
      delete init.webrtc_fake_ip;
    }

    // 3. webrtc_local_ip 必须为有效私网 IPv4 地址
    if (fields.webrtc_local_ip && isValidPrivateIpv4(fields.webrtc_local_ip)) {
      init.webrtc_local_ip = fields.webrtc_local_ip;
    } else if (!init.webrtc_local_ip || !isValidPrivateIpv4(init.webrtc_local_ip)) {
      init.webrtc_local_ip = fallbackPrivateIp(fields._windowName || 'webrtc-local');
    }
  }

  // 4. webrtc_media_labels 同源与枚举关闭清空不变量：
  if (init.is_enumerate_devices_enable === false) {
    const existing = (init.webrtc_media_labels && typeof init.webrtc_media_labels === 'object') ? init.webrtc_media_labels : {};
    init.webrtc_media_labels = {
      audio_input_labels: [],
      audio_output_labels: [],
      communications_text: String(existing.communications_text || fields.webrtc_media_labels?.communications_text || 'Communications - '),
      default_text: String(existing.default_text || fields.webrtc_media_labels?.default_text || 'Default - '),
      video_input_labels: [],
    };
  } else if (fields.webrtc_media_labels) {
    init.webrtc_media_labels = {
      audio_input_labels: Array.isArray(fields.webrtc_media_labels.audio_input_labels) ? [...fields.webrtc_media_labels.audio_input_labels] : [],
      audio_output_labels: Array.isArray(fields.webrtc_media_labels.audio_output_labels) ? [...fields.webrtc_media_labels.audio_output_labels] : [],
      communications_text: String(fields.webrtc_media_labels.communications_text || 'Communications - '),
      default_text: String(fields.webrtc_media_labels.default_text || 'Default - '),
      video_input_labels: Array.isArray(fields.webrtc_media_labels.video_input_labels) ? [...fields.webrtc_media_labels.video_input_labels] : [],
    };
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
function isDeepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (Array.isArray(b)) return false;

  const aKeys = Object.keys(a).filter((k) => a[k] !== undefined);
  const bKeys = Object.keys(b).filter((k) => b[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;

  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!isDeepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * 严格回读比对全部泄漏关键字段：
 * platform, user_agent_data, webgl_vendor, webgl_renderer, webgpu_parameter,
 * accept_languages, cmd_line(user-agent, lange), is_font_finger_printing_enable,
 * font_list, canvas_fingerprint_skip_hosts, webgl_fingerprint_skip_hosts,
 * is_webrtc_enable, webrtc_policy, webrtc_fake_ip, webrtc_local_ip, webrtc_media_labels
 */
function verifyKernelInitReadback(written, readback, initPath) {
  if (!readback || typeof readback !== 'object') {
    throw new Error('Failed to verify written init.json at ' + initPath + ': readback failed');
  }

  const mismatches = [];
  const fields = [
    'platform',
    'user_agent_data',
    'webgl_vendor',
    'webgl_renderer',
    'webgpu_parameter',
    'accept_languages',
    'is_font_finger_printing_enable',
    'font_list',
    'canvas_fingerprint_skip_hosts',
    'webgl_fingerprint_skip_hosts',
    'is_webrtc_enable',
    'webrtc_policy',
    'webrtc_fake_ip',
    'webrtc_local_ip',
    'webrtc_media_labels',
  ];

  for (const f of fields) {
    const wVal = written[f];
    const rVal = readback[f];
    if (!isDeepEqual(wVal, rVal)) {
      mismatches.push(`${f} (expected ${JSON.stringify(wVal)}, read back ${JSON.stringify(rVal)})`);
    }
  }

  const wCmd = written.cmd_line || {};
  const rCmd = readback.cmd_line || {};
  if (wCmd['user-agent'] !== rCmd['user-agent']) {
    mismatches.push(`cmd_line.user-agent (expected ${JSON.stringify(wCmd['user-agent'])}, read back ${JSON.stringify(rCmd['user-agent'])})`);
  }
  if (wCmd.lange !== rCmd.lange) {
    mismatches.push(`cmd_line.lange (expected ${JSON.stringify(wCmd.lange)}, read back ${JSON.stringify(rCmd.lange)})`);
  }

  if (mismatches.length > 0) {
    throw new Error('Failed to verify written init.json at ' + initPath + ': readback verification failed: ' + mismatches.join('; '));
  }
}

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

  const invariantCheck = validateKernelInitInvariants(init);
  if (!invariantCheck.valid) {
    throw new Error('Kernel init invariant violation: ' + invariantCheck.issues.join('; '));
  }

  const encoded = encodeInitObject(init);
  await fsp.writeFile(initPath, encoded, 'utf8');

  // 支持测试插桩以检验人为篡改捕获能力
  if (typeof options._beforeReadback === 'function') {
    await options._beforeReadback(initPath);
  }

  const readback = loadInitObject(await fsp.readFile(initPath));
  verifyKernelInitReadback(init, readback, initPath);

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

/**
 * Validate openbrowser-148 init.json invariants:
 * 1. Font invariant: is_font_finger_printing_enable === true <==> font_list is a non-empty array
 * 2. Skip hosts invariant: canvas_fingerprint_skip_hosts and webgl_fingerprint_skip_hosts must be strictly co-sourced and identical
 */
function validateKernelInitInvariants(init) {
  const issues = [];
  if (!init || typeof init !== 'object') {
    return { valid: false, issues: ['init is not an object'] };
  }
  if (init.is_font_finger_printing_enable) {
    if (!Array.isArray(init.font_list) || init.font_list.length === 0) {
      issues.push('is_font_finger_printing_enable is true but font_list is missing or empty');
    }
  } else {
    if (init.font_list !== undefined) {
      issues.push('is_font_finger_printing_enable is false but font_list is present');
    }
    if (init.full_font_list !== undefined) {
      issues.push('is_font_finger_printing_enable is false but full_font_list is present');
    }
  }
  const hasCanvasSkip = Array.isArray(init.canvas_fingerprint_skip_hosts);
  const hasWebglSkip = Array.isArray(init.webgl_fingerprint_skip_hosts);
  if (hasCanvasSkip !== hasWebglSkip) {
    issues.push('canvas_fingerprint_skip_hosts and webgl_fingerprint_skip_hosts must both be present or both absent');
  } else if (hasCanvasSkip && hasWebglSkip) {
    if (JSON.stringify(init.canvas_fingerprint_skip_hosts) !== JSON.stringify(init.webgl_fingerprint_skip_hosts)) {
      issues.push('canvas_fingerprint_skip_hosts and webgl_fingerprint_skip_hosts must have identical items');
    }
  }

  // 3. WebRTC 互洽不变量校验
  if (init.is_webrtc_enable !== undefined) {
    if (init.is_webrtc_enable === false) {
      if (init.webrtc_policy !== undefined && init.webrtc_policy !== 0) {
        issues.push('is_webrtc_enable is false but webrtc_policy is not 0 (disabled)');
      }
      if (init.webrtc_fake_ip !== undefined) {
        issues.push('is_webrtc_enable is false but webrtc_fake_ip is present');
      }
      if (init.webrtc_local_ip !== undefined) {
        issues.push('is_webrtc_enable is false but webrtc_local_ip is present');
      }
      if (init.webrtc_stun_servers !== undefined) {
        issues.push('is_webrtc_enable is false but webrtc_stun_servers is present');
      }
    } else if (init.is_webrtc_enable === true) {
      if (init.webrtc_policy === 0) {
        issues.push('is_webrtc_enable is true but webrtc_policy is 0 (disabled)');
      }
      if (init.webrtc_policy === 3) {
        if (!init.webrtc_fake_ip || typeof init.webrtc_fake_ip !== 'string' || !init.webrtc_fake_ip.trim() || init.webrtc_fake_ip === '0.0.0.0') {
          issues.push('webrtc_policy is 3 (fake exit IP) but webrtc_fake_ip is missing, empty, or placeholder (0.0.0.0)');
        }
      } else if (init.webrtc_policy === 1) {
        if (init.webrtc_fake_ip !== undefined) {
          issues.push('webrtc_policy is 1 (real) but webrtc_fake_ip is present');
        }
      }
      if (init.webrtc_local_ip !== undefined) {
        if (!isValidPrivateIpv4(init.webrtc_local_ip)) {
          issues.push(`webrtc_local_ip must be a valid private IPv4 address (10.x, 172.16-31.x, 192.168.x), got: ${JSON.stringify(init.webrtc_local_ip)}`);
        }
      } else {
        issues.push('is_webrtc_enable is true but webrtc_local_ip is missing');
      }
    }
  }

  // 4. webrtc_media_labels 同源与前缀校验
  if (init.webrtc_media_labels !== undefined) {
    const ml = init.webrtc_media_labels;
    if (!ml || typeof ml !== 'object') {
      issues.push('webrtc_media_labels must be an object');
    } else {
      if (typeof ml.default_text !== 'string' || !ml.default_text) {
        issues.push('webrtc_media_labels.default_text must be a non-empty string');
      }
      if (typeof ml.communications_text !== 'string' || !ml.communications_text) {
        issues.push('webrtc_media_labels.communications_text must be a non-empty string');
      }
      if (!Array.isArray(ml.audio_input_labels) || !Array.isArray(ml.audio_output_labels) || !Array.isArray(ml.video_input_labels)) {
        issues.push('webrtc_media_labels audio/video label lists must be arrays');
      } else if (init.is_enumerate_devices_enable === false) {
        if (ml.audio_input_labels.length > 0 || ml.audio_output_labels.length > 0 || ml.video_input_labels.length > 0) {
          issues.push('is_enumerate_devices_enable is false but webrtc_media_labels contains non-empty label lists');
        }
      } else {
        const os = detectInitOs(init);
        const checkLabels = (list, kind) => {
          for (const raw of list) {
            const label = String(raw || '').trim();
            if (!label) continue;
            if (os === 'windows') {
              if (/facetime|macbook|mac mini/i.test(label)) {
                issues.push(`webrtc_media_labels.${kind} contains macOS device "${label}" on Windows persona`);
              }
              if (/back camera|front camera|rear camera/i.test(label)) {
                issues.push(`webrtc_media_labels.${kind} contains Android device "${label}" on Windows persona`);
              }
            } else if (os === 'macos') {
              if (/realtek|conexant|synaptics/i.test(label)) {
                issues.push(`webrtc_media_labels.${kind} contains Windows device "${label}" on macOS persona`);
              }
              if (/back camera|front camera|rear camera/i.test(label)) {
                issues.push(`webrtc_media_labels.${kind} contains Android device "${label}" on macOS persona`);
              }
            } else if (os === 'android') {
              if (/realtek|conexant|synaptics/i.test(label)) {
                issues.push(`webrtc_media_labels.${kind} contains Windows device "${label}" on Android persona`);
              }
              if (/facetime|macbook|mac mini/i.test(label)) {
                issues.push(`webrtc_media_labels.${kind} contains macOS device "${label}" on Android persona`);
              }
            } else if (os === 'ios') {
              if (/realtek|conexant|synaptics|integrated camera/i.test(label)) {
                issues.push(`webrtc_media_labels.${kind} contains Windows device "${label}" on iOS persona`);
              }
              if (/macbook|mac mini|facetime/i.test(label)) {
                issues.push(`webrtc_media_labels.${kind} contains macOS device "${label}" on iOS persona`);
              }
            } else if (os === 'linux') {
              if (/realtek|conexant|synaptics|integrated camera/i.test(label)) {
                issues.push(`webrtc_media_labels.${kind} contains Windows device "${label}" on Linux persona`);
              }
              if (/facetime|macbook|mac mini|\bmac\b/i.test(label)) {
                issues.push(`webrtc_media_labels.${kind} contains macOS device "${label}" on Linux persona`);
              }
            }
          }
        };
        checkLabels(ml.audio_input_labels, 'audio_input_labels');
        checkLabels(ml.audio_output_labels, 'audio_output_labels');
        checkLabels(ml.video_input_labels, 'video_input_labels');
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
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
  validateKernelInitInvariants,
  isValidPrivateIpv4,
  fallbackPrivateIp,
  mediaLabelsFromFp,
  isDeepEqual,
  verifyKernelInitReadback,
  detectInitOs,
  detectOs,
  MEDIA_POOLS_BY_OS,
};
