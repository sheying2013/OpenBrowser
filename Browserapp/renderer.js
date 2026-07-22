const UI_KEY = 'openbrowser-ui-state';
const GROUP_COLORS = ['#245cff', '#22d3ee', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb7185', '#94a3b8', '#f97316', '#2dd4bf'];
const UNGROUPED_ID = '';

function t(key, params) {
  return window.OpenBrowserI18n?.t?.(key, params) ?? key;
}

function tx(s) {
  if (s == null || s === '') return s;
  try {
    if (window.OpenBrowserI18n?.getLocale?.() === 'zh-CN') return String(s);
    return window.OpenBrowserI18n?.translateChineseUiText?.(String(s)) ?? String(s);
  } catch (_) { return String(s); }
}


const appUpdateState = { status: 'idle', result: null, message: '', progress: null };

function applyVersionTrafficLight(payload) {
  const lightEl = document.getElementById('version-traffic-light');
  const wrap = document.getElementById('app-version-wrap');
  const versionEl = document.getElementById('app-version');
  if (!lightEl || !wrap) return;
  // Product: green = latest, red = update available. Never paint "latest" as yellow.
  let light = payload?.light;
  if (!light) {
    if (payload?.status === 'checking') light = 'checking';
    else if (payload?.upToDate === true) light = 'green';
    else if (payload?.upToDate === false && payload?.remoteVersion) light = 'red';
    else if (payload?.error) light = 'unknown';
    else light = 'checking';
  }
  // Legacy / mistaken amber states → gray unknown (not "update available")
  if (light === 'yellow' || light === 'amber' || light === 'orange') light = 'unknown';
  // If backend already compared versions, force green/red even if light string is wrong
  if (payload?.upToDate === true) light = 'green';
  else if (payload?.upToDate === false && payload?.remoteVersion) light = 'red';
  lightEl.dataset.state = light;
  if (payload?.currentVersion && versionEl) versionEl.textContent = `v${payload.currentVersion}`;
  let title = t('footer.versionChecking') || '正在检查版本…';
  if (light === 'green') {
    title = t('footer.versionLatest', { version: payload.currentVersion || '' })
      || `已是最新版本 v${payload.currentVersion || ''}`;
  } else if (light === 'red') {
    title = t('footer.versionUpdateAvailable', {
      current: payload.currentVersion || '',
      version: payload.remoteVersion || '',
    }) || `有新版本 v${payload.remoteVersion}（当前 v${payload.currentVersion}），点击查看更新`;
  } else if (light === 'unknown') {
    title = payload?.error
      ? (t('footer.versionCheckFailed', { message: payload.error }) || `版本检查失败：${payload.error}`)
      : (t('footer.versionUnknown') || '无法判断是否为最新版本');
  }
  wrap.title = title;
  wrap.setAttribute('aria-label', title);
  wrap.classList.toggle('is-clickable', light === 'red');
  wrap.dataset.light = light;
  if (payload && (payload.upToDate != null || payload.remoteVersion || payload.supported != null)) {
    appUpdateState.result = {
      ...(appUpdateState.result || {}),
      ...payload,
      supported: payload.supported !== false,
      upToDate: payload.upToDate,
      currentVersion: payload.currentVersion,
      remoteVersion: payload.remoteVersion,
    };
    if (appUpdateState.status === 'idle' || appUpdateState.status === 'checking' || appUpdateState.status === 'ready') {
      if (payload.error && light === 'unknown') {
        /* keep settings card free unless user opened it */
      } else {
        appUpdateState.status = 'ready';
        appUpdateState.message = '';
      }
      renderAppUpdateState();
    }
  }
}

function openAppUpdatePanel() {
  try {
    switchView('system');
    const card = document.getElementById('app-update-card');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (_) {}
}


function renderAppUpdateState() {
  const status = document.getElementById('app-update-status');
  const version = document.getElementById('app-update-version');
  const check = document.getElementById('app-check-update');
  const download = document.getElementById('app-download-update');
  if (!status || !version || !check || !download) return;
  const result = appUpdateState.result;
  version.textContent = result?.remoteVersion ? `v${result.remoteVersion}` : '—';
  check.disabled = appUpdateState.status === 'checking' || appUpdateState.status === 'downloading';
  download.hidden = !(result && !result.upToDate && (result.canDownload !== false) && result.asset?.name && appUpdateState.status !== 'downloading');
  download.disabled = appUpdateState.status === 'checking' || appUpdateState.status === 'downloading';
  if (appUpdateState.message) {
    status.textContent = appUpdateState.message;
    return;
  }
  if (appUpdateState.status === 'checking') status.textContent = t('system.update.checking');
  else if (appUpdateState.status === 'downloading') {
    const progress = appUpdateState.progress;
    if (progress?.percent != null) status.textContent = t('system.update.downloadingPercent', { percent: progress.percent });
    else if (progress?.received && progress?.total) status.textContent = t('system.update.downloadingBytes', { received: formatBytes(progress.received), total: formatBytes(progress.total) });
    else status.textContent = t('system.update.downloading');
  }
  else if (result?.supported && result.upToDate) status.textContent = t('system.update.latest', { version: result.currentVersion });
  else if (result?.supported && !result.upToDate) status.textContent = t('system.update.available', { current: result.currentVersion, version: result.remoteVersion });
  else if (result && !result.supported) status.textContent = t('system.update.unsupported');
  else status.textContent = t('system.update.idle');
}

async function checkAppUpdate() {
  appUpdateState.status = 'checking'; appUpdateState.result = null; appUpdateState.message = ''; appUpdateState.progress = null;
  applyVersionTrafficLight({ light: 'checking', currentVersion: document.getElementById('app-version')?.textContent?.replace(/^v/i, '') });
  renderAppUpdateState();
  try {
    appUpdateState.result = await window.ops.checkAppUpdate();
    appUpdateState.status = 'ready';
    const result = appUpdateState.result || {};
    let light = result.light;
    if (result.upToDate === true) light = 'green';
    else if (result.upToDate === false && result.remoteVersion) light = 'red';
    else if (result.supported === false) light = 'unknown';
    else if (!light) light = result.remoteVersion ? (result.upToDate ? 'green' : 'red') : 'unknown';
    applyVersionTrafficLight({ ...result, light });
  } catch (error) {
    appUpdateState.status = 'error';
    appUpdateState.message = t('system.update.error', { message: error.message });
    applyVersionTrafficLight({ light: 'unknown', error: error.message });
  }
  renderAppUpdateState();
}

async function downloadAppUpdate() {
  appUpdateState.status = 'downloading'; appUpdateState.message = ''; appUpdateState.progress = null; renderAppUpdateState();
  try {
    const result = await window.ops.downloadAppUpdate();
    appUpdateState.status = 'ready';
    appUpdateState.message = result.upToDate
      ? t('system.update.latest', { version: result.version })
      : t('system.update.downloaded', { path: result.path });
  } catch (error) {
    appUpdateState.status = 'error';
    appUpdateState.message = t('system.update.error', { message: error.message });
  }
  renderAppUpdateState();
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

document.getElementById('github-link')?.addEventListener('click', async (event) => {
  event.preventDefault();
  try { await window.ops.openGithub(); } catch (error) { toast(error.message); }
});
document.getElementById('app-version-wrap')?.addEventListener('click', () => {
  const light = document.getElementById('app-version-wrap')?.dataset?.light;
  if (light === 'red') openAppUpdatePanel();
  else checkAppUpdate();
});
document.getElementById('app-check-update')?.addEventListener('click', () => checkAppUpdate());
document.getElementById('app-download-update')?.addEventListener('click', () => downloadAppUpdate());

function afterUiRender(root) {
  try { window.OpenBrowserI18n?.applyDom?.(root || document); } catch (_) {}
}

function refreshLocaleChrome() {
  const i18n = window.OpenBrowserI18n;
  if (!i18n) return;
  i18n.applyDom(document);
  const select = document.getElementById('ui-locale-select');
  if (select) {
    i18n.fillLocaleSelect(select);
    select.value = i18n.getPreference();
  }
  const badge = document.getElementById('ui-locale-badge');
  if (badge) {
    const pref = i18n.getPreference();
    badge.textContent = pref === 'system' ? 'System' : i18n.getLocale();
  }
  const current = document.getElementById('ui-locale-current');
  if (current) {
    const label = i18n.SUPPORTED.find((item) => item.code === i18n.getLocale())?.label || i18n.getLocale();
    current.textContent = t('system.locale.current', { lang: label });
  }
  // Keep browser language pickers complete (en/zh/ja/vi/fr/de/th/id + …)
  i18n.fillBrowserLanguageSelect?.(document.getElementById('editor-language'));
  i18n.fillBrowserLanguageSelect?.(document.getElementById('profile-create-language'));
  i18n.fillBrowserLanguageSelect?.(document.getElementById('batch-add-language'));
  const modeSelect = document.getElementById('editor-language-mode');
  if (modeSelect) {
    const prev = modeSelect.value || 'ip';
    i18n.fillBrowserLanguageSelect(modeSelect, { includeModes: true });
    if ([...modeSelect.options].some((o) => o.value === prev)) modeSelect.value = prev;
    else modeSelect.value = 'ip';
  }
  if (typeof syncThemedSelects === 'function') syncThemedSelects();
  if (typeof refreshIcons === 'function') refreshIcons();
  renderAppUpdateState();
}

function applyPlatformClass() {
  const raw = navigator.userAgentData?.platform || navigator.platform || '';
  const platform = /mac/i.test(raw) ? 'macos' : /win/i.test(raw) ? 'windows' : 'other';
  document.documentElement.dataset.platform = platform;
  // Shipping-app fused title bar (hiddenInset / titleBarOverlay)
  const integrated = platform === 'macos' || platform === 'windows';
  document.documentElement.dataset.titlebar = integrated ? 'integrated' : 'default';
  document.documentElement.classList.toggle('titlebar-integrated', integrated);
}

function refreshIcons() {
  if (!window.lucide?.createIcons) return;
  try {
    // UMD build: icons live on lucide.icons (not the root export bag)
    const icons = window.lucide.icons;
    if (!icons || !Object.keys(icons).length) {
      console.warn('Lucide icons map is empty');
      return;
    }
    window.lucide.createIcons({
      icons,
      attrs: {
        'aria-hidden': 'true',
        'stroke-width': '1.75',
        stroke: 'currentColor',
        fill: 'none',
      },
    });
  } catch (error) {
    console.warn('Lucide icons failed to render:', error?.message || error);
  }
}

applyPlatformClass();
refreshIcons();

function createGroupId() {
  return 'grp-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function defaultGroups() {
  return [
    { id: 'grp-default', name: t('groups.default'), color: '#245cff', note: '', sort: 0, createdAt: new Date().toISOString() },
  ];
}

const defaultProfiles = () => [
  { id: 'env-001', number: 1, name: '1', browser: 'Google Chrome', language: 'zh-CN', networkMode: 'direct', proxy: 'Direct', tag: '', groupId: 'grp-default', os: 'Windows', location: 'Local' },
];

function positiveProfileNumber(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function normalizeProfileSettings(profile) {
  const value = profile && typeof profile === 'object' ? profile : {};
  const privacy = value.privacy && typeof value.privacy === 'object' ? value.privacy : {};
  const advanced = value.advanced && typeof value.advanced === 'object' ? value.advanced : {};
  const proxyMeta = value.proxyMeta && typeof value.proxyMeta === 'object' ? value.proxyMeta : {};
  const platform = value.platform && typeof value.platform === 'object' ? value.platform : {};
  const number = positiveProfileNumber(value.number);
  const rawProxy = String(value.proxy || '').trim();
  const legacyDemoProxy = value.networkMode == null && value.id === 'env-004' && rawProxy === '127.0.0.1:7890';
  const networkMode = value.networkMode === 'direct' || legacyDemoProxy || !rawProxy || /^(direct|offline|none)$/i.test(rawProxy)
    ? 'direct'
    : 'proxy';
  return {
    ...value,
    number,
    name: number ? String(number) : String(value.name || ''),
    title: String(value.title || value.displayName || ''),
    browser: 'Google Chrome',
    os: String(value.os || 'Windows'),
    language: String(value.language || 'en-US'),
    networkMode,
    proxy: networkMode === 'direct' ? 'Direct' : rawProxy,
    userAgent: String(value.userAgent || ''),
    cookies: String(value.cookies || ''),
    note: String(value.note || ''),
    tag: String(value.tag || ''),
    groupId: value.groupId == null || value.groupId === undefined ? UNGROUPED_ID : String(value.groupId || ''),
    width: Number(value.width) >= 640 ? Number(value.width) : 1280,
    height: Number(value.height) >= 480 ? Number(value.height) : 820,
    platform: {
      type: String(platform.type || 'other'),
      startUrl: String(platform.startUrl || value.startUrl || ''),
      username: String(platform.username || ''),
      password: String(platform.password || ''),
      totpSecret: String(platform.totpSecret || platform.otp || ''),
    },
    proxyMeta: {
      ipChannel: String(proxyMeta.ipChannel || 'ip-api'),
      refreshUrl: String(proxyMeta.refreshUrl || ''),
      checkOnStart: Boolean(proxyMeta.checkOnStart),
      refreshOnStart: Boolean(proxyMeta.refreshOnStart),
      systemProxy: String(proxyMeta.systemProxy || 'global'),
      directBypass: Boolean(proxyMeta.directBypass),
      bypassList: String(proxyMeta.bypassList || ''),
      apiExtractUrl: String(proxyMeta.apiExtractUrl || ''),
      backupProxies: Array.isArray(proxyMeta.backupProxies)
        ? proxyMeta.backupProxies.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
        : String(proxyMeta.backupProxies || '').split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8),
      fillFingerprint: proxyMeta.fillFingerprint !== false,
      requireReady: proxyMeta.requireReady !== false,
      notReadyPolicy: ['block', 'direct', 'continue'].includes(String(proxyMeta.notReadyPolicy || ''))
        ? String(proxyMeta.notReadyPolicy)
        : (proxyMeta.requireReady === false ? 'continue' : 'block'),
      tlsProfile: ['auto', 'chrome', 'chrome_legacy', 'node', 'off'].includes(String(proxyMeta.tlsProfile || ''))
        ? String(proxyMeta.tlsProfile)
        : 'auto',
      tlsChromeMajor: (() => {
        const n = Number(proxyMeta.tlsChromeMajor);
        return Number.isFinite(n) && n >= 80 && n <= 200 ? Math.floor(n) : null;
      })(),
    },
    privacy: {
      webrtc: String(privacy.webrtc || 'proxy'),
      timezoneMode: String(privacy.timezoneMode || 'ip'),
      timezone: String(privacy.timezone || ''),
      geoMode: String(privacy.geoMode || 'ip'),
      latitude: privacy.latitude ?? '',
      longitude: privacy.longitude ?? '',
      accuracy: Number(privacy.accuracy) || 100,
      uiLanguage: String(privacy.uiLanguage || 'profile'),
      languageMode: String(privacy.languageMode || (privacy.langFromIp !== false ? 'ip' : (privacy.uiLanguage && privacy.uiLanguage !== 'profile' ? privacy.uiLanguage : 'ip'))),
      langFromIp: privacy.langFromIp !== false,
      timezoneFromIp: privacy.timezoneFromIp !== false,
      geoFromIp: privacy.geoFromIp !== false,
      fontMode: String(privacy.fontMode || 'default'),
      fontSize: Number(privacy.fontSize) || 16,
      canvas: String(privacy.canvas || 'noise'),
      webgl: String(privacy.webgl || 'noise'),
      webglMeta: String(privacy.webglMeta || 'noise'),
      webgpu: String(privacy.webgpu || 'webgl'),
      audio: String(privacy.audio || 'noise'),
      media: String(privacy.media || 'noise'),
      mediaDevices: String(privacy.mediaDevices || ''),
      mediaLabels: privacy.mediaLabels && typeof privacy.mediaLabels === 'object' ? {
        audioinput: String(privacy.mediaLabels.audioinput || privacy.mediaLabels.input || '').slice(0, 200),
        videoinput: String(privacy.mediaLabels.videoinput || privacy.mediaLabels.video || '').slice(0, 200),
        audiooutput: String(privacy.mediaLabels.audiooutput || privacy.mediaLabels.output || '').slice(0, 200),
      } : { audioinput: '', videoinput: '', audiooutput: '' },
      battery: String(privacy.battery || 'noise'),
      clientRects: String(privacy.clientRects || 'noise'),
      speech: String(privacy.speech || 'noise'),
      deviceNameMode: String(privacy.deviceNameMode || 'noise'),
      deviceName: String(privacy.deviceName || ''),
      dnt: Boolean(privacy.dnt),
      dntMode: String(privacy.dntMode || (privacy.dnt ? 'on' : 'default')),
      portScanProtect: Boolean(privacy.portScanProtect),
      portScanAllow: String(privacy.portScanAllow || ''),
      cfOptimize: privacy.cfOptimize !== false,
      refreshFingerprintOnStart: Boolean(privacy.refreshFingerprintOnStart),
      stabilityMode: ['off', 'auto', 'force'].includes(String(privacy.stabilityMode || ''))
        ? String(privacy.stabilityMode)
        : 'auto',
      stabilityHamming: Math.min(64, Math.max(1, Number(privacy.stabilityHamming) || 12)),
      stabilityMaxWidth: Math.min(4096, Math.max(64, Number(privacy.stabilityMaxWidth) || 600)),
      stabilityMaxHeight: Math.min(4096, Math.max(64, Number(privacy.stabilityMaxHeight) || 600)),
      stabilitySquare: Math.min(64, Math.max(2, Number(privacy.stabilitySquare) || 8)),
      stabilityHosts: Array.isArray(privacy.stabilityHosts)
        ? privacy.stabilityHosts.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 800)
        : String(privacy.stabilityHosts || '').split(/[\r\n,;\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 800),
      stabilitySkipHosts: Array.isArray(privacy.stabilitySkipHosts)
        ? privacy.stabilitySkipHosts.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 200)
        : String(privacy.stabilitySkipHosts || '').split(/[\r\n,;\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 200),
      // Preserve 0 (= 真实). Empty = 自动. Never use `||` which turns 0 into 自动.
      cores: (() => {
        const raw = privacy.cores ?? privacy.fingerprint?.cores;
        if (raw === '' || raw === null || raw === undefined) return '';
        const n = Number(raw);
        return Number.isFinite(n) ? n : '';
      })(),
      memory: (() => {
        const raw = privacy.memory ?? privacy.fingerprint?.memory;
        if (raw === '' || raw === null || raw === undefined) return '';
        const n = Number(raw);
        return Number.isFinite(n) ? n : '';
      })(),
      fingerprint: privacy.fingerprint && typeof privacy.fingerprint === 'object' ? {
        ...privacy.fingerprint,
        cores: (() => {
          const raw = privacy.cores ?? privacy.fingerprint?.cores;
          if (raw === '' || raw === null || raw === undefined) return privacy.fingerprint.cores ?? null;
          const n = Number(raw);
          return Number.isFinite(n) ? n : (privacy.fingerprint.cores ?? null);
        })(),
        memory: (() => {
          const raw = privacy.memory ?? privacy.fingerprint?.memory;
          if (raw === '' || raw === null || raw === undefined) return privacy.fingerprint.memory ?? null;
          const n = Number(raw);
          return Number.isFinite(n) ? n : (privacy.fingerprint.memory ?? null);
        })(),
      } : {},
    },
    advanced: {
      saveCookies: advanced.saveCookies !== false,
      savePasswords: Boolean(advanced.savePasswords),
      saveBookmarks: advanced.saveBookmarks !== false,
      saveLocalStorage: advanced.saveLocalStorage !== false,
      saveIndexedDB: advanced.saveIndexedDB !== false,
      saveHistory: advanced.saveHistory !== false,
      allowSignin: Boolean(advanced.allowSignin),
      restoreSession: Boolean(advanced.restoreSession) || advanced.tabMode === 'restore',
      blockVideo: Boolean(advanced.blockVideo),
      blockImages: Boolean(advanced.blockImages),
      clearCacheOnStart: Boolean(advanced.clearCacheOnStart),
      cloudBackup: Boolean(advanced.cloudBackup),
      syncCookiesOnClose: advanced.syncCookiesOnClose !== false,
      syncIndexedDB: Boolean(advanced.syncIndexedDB),
      syncLocalStorage: Boolean(advanced.syncLocalStorage),
      syncPasswords: Boolean(advanced.syncPasswords),
      syncExtensionData: Boolean(advanced.syncExtensionData),
      multiOpen: Boolean(advanced.multiOpen),
      tabMode: String(advanced.tabMode || (advanced.restoreSession ? 'restore' : 'fixed')),
      startUrls: String(advanced.startUrls || ''),
      blockUrls: String(advanced.blockUrls || ''),
      blockSound: Boolean(advanced.blockSound),
      blockPasswordPrompt: Boolean(advanced.blockPasswordPrompt),
      blockRestoreDialog: advanced.blockRestoreDialog !== false,
      blockNotifications: advanced.blockNotifications !== false,
      blockPopups: Boolean(advanced.blockPopups),
      jsHeapMax: Boolean(advanced.jsHeapMax),
      showInfoPage: advanced.showInfoPage !== false,
      showPasswordOnInfo: Boolean(advanced.showPasswordOnInfo),
      loadGlobalBookmarks: Boolean(advanced.loadGlobalBookmarks),
      showBookmarkBar: Boolean(advanced.showBookmarkBar),
      uploadBookmarks: Boolean(advanced.uploadBookmarks),
    },
  };
}

function loadUi() {
  try {
    const value = JSON.parse(localStorage.getItem(UI_KEY));
    if (value && Array.isArray(value.profiles)) return value;
  } catch (_) {}
  return { profiles: defaultProfiles(), groups: defaultGroups(), logs: [] };
}

function normalizeGroup(raw, index = 0) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const id = String(value.id || createGroupId()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || createGroupId();
  const savedColor = String(value.color || '').trim();
  const color = /^#[0-9a-fA-F]{6}$/.test(savedColor)
    ? savedColor.toUpperCase()
    : GROUP_COLORS[index % GROUP_COLORS.length];
  return {
    id,
    name: String(value.name || t('groups.unnamed')).trim().slice(0, 40) || t('groups.unnamed'),
    color,
    note: String(value.note || '').slice(0, 200),
    sort: Number.isFinite(Number(value.sort)) ? Number(value.sort) : index,
    createdAt: value.createdAt || new Date().toISOString(),
  };
}

function migrateGroups(rawGroups, profiles) {
  let groups = Array.isArray(rawGroups) ? rawGroups.map((g, i) => normalizeGroup(g, i)) : [];
  if (!groups.length) groups = defaultGroups();
  // Ensure unique ids
  const seen = new Set();
  groups = groups.filter((g) => {
    if (seen.has(g.id)) return false;
    seen.add(g.id);
    return true;
  });
  const validIds = new Set(groups.map((g) => g.id));
  // Legacy: profiles may have group_name without groupId
  for (const profile of profiles) {
    if (profile.groupId && validIds.has(profile.groupId)) continue;
    const legacyName = String(profile.group_name || profile.groupName || '').trim();
    if (legacyName) {
      let found = groups.find((g) => g.name === legacyName);
      if (!found) {
        found = normalizeGroup({ id: createGroupId(), name: legacyName, color: GROUP_COLORS[groups.length % GROUP_COLORS.length] }, groups.length);
        groups.push(found);
        validIds.add(found.id);
      }
      profile.groupId = found.id;
    } else if (profile.groupId && !validIds.has(profile.groupId)) {
      profile.groupId = UNGROUPED_ID;
    } else if (profile.groupId == null) {
      profile.groupId = UNGROUPED_ID;
    }
  }
  groups.sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name, 'zh'));
  return groups;
}

function migrateProfileNumbers(profiles, savedNextNumber) {
  const used = new Set(); let cursor = 1;
  const migrated = profiles.map((profile) => {
    let number = positiveProfileNumber(profile?.number);
    if (!number || used.has(number)) { while (used.has(cursor)) cursor += 1; number = cursor; }
    used.add(number); cursor = Math.max(cursor, number + 1);
    return normalizeProfileSettings({ ...profile, number, name: String(number) });
  });
  const maximum = used.size ? Math.max(...used) : 0;
  return { profiles: migrated, nextProfileNumber: Math.max(positiveProfileNumber(savedNextNumber), maximum + 1, 1) };
}

const loadedUi = loadUi();
const migratedUi = migrateProfileNumbers(loadedUi.profiles, loadedUi.nextProfileNumber);
const migratedGroups = migrateGroups(loadedUi.groups, migratedUi.profiles);
let ui = { ...loadedUi, ...migratedUi, groups: migratedGroups };
// Immediate migration: purge secrets from any older localStorage dumps.
try {
  localStorage.setItem(UI_KEY, JSON.stringify({
    ...ui,
    profiles: (ui.profiles || []).map((item) => redactProfileForStorage(item)),
  }));
} catch (_) {}

let activeGroupFilter = 'all'; // 'all' | 'ungrouped' | groupId

function listGroups() {
  return [...(ui.groups || [])].sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name, 'zh'));
}

function findGroup(id) {
  if (!id) return null;
  return listGroups().find((g) => g.id === id) || null;
}

function localizeSystemLabel(name) {
  const n = String(name || '').trim();
  if (!n) return n;
  // Prefer full UI phrase map (covers 主控/工作组/代理/默认分组/…)
  if (window.OpenBrowserI18n?.translateChineseUiText) {
    const translated = window.OpenBrowserI18n.translateChineseUiText(n);
    if (translated && translated !== n) return translated;
  }
  if (n === '未分组' || n === 'Ungrouped') return t('groups.ungrouped');
  if (n === '默认分组' || n === 'Default group') return t('groups.default');
  if (n === '全部' || n === 'All') return t('groups.all');
  if (n === '全部分组' || n === 'All groups') return t('groups.allGroups');
  if (n === '主控' || n === 'Master') return t('tag.master');
  if (n === '工作组' || n === 'Workgroup') return t('tag.workgroup');
  if (n === '代理' || n === 'Proxy') return t('tag.proxy');
  return n;
}

function groupNameOf(profile) {
  const g = findGroup(profile?.groupId);
  return g ? localizeSystemLabel(g.name) : t('groups.ungrouped');
}

/** Raw stored group name (for data), not display-localized */
function groupNameRaw(profile) {
  const g = findGroup(profile?.groupId);
  return g ? g.name : '';
}

function groupColorOf(profile) {
  const g = findGroup(profile?.groupId);
  return g ? g.color : '#6b7280';
}

function countProfilesInGroup(groupId) {
  if (groupId === 'ungrouped' || groupId === UNGROUPED_ID) {
    return ui.profiles.filter((p) => !p.groupId).length;
  }
  return ui.profiles.filter((p) => p.groupId === groupId).length;
}

function fillGroupSelect(selectEl, selectedId = '', { includeAll = false, includeUngrouped = true } = {}) {
  if (!selectEl) return;
  selectEl.replaceChildren();
  if (includeAll) {
    const opt = document.createElement('option');
    opt.value = 'all';
    opt.textContent = t('groups.allGroups');
    selectEl.append(opt);
  }
  if (includeUngrouped) {
    const opt = document.createElement('option');
    opt.value = UNGROUPED_ID;
    opt.textContent = t('groups.ungrouped');
    selectEl.append(opt);
  }
  for (const g of listGroups()) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = localizeSystemLabel(g.name);
    selectEl.append(opt);
  }
  if (selectedId === 'all' && includeAll) selectEl.value = 'all';
  else if (selectedId && [...selectEl.options].some((o) => o.value === selectedId)) selectEl.value = selectedId;
  else if (includeUngrouped) selectEl.value = UNGROUPED_ID;
}

function displayProfileNumber(profile) {
  return String(positiveProfileNumber(profile?.number) || profile?.name || profile?.id || '');
}

/** Env identity colors (not Chrome branding) */
const ENV_ICON_PALETTE = [
  ['#2563eb', '#1d4ed8'],
  ['#7c3aed', '#5b21b6'],
  ['#db2777', '#9d174d'],
  ['#ea580c', '#c2410c'],
  ['#059669', '#047857'],
  ['#0891b2', '#0e7490'],
  ['#4f46e5', '#3730a3'],
  ['#ca8a04', '#a16207'],
  ['#0d9488', '#0f766e'],
  ['#e11d48', '#be123c'],
];

function envBadgeColors(profileOrNumber) {
  const n = typeof profileOrNumber === 'object'
    ? positiveProfileNumber(profileOrNumber?.number) || 0
    : Number(profileOrNumber) || 0;
  return ENV_ICON_PALETTE[Math.abs(n) % ENV_ICON_PALETTE.length];
}

/** Shared square mark size — matches 环境管理 env-badge (CSS --ui-mark-size). */
const UI_MARK_SIZE = 34;

function hashHue(text) {
  const s = String(text || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function markGradientFromColor(color) {
  const raw = String(color || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
    const r = parseInt(raw.slice(1, 3), 16);
    const g = parseInt(raw.slice(3, 5), 16);
    const b = parseInt(raw.slice(5, 7), 16);
    const d = (n) => Math.max(0, Math.min(255, Math.round(n * 0.72)));
    return `linear-gradient(145deg, ${raw}, rgb(${d(r)}, ${d(g)}, ${d(b)}))`;
  }
  const hue = hashHue(raw || 'mark');
  return `linear-gradient(145deg, hsl(${hue} 72% 52%), hsl(${hue} 68% 38%))`;
}

/** Colored square badge (env / group / proxy / extension) — same visual language */
function buildSquareMark(label, { color, title, size = UI_MARK_SIZE, className = '' } = {}) {
  const badge = document.createElement('div');
  badge.className = ('env-badge ui-mark ' + (className || '')).trim();
  badge.style.width = size + 'px';
  badge.style.height = size + 'px';
  badge.style.background = markGradientFromColor(color || label);
  if (title) badge.title = title;
  const num = document.createElement('span');
  num.className = 'env-badge-num';
  const text = String(label ?? '').trim() || '?';
  num.textContent = text;
  if (text.length >= 3) num.classList.add('env-badge-num-sm');
  if (text.length >= 4) num.classList.add('env-badge-num-xs');
  badge.append(num);
  return badge;
}

/** Colored square badge with environment number — replaces Chrome icon usage in UI */
function buildEnvBadge(profile, size = UI_MARK_SIZE) {
  const n = displayProfileNumber(profile);
  const [c1, c2] = envBadgeColors(profile);
  const badge = document.createElement('div');
  badge.className = 'env-badge ui-mark';
  badge.style.width = size + 'px';
  badge.style.height = size + 'px';
  badge.style.background = `linear-gradient(145deg, ${c1}, ${c2})`;
  badge.title = t('profiles.envName', { n });
  const num = document.createElement('span');
  num.className = 'env-badge-num';
  num.textContent = n;
  if (String(n).length >= 3) num.classList.add('env-badge-num-sm');
  if (String(n).length >= 4) num.classList.add('env-badge-num-xs');
  badge.append(num);
  return badge;
}

function buildEnvIdentity(profile) {
  const n = displayProfileNumber(profile);
  const box = document.createElement('div');
  box.className = 'profile-name env-identity';
  box.append(buildEnvBadge(profile, UI_MARK_SIZE));
  const text = document.createElement('div');
  text.className = 'env-identity-text';
  const titleText = (profile.title && String(profile.title).trim() && String(profile.title) !== String(n))
    ? String(profile.title).trim()
    : t('profiles.envName', { n });
  text.append(element('strong', '', titleText));
  const sub = (profile.tag ? localizeSystemLabel(profile.tag) : '')
    || (profile.platform?.startUrl ? String(profile.platform.startUrl).slice(0, 42) : '')
    || (profile.platform?.type && profile.platform.type !== 'other' ? String(profile.platform.type) : '')
    || t('profiles.envName', { n });
  text.append(element('small', '', sub));
  box.append(text);
  return box;
}

function buildEnvBrowserCell(profile) {
  // App-icon style: env number square mark (never Chrome brand icon/text)
  const wrap = document.createElement('div');
  wrap.className = 'env-browser-cell env-browser-cell-app';
  const n = displayProfileNumber(profile);
  wrap.append(buildEnvBadge(profile, UI_MARK_SIZE));
  const label = document.createElement('div');
  label.className = 'env-browser-label';
  label.append(element('strong', '', t('profiles.envName', { n })));
  const kernel = String(profile.browser || '').replace(/^Google\s+/i, '').trim();
  // Neutral kernel label — avoid "Chrome" product branding in list
  let kernelLabel = t('profiles.kernel.independent');
  if (/edge/i.test(kernel)) kernelLabel = t('profiles.kernel.edge');
  else if (/chromium|wayfern|donut|testing/i.test(kernel)) kernelLabel = t('profiles.kernel.independent');
  else if (kernel && !/chrome/i.test(kernel)) kernelLabel = kernel.slice(0, 12);
  label.append(element('small', '', kernelLabel));
  wrap.append(label);
  wrap.title = t('profiles.envName', { n }) + ' · ' + kernelLabel;
  return wrap;
}

function nextProfileNumber() {
  const maximum = ui.profiles.reduce((value, profile) => Math.max(value, positiveProfileNumber(profile.number)), 0);
  return Math.max(positiveProfileNumber(ui.nextProfileNumber), maximum + 1, 1);
}

function createInternalProfileId(number, usedIds = new Set(ui.profiles.map((profile) => profile.id))) {
  const base = 'env-' + String(number).padStart(3, '0'); if (!usedIds.has(base)) return base;
  let suffix = 2; while (usedIds.has(base + '-' + suffix)) suffix += 1; return base + '-' + suffix;
}

let engineProfiles = [];
let extensions = [];
let appCenterTab = 'builtin';
let appCenterData = { builtin: [], recommended: [], local: [], counts: {} };
let sessions = [];
let sessionsInitialized = false;
let preferredMasterId = null;
let syncHealth = { queueDepth: 0, coalesced: 0, dropped: 0, lastLatencyMs: 0, recovering: false };
let selectedProfiles = new Set();
/** @type {Map<string, {phase:string, percent:number, message:string, updatedAt:number}>} */
const startingProfiles = new Map();
const START_PROGRESS_PHASES = {
  prepare: 6,
  proxy: 18,
  kernel: 30,
  configure: 48,
  spawn: 62,
  cdp: 76,
  inject: 88,
  ready: 100,
};
let selectedSessions = new Set();
let currentExtension = null;
let syncState = { active: false, master: null, selected: [] };
const SYNC_SETTINGS_KEY = 'openbrowser-sync-settings-v13';
const DEFAULT_SYNC_SETTINGS = Object.freeze({ keyboard: true, click: true, scroll: true, track: true, delayClick: false, delayInput: false, inputMinMs: 300, inputMaxMs: 300, clickMinMs: 100, clickMaxMs: 300 });
function normalizeSyncSettings(value = {}) {
  const number = (name, fallback) => Math.max(0, Math.min(5000, Number(value[name] ?? fallback) || 0));
  const result = { ...DEFAULT_SYNC_SETTINGS, ...value };
  for (const name of ['keyboard', 'click', 'scroll', 'track', 'delayClick', 'delayInput']) result[name] = value[name] === undefined ? DEFAULT_SYNC_SETTINGS[name] : value[name] !== false;
  result.inputMinMs = number('inputMinMs', 300); result.inputMaxMs = Math.max(result.inputMinMs, number('inputMaxMs', result.inputMinMs));
  result.clickMinMs = number('clickMinMs', 100); result.clickMaxMs = Math.max(result.clickMinMs, number('clickMaxMs', result.clickMinMs));
  return result;
}
let syncSettings = (() => { try { return normalizeSyncSettings(JSON.parse(localStorage.getItem(SYNC_SETTINGS_KEY) || '{}')); } catch (_) { return { ...DEFAULT_SYNC_SETTINGS }; } })();
let pendingDeleteProfiles = [];
let editingProfileId = null;
let editorNetworkResult = null;
let toastTimer = null;
const PROFILE_PAGE_SIZES = [10, 20, 50, 100];
const PROFILE_PAGE_SIZE_KEY = 'openbrowser-profile-page-size-v1';
let profilePage = 1;
let profilePageSize = 10;
try {
  const savedProfilePageSize = Number(localStorage.getItem(PROFILE_PAGE_SIZE_KEY));
  if (PROFILE_PAGE_SIZES.includes(savedProfilePageSize)) profilePageSize = savedProfilePageSize;
} catch (_) {}

const SPECIFIED_TEXT_GROUPS_KEY = 'openbrowser-specified-text-groups-v1';
const SPECIFIED_TEXT_GROUP_LIMIT = 20;
let specifiedTextGroupSerial = 0;

function createSpecifiedTextGroup(index = 0) {
  specifiedTextGroupSerial += 1;
  return { id: 'text-group-' + Date.now().toString(36) + '-' + specifiedTextGroupSerial, mode: 'sequence', text: '', cursor: 0, index };
}

function normalizeSpecifiedTextGroups(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, SPECIFIED_TEXT_GROUP_LIMIT).map((group, index) => {
    const source = group && typeof group === 'object' ? group : {};
    const fallback = createSpecifiedTextGroup(index);
    const id = String(source.id || fallback.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || fallback.id;
    return { id, mode: source.mode === 'random' ? 'random' : 'sequence', text: String(source.text || '').slice(0, 500000), cursor: Math.max(0, Number.parseInt(source.cursor, 10) || 0), index };
  });
}

function loadSpecifiedTextGroups() {
  try {
    const groups = normalizeSpecifiedTextGroups(JSON.parse(localStorage.getItem(SPECIFIED_TEXT_GROUPS_KEY) || '[]'));
    if (groups.length) return groups;
  } catch (_) {}
  return [createSpecifiedTextGroup(0)];
}

let specifiedTextGroups = loadSpecifiedTextGroups();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const element = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
function redactProxyForStorage(proxy) {
  const raw = String(proxy || '').trim();
  if (!raw || /^(direct|offline|none)$/i.test(raw)) return raw || 'Direct';
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      const parsed = new URL(raw);
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
  } catch (_) {}
  const parts = raw.split(':');
  // host:port:user:pass → host:port only
  if (parts.length >= 4) return `${parts[0]}:${parts[1]}`;
  return raw;
}

function redactProfileForStorage(profile) {
  const value = normalizeProfileSettings(profile);
  return {
    ...value,
    cookies: '',
    proxy: redactProxyForStorage(value.proxy),
    platform: {
      ...(value.platform || {}),
      password: '',
      totpSecret: '',
    },
  };
}

const save = () => {
  if (!Array.isArray(ui.groups)) ui.groups = defaultGroups();
  try {
    // Never persist cookies / platform secrets / proxy passwords in renderer localStorage.
    // Secrets stay in main-process engine state (openbrowser-engine.json).
    const safe = {
      ...ui,
      profiles: (ui.profiles || []).map((item) => redactProfileForStorage(item)),
    };
    localStorage.setItem(UI_KEY, JSON.stringify(safe));
  } catch (_) {}
};
function textDelayRange() { return syncSettings.delayInput ? [syncSettings.inputMinMs / 1000, syncSettings.inputMaxMs / 1000] : [0, 0]; }
function fillSyncSettingsForm() {
  const checks = { '#settings-sync-keyboard': 'keyboard', '#settings-sync-click': 'click', '#settings-sync-scroll': 'scroll', '#settings-sync-track': 'track', '#settings-delay-click': 'delayClick', '#settings-delay-input': 'delayInput' };
  for (const [selector, name] of Object.entries(checks)) { const input = $(selector); if (input) input.checked = Boolean(syncSettings[name]); }
  const values = { '#settings-input-min': 'inputMinMs', '#settings-input-max': 'inputMaxMs', '#settings-click-min': 'clickMinMs', '#settings-click-max': 'clickMaxMs' };
  for (const [selector, name] of Object.entries(values)) { const input = $(selector); if (input) input.value = syncSettings[name]; }
  if ($('#delay-input')) $('#delay-input').checked = syncSettings.delayInput;
  if ($('#delay-click')) $('#delay-click').checked = syncSettings.delayClick;
}
function syncSettingsFromForm() {
  return normalizeSyncSettings({ keyboard: $('#settings-sync-keyboard').checked, click: $('#settings-sync-click').checked, scroll: $('#settings-sync-scroll').checked, track: $('#settings-sync-track').checked, delayClick: $('#settings-delay-click').checked, delayInput: $('#settings-delay-input').checked, inputMinMs: $('#settings-input-min').value, inputMaxMs: $('#settings-input-max').value, clickMinMs: $('#settings-click-min').value, clickMaxMs: $('#settings-click-max').value });
}
async function applySyncSettings(value, announce = false) {
  syncSettings = normalizeSyncSettings(value); localStorage.setItem(SYNC_SETTINGS_KEY, JSON.stringify(syncSettings)); fillSyncSettingsForm();
  await window.ops.setSyncSettings(syncSettings);
  if (announce) toast('\u540c\u6b65\u8bbe\u7f6e\u5df2\u4fdd\u5b58\uff0c\u9f20\u6807\u548c\u952e\u76d8\u5f00\u5173\u5df2\u7acb\u5373\u751f\u6548');
}
const UI_THEME_KEY = 'openbrowser-ui-skin-v1';
const UI_COLOR_MODE_KEY = 'openbrowser-ui-color-mode-v1';
const UI_THEMES = Object.freeze({
  'retro-desktop': { nameKey: 'theme.retro.name', colorScheme: 'light' },
  'pixel-workstation': { nameKey: 'theme.pixel.name', colorScheme: 'dark' },
  'nes-light': { nameKey: 'theme.nes.name', colorScheme: 'light' },
  'element-admin': { nameKey: 'theme.native.name', colorScheme: 'light', supportsColorMode: true },
});

function themeDisplayName(theme) {
  const def = UI_THEMES[theme];
  return def?.nameKey ? t(def.nameKey) : theme;
}

let openSelectMenu = null;
let themedSelectId = 0;

function closeSelectMenu({ restoreFocus = false } = {}) {
  if (!openSelectMenu) return;
  const { button, menu } = openSelectMenu;
  menu.remove();
  button.classList.remove('open');
  button.setAttribute('aria-expanded', 'false');
  openSelectMenu = null;
  if (restoreFocus) button.focus();
}

function selectLabel(select) {
  const option = select.selectedOptions?.[0] || select.options[select.selectedIndex];
  return option?.textContent?.trim() || t('common.select');
}

function moveSelectMenuFocus(menu, key, fallbackIndex = null) {
  const enabled = [...menu.querySelectorAll('.themed-select-option:not(:disabled)')];
  if (!enabled.length) return;
  const focused = enabled.indexOf(document.activeElement);
  const fallback = Number.isInteger(fallbackIndex)
    ? enabled.findIndex((item) => Number(item.dataset.optionIndex) === fallbackIndex)
    : -1;
  const current = focused >= 0 ? focused : Math.max(0, fallback);
  let next = current;
  if (key === 'ArrowDown') next = (current + 1) % enabled.length;
  else if (key === 'ArrowUp') next = (current - 1 + enabled.length) % enabled.length;
  else if (key === 'Home') next = 0;
  else if (key === 'End') next = enabled.length - 1;
  enabled[next]?.focus({ preventScroll: true });
  enabled[next]?.scrollIntoView({ block: 'nearest' });
}

function syncThemedSelect(select) {
  const wrap = select.closest('.themed-select');
  if (!wrap) return;
  const button = wrap.querySelector('.themed-select-button');
  if (!button) return;
  button.querySelector('.themed-select-value').textContent = selectLabel(select);
  button.disabled = select.disabled;
  button.setAttribute('aria-label', select.getAttribute('aria-label') || select.labels?.[0]?.textContent?.trim() || selectLabel(select));
  if (openSelectMenu?.select === select) {
    const focusedIndex = Number(openSelectMenu.menu.querySelector(':focus')?.dataset.optionIndex);
    openThemedSelect(select, button, Number.isInteger(focusedIndex) ? focusedIndex : null);
  }
}

function positionSelectMenu(menu, button) {
  const rect = button.getBoundingClientRect();
  const gap = 4;
  const viewportPadding = 8;
  const menuWidth = Math.min(
    Math.max(rect.width, 160),
    window.innerWidth - viewportPadding * 2
  );
  const menuLeft = Math.min(
    Math.max(rect.left, viewportPadding),
    window.innerWidth - menuWidth - viewportPadding
  );
  const availableBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
  const availableAbove = rect.top - gap - viewportPadding;
  // Prefer below; flip only when below is clearly too tight and above is better
  const openAbove = availableBelow < 160 && availableAbove > availableBelow;
  const space = Math.max(0, openAbove ? availableAbove : availableBelow);
  // Long option lists need real height — allow up to ~half viewport
  const maxHeight = Math.max(120, Math.min(Math.floor(window.innerHeight * 0.5), Math.max(space, 160), 420));
  menu.style.position = 'fixed';
  menu.style.zIndex = '2147483000';
  menu.style.left = `${menuLeft}px`;
  menu.style.width = `${menuWidth}px`;
  menu.style.maxHeight = `${maxHeight}px`;
  menu.style.overflowY = 'auto';
  menu.style.overflowX = 'hidden';
  if (openAbove) {
    menu.style.top = 'auto';
    menu.style.bottom = `${Math.max(viewportPadding, window.innerHeight - rect.top + gap)}px`;
  } else {
    menu.style.bottom = 'auto';
    menu.style.top = `${rect.bottom + gap}px`;
  }
}

function openThemedSelect(select, button, focusIndex = null) {
  closeSelectMenu();
  if (select.disabled) return;
  const menu = element('div', 'themed-select-menu');
  menu.id = button.getAttribute('aria-controls');
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', select.getAttribute('aria-label') || tx('选择选项'));
  menu.tabIndex = -1;
  menu.dataset.themedSelectMenu = '1';
  [...select.options].forEach((option, index) => {
    const item = element('button', 'themed-select-option', option.textContent.trim());
    item.id = `${menu.id}-option-${index}`;
    item.type = 'button';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option.selected));
    item.disabled = option.disabled;
    item.dataset.optionIndex = String(index);
    if (option.selected) item.classList.add('selected');
    menu.append(item);
  });
  menu.addEventListener('keydown', (event) => {
    const item = event.target.closest('.themed-select-option');
    if (!item) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSelectMenu({ restoreFocus: true });
      return;
    }
    if (event.key === 'Tab') {
      closeSelectMenu();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      item.click();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    moveSelectMenuFocus(menu, event.key, select.selectedIndex);
  });
  // A modal dialog is in the browser top layer. No body z-index can rise above it,
  // so dialog-owned menus must join that same top-layer subtree.
  const owner = select.closest('dialog[open]') || document.body;
  owner.append(menu);
  button.classList.add('open');
  button.setAttribute('aria-expanded', 'true');
  openSelectMenu = { select, button, menu, settling: true };
  positionSelectMenu(menu, button);
  // scrollIntoView can fire capture scroll and would close the menu — settle first
  requestAnimationFrame(() => {
    try {
      const requested = Number.isInteger(focusIndex)
        ? menu.querySelector(`[data-option-index="${focusIndex}"]:not(:disabled)`)
        : null;
      const active = requested || menu.querySelector('.selected:not(:disabled)') || menu.querySelector('.themed-select-option:not(:disabled)');
      active?.scrollIntoView({ block: 'nearest' });
      active?.focus({ preventScroll: true });
    } catch (_) {}
    requestAnimationFrame(() => {
      if (openSelectMenu?.menu === menu) openSelectMenu.settling = false;
    });
  });
}

function enhanceSelect(select) {
  if (!(select instanceof HTMLSelectElement) || select.closest('.themed-select, .themed-multiselect')) return;
  if (select.multiple) return enhanceMultiSelect(select);
  themedSelectId += 1;
  const controlId = select.id || `themed-select-${themedSelectId}`;
  const wrap = element('span', 'themed-select');
  const button = element('button', 'themed-select-button');
  button.type = 'button';
  button.id = `${controlId}-button`;
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', `${controlId}-menu`);
  button.append(element('span', 'themed-select-value'), element('span', 'themed-select-arrow', '▾'));
  select.before(wrap);
  wrap.append(select, button);
  select.classList.add('themed-select-native');
  syncThemedSelect(select);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (openSelectMenu?.select === select) closeSelectMenu();
    else openThemedSelect(select, button);
  });
  button.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') return closeSelectMenu({ restoreFocus: true });
    if (openSelectMenu?.select === select) {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        moveSelectMenuFocus(openSelectMenu.menu, event.key, select.selectedIndex);
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') return openThemedSelect(select, button);
    const enabled = [...select.options]
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !option.disabled);
    if (!enabled.length) return openThemedSelect(select, button);
    const current = enabled.findIndex(({ index }) => index === select.selectedIndex);
    let target = 0;
    if (event.key === 'End') target = enabled.length - 1;
    else if (event.key === 'ArrowUp') target = current < 0 ? enabled.length - 1 : (current - 1 + enabled.length) % enabled.length;
    else if (event.key === 'ArrowDown') target = current < 0 ? 0 : (current + 1) % enabled.length;
    openThemedSelect(select, button, enabled[target].index);
  });
  select.addEventListener('change', () => syncThemedSelect(select));
  new MutationObserver((mutations) => {
    const needsSync = mutations.some((mutation) =>
      mutation.type === 'childList'
      || mutation.type === 'characterData'
      || mutation.target === select
      || mutation.target instanceof HTMLOptionElement
    );
    if (needsSync) syncThemedSelect(select);
  }).observe(select, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'label', 'selected'],
  });
}

function syncThemedMultiSelect(select, { rebuild = false } = {}) {
  const wrap = select.closest('.themed-multiselect');
  const list = wrap?.querySelector('.themed-multiselect-list');
  if (!list) return;
  const focusedIndex = Number(list.querySelector(':focus')?.dataset.optionIndex);
  if (rebuild || list.children.length !== select.options.length) {
    list.replaceChildren();
    [...select.options].forEach((option, index) => {
      const item = element('button', 'themed-multiselect-option');
      item.type = 'button';
      item.dataset.optionIndex = String(index);
      item.setAttribute('role', 'option');
      item.append(element('span', 'themed-multiselect-check', '✓'), element('span', 'themed-multiselect-label', option.textContent.trim()));
      list.append(item);
    });
  }
  [...list.children].forEach((item, index) => {
    const option = select.options[index];
    if (!option) return;
    item.classList.toggle('selected', option.selected);
    item.disabled = select.disabled || option.disabled;
    item.setAttribute('aria-selected', String(option.selected));
    item.querySelector('.themed-multiselect-label').textContent = option.textContent.trim();
  });
  list.setAttribute('aria-disabled', String(select.disabled));
  const enabledItems = [...list.querySelectorAll('.themed-multiselect-option:not(:disabled)')];
  const focusedItem = Number.isInteger(focusedIndex)
    ? list.querySelector(`[data-option-index="${focusedIndex}"]:not(:disabled)`)
    : null;
  const tabStop = focusedItem || enabledItems.find((item) => item.classList.contains('selected')) || enabledItems[0];
  [...list.children].forEach((item) => { item.tabIndex = item === tabStop ? 0 : -1; });
  if (focusedItem) focusedItem.focus({ preventScroll: true });
}

function enhanceMultiSelect(select) {
  themedSelectId += 1;
  const controlId = select.id || `themed-multiselect-${themedSelectId}`;
  const wrap = element('div', 'themed-multiselect');
  const list = element('div', 'themed-multiselect-list');
  list.id = `${controlId}-list`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-multiselectable', 'true');
  list.setAttribute('aria-label', select.getAttribute('aria-label') || select.labels?.[0]?.textContent?.trim() || tx('选择多个选项'));
  select.before(wrap);
  wrap.append(select, list);
  select.classList.add('themed-select-native');
  let anchorIndex = -1;
  const commit = (index, { range = false, toggle = true } = {}) => {
    const option = select.options[index];
    if (!option || option.disabled || select.disabled) return;
    if (range && anchorIndex >= 0) {
      const [start, end] = [anchorIndex, index].sort((a, b) => a - b);
      [...select.options].forEach((entry, optionIndex) => {
        if (!entry.disabled) entry.selected = optionIndex >= start && optionIndex <= end;
      });
    } else {
      option.selected = toggle ? !option.selected : true;
      anchorIndex = index;
    }
    select.dispatchEvent(new Event('change', { bubbles: true }));
    syncThemedMultiSelect(select);
  };
  list.addEventListener('click', (event) => {
    const item = event.target.closest('.themed-multiselect-option');
    if (!item) return;
    commit(Number(item.dataset.optionIndex), { range: event.shiftKey });
  });
  list.addEventListener('keydown', (event) => {
    const item = event.target.closest('.themed-multiselect-option');
    if (!item) return;
    const enabled = [...list.querySelectorAll('.themed-multiselect-option:not(:disabled)')];
    const current = enabled.indexOf(item);
    let next = current;
    if (event.key === 'ArrowDown') next = Math.min(enabled.length - 1, current + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, current - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = enabled.length - 1;
    else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      commit(Number(item.dataset.optionIndex), { range: event.shiftKey });
      return;
    } else return;
    event.preventDefault();
    enabled.forEach((entry) => { entry.tabIndex = entry === enabled[next] ? 0 : -1; });
    enabled[next]?.focus({ preventScroll: true });
    enabled[next]?.scrollIntoView({ block: 'nearest' });
  });
  select.addEventListener('change', () => syncThemedMultiSelect(select));
  new MutationObserver((mutations) => {
    const rebuild = mutations.some((mutation) => mutation.type === 'childList' || mutation.target instanceof HTMLOptionElement);
    syncThemedMultiSelect(select, { rebuild });
  }).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'label', 'selected'] });
  syncThemedMultiSelect(select, { rebuild: true });
}

function enhanceSelects(root = document) {
  if (root instanceof HTMLSelectElement) enhanceSelect(root);
  root.querySelectorAll?.('select').forEach(enhanceSelect);
}

function syncThemedSelects(root = document) {
  if (root instanceof HTMLSelectElement) syncThemedSelect(root);
  root.querySelectorAll?.('.themed-select > select').forEach(syncThemedSelect);
  root.querySelectorAll?.('.themed-multiselect > select').forEach((select) => syncThemedMultiSelect(select));
}

function readSavedColorMode() {
  try {
    const saved = localStorage.getItem(UI_COLOR_MODE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch (_) {}
  // Prefer system preference when first using native theme
  try {
    if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch (_) {}
  return 'light';
}

let uiColorMode = readSavedColorMode();

function syncAppearanceControls(theme) {
  const panel = $('#theme-appearance');
  if (!panel) return;
  const show = theme === 'element-admin';
  panel.hidden = !show;
  panel.classList.toggle('is-visible', show);
  panel.querySelectorAll('[data-color-mode]').forEach((button) => {
    const active = button.dataset.colorMode === uiColorMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function applyColorMode(mode, persist = true) {
  uiColorMode = mode === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.colorMode = uiColorMode;
  if (persist) {
    try { localStorage.setItem(UI_COLOR_MODE_KEY, uiColorMode); } catch (_) {}
  }
  const theme = document.documentElement.dataset.uiTheme || 'pixel-workstation';
  const definition = UI_THEMES[theme];
  if (theme === 'element-admin') {
    document.documentElement.style.colorScheme = uiColorMode;
  } else if (definition) {
    document.documentElement.style.colorScheme = definition.colorScheme;
  }
  syncAppearanceControls(theme);
  try {
    window.ops?.setUiChrome?.({ themeId: theme, colorMode: theme === 'element-admin' ? uiColorMode : definition?.colorScheme || 'light' });
  } catch (_) {}
  requestAnimationFrame(() => {
    refreshIcons();
    if (typeof positionThemePopover === 'function') positionThemePopover();
  });
}

function applyUiTheme(value, persist = true) {
  closeSelectMenu();
  // Pixel Workstation is the default; saved selections for the other skins remain supported.
  if (value === 'anime-dream') value = 'element-admin';
  const theme = Object.hasOwn(UI_THEMES, value) ? value : 'pixel-workstation';
  const definition = UI_THEMES[theme];
  document.documentElement.dataset.uiTheme = theme;
  const effectiveScheme = theme === 'element-admin' ? uiColorMode : definition.colorScheme;
  document.documentElement.style.colorScheme = effectiveScheme;
  document.documentElement.dataset.colorMode = theme === 'element-admin' ? uiColorMode : definition.colorScheme;
  if (persist) { try { localStorage.setItem(UI_THEME_KEY, theme); } catch (_) {} }
  const current = $('#theme-current');
  if (current) {
    current.textContent = theme === 'element-admin'
      ? `${themeDisplayName(theme)} · ${uiColorMode === 'dark' ? t('theme.dark') : t('theme.light')}`
      : themeDisplayName(theme);
  }
  $$('[data-ui-theme-option]').forEach((button) => {
    const active = button.dataset.uiThemeOption === theme;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  syncAppearanceControls(theme);
  // Match native window chrome (title bar) to current skin + appearance
  try {
    window.ops?.setUiChrome?.({
      themeId: theme,
      colorMode: theme === 'element-admin' ? uiColorMode : definition.colorScheme,
    });
  } catch (_) {}
  // Re-apply Lucide after theme CSS (stroke / currentColor) is in effect
  requestAnimationFrame(() => {
    refreshIcons();
    // Appearance row may appear/hide — re-clamp so options stay fully on-screen after scale
    if (typeof positionThemePopover === 'function') positionThemePopover();
  });
}

let savedUiTheme = 'pixel-workstation';
try {
  savedUiTheme = localStorage.getItem(UI_THEME_KEY) || 'pixel-workstation';
  const migrated = localStorage.getItem('openbrowser-ui-skin-pixel-default-v1');
  if (!migrated && (savedUiTheme === 'retro-desktop' || savedUiTheme === 'element-admin')) {
    savedUiTheme = 'pixel-workstation';
    localStorage.setItem(UI_THEME_KEY, savedUiTheme);
  }
  localStorage.setItem('openbrowser-ui-skin-pixel-default-v1', '1');
} catch (_) {}
applyUiTheme(savedUiTheme, false);
// UI language: default = system; user can pin en/zh/ja/vi/fr/de/th/id
try {
  refreshLocaleChrome();
  window.OpenBrowserI18n?.onChange?.((resolved) => {
    refreshLocaleChrome();
    applyUiTheme(document.documentElement.dataset.uiTheme || 'pixel-workstation', false);
    const activeView = document.querySelector('.view.active')?.id?.replace(/^view-/, '') || 'profiles';
    if (typeof switchView === 'function') switchView(activeView);
    if (typeof renderProfiles === 'function') renderProfiles();
    if (typeof renderGroupsPage === 'function') renderGroupsPage();
    if (typeof renderRpaStore === 'function') renderRpaStore();
    if (typeof renderSessions === 'function') renderSessions();
    if (activeView === 'rpa' && typeof refreshRpaPage === 'function') refreshRpaPage().catch(() => {});
    if (activeView === 'api-mcp' && typeof refreshApiMcpPage === 'function') refreshApiMcpPage();
    if (typeof fillGroupSelect === 'function') {
      try {
        fillGroupSelect($('#batch-assign-group'), UNGROUPED_ID, { includeUngrouped: true });
        fillGroupSelect($('#batch-add-group'), listGroups()[0]?.id || UNGROUPED_ID);
        fillGroupSelect($('#profile-create-group'), listGroups()[0]?.id || UNGROUPED_ID);
      } catch (_) {}
    }
    // Re-read engine badge with new locale
    window.ops?.getInfo?.().then((info) => updateEngineBadge(info)).catch(() => {});
    if (typeof refreshIcons === 'function') refreshIcons();
    if (typeof syncThemedSelects === 'function') syncThemedSelects();
    document.documentElement.dataset.uiLocale = resolved;
  });
  document.getElementById('ui-locale-select')?.addEventListener('change', (event) => {
    window.OpenBrowserI18n?.setPreference?.(event.target.value);
  });
} catch (_) {}
// seed group selects
try {
  fillGroupSelect($('#batch-assign-group'), UNGROUPED_ID, { includeUngrouped: true });
  fillGroupSelect($('#batch-add-group'), listGroups()[0]?.id || UNGROUPED_ID);
  fillGroupSelect($('#profile-create-group'), listGroups()[0]?.id || UNGROUPED_ID);
} catch (_) {}
enhanceSelects();
new MutationObserver((records) => {
  records.forEach((record) => record.addedNodes.forEach((node) => {
    if (node instanceof Element) enhanceSelects(node);
  }));
}).observe(document.body, { childList: true, subtree: true });

function toast(message) { const value = $('#toast'); value.textContent = message; value.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => value.classList.remove('show'), 2400); }
function log(module, message) { ui.logs.unshift({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), module, message }); ui.logs = ui.logs.slice(0, 200); save(); renderLogs(); }
function initials(name) { return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(); }
function isDirectProxy(value) {
  return !value || /^(direct|offline|none)$/i.test(String(value).trim());
}

function maskProxy(value) {
  const raw = String(value || '').trim();
  if (isDirectProxy(raw)) return t('net.localDirect');
  try {
    const parsed = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? new URL(raw) : null;
    if (parsed) return parsed.protocol.replace(':', '').toUpperCase() + ' · ' + parsed.hostname + ':' + parsed.port + (parsed.username ? ' · ' + t('net.auth') : '');
  } catch (_) {}
  const parts = raw.split(':');
  return parts.length >= 4 ? 'SOCKS5 · ' + parts[0] + ':' + parts[1] + ' · ' + t('net.auth') : raw;
}

function networkModeBadge(proxy) {
  const wrap = document.createElement('div');
  wrap.className = 'network-mode-cell network-mode-cell-compact';
  if (isDirectProxy(proxy)) {
    const badge = element('span', 'net-badge net-badge-direct', t('net.direct'));
    badge.title = t('net.localDirect');
    wrap.append(badge);
  } else {
    const badge = element('span', 'net-badge net-badge-proxy', t('net.proxy'));
    badge.title = maskProxy(proxy);
    wrap.append(badge);
  }
  return wrap;
}
function countryFlag(code) { const value = String(code || '').toUpperCase(); return /^[A-Z]{2}$/.test(value) ? String.fromCodePoint(...[...value].map((char) => 127397 + char.charCodeAt(0))) : '🌐'; }
function countryName(code) {
  const locale = window.OpenBrowserI18n?.getLocale?.() === 'zh-CN' ? 'zh-CN' : (window.OpenBrowserI18n?.getLocale?.() || 'en');
  try { return new Intl.DisplayNames([locale], { type: 'region' }).of(String(code || '').toUpperCase()) || code; } catch (_) { return code || ''; }
}
function parseEditorProxy(value) {
  const raw = String(value || '').trim();
  if (!raw || /^(direct|offline|none)$/i.test(raw)) return { mode: 'direct', type: 'socks5', host: '', port: '', username: '', password: '' };
  try {
    const parsed = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? new URL(raw) : null;
    if (parsed) return { mode: 'custom', type: parsed.protocol.replace(':', '').toLowerCase(), host: parsed.hostname, port: parsed.port, username: decodeURIComponent(parsed.username || ''), password: decodeURIComponent(parsed.password || '') };
  } catch (_) {}
  const parts = raw.split(':');
  return { mode: 'custom', type: parts.length >= 4 ? 'socks5' : 'http', host: parts[0] || '', port: parts[1] || '', username: parts[2] || '', password: parts.slice(3).join(':') };
}

function editorSet(id, value) { const field = $(id); if (field) field.value = value ?? ''; }
function editorCheck(id, value) { const field = $(id); if (field) field.checked = Boolean(value); }
function editorSelectedNetwork() { return document.querySelector('input[name="editor-network"]:checked')?.value || 'direct'; }

function serializeEditorProxy(strict = true) {
  if (editorSelectedNetwork() === 'direct') return 'Direct';
  const protocol = $('#editor-proxy-type').value; const host = $('#editor-proxy-host').value.trim(); const port = Number($('#editor-proxy-port').value);
  const username = $('#editor-proxy-user').value; const password = $('#editor-proxy-password').value;
  if (!host && !$('#editor-proxy-port').value.trim() && !username && !password) return 'Direct';
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    if (strict) throw new Error(tx('请填写有效的代理主机和端口'));
    return protocol.toUpperCase() + ' · 待完善';
  }
  if ((username && !password) || (!username && password)) {
    if (strict) throw new Error(tx('代理账号和密码必须同时填写'));
    return protocol + '://' + host + ':' + port;
  }
  const auth = username ? encodeURIComponent(username) + ':' + encodeURIComponent(password) + '@' : '';
  return protocol + '://' + auth + host + ':' + port;
}

function editorResolution() {
  const selected = $('#editor-resolution').value;
  if (selected !== 'custom') { const [width, height] = selected.split('x').map(Number); return { width, height }; }
  const width = Number($('#editor-width').value); const height = Number($('#editor-height').value);
  if (!Number.isInteger(width) || width < 640 || width > 7680 || !Number.isInteger(height) || height < 480 || height > 4320) throw new Error(tx('请填写有效的窗口宽度和高度'));
  return { width, height };
}

function editorCookies() {
  const raw = $('#editor-cookies').value.trim(); if (!raw) return '';
  let values; try { values = JSON.parse(raw); } catch (_) { throw new Error(tx('Cookie JSON 格式错误')); }
  if (!Array.isArray(values) || values.some((item) => !item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.value !== 'string')) throw new Error(tx('Cookie 必须是包含 name 和 value 的 JSON 数组'));
  return JSON.stringify(values);
}

function editorDraft(strict = true) {
  const current = ui.profiles.find((item) => item.id === editingProfileId) || {};
  let resolution = { width: Number($('#editor-width')?.value) || current.width || 1280, height: Number($('#editor-height')?.value) || current.height || 820 };
  if (strict) resolution = editorResolution();
  else if ($('#editor-resolution')?.value && $('#editor-resolution').value !== 'custom') {
    const values = $('#editor-resolution').value.split('x').map(Number);
    resolution = { width: values[0], height: values[1] };
  }
  const tabMode = document.querySelector('input[name="editor-tab-mode"]:checked')?.value || 'fixed';
  const dntMode = $('#editor-dnt-mode')?.value || 'default';
  const privacy = {
    webrtc: $('#editor-webrtc')?.value || 'proxy',
    timezoneMode: $('#editor-timezone-mode')?.value || 'ip',
    timezone: ($('#editor-timezone')?.value || '').trim(),
    geoMode: $('#editor-geo-mode')?.value || 'ip',
    latitude: $('#editor-latitude')?.value,
    longitude: $('#editor-longitude')?.value,
    accuracy: Number($('#editor-accuracy')?.value) || 100,
    languageMode: $('#editor-language-mode')?.value || 'ip',
    uiLanguage: (() => {
      const mode = $('#editor-language-mode')?.value || 'ip';
      if (mode === 'ip' || mode === 'system') return 'profile';
      return mode;
    })(),
    langFromIp: ($('#editor-language-mode')?.value || 'ip') === 'ip',
    timezoneFromIp: true,
    geoFromIp: $('#editor-geo-from-ip')?.checked !== false,
    fontMode: $('#editor-font-mode')?.value || 'default',
    fontSize: Number($('#editor-font-size')?.value) || 16,
    canvas: $('#editor-canvas')?.value || 'noise',
    webgl: $('#editor-webgl')?.value || 'noise',
    webglMeta: $('#editor-webgl-meta')?.value || 'noise',
    webgpu: $('#editor-webgpu')?.value || 'webgl',
    audio: $('#editor-audio')?.value || 'noise',
    media: $('#editor-media')?.value || 'noise',
    mediaDevices: ($('#editor-media-devices')?.value || '').trim(),
    mediaLabels: {
      audioinput: ($('#editor-media-label-audio')?.value || '').trim().slice(0, 200),
      videoinput: ($('#editor-media-label-video')?.value || '').trim().slice(0, 200),
      audiooutput: ($('#editor-media-label-output')?.value || '').trim().slice(0, 200),
    },
    battery: $('#editor-battery')?.value || 'noise',
    clientRects: $('#editor-client-rects')?.value || 'noise',
    speech: $('#editor-speech')?.value || 'noise',
    deviceNameMode: $('#editor-device-name-mode')?.value || 'noise',
    deviceName: ($('#editor-device-name')?.value || '').trim(),
    dnt: dntMode === 'on' || ($('#editor-dnt')?.checked === true),
    dntMode,
    portScanProtect: Boolean($('#editor-port-scan')?.checked),
    portScanAllow: ($('#editor-port-scan-allow')?.value || '').trim(),
    cfOptimize: $('#editor-cf-optimize')?.checked !== false,
    refreshFingerprintOnStart: Boolean($('#editor-refresh-fingerprint')?.checked),
    stabilityMode: $('#editor-stability-mode')?.value || 'auto',
    stabilityHamming: Number($('#editor-stability-hamming')?.value) || 12,
    stabilityMaxWidth: Number($('#editor-stability-max-width')?.value) || 600,
    stabilityMaxHeight: Number($('#editor-stability-max-height')?.value) || 600,
    stabilitySquare: Number($('#editor-stability-square')?.value) || 8,
    stabilityHosts: ($('#editor-stability-hosts')?.value || '').split(/[\r\n,;\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 800),
    stabilitySkipHosts: ($('#editor-stability-skip-hosts')?.value || '').split(/[\r\n,;\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 200),
    cores: (() => {
      const v = $('#editor-cores')?.value;
      if (v === '' || v == null) return '';
      const n = Number(v);
      return Number.isFinite(n) ? n : '';
    })(),
    memory: (() => {
      const v = $('#editor-memory')?.value;
      if (v === '' || v == null) return '';
      const n = Number(v);
      return Number.isFinite(n) ? n : '';
    })(),
    fingerprint: {
      ...(current.privacy?.fingerprint || {}),
      cores: (() => {
        const v = $('#editor-cores')?.value;
        if (v === '' || v == null) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      })(),
      memory: (() => {
        const v = $('#editor-memory')?.value;
        if (v === '' || v == null) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      })(),
    },
  };
  if (strict && privacy.timezoneMode === 'custom' && privacy.timezone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: privacy.timezone }).format(); }
    catch (_) { throw new Error(tx('自定义时区无效，请使用 Asia/Shanghai 这类 IANA 时区名称')); }
  }
  if (strict && privacy.geoMode === 'custom') {
    const latitude = Number(privacy.latitude); const longitude = Number(privacy.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error(tx('自定义地理位置经纬度无效'));
    }
    privacy.latitude = latitude; privacy.longitude = longitude;
  }
  return normalizeProfileSettings({
    ...current,
    ...(editorNetworkResult ? {
      exitIp: editorNetworkResult.ip,
      exitCountryCode: editorNetworkResult.countryCode,
      exitTimezone: editorNetworkResult.timezone || '',
      exitLatitude: editorNetworkResult.latitude,
      exitLongitude: editorNetworkResult.longitude,
      exitCheckedAt: editorNetworkResult.checkedAt,
    } : {}),
    id: editingProfileId,
    number: current.number,
    name: displayProfileNumber(current),
    title: ($('#editor-title')?.value || '').trim(),
    browser: 'Google Chrome',
    os: $('#editor-os')?.value || current.os || 'Windows',
    userAgent: ($('#editor-user-agent')?.value || '').trim(),
    cookies: strict ? editorCookies() : ($('#editor-cookies')?.value || '').trim(),
    language: (() => {
      // 最终语言在 engine.start 时按出口 IP 解析（JP→ja-JP）；此处只存草稿/固定值
      const mode = $('#editor-language-mode')?.value || 'ip';
      if (mode === 'ip') {
        // 若已测过出口国家，先写入对应语言；否则保留原值，启动时再解析
        const cc = editorNetworkResult?.countryCode || current.exitCountryCode || '';
        if (cc) {
          try {
            // 与 engine locale-from-country 对齐的轻量映射（渲染进程不 require 该模块）
            const map = { JP: 'ja-JP', CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK', KR: 'ko-KR', US: 'en-US', GB: 'en-GB', DE: 'de-DE', FR: 'fr-FR', ES: 'es-ES', BR: 'pt-BR', RU: 'ru-RU', TH: 'th-TH', VN: 'vi-VN', ID: 'id-ID', SA: 'ar-SA', SG: 'en-SG', AU: 'en-AU', CA: 'en-CA', IN: 'en-IN', PH: 'en-PH', MX: 'es-MX', IT: 'it-IT', NL: 'nl-NL', PL: 'pl-PL', TR: 'tr-TR', UA: 'uk-UA', MY: 'ms-MY' };
            const code = String(cc).toUpperCase();
            if (map[code]) return map[code];
          } catch (_) {}
        }
        return current.language || 'en-US';
      }
      if (mode === 'system') {
        try { return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'; } catch (_) { return 'en-US'; }
      }
      if (/^[a-z]{2}(-[A-Za-z]{2})?$/i.test(mode)) return mode;
      return current.language || 'en-US';
    })(),
    tag: ($('#editor-tag')?.value || '').trim(),
    groupId: $('#editor-group')?.value || UNGROUPED_ID,
    note: ($('#editor-note')?.value || '').trim(),
    networkMode: editorSelectedNetwork() === 'direct' ? 'direct' : 'proxy',
    proxy: serializeEditorProxy(strict),
    width: resolution.width,
    height: resolution.height,
    platform: {
      type: $('#editor-platform-type')?.value || 'other',
      startUrl: ($('#editor-start-url')?.value || '').trim(),
      username: ($('#editor-platform-user')?.value || '').trim(),
      password: $('#editor-platform-pass')?.value || '',
      totpSecret: ($('#editor-platform-2fa')?.value || '').trim(),
    },
    proxyMeta: {
      ipChannel: $('#editor-ip-channel')?.value || 'ip-api',
      refreshUrl: ($('#editor-refresh-url')?.value || '').trim(),
      checkOnStart: Boolean($('#editor-proxy-check-start')?.checked),
      refreshOnStart: Boolean($('#editor-proxy-refresh-start')?.checked),
      systemProxy: $('#editor-system-proxy')?.value || 'global',
      directBypass: Boolean($('#editor-direct-bypass')?.checked),
      bypassList: ($('#editor-bypass-list')?.value || '').trim(),
      apiExtractUrl: ($('#editor-api-extract-url')?.value || '').trim(),
      backupProxies: ($('#editor-backup-proxies')?.value || '').split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8),
      fillFingerprint: $('#editor-proxy-fill-fingerprint')?.checked !== false,
      requireReady: $('#editor-proxy-require-ready')?.checked !== false,
      notReadyPolicy: $('#editor-proxy-not-ready-policy')?.value || 'block',
      tlsProfile: $('#editor-proxy-tls-profile')?.value || 'auto',
      tlsChromeMajor: (() => {
        const raw = ($('#editor-proxy-tls-chrome-major')?.value || '').trim();
        if (!raw) return null;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 80 && n <= 200 ? Math.floor(n) : null;
      })(),
    },
    privacy,
    advanced: {
      saveCookies: $('#editor-save-cookies')?.checked !== false,
      savePasswords: Boolean($('#editor-save-passwords')?.checked),
      saveBookmarks: $('#editor-save-bookmarks')?.checked !== false,
      saveLocalStorage: $('#editor-save-local-storage')?.checked !== false,
      saveIndexedDB: $('#editor-save-indexeddb')?.checked !== false,
      saveHistory: $('#editor-save-history')?.checked !== false,
      allowSignin: Boolean($('#editor-allow-signin')?.checked),
      restoreSession: tabMode === 'restore' || Boolean($('#editor-restore-session')?.checked),
      blockVideo: Boolean($('#editor-block-video')?.checked),
      blockImages: Boolean($('#editor-block-images')?.checked),
      clearCacheOnStart: Boolean($('#editor-clear-cache')?.checked),
      cloudBackup: Boolean($('#editor-cloud-backup')?.checked),
      syncCookiesOnClose: $('#editor-sync-cookies-close')?.checked !== false,
      syncIndexedDB: Boolean($('#editor-sync-idb')?.checked),
      syncLocalStorage: Boolean($('#editor-sync-ls')?.checked),
      syncPasswords: Boolean($('#editor-sync-passwords')?.checked),
      syncExtensionData: Boolean($('#editor-sync-ext')?.checked),
      multiOpen: Boolean($('#editor-multi-open')?.checked),
      tabMode,
      startUrls: ($('#editor-start-urls')?.value || '').trim(),
      blockUrls: ($('#editor-block-urls')?.value || '').trim(),
      blockSound: Boolean($('#editor-block-sound')?.checked),
      blockPasswordPrompt: Boolean($('#editor-block-password-prompt')?.checked),
      blockRestoreDialog: $('#editor-block-restore-dialog')?.checked !== false,
      blockNotifications: $('#editor-block-notifications')?.checked !== false,
      blockPopups: Boolean($('#editor-block-popups')?.checked),
      jsHeapMax: Boolean($('#editor-js-heap-max')?.checked),
      showInfoPage: $('#editor-show-info-page')?.checked !== false,
      showPasswordOnInfo: Boolean($('#editor-show-password-info')?.checked),
      loadGlobalBookmarks: Boolean($('#editor-load-global-bookmarks')?.checked),
      showBookmarkBar: Boolean($('#editor-show-bookmark-bar')?.checked),
      uploadBookmarks: Boolean($('#editor-upload-bookmarks')?.checked),
    },
  });
}

function updateEditorVisibility() {
  const direct = editorSelectedNetwork() === 'direct';
  const proxyFields = $('#editor-proxy-fields');
  if (proxyFields) {
    proxyFields.classList.toggle('disabled', direct);
    proxyFields.hidden = direct;
  }
  $('#editor-timezone').hidden = $('#editor-timezone-mode').value !== 'custom';
  $('.geo-custom').hidden = $('#editor-geo-mode').value !== 'custom';
  const customResolution = $('#editor-resolution').value === 'custom'; $('#editor-width').hidden = !customResolution; $('#editor-height').hidden = !customResolution;
  $('#editor-font-size').hidden = $('#editor-font-mode').value !== 'custom';
}

function renderEditorSummary() {
  if (!editingProfileId) return;
  const draft = editorDraft(false); const privacy = draft.privacy; const summary = $('#editor-summary'); summary.replaceChildren();
  const labels = {
    webrtc: { proxy: tx('仅代理连接'), disabled: tx('禁用非代理 UDP'), real: tx('真实网络') }, timezoneMode: { ip: '基于出口 IP', real: '系统真实', custom: privacy.timezone || '自定义' },
    geoMode: { ip: '基于出口 IP', disabled: '禁止访问', custom: '自定义坐标' }, canvas: { real: '真实', blocked: '禁止读取' }, webgl: { real: '真实', blocked: '禁用' },
    audio: { real: '真实', muted: '静音输出' }, media: { real: '按网站询问', blocked: '禁止访问' }, speech: { real: '真实', blocked: '禁用' }
  };
  const values = [
    [tx('浏览器'), 'Google Chrome'], [tx('分组'), groupNameOf(draft)], ['User-Agent', draft.userAgent || 'Chrome 默认'], [tx('网络'), maskProxy(draft.proxy)], ['WebRTC', labels.webrtc[privacy.webrtc]],
    [tx('时区'), labels.timezoneMode[privacy.timezoneMode]], [tx('地理位置'), labels.geoMode[privacy.geoMode]], [tx('语言'), draft.language], [tx('界面语言'), privacy.uiLanguage === 'profile' ? '跟随语言' : privacy.uiLanguage],
    [tx('分辨率'), draft.width + ' × ' + draft.height], [tx('字体'), privacy.fontMode === 'custom' ? privacy.fontSize + 'px' : '默认'], ['Canvas', labels.canvas[privacy.canvas]],
    ['WebGL', labels.webgl[privacy.webgl]], ['WebGPU', privacy.webgpu === 'blocked' ? '禁用' : (privacy.webgpu === 'webgl' ? '基于 WebGL' : '真实')], ['AudioContext', labels.audio[privacy.audio]], [tx('媒体设备'), labels.media[privacy.media]],
    [tx('电池'), privacy.battery === 'blocked' ? '关闭' : (privacy.battery === 'real' ? '真实' : '随机')],
    [tx('站点稳定性'), privacy.stabilityMode === 'force' ? '强制' : (privacy.stabilityMode === 'off' ? '关闭' : '自动')],
    [tx('代理未就绪'), draft.proxyMeta?.notReadyPolicy === 'direct' ? '回退直连' : (draft.proxyMeta?.notReadyPolicy === 'continue' ? '继续' : '阻断')],
    [tx('TLS 配置'), draft.proxyMeta?.tlsProfile || 'auto'],
    ['ClientRects', privacy.clientRects === 'real' ? '真实' : '随机'],
    ['SpeechVoices', labels.speech[privacy.speech]],
    // Must read the profile editor value — never the host Electron navigator.
    ['CPU', (() => {
      const raw = privacy.cores ?? privacy.fingerprint?.cores;
      if (raw === '' || raw === null || raw === undefined) return tx('自动');
      const n = Number(raw);
      if (!Number.isFinite(n)) return tx('自动');
      if (n === 0) return tx('真实');
      return `${n} 核`;
    })()],
    ['RAM', (() => {
      const raw = privacy.memory ?? privacy.fingerprint?.memory;
      if (raw === '' || raw === null || raw === undefined) return tx('自动');
      const n = Number(raw);
      if (!Number.isFinite(n)) return tx('自动');
      if (n === 0) return tx('真实');
      return `${n} GB`;
    })()],
    ['Do Not Track', privacy.dnt ? '启用' : '默认'],
    [tx('每次打开刷新指纹'), privacy.refreshFingerprintOnStart ? '开启' : '关闭']
  ];
  for (const [name, value] of values) { const row = document.createElement('div'); row.append(element('dt', '', name), element('dd', '', value || '默认')); summary.append(row); }
  const auditTarget = $('#editor-audit');
  if (auditTarget && window.EnvironmentAudit) {
    const report = window.EnvironmentAudit.build(draft, { systemTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    auditTarget.replaceChildren();
    const head = element('div', 'audit-head');
    head.append(element('strong', '', tx('环境一致性检查')), element('span', report.status, report.warnings ? `${report.warnings} 项需确认` : '配置一致'));
    auditTarget.append(head);
    for (const check of report.checks) {
      const row = element('div', `audit-row ${check.state}`);
      const body = element('div'); body.append(element('strong', '', check.label), element('small', '', check.detail));
      row.append(element('i', '', ''), body); auditTarget.append(row);
    }
  }
}

function setEditorTab(tab) {
  $$('[data-editor-tab]').forEach((button) => button.classList.toggle('active', button.dataset.editorTab === tab));
  $$('[data-editor-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.editorPanel === tab));
}

function openProfileEditor(id) {
  const profile = normalizeProfileSettings(ui.profiles.find((item) => item.id === id)); if (!profile?.id) return;
  editorNetworkResult = profile.exitIp ? { ip: profile.exitIp, countryCode: profile.exitCountryCode, timezone: profile.exitTimezone, latitude: profile.exitLatitude, longitude: profile.exitLongitude, checkedAt: profile.exitCheckedAt } : null;
  editingProfileId = profile.id;
  editorSet('#editor-id', profile.id);
  $('#editor-profile-id').textContent = displayProfileNumber(profile);
  editorSet('#editor-name', displayProfileNumber(profile));
  editorSet('#editor-title', profile.title || '');
  editorSet('#editor-browser', 'Google Chrome');
  editorSet('#editor-os', profile.os);
  editorSet('#editor-user-agent', profile.userAgent);
  editorSet('#editor-cookies', (() => {
    if (!profile.cookies) return '';
    try { return JSON.stringify(JSON.parse(profile.cookies), null, 2); } catch (_) { return profile.cookies; }
  })());
  editorSet('#editor-language', profile.language);
  editorSet('#editor-tag', profile.tag);
  editorSet('#editor-note', profile.note);
  editorSet('#editor-platform-type', profile.platform?.type || 'other');
  editorSet('#editor-start-url', profile.platform?.startUrl || '');
  // if type is blank, keep URL empty
  if ((profile.platform?.type || '') === 'blank') editorSet('#editor-start-url', '');
  editorSet('#editor-platform-user', profile.platform?.username || '');
  editorSet('#editor-platform-pass', profile.platform?.password || '');
  editorSet('#editor-platform-2fa', profile.platform?.totpSecret || '');
  fillGroupSelect($('#editor-group'), profile.groupId || UNGROUPED_ID, { includeUngrouped: true });
  const proxy = parseEditorProxy(profile.proxy);
  const mode = document.querySelector('input[name="editor-network"][value="' + proxy.mode + '"]');
  if (mode) mode.checked = true;
  editorSet('#editor-proxy-type', ['http', 'https', 'socks5'].includes(proxy.type) ? proxy.type : 'socks5');
  editorSet('#editor-proxy-host', proxy.host);
  editorSet('#editor-proxy-port', proxy.port);
  editorSet('#editor-proxy-user', proxy.username);
  editorSet('#editor-proxy-password', proxy.password);
  editorSet('#editor-ip-channel', profile.proxyMeta.ipChannel);
  editorSet('#editor-refresh-url', profile.proxyMeta.refreshUrl);
  editorSet('#editor-api-extract-url', profile.proxyMeta.apiExtractUrl || '');
  editorSet('#editor-backup-proxies', Array.isArray(profile.proxyMeta.backupProxies) ? profile.proxyMeta.backupProxies.join('\n') : '');
  editorCheck('#editor-proxy-check-start', profile.proxyMeta.checkOnStart);
  editorCheck('#editor-proxy-refresh-start', profile.proxyMeta.refreshOnStart);
  editorCheck('#editor-proxy-fill-fingerprint', profile.proxyMeta.fillFingerprint !== false);
  editorCheck('#editor-proxy-require-ready', profile.proxyMeta.requireReady !== false);
  editorSet('#editor-proxy-not-ready-policy', profile.proxyMeta.notReadyPolicy || (profile.proxyMeta.requireReady === false ? 'continue' : 'block'));
  editorSet('#editor-proxy-tls-profile', profile.proxyMeta.tlsProfile || 'auto');
  editorSet('#editor-proxy-tls-chrome-major', profile.proxyMeta.tlsChromeMajor == null ? '' : profile.proxyMeta.tlsChromeMajor);
  editorSet('#editor-system-proxy', profile.proxyMeta.systemProxy || 'global');
  editorCheck('#editor-direct-bypass', profile.proxyMeta.directBypass);
  editorSet('#editor-bypass-list', profile.proxyMeta.bypassList || '');
  if ($('#editor-proxy-result')) {
    $('#editor-proxy-result').className = 'proxy-test-result';
    $('#editor-proxy-result').textContent = profile.exitIp ? tx('上次出口：') + profile.exitIp + ' · ' + countryName(profile.exitCountryCode) : tx('尚未检测');
  }
  const privacy = profile.privacy;
  editorSet('#editor-webrtc', privacy.webrtc);
  editorSet('#editor-timezone-mode', privacy.timezoneMode);
  editorSet('#editor-timezone', privacy.timezone);
  editorSet('#editor-geo-mode', privacy.geoMode);
  editorSet('#editor-latitude', privacy.latitude);
  editorSet('#editor-longitude', privacy.longitude);
  editorSet('#editor-accuracy', privacy.accuracy);
  {
    const mode = privacy.languageMode
      || (privacy.langFromIp !== false && (!privacy.uiLanguage || privacy.uiLanguage === 'profile') ? 'ip' : null)
      || (privacy.uiLanguage && privacy.uiLanguage !== 'profile' ? privacy.uiLanguage : null)
      || 'ip';
    editorSet('#editor-language-mode', mode);
    editorSet('#editor-ui-language', mode === 'ip' || mode === 'system' ? 'profile' : mode);
    editorCheck('#editor-lang-from-ip', mode === 'ip');
  }
  editorCheck('#editor-geo-from-ip', privacy.geoFromIp !== false);
  const resolutionKey = profile.width + 'x' + profile.height;
  const resolution = ['1280x820', '1366x768', '1440x900', '1920x1080'].includes(resolutionKey) ? resolutionKey : 'custom';
  editorSet('#editor-resolution', resolution);
  editorSet('#editor-width', profile.width);
  editorSet('#editor-height', profile.height);
  editorSet('#editor-font-mode', privacy.fontMode);
  editorSet('#editor-font-size', privacy.fontSize);
  editorSet('#editor-canvas', privacy.canvas);
  editorSet('#editor-webgl', privacy.webgl);
  editorSet('#editor-webgl-meta', privacy.webglMeta || 'noise');
  editorSet('#editor-webgpu', privacy.webgpu);
  editorSet('#editor-audio', privacy.audio);
  editorSet('#editor-media', privacy.media);
  editorSet('#editor-media-devices', privacy.mediaDevices || '');
  editorSet('#editor-battery', privacy.battery || 'noise');
  editorSet('#editor-media-label-audio', privacy.mediaLabels?.audioinput || privacy.mediaLabels?.input || '');
  editorSet('#editor-media-label-video', privacy.mediaLabels?.videoinput || privacy.mediaLabels?.video || '');
  editorSet('#editor-media-label-output', privacy.mediaLabels?.audiooutput || privacy.mediaLabels?.output || '');
  editorSet('#editor-client-rects', privacy.clientRects || 'noise');
  editorSet('#editor-speech', privacy.speech);
  // Select values are strings; 0 must stay "0" (真实), never fall through to "" (自动).
  editorSet('#editor-cores', (() => {
    const raw = privacy.cores ?? privacy.fingerprint?.cores;
    if (raw === '' || raw === null || raw === undefined) return '';
    return String(raw);
  })());
  editorSet('#editor-memory', (() => {
    const raw = privacy.memory ?? privacy.fingerprint?.memory;
    if (raw === '' || raw === null || raw === undefined) return '';
    return String(raw);
  })());
  editorSet('#editor-device-name-mode', privacy.deviceNameMode || 'noise');
  editorSet('#editor-device-name', privacy.deviceName || '');
  editorSet('#editor-dnt-mode', privacy.dntMode || (privacy.dnt ? 'on' : 'default'));
  editorCheck('#editor-dnt', privacy.dnt);
  editorCheck('#editor-port-scan', privacy.portScanProtect);
  editorSet('#editor-port-scan-allow', privacy.portScanAllow || '');
  editorCheck('#editor-cf-optimize', privacy.cfOptimize !== false);
  editorCheck('#editor-refresh-fingerprint', privacy.refreshFingerprintOnStart);
  editorSet('#editor-stability-mode', privacy.stabilityMode || 'auto');
  editorSet('#editor-stability-hamming', privacy.stabilityHamming || 12);
  editorSet('#editor-stability-max-width', privacy.stabilityMaxWidth || 600);
  editorSet('#editor-stability-max-height', privacy.stabilityMaxHeight || 600);
  editorSet('#editor-stability-square', privacy.stabilitySquare || 8);
  editorSet('#editor-stability-hosts', Array.isArray(privacy.stabilityHosts) ? privacy.stabilityHosts.join('\n') : (privacy.stabilityHosts || ''));
  editorSet('#editor-stability-skip-hosts', Array.isArray(privacy.stabilitySkipHosts) ? privacy.stabilitySkipHosts.join('\n') : (privacy.stabilitySkipHosts || ''));
  const advanced = profile.advanced;
  for (const [sel, value] of [
    ['#editor-save-cookies', advanced.saveCookies],
    ['#editor-save-passwords', advanced.savePasswords],
    ['#editor-save-bookmarks', advanced.saveBookmarks],
    ['#editor-save-local-storage', advanced.saveLocalStorage],
    ['#editor-save-indexeddb', advanced.saveIndexedDB],
    ['#editor-save-history', advanced.saveHistory],
    ['#editor-allow-signin', advanced.allowSignin],
    ['#editor-restore-session', advanced.restoreSession],
    ['#editor-block-video', advanced.blockVideo],
    ['#editor-block-images', advanced.blockImages],
    ['#editor-clear-cache', advanced.clearCacheOnStart],
    ['#editor-cloud-backup', advanced.cloudBackup],
    ['#editor-sync-cookies-close', advanced.syncCookiesOnClose !== false],
    ['#editor-sync-idb', advanced.syncIndexedDB],
    ['#editor-sync-ls', advanced.syncLocalStorage],
    ['#editor-sync-passwords', advanced.syncPasswords],
    ['#editor-sync-ext', advanced.syncExtensionData],
    ['#editor-multi-open', advanced.multiOpen],
    ['#editor-block-sound', advanced.blockSound],
    ['#editor-block-password-prompt', advanced.blockPasswordPrompt],
    ['#editor-block-restore-dialog', advanced.blockRestoreDialog],
    ['#editor-block-notifications', advanced.blockNotifications],
    ['#editor-block-popups', advanced.blockPopups],
    ['#editor-js-heap-max', advanced.jsHeapMax],
    ['#editor-show-info-page', advanced.showInfoPage],
    ['#editor-show-password-info', advanced.showPasswordOnInfo],
    ['#editor-load-global-bookmarks', advanced.loadGlobalBookmarks],
    ['#editor-show-bookmark-bar', advanced.showBookmarkBar],
    ['#editor-upload-bookmarks', advanced.uploadBookmarks],
  ]) editorCheck(sel, value);
  const tabMode = advanced.tabMode === 'restore' ? 'restore' : 'fixed';
  const tabRadio = document.querySelector('input[name="editor-tab-mode"][value="' + tabMode + '"]');
  if (tabRadio) tabRadio.checked = true;
  editorSet('#editor-start-urls', advanced.startUrls || '');
  editorSet('#editor-block-urls', advanced.blockUrls || '');
  setEditorTab('basic');
  updateEditorVisibility();
  renderEditorSummary();
  switchView('profile-editor');
}

function formatProxyCheckResult(result = {}) {
  const parts = [
    result.ip || '',
    result.countryCode ? (countryFlag(result.countryCode) + ' ' + countryName(result.countryCode)) : '',
    Number.isFinite(Number(result.latencyMs)) ? (Number(result.latencyMs) + 'ms') : '',
    result.networkType || '',
    result.timezone || '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function applyEditorNetworkResult(result = {}, { fillFingerprint = true } = {}) {
  editorNetworkResult = result;
  if (!fillFingerprint) return;
  if (result.timezone) {
    editorSet('#editor-timezone-mode', 'ip');
    editorSet('#editor-timezone', result.timezone);
  }
  if (result.countryCode) {
    editorSet('#editor-language-mode', 'ip');
  }
  if (Number.isFinite(Number(result.latitude)) && Number.isFinite(Number(result.longitude))) {
    editorSet('#editor-geo-mode', 'ip');
  }
  updateEditorVisibility();
  renderEditorSummary();
}

async function testEditorProxy() {
  const output = $('#editor-proxy-result');
  try {
    const draft = editorDraft(true);
    if (/^Direct$/i.test(draft.proxy) && !draft.proxyMeta?.apiExtractUrl) throw new Error(tx('本地直连无需代理检测'));
    output.className = 'proxy-test-result';
    output.textContent = tx('正在检测代理出口...');
    const result = await window.ops.testProfileProxy(draft);
    const fill = $('#editor-proxy-fill-fingerprint')?.checked !== false;
    applyEditorNetworkResult(result, { fillFingerprint: fill });
    output.className = 'proxy-test-result success';
    output.textContent = tx('连接成功 · ') + formatProxyCheckResult(result);
  } catch (error) {
    output.className = 'proxy-test-result error';
    const cls = error?.errorClass ? ` [${error.errorClass}]` : '';
    output.textContent = tx('检测失败 · ') + error.message + cls;
  }
}

async function applyEditorProxyFingerprint() {
  const output = $('#editor-proxy-result');
  try {
    const draft = editorDraft(true);
    if (/^Direct$/i.test(draft.proxy) && !draft.proxyMeta?.apiExtractUrl) throw new Error(tx('本地直连无需代理检测'));
    output.className = 'proxy-test-result';
    output.textContent = tx('正在用代理对齐指纹...');
    const result = await window.ops.applyProxyFingerprint(draft);
    applyEditorNetworkResult(result, { fillFingerprint: true });
    output.className = 'proxy-test-result success';
    output.textContent = tx('已对齐指纹 · ') + formatProxyCheckResult(result);
    toast(tx('已按出口 IP 填充时区 / 语言 / 定位'));
  } catch (error) {
    output.className = 'proxy-test-result error';
    output.textContent = tx('对齐失败 · ') + error.message;
    toast(tx('对齐失败：') + error.message);
  }
}

async function refreshEditorProxy() {
  const output = $('#editor-proxy-result');
  try {
    const draft = editorDraft(true);
    if (!draft.proxyMeta?.refreshUrl && !draft.proxyMeta?.apiExtractUrl) {
      throw new Error(tx('请先填写刷新 URL 或 API 提取 URL'));
    }
    output.className = 'proxy-test-result';
    output.textContent = tx('正在刷新代理...');
    const result = await window.ops.refreshProfileProxy(draft);
    const network = result.network || result;
    if (result.profile?.proxy) {
      try {
        const raw = String(result.profile.proxy);
        const url = new URL(raw.includes('://') ? raw : ('socks5://' + raw));
        editorSet('#editor-proxy-type', (url.protocol || 'socks5:').replace(':', '') || 'socks5');
        editorSet('#editor-proxy-host', url.hostname || '');
        editorSet('#editor-proxy-port', url.port || '');
        editorSet('#editor-proxy-user', decodeURIComponent(url.username || ''));
        editorSet('#editor-proxy-password', decodeURIComponent(url.password || ''));
      } catch (_) {}
    }
    applyEditorNetworkResult(network, { fillFingerprint: $('#editor-proxy-fill-fingerprint')?.checked !== false });
    updateEditorVisibility();
    renderEditorSummary();
    output.className = 'proxy-test-result success';
    let msg = tx('刷新成功 · ') + formatProxyCheckResult(network);
    if (result.extractError) msg += ' · ' + tx('提取警告：') + result.extractError;
    output.textContent = msg;
    toast(result.extractError ? (tx('代理已刷新（提取有警告）')) : tx('代理已刷新'));
  } catch (error) {
    output.className = 'proxy-test-result error';
    output.textContent = tx('刷新失败 · ') + error.message;
    toast(tx('刷新失败：') + error.message);
  }
}

function useSystemEditorDefaults() {
  editorSet('#editor-user-agent', ''); editorSet('#editor-timezone-mode', 'real'); editorSet('#editor-timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || ''); editorSet('#editor-geo-mode', 'disabled'); editorSet('#editor-ui-language', 'system');
  editorSet('#editor-resolution', 'custom'); editorSet('#editor-width', Math.max(640, screen.availWidth || 1280)); editorSet('#editor-height', Math.max(480, screen.availHeight || 820));
  editorSet('#editor-webrtc', 'real'); editorSet('#editor-canvas', 'real'); editorSet('#editor-webgl', 'real'); editorSet('#editor-webgpu', 'real'); editorSet('#editor-audio', 'real'); editorSet('#editor-media', 'real'); editorSet('#editor-speech', 'real');
  updateEditorVisibility(); renderEditorSummary(); toast(tx('已读取本机安全默认值'));
  refreshUaMetaPreview().catch(() => {});
}

function editorOsToUaKey(osLabel) {
  const s = String(osLabel || '');
  if (/mac/i.test(s)) return 'macos';
  if (/linux/i.test(s)) return 'linux';
  return 'windows';
}

async function applyBuiltUa(payload) {
  if (!window.ops?.buildUa) throw new Error(tx('UA 生成接口不可用，请重启应用'));
  const ua = await window.ops.buildUa(payload);
  editorSet('#editor-user-agent', ua.userAgent || '');
  // sync OS selector with generated UA platform
  if (ua.os === 'macos') editorSet('#editor-os', 'macOS');
  else if (ua.os === 'linux') editorSet('#editor-os', 'Linux');
  else if (ua.os === 'windows') editorSet('#editor-os', 'Windows');
  if (ua.chromeMajor) editorSet('#editor-ua-chrome-major', String(ua.chromeMajor));
  await showUaMetaPreview(ua);
  renderEditorSummary();
  return ua;
}

async function showUaMetaPreview(ua) {
  const el = document.getElementById('editor-ua-meta');
  if (!el) return;
  if (!ua) { el.hidden = true; el.textContent = ''; return; }
  const meta = ua.metadata || ua.userAgentMetadata || {};
  const brands = (meta.brands || []).map((b) => `${b.brand} ${b.version}`).join(', ');
  el.hidden = false;
  el.textContent = [
    'Client Hints / UserAgentMetadata',
    `platform: ${meta.platform || ''}  platformVersion: ${meta.platformVersion || ''}`,
    `architecture: ${meta.architecture || ''}  bitness: ${meta.bitness || ''}  mobile: ${meta.mobile}`,
    `uaFullVersion: ${meta.uaFullVersion || meta.fullVersion || ''}`,
    `brands: ${brands}`,
  ].join('\n');
}

async function refreshUaMetaPreview() {
  const raw = document.getElementById('editor-user-agent')?.value?.trim() || '';
  if (!raw) {
    const el = document.getElementById('editor-ua-meta');
    if (el) {
      el.hidden = false;
      el.textContent = tx('留空：启动时按环境 ID 自动生成 UA + Client Hints（各环境互不相同）');
    }
    return;
  }
  try {
    const ua = await window.ops.buildUa({
      userAgent: raw,
      os: editorOsToUaKey($('#editor-os')?.value),
      chromeMajor: Number($('#editor-ua-chrome-major')?.value) || undefined,
    });
    await showUaMetaPreview(ua);
  } catch (_) {}
}

document.getElementById('editor-ua-generate')?.addEventListener('click', async () => {
  try {
    await applyBuiltUa({
      os: editorOsToUaKey($('#editor-os')?.value),
      chromeMajor: Number($('#editor-ua-chrome-major')?.value) || 131,
    });
    toast(tx('已按系统生成 UA + Client Hints'));
  } catch (e) { toast(e.message); }
});
document.getElementById('editor-ua-random')?.addEventListener('click', async () => {
  try {
    await applyBuiltUa({
      random: true,
      chromeMajor: Number($('#editor-ua-chrome-major')?.value) || undefined,
    });
    toast(tx('已随机生成 UA'));
  } catch (e) { toast(e.message); }
});
document.getElementById('editor-ua-clear')?.addEventListener('click', () => {
  editorSet('#editor-user-agent', '');
  refreshUaMetaPreview().catch(() => {});
  renderEditorSummary();
  toast(tx('已改为自动生成'));
});
document.getElementById('editor-user-agent')?.addEventListener('input', () => {
  clearTimeout(window.__uaPreviewTimer);
  window.__uaPreviewTimer = setTimeout(() => refreshUaMetaPreview().catch(() => {}), 300);
});
document.getElementById('editor-os')?.addEventListener('change', () => refreshUaMetaPreview().catch(() => {}));

function profileEngine(id) { return engineProfiles.find((item) => item.id === id) || { running: false, assignedExtensions: [] }; }

function viewMetaFor(view) {
  const map = {
    profiles: ['view.profiles', 'view.profiles.sub'],
    'profile-editor': ['view.profile-editor', 'view.profile-editor.sub'],
    groups: ['view.groups', 'view.groups.sub'],
    proxies: ['view.proxies', 'view.proxies.sub'],
    extensions: ['view.extensions', 'view.extensions.sub'],
    sync: ['view.sync', 'view.sync.sub'],
    rpa: ['view.rpa', 'view.rpa.sub'],
    'api-mcp': ['view.api-mcp', 'view.api-mcp.sub'],
    logs: ['view.logs', 'view.logs.sub'],
    system: ['view.system', 'view.system.sub'],
  };
  const keys = map[view] || map.profiles;
  return [t(keys[0]), t(keys[1])];
}

let proxyLibrary = [];
const selectedProxies = new Set();

function switchView(view) {
  $$('.nav').forEach((button) => {
    if (button.id === 'rpa-menu-toggle') {
      // parent group: active while any RPA sub-page is open
      button.classList.toggle('active', view === 'rpa');
      return;
    }
    if (button.classList.contains('nav-child') && button.dataset.view === 'rpa') {
      // child active state is refined in showRpaPanel
      button.classList.toggle('active', view === 'rpa' && button.dataset.rpaTab === (currentRpaTab || 'flows'));
      return;
    }
    button.classList.toggle('active', button.dataset.view === view);
  });
  $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
  const meta = viewMetaFor(view);
  $('#page-title').textContent = meta[0]; $('#page-subtitle').textContent = meta[1];
  if (view === 'sync') refreshSessions();
  if (view === 'extensions') refreshExtensions();
  if (view === 'proxies') refreshProxies();
  if (view === 'groups') renderGroupsPage();
  if (view === 'profiles') renderProfiles();
  if (view === 'rpa') {
    const tab = arguments[1] || currentRpaTab || 'flows';
    showRpaPanel(tab);
    refreshRpaPage();
  } else {
    // leaving RPA does not force-collapse; user may re-open later
    document.getElementById('rpa-menu-toggle')?.classList.remove('open');
  }
  if (view === 'api-mcp') refreshApiMcpPage();
}

// ========== 分组管理 ==========
function renderGroupsPage() {
  const table = $('#group-table');
  const empty = $('#group-empty');
  const countEl = $('#group-count');
  if (!table) return;
  table.replaceChildren();
  const groups = listGroups();
  if (countEl) countEl.textContent = String(groups.length);
  // ungrouped row
  {
    const row = document.createElement('tr');
    const n = countProfilesInGroup('ungrouped');
    const colorCell = document.createElement('td');
    colorCell.append(buildSquareMark('—', { color: '#94a3b8', title: t('groups.ungrouped'), size: UI_MARK_SIZE, className: 'group-mark' }));
    row.append(
      colorCell,
      element('td', '', t('groups.ungrouped')),
      element('td', '', String(n)),
      element('td', '', t('groups.default')),
      element('td', '', '—')
    );
    table.append(row);
  }
  for (const g of groups) {
    const row = document.createElement('tr');
    const colorCell = document.createElement('td');
    const letter = String(g.name || '?').trim().charAt(0) || '?';
    colorCell.append(buildSquareMark(letter, {
      color: g.color || '#245cff',
      title: g.name,
      size: UI_MARK_SIZE,
      className: 'group-mark',
    }));
    const nameCell = document.createElement('td');
    const nameWrap = element('div', 'profile-name env-identity');
    nameWrap.append(element('strong', '', g.name));
    if (g.note) nameWrap.append(element('small', 'group-note', g.note));
    nameCell.append(nameWrap);
    const n = countProfilesInGroup(g.id);
    const actions = element('div', 'actions');
    const edit = element('button', 'mini edit', t('action.edit')); edit.dataset.groupEdit = g.id;
    const view = element('button', 'mini blue', t('action.use')); view.dataset.groupView = g.id;
    const del = element('button', 'mini', t('action.delete')); del.dataset.groupDelete = g.id;
    actions.append(view, edit, del);
    const actionCell = document.createElement('td'); actionCell.append(actions);
    row.append(colorCell, nameCell, element('td', '', String(n)), element('td', '', (g.createdAt || '').replace('T', ' ').slice(0, 16) || '—'), actionCell);
    table.append(row);
  }
  if (empty) empty.hidden = true;
  afterUiRender(document.getElementById('view-groups') || document);
}

function openGroupDialog(group = null) {
  $('#group-edit-id').value = group?.id || '';
  $('#group-dialog-title').textContent = group ? tx('编辑分组') : tx('新建分组');
  $('#group-name').value = group?.name || '';
  $('#group-note').value = group?.note || '';
  const color = group?.color || GROUP_COLORS[listGroups().length % GROUP_COLORS.length];
  const normalizedColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#245cff';
  $('#group-color').value = normalizedColor;
  $('#group-color-preview')?.style.setProperty('--group-color', normalizedColor);
  // color chips
  const chips = $('#group-color-chips');
  if (chips) {
    chips.replaceChildren();
    for (const c of GROUP_COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'group-color-pick' + (c.toLowerCase() === normalizedColor.toLowerCase() ? ' active' : '');
      b.style.background = c;
      b.dataset.color = c;
      chips.append(b);
    }
  }
  $('#group-dialog').showModal();
}

function saveGroupFromDialog() {
  const id = $('#group-edit-id').value.trim();
  const name = $('#group-name').value.trim();
  if (!name) throw new Error(tx('请输入分组名称'));
  const color = $('#group-color').value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(tx('颜色必须是 #RRGGBB 格式'));
  const note = $('#group-note').value.trim();
  if (id) {
    const idx = ui.groups.findIndex((g) => g.id === id);
    if (idx < 0) throw new Error(tx('分组不存在'));
    if (ui.groups.some((g) => g.id !== id && g.name === name)) throw new Error(tx('已有同名分组'));
    ui.groups[idx] = normalizeGroup({ ...ui.groups[idx], name, color, note }, idx);
  } else {
    if (ui.groups.some((g) => g.name === name)) throw new Error(tx('已有同名分组'));
    ui.groups.push(normalizeGroup({
      id: createGroupId(),
      name,
      color,
      note,
      sort: listGroups().length,
    }, listGroups().length));
  }
  save();
  renderGroupsPage();
  renderProfiles();
  fillGroupSelect($('#editor-group'), $('#editor-group')?.value || UNGROUPED_ID);
  fillGroupSelect($('#batch-add-group'), $('#batch-add-group')?.value || UNGROUPED_ID);
  fillGroupSelect($('#profile-create-group'), $('#profile-create-group')?.value || UNGROUPED_ID);
  fillGroupSelect($('#batch-assign-group'), '', { includeUngrouped: true });
}

function deleteGroup(id) {
  const g = findGroup(id);
  if (!g) return;
  const n = countProfilesInGroup(id);
  if (!confirm(tx(`删除分组「${g.name}」？\n其中 ${n} 个环境将变为「未分组」。`))) return;
  ui.profiles = ui.profiles.map((p) => (p.groupId === id ? { ...p, groupId: UNGROUPED_ID } : p));
  ui.groups = ui.groups.filter((item) => item.id !== id);
  if (activeGroupFilter === id) activeGroupFilter = 'all';
  save();
  window.ops.syncProfiles(ui.profiles).catch(() => {});
  renderGroupsPage();
  renderProfiles();
  toast(tx('已删除分组'));
  log('Group', '删除分组 ' + g.name);
}

async function assignSelectedToGroup(groupId) {
  const ids = [...selectedProfiles];
  if (!ids.length) throw new Error(tx('请先勾选环境'));
  const gid = groupId === 'ungrouped' ? UNGROUPED_ID : groupId;
  if (gid && !findGroup(gid)) throw new Error(tx('分组不存在'));
  ui.profiles = ui.profiles.map((p) => (ids.includes(p.id) ? { ...p, groupId: gid } : p));
  save();
  engineProfiles = await window.ops.syncProfiles(ui.profiles);
  renderProfiles();
  toast(tx(`已将 ${ids.length} 个环境移到「${gid ? groupNameOf({ groupId: gid }) : '未分组'}」`));
  log('Group', `批量移动 ${ids.length} 个环境 → ${gid || '未分组'}`);
}

// allow nav buttons to pass rpa tab via dataset
document.addEventListener('click', (event) => {
  const nav = event.target.closest('[data-view="rpa"][data-rpa-tab]');
  if (!nav) return;
  // switchView will be called by existing nav handler; stash tab
  currentRpaTab = nav.dataset.rpaTab || 'flows';
}, true);


function renderProxies() {
  const table = $('#proxy-table');
  const empty = $('#proxy-empty');
  const countEl = $('#proxy-count');
  if (!table) return;
  const q = ($('#proxy-search')?.value || '').trim().toLowerCase();
  const list = proxyLibrary.filter((item) => !q || [item.name, item.host, item.protocol, item.remark, item.lastIp, String(item.port)].join(' ').toLowerCase().includes(q));
  table.replaceChildren();
  for (const item of list) {
    const row = document.createElement('tr');
    const checkCell = document.createElement('td');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selectedProxies.has(item.id);
    check.dataset.proxySelect = item.id;
    checkCell.append(check);
    const host = `${item.host}:${item.port}`;
    const auth = item.authenticated ? t('common.confirm') : t('common.cancel');
    const exit = item.lastIp
      ? `${item.lastIp}${item.lastCountryCode ? ' · ' + item.lastCountryCode : ''}${item.lastCheckOk === false ? ' · 失败' : ''}`
      : (item.lastCheckOk === false ? (item.lastErrorClass || '失败') : '—');
    const latency = Number.isFinite(Number(item.lastLatencyMs)) ? `${Number(item.lastLatencyMs)}ms` : '—';
    const netType = item.lastNetworkType || '—';
    const actions = element('div', 'actions');
    const edit = element('button', 'mini edit', t('action.edit')); edit.dataset.proxyEdit = item.id;
    const test = element('button', 'mini blue', t('action.check')); test.dataset.proxyTest = item.id;
    const use = element('button', 'mini', t('action.use')); use.dataset.proxyUse = item.id;
    const del = element('button', 'mini', t('action.delete')); del.dataset.proxyDelete = item.id;
    actions.append(edit, test, use, del);
    const actionCell = document.createElement('td'); actionCell.append(actions);
    const proto = String(item.protocol || 'proxy').toUpperCase();
    const protoLabel = proto === 'SOCKS5' ? 'S5' : proto === 'HTTPS' ? 'HS' : proto === 'HTTP' ? 'HT' : proto.slice(0, 2);
    const nameCell = document.createElement('td');
    const nameWrap = element('div', 'profile-name env-identity');
    nameWrap.append(
      buildSquareMark(protoLabel, {
        color: proto.includes('SOCKS') ? '#22d3ee' : proto.includes('HTTPS') ? '#34d399' : '#245cff',
        title: proto,
        size: UI_MARK_SIZE,
        className: 'proxy-mark',
      }),
    );
    const nameText = document.createElement('div');
    nameText.className = 'env-identity-text';
    nameText.append(element('strong', '', item.name || host));
    nameText.append(element('small', '', host));
    nameWrap.append(nameText);
    nameCell.append(nameWrap);
    row.append(
      checkCell,
      nameCell,
      element('td', '', proto),
      element('td', '', host),
      element('td', '', auth),
      element('td', '', exit),
      element('td', '', latency),
      element('td', '', netType),
      element('td', '', item.remark || '—'),
      actionCell
    );
    table.append(row);
  }
  if (empty) empty.hidden = list.length !== 0;
  if (countEl) countEl.textContent = t('rpa.store.count', { n: proxyLibrary.length }).replace('templates', tx('条')) + (q ? ` · ${t('profiles.search').split('/')[0].trim()} ${list.length}` : '');
  const selectAll = $('#proxy-select-all');
  if (selectAll) {
    const ids = list.map((i) => i.id);
    const n = ids.filter((id) => selectedProxies.has(id)).length;
    selectAll.checked = ids.length > 0 && n === ids.length;
    selectAll.indeterminate = n > 0 && n < ids.length;
  }
}

async function refreshProxies() {
  try {
    proxyLibrary = await window.ops.proxyList({ q: $('#proxy-search')?.value || '' });
    if (!Array.isArray(proxyLibrary)) proxyLibrary = [];
  } catch (error) {
    proxyLibrary = [];
    toast('加载代理库失败：' + error.message);
  }
  renderProxies();
  afterUiRender(document.getElementById('view-proxies') || document);
}

function openProxyDialog(item = null) {
  $('#proxy-edit-id').value = item?.id || '';
  $('#proxy-dialog-title').textContent = item ? tx('编辑代理') : tx('新建代理');
  $('#proxy-name').value = item?.name || '';
  $('#proxy-protocol').value = item?.protocol || 'socks5';
  $('#proxy-ip-channel').value = item?.ipChannel || 'ip-api';
  $('#proxy-host').value = item?.host || '';
  $('#proxy-port').value = item?.port || '';
  $('#proxy-user').value = item?.username || '';
  $('#proxy-password').value = item?.password || '';
  $('#proxy-raw').value = '';
  $('#proxy-remark').value = item?.remark || '';
  const result = $('#proxy-dialog-result');
  result.className = 'proxy-test-result';
  result.textContent = item?.lastIp ? tx(`上次出口：${item.lastIp}`) : tx('保存前可先检测');
  syncThemedSelects($('#proxy-dialog'));
  $('#proxy-dialog').showModal();
}

function readProxyForm() {
  const raw = $('#proxy-raw').value.trim();
  return {
    id: $('#proxy-edit-id').value || undefined,
    name: $('#proxy-name').value.trim(),
    protocol: $('#proxy-protocol').value,
    host: $('#proxy-host').value.trim(),
    port: Number($('#proxy-port').value),
    username: $('#proxy-user').value,
    password: $('#proxy-password').value,
    raw: raw || undefined,
    ipChannel: $('#proxy-ip-channel').value,
    remark: $('#proxy-remark').value.trim(),
  };
}

function renderGroupFilterChips() {
  const host = $('#profile-group-chips');
  if (!host) return;
  host.replaceChildren();
  const mk = (id, label, count) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'group-chip' + (activeGroupFilter === id ? ' active' : '');
    btn.dataset.groupFilter = id;
    const g = findGroup(id);
    if (g?.color) btn.style.setProperty('--chip-color', g.color);
    const dot = document.createElement('span');
    dot.className = 'dot';
    const text = document.createElement('span');
    text.textContent = label;
    const badge = document.createElement('b');
    badge.textContent = String(count);
    btn.append(dot, text, badge);
    return btn;
  };
  host.append(mk('all', t('groups.all'), ui.profiles.length));
  host.append(mk('ungrouped', t('groups.ungrouped'), countProfilesInGroup('ungrouped')));
  for (const g of listGroups()) {
    host.append(mk(g.id, localizeSystemLabel(g.name), countProfilesInGroup(g.id)));
  }
}

function updateProfileSelectionUi() {
  const count = selectedProfiles.size;
  const bar = $('#profile-selection-bar');
  const label = $('#profile-selection-count');
  if (label) label.textContent = t('profiles.selected', { n: count });
  if (bar) {
    bar.hidden = count === 0;
    bar.classList.toggle('is-visible', count > 0);
  }
  $$('#profile-table tr[data-profile-id]').forEach((row) => {
    row.classList.toggle('selected-row', selectedProfiles.has(row.dataset.profileId));
  });
  const visibleCheckboxes = $$('#profile-table [data-profile-select]');
  const selectedOnPage = visibleCheckboxes.filter((input) => selectedProfiles.has(input.dataset.profileSelect)).length;
  const selectAll = $('#select-all-profiles');
  if (selectAll) {
    selectAll.checked = visibleCheckboxes.length > 0 && selectedOnPage === visibleCheckboxes.length;
    selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < visibleCheckboxes.length;
  }
}

function setStartingProgress(id, progress = {}) {
  if (!id) return;
  const prev = startingProfiles.get(id) || {};
  const percentRaw = Number(progress.percent);
  const percent = Number.isFinite(percentRaw)
    ? Math.max(0, Math.min(100, Math.round(percentRaw)))
    : (START_PROGRESS_PHASES[progress.phase] ?? prev.percent ?? 8);
  startingProfiles.set(id, {
    phase: progress.phase || prev.phase || 'prepare',
    percent,
    message: progress.message || prev.message || t('status.starting'),
    updatedAt: Date.now(),
  });
}

function clearStartingProgress(id) {
  if (id) startingProfiles.delete(id);
  else startingProfiles.clear();
}

function startProgressLabel(progress) {
  if (!progress) return t('status.starting');
  const phaseKey = progress.phase ? `status.startPhase.${progress.phase}` : '';
  const phaseText = phaseKey && t(phaseKey) !== phaseKey ? t(phaseKey) : '';
  if (phaseText) return phaseText;
  if (progress.message) return progress.message;
  return t('status.starting');
}

function buildStartProgressCell(profileId, progress) {
  const wrap = element('div', 'start-progress');
  wrap.dataset.profileId = profileId;
  wrap.dataset.phase = progress?.phase || 'prepare';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');
  const label = element('span', 'start-progress-label', startProgressLabel(progress));
  const track = element('div', 'start-progress-track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  const percent = Math.max(0, Math.min(100, Number(progress?.percent) || 8));
  track.setAttribute('aria-valuenow', String(percent));
  track.setAttribute('aria-label', startProgressLabel(progress));
  const fill = element('div', 'start-progress-fill');
  fill.style.width = `${percent}%`;
  const shimmer = element('span', 'start-progress-shimmer');
  fill.append(shimmer);
  track.append(fill);
  const pct = element('span', 'start-progress-percent', `${percent}%`);
  wrap.append(label, track, pct);
  wrap.title = progress?.message || startProgressLabel(progress);
  return wrap;
}

function renderProfiles() {
  renderGroupFilterChips();
  const filter = $('#profile-search').value.trim().toLowerCase();
  const table = $('#profile-table'); table.replaceChildren();
  let filtered = ui.profiles.filter((profile) => {
    if (activeGroupFilter === 'ungrouped') return !profile.groupId;
    if (activeGroupFilter !== 'all' && profile.groupId !== activeGroupFilter) return false;
    return true;
  });
  filtered = filtered.filter((profile) => [profile.id, displayProfileNumber(profile), profile.browser, profile.proxy, profile.tag, groupNameOf(profile)].join(' ').toLowerCase().includes(filter));
  const totalPages = Math.max(1, Math.ceil(filtered.length / profilePageSize));
  profilePage = Math.min(Math.max(1, profilePage), totalPages);
  const pageStart = (profilePage - 1) * profilePageSize;
  const visible = filtered.slice(pageStart, pageStart + profilePageSize);
  for (const profile of visible) {
    const info = profileEngine(profile.id); const row = document.createElement('tr');
    row.dataset.profileId = profile.id;
    const selectCell = document.createElement('td'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedProfiles.has(profile.id); checkbox.dataset.profileSelect = profile.id; selectCell.append(checkbox);
    const idCell = element('td', 'col-num', displayProfileNumber(profile));
    const nameCell = document.createElement('td');
    nameCell.append(buildEnvIdentity(profile));
    const groupCell = document.createElement('td');
    groupCell.className = 'col-group';
    const badge = element('span', 'group-badge group-badge-compact', groupNameOf(profile));
    badge.style.setProperty('--chip-color', groupColorOf(profile));
    badge.title = groupNameOf(profile);
    groupCell.append(badge);
    const browserCell = document.createElement('td');
    browserCell.className = 'col-browser';
    browserCell.append(buildEnvBrowserCell(profile));
    const proxyCell = document.createElement('td');
    proxyCell.className = 'col-network';
    proxyCell.append(networkModeBadge(profile.proxy));
    const networkCell = document.createElement('td');
    networkCell.className = 'col-exit';
    const network = info.network || (profile.exitIp ? { ip: profile.exitIp, countryCode: profile.exitCountryCode, checkedAt: profile.exitCheckedAt } : null);
    const networkInfo = element('div', 'network-info network-info-compact');
    if (network?.ip) {
      const code = String(network.countryCode || '').toUpperCase();
      const line = element('span', 'exit-compact', (code ? countryFlag(code) + ' ' + code : '🌐') + (network.ip ? ' · ' + String(network.ip).replace(/^(\d+\.\d+)\.\d+\.\d+$/, '$1.*.*') : ''));
      line.title = (network.ip || '') + (code ? ' · ' + countryName(code) : '');
      networkInfo.append(line);
    } else {
      networkInfo.append(element('span', 'network-pending', isDirectProxy(profile.proxy) ? t('net.localHost') : t('net.untested')));
    }
    if (!isDirectProxy(profile.proxy)) {
      const inspect = element('button', 'network-check', t('action.check'));
      inspect.title = network?.ip ? t('action.recheck') : t('action.checkExit');
      inspect.dataset.proxyCheck = profile.id;
      networkInfo.append(inspect);
    }
    networkCell.append(networkInfo);
    const extensionCell = element('td', 'col-ext', String(info.assignedExtensions?.length || 0));
    const statusCell = document.createElement('td');
    statusCell.className = 'col-status';
    const starting = !info.running && startingProfiles.has(profile.id);
    if (starting) {
      statusCell.append(buildStartProgressCell(profile.id, startingProfiles.get(profile.id)));
      row.classList.add('is-starting');
    } else {
      const status = element('span', `status status-compact ${info.running ? 'running' : ''}`, info.running ? t('status.run') : t('status.stop'));
      if (info.running && info.port) status.title = t('status.runningCdp', { port: info.port });
      statusCell.append(status);
    }
    const actionCell = document.createElement('td');
    actionCell.className = 'col-actions';
    const actions = element('div', 'actions');
    const toggle = element('button', 'mini', info.running ? t('action.stop') : (starting ? t('status.starting') : t('action.start')));
    toggle.dataset.action = info.running ? 'stop' : 'start';
    toggle.dataset.id = profile.id;
    if (starting) {
      toggle.disabled = true;
      toggle.classList.add('is-starting');
      toggle.title = startProgressLabel(startingProfiles.get(profile.id));
    }
    const sync = element('button', 'mini blue', t('action.sync')); sync.dataset.action = 'select-sync'; sync.dataset.id = profile.id; sync.disabled = !info.running || starting; sync.title = t('profiles.syncSelect');
    const edit = element('button', 'mini edit', t('action.edit')); edit.dataset.action = 'edit'; edit.dataset.id = profile.id;
    actions.append(toggle, sync, edit); actionCell.append(actions);
    row.append(selectCell, idCell, nameCell, groupCell, browserCell, proxyCell, networkCell, extensionCell, statusCell, actionCell); table.append(row);
  }
  $('#profile-empty').hidden = filtered.length !== 0;
  $('#profile-total').textContent = String(filtered.length);
  const totalLabel = document.querySelector('#profile-pagination .profile-total');
  if (totalLabel) {
    // Keep strong#profile-total as number; wrap prefix via data-i18n or rebuild
    const strong = totalLabel.querySelector('#profile-total');
    const num = String(filtered.length);
    if (strong) {
      totalLabel.replaceChildren(document.createTextNode(t('profiles.totalLabel')), strong);
      strong.textContent = num;
    } else {
      totalLabel.textContent = t('profiles.totalLabel') + num;
    }
  }
  const pageSize = $('#profile-page-size');
  if (pageSize) {
    const prev = pageSize.value;
    [...pageSize.options].forEach((opt) => {
      opt.textContent = t('profiles.perPageOpt', { n: opt.value });
    });
    pageSize.value = prev || String(profilePageSize);
  }
  $('#profile-page').value = String(profilePage);
  $('#profile-page').max = String(totalPages);
  $('#profile-pages').textContent = String(totalPages);
  $('#profile-page-size').value = String(profilePageSize);
  $('#profile-prev').disabled = profilePage <= 1;
  $('#profile-next').disabled = profilePage >= totalPages;
  const pageIds = visible.map((profile) => profile.id);
  const selectedOnPage = pageIds.filter((id) => selectedProfiles.has(id)).length;
  const selectAll = $('#select-all-profiles');
  selectAll.checked = pageIds.length > 0 && selectedOnPage === pageIds.length;
  selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < pageIds.length;
  updateProfileSelectionUi();
  // Translate any remaining Chinese chrome text that was just injected
  afterUiRender(document.getElementById('view-profiles') || document);
}

function visibleProfilePageIds() {
  const filter = $('#profile-search').value.trim().toLowerCase();
  const filtered = ui.profiles.filter((profile) => [profile.id, displayProfileNumber(profile), profile.browser, profile.proxy, profile.tag].join(' ').toLowerCase().includes(filter));
  const totalPages = Math.max(1, Math.ceil(filtered.length / profilePageSize));
  const page = Math.min(Math.max(1, profilePage), totalPages);
  const pageStart = (page - 1) * profilePageSize;
  return filtered.slice(pageStart, pageStart + profilePageSize).map((profile) => profile.id);
}

async function refreshStatus() {
  engineProfiles = await window.ops.profileStatus(); renderProfiles();
}

async function startProfile(id) {
  const profile = ui.profiles.find((item) => item.id === id); if (!profile) return;
  if (profileEngine(id).running || startingProfiles.has(id)) return;
  const payload = {
    ...profile,
    group_name: groupNameRaw(profile) || '',
  };
  setStartingProgress(id, { phase: 'prepare', percent: 6, message: t('status.starting') });
  renderProfiles();
  try {
    const result = await window.ops.startProfile(payload);
    setStartingProgress(id, { phase: 'ready', percent: 100, message: t('status.startPhase.ready') });
    log('Browser', `${displayProfileNumber(profile)} 已启动 · ${result.browser} · CDP ${result.port || 'pending'}`);
    toast(tx(`${displayProfileNumber(profile)} 已启动`));
    await refreshStatus();
    await refreshSessions();
  } catch (error) {
    log('Error', error.message);
    toast(tx(`启动失败：${error.message}`));
  } finally {
    clearStartingProgress(id);
    await refreshStatus();
  }
}

async function stopProfile(id) {
  try { await window.ops.stopProfile(id); const profile = ui.profiles.find((item) => item.id === id); log('Browser', `${profile?.name || id} 已停止`); await refreshStatus(); await refreshSessions(); }
  catch (error) { log('Error', error.message); toast(tx(`停止失败：${error.message}`)); }
}

async function checkProfileProxy(id) {
  const profile = ui.profiles.find((item) => item.id === id); if (!profile) return;
  try {
    toast('正在通过环境 ' + displayProfileNumber(profile) + ' 的代理检测出口 IP...');
    const result = await window.ops.checkProfileProxy(profile);
    profile.exitIp = result.ip; profile.exitCountryCode = result.countryCode; profile.exitTimezone = result.timezone || ''; profile.exitLatitude = result.latitude; profile.exitLongitude = result.longitude; profile.exitCheckedAt = result.checkedAt;
    if (Number.isFinite(Number(result.latencyMs))) profile.exitLatencyMs = Number(result.latencyMs);
    if (result.networkType) profile.exitNetworkType = result.networkType;
    if (result.appliedFingerprint?.language) profile.language = result.appliedFingerprint.language;
    if (result.appliedFingerprint?.privacy) profile.privacy = { ...(profile.privacy || {}), ...result.appliedFingerprint.privacy };
    save();
    const number = displayProfileNumber(profile); await refreshStatus(); renderProfiles();
    const detail = formatProxyCheckResult(result);
    log('Proxy', '环境 ' + number + ' 出口检测成功 · ' + detail);
    toast('环境 ' + number + ' 出口：' + detail);
  } catch (error) { log('Proxy', '环境 ' + displayProfileNumber(profile) + ' 检测失败 · ' + error.message); toast('代理检测失败：' + error.message); }
}

function extensionIcon(name) { return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(); }

function createExtensionIcon(item) {
  const label = extensionIcon(item.name || 'OB');
  const icon = buildSquareMark(label, {
    color: item.builtIn || item.source === 'builtin' ? '#245cff' : '#a78bfa',
    title: item.name || tx('扩展'),
    size: UI_MARK_SIZE,
    className: 'extension-icon',
  });
  const iconUrl = String(item.iconUrl || item.icon_url || '');
  if (!/^(https:|file:|data:)/i.test(iconUrl)) return icon;
  const image = document.createElement('img');
  image.alt = '';
  image.loading = 'lazy';
  image.referrerPolicy = 'no-referrer';
  image.src = iconUrl;
  image.addEventListener('error', () => {
    icon.classList.remove('has-image');
    icon.replaceChildren();
    const num = document.createElement('span');
    num.className = 'env-badge-num';
    num.textContent = label;
    if (label.length >= 3) num.classList.add('env-badge-num-sm');
    icon.append(num);
  }, { once: true });
  icon.classList.add('has-image');
  icon.replaceChildren(image);
  return icon;
}

function renderAppCenterTabs() {
  $$('#app-center-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.appTab === appCenterTab));
  const counts = appCenterData.counts || {};
  const countsEl = $('#extension-counts');
  if (countsEl) countsEl.textContent = tx(`自带 ${counts.builtin || 0} · 推荐 ${counts.recommended || 0} · 本地 ${counts.local || counts.installed || 0}`);
}

function renderExtensions() {
  renderAppCenterTabs();
  const query = $('#extension-search').value.trim().toLowerCase();
  const grid = $('#extension-grid');
  grid.replaceChildren();

  if (appCenterTab === 'recommended') {
    const list = (appCenterData.recommended || []).filter((item) => [item.name, item.description, item.category, ...(item.tags || [])].join(' ').toLowerCase().includes(query));
    for (const app of list) {
      const card = element('article', 'extension-card recommended');
      const top = element('div', 'extension-top');
      top.append(createExtensionIcon(app));
      if (app.installed) top.append(element('span', 'status running', tx('已安装')));
      card.append(top, element('h3', '', app.name), element('p', '', app.description || 'Chrome Web Store'));
      const meta = element('div', 'extension-meta');
      meta.append(element('span', '', app.category || 'app'), element('span', '', app.installed ? `已启用环境 ${app.assigned_profiles || 0}` : '商店安装'));
      card.append(meta);
      const actions = element('div', 'card-actions');
      if (app.installed && app.extension_id) {
        const assign = element('button', 'primary', tx('批量分配'));
        assign.dataset.extensionAssign = app.extension_id;
        actions.append(assign);
      } else {
        const install = element('button', 'primary', tx('安装'));
        install.dataset.storeInstall = app.store_url || app.store_id;
        actions.append(install);
      }
      card.append(actions);
      grid.append(card);
    }
    $('#extension-empty').hidden = list.length !== 0;
    if (!list.length) $('#extension-empty').textContent = query ? tx('没有匹配的推荐应用') : tx('暂无推荐应用');
    return;
  }

  const sourceList = appCenterTab === 'builtin'
    ? (appCenterData.builtin || []).map((item) => {
      const full = extensions.find((ext) => ext.id === item.extension_id || ext.id === item.id);
      return full || {
        id: item.extension_id || item.id,
        name: item.name,
        description: item.description,
        version: item.version || '-',
        manifestVersion: item.manifest_version || 3,
        source: item.source,
        builtIn: item.source === 'builtin',
        enabledAll: item.enabled_all,
        assignedProfiles: item.assigned_profiles || 0,
        assignedProfileIds: [],
        iconUrl: item.icon_url || null,
      };
    })
    : extensions;

  const visible = sourceList.filter((item) => [item.name, item.description, item.version].join(' ').toLowerCase().includes(query));
  for (const extension of visible) {
    const card = element('article', 'extension-card');
    const top = element('div', 'extension-top');
    const toggleLabel = element('label', 'extension-toggle');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = extension.enabledAll;
    toggle.dataset.extensionToggle = extension.id;
    toggle.indeterminate = !extension.enabledAll && Number(extension.assignedProfiles) > 0;
    toggleLabel.title = extension.enabledAll ? tx('全部环境已启用') : toggle.indeterminate ? tx('部分环境已启用') : tx('全部环境已停用');
    toggleLabel.append(toggle, element('span', 'extension-toggle-slider'));
    top.append(createExtensionIcon(extension), toggleLabel);
    card.append(top, element('h3', '', extension.name), element('p', '', extension.description || 'Local unpacked Chrome extension'));
    const meta = element('div', 'extension-meta');
    meta.append(
      element('span', '', `v${extension.version} · MV${extension.manifestVersion} · ${extension.source || (extension.builtIn ? '内置' : '本地')}`),
      element('span', '', `已启用 ${extension.assignedProfiles}/${ui.profiles.length}`)
    );
    card.append(meta);
    const actions = element('div', 'card-actions');
    const assign = element('button', 'primary', tx('批量分配'));
    assign.dataset.extensionAssign = extension.id;
    actions.append(assign);
    if (!extension.builtIn) {
      const remove = element('button', 'outline', tx('移除'));
      remove.dataset.extensionRemove = extension.id;
      actions.append(remove);
    }
    card.append(actions);
    grid.append(card);
  }
  $('#extension-empty').hidden = visible.length !== 0;
  if (!visible.length) $('#extension-empty').textContent = appCenterTab === 'builtin' ? tx('暂无自带应用') : tx('尚未添加扩展');
}

async function refreshExtensions() {
  extensions = await window.ops.extensionList();
  try {
    const payload = await window.ops.appCenterList({ tab: 'all' });
    if (payload?.list && !Array.isArray(payload.list)) {
      appCenterData = {
        builtin: payload.list.builtin || [],
        recommended: payload.list.recommended || [],
        local: payload.list.local || [],
        counts: payload.counts || {},
      };
    } else {
      appCenterData = { builtin: [], recommended: [], local: extensions, counts: { builtin: 0, recommended: 0, local: extensions.length, installed: extensions.length } };
    }
  } catch (_) {
    appCenterData = {
      builtin: extensions.filter((item) => item.builtIn),
      recommended: [],
      local: extensions,
      counts: { builtin: 0, recommended: 0, local: extensions.length, installed: extensions.length },
    };
  }
  renderExtensions();
  hydrateAppCenterIcons().catch(() => {});
}

async function hydrateAppCenterIcons() {
  const items = [...(appCenterData.recommended || []), ...(appCenterData.local || []), ...(appCenterData.builtin || [])];
  const missingStoreIds = [...new Set(items
    .filter((item) => {
      const storeId = item.store_id || item.storeId || item.chromeId;
      const hasIcon = Boolean(item.icon_url || item.iconUrl);
      return storeId && !hasIcon;
    })
    .map((item) => item.store_id || item.storeId || item.chromeId)
    .filter(Boolean))];
  if (!missingStoreIds.length) return;

  let changed = false;
  // Prefer page/CRX metadata; fall back to dedicated icon scrape (both return data: URLs)
  const [metadata, icons] = await Promise.all([
    window.ops.appCenterMetadata?.(missingStoreIds).catch(() => ({})) || {},
    window.ops.appCenterIcons?.(missingStoreIds).catch(() => ({})) || {},
  ]);

  for (const item of items) {
    const storeId = item.store_id || item.storeId || item.chromeId;
    if (!storeId) continue;
    const meta = metadata?.[storeId];
    const iconUrl = meta?.icon_url || icons?.[storeId] || null;
    if (iconUrl && item.icon_url !== iconUrl && item.iconUrl !== iconUrl) {
      item.icon_url = iconUrl;
      item.iconUrl = iconUrl;
      changed = true;
    }
    if (meta?.description && item.description !== meta.description) {
      item.description = meta.description;
      changed = true;
    }
    if (meta?.name && !item.name) {
      item.name = meta.name;
      changed = true;
    }
  }
  if (changed) renderExtensions();
  afterUiRender(document.getElementById('view-extensions') || document);
}

function openAssign(id) {
  currentExtension = extensions.find((item) => item.id === id); if (!currentExtension) return;
  $('#assign-extension-name').textContent = tx(`${currentExtension.name} · 运行中的环境需重启后生效`);
  const list = $('#assign-profile-list'); list.replaceChildren();
  const assigned = new Set(currentExtension.assignedProfileIds || []);
  for (const profile of ui.profiles) { const label = element('label', 'assign-item'); const input = document.createElement('input'); input.type = 'checkbox'; input.value = profile.id; input.checked = assigned.has(profile.id); label.append(input, element('span', '', '环境 ' + displayProfileNumber(profile))); list.append(label); }
  $('#assign-dialog').showModal();
}

async function applyAssignment(enabled) {
  const ids = $$('#assign-profile-list input:checked').map((input) => input.value); if (!ids.length) return toast(tx('请先选择环境'));
  const result = await window.ops.assignExtension(currentExtension.id, ids, enabled); $('#assign-dialog').close(); await refreshExtensions(); await refreshStatus();
  log('Extension', `${currentExtension.name} ${enabled ? '添加到' : '移出'} ${ids.length} 个环境`);
  toast(result.restartRequired?.length ? `已保存；${result.restartRequired.length} 个运行环境需重启` : '批量分配已生效');
}

function orderedSelectedSessionIds() {
  const ids = [...selectedSessions];
  if (!preferredMasterId || !selectedSessions.has(preferredMasterId)) preferredMasterId = ids[0] || null;
  return preferredMasterId ? [preferredMasterId, ...ids.filter((id) => id !== preferredMasterId)] : ids;
}

function populateSyncGroups() {
  const select = $('#sync-group'); const current = select.value || 'all'; const groups = [...new Set(sessions.map((item) => String(item.profile?.tag || '未分组')))].sort();
  select.replaceChildren(); const all = document.createElement('option'); all.value = 'all'; all.textContent = tx('全部分组'); select.append(all);
  for (const group of groups) { const option = document.createElement('option'); option.value = group; option.textContent = group; select.append(option); }
  select.value = [...select.options].some((option) => option.value === current) ? current : 'all';
}

function renderSessions() {
  populateSyncGroups(); const group = $('#sync-group').value || 'all'; const visible = group === 'all' ? sessions : sessions.filter((item) => String(item.profile?.tag || t('groups.ungrouped')) === group);
  const table = $('#session-table'); table.replaceChildren();
  for (const value of visible) {
    const selected = selectedSessions.has(value.id);
    const role = syncState.active && syncState.master === value.id ? t('tag.master') : syncState.active && syncState.selected.includes(value.id) ? t('tag.workgroup') : selected && preferredMasterId === value.id ? t('tag.master') : selected ? t('action.use') : t('status.stopped');
    const row = document.createElement('tr');
    if (selected) row.classList.add('selected-row');
    if ((syncState.active && syncState.master === value.id) || (!syncState.active && preferredMasterId === value.id && selected)) row.classList.add('master-row');
    const selectCell = document.createElement('td'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected; checkbox.disabled = syncState.active; checkbox.dataset.sessionSelect = value.id; selectCell.append(checkbox);
    const statusCell = document.createElement('td'); statusCell.append(element('span', 'sync-role', role));
    const actionCell = document.createElement('td'); actionCell.className = 'sync-actions';
    const master = element('button', 'sync-show', preferredMasterId === value.id ? t('tag.master') : t('action.use')); master.dataset.masterSelect = value.id; master.disabled = syncState.active || !selected;
    const show = element('button', 'sync-show', t('action.preview')); show.dataset.showWindow = value.id; actionCell.append(master, show);
    const profile = value.profile || { id: value.id, number: value.id };
    const number = displayProfileNumber(profile);
    const idCell = document.createElement('td');
    idCell.append(buildEnvBadge(profile, UI_MARK_SIZE));
    const nameCell = document.createElement('td');
    nameCell.append(element('strong', '', (profile.title && String(profile.title) !== String(number)) ? profile.title : (t('profiles.envName', { n: number }))));
    const browserCell = document.createElement('td');
    browserCell.append(buildEnvBrowserCell(profile));
    row.append(selectCell, idCell, nameCell, browserCell, element('td', '', String(value.tabs.length)), statusCell, actionCell); table.append(row);
  }
  $('#session-empty').style.display = visible.length ? 'none' : 'block';
  $('#selected-count').textContent = t('profiles.selected', { n: selectedSessions.size });
  $('#sync-selected').textContent = t('profiles.selected', { n: selectedSessions.size });
  const allBox = $('#select-all-sessions'); allBox.checked = visible.length > 0 && visible.every((item) => selectedSessions.has(item.id)); allBox.indeterminate = visible.some((item) => selectedSessions.has(item.id)) && !allBox.checked;
  renderSyncState(); renderTabInventory();
  afterUiRender(document.getElementById('view-sync') || document);
}

function renderSyncState() {
  $('#start-sync').hidden = syncState.active;
  $('#stop-sync').hidden = !syncState.active;
  $('#restart-sync').disabled = selectedSessions.size < 2;
  $('#select-all-sessions').disabled = syncState.active; $('#sync-group').disabled = syncState.active;
  const health = $('#sync-health');
  if (!health) return;
  if (!syncState.active) { health.className = 'sync-health idle'; health.textContent = t('sync.idle'); }
  else if (syncHealth.recovering) { health.className = 'sync-health warning'; health.textContent = t('sync.recovering'); }
  else if (syncHealth.queueDepth > 24 || syncHealth.lastLatencyMs > 800) { health.className = 'sync-health warning'; health.textContent = tx(`同步繁忙 · 队列 ${syncHealth.queueDepth}`); }
  else { health.className = 'sync-health healthy'; health.textContent = tx(`同步正常 · ${syncHealth.lastLatencyMs || 0}ms`); }
}

function pushSyncSelection() {
  if (syncState.active) return renderSyncState();
  const ids = orderedSelectedSessionIds(); syncState.selected = ids;
  window.ops.setSyncSelection(ids).catch((error) => log('Error', error.message));
  renderSyncState();
}

function renderTabInventory() {
  const target = $('#tab-inventory'); target.replaceChildren();
  for (const value of sessions.filter((item) => selectedSessions.has(item.id))) { const group = element('div', 'tab-group'); group.append(element('strong', '', `${t('profiles.envName', { n: displayProfileNumber(value.profile || { id: value.id }) })} · ${value.tabs.length} ${t('common.tabs')}`)); for (const tab of value.tabs.slice(0, 6)) group.append(element('span', '', `${tab.title || 'Untitled'} — ${tab.url}`)); target.append(group); }
}

async function refreshSessions() {
  try {
    const previous = new Set(selectedSessions); sessions = await window.ops.syncSessions(); const live = new Set(sessions.map((item) => item.id));
    if (syncState.active) selectedSessions = new Set((syncState.selected || []).filter((id) => live.has(id)));
    else if (!sessionsInitialized) selectedSessions = new Set(sessions.map((item) => item.id));
    else selectedSessions = new Set([...previous].filter((id) => live.has(id)));
    sessionsInitialized = true; if (!selectedSessions.has(preferredMasterId)) preferredMasterId = orderedSelectedSessionIds()[0] || null;
    if (!syncState.active) pushSyncSelection(); renderSessions();
  } catch (error) { log('CDP', error.message); }
}
function selectedSessionIds(minimum = 1) { const ids = orderedSelectedSessionIds(); if (ids.length < minimum) throw new Error(`请至少选择 ${minimum} 个运行环境`); return ids; }
function specifiedTextItems(value) {
  return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function distributeSpecifiedTexts(items, count, mode = 'sequence', cursor = 0, random = Math.random) {
  const values = Array.isArray(items) ? items.map((item) => String(item)).filter((item) => item.length > 0) : [];
  const amount = Math.max(0, Number.parseInt(count, 10) || 0);
  if (!values.length || !amount) return { texts: [], nextCursor: Math.max(0, Number.parseInt(cursor, 10) || 0) };
  if (mode === 'random') {
    return {
      texts: Array.from({ length: amount }, () => values[Math.min(values.length - 1, Math.max(0, Math.floor(Number(random()) * values.length)))]),
      nextCursor: Math.max(0, Number.parseInt(cursor, 10) || 0)
    };
  }
  const start = ((Number.parseInt(cursor, 10) || 0) % values.length + values.length) % values.length;
  return { texts: Array.from({ length: amount }, (_unused, index) => values[(start + index) % values.length]), nextCursor: (start + amount) % values.length };
}

function saveSpecifiedTextGroups() {
  try {
    localStorage.setItem(SPECIFIED_TEXT_GROUPS_KEY, JSON.stringify(specifiedTextGroups.map(({ id, mode, text, cursor }) => ({ id, mode, text, cursor }))));
  } catch (_) {}
}

function renderSpecifiedTextGroups() {
  const target = $('#specified-text-groups'); if (!target) return;
  target.replaceChildren();
  specifiedTextGroups.forEach((group, index) => {
    const card = element('article', 'specified-text-group'); card.dataset.specifiedGroup = group.id;
    const head = element('div', 'specified-text-group-head');
    head.append(element('strong', '', '\u6587\u672c\u7ec4' + (index + 1)));
    const remove = element('button', 'specified-text-remove', '\u5220\u9664'); remove.type = 'button'; remove.dataset.specifiedRemove = group.id; remove.hidden = specifiedTextGroups.length <= 1; head.append(remove);
    const modes = element('div', 'specified-text-modes');
    for (const [value, labelText] of [['sequence', '\u987a\u5e8f\u8f93\u5165'], ['random', '\u968f\u673a\u8f93\u5165']]) {
      const label = document.createElement('label'); const input = document.createElement('input');
      input.type = 'radio'; input.name = 'specified-mode-' + group.id; input.value = value; input.checked = group.mode === value; input.dataset.specifiedMode = group.id;
      label.append(input, document.createTextNode(labelText)); modes.append(label);
    }
    const textarea = document.createElement('textarea'); textarea.value = group.text; textarea.dataset.specifiedText = group.id; textarea.placeholder = '\u6bcf\u884c\u4e00\u6761\u6587\u672c\uff0c\u8f93\u5165\u65f6\u6309\u73af\u5883\u5206\u914d';
    const foot = element('div', 'specified-text-group-foot');
    const count = element('span', 'specified-text-count', specifiedTextItems(group.text).length + ' \u6761\u6587\u672c'); count.dataset.specifiedCount = group.id;
    const send = element('button', 'specified-text-send', '\u8f93\u5165 (Shift+F1)'); send.type = 'button'; send.dataset.specifiedSend = group.id;
    foot.append(count, send); card.append(head, modes, textarea, foot); target.append(card);
  });
}

function specifiedTextSessionIds() {
  return selectedSessionIds().sort((left, right) => {
    const leftSession = sessions.find((item) => item.id === left);
    const rightSession = sessions.find((item) => item.id === right);
    const leftNumber = String(displayProfileNumber(leftSession?.profile || { id: left }));
    const rightNumber = String(displayProfileNumber(rightSession?.profile || { id: right }));
    return leftNumber.localeCompare(rightNumber, 'zh-CN', { numeric: true, sensitivity: 'base' }) || String(left).localeCompare(String(right));
  });
}

function specifiedTextFailureLabel(id) {
  const session = sessions.find((item) => item.id === id);
  return displayProfileNumber(session?.profile || { id });
}

async function sendSpecifiedTextGroup(id) {
  const group = specifiedTextGroups.find((item) => item.id === id); if (!group) return;
  let ids;
  try { ids = specifiedTextSessionIds(); } catch (error) { return toast(error.message); }
  const items = specifiedTextItems(group.text); if (!items.length) return toast('\u8bf7\u5148\u5728\u6587\u672c\u7ec4\u4e2d\u6bcf\u884c\u586b\u5199\u4e00\u6761\u6587\u672c');
  const assignment = distributeSpecifiedTexts(items, ids.length, group.mode, group.cursor);
  const [delayMin, delayMax] = textDelayRange();
  const button = document.querySelector('[data-specified-send="' + id + '"]'); if (button) button.disabled = true;
  try {
    const label = group.mode === 'random' ? '\u968f\u673a\u6307\u5b9a\u6587\u672c' : '\u987a\u5e8f\u6307\u5b9a\u6587\u672c';
    const result = await window.ops.batchTextAction(ids, assignment.texts, delayMin, delayMax);
    log('Sync', label + ' \u00b7 ' + JSON.stringify(result));
    if (!result?.success) {
      const failed = (result?.failures || []).map((item) => specifiedTextFailureLabel(item.id));
      const suffix = failed.length ? '\uff1b\u8bf7\u5148\u5728\u73af\u5883 ' + failed.join('\u3001') + ' \u4e2d\u70b9\u51fb\u4f60\u8981\u8f93\u5165\u7684\u4f4d\u7f6e' : '';
      return toast('\u6307\u5b9a\u6587\u672c\u4ec5\u5199\u5165 ' + (result?.profiles?.length || 0) + '/' + ids.length + ' \u4e2a\u73af\u5883' + suffix);
    }
    if (group.mode === 'sequence') { group.cursor = assignment.nextCursor; saveSpecifiedTextGroups(); }
    toast(label + '\u5b8c\u6210\uff1a' + result.profiles.length + '/' + ids.length + ' \u4e2a\u73af\u5883\u5df2\u5b9e\u9645\u5199\u5165');
  } catch (error) { log('Error', error.message); toast(error.message); }
  finally { if (button) button.disabled = false; }
}
function normalizeUrl(value) { const raw = String(value || '').trim(); if (!raw) return 'about:blank'; if (/^(https?:\/\/|about:)/i.test(raw)) return raw; return `https://${raw}`; }

function normalizedProxyType(value) {
  const protocol = String(value || '').toLowerCase();
  return ['http', 'https', 'socks5'].includes(protocol) ? protocol : 'socks5';
}
function normalizeProxy(value, selectedType = 'socks5') {
  let raw = String(value || '').trim(); if (!raw || /^(direct|offline|none)$/i.test(raw)) return 'Direct';
  raw = raw.replace(/^sock(?:s)?5s?:\/\//i, 'socks5://');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  const parts = raw.split(':'); if (![2, 4].includes(parts.length) && parts.length < 4) throw new Error('\u4ee3\u7406\u683c\u5f0f\u5e94\u4e3a IP:\u7aef\u53e3 \u6216 IP:\u7aef\u53e3:\u7528\u6237\u540d:\u5bc6\u7801');
  const host = parts[0]; const port = Number(parts[1]); if (!/^[a-zA-Z0-9._-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('\u4ee3\u7406 IP \u6216\u7aef\u53e3\u65e0\u6548');
  const protocol = normalizedProxyType(selectedType);
  if (parts.length === 2) return protocol + '://' + host + ':' + port;
  const username = parts[2]; const password = parts.slice(3).join(':'); if (!username || !password) throw new Error('\u4ee3\u7406\u7528\u6237\u540d\u548c\u5bc6\u7801\u4e0d\u80fd\u4e3a\u7a7a');
  return protocol + '://' + encodeURIComponent(username) + ':' + encodeURIComponent(password) + '@' + host + ':' + port;
}
function proxyLines(textareaId, typeId) { return $(textareaId).value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).map((item) => normalizeProxy(item, $(typeId).value)); }
async function verifyProxyAssignments(profiles, proxies) {
  if (profiles.length !== proxies.length) throw new Error('\u4ee3\u7406\u6570\u91cf\u5fc5\u987b\u4e0e\u73af\u5883\u6570\u91cf\u4e00\u81f4\uff0c\u786e\u4fdd\u6bcf\u4e2a\u73af\u5883\u7ed1\u5b9a\u81ea\u5df1\u7684\u4ee3\u7406');
  const results = [];
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index]; toast('\u6b63\u5728\u68c0\u6d4b\u4ee3\u7406 ' + (index + 1) + '/' + profiles.length + '\uff08\u73af\u5883 ' + displayProfileNumber(profile) + '\uff09...');
    try { results.push(await window.ops.testProfileProxy({ ...profile, proxy: proxies[index] })); }
    catch (error) { throw new Error('\u73af\u5883 ' + displayProfileNumber(profile) + ' \u4ee3\u7406\u4e0d\u53ef\u7528\uff1a' + error.message); }
  }
  return results;
}
function installProxyTypeControl(textareaId, selectId) {
  const textarea = $(textareaId); if (!textarea || $(selectId)) return;
  const label = document.createElement('label'); label.className = 'proxy-type-field'; label.dataset.proxyFor = textarea.id; label.textContent = '\u4ee3\u7406\u7c7b\u578b\uff08\u672a\u586b\u5199\u524d\u7f00\u65f6\u4f7f\u7528\uff09';
  const select = document.createElement('select'); select.id = selectId;
  for (const [value, text] of [['socks5', 'SOCKS5'], ['http', 'HTTP'], ['https', 'HTTPS']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
  label.append(select);
  const note = element('p', 'store-note', '\u53ef\u76f4\u63a5\u8f93\u5165 IP:\u7aef\u53e3:\u7528\u6237\u540d:\u5bc6\u7801\uff1b\u68c0\u6d4b\u6210\u529f\u540e\u624d\u4f1a\u5199\u5165\u73af\u5883\u3002'); note.dataset.proxyFor = textarea.id;
  const field = textarea.closest('label') || textarea; field.before(label, note);
}
installProxyTypeControl('#batch-add-proxies', 'batch-add-proxy-type');
installProxyTypeControl('#batch-proxy-list', 'batch-update-proxy-type');
function installBatchUpdateNetworkMode() {
  const form = $('#batch-update-form');
  const hidden = $('#batch-update-network-mode');
  const fields = $('#batch-update-proxy-fields');
  const textarea = $('#batch-proxy-list');
  const submit = $('#batch-update-submit') || form?.querySelector('button.primary[value="default"]');
  if (!form || !hidden) return;
  const sync = () => {
    const selected = document.querySelector('input[name="batch-update-network"]:checked')?.value
      || (hidden.value === 'direct' ? 'direct' : 'proxy');
    const direct = selected === 'direct';
    hidden.value = direct ? 'direct' : 'proxy';
    if (fields) fields.hidden = direct;
    if (textarea) textarea.disabled = direct;
    form.querySelectorAll('[data-proxy-for="batch-proxy-list"]').forEach((item) => { item.hidden = direct; });
    if (submit) submit.textContent = direct ? tx('应用本地直连') : tx('检测并应用代理');
  };
  form.querySelectorAll('input[name="batch-update-network"]').forEach((input) => {
    input.addEventListener('change', sync);
  });
  // keep legacy select support if something still injects it
  const legacy = document.getElementById('batch-update-network-mode-select');
  if (legacy) legacy.addEventListener('change', () => { hidden.value = legacy.value; sync(); });
  sync();
}
installBatchUpdateNetworkMode();

function installCreateNetworkMode() {
  const fields = $('#create-proxy-fields');
  const input = $('#create-proxy-input');
  const sync = () => {
    const mode = document.querySelector('input[name="create-network"]:checked')?.value || 'direct';
    const direct = mode === 'direct';
    if (fields) fields.hidden = direct;
    if (input) {
      input.required = !direct;
      if (direct) input.value = '';
    }
  };
  document.querySelectorAll('input[name="create-network"]').forEach((el) => el.addEventListener('change', sync));
  sync();
}
installCreateNetworkMode();

function installBatchAddNetworkMode() {
  const fields = $('#batch-add-proxy-fields');
  const sync = () => {
    const mode = document.querySelector('input[name="batch-add-network"]:checked')?.value || 'direct';
    if (fields) fields.hidden = mode === 'direct';
  };
  document.querySelectorAll('input[name="batch-add-network"]').forEach((el) => el.addEventListener('change', sync));
  sync();
}
installBatchAddNetworkMode();
renderSpecifiedTextGroups();

async function runSyncAction(label, action) {
  try {
    const result = await action(); log('Sync', label + ' · ' + JSON.stringify(result));
    if (result?.success === false) {
      const failures = Array.isArray(result.failures) ? result.failures : [];
      const failed = failures.map((item) => specifiedTextFailureLabel(item.id)).join('、');
      toast(label + '仅完成 ' + (result.profiles?.length || 0) + ' 个环境' + (failed ? '；失败环境：' + failed : ''));
      await refreshSessions(); return result;
    }
    toast(label + '完成'); await refreshSessions(); return result;
  }
  catch (error) { log('Error', error.message); toast(error.message); return null; }
}

function renderLogs() {
  const target = $('#log-list');
  target.replaceChildren();
  if (!ui.logs.length) {
    target.append(element('div', 'log-empty', tx('暂无操作记录')));
    return;
  }
  for (const item of ui.logs) {
    const row = element('div', 'log-row');
    row.append(element('span', '', item.time), element('span', '', item.module), element('span', '', item.message));
    target.append(row);
  }
}

function themePopoverViewport() {
  // Prefer visualViewport so page zoom / pinch / OS scale stay correct.
  const vv = window.visualViewport;
  if (vv && Number.isFinite(vv.width) && vv.width > 0) {
    return {
      left: vv.offsetLeft || 0,
      top: vv.offsetTop || 0,
      width: vv.width,
      height: vv.height,
    };
  }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

/** Header uses backdrop-filter which makes position:fixed relative to header in Chromium.
 *  Portal the menu to <body> so fixed coords match getBoundingClientRect (viewport). */
function ensureThemePopoverPortaled() {
  const popover = $('#theme-popover');
  if (!popover) return null;
  if (popover.parentElement !== document.body) {
    document.body.appendChild(popover);
  }
  return popover;
}

function positionThemePopover() {
  const trigger = $('#theme-trigger');
  const popover = ensureThemePopoverPortaled() || $('#theme-popover');
  if (!trigger || !popover || popover.hidden) return;

  const rect = trigger.getBoundingClientRect();
  const vp = themePopoverViewport();
  const pad = 10;
  // Leave room for macOS traffic lights (left) and Windows caption buttons (right).
  const safeRight = 10;
  const gap = 8;
  const maxW = Math.max(200, Math.min(vp.width - pad - safeRight, vp.width - pad * 2));
  // Native / English labels need more width than the old 300px fixed box.
  const preferred = Math.min(360, Math.max(280, maxW));
  const width = Math.min(preferred, maxW);

  popover.style.position = 'fixed';
  popover.style.zIndex = '2147483000';
  popover.style.boxSizing = 'border-box';
  popover.style.width = `${Math.round(width)}px`;
  popover.style.maxWidth = `${Math.round(maxW)}px`;
  popover.style.minWidth = `${Math.min(240, maxW)}px`;
  popover.style.right = 'auto';
  popover.style.bottom = 'auto';
  popover.style.margin = '0';
  popover.style.overflowX = 'hidden';
  popover.style.overflowY = 'auto';

  // Measure after width is applied so height reflects wrapped content.
  const measuredW = Math.min(Math.max(popover.offsetWidth || width, width * 0.9), maxW);
  const measuredH = popover.offsetHeight || 280;
  const maxH = Math.max(160, vp.height - pad * 2);
  popover.style.maxHeight = `${Math.round(maxH)}px`;

  // Prefer align to trigger right edge (menu hangs left under the Theme button).
  let left = rect.right - measuredW;
  // Clamp fully inside the visual viewport.
  const maxLeft = vp.left + vp.width - measuredW - pad;
  const minLeft = vp.left + pad;
  left = Math.min(Math.max(left, minLeft), maxLeft);

  let top = rect.bottom + gap;
  const spaceBelow = (vp.top + vp.height - pad) - top;
  const spaceAbove = rect.top - gap - (vp.top + pad);
  const useH = Math.min(measuredH, maxH);
  if (useH > spaceBelow && spaceAbove > spaceBelow) {
    top = Math.max(vp.top + pad, rect.top - useH - gap);
  } else {
    top = Math.min(top, vp.top + vp.height - useH - pad);
    top = Math.max(vp.top + pad, top);
  }

  // Final hard clamp (guards float rounding + titlebar overlays).
  if (left + measuredW > vp.left + vp.width - 4) {
    left = Math.max(minLeft, vp.left + vp.width - measuredW - 4);
  }
  if (top + useH > vp.top + vp.height - 4) {
    top = Math.max(vp.top + pad, vp.top + vp.height - useH - 4);
  }

  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function setThemePopoverOpen(open) {
  const trigger = $('#theme-trigger');
  const popover = ensureThemePopoverPortaled() || $('#theme-popover');
  if (!popover || !trigger) return;
  popover.hidden = !open;
  trigger.setAttribute('aria-expanded', String(open));
  if (open) {
    // next frames: portal + paint, then measure (appearance row may show for native theme)
    requestAnimationFrame(() => {
      positionThemePopover();
      requestAnimationFrame(() => {
        positionThemePopover();
        // appearance panel toggle can change height after theme click
        setTimeout(positionThemePopover, 0);
      });
    });
  }
}

$('#theme-trigger').addEventListener('click', (event) => {
  event.stopPropagation();
  setThemePopoverOpen($('#theme-popover')?.hidden !== false);
});
window.addEventListener('resize', () => positionThemePopover());
window.addEventListener('scroll', () => positionThemePopover(), true);
try {
  window.visualViewport?.addEventListener('resize', () => positionThemePopover());
  window.visualViewport?.addEventListener('scroll', () => positionThemePopover());
} catch (_) {}

document.addEventListener('click', async (event) => {
  const cancelButton = event.target.closest('dialog button[value="cancel"]');
  if (cancelButton) {
    const dialog = cancelButton.closest('dialog');
    if (dialog?.open) {
      event.preventDefault();
      dialog.close('cancel');
      return;
    }
  }
  const selectOption = event.target.closest('.themed-select-option');
  if (selectOption && openSelectMenu) {
    const { select } = openSelectMenu;
    select.selectedIndex = Number(selectOption.dataset.optionIndex);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    syncThemedSelect(select);
    closeSelectMenu({ restoreFocus: true });
    return;
  }
  if (!event.target.closest('.themed-select-menu, .themed-select')) closeSelectMenu();
  const colorModeBtn = event.target.closest('[data-color-mode]');
  if (colorModeBtn && colorModeBtn.closest('#theme-appearance')) {
    event.stopPropagation();
    applyColorMode(colorModeBtn.dataset.colorMode);
    return;
  }
  const themeOption = event.target.closest('[data-ui-theme-option]');
  if (themeOption) {
    applyUiTheme(themeOption.dataset.uiThemeOption);
    // Keep popover open so user can switch light/dark for 系统原生
    if (themeOption.dataset.uiThemeOption !== 'element-admin') setThemePopoverOpen(false);
  } else if (!event.target.closest('#theme-picker') && !event.target.closest('#theme-popover')) {
    setThemePopoverOpen(false);
  }
  const nav = event.target.closest('[data-view]'); if (nav) switchView(nav.dataset.view);
  const action = event.target.closest('[data-action]');
  if (action?.dataset.action === 'start') startProfile(action.dataset.id);
  if (action?.dataset.action === 'stop') stopProfile(action.dataset.id);
  if (action?.dataset.action === 'edit') openProfileEditor(action.dataset.id);
  if (action?.dataset.action === 'select-sync') { selectedSessions.add(action.dataset.id); pushSyncSelection(); switchView('sync'); }

  const assign = event.target.closest('[data-extension-assign]'); if (assign) openAssign(assign.dataset.extensionAssign);
  const remove = event.target.closest('[data-extension-remove]'); if (remove) { try { await window.ops.removeExtension(remove.dataset.extensionRemove); await refreshExtensions(); } catch (error) { toast(error.message); } }
  const windowButton = event.target.closest('[data-window]'); if (windowButton) runSyncAction('窗口操作', () => window.ops.windowAction(selectedSessionIds(), windowButton.dataset.window));
  const masterSelect = event.target.closest('[data-master-select]'); if (masterSelect && !syncState.active && selectedSessions.has(masterSelect.dataset.masterSelect)) { preferredMasterId = masterSelect.dataset.masterSelect; pushSyncSelection(); renderSessions(); }
  const showWindow = event.target.closest('[data-show-window]'); if (showWindow) runSyncAction('\u663e\u793a\u7a97\u53e3', () => window.ops.windowAction([showWindow.dataset.showWindow], 'normal'));
  const proxyCheck = event.target.closest('[data-proxy-check]'); if (proxyCheck) checkProfileProxy(proxyCheck.dataset.proxyCheck);
  const consoleButton = event.target.closest('[data-console]'); if (consoleButton) { $$('.console-tabs button').forEach((button) => button.classList.toggle('active', button === consoleButton)); $$('.console-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `console-${consoleButton.dataset.console}`)); }
});

document.addEventListener('focusin', (event) => {
  if (!openSelectMenu) return;
  if (openSelectMenu.menu.contains(event.target) || openSelectMenu.button.contains(event.target)) return;
  closeSelectMenu();
});

window.addEventListener('resize', () => {
  if (openSelectMenu) positionSelectMenu(openSelectMenu.menu, openSelectMenu.button);
});
// Close dropdown on outer scroll — but NOT when scrolling the menu itself
// (long lists need overflow scroll; previous capture-scroll closed them instantly)
window.addEventListener('scroll', (event) => {
  if (!openSelectMenu || openSelectMenu.settling) return;
  const target = event.target;
  if (target === openSelectMenu.menu || openSelectMenu.menu.contains(target)) return;
  // Also ignore scrolls bubbling from within the open menu (some browsers)
  if (typeof target?.closest === 'function' && target.closest('.themed-select-menu')) return;
  closeSelectMenu();
}, true);
document.addEventListener('keydown', (event) => {
  if (!openSelectMenu) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeSelectMenu({ restoreFocus: true });
    return;
  }
  const option = event.target.closest?.('.themed-select-option');
  if (!option || !openSelectMenu.menu.contains(option)) return;
  const options = [...openSelectMenu.menu.querySelectorAll('.themed-select-option:not(:disabled)')];
  if (!options.length) return;
  const current = Math.max(0, options.indexOf(option));
  let next = current;
  if (event.key === 'ArrowDown') next = (current + 1) % options.length;
  else if (event.key === 'ArrowUp') next = (current - 1 + options.length) % options.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = options.length - 1;
  else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    option.click();
    return;
  } else if (event.key === 'Tab') {
    closeSelectMenu();
    return;
  } else return;
  event.preventDefault();
  options[next].focus({ preventScroll: true });
  options[next].scrollIntoView({ block: 'nearest' });
});

document.addEventListener('close', (event) => {
  if (event.target instanceof HTMLDialogElement && openSelectMenu?.select.closest('dialog') === event.target) closeSelectMenu();
}, true);

document.addEventListener('change', async (event) => {
  if (event.target.dataset.extensionToggle) {
    const input = event.target; input.disabled = true;
    try { toast(input.checked ? '正在批量启用扩展并重启运行环境...' : '正在批量停用扩展并重启运行环境...'); const result = await window.ops.toggleExtensionAll(input.dataset.extensionToggle, input.checked); await refreshExtensions(); await refreshStatus(); await refreshSessions(); toast(tx(`已${input.checked ? '启用' : '停用'}，影响 ${result.affected} 个环境，重启 ${result.restarted} 个`)); }
    catch (error) { input.checked = !input.checked; toast(error.message); } finally { input.disabled = false; }
  }
  if (event.target.dataset.profileSelect) { event.target.checked ? selectedProfiles.add(event.target.dataset.profileSelect) : selectedProfiles.delete(event.target.dataset.profileSelect); updateProfileSelectionUi(); }
  if (event.target.dataset.sessionSelect && !syncState.active) { event.target.checked ? selectedSessions.add(event.target.dataset.sessionSelect) : selectedSessions.delete(event.target.dataset.sessionSelect); if (!selectedSessions.has(preferredMasterId)) preferredMasterId = [...selectedSessions][0] || null; pushSyncSelection(); renderSessions(); }
});

$('#select-all-profiles').addEventListener('change', (event) => { for (const id of visibleProfilePageIds()) event.target.checked ? selectedProfiles.add(id) : selectedProfiles.delete(id); renderProfiles(); });
$('#select-all-sessions').addEventListener('change', (event) => { if (syncState.active) return; const group = $('#sync-group').value || 'all'; const visible = group === 'all' ? sessions : sessions.filter((item) => String(item.profile?.tag || '未分组') === group); for (const item of visible) event.target.checked ? selectedSessions.add(item.id) : selectedSessions.delete(item.id); if (!selectedSessions.has(preferredMasterId)) preferredMasterId = [...selectedSessions][0] || null; pushSyncSelection(); renderSessions(); });
$('#sync-group').addEventListener('change', () => { if (syncState.active) return; const group = $('#sync-group').value || 'all'; const values = group === 'all' ? sessions : sessions.filter((item) => String(item.profile?.tag || '未分组') === group); selectedSessions = new Set(values.map((item) => item.id)); preferredMasterId = values[0]?.id || null; pushSyncSelection(); renderSessions(); });
$('#profile-search').addEventListener('input', () => { profilePage = 1; renderProfiles(); }); $('#extension-search').addEventListener('input', renderExtensions);
$('#profile-page-size').addEventListener('change', (event) => { const value = Number(event.target.value); profilePageSize = PROFILE_PAGE_SIZES.includes(value) ? value : 10; profilePage = 1; try { localStorage.setItem(PROFILE_PAGE_SIZE_KEY, String(profilePageSize)); } catch (_) {} renderProfiles(); });
$('#profile-prev').addEventListener('click', () => { profilePage = Math.max(1, profilePage - 1); renderProfiles(); });
$('#profile-next').addEventListener('click', () => { profilePage += 1; renderProfiles(); });
$('#profile-page').addEventListener('change', (event) => { profilePage = Math.max(1, Number.parseInt(event.target.value, 10) || 1); renderProfiles(); });
function openCreateProfileDialog() {
  fillGroupSelect($('#profile-create-group'), listGroups()[0]?.id || UNGROUPED_ID);
  const directRadio = document.querySelector('input[name="create-network"][value="direct"]');
  if (directRadio) directRadio.checked = true;
  const proxyInput = $('#create-proxy-input');
  if (proxyInput) proxyInput.value = '';
  const fields = $('#create-proxy-fields');
  if (fields) fields.hidden = true;
  const number = nextProfileNumber();
  const form = $('#profile-form');
  if (form?.elements?.name) {
    form.elements.name.value = String(number);
    form.elements.name.readOnly = true;
  }
  $('#profile-dialog')?.showModal();
}
$('#create-profile').addEventListener('click', openCreateProfileDialog); $('#quick-create').addEventListener('click', openCreateProfileDialog);

// group filter chips
document.getElementById('profile-group-chips')?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-group-filter]');
  if (!btn) return;
  activeGroupFilter = btn.dataset.groupFilter || 'all';
  profilePage = 1;
  renderProfiles();
});

// groups page actions
document.getElementById('group-create')?.addEventListener('click', () => openGroupDialog(null));
document.getElementById('group-refresh')?.addEventListener('click', () => renderGroupsPage());
document.getElementById('group-table')?.addEventListener('click', (event) => {
  const editId = event.target.closest('[data-group-edit]')?.dataset.groupEdit;
  const delId = event.target.closest('[data-group-delete]')?.dataset.groupDelete;
  const viewId = event.target.closest('[data-group-view]')?.dataset.groupView;
  if (editId) openGroupDialog(findGroup(editId));
  if (delId) deleteGroup(delId);
  if (viewId) {
    activeGroupFilter = viewId;
    switchView('profiles');
    renderProfiles();
  }
});
document.getElementById('group-color-chips')?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-color]');
  if (!btn) return;
  $('#group-color').value = btn.dataset.color;
  $('#group-color-preview')?.style.setProperty('--group-color', btn.dataset.color);
  $$('#group-color-chips .group-color-pick').forEach((b) => b.classList.toggle('active', b === btn));
});
document.getElementById('group-color')?.addEventListener('input', (event) => {
  const color = event.target.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    $('#group-color-preview')?.style.setProperty('--group-color', color);
    $$('#group-color-chips .group-color-pick').forEach((button) => button.classList.toggle('active', button.dataset.color.toLowerCase() === color.toLowerCase()));
  }
});
document.getElementById('group-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') return $('#group-dialog').close();
  try {
    saveGroupFromDialog();
    $('#group-dialog').close();
    toast(tx('分组已保存'));
    log('Group', tx('保存分组'));
  } catch (error) { toast(error.message); }
});
document.getElementById('batch-assign-group-btn')?.addEventListener('click', async () => {
  try {
    const gid = $('#batch-assign-group')?.value;
    await assignSelectedToGroup(gid === '' ? UNGROUPED_ID : gid);
  } catch (error) { toast(error.message); }
});
$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (event.submitter?.value === 'cancel') return $('#profile-dialog').close();
  const form = event.currentTarget; const data = new FormData(form); const number = nextProfileNumber(); const previousNext = ui.nextProfileNumber;
  const groupId = String(data.get('groupId') || $('#profile-create-group')?.value || UNGROUPED_ID);
  const networkMode = document.querySelector('input[name="create-network"]:checked')?.value || 'direct';
  let proxy = 'Direct';
  if (networkMode === 'proxy') {
    const type = $('#create-proxy-type')?.value || 'socks5';
    const raw = String(data.get('proxy') || '').trim();
    if (raw) {
      try { proxy = normalizeProxy(raw, type); }
      catch (error) { return toast('代理格式错误：' + error.message); }
    }
  }
  const profile = {
    id: createInternalProfileId(number),
    number,
    name: String(number),
    browser: data.get('browser'),
    language: data.get('language') || 'en-US',
    networkMode: isDirectProxy(proxy) ? 'direct' : 'proxy',
    proxy,
    tag: String(data.get('tag') || 'Default'),
    groupId,
    os: 'Windows',
    location: 'Local',
    // Browser UI language defaults to exit-IP country; fixed locale is optional in editor.
    privacy: { languageMode: 'ip', langFromIp: true, uiLanguage: 'profile' },
  };
  ui.profiles.push(profile); ui.nextProfileNumber = number + 1; save();
  try {
    await window.ops.syncProfiles(ui.profiles); $('#profile-dialog').close(); form.reset();
    const directRadio = document.querySelector('input[name="create-network"][value="direct"]');
    if (directRadio) directRadio.checked = true;
    const fields = $('#create-proxy-fields'); if (fields) fields.hidden = true;
    await refreshStatus(); log('Profile', '创建环境 ' + number + ' · ' + (isDirectProxy(proxy) ? '本地直连' : '代理'));
    toast(isDirectProxy(proxy) && networkMode === 'proxy' ? '未填写代理，已自动切换为本地直连' : (isDirectProxy(proxy) ? '已创建（本地直连）' : '已创建（代理模式）'));
  } catch (error) {
    ui.profiles = ui.profiles.filter((item) => item.id !== profile.id); ui.nextProfileNumber = previousNext; save(); toast('创建失败：' + error.message);
  }
});

$$('[data-editor-tab]').forEach((button) => button.addEventListener('click', () => setEditorTab(button.dataset.editorTab)));
$('#editor-back').addEventListener('click', () => { editingProfileId = null; editorNetworkResult = null; switchView('profiles'); });
$('#editor-cancel').addEventListener('click', () => { editingProfileId = null; editorNetworkResult = null; switchView('profiles'); });
$('#editor-test-proxy')?.addEventListener('click', testEditorProxy);
$('#editor-apply-proxy-fp')?.addEventListener('click', applyEditorProxyFingerprint);
$('#editor-refresh-proxy')?.addEventListener('click', refreshEditorProxy);
$('#editor-system-defaults').addEventListener('click', useSystemEditorDefaults);
const editorProxySelector = '#editor-proxy-type,#editor-proxy-host,#editor-proxy-port,#editor-proxy-user,#editor-proxy-password,input[name="editor-network"]';
const onEditorFormChange = (event) => {
  if (event.target.matches(editorProxySelector)) {
    editorNetworkResult = null;
    $('#editor-proxy-result').className = 'proxy-test-result';
    $('#editor-proxy-result').textContent = editorSelectedNetwork() === 'direct' ? tx('本地直连') : tx('设置已更改，请重新检测');
  }
  updateEditorVisibility(); renderEditorSummary();
};
$('#profile-editor-form').addEventListener('input', onEditorFormChange);
$('#profile-editor-form').addEventListener('change', onEditorFormChange);

// Platform preset → fill 指定地址
function applyPlatformPresetToStartUrl() {
  const sel = document.getElementById('editor-platform-type');
  const urlInput = document.getElementById('editor-start-url');
  if (!sel || !urlInput) return;
  const opt = sel.selectedOptions?.[0];
  const preset = opt?.getAttribute('data-url');
  const type = sel.value;
  if (type === 'blank') {
    urlInput.value = '';
    urlInput.placeholder = tx('空白页 — 启动不打开站点');
    return;
  }
  if (type === 'other') {
    urlInput.placeholder = tx('手填任意 URL，例如 https://www.example.com');
    // do not clear custom URL when switching to other
    return;
  }
  if (preset != null && preset !== '') {
    urlInput.value = preset;
    urlInput.placeholder = tx('选择平台后自动填入，也可手动修改');
  }
}
document.getElementById('editor-platform-type')?.addEventListener('change', () => {
  applyPlatformPresetToStartUrl();
  renderEditorSummary?.();
});

// Cookie tools (export/import/clear)
document.getElementById('editor-cookie-export')?.addEventListener('click', () => {
  try {
    const raw = ($('#editor-cookies')?.value || '').trim() || '[]';
    JSON.parse(raw); // validate
    const blob = new Blob([raw], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cookies-${editingProfileId || 'profile'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(tx('Cookie 已导出'));
  } catch (error) { toast('导出失败：' + error.message); }
});
document.getElementById('editor-cookie-import-file')?.addEventListener('click', () => {
  document.getElementById('editor-cookie-file')?.click();
});
document.getElementById('editor-cookie-file')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error(tx('Cookie 必须是 JSON 数组'));
    editorSet('#editor-cookies', JSON.stringify(data, null, 2));
    toast('已导入 ' + data.length + ' 条 Cookie（保存环境后生效）');
  } catch (error) { toast('导入失败：' + error.message); }
});
document.getElementById('editor-clear-cache-cookie')?.addEventListener('click', async () => {
  if (!editingProfileId) return toast(tx('未打开环境'));
  if (!confirm(tx('清除该环境的缓存及 Cookie？需先关闭窗口。'))) return;
  try {
    await window.ops.clearProfileCacheCookies(editingProfileId);
    editorSet('#editor-cookies', '');
    const idx = ui.profiles.findIndex((p) => p.id === editingProfileId);
    if (idx >= 0) {
      ui.profiles[idx] = { ...ui.profiles[idx], cookies: '', updatedAt: new Date().toISOString() };
      save();
    }
    toast(tx('缓存及 Cookie 已清除'));
  } catch (error) { toast(error.message); }
});
$('#profile-editor-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const index = ui.profiles.findIndex((item) => item.id === editingProfileId); if (index < 0) return toast(tx('环境不存在'));
  try {
    const previous = ui.profiles[index]; const draft = editorDraft(true); if (!draft.name) throw new Error(tx('环境名称不能为空'));
    const switchedToDirect = editorSelectedNetwork() !== 'direct' && isDirectProxy(draft.proxy);
    if (draft.proxy !== previous.proxy && !editorNetworkResult) { delete draft.exitIp; delete draft.exitCountryCode; delete draft.exitTimezone; delete draft.exitLatitude; delete draft.exitLongitude; delete draft.exitCheckedAt; }
    draft.updatedAt = new Date().toISOString();
    ui.profiles[index] = draft; save(); engineProfiles = await window.ops.syncProfiles(ui.profiles); renderProfiles();
    const running = profileEngine(draft.id).running; log('Profile', '已更新环境 ' + displayProfileNumber(draft)); editingProfileId = null; editorNetworkResult = null; switchView('profiles'); toast(switchedToDirect ? '未填写代理，已自动切换为本地直连' : (running ? '设置已保存，请重启该环境后生效' : '环境设置已保存'));
  } catch (error) { toast('保存失败：' + error.message); }
});

$('#batch-add').addEventListener('click', () => {
  $('#batch-add-start').value = String(nextProfileNumber());
  fillGroupSelect($('#batch-add-group'), listGroups()[0]?.id || UNGROUPED_ID);
  fillGroupSelect($('#batch-assign-group'), UNGROUPED_ID, { includeUngrouped: true });
  const directRadio = document.querySelector('input[name="batch-add-network"][value="direct"]');
  if (directRadio) directRadio.checked = true;
  const fields = $('#batch-add-proxy-fields'); if (fields) fields.hidden = true;
  $('#batch-add-dialog').showModal();
});
$('#batch-add-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (event.submitter?.value === 'cancel') return $('#batch-add-dialog').close();
  const count = Number.parseInt($('#batch-add-count').value, 10); const start = nextProfileNumber(); const previousNext = ui.nextProfileNumber;
  const language = $('#batch-add-language').value; const tag = $('#batch-add-tag').value.trim() || '批量创建';
  const groupId = $('#batch-add-group')?.value || UNGROUPED_ID;
  const networkMode = document.querySelector('input[name="batch-add-network"]:checked')?.value || 'direct';
  let proxies = [];
  if (networkMode === 'proxy') {
    try { proxies = proxyLines('#batch-add-proxies', '#batch-add-proxy-type'); }
    catch (error) { return toast('代理格式错误：' + error.message); }
    if (!proxies.length) return toast(tx('代理模式请填写代理列表'));
  }
  if (!Number.isInteger(count) || count < 1 || count > 200) return toast(tx('新增数量必须为 1-200'));
  if (proxies.length && proxies.length !== count) return toast(tx('代理数量必须等于新增环境数量，每个环境对应一条代理'));
  const used = new Set(ui.profiles.map((item) => item.id)); const created = [];
  while (created.length < count) {
    const number = start + created.length; const id = createInternalProfileId(number, used); used.add(id);
    created.push({ id, number, name: String(number), browser: 'Google Chrome', language, networkMode: proxies.length ? 'proxy' : 'direct', proxy: proxies.length ? proxies[created.length] : 'Direct', tag, groupId, os: 'Windows', location: 'Local' });
  }
  try {
    const verified = proxies.length ? await verifyProxyAssignments(created, proxies) : [];
    created.forEach((profile, index) => {
      const result = verified[index]; if (!result) return;
      profile.exitIp = result.ip; profile.exitCountryCode = result.countryCode; profile.exitTimezone = result.timezone || ''; profile.exitLatitude = result.latitude; profile.exitLongitude = result.longitude; profile.exitCheckedAt = result.checkedAt;
    });
    ui.profiles.push(...created); ui.nextProfileNumber = start + created.length; save(); engineProfiles = await window.ops.syncProfiles(ui.profiles);
    selectedProfiles = new Set(created.map((item) => item.id)); $('#select-all-profiles').checked = false; $('#batch-add-dialog').close(); $('#batch-add-proxies').value = '';
    await refreshStatus(); await refreshExtensions(); renderProfiles();
    log('Batch', '批量新增 ' + created.length + ' 个环境 · ' + (networkMode === 'direct' ? '本地直连' : '代理'));
    toast('已批量创建 ' + created.length + ' 个环境（' + (networkMode === 'direct' ? '本地直连' : '代理模式') + '）');
  } catch (error) {
    ui.profiles = ui.profiles.filter((item) => !created.some((createdItem) => createdItem.id === item.id)); ui.nextProfileNumber = previousNext; save(); toast('批量新增失败：' + error.message);
  }
});
$('#delete-selected').addEventListener('click', async () => {
  pendingDeleteProfiles = ui.profiles.filter((item) => selectedProfiles.has(item.id)).map((item) => item.id);
  if (!pendingDeleteProfiles.length) return toast(tx('请先勾选要删除的环境'));
  try {
    const status = await window.ops.profileStatus(); const running = status.filter((item) => item.running && pendingDeleteProfiles.includes(item.id)).length;
    $('#batch-delete-summary').textContent = tx('已选择 ') + pendingDeleteProfiles.length + ' 个环境，其中 ' + running + ' 个正在运行。'; $('#batch-delete-dialog').showModal();
  } catch (error) { toast(error.message); }
});
$('#batch-delete-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (event.submitter?.value === 'cancel') { pendingDeleteProfiles = []; return $('#batch-delete-dialog').close(); }
  const ids = [...pendingDeleteProfiles]; if (!ids.length) return $('#batch-delete-dialog').close();
  const submitter = event.submitter; if (submitter) submitter.disabled = true;
  try {
    const result = await window.ops.deleteProfiles(ids, $('#batch-delete-data').checked);
    ui.profiles = ui.profiles.filter((item) => !ids.includes(item.id)); for (const id of ids) { selectedProfiles.delete(id); selectedSessions.delete(id); }
    pendingDeleteProfiles = []; save(); $('#select-all-profiles').checked = false; $('#batch-delete-dialog').close();
    await refreshStatus(); await refreshSessions(); await refreshExtensions(); renderProfiles(); log('Batch', '批量删除 ' + result.deleted + ' 个环境'); toast('已删除 ' + result.deleted + ' 个环境');
  } catch (error) { toast('批量删除失败：' + error.message); } finally { if (submitter) submitter.disabled = false; }
});
$('#start-selected').addEventListener('click', async () => { if (!selectedProfiles.size) return toast(tx('请先选择环境')); for (const id of selectedProfiles) await startProfile(id); });
$('#stop-selected').addEventListener('click', async () => { if (!selectedProfiles.size) return toast(tx('请先选择环境')); for (const id of selectedProfiles) await stopProfile(id); });
$('#add-extension').addEventListener('click', () => $('#add-app-dialog').showModal());
$('#close-add-app').addEventListener('click', () => $('#add-app-dialog').close());
$('#cancel-add-app').addEventListener('click', () => $('#add-app-dialog').close());
$('#choose-extension-folder').addEventListener('click', async () => {
  try {
    const result = await window.ops.addExtensionFolder();
    if (!result.canceled) { await refreshExtensions(); await refreshStatus(); await refreshSessions(); $('#add-app-dialog').close(); log('Extension', `添加 ${result.extension.name}，默认分配 ${result.assigned || 0} 个环境，重启 ${result.restarted || 0} 个`); toast(tx(`已添加 ${result.extension.name}，默认启用 ${result.assigned || 0}/${ui.profiles.length}`)); }
  } catch (error) { toast(error.message); }
});
$('#add-store-submit').addEventListener('click', async () => {
  const url = $('#chrome-store-url').value.trim();
  if (!url) return toast(tx('请输入 Chrome 应用商店 URL'));
  const all = $('#store-assign-all').checked; const ids = all ? ui.profiles.map((item) => item.id) : [];
  try {
    toast(tx('正在从 Chrome 应用商店获取扩展...'));
    const result = await window.ops.addExtensionStore(url, ids, all);
    await refreshExtensions(); await refreshStatus(); await refreshSessions();
    $('#add-app-dialog').close(); $('#chrome-store-url').value = '';
    log('Extension', '商店添加 ' + result.extension.name + ', 分配 ' + result.assigned + ', 重启 ' + result.restarted);
    toast('已添加 ' + result.extension.name + '，分配 ' + result.assigned + ' 个环境');
  } catch (error) { toast('商店添加失败：' + error.message); }
});
$('#refresh-extensions').addEventListener('click', refreshExtensions);
$('#app-center-tabs')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-app-tab]');
  if (!button) return;
  appCenterTab = button.dataset.appTab;
  renderExtensions();
});

// ---- proxy library ----
$('#proxy-create')?.addEventListener('click', () => openProxyDialog(null));
$('#proxy-refresh')?.addEventListener('click', refreshProxies);
$('#proxy-search')?.addEventListener('input', renderProxies);
$('#proxy-select-all')?.addEventListener('change', (event) => {
  const checked = event.target.checked;
  const q = ($('#proxy-search')?.value || '').trim().toLowerCase();
  const list = proxyLibrary.filter((item) => !q || [item.name, item.host, item.protocol, item.remark, item.lastIp, String(item.port)].join(' ').toLowerCase().includes(q));
  for (const item of list) {
    if (checked) selectedProxies.add(item.id); else selectedProxies.delete(item.id);
  }
  renderProxies();
});
$('#proxy-delete-selected')?.addEventListener('click', async () => {
  const ids = [...selectedProxies];
  if (!ids.length) return toast(tx('请先勾选代理'));
  if (!confirm(tx(`确定删除选中的 ${ids.length} 条代理？`))) return;
  try {
    await window.ops.proxyDelete(ids);
    ids.forEach((id) => selectedProxies.delete(id));
    await refreshProxies();
    toast('已删除 ' + ids.length + ' 条代理');
    log('Proxy', '删除 ' + ids.length + ' 条');
  } catch (error) { toast(error.message); }
});
async function runProxyBatchCheck(ids) {
  if (!ids.length) return toast(tx('请先勾选代理'));
  toast('正在检测 ' + ids.length + ' 条代理…');
  if (typeof window.ops.proxyCheckMany === 'function') {
    try {
      const summary = await window.ops.proxyCheckMany({ ids });
      await refreshProxies();
      toast(tx(`检测完成：成功 ${summary.ok || 0} · 失败 ${summary.fail || 0}`));
      return;
    } catch (error) {
      await refreshProxies();
      toast(tx('批量检测失败：') + (error.message || error));
      log('Proxy', '批量检测失败 · ' + (error.message || error));
      return;
    }
  }
  let ok = 0; let fail = 0;
  for (const id of ids) {
    try { await window.ops.proxyCheck({ id }); ok += 1; }
    catch (_) { fail += 1; }
  }
  await refreshProxies();
  toast(tx(`检测完成：成功 ${ok} · 失败 ${fail}`));
}
$('#proxy-check-selected')?.addEventListener('click', async () => {
  await runProxyBatchCheck([...selectedProxies]);
});
$('#proxy-check-all')?.addEventListener('click', async () => {
  const ids = (proxyLibrary || []).map((item) => item.id);
  if (!ids.length) return toast(tx('代理库为空'));
  await runProxyBatchCheck(ids);
});
document.addEventListener('change', (event) => {
  const box = event.target.closest('[data-proxy-select]');
  if (!box) return;
  if (box.checked) selectedProxies.add(box.dataset.proxySelect);
  else selectedProxies.delete(box.dataset.proxySelect);
});
document.addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-proxy-edit]');
  if (edit) {
    const item = proxyLibrary.find((p) => p.id === edit.dataset.proxyEdit);
    if (item) openProxyDialog(item);
    return;
  }
  const del = event.target.closest('[data-proxy-delete]');
  if (del) {
    const id = del.dataset.proxyDelete;
    if (!confirm(tx('确定删除该代理？'))) return;
    try {
      await window.ops.proxyDelete([id]);
      selectedProxies.delete(id);
      await refreshProxies();
      toast(tx('已删除'));
    } catch (error) { toast(error.message); }
    return;
  }
  const test = event.target.closest('[data-proxy-test]');
  if (test) {
    const id = test.dataset.proxyTest;
    try {
      toast(tx('检测中…'));
      const result = await window.ops.proxyCheck({ id });
      await refreshProxies();
      toast('连接成功 · ' + result.ip + (result.countryCode ? ' · ' + result.countryCode : ''));
      log('Proxy', '检测 ' + id + ' → ' + result.ip);
    } catch (error) { toast('检测失败：' + error.message); }
    return;
  }
  const use = event.target.closest('[data-proxy-use]');
  if (use) {
    const item = proxyLibrary.find((p) => p.id === use.dataset.proxyUse);
    if (!item) return;
    openCreateProfileDialog();
    const proxyRadio = document.querySelector('input[name="create-network"][value="proxy"]');
    if (proxyRadio) {
      proxyRadio.checked = true;
      proxyRadio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const type = $('#create-proxy-type');
    if (type && item.protocol) type.value = item.protocol;
    const input = $('#create-proxy-input') || document.querySelector('#profile-form input[name="proxy"]');
    if (input) input.value = item.raw || `${item.host}:${item.port}`;
    const fields = $('#create-proxy-fields');
    if (fields) fields.hidden = false;
    toast(tx('已切换为代理模式并填入代理'));
  }
});
$('#proxy-dialog-test')?.addEventListener('click', async () => {
  const output = $('#proxy-dialog-result');
  try {
    const draft = readProxyForm();
    output.className = 'proxy-test-result';
    output.textContent = tx('正在检测…');
    const result = await window.ops.proxyCheck(draft.id ? { id: draft.id } : { proxy: draft.raw || undefined, ...draft });
    output.className = 'proxy-test-result success';
    output.textContent = tx('连接成功 · ') + result.ip + (result.countryCode ? ' · ' + result.countryCode : '');
    if (draft.id) await refreshProxies();
  } catch (error) {
    output.className = 'proxy-test-result error';
    output.textContent = tx('检测失败 · ') + error.message;
  }
});
$('#proxy-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitter = event.submitter;
  if (submitter?.value === 'cancel') return $('#proxy-dialog').close('cancel');
  if (submitter && submitter.id !== 'proxy-dialog-save' && submitter.value !== 'default') return;
  try {
    const draft = readProxyForm();
    if (draft.id) await window.ops.proxyUpdate(draft);
    else await window.ops.proxyCreate(draft);
    $('#proxy-dialog').close();
    await refreshProxies();
    toast(draft.id ? '代理已更新' : '代理已创建');
    log('Proxy', (draft.id ? '更新 ' : '新建 ') + (draft.name || draft.host));
  } catch (error) {
    toast('保存失败：' + error.message);
  }
});
document.addEventListener('click', async (event) => {
  const install = event.target.closest('[data-store-install]');
  if (!install) return;
  const url = install.dataset.storeInstall;
  if (!url) return;
  try {
    toast(tx('正在从 Chrome 应用商店安装…'));
    const ids = ui.profiles.map((item) => item.id);
    const result = await window.ops.addExtensionStore(url.includes('://') ? url : `https://chromewebstore.google.com/detail/${url}`, ids, true);
    await refreshExtensions();
    await refreshStatus();
    await refreshSessions();
    toast(tx(`已安装 ${result.extension?.name || '扩展'}`));
    log('Extension', `推荐安装 ${result.extension?.name || url}`);
  } catch (error) {
    toast('安装失败：' + error.message);
    log('Error', error.message);
  }
});
$('#assign-extension').addEventListener('click', (event) => { event.preventDefault(); applyAssignment(true); }); $('#unassign-extension').addEventListener('click', (event) => { event.preventDefault(); applyAssignment(false); });
$('#refresh-sessions').addEventListener('click', refreshSessions);
$('#start-sync').addEventListener('click', () => runSyncAction('\u542f\u52a8\u540c\u6b65', () => window.ops.startSync(selectedSessionIds(2))));
$('#stop-sync').addEventListener('click', () => runSyncAction('\u505c\u6b62\u540c\u6b65', () => window.ops.stopSync()));
$('#restart-sync').addEventListener('click', () => runSyncAction('\u91cd\u542f\u540c\u6b65', () => window.ops.restartSync()));
async function sendSameText() { const [delayMin, delayMax] = textDelayRange(); return runSyncAction('\u6587\u672c\u8f93\u5165', () => window.ops.textAction(selectedSessionIds(), 'insert', $('#sync-text').value, delayMin, delayMax)); }
async function sendRandomNumbers() {
  let ids; try { ids = specifiedTextSessionIds(); } catch (error) { return toast(error.message); }
  let min = Number($('#random-number-min').value), max = Number($('#random-number-max').value); if (!Number.isFinite(min) || !Number.isFinite(max)) return toast('\u8bf7\u8f93\u5165\u6709\u6548\u7684\u6570\u5b57\u8303\u56f4'); if (max < min) [min, max] = [max, min];
  const decimals = Math.max((String($('#random-number-min').value).split('.')[1] || '').length, (String($('#random-number-max').value).split('.')[1] || '').length);
  const texts = ids.map(() => (min + Math.random() * (max - min)).toFixed(Math.min(8, decimals)));
  const [delayMin, delayMax] = textDelayRange(); return runSyncAction('\u968f\u673a\u6570\u5b57\u8f93\u5165', () => window.ops.batchTextAction(ids, texts, delayMin, delayMax));
}
$('#send-text').addEventListener('click', sendSameText);
$('#send-random-number').addEventListener('click', sendRandomNumbers);
$('#sync-settings-button').addEventListener('click', () => { fillSyncSettingsForm(); $('#sync-settings-dialog').showModal(); });
$('#sync-settings-form').addEventListener('submit', async (event) => { event.preventDefault(); if (event.submitter?.value === 'cancel') return $('#sync-settings-dialog').close('cancel'); await applySyncSettings(syncSettingsFromForm(), true); $('#sync-settings-dialog').close(); });
$('#delay-input').addEventListener('change', () => applySyncSettings({ ...syncSettings, delayInput: $('#delay-input').checked }));
$('#delay-click').addEventListener('change', () => applySyncSettings({ ...syncSettings, delayClick: $('#delay-click').checked }));
$('#clear-text').addEventListener('click', () => runSyncAction('清空内容', () => window.ops.textAction(selectedSessionIds(), 'clear', '', 0, 0)));
$('#add-specified-text-group').addEventListener('click', () => {
  if (specifiedTextGroups.length >= SPECIFIED_TEXT_GROUP_LIMIT) return toast('\u6700\u591a\u6dfb\u52a0 ' + SPECIFIED_TEXT_GROUP_LIMIT + ' \u4e2a\u6587\u672c\u7ec4');
  specifiedTextGroups.push(createSpecifiedTextGroup(specifiedTextGroups.length)); saveSpecifiedTextGroups(); renderSpecifiedTextGroups();
});
$('#specified-text-groups').addEventListener('input', (event) => {
  const id = event.target.dataset.specifiedText; if (!id) return;
  const group = specifiedTextGroups.find((item) => item.id === id); if (!group) return;
  group.text = event.target.value.slice(0, 500000); group.cursor = Math.min(group.cursor, Math.max(0, specifiedTextItems(group.text).length - 1)); saveSpecifiedTextGroups();
  const counter = document.querySelector('[data-specified-count="' + id + '"]'); if (counter) counter.textContent = specifiedTextItems(group.text).length + ' \u6761\u6587\u672c';
});
$('#specified-text-groups').addEventListener('change', (event) => {
  const id = event.target.dataset.specifiedMode; if (!id) return;
  const group = specifiedTextGroups.find((item) => item.id === id); if (!group) return;
  group.mode = event.target.value === 'random' ? 'random' : 'sequence'; group.cursor = 0; saveSpecifiedTextGroups();
});
$('#specified-text-groups').addEventListener('click', (event) => {
  const send = event.target.closest('[data-specified-send]'); if (send) return sendSpecifiedTextGroup(send.dataset.specifiedSend);
  const remove = event.target.closest('[data-specified-remove]'); if (!remove || specifiedTextGroups.length <= 1) return;
  specifiedTextGroups = specifiedTextGroups.filter((item) => item.id !== remove.dataset.specifiedRemove); saveSpecifiedTextGroups(); renderSpecifiedTextGroups();
});
$('#new-tab').addEventListener('click', () => runSyncAction('新建标签页', () => window.ops.tabAction(selectedSessionIds(), 'new', { url: normalizeUrl($('#tab-url').value) })));
$('#navigate-tab').addEventListener('click', () => runSyncAction('批量导航', () => window.ops.tabAction(selectedSessionIds(), 'navigate', { url: normalizeUrl($('#tab-url').value) })));
$('#reload-tab').addEventListener('click', () => runSyncAction('刷新标签页', () => window.ops.tabAction(selectedSessionIds(), 'reload', {})));
$('#close-tab').addEventListener('click', () => runSyncAction('关闭标签页', () => window.ops.tabAction(selectedSessionIds(), 'close', {})));
$('#sync-tabs').addEventListener('click', () => runSyncAction('同步标签页', () => window.ops.tabAction(selectedSessionIds(2), 'sync', {})));
$('#clear-logs').addEventListener('click', () => { ui.logs = []; save(); renderLogs(); });
$('#choose-profile-storage').addEventListener('click', chooseProfileStorage);
$('#reset-profile-storage').addEventListener('click', resetProfileStorage);
$('#open-profile-storage').addEventListener('click', async () => { try { await window.ops.openProfileStorage(); } catch (error) { toast(error.message); log('Error', error.message); } });

window.ops.onEvent(async (value) => {
  if (value?.type === 'app-update-progress') {
    appUpdateState.progress = value;
    renderAppUpdateState();
  }
  if (value?.type === 'app-update-status') {
    applyVersionTrafficLight(value);
  }
  if (value?.type === 'profile-start-progress' && value.id) {
    if (value.error || value.starting === false) {
      clearStartingProgress(value.id);
    } else {
      setStartingProgress(value.id, value);
    }
    renderProfiles();
  }
  if (value.type === 'status') {
    // Only terminal status clears the start bar. Intermediate emits (e.g. extensions-reconcile-skipped)
    // also set running:true and must not wipe progress mid-launch.
    if (value.id && value.running === false) clearStartingProgress(value.id);
    if (value.id && value.running === true && !value.action) clearStartingProgress(value.id);
    await refreshStatus();
    await refreshSessions();
    if (value.action === 'extensions-reconcile-skipped' && value.message) {
      // Informative only — openbrowser-148 lacks Extensions CDP; --load-extension still works.
      log('Browser', value.message);
    } else if (value.running === false && value.id) {
      const profile = ui.profiles.find((item) => item.id === value.id);
      const num = profile ? displayProfileNumber(profile) : value.id;
      if (value.reason && value.reason !== 'stop') {
        log('Browser', `环境 ${num} 已关闭（窗口退出）`);
      }
    } else if (value.message && value.action) {
      log('Browser', value.message);
    }
  }
  if (value.type === 'profile-closed' && value.profile?.id) {
    // Keep renderer UI state aligned with engine cookie snapshot after close
    const idx = ui.profiles.findIndex((p) => p.id === value.profile.id);
    if (idx >= 0) {
      const next = { ...ui.profiles[idx], ...value.profile };
      if (value.profile.cookies != null) next.cookies = value.profile.cookies;
      next.updatedAt = value.profile.updatedAt || new Date().toISOString();
      ui.profiles[idx] = normalizeProfileSettings(next);
      save();
      if (editingProfileId === value.profile.id) {
        editorSet('#editor-cookies', (() => {
          try { return next.cookies ? JSON.stringify(JSON.parse(next.cookies), null, 2) : ''; }
          catch (_) { return next.cookies || ''; }
        })());
      }
    }
  }
  if (value.type === 'extensions') await refreshExtensions();
  if (value.type === 'storage-settings') updateProfileStorageDisplay(value.profileRoot);
  if (value.type === 'sync-settings' && value.settings) { syncSettings = normalizeSyncSettings(value.settings); fillSyncSettingsForm(); }
  if (value.type === 'text-shortcut') {
    if (value.action === 'random-number') sendRandomNumbers();
    else if (value.action === 'same-text') sendSameText();
    else if (value.action === 'specified-text' && specifiedTextGroups[0]) sendSpecifiedTextGroup(specifiedTextGroups[0].id);
  }
  if (value.type === 'sync-state') {
    syncState = { active: value.active, master: value.master, selected: value.selected || [] };
    if (value.active) { preferredMasterId = value.master; selectedSessions = new Set(value.selected || []); syncHealth.recovering = false; }
    else syncHealth = { queueDepth: 0, coalesced: 0, dropped: 0, lastLatencyMs: 0, recovering: false };
    renderSessions(); log('Sync', value.active ? '同步已启动' : '同步已停止');
  }
  if (value.type === 'sync-health') { syncHealth = { ...syncHealth, ...value, recovering: false }; renderSyncState(); }
  if (value.type === 'sync-recovering') { syncHealth.recovering = true; renderSyncState(); log('Sync', `输入桥自动恢复，第 ${value.attempt} 次`); }
  if (value.type === 'native-input' && value.active) { syncHealth.recovering = false; renderSyncState(); }
  if (value.type === 'sync-error') { toast(value.message); log('Error', value.message); }
  if (value.type === 'sync-disconnected') { toast(value.message); log('Sync', value.message); }
});

window.ops.onEvent((value) => {
  if (value.type === 'proxy-error' || value.type === 'proxy-warn') {
    const profile = ui.profiles.find((item) => item.id === value.id);
    const msg = String(value.message || '');
    const message = '环境 ' + displayProfileNumber(profile || { id: value.id }) + '：' + msg;
    if (/出口信息检测失败（语言\/时区可能回退）|本地出口信息暂不可用|Direct exit lookup|本地出口查询失败/.test(msg)) {
      log('ProxyWarn', message);
      return;
    }
    if (value.type === 'proxy-error') toast(message);
    log(value.type === 'proxy-error' ? 'Proxy' : 'ProxyWarn', message);
  }
});

function updateProfileStorageDisplay(profileRoot) {
  const value = String(profileRoot || '');
  const current = $('#profile-storage-path'); if (current) current.textContent = value;
  const runtimeValue = document.querySelector('[data-runtime-key="Profile root"]'); if (runtimeValue) runtimeValue.textContent = value;
}

function renderRuntimeInfo(info) {
  const runtime = $('#runtime-info'); runtime.replaceChildren();
  const rows = [
    [t('system.runtime'), info.appVersion],
    [t('system.cdp'), info.chrome],
    [t('system.storage.current'), info.profileRoot],
  ];
  for (const [key, value] of rows) {
    const row = document.createElement('div'); const output = element('dd', '', value); output.dataset.runtimeKey = key;
    row.append(element('dt', '', key), output); runtime.append(row);
  }
  updateProfileStorageDisplay(info.profileRoot);
}

async function chooseProfileStorage() {
  const button = $('#choose-profile-storage'); button.disabled = true;
  try {
    const result = await window.ops.chooseProfileStorage(); if (result.canceled) return;
    updateProfileStorageDisplay(result.profileRoot); log('System', '\u73af\u5883\u6570\u636e\u4f4d\u7f6e\u5df2\u66f4\u6539\u4e3a ' + result.profileRoot); toast('\u73af\u5883\u6570\u636e\u4f4d\u7f6e\u5df2\u66f4\u6539\uff0c\u4e0b\u6b21\u542f\u52a8\u73af\u5883\u65f6\u751f\u6548');
  } catch (error) { toast(error.message); log('Error', error.message); } finally { button.disabled = false; }
}

async function resetProfileStorage() {
  const button = $('#reset-profile-storage'); button.disabled = true;
  try {
    const result = await window.ops.resetProfileStorage(); updateProfileStorageDisplay(result.profileRoot); log('System', '\u73af\u5883\u6570\u636e\u4f4d\u7f6e\u5df2\u6062\u590d\u9ed8\u8ba4'); toast('\u5df2\u6062\u590d\u9ed8\u8ba4\u6570\u636e\u4f4d\u7f6e');
  } catch (error) { toast(error.message); log('Error', error.message); } finally { button.disabled = false; }
}
function updateEngineBadge(info) {
  const badge = $('#engine-badge');
  if (!badge) return;
  const browsers = Array.isArray(info?.browsers) ? info.browsers : [];
  const ready = browsers.length > 0;
  const names = browsers.map((item) => item.name || item.path || '').filter(Boolean);
  badge.classList.remove('engine-badge-checking', 'engine-badge-ok', 'engine-badge-missing');
  badge.classList.add(ready ? 'engine-badge-ok' : 'engine-badge-missing');
  const text = badge.querySelector('.engine-badge-text');
  if (text) text.textContent = ready ? t('header.browserReady') : t('header.browserMissing');
  badge.title = ready
    ? (names.length ? names.join(' · ') : t('header.browserReadyTitle'))
    : t('header.browserMissingTitle');
  badge.setAttribute('aria-label', badge.title);
}

async function initialize() {
  refreshLocaleChrome();
  const info = await window.ops.getInfo();
  const appVersion = document.getElementById('app-version');
  if (appVersion && info?.appVersion) appVersion.textContent = `v${info.appVersion}`;
  applyVersionTrafficLight({ light: 'checking', currentVersion: info?.appVersion });
  // Backend also pushes app-update-status after startup delay; this primes the light immediately.
  updateEngineBadge(info);
  renderRuntimeInfo(info);
  syncState = await window.ops.getSyncState(); preferredMasterId = syncState.master || null; if (syncState.active) selectedSessions = new Set(syncState.selected || []);
  await applySyncSettings(syncSettings); fillSyncSettingsForm();
  ui.profiles = ui.profiles.map((item) => ({ ...item, browser: 'Google Chrome' }));
  // Merge secrets already loaded in main process (not stored in localStorage).
  try {
    const engineStatus = await window.ops.profileStatus();
    if (Array.isArray(engineStatus) && engineStatus.length) {
      const byId = new Map(engineStatus.map((item) => [item.id, item]));
      ui.profiles = ui.profiles.map((local) => {
        const remote = byId.get(local.id);
        if (!remote) return local;
        return normalizeProfileSettings({
          ...local,
          cookies: local.cookies || remote.cookies || '',
          proxy: local.proxy && !/^(direct)$/i.test(local.proxy) ? local.proxy : (remote.proxy || local.proxy),
          platform: {
            ...(local.platform || {}),
            password: local.platform?.password || remote.platform?.password || '',
            totpSecret: local.platform?.totpSecret || remote.platform?.totpSecret || '',
          },
        });
      });
      // Engine-only profiles (restored from disk) not yet in UI list
      for (const remote of engineStatus) {
        if (!ui.profiles.some((item) => item.id === remote.id)) {
          ui.profiles.push(normalizeProfileSettings(remote));
        }
      }
    }
  } catch (_) {}
  save();
  engineProfiles = await window.ops.syncProfiles(ui.profiles); await refreshExtensions(); await refreshSessions(); renderProfiles(); renderLogs();
  log('System', readyBrowserLog(info));
  switchView(document.querySelector('.view.active')?.id?.replace(/^view-/, '') || 'profiles');
}
function readyBrowserLog(info) {
  const n = Array.isArray(info?.browsers) ? info.browsers.length : 0;
  return n > 0 ? `引擎启动 · ${n} 个浏览器可用` : '引擎启动 · 未找到浏览器';
}
initialize().catch((error) => {
  updateEngineBadge({ browsers: [] });
  log('Error', error.message);
  toast(error.message);
});


function parseCsvLine(line) {
  const values = []; let current = ''; let quoted = false;
  for (let index = 0; index < line.length; index += 1) { const char = line[index]; if (char === '"' && line[index + 1] === '"') { current += '"'; index += 1; } else if (char === '"') quoted = !quoted; else if (char === ',' && !quoted) { values.push(current.trim()); current = ''; } else current += char; }
  values.push(current.trim()); return values;
}

function parseImportedProfiles(text, extension) {
  if (extension === 'json') { const values = JSON.parse(text); if (!Array.isArray(values)) throw new Error('\u5bfc\u5165 JSON \u5fc5\u987b\u662f\u6570\u7ec4'); return values; }
  const lines = text.split(/\r?\n/).filter((line) => line.trim()); if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((item) => item.toLowerCase());
  return lines.slice(1).map((line, row) => { const values = parseCsvLine(line); const item = Object.fromEntries(headers.map((key, index) => [key, values[index] || ''])); return { id: item.id || 'env-import-' + Date.now().toString(36) + '-' + row, name: item.name || item.id || 'Imported ' + (row + 1), browser: item.browser || 'Google Chrome', language: item.language || 'en-US', proxy: item.proxy || item.ip || 'Direct', proxyType: item.proxytype || '', exitIp: item.ip || '', exitCountryCode: item.countrycode || '', tag: item.tag || item.group || 'Imported', os: 'Windows', location: item.location || 'Local' }; });
}

$('#batch-import').addEventListener('click', () => $('#batch-import-file').click());
$('#batch-import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0]; if (!file) return;
  const previousLength = ui.profiles.length; const previousNext = ui.nextProfileNumber;
  try {
    const extension = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv'; const imported = parseImportedProfiles(await file.text(), extension);
    const start = nextProfileNumber(); const used = new Set(ui.profiles.map((item) => item.id));
    const normalized = imported.map((item, index) => { const number = start + index; const id = createInternalProfileId(number, used); used.add(id); return { id, number, name: String(number), browser: 'Google Chrome', language: String(item.language || 'en-US'), proxy: String(item.proxy || item.ip || 'Direct'), proxyType: String(item.proxyType || item.proxytype || ''), exitIp: String(item.exitIp || item.ip || ''), exitCountryCode: String(item.exitCountryCode || item.countrycode || ''), tag: String(item.tag || item.group || 'Imported'), os: 'Windows', location: String(item.location || 'Local') }; });
    ui.profiles.push(...normalized); ui.nextProfileNumber = start + normalized.length; save(); engineProfiles = await window.ops.syncProfiles(ui.profiles); renderProfiles(); log('Import', '\u6279\u91cf\u5bfc\u5165 ' + normalized.length + ' \u4e2a\u73af\u5883'); toast('\u5df2\u5bfc\u5165 ' + normalized.length + ' \u4e2a\u73af\u5883');
  } catch (error) { ui.profiles = ui.profiles.slice(0, previousLength); ui.nextProfileNumber = previousNext; save(); toast('\u5bfc\u5165\u5931\u8d25\uff1a' + error.message); }
  event.target.value = '';
});

async function applySelectedNetworkMode(mode, { proxies = null, restart = true } = {}) {
  const ids = ui.profiles.filter((profile) => selectedProfiles.has(profile.id)).map((profile) => profile.id);
  if (!ids.length) throw new Error(tx('请先选择环境'));
  const profiles = ids.map((id) => ui.profiles.find((profile) => profile.id === id));
  const direct = mode === 'direct';
  let list; let verified;
  if (direct) {
    list = profiles.map(() => 'Direct');
    verified = profiles.map(() => null);
  } else {
    list = proxies;
    if (!list || list.length !== profiles.length) throw new Error(tx('代理数量必须与所选环境数量一致'));
    verified = await verifyProxyAssignments(profiles, list);
  }
  const status = await window.ops.profileStatus();
  const runningBefore = new Set(status.filter((item) => item.running && ids.includes(item.id)).map((item) => item.id));
  if (restart) for (const id of runningBefore) await window.ops.stopProfile(id);
  profiles.forEach((profile, index) => {
    profile.proxy = list[index];
    const result = verified[index];
    if (result) {
      profile.exitIp = result.ip; profile.exitCountryCode = result.countryCode; profile.exitTimezone = result.timezone || '';
      profile.exitLatitude = result.latitude; profile.exitLongitude = result.longitude; profile.exitCheckedAt = result.checkedAt;
    } else {
      delete profile.exitIp; delete profile.exitCountryCode; delete profile.exitTimezone;
      delete profile.exitLatitude; delete profile.exitLongitude; delete profile.exitCheckedAt;
    }
  });
  save();
  engineProfiles = await window.ops.syncProfiles(ui.profiles);
  if (restart) for (const id of runningBefore) {
    const profile = ui.profiles.find((item) => item.id === id);
    if (profile) await window.ops.startProfile(profile);
  }
  await refreshStatus(); await refreshSessions(); renderProfiles();
  return { count: ids.length, direct };
}

$('#batch-set-direct')?.addEventListener('click', async () => {
  if (!selectedProfiles.size) return toast(tx('请先选择环境'));
  try {
    const result = await applySelectedNetworkMode('direct', { restart: true });
    log('Batch', '批量设为本地直连 · ' + result.count);
    toast('已将 ' + result.count + ' 个环境设为本地直连');
  } catch (error) {
    toast(error.message);
  }
});

$('#batch-update').addEventListener('click', () => {
  if (!selectedProfiles.size) return toast(tx('请先选择环境'));
  const proxyRadio = document.querySelector('input[name="batch-update-network"][value="proxy"]');
  if (proxyRadio) proxyRadio.checked = true;
  const hidden = $('#batch-update-network-mode'); if (hidden) hidden.value = 'proxy';
  const fields = $('#batch-update-proxy-fields'); if (fields) fields.hidden = false;
  const submit = $('#batch-update-submit'); if (submit) submit.textContent = tx('检测并应用代理');
  $('#batch-update-dialog').showModal();
});
$('#batch-update-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') return $('#batch-update-dialog').close();
  const mode = document.querySelector('input[name="batch-update-network"]:checked')?.value
    || $('#batch-update-network-mode')?.value
    || 'proxy';
  const restart = !!$('#restart-running')?.checked;
  try {
    let proxies = null;
    if (mode !== 'direct') {
      try { proxies = proxyLines('#batch-proxy-list', '#batch-update-proxy-type'); }
      catch (error) { return toast('代理格式错误：' + error.message); }
    }
    const result = await applySelectedNetworkMode(mode === 'direct' ? 'direct' : 'proxy', { proxies, restart });
    $('#batch-update-dialog').close();
    $('#batch-proxy-list').value = '';
    const modeText = result.direct ? '本地直连' : '已验证代理';
    log('Batch', '批量更新 ' + result.count + ' 个环境 · ' + modeText);
    toast('已将 ' + result.count + ' 个环境更新为' + modeText);
  } catch (error) {
    log('Proxy', '批量更新失败 · ' + error.message);
    toast(error.message);
  }
});


// ========== Automation scripts (local-only panels) ==========
let rpaPlans = [];
let rpaSelectedId = null;
let currentRpaTab = 'flows';
const RPA_TEMPLATE = `[
  { "type": "gotoUrl", "url": "https://www.baidu.com" },
  { "type": "waitTime", "timeout": 1500 },
  { "type": "inputContent", "selector": "#kw", "content": "openbrowser rpa", "isClear": true },
  { "type": "waitTime", "timeout": 400 },
  { "type": "click", "selector": "#su" },
  { "type": "waitTime", "timeout": 2000 }
]`;

let rpaStoreTemplates = [];
let rpaStoreCategories = ['全部'];
let rpaStoreActiveCat = '全部';
let rpaPreviewTemplateId = null;

function showRpaPanel(tab) {
  setTimeout(() => afterUiRender(document.getElementById('view-rpa') || document), 0);

  currentRpaTab = tab || 'flows';
  document.querySelectorAll('[data-rpa-panel]').forEach((el) => {
    el.hidden = el.getAttribute('data-rpa-panel') !== currentRpaTab;
  });
  document.querySelectorAll('[data-view="rpa"]').forEach((btn) => {
    const t = btn.dataset.rpaTab;
    if (t) {
      btn.classList.toggle('active', t === currentRpaTab);
    }
  });

  // Ensure RPA menu expands
  const menu = document.getElementById('nav-rpa-plus');
  const toggle = document.getElementById('rpa-menu-toggle');
  if (menu && menu.hidden) {
    menu.hidden = false;
    menu.style.display = 'block';
  }
  if (toggle && !toggle.classList.contains('open')) {
    toggle.setAttribute('aria-expanded', 'true');
    toggle.classList.add('open');
  }
}

function setRpaEditorVisible(show) {
  const empty = document.getElementById('rpa-flow-empty');
  const editor = document.getElementById('rpa-flow-editor');
  if (empty) empty.hidden = show;
  if (editor) editor.hidden = !show;
}

function fillRpaProfileSelect(selectedIds = []) {
  const sel = document.getElementById('rpa-profile-ids');
  if (!sel) return;
  const running = (engineProfiles || []).filter((p) => p.running);
  sel.replaceChildren();
  for (const profile of (ui.profiles || [])) {
    const opt = document.createElement('option');
    opt.value = profile.id;
    const live = running.some((r) => r.id === profile.id);
    opt.textContent = (live ? '● ' : '○ ') + displayProfileNumber(profile) + ' · ' + (profile.name || profile.id);
    if (selectedIds.includes(profile.id)) opt.selected = true;
    sel.append(opt);
  }
}

function selectedRpaProfileIds() {
  const sel = document.getElementById('rpa-profile-ids');
  if (!sel) return [];
  return [...sel.selectedOptions].map((o) => o.value);
}

function renderRpaPlans() {
  const table = document.getElementById('rpa-plan-table');
  const countEl = document.getElementById('rpa-flow-count');
  const q = (document.getElementById('rpa-flow-search')?.value || '').trim().toLowerCase();
  if (countEl) countEl.textContent = String(rpaPlans.length);
  if (!table) return;
  table.replaceChildren();
  const list = rpaPlans.filter((p) => !q || String(p.plan_name || '').toLowerCase().includes(q));
  for (const plan of list) {
    const row = document.createElement('tr');
    if (plan.id === rpaSelectedId) row.classList.add('active');
    row.dataset.rpaPlan = plan.id;
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.rpaPlanCheck = plan.id;
    const td0 = document.createElement('td'); td0.append(cb);
    row.append(
      td0,
      element('td', '', plan.plan_name || plan.id),
      element('td', '', String((plan.steps || []).length)),
      element('td', '', String((plan.profile_ids || []).length)),
      element('td', '', String(plan.update_time || plan.create_time || '—').replace('T', ' ').slice(0, 19))
    );
    table.append(row);
  }
  setRpaEditorVisible(list.length > 0 || Boolean(rpaSelectedId));
  if (!list.length && !rpaSelectedId) setRpaEditorVisible(false);
}

function loadRpaPlanToEditor(plan) {
  rpaSelectedId = plan?.id || null;
  const title = document.getElementById('rpa-editor-title');
  if (!plan) {
    if (title) title.textContent = tx('编辑流程');
    const name = document.getElementById('rpa-plan-name');
    const steps = document.getElementById('rpa-steps-json');
    if (name) name.value = '';
    if (steps) steps.value = '';
    fillRpaProfileSelect([]);
    renderRpaPlans();
    return;
  }
  setRpaEditorVisible(true);
  if (title) title.textContent = plan.plan_name || plan.id;
  document.getElementById('rpa-plan-name').value = plan.plan_name || '';
  document.getElementById('rpa-steps-json').value = JSON.stringify(plan.steps || [], null, 2);
  fillRpaProfileSelect(plan.profile_ids || []);
  renderRpaPlans();
}

function appendRpaLog(line) {
  const box = document.getElementById('rpa-log-list');
  if (!box) return;
  if (box.querySelector('.rpa-muted') && box.children.length === 1) box.replaceChildren();
  const raw = String(line || '');
  const levelMatch = raw.match(/^(error|fail|failed|warn|warning|ok|success|done|info)\s*[:：-]\s*/i);
  let level = 'info';
  let message = raw;
  if (levelMatch) {
    const token = String(levelMatch[1] || '').toLowerCase();
    level = /error|fail/.test(token) ? 'error'
      : /warn/.test(token) ? 'warn'
        : /ok|success|done/.test(token) ? 'ok'
          : 'info';
    message = raw.slice(levelMatch[0].length) || raw;
  } else if (/\berror\b|错误|失败/i.test(raw)) {
    level = 'error';
  } else if (/\bwarn(?:ing)?\b|警告/i.test(raw)) {
    level = 'warn';
  } else if (/完成|成功|started|已启动|done|success/i.test(raw)) {
    level = 'ok';
  }
  const levelLabel = level === 'error' ? 'ERROR'
    : level === 'warn' ? 'WARN'
      : level === 'ok' ? 'OK'
        : 'INFO';
  const row = document.createElement('div');
  row.className = 'log-line level-' + level;
  const timeEl = document.createElement('span');
  timeEl.className = 'log-time';
  timeEl.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const levelEl = document.createElement('span');
  levelEl.className = 'log-level';
  levelEl.textContent = levelLabel;
  const msgEl = document.createElement('span');
  msgEl.className = 'log-msg';
  msgEl.textContent = message;
  row.append(timeEl, levelEl, msgEl);
  box.prepend(row);
  // Keep the newest line visible without forcing the whole page to jump.
  try { box.scrollTop = 0; } catch (_) {}
}

async function refreshRpaStatusBadge() {
  try {
    const st = await window.ops.rpaStatus();
    const el = document.getElementById('rpa-run-status');
    if (el) el.textContent = st.count ? (tx('运行中 ') + st.count) : tx('空闲');
  } catch (_) {}
}

async function refreshRpaTasks() {
  const table = document.getElementById('rpa-task-table');
  const empty = document.getElementById('rpa-task-empty');
  if (!table) return;
  let tasks = [];
  try { tasks = await window.ops.rpaTasks({}); } catch (_) { tasks = []; }
  const q = (document.getElementById('rpa-task-search')?.value || '').trim().toLowerCase();
  table.replaceChildren();
  const list = (tasks || []).filter((t) => !q || String(t.process_name || t.id).toLowerCase().includes(q));
  for (const t of list) {
    const row = document.createElement('tr');
    const cb = document.createElement('input'); cb.type = 'checkbox';
    const td0 = document.createElement('td'); td0.append(cb);
    const runBtn = element('button', 'outline', tx('详情'));
    runBtn.onclick = () => {
      appendRpaLog(JSON.stringify(t));
      showRpaPanel('runs');
      toast(tx('见运行记录/日志'));
    };
    const tdOp = document.createElement('td'); tdOp.append(runBtn);
    row.append(
      td0,
      element('td', '', t.process_name || t.id),
      element('td', '', '1'),
      element('td', '', t.process_name || '—'),
      element('td', '', t.type || '普通'),
      element('td', '', String(t.start_time || t.create_time || '—').replace('T', ' ').slice(0, 19)),
      element('td', '', t.status || '—'),
      tdOp
    );
    table.append(row);
  }
  if (empty) {
    empty.style.display = list.length ? 'none' : 'grid';
  }
}

async function refreshRpaRuns() {
  const table = document.getElementById('rpa-run-table');
  const empty = document.getElementById('rpa-run-empty');
  if (!table) return;
  let tasks = [];
  try { tasks = await window.ops.rpaTasks({}); } catch (_) { tasks = []; }
  const filter = document.getElementById('rpa-run-filter')?.value || 'all';
  const q = (document.getElementById('rpa-run-search')?.value || '').trim().toLowerCase();
  table.replaceChildren();
  let list = tasks || [];
  if (filter !== 'all') list = list.filter((t) => String(t.status) === filter);
  if (q) list = list.filter((t) => String(t.process_name || '').toLowerCase().includes(q));
  for (const t of list) {
    const row = document.createElement('tr');
    row.append(
      element('td', '', t.process_name || t.id),
      element('td', '', t.process_name || '—'),
      element('td', '', t.profile_id || '—'),
      element('td', '', t.status || '—'),
      element('td', '', String(t.start_time || t.create_time || '—').replace('T', ' ').slice(0, 19)),
      element('td', '', String(t.complete_time || '—').replace('T', ' ').slice(0, 19)),
      element('td', '', '')
    );
    table.append(row);
  }
  if (empty) empty.style.display = list.length ? 'none' : 'grid';
}

function rpaCategoryLabel(cat) {
  const c = String(cat || '');
  if (c === '全部' || c === 'All') return t('rpa.cat.all');
  return c;
}

function syncRpaStoreCategoryUi(categories) {
  rpaStoreCategories = Array.isArray(categories) && categories.length ? categories : ['全部'];
  const select = document.getElementById('rpa-store-cat');
  const chips = document.getElementById('rpa-store-chips');
  if (select) {
    const prev = select.value || rpaStoreActiveCat;
    select.replaceChildren();
    for (const c of rpaStoreCategories) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = rpaCategoryLabel(c);
      select.append(opt);
    }
    select.value = rpaStoreCategories.includes(prev) ? prev : '全部';
    rpaStoreActiveCat = select.value;
  }
  if (chips) {
    chips.replaceChildren();
    for (const c of rpaStoreCategories) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = rpaCategoryLabel(c);
      b.dataset.storeCat = c;
      if (c === rpaStoreActiveCat) b.classList.add('active');
      chips.append(b);
    }
  }
}

function rpaStoreSourceLabel(tpl) {
  if (tpl.builtin || tpl.source === 'builtin') return t('rpa.store.source.builtin');
  if (tpl.source === 'catalog') return t('rpa.store.source.local');
  if (tpl.source === 'import') return t('rpa.store.source.import');
  return t('rpa.store.source.mine');
}

function rpaStepSummary(steps, max = 12) {
  if (!Array.isArray(steps) || !steps.length) return '（无步骤）';
  return steps.slice(0, max).map((s, i) => {
    const t = s.type || s.action || '?';
    const hint = s.url || s.selector || s.content || s.expression || '';
    const short = String(hint).replace(/\s+/g, ' ').slice(0, 48);
    return `${i + 1}. ${t}${short ? ' · ' + short : ''}`;
  }).join('\n') + (steps.length > max ? `\n… 共 ${steps.length} 步` : '');
}

async function refreshRpaStore() {
  const q = (document.getElementById('rpa-store-search')?.value || '').trim();
  const cat = rpaStoreActiveCat || '全部';
  const sort = document.getElementById('rpa-store-sort')?.value || 'use_num';
  const source = document.getElementById('rpa-store-source')?.value || '';
  try {
    const result = await window.ops.rpaTemplates({ q, cat, sort, source });
    rpaStoreTemplates = Array.isArray(result?.list) ? result.list : [];
    syncRpaStoreCategoryUi(result?.categories);
    const meta = document.getElementById('rpa-store-sync-meta');
    if (meta) meta.textContent = t('rpa.store.localMeta');
  } catch (error) {
    rpaStoreTemplates = [];
    toast('加载模板仓库失败：' + error.message);
  }
  renderRpaStore();
}

function renderRpaStore() {
  const grid = document.getElementById('rpa-store-grid');
  const empty = document.getElementById('rpa-store-empty');
  const countEl = document.getElementById('rpa-store-count');
  if (!grid) return;
  // Server already filtered; keep light client filter for search-as-you-type without refetch lag
  const list = rpaStoreTemplates;
  if (countEl) {
    const wrap = countEl.parentElement;
    if (wrap && wrap.classList.contains('rpa-toolbar-right')) {
      wrap.innerHTML = `${t('rpa.store.countPrefix') || '共 '}<b id="rpa-store-count">${list.length}</b>${t('rpa.store.countMiddle') || ' 个 · '}<span id="rpa-store-sync-meta">${t('rpa.store.localMeta')}</span>`;
    } else {
      countEl.textContent = String(list.length);
    }
  }
  grid.replaceChildren();
  if (empty) empty.hidden = list.length > 0;
  for (const tpl of list) {
    const card = document.createElement('article');
    card.className = 'rpa-store-card';
    card.dataset.templateId = tpl.id;
    const sourceLabel = rpaStoreSourceLabel(tpl);
    const stepCount = Array.isArray(tpl.steps) ? tpl.steps.length : 0;
    const runnable = tpl.runnable === true;
    const tags = Array.isArray(tpl.tags) ? tpl.tags.slice(0, 4) : [];
    card.innerHTML = `
      <h4></h4>
      <p></p>
      <div class="rpa-store-tags"></div>
      <div class="rpa-store-meta"><span></span><span></span></div>
      <div class="rpa-store-actions"></div>`;
    card.querySelector('h4').textContent = tpl.name || tpl.id;
    card.querySelector('p').textContent = tpl.desc || '';
    const tagBox = card.querySelector('.rpa-store-tags');
    for (const tag of tags) {
      const i = document.createElement('i');
      i.textContent = tag;
      tagBox.append(i);
    }
    if (tpl.developer) {
      const i = document.createElement('i');
      i.textContent = tpl.developer;
      tagBox.append(i);
    }
    const meta = card.querySelectorAll('.rpa-store-meta span');
    meta[0].textContent = `${tpl.cat || '—'} · ${sourceLabel}`;
    meta[1].textContent = t('rpa.store.steps', { n: stepCount });
    const actions = card.querySelector('.rpa-store-actions');
    const useBtn = document.createElement('button');
    useBtn.type = 'button'; useBtn.className = 'primary'; useBtn.textContent = runnable ? t('action.use') : t('action.unavailable');
    useBtn.disabled = !runnable;
    useBtn.title = runnable
      ? t('rpa.store.createFlow')
      : (stepCount ? t('rpa.store.unsupportedPrefix', { items: (tpl.unsupported_steps || []).slice(0, 3).map((item) => item.type).join(', ') }) : t('rpa.store.noSteps'));
    useBtn.onclick = () => installRpaTemplate(tpl.id).catch((e) => toast(e.message));
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button'; previewBtn.className = 'outline'; previewBtn.textContent = t('action.preview');
    previewBtn.onclick = () => openRpaTemplatePreview(tpl);
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button'; exportBtn.className = 'outline'; exportBtn.textContent = t('action.export');
    exportBtn.onclick = async () => {
      try {
        const result = await window.ops.rpaTemplateExport(tpl.id);
        if (result?.canceled) return;
        toast(t('rpa.store.exported', { path: result.path || '' }));
      } catch (e) { toast(e.message); }
    };
    actions.append(useBtn, previewBtn, exportBtn);
    if (!tpl.builtin && tpl.source !== 'builtin' && tpl.source !== 'catalog') {
      const delBtn = document.createElement('button');
      delBtn.type = 'button'; delBtn.className = 'outline rpa-btn-danger'; delBtn.textContent = t('action.delete');
      delBtn.onclick = async () => {
        if (!confirm(t('rpa.store.deleteConfirm', { name: tpl.name || '' }))) return;
        try {
          await window.ops.rpaTemplateDelete(tpl.id);
          toast(t('toast.deleted'));
          await refreshRpaStore();
        } catch (e) { toast(e.message); }
      };
      actions.append(delBtn);
    }
    grid.append(card);
  }
}

async function installRpaTemplate(id) {
  const result = await window.ops.rpaTemplateInstall({ id });
  const plan = result?.plan;
  if (!plan) throw new Error(tx('安装模板失败'));
  rpaSelectedId = plan.id;
  showRpaPanel('flows');
  await refreshRpaPage();
  loadRpaPlanToEditor(plan);
  toast(`${t('rpa.store.createFlow')}：${plan.plan_name || plan.id}（${t('rpa.store.steps', { n: plan.steps?.length || 0 })}）`);
  afterUiRender(document.getElementById('view-rpa') || document);
  return plan;
}

function openRpaTemplatePreview(tpl) {
  rpaPreviewTemplateId = tpl.id;
  const dialog = document.getElementById('rpa-template-preview');
  const title = document.getElementById('rpa-preview-title');
  const meta = document.getElementById('rpa-preview-meta');
  const steps = document.getElementById('rpa-preview-steps');
  if (title) title.textContent = t('rpa.store.previewTitle');
  if (meta) {
    meta.textContent = `${tpl.cat || ''} · ${rpaStoreSourceLabel(tpl)} · ${t('rpa.store.steps', { n: Array.isArray(tpl.steps) ? tpl.steps.length : 0 })} · ${tpl.desc || ''}`;
  }
  if (steps) {
    const summary = rpaStepSummary(tpl.steps || []);
    steps.textContent = summary + '\n\n—— JSON ——\n' + JSON.stringify(tpl.steps || [], null, 2);
  }
  dialog?.showModal?.();
}

function openCustomTemplateDialog(seed = {}) {
  const dialog = document.getElementById('rpa-template-dialog');
  const nameEl = document.getElementById('rpa-tpl-name');
  const catEl = document.getElementById('rpa-tpl-cat');
  const descEl = document.getElementById('rpa-tpl-desc');
  const stepsEl = document.getElementById('rpa-tpl-steps');
  if (nameEl) nameEl.value = seed.name || '';
  if (catEl) catEl.value = seed.cat || '我的模板';
  if (descEl) descEl.value = seed.desc || '';
  if (stepsEl) {
    try {
      stepsEl.value = typeof seed.stepsJson === 'string'
        ? seed.stepsJson
        : JSON.stringify(seed.steps || JSON.parse(RPA_TEMPLATE), null, 2);
    } catch (_) {
      stepsEl.value = RPA_TEMPLATE;
    }
  }
  dialog?.showModal?.();
}

async function saveCustomTemplateFromDialog() {
  const name = document.getElementById('rpa-tpl-name')?.value?.trim() || '自定义模板';
  const cat = document.getElementById('rpa-tpl-cat')?.value?.trim() || '我的模板';
  const desc = document.getElementById('rpa-tpl-desc')?.value?.trim() || '';
  let steps;
  try {
    steps = JSON.parse(document.getElementById('rpa-tpl-steps')?.value || '[]');
  } catch (e) {
    throw new Error(tx('步骤 JSON 无效：') + e.message);
  }
  if (!Array.isArray(steps) || !steps.length) throw new Error(tx('步骤不能为空'));
  await window.ops.rpaTemplateSaveAs({ name, cat, desc, steps, tags: ['自定义'] });
  toast(tx('模板已保存到仓库'));
  showRpaPanel('store');
  await refreshRpaStore();
}

async function refreshRpaPage() {
  try {
    await refreshStatus();
    rpaPlans = await window.ops.rpaPlans();
    if (!Array.isArray(rpaPlans)) rpaPlans = [];
  } catch (error) {
    rpaPlans = [];
    toast('加载自动脚本失败：' + error.message);
  }
  if (rpaSelectedId) {
    const plan = rpaPlans.find((p) => p.id === rpaSelectedId) || await window.ops.rpaGetPlan(rpaSelectedId);
    if (plan) loadRpaPlanToEditor(plan);
    else { rpaSelectedId = null; renderRpaPlans(); }
  } else renderRpaPlans();
  await refreshRpaStatusBadge();
  await refreshRpaTasks();
  await refreshRpaRuns();
  await refreshRpaStore();
  afterUiRender(document.getElementById('view-rpa') || document);
}

async function createRpaPlan(name) {
  const plan = await window.ops.rpaSavePlan({
    plan_name: name || ('新流程 ' + new Date().toLocaleString()),
    profile_ids: [],
    steps: JSON.parse(RPA_TEMPLATE),
  });
  rpaSelectedId = plan.id;
  showRpaPanel('flows');
  await refreshRpaPage();
  loadRpaPlanToEditor(plan);
  toast(tx('已创建流程'));
}

document.getElementById('rpa-new-plan')?.addEventListener('click', () => createRpaPlan().catch((e) => toast(e.message)));
document.getElementById('rpa-new-plan-2')?.addEventListener('click', () => createRpaPlan().catch((e) => toast(e.message)));
document.getElementById('rpa-create-task')?.addEventListener('click', () => createRpaPlan('任务流程 ' + new Date().toLocaleString()).catch((e) => toast(e.message)));
document.getElementById('rpa-refresh')?.addEventListener('click', refreshRpaPage);
document.getElementById('rpa-task-refresh')?.addEventListener('click', refreshRpaTasks);
document.getElementById('rpa-run-refresh')?.addEventListener('click', refreshRpaRuns);
document.getElementById('rpa-flow-search')?.addEventListener('input', renderRpaPlans);
document.getElementById('rpa-task-search')?.addEventListener('input', refreshRpaTasks);
document.getElementById('rpa-run-search')?.addEventListener('input', refreshRpaRuns);
document.getElementById('rpa-run-filter')?.addEventListener('change', refreshRpaRuns);
document.getElementById('rpa-store-search')?.addEventListener('input', () => {
  // debounce refetch with filters
  clearTimeout(window.__rpaStoreSearchTimer);
  window.__rpaStoreSearchTimer = setTimeout(() => refreshRpaStore().catch((e) => toast(e.message)), 280);
});
document.getElementById('rpa-store-cat')?.addEventListener('change', (event) => {
  rpaStoreActiveCat = event.target.value || '全部';
  document.querySelectorAll('#rpa-store-chips button').forEach((b) => {
    b.classList.toggle('active', b.dataset.storeCat === rpaStoreActiveCat);
  });
  refreshRpaStore().catch((e) => toast(e.message));
});
document.getElementById('rpa-store-sort')?.addEventListener('change', () => refreshRpaStore().catch((e) => toast(e.message)));
document.getElementById('rpa-store-source')?.addEventListener('change', () => refreshRpaStore().catch((e) => toast(e.message)));
document.getElementById('rpa-store-refresh')?.addEventListener('click', () => refreshRpaStore().catch((e) => toast(e.message)));
document.getElementById('rpa-store-guide')?.addEventListener('click', () => {
  showRpaPanel('guide');
});
document.getElementById('rpa-guide-back')?.addEventListener('click', () => showRpaPanel('store'));
document.getElementById('rpa-guide-create')?.addEventListener('click', () => {
  showRpaPanel('store');
  openCustomTemplateDialog({
    name: '',
    cat: '我的模板',
    desc: '',
    stepsJson: document.getElementById('rpa-steps-json')?.value || RPA_TEMPLATE,
  });
});
document.getElementById('rpa-store-import')?.addEventListener('click', async () => {
  try {
    const result = await window.ops.rpaTemplateImport();
    if (result?.canceled) return;
    toast(`导入 ${result.imported || 0} 个模板` + (result.skipped?.length ? `，跳过 ${result.skipped.length}` : ''));
    await refreshRpaStore();
  } catch (e) { toast(e.message); }
});
document.getElementById('rpa-store-export-all')?.addEventListener('click', async () => {
  try {
    const result = await window.ops.rpaTemplateExport(null);
    if (result?.canceled) return;
    toast(result.count ? `已导出 ${result.count} 个自定义模板` : '没有可导出的自定义模板（已写空包）');
  } catch (e) { toast(e.message); }
});
document.getElementById('rpa-store-custom')?.addEventListener('click', () => {
  openCustomTemplateDialog({
    name: '',
    cat: '我的模板',
    desc: '',
    stepsJson: document.getElementById('rpa-steps-json')?.value || RPA_TEMPLATE,
  });
});
document.getElementById('rpa-save-as-template')?.addEventListener('click', () => {
  const name = document.getElementById('rpa-plan-name')?.value?.trim() || '来自流程';
  openCustomTemplateDialog({
    name,
    cat: '我的模板',
    desc: '由流程「' + name + '」另存',
    stepsJson: document.getElementById('rpa-steps-json')?.value || RPA_TEMPLATE,
  });
});
document.getElementById('rpa-template-dialog')?.addEventListener('close', async () => {
  const dialog = document.getElementById('rpa-template-dialog');
  if (dialog?.returnValue !== 'save') return;
  try {
    await saveCustomTemplateFromDialog();
  } catch (e) {
    toast(e.message);
    // re-open so user can fix
    setTimeout(() => dialog.showModal?.(), 0);
  }
});
document.getElementById('rpa-preview-use')?.addEventListener('click', async () => {
  try {
    if (!rpaPreviewTemplateId) return;
    document.getElementById('rpa-template-preview')?.close?.();
    await installRpaTemplate(rpaPreviewTemplateId);
  } catch (e) { toast(e.message); }
});

document.getElementById('rpa-plan-table')?.addEventListener('click', async (event) => {
  const tr = event.target.closest('[data-rpa-plan]');
  if (!tr || event.target.closest('input')) return;
  const plan = rpaPlans.find((p) => p.id === tr.dataset.rpaPlan) || await window.ops.rpaGetPlan(tr.dataset.rpaPlan);
  if (plan) loadRpaPlanToEditor(plan);
});

document.getElementById('rpa-save')?.addEventListener('click', async () => {
  try {
    let steps;
    try { steps = JSON.parse(document.getElementById('rpa-steps-json').value || '[]'); }
    catch (e) { throw new Error(tx('步骤 JSON 无效：') + e.message); }
    if (!Array.isArray(steps)) throw new Error(tx('步骤必须是数组'));
    const plan = await window.ops.rpaSavePlan({
      id: rpaSelectedId || undefined,
      plan_name: document.getElementById('rpa-plan-name').value.trim() || '未命名流程',
      profile_ids: selectedRpaProfileIds(),
      steps,
    });
    rpaSelectedId = plan.id;
    await refreshRpaPage();
    toast(tx('已保存'));
    log('自动脚本', '保存流程 ' + plan.plan_name);
  } catch (error) { toast(error.message); }
});

document.getElementById('rpa-delete')?.addEventListener('click', async () => {
  const checked = [...document.querySelectorAll('[data-rpa-plan-check]:checked')].map((el) => el.dataset.rpaPlanCheck);
  const ids = checked.length ? checked : (rpaSelectedId ? [rpaSelectedId] : []);
  if (!ids.length) return toast(tx('请先选择流程'));
  if (!confirm(tx('确定删除选中的 ') + ids.length + tx(' 个流程？'))) return;
  try {
    for (const id of ids) await window.ops.rpaDeletePlan(id);
    if (ids.includes(rpaSelectedId)) rpaSelectedId = null;
    await refreshRpaPage();
    toast(tx('已删除'));
  } catch (error) { toast(error.message); }
});

document.getElementById('rpa-run')?.addEventListener('click', async () => {
  try {
    let steps;
    try { steps = JSON.parse(document.getElementById('rpa-steps-json').value || '[]'); }
    catch (e) { throw new Error(tx('步骤 JSON 无效：') + e.message); }
    const profileIds = selectedRpaProfileIds();
    if (!profileIds.length) throw new Error(tx('请选择至少一个已启动的环境'));
    const plan = await window.ops.rpaSavePlan({
      id: rpaSelectedId || undefined,
      plan_name: document.getElementById('rpa-plan-name').value.trim() || '未命名流程',
      profile_ids: profileIds,
      steps,
    });
    rpaSelectedId = plan.id;
    appendRpaLog('开始运行：' + plan.plan_name + ' → ' + profileIds.join(','));
    toast(tx('自动脚本运行中…'));
    const result = await window.ops.rpaRun({ plan_id: plan.id, profile_ids: profileIds });
    appendRpaLog('完成：' + JSON.stringify(result));
    toast(result.success === false ? '自动脚本有失败任务' : '自动脚本完成');
    await refreshRpaStatusBadge();
    await refreshRpaTasks();
    await refreshRpaRuns();
    log('自动脚本', '运行 ' + plan.plan_name);
  } catch (error) {
    appendRpaLog('错误：' + error.message);
    toast('运行失败：' + error.message);
  }
});

document.getElementById('rpa-stop')?.addEventListener('click', async () => {
  try {
    await window.ops.rpaStop();
    appendRpaLog('已请求停止');
    await refreshRpaStatusBadge();
    toast(tx('已停止'));
  } catch (error) { toast(error.message); }
});

document.getElementById('rpa-load-template')?.addEventListener('click', () => {
  const ta = document.getElementById('rpa-steps-json');
  if (ta) { ta.value = RPA_TEMPLATE; toast(tx('已载入示例')); }
});
document.getElementById('rpa-format-json')?.addEventListener('click', () => {
  try {
    const ta = document.getElementById('rpa-steps-json');
    if (!ta) return;
    ta.value = JSON.stringify(JSON.parse(ta.value || '[]'), null, 2);
  } catch (error) { toast('JSON 无效：' + error.message); }
});

document.getElementById('rpa-store-chips')?.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-store-cat]');
  if (!btn) return;
  rpaStoreActiveCat = btn.dataset.storeCat || '全部';
  document.querySelectorAll('#rpa-store-chips button').forEach((b) => b.classList.toggle('active', b === btn));
  const select = document.getElementById('rpa-store-cat');
  if (select) select.value = rpaStoreActiveCat;
  refreshRpaStore().catch((e) => toast(e.message));
});

// fix nav: when clicking rpa child, switch view with tab
const _origNavHandler = null;
document.addEventListener('click', (event) => {
  const nav = event.target.closest('.nav[data-view]');
  if (!nav) return;
  if (nav.dataset.view === 'rpa') {
    currentRpaTab = nav.dataset.rpaTab || currentRpaTab || 'flows';
  }
});

document.getElementById('rpa-menu-toggle')?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const menu = document.getElementById('nav-rpa-plus');
  const toggle = document.getElementById('rpa-menu-toggle');
  if (!menu || !toggle) return;
  const isCurrentlyHidden = menu.hidden || menu.style.display === 'none';
  if (isCurrentlyHidden) {
    menu.hidden = false;
    menu.style.display = 'block';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.classList.add('open');
    switchView('rpa', currentRpaTab || 'flows'); // Automatically open first sub-menu when expanded
  } else {
    menu.hidden = true;
    menu.style.display = 'none';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.classList.remove('open');
  }
});

// ========== API & MCP (local-only) ==========
function shellQuote(value) {
  return "'" + String(value ?? '').replace(/'/g, "'\\''") + "'";
}

async function refreshApiMcpPage() {
  const pill = document.getElementById('api-conn-pill');
  const urlEl = document.getElementById('api-status-url');
  const keyEl = document.getElementById('api-key-display');
  const mcpTa = document.getElementById('mcp-config-json');
  const mcpHint = document.getElementById('mcp-cmd-hint');
  const curlHint = document.getElementById('api-curl-hint');
  try {
    const info = await window.ops.localApiInfo();
    const paths = await window.ops.mcpPaths();
    const port = info?.port || paths?.port || 50325;
    const base = (info?.url || ('http://127.0.0.1:' + port + '/')).replace(/\/?$/, '/');
    const apiKey = paths?.apiKey || '';
    if (pill) {
      pill.textContent = info ? tx('运行中') : tx('未启动');
      pill.classList.toggle('off', !info);
    }
    if (urlEl) urlEl.textContent = base.replace(/\/$/, '');
    if (keyEl) keyEl.value = apiKey;
    if (keyEl && !apiKey) keyEl.placeholder = tx('未设置（可选环境变量 OPENBROWSER_API_KEY）');
    const mcpScript = paths?.mcpScript || '';
    const common = {
      mcpServers: {
        'openbrowser-local-api': {
          command: 'node',
          args: [mcpScript],
          env: {
            PORT: String(port),
            OPENBROWSER_API_PORT: String(port),
            API_KEY: apiKey || 'your_api_key',
            OPENBROWSER_API_KEY: apiKey || 'your_api_key',
          },
        },
      },
    };
    window.__mcpConfigCommon = common;
    window.__mcpConfigPlatform = {
      mcpServers: {
        'openbrowser-local-api': {
          command: 'node',
          args: [mcpScript],
          env: {
            OPENBROWSER_API_PORT: String(port),
            OPENBROWSER_API_KEY: apiKey || 'your_api_key',
          },
        },
      },
    };
    const tab = document.querySelector('#mcp-config-tabs button.active')?.dataset.mcpTab || 'common';
    if (mcpTa) mcpTa.textContent = JSON.stringify(tab === 'platform' ? window.__mcpConfigPlatform : window.__mcpConfigCommon, null, 2);
    if (mcpHint) mcpHint.textContent = 'OPENBROWSER_API_PORT=' + shellQuote(port) + (apiKey ? ' OPENBROWSER_API_KEY=' + shellQuote(apiKey) : '') + ' node ' + shellQuote(mcpScript);
    if (curlHint) curlHint.textContent = 'curl -s -H ' + shellQuote('api-key: ' + (apiKey || 'your_api_key')) + ' ' + shellQuote(base + 'api/getVersion');
    setLocalApiStatus(!!info);
  } catch (error) {
    if (pill) { pill.textContent = tx('未启动'); pill.classList.add('off'); }
    setLocalApiStatus(false);
  }
  afterUiRender(document.getElementById('view-api-mcp') || document);
}

function setLocalApiStatus(running) {
  const hint = document.getElementById('sidebar-api-hint');
  const card = document.getElementById('local-status-card');
  if (hint) hint.textContent = running ? tx('本地运行中') : tx('服务未启动');
  if (card) card.classList.toggle('is-off', !running);
}

document.getElementById('api-refresh')?.addEventListener('click', refreshApiMcpPage);
document.getElementById('api-copy-base')?.addEventListener('click', async () => {
  const url = document.getElementById('api-status-url')?.textContent || '';
  try { await navigator.clipboard.writeText(url); toast(tx('已复制')); } catch (_) { toast(url); }
});
document.getElementById('api-open-version')?.addEventListener('click', async () => {
  const out = document.getElementById('api-test-output');
  try {
    const result = await window.ops.localApiVersion();
    if (out) out.textContent = JSON.stringify(result, null, 2);
    toast(tx('接口正常'));
  } catch (error) {
    if (out) out.textContent = String(error);
    toast('请求失败：' + error.message);
  }
});
document.getElementById('api-copy-curl')?.addEventListener('click', async () => {
  const text = document.getElementById('api-curl-hint')?.textContent || '';
  try { await navigator.clipboard.writeText(text); toast(tx('已复制')); } catch (_) {}
});
document.getElementById('mcp-copy-config')?.addEventListener('click', async () => {
  const text = document.getElementById('mcp-config-json')?.textContent || '';
  try { await navigator.clipboard.writeText(text); toast(tx('已复制 MCP 配置')); } catch (_) {}
});
document.getElementById('mcp-copy-cmd')?.addEventListener('click', async () => {
  const text = document.getElementById('mcp-cmd-hint')?.textContent || '';
  try { await navigator.clipboard.writeText(text); toast(tx('已复制命令')); } catch (_) {}
});
document.getElementById('mcp-config-tabs')?.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-mcp-tab]');
  if (!btn) return;
  document.querySelectorAll('#mcp-config-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  const tab = btn.dataset.mcpTab;
  const mcpTa = document.getElementById('mcp-config-json');
  if (mcpTa) mcpTa.textContent = JSON.stringify(tab === 'platform' ? window.__mcpConfigPlatform : window.__mcpConfigCommon, null, 2);
});

window.ops.onEvent((value) => {
  if (value?.type === 'rpa-log') appendRpaLog((value.level || 'info') + ': ' + value.message);
  if (value?.type === 'rpa-task') {
    appendRpaLog('task ' + value.taskId + ' → ' + value.status + (value.message ? ' · ' + value.message : ''));
    refreshRpaStatusBadge();
    refreshRpaTasks();
    refreshRpaRuns();
  }
  if (value?.type === 'local-api') {
    setLocalApiStatus(true);
  }
});

// ========== Independent browser kernel — Donut Wayfern channel ==========
function kernelSourceLabel(source) {
  if (source === 'donut-wayfern') return 'Donut Wayfern';
  if (source === 'chrome-for-testing') return 'Chrome for Testing';
  if (source === 'custom') return '自定义';
  return source || '—';
}

async function refreshKernelPanel() {
  const badge = document.getElementById('kernel-status-badge');
  const pathEl = document.getElementById('kernel-path');
  const verEl = document.getElementById('kernel-version');
  const activePathEl = document.getElementById('kernel-active-path');
  const launchModeEl = document.getElementById('kernel-launch-mode');
  const channelEl = document.getElementById('kernel-channel');
  const prefer = document.getElementById('kernel-prefer-independent');
  const allow = document.getElementById('kernel-allow-system');
  const systemBrowser = document.getElementById('kernel-system-browser');
  try {
    const info = await window.ops.getInfo();
    updateEngineBadge(info);
    const st = info.kernel || await window.ops.kernelStatus();
    const k = st.kernel;
    if (badge) {
      badge.textContent = k ? tx('已安装 · ') + kernelSourceLabel(k.source) : tx('未安装');
      badge.style.color = k ? '#15803d' : '#b45309';
    }
    if (pathEl) pathEl.textContent = k?.path || st.kernelsRoot || '—';
    if (verEl) {
      const remote = st.meta?.remoteVersion;
      verEl.textContent = k
        ? `${k.version || '—'} · ${kernelSourceLabel(k.source)}${remote && remote !== k.version ? tx(' · 远端 ') + remote : ''}`
        : tx('点击下方从 Donut 官方源下载 Wayfern');
    }
    if (channelEl) {
      channelEl.textContent = st.channel
        ? `${st.channel.name} · ${st.channel.metaUrl}`
        : 'Donut · Wayfern · https://donutbrowser.com/wayfern.json';
    }
    const selection = info.kernelSelection;
    if (activePathEl) activePathEl.textContent = selection?.browser?.path || selection?.message || tx('未选择可执行文件');
    if (launchModeEl) {
      const mode = selection?.mode;
      launchModeEl.textContent = mode === 'independent'
        ? `独立内核 · ${selection.browser.name}`
        : mode === 'system-manual'
          ? `手动选择本机浏览器 · ${selection.browser.name}`
          : mode === 'system'
            ? `本机浏览器 · ${selection.browser.name}`
            : tx('已阻止启动：需要独立内核');
    }
    if (prefer) prefer.checked = info.preferIndependentKernel !== false;
    if (allow) allow.checked = info.allowSystemBrowserFallback === true;
    if (systemBrowser) {
      const selected = info.systemBrowserPath || '';
      systemBrowser.replaceChildren(new Option(tx('未选择'), ''));
      for (const item of info.systemBrowsers || []) {
        systemBrowser.add(new Option(`${item.name} · ${item.path}`, item.path));
      }
      systemBrowser.value = selected;
    }
  } catch (error) {
    if (badge) badge.textContent = tx('读取失败');
  }
}

document.getElementById('kernel-refresh')?.addEventListener('click', refreshKernelPanel);
document.getElementById('kernel-download')?.addEventListener('click', async () => {
  const progress = document.getElementById('kernel-progress');
  const btn = document.getElementById('kernel-download');
  try {
    if (btn) btn.disabled = true;
    if (progress) progress.textContent = tx('正在定位安装包内置内核…');
    toast(tx('重新定位内置内核…'));
    // Runtime network download is disabled — only resolve integrated seeds.
    const kernel = await window.ops.kernelDownload(false);
    if (progress) progress.textContent = tx('内置内核就绪：') + (kernel?.path || '');
    toast(tx(`${kernelSourceLabel(kernel?.source)} 已就绪 v${kernel?.version || ''}`));
    await refreshKernelPanel();
    log('Kernel', `${kernelSourceLabel(kernel?.source)} ${kernel?.version || ''} · ${kernel?.path || ''}`);
  } catch (error) {
    if (progress) progress.textContent = tx('内置内核不可用：') + error.message;
    toast(tx('内置内核不可用：') + error.message);
  } finally {
    if (btn) btn.disabled = false;
  }
});
document.getElementById('kernel-check-update')?.addEventListener('click', async () => {
  const progress = document.getElementById('kernel-progress');
  try {
    if (progress) progress.textContent = tx('读取内置内核版本…');
    const result = await window.ops.kernelCheckUpdate();
    if (result.error) {
      toast(tx('内置内核：') + result.error);
      if (progress) progress.textContent = tx('内置内核：') + result.error;
      return;
    }
    const remote = result.remote;
    const installed = result.installed;
    if (!installed && !remote) {
      toast(tx('未找到内置内核'));
      return;
    }
    const ver = installed?.version || remote?.version || '';
    const src = kernelSourceLabel(installed?.source || remote?.source);
    toast(tx(`内置内核 ${src} v${ver}（不在线更新）`));
    if (progress) progress.textContent = tx(`内置内核 ${src} · ${ver} · 运行时不自动下载`);
    await refreshKernelPanel();
  } catch (error) {
    toast(error.message);
    if (progress) progress.textContent = tx('读取失败：') + error.message;
  }
});
document.getElementById('kernel-choose')?.addEventListener('click', async () => {
  try {
    const result = await window.ops.kernelChooseCustom();
    if (result?.canceled) return;
    const kernel = result.kernel || result;
    const validation = kernel?.validation;
    const progress = document.getElementById('kernel-progress');
    if (validation?.browser) {
      toast(tx(`自定义内核验证通过：${validation.browser}`));
      if (progress) progress.textContent = tx(`兼容性验证通过：${validation.browser}`);
    } else {
      toast(tx('已设置自定义内核'));
    }
    await refreshKernelPanel();
  } catch (error) { toast(error.message); }
});
document.getElementById('kernel-prefer-independent')?.addEventListener('change', async (e) => {
  try {
    await window.ops.kernelPolicy({ preferIndependentKernel: e.target.checked });
    toast(e.target.checked ? tx('已优先独立内核') : tx('已允许使用候选列表第一项'));
  } catch (error) { toast(error.message); }
});
document.getElementById('kernel-allow-system')?.addEventListener('change', async (e) => {
  try {
    const systemBrowser = document.getElementById('kernel-system-browser');
    if (e.target.checked && !systemBrowser?.value) {
      e.target.checked = false;
      toast(tx('请先手动选择回退浏览器'));
      return;
    }
    await window.ops.kernelPolicy({ allowSystemBrowserFallback: e.target.checked });
    toast(e.target.checked
      ? tx('已允许在独立内核不可用时回退本机浏览器')
      : tx('已禁止自动回退本机浏览器'));
    await refreshKernelPanel();
  } catch (error) {
    e.target.checked = !e.target.checked;
    toast(error.message);
  }
});
document.getElementById('kernel-system-browser')?.addEventListener('change', async (e) => {
  try {
    const allow = document.getElementById('kernel-allow-system');
    await window.ops.kernelPolicy({ systemBrowserPath: e.target.value });
    if (allow && !e.target.value) allow.checked = false;
    toast(e.target.value ? tx('已选择手动回退浏览器') : tx('已清除手动回退浏览器'));
    await refreshKernelPanel();
  } catch (error) {
    toast(error.message);
    await refreshKernelPanel();
  }
});

// ---------- Cloud backup UI (本地设置) ----------
const CLOUD_BRIDGE_PRESETS = {
  gdrive: {
    id: 'gdrive',
    label: '谷歌云盘',
    provider: 'gdrive',
    dir: 'OpenBrowser',
    urlPlaceholder: 'https://alist.example.com/dav/gdrive',
    hint: 'Google Drive：用 Alist / OpenList 挂载后填 WebDAV 桥地址。',
  },
  onedrive: {
    id: 'onedrive',
    label: '微软云 OneDrive',
    provider: 'onedrive',
    dir: 'OpenBrowser',
    urlPlaceholder: 'https://alist.example.com/dav/onedrive',
    hint: '微软云 OneDrive：用 Alist / OpenList 挂载 OneDrive 后，填 WebDAV 地址。示例：https://alist.xxx.com/dav/onedrive',
  },
  quark: {
    id: 'quark',
    label: '夸克云',
    provider: 'quark',
    dir: 'OpenBrowser',
    urlPlaceholder: 'https://alist.example.com/dav/quark',
    hint: '夸克云：无官方 WebDAV，请在 Alist / OpenList 后台用 Cookie 挂载夸克网盘，再填桥接地址。',
  },
  baidu: {
    id: 'baidu',
    label: '百度云',
    provider: 'baidu',
    dir: 'OpenBrowser',
    urlPlaceholder: 'https://alist.example.com/dav/baidu',
    hint: '百度云：在 Alist / OpenList 挂载百度网盘后填 WebDAV。示例：https://alist.xxx.com/dav/baidu',
  },
};

function readBridgeFields(prefix) {
  return {
    url: ($(`#cloud-${prefix}-url`)?.value || '').trim(),
    username: ($(`#cloud-${prefix}-user`)?.value || '').trim(),
    password: $(`#cloud-${prefix}-pass`)?.value || '',
    dir: ($(`#cloud-${prefix}-dir`)?.value || 'OpenBrowser').trim() || 'OpenBrowser',
  };
}

function writeBridgeFields(prefix, data = {}) {
  if ($(`#cloud-${prefix}-url`)) $(`#cloud-${prefix}-url`).value = data.url || '';
  if ($(`#cloud-${prefix}-user`)) $(`#cloud-${prefix}-user`).value = data.username || '';
  if ($(`#cloud-${prefix}-pass`)) $(`#cloud-${prefix}-pass`).value = data.password || '';
  if ($(`#cloud-${prefix}-dir`)) $(`#cloud-${prefix}-dir`).value = data.dir || 'OpenBrowser';
}

function cloudProviderFieldsVisibility() {
  const provider = $('#cloud-provider')?.value || 'local';
  const map = {
    local: 'cloud-fields-local',
    webdav: 'cloud-fields-webdav',
    github: 'cloud-fields-github',
    gdrive: 'cloud-fields-gdrive',
    onedrive: 'cloud-fields-onedrive',
    quark: 'cloud-fields-quark',
    baidu: 'cloud-fields-baidu',
  };
  for (const [key, id] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.hidden = key !== provider;
  }
  // highlight active preset button
  $$('.cloud-preset-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.cloudPreset === provider);
  });
}

function applyCloudPreset(presetId) {
  const preset = CLOUD_BRIDGE_PRESETS[presetId];
  if (!preset) return;
  if ($('#cloud-enabled')) $('#cloud-enabled').checked = true;
  if ($('#cloud-provider')) $('#cloud-provider').value = preset.provider;
  const prefix = preset.provider;
  const urlInput = $(`#cloud-${prefix}-url`);
  if (urlInput) {
    urlInput.placeholder = preset.urlPlaceholder || urlInput.placeholder;
    // only fill placeholder-like empty URL with suggested path if blank
    if (!urlInput.value.trim()) urlInput.value = '';
  }
  if ($(`#cloud-${prefix}-dir`) && !$(`#cloud-${prefix}-dir`).value.trim()) {
    $(`#cloud-${prefix}-dir`).value = preset.dir || 'OpenBrowser';
  } else if ($(`#cloud-${prefix}-dir`)) {
    $(`#cloud-${prefix}-dir`).value = preset.dir || 'OpenBrowser';
  }
  const hint = $(`#cloud-${prefix}-hint`);
  if (hint) hint.textContent = tx(preset.hint);
  cloudProviderFieldsVisibility();
  requestAnimationFrame(() => refreshIcons());
  toast(tx(`已切换到「${preset.label}」一键配置，请填写 WebDAV 桥 URL 与账号后点保存`));
  afterUiRender(document.getElementById('view-system') || document);
  // scroll fields into view
  document.getElementById(`cloud-fields-${prefix}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}

function readCloudForm() {
  return {
    enabled: Boolean($('#cloud-enabled')?.checked),
    autoSyncOnQuit: $('#cloud-auto-quit')?.checked !== false,
    includeBrowserData: $('#cloud-include-data')?.checked !== false,
    provider: $('#cloud-provider')?.value || 'local',
    restoreMode: $('#cloud-restore-mode')?.value || 'merge',
    passphrase: $('#cloud-passphrase')?.value || '',
    local: { dir: ($('#cloud-local-dir')?.textContent || '').trim() === tx('未选择') ? '' : ($('#cloud-local-dir')?.textContent || '').trim() },
    webdav: {
      url: ($('#cloud-webdav-url')?.value || '').trim(),
      username: ($('#cloud-webdav-user')?.value || '').trim(),
      password: $('#cloud-webdav-pass')?.value || '',
      dir: ($('#cloud-webdav-dir')?.value || 'OpenBrowser').trim(),
    },
    github: {
      owner: ($('#cloud-gh-owner')?.value || '').trim(),
      repo: ($('#cloud-gh-repo')?.value || '').trim(),
      token: $('#cloud-gh-token')?.value || '',
      branch: ($('#cloud-gh-branch')?.value || 'main').trim(),
      path: ($('#cloud-gh-path')?.value || 'openbrowser/openbrowser-backup.obpack').trim(),
    },
    gdrive: readBridgeFields('gdrive'),
    onedrive: readBridgeFields('onedrive'),
    quark: readBridgeFields('quark'),
    baidu: readBridgeFields('baidu'),
  };
}

function applyCloudForm(cloud) {
  const c = cloud || {};
  if ($('#cloud-enabled')) $('#cloud-enabled').checked = Boolean(c.enabled);
  if ($('#cloud-auto-quit')) $('#cloud-auto-quit').checked = c.autoSyncOnQuit !== false;
  if ($('#cloud-include-data')) $('#cloud-include-data').checked = c.includeBrowserData !== false;
  if ($('#cloud-provider')) {
    const allowed = new Set(['local', 'webdav', 'github', 'gdrive', 'onedrive', 'quark', 'baidu']);
    $('#cloud-provider').value = allowed.has(c.provider) ? c.provider : 'local';
  }
  if ($('#cloud-restore-mode')) $('#cloud-restore-mode').value = c.restoreMode || 'merge';
  if ($('#cloud-passphrase')) $('#cloud-passphrase').value = c.passphrase || '';
  if ($('#cloud-local-dir')) $('#cloud-local-dir').textContent = c.local?.dir || tx('未选择');
  if ($('#cloud-webdav-url')) $('#cloud-webdav-url').value = c.webdav?.url || '';
  if ($('#cloud-webdav-user')) $('#cloud-webdav-user').value = c.webdav?.username || '';
  if ($('#cloud-webdav-pass')) $('#cloud-webdav-pass').value = c.webdav?.password || '';
  if ($('#cloud-webdav-dir')) $('#cloud-webdav-dir').value = c.webdav?.dir || 'OpenBrowser';
  if ($('#cloud-gh-owner')) $('#cloud-gh-owner').value = c.github?.owner || '';
  if ($('#cloud-gh-repo')) $('#cloud-gh-repo').value = c.github?.repo || '';
  if ($('#cloud-gh-token')) $('#cloud-gh-token').value = c.github?.token || '';
  if ($('#cloud-gh-branch')) $('#cloud-gh-branch').value = c.github?.branch || 'main';
  if ($('#cloud-gh-path')) $('#cloud-gh-path').value = c.github?.path || 'openbrowser/openbrowser-backup.obpack';
  writeBridgeFields('gdrive', c.gdrive || {});
  writeBridgeFields('onedrive', c.onedrive || {});
  writeBridgeFields('quark', c.quark || {});
  writeBridgeFields('baidu', c.baidu || {});
  const badge = $('#cloud-sync-badge');
  if (badge) badge.textContent = c.enabled ? (c.lastSyncAt ? tx('已同步') : tx('已启用')) : tx('未配置');
  const status = $('#cloud-sync-status');
  if (status) {
    const modeLabel = ({ merge: '智能合并', 'local-wins': '仅新增', overwrite: '覆盖' })[c.restoreMode || 'merge'] || '智能合并';
    const providerLabel = ({
      local: '本地', webdav: 'WebDAV', github: 'GitHub', gdrive: '谷歌云',
      onedrive: '微软云', quark: '夸克云', baidu: '百度云',
    })[c.provider || 'local'] || (c.provider || '本地');
    status.textContent = c.lastError
      ? (tx('上次错误：') + c.lastError)
      : (c.lastSyncAt
        ? (`上次同步：${c.lastSyncAt} · ${providerLabel} · 恢复策略：${modeLabel}`)
        : `尚未同步。当前：${providerLabel} · 恢复策略：${modeLabel}（默认不会删除本地独有环境）。`);
  }
  cloudProviderFieldsVisibility();
}

async function refreshCloudPanel() {
  if (!window.ops?.cloudGetConfig) return;
  try {
    const cloud = await window.ops.cloudGetConfig();
    applyCloudForm(cloud);
  } catch (error) {
    const status = $('#cloud-sync-status');
    if (status) status.textContent = tx('读取云配置失败：') + error.message;
  }
  afterUiRender(document.getElementById('view-system') || document);
}

function formatMergeStats(stats) {
  if (!stats) return '';
  const parts = [];
  if (stats.added) parts.push(`新增 ${stats.added}`);
  if (stats.updated) parts.push(`更新 ${stats.updated}`);
  if (stats.kept) parts.push(`保留本地 ${stats.kept}`);
  if (stats.skipped) parts.push(`跳过 ${stats.skipped}`);
  if (stats.conflicts) parts.push(`冲突处理 ${stats.conflicts}`);
  return parts.join(' · ');
}

function applyRestoredProfiles(result) {
  if (!result?.profiles) return;
  ui.profiles = result.profiles.map((p) => normalizeProfileSettings(p));
  if (Array.isArray(result.groups) && result.groups.length) {
    ui.groups = result.groups;
  }
  save();
  window.ops.syncProfiles(ui.profiles).catch(() => {});
  renderProfiles();
  refreshProxies?.().catch?.(() => {});
}

function cloudEnabledProfiles(ids) {
  const allow = new Set((ids || []).filter(Boolean));
  return ui.profiles.filter((p) => allow.has(p.id) && p.advanced?.cloudBackup);
}

async function pushProfilesToCloud(ids) {
  const enabled = cloudEnabledProfiles(ids);
  if (!enabled.length) throw new Error(tx('所选环境均未开启云备份。请到「编辑 → 偏好设置」开启。'));
  const cloud = readCloudForm();
  if (!cloud.enabled) throw new Error(tx('请先在「本地设置 → 云同步」启用云同步服务并保存配置'));
  await window.ops.cloudSetConfig(cloud);
  const list = enabled.map((p) => p.id);
  toast('正在推送 ' + list.length + ' 个环境…');
  const result = await window.ops.cloudProfilePush({
    profileIds: list,
    profiles: ui.profiles,
    groups: ui.groups || [],
    cloud,
  });
  applyCloudForm(result.cloud || cloud);
  toast('已推送 ' + (result.results?.length || list.length) + ' 个环境到云端');
  log('Cloud', '单环境推送 · ' + list.join(','));
  return result;
}

async function pullProfilesFromCloud(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) throw new Error(tx('请先选择环境'));
  const cloud = readCloudForm();
  if (!cloud.enabled) throw new Error(tx('请先在「本地设置 → 云同步」启用云同步服务并保存配置'));
  const mode = cloud.restoreMode || 'merge';
  await window.ops.cloudSetConfig(cloud);
  toast('正在拉取 ' + list.length + ' 个环境…');
  const result = await window.ops.cloudProfilePull({
    profileIds: list,
    localProfiles: ui.profiles,
    localGroups: ui.groups || [],
    mode,
    cloud,
  });
  applyRestoredProfiles(result);
  applyCloudForm(result.cloud || cloud);
  const detail = formatMergeStats(result.mergeStats);
  toast('拉取完成' + (detail ? ' · ' + detail : ''));
  log('Cloud', '单环境拉取 · ' + list.join(',') + (detail ? ' · ' + detail : ''));
  return result;
}

$('#cloud-provider')?.addEventListener('change', cloudProviderFieldsVisibility);
document.querySelectorAll('.cloud-preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => applyCloudPreset(btn.dataset.cloudPreset));
});
$('#cloud-choose-dir')?.addEventListener('click', async () => {
  try {
    const result = await window.ops.cloudChooseDir();
    if (result?.canceled || !result.dir) return;
    if ($('#cloud-local-dir')) $('#cloud-local-dir').textContent = result.dir;
  } catch (error) { toast(error.message); }
});
$('#cloud-save-cfg')?.addEventListener('click', async () => {
  try {
    const cloud = await window.ops.cloudSetConfig(readCloudForm());
    applyCloudForm(cloud);
    toast(tx('云备份配置已保存'));
  } catch (error) { toast(error.message); }
});
$('#cloud-backup-now')?.addEventListener('click', async () => {
  try {
    const cloud = readCloudForm();
    await window.ops.cloudSetConfig(cloud);
    toast(tx('正在全量备份…'));
    const result = await window.ops.cloudBackup({
      profiles: ui.profiles,
      groups: ui.groups || [],
      cloud,
    });
    applyCloudForm(result.cloud || cloud);
    toast('备份完成 · ' + (result.meta?.profileCount || 0) + ' 个环境 · ' + Math.round((result.meta?.bytes || 0) / 1024) + ' KB');
    log('Cloud', '全量备份 · ' + (result.meta?.profileCount || 0) + ' 环境');
  } catch (error) { toast('备份失败：' + error.message); }
});
$('#cloud-restore-now')?.addEventListener('click', async () => {
  const cloud = readCloudForm();
  const mode = cloud.restoreMode || 'merge';
  const warn = mode === 'overwrite'
    ? '将用云端备份完全覆盖本地环境列表，本地独有环境会丢失。确定？'
    : (mode === 'local-wins'
      ? '仅从云端新增本地没有的环境，已有环境不变。继续？'
      : '智能合并：同 ID 取较新版本，本地独有环境会保留。继续？');
  if (!confirm(warn)) return;
  try {
    await window.ops.cloudSetConfig(cloud);
    toast(tx('正在恢复…'));
    const result = await window.ops.cloudRestore({
      cloud,
      mode,
      localProfiles: ui.profiles,
      localGroups: ui.groups || [],
    });
    applyRestoredProfiles(result);
    await refreshCloudPanel();
    const detail = formatMergeStats(result.mergeStats);
    toast('恢复完成 · ' + (result.profiles?.length || 0) + ' 个环境' + (detail ? ' · ' + detail : ''));
    log('Cloud', '恢复 · ' + mode + ' · ' + (result.profiles?.length || 0) + (detail ? ' · ' + detail : ''));
  } catch (error) { toast('恢复失败：' + error.message); }
});
$('#cloud-export-file')?.addEventListener('click', async () => {
  try {
    const cloud = readCloudForm();
    const result = await window.ops.cloudExportFile({ profiles: ui.profiles, groups: ui.groups || [], cloud });
    if (result?.canceled) return;
    toast(tx('已导出备份文件'));
  } catch (error) { toast(error.message); }
});
$('#cloud-import-file')?.addEventListener('click', async () => {
  const cloud = readCloudForm();
  const mode = cloud.restoreMode || 'merge';
  const warn = mode === 'overwrite'
    ? '导入将完全覆盖本地环境列表。确定？'
    : '导入将按当前恢复策略合并。继续？';
  if (!confirm(warn)) return;
  try {
    const result = await window.ops.cloudImportFile({
      passphrase: cloud.passphrase || '',
      mode,
      localProfiles: ui.profiles,
      localGroups: ui.groups || [],
    });
    if (result?.canceled) return;
    applyRestoredProfiles(result);
    const detail = formatMergeStats(result.mergeStats);
    toast('导入完成 · ' + (result.profiles?.length || 0) + ' 个环境' + (detail ? ' · ' + detail : ''));
  } catch (error) { toast('导入失败：' + error.message); }
});
document.getElementById('editor-cloud-push-one')?.addEventListener('click', async () => {
  try {
    if (!editingProfileId) throw new Error(tx('未打开环境'));
    // ensure current form flags saved conceptually: require cloudBackup checked
    if (!$('#editor-cloud-backup')?.checked) throw new Error(tx('请先勾选「云备份」并保存环境'));
    // stamp draft cloud on and push current saved profile
    const idx = ui.profiles.findIndex((p) => p.id === editingProfileId);
    if (idx < 0) throw new Error(tx('环境不存在'));
    // apply current editor draft flags without full save
    ui.profiles[idx] = { ...ui.profiles[idx], ...editorDraft(false), updatedAt: new Date().toISOString() };
    save();
    await window.ops.syncProfiles(ui.profiles);
    await pushProfilesToCloud([editingProfileId]);
  } catch (error) { toast(error.message); }
});
document.getElementById('editor-cloud-pull-one')?.addEventListener('click', async () => {
  try {
    if (!editingProfileId) throw new Error(tx('未打开环境'));
    await pullProfilesFromCloud([editingProfileId]);
    openProfileEditor(editingProfileId);
  } catch (error) { toast(error.message); }
});

$('#cloud-push-selected')?.addEventListener('click', async () => {
  // From settings only: push all profiles that opted into cloudBackup
  try {
    const ids = ui.profiles.filter((p) => p.advanced?.cloudBackup).map((p) => p.id);
    await pushProfilesToCloud(ids);
  } catch (error) { toast(error.message); }
});
$('#cloud-pull-selected')?.addEventListener('click', async () => {
  try {
    // pull merge from full remote pack (all remote profiles), not homepage selection
    const cloud = readCloudForm();
    if (!cloud.enabled) throw new Error(tx('请先启用云同步服务'));
    await window.ops.cloudSetConfig(cloud);
    toast(tx('正在按策略从云端恢复…'));
    const result = await window.ops.cloudRestore({
      cloud,
      mode: cloud.restoreMode || 'merge',
      localProfiles: ui.profiles,
      localGroups: ui.groups || [],
    });
    applyRestoredProfiles(result);
    await refreshCloudPanel();
    toast('恢复完成 · ' + formatMergeStats(result.mergeStats));
  } catch (error) { toast(error.message); }
});

// hook system view
const _switchViewKernel = switchView;
switchView = function(view) {
  _switchViewKernel.apply(this, arguments);
  // Re-translate static + dynamic chrome for every page (API/MCP, guide, settings, store…)
  try {
    const root = document.getElementById('view-' + view) || document;
    afterUiRender(root);
    // guide + system + api are mostly static HTML — full document pass catches options/labels
    if (view === 'system' || view === 'api-mcp' || view === 'rpa' || view === 'rpa-guide' || view === 'logs') {
      afterUiRender(document);
    }
  } catch (_) {}
  if (view === 'system') {
    refreshLocaleChrome();
    try { refreshKernelPanel?.(); } catch (_) {}
    try { refreshApiMcpPage?.().catch(() => setLocalApiStatus?.(false)); } catch (_) {}
    try { refreshCloudPanel?.().catch(() => {}); } catch (_) {}
  }
  if (view === 'api-mcp') {
    try { refreshApiMcpPage?.().catch(() => {}); } catch (_) {}
    afterUiRender(document.getElementById('view-api-mcp') || document);
  }
  if (view === 'rpa-guide') {
    afterUiRender(document.getElementById('view-rpa-guide') || document);
  }
};

window.ops.onEvent((value) => {
  if (value?.type === 'kernel-progress') {
    const progress = document.getElementById('kernel-progress');
    if (!progress) return;
    if (value.phase === 'download' && value.percent != null) progress.textContent = tx(`下载中 ${value.percent}% (${Math.round((value.received||0)/1048576)}MB) · ${value.version || ''}`);
    else if (value.message) progress.textContent = value.message;
  }
  if (value?.type === 'kernel-error') {
    const progress = document.getElementById('kernel-progress');
    if (progress) progress.textContent = value.message || tx('内核准备失败');
    toast(value.message || tx('内核准备失败'));
    refreshKernelPanel().catch(() => {});
  }
  if (value?.type === 'kernel-ready') refreshKernelPanel().catch(() => {});
  if (value?.type === 'cloud-sync') {
    refreshCloudPanel().catch(() => {});
  }
});
