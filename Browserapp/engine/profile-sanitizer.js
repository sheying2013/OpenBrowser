"use strict";

const { assertProfileId } = require("../automation/isolation");
const { normalizeIpLookupChannel } = require("../proxy-forwarder");
const { profileProxyAssociation, normalizedProxyAssociationId } = require("./proxy-helpers");

const MAX_PROFILE_PROXY_LENGTH = 64 * 1024;

function sanitizeProfile(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || typeof value.name !== "string") throw new Error("Invalid profile");
  const id = assertProfileId(value.id);
  const privacyValue = value.privacy && typeof value.privacy === "object" ? value.privacy : {};
  const advancedValue = value.advanced && typeof value.advanced === "object" ? value.advanced : {};
  const proxyMetaValue = value.proxyMeta && typeof value.proxyMeta === "object" ? value.proxyMeta : {};
  const platformValue = value.platform && typeof value.platform === "object" ? value.platform : {};
  const fingerprintValue = value.fingerprint && typeof value.fingerprint === "object"
    ? value.fingerprint
    : (privacyValue.fingerprint && typeof privacyValue.fingerprint === "object" ? privacyValue.fingerprint : null);
  const allowed = (candidate, values, fallback) => values.includes(String(candidate || "")) ? String(candidate) : fallback;
  const finite = (candidate) => candidate !== "" && candidate !== null && candidate !== undefined && Number.isFinite(Number(candidate)) ? Number(candidate) : null;
  const width = Math.min(7680, Math.max(640, Number(value.width) || 1280));
  const height = Math.min(4320, Math.max(480, Number(value.height) || 820));
  const number = Number.parseInt(value.number, 10);
  const parseLimitedOption = (candidate, values) => {
    if (candidate === "" || candidate === null || candidate === undefined) return null;
    const val = Number(candidate);
    return values.includes(val) ? val : null;
  };
  const cpuCandidate = privacyValue.cores === "" || privacyValue.cores === null || privacyValue.cores === undefined
    ? fingerprintValue?.cores
    : privacyValue.cores;
  const memoryCandidate = privacyValue.memory === "" || privacyValue.memory === null || privacyValue.memory === undefined
    ? fingerprintValue?.memory
    : privacyValue.memory;
  const cores = parseLimitedOption(cpuCandidate, [0, 2, 4, 6, 8, 10, 12, 16]);
  const memory = parseLimitedOption(memoryCandidate, [0, 2, 4, 6, 8]);
  const rawProxy = String(value.proxy || "").trim();
  if (rawProxy.length > MAX_PROFILE_PROXY_LENGTH) throw new Error("Proxy URL is too long");
  const networkMode = value.networkMode === "direct" || !rawProxy || /^(direct|offline|none)$/i.test(rawProxy) ? "direct" : "proxy";
  const effectiveStartUrl = String(value.startUrl || platformValue.startUrl || advancedValue.startUrls || "").trim().slice(0, 2000);
  const proxyAssociation = profileProxyAssociation(value);
  const proxyId = networkMode === "direct" ? null : normalizedProxyAssociationId(proxyAssociation.value);

  return {
    id,
    number: Number.isInteger(number) && number > 0 ? number : null,
    name: value.name.slice(0, 100),
    title: String(value.title || value.displayName || "").slice(0, 120),
    startUrl: effectiveStartUrl,
    browser: "Google Chrome",
    os: String(value.os || "Windows").slice(0, 40),
    location: String(value.location || "Local").slice(0, 80),
    networkMode,
    proxy: networkMode === "direct" ? "Direct" : rawProxy,
    proxyId,
    tag: String(value.tag || "").slice(0, 40),
    groupId: String(value.groupId || "").slice(0, 64),
    group_name: String(value.group_name || value.groupName || "").slice(0, 40),
    language: String(value.language || "en-US").slice(0, 20),
    width,
    height,
    userAgent: String(value.userAgent || "").replace(/[\r\n]/g, " ").slice(0, 1000),
    cookies: String(value.cookies || "").slice(0, 500000),
    note: String(value.note || "").slice(0, 2000),
    exitIp: String(value.exitIp || "").slice(0, 80),
    exitCountryCode: String(value.exitCountryCode || "").slice(0, 4),
    exitTimezone: String(value.exitTimezone || "").slice(0, 100),
    exitLatitude: finite(value.exitLatitude),
    exitLongitude: finite(value.exitLongitude),
    exitCheckedAt: String(value.exitCheckedAt || "").slice(0, 40),
    exitLatencyMs: finite(value.exitLatencyMs),
    exitNetworkType: String(value.exitNetworkType || "").slice(0, 40),
    platform: {
      type: String(platformValue.type || "other").slice(0, 40),
      startUrl: effectiveStartUrl,
      username: String(platformValue.username || "").slice(0, 200),
      password: String(platformValue.password || "").slice(0, 500),
      totpSecret: String(platformValue.totpSecret || platformValue.otp || "").slice(0, 200),
    },
    proxyMeta: {
      proxyId,
      ipChannel: normalizeIpLookupChannel(proxyMetaValue.ipChannel ?? proxyMetaValue.ip_channel),
      refreshUrl: String(proxyMetaValue.refreshUrl ?? proxyMetaValue.refresh_url ?? "").slice(0, 1000),
      checkOnStart: Boolean(proxyMetaValue.checkOnStart),
      refreshOnStart: Boolean(proxyMetaValue.refreshOnStart),
      systemProxy: allowed(proxyMetaValue.systemProxy, ["global", "use", "off"], "global"),
      directBypass: Boolean(proxyMetaValue.directBypass),
      bypassList: String(proxyMetaValue.bypassList || "").slice(0, 4000),
      apiExtractUrl: String(proxyMetaValue.apiExtractUrl || "").slice(0, 2000),
      backupProxies: Array.isArray(proxyMetaValue.backupProxies)
        ? proxyMetaValue.backupProxies.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
        : (typeof proxyMetaValue.backupProxies === "string"
          ? String(proxyMetaValue.backupProxies).split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8)
          : []),
      fillFingerprint: proxyMetaValue.fillFingerprint !== false,
      requireReady: proxyMetaValue.requireReady !== false,
      notReadyPolicy: allowed(proxyMetaValue.notReadyPolicy, ["block", "direct", "continue"], proxyMetaValue.requireReady === false ? "continue" : "block"),
      tlsProfile: allowed(proxyMetaValue.tlsProfile, ["auto", "chrome", "chrome_legacy", "node", "off"], "auto"),
      tlsChromeMajor: (() => {
        const n = Number(proxyMetaValue.tlsChromeMajor);
        return Number.isFinite(n) && n >= 1 && n <= 999 ? Math.round(n) : null;
      })(),
    },
    privacy: {
      webrtc: allowed(privacyValue.webrtc, ["proxy", "disabled", "real"], "proxy"),
      timezoneMode: allowed(privacyValue.timezoneMode, ["ip", "real", "custom"], "ip"),
      timezone: String(privacyValue.timezone || "").slice(0, 100),
      geoMode: allowed(privacyValue.geoMode, ["ip", "disabled", "custom", "prompt", "allow"], privacyValue.geoMode === "prompt" ? "prompt" : (privacyValue.geoMode === "allow" ? "ip" : "ip")),
      latitude: finite(privacyValue.latitude),
      longitude: finite(privacyValue.longitude),
      accuracy: Math.min(100000, Math.max(1, Number(privacyValue.accuracy) || 100)),
      uiLanguage: String(privacyValue.uiLanguage || "profile").slice(0, 20),
      langFromIp: privacyValue.langFromIp !== false,
      languageMode: String(privacyValue.languageMode || (privacyValue.langFromIp !== false ? "ip" : (privacyValue.uiLanguage || "profile"))).slice(0, 20),
      timezoneFromIp: privacyValue.timezoneFromIp !== false,
      geoFromIp: privacyValue.geoFromIp !== false,
      fontMode: allowed(privacyValue.fontMode, ["default", "custom"], "default"),
      fontSize: Math.min(36, Math.max(9, Number(privacyValue.fontSize) || 16)),
      deviceProfile: allowed(privacyValue.deviceProfile, ["default", "persona"], "default"),
      canvas: allowed(privacyValue.canvas, ["real", "noise", "blocked"], privacyValue.canvas === "blocked" ? "blocked" : (privacyValue.canvas === "real" ? "real" : "noise")),
      webgl: allowed(privacyValue.webgl, ["real", "noise", "blocked"], privacyValue.webgl === "blocked" ? "blocked" : (privacyValue.webgl === "real" ? "real" : "noise")),
      webglMeta: allowed(privacyValue.webglMeta, ["noise", "custom", "real", "blocked"], "noise"),
      webgpu: allowed(privacyValue.webgpu, ["real", "blocked", "webgl"], privacyValue.webgpu === "webgl" ? "webgl" : (privacyValue.webgpu === "blocked" ? "blocked" : "real")),
      audio: allowed(privacyValue.audio, ["real", "noise", "muted"], privacyValue.audio === "muted" ? "muted" : (privacyValue.audio === "real" ? "real" : "noise")),
      media: allowed(privacyValue.media, ["real", "blocked", "noise"], privacyValue.media === "blocked" ? "blocked" : (privacyValue.media === "noise" ? "noise" : "real")),
      mediaDevices: allowed(privacyValue.mediaDevices, ["real", "noise", "empty"], privacyValue.mediaDevices === "real" ? "real" : (privacyValue.mediaDevices === "empty" ? "empty" : (privacyValue.media === "noise" ? "noise" : (privacyValue.media === "blocked" ? "empty" : "noise")))),
      mediaLabels: privacyValue.mediaLabels && typeof privacyValue.mediaLabels === "object" ? {
        audioinput: String(privacyValue.mediaLabels.audioinput || privacyValue.mediaLabels.input || "").slice(0, 200),
        videoinput: String(privacyValue.mediaLabels.videoinput || privacyValue.mediaLabels.video || "").slice(0, 200),
        audiooutput: String(privacyValue.mediaLabels.audiooutput || privacyValue.mediaLabels.output || "").slice(0, 200),
      } : null,
      battery: allowed(privacyValue.battery, ["real", "noise", "blocked"], privacyValue.battery === "blocked" ? "blocked" : (privacyValue.battery === "real" ? "real" : "noise")),
      batterySnapshot: privacyValue.batterySnapshot && typeof privacyValue.batterySnapshot === "object" ? {
        charging: privacyValue.batterySnapshot.charging !== false,
        level: Math.min(1, Math.max(0, Number(privacyValue.batterySnapshot.level) || 0.87)),
        chargingTime: Number.isFinite(Number(privacyValue.batterySnapshot.chargingTime)) ? Number(privacyValue.batterySnapshot.chargingTime) : null,
        dischargingTime: Number.isFinite(Number(privacyValue.batterySnapshot.dischargingTime)) ? Number(privacyValue.batterySnapshot.dischargingTime) : null,
      } : null,
      webrtcPolicy: privacyValue.webrtc === "disabled" ? 0 : (privacyValue.webrtc === "real" ? 1 : 3),
      stabilityMode: allowed(privacyValue.stabilityMode, ["off", "auto", "force"], "auto"),
      stabilityHamming: Math.min(64, Math.max(1, Number(privacyValue.stabilityHamming) || 12)),
      stabilityMaxWidth: Math.min(4096, Math.max(64, Number(privacyValue.stabilityMaxWidth) || 600)),
      stabilityMaxHeight: Math.min(4096, Math.max(64, Number(privacyValue.stabilityMaxHeight) || 600)),
      stabilitySquare: Math.min(64, Math.max(2, Number(privacyValue.stabilitySquare) || 8)),
      stabilityHosts: Array.isArray(privacyValue.stabilityHosts)
        ? privacyValue.stabilityHosts.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean).slice(0, 800)
        : (typeof privacyValue.stabilityHosts === "string"
          ? String(privacyValue.stabilityHosts).split(/[\r\n,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 800)
          : null),
      stabilitySkipHosts: Array.isArray(privacyValue.stabilitySkipHosts)
        ? privacyValue.stabilitySkipHosts.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean).slice(0, 200)
        : (typeof privacyValue.stabilitySkipHosts === "string"
          ? String(privacyValue.stabilitySkipHosts).split(/[\r\n,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 200)
          : null),
      clientRects: allowed(privacyValue.clientRects, ["real", "noise"], privacyValue.clientRects === "real" ? "real" : "noise"),
      speech: allowed(privacyValue.speech, ["real", "blocked", "noise"], privacyValue.speech === "blocked" ? "blocked" : (privacyValue.speech === "noise" ? "noise" : "real")),
      deviceNameMode: allowed(privacyValue.deviceNameMode, ["noise", "custom", "real"], "noise"),
      deviceName: String(privacyValue.deviceName || "").slice(0, 120),
      dnt: privacyValue.dnt === true || privacyValue.dnt === "on" ? true : (privacyValue.dnt === false || privacyValue.dnt === "off" ? false : Boolean(privacyValue.dnt)),
      dntMode: allowed(privacyValue.dntMode, ["default", "on", "off"], privacyValue.dnt === true ? "on" : (privacyValue.dnt === false ? "off" : "default")),
      portScanProtect: Boolean(privacyValue.portScanProtect),
      portScanAllow: String(privacyValue.portScanAllow || "").slice(0, 500),
      cfOptimize: privacyValue.cfOptimize !== false,
      refreshFingerprintOnStart: Boolean(privacyValue.refreshFingerprintOnStart),
      cores,
      memory,
      ...(fingerprintValue ? { fingerprint: {
        ...fingerprintValue,
        cores: cores === null || cores === undefined
          ? (fingerprintValue.cores === 0 || fingerprintValue.cores === "0"
            ? 0
            : (fingerprintValue.cores ?? null))
          : cores,
        memory: memory === null || memory === undefined
          ? (fingerprintValue.memory === 0 || fingerprintValue.memory === "0"
            ? 0
            : (fingerprintValue.memory ?? null))
          : memory,
      } } : {}),
    },
    advanced: {
      saveCookies: advancedValue.saveCookies !== false,
      savePasswords: Boolean(advancedValue.savePasswords),
      saveBookmarks: advancedValue.saveBookmarks !== false,
      saveLocalStorage: advancedValue.saveLocalStorage !== false,
      saveIndexedDB: advancedValue.saveIndexedDB !== false,
      saveHistory: advancedValue.saveHistory !== false,
      allowSignin: Boolean(advancedValue.allowSignin),
      restoreSession: Boolean(advancedValue.restoreSession) || advancedValue.tabMode === "restore",
      blockVideo: Boolean(advancedValue.blockVideo || advancedValue.blockSound),
      blockImages: Boolean(advancedValue.blockImages),
      clearCacheOnStart: Boolean(advancedValue.clearCacheOnStart),
      cloudBackup: Boolean(advancedValue.cloudBackup),
      syncCookiesOnClose: advancedValue.syncCookiesOnClose !== false,
      syncIndexedDB: Boolean(advancedValue.syncIndexedDB),
      syncLocalStorage: Boolean(advancedValue.syncLocalStorage),
      syncPasswords: Boolean(advancedValue.syncPasswords),
      syncExtensionData: Boolean(advancedValue.syncExtensionData),
      multiOpen: Boolean(advancedValue.multiOpen),
      tabMode: allowed(advancedValue.tabMode, ["fixed", "restore"], advancedValue.restoreSession ? "restore" : "fixed"),
      startUrls: String(advancedValue.startUrls || effectiveStartUrl || "").slice(0, 8000),
      blockUrls: String(advancedValue.blockUrls || "").slice(0, 8000),
      blockSound: Boolean(advancedValue.blockSound),
      blockPasswordPrompt: Boolean(advancedValue.blockPasswordPrompt),
      blockRestoreDialog: advancedValue.blockRestoreDialog !== false,
      blockNotifications: advancedValue.blockNotifications !== false,
      blockPopups: Boolean(advancedValue.blockPopups),
      jsHeapMax: Boolean(advancedValue.jsHeapMax),
      showInfoPage: advancedValue.showInfoPage !== false,
      showPasswordOnInfo: Boolean(advancedValue.showPasswordOnInfo),
      loadGlobalBookmarks: Boolean(advancedValue.loadGlobalBookmarks),
      showBookmarkBar: Boolean(advancedValue.showBookmarkBar),
      uploadBookmarks: Boolean(advancedValue.uploadBookmarks),
    },
  };
}

module.exports = {
  MAX_PROFILE_PROXY_LENGTH,
  sanitizeProfile,
};
