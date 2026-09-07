/**
 * OpenBrowser UI submodule
 */
const {
  toast,
  tx,
  t,
  log,
  element,
  buildSquareMark,
  displayProfileNumber,
  updateEngineBadge,
  afterUiRender,
  syncThemedSelects,
} = window.OpenBrowserApp || window;
const $ = window.$ || ((s, root = document) => root.querySelector(s));
const $$ = window.$$ || ((s, root = document) => [...root.querySelectorAll(s)]);
const ui = window.OpenBrowserApp?.ui || window.ui || { profiles: [] };
const save = window.OpenBrowserApp?.save || window.save || (() => {});

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

window.refreshCloudPanel = refreshCloudPanel;
window.CLOUD_BRIDGE_PRESETS = CLOUD_BRIDGE_PRESETS;
window.pushProfilesToCloud = pushProfilesToCloud;
window.pullProfilesFromCloud = pullProfilesFromCloud;
