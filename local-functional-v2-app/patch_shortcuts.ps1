$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Read-Text([string]$path) { return [System.IO.File]::ReadAllText($path) }
function Write-Text([string]$path, [string]$value) { [System.IO.File]::WriteAllText($path, $value, $utf8) }
function Replace-Exact([string]$value, [string]$old, [string]$new, [string]$label) {
  if (-not $value.Contains($old)) { throw "Pattern not found: $label" }
  return $value.Replace($old, $new)
}

$mainPath = Join-Path $PSScriptRoot 'main.js'
$main = Read-Text $mainPath
$main = Replace-Exact $main "const { app, BrowserWindow, dialog, ipcMain, screen, session } = require('desktop-shell');" "const { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen, session } = require('desktop-shell');" 'desktop-shell import'
$main = Replace-Exact $main "let quitting = false;" "let quitting = false;`r`nlet syncSelection = [];`r`nlet syncState = { active: false, master: null, selected: [] };" 'sync globals'
$helpers = @'
function syncSnapshot() { return { ...syncState, selected: [...syncState.selected] }; }

async function beginSync(ids = syncSelection) {
  const selected = sanitizeIds(ids);
  if (selected.length < 2) throw new Error('Select at least two running browser environments');
  syncSelection = selected;
  await tile(selected, false);
  const tabs = await syncTabsFromMaster(selected);
  syncState = { active: true, master: selected[0], selected };
  emit({ type: 'sync-state', ...syncSnapshot() });
  return { success: true, ...tabs, state: syncSnapshot() };
}

function endSync() {
  syncState = { active: false, master: null, selected: [...syncSelection] };
  emit({ type: 'sync-state', ...syncSnapshot() });
  return { success: true, state: syncSnapshot() };
}

async function restartSync() {
  endSync();
  return beginSync(syncSelection);
}

async function runShortcut(action) {
  try {
    if (action === 'start') await beginSync(syncSelection);
    else if (action === 'stop') endSync();
    else await restartSync();
  } catch (error) {
    emit({ type: 'sync-error', action, message: error.message });
  }
}

'@
$main = Replace-Exact $main "async function createWindow() {" ($helpers + "async function createWindow() {") 'sync helper insertion'
$oldStart = @'
  ipcMain.handle('sync:start', async (_event, ids) => {
    const selected = sanitizeIds(ids); await tile(selected, false); const tabs = await syncTabsFromMaster(selected); return { success: true, ...tabs };
  });
'@
$newStart = @'
  ipcMain.handle('sync:selection', (_event, ids) => { syncSelection = sanitizeIds(ids); syncState.selected = [...syncSelection]; emit({ type: 'sync-state', ...syncSnapshot() }); return syncSnapshot(); });
  ipcMain.handle('sync:state', () => syncSnapshot());
  ipcMain.handle('sync:start', (_event, ids) => beginSync(ids));
  ipcMain.handle('sync:stop', () => endSync());
  ipcMain.handle('sync:restart', () => restartSync());
'@
$main = Replace-Exact $main $oldStart $newStart 'sync ipc handlers'
$shortcutRegistration = @'
  engine.on(emit);
  globalShortcut.register('Control+Alt+A', () => runShortcut('start'));
  globalShortcut.register('Control+Alt+D', () => runShortcut('stop'));
  globalShortcut.register('Control+Alt+R', () => runShortcut('restart'));
'@
$main = Replace-Exact $main "  engine.on(emit);" $shortcutRegistration.TrimEnd() 'shortcut registration'
$main = Replace-Exact $main "app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });" "app.on('will-quit', () => globalShortcut.unregisterAll());`r`napp.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });" 'shortcut cleanup'
Write-Text $mainPath $main

$preloadPath = Join-Path $PSScriptRoot 'preload.js'
$preload = Read-Text $preloadPath
$preload = Replace-Exact $preload "  startSync: (ids) => ipcRenderer.invoke('sync:start', ids)," "  setSyncSelection: (ids) => ipcRenderer.invoke('sync:selection', ids),`r`n  getSyncState: () => ipcRenderer.invoke('sync:state'),`r`n  startSync: (ids) => ipcRenderer.invoke('sync:start', ids),`r`n  stopSync: () => ipcRenderer.invoke('sync:stop'),`r`n  restartSync: () => ipcRenderer.invoke('sync:restart')," 'preload sync methods'
Write-Text $preloadPath $preload

$indexPath = Join-Path $PSScriptRoot 'index.html'
$index = Read-Text $indexPath
$oldToolbar = '<div class="sync-toolbar"><select id="sync-group"><option>全部运行环境</option></select><button class="primary" id="start-sync">▶ 启动同步</button><button class="outline" id="refresh-sessions">↻ 刷新会话</button></div>'
$newToolbar = '<div class="sync-toolbar"><select id="sync-group"><option>全部运行环境</option></select><button class="primary" id="start-sync">▶ 启动同步 (Ctrl+Alt+A)</button><button class="danger-sync" id="stop-sync" hidden>■ 停止同步 (Ctrl+Alt+D)</button><button class="outline" id="restart-sync" disabled>↻ 重启同步 (Ctrl+Alt+R)</button><button class="outline" id="refresh-sessions">刷新会话</button><span class="sync-selected" id="sync-selected">已选择 0 列</span></div>'
$index = Replace-Exact $index $oldToolbar $newToolbar 'sync toolbar html'
$oldTable = '<div class="table-card sync-table"><table><thead><tr><th><input type="checkbox" id="select-all-sessions"></th><th>环境编号</th><th>环境名称</th><th>浏览器</th><th>标签页</th><th>CDP</th></tr></thead><tbody id="session-table"></tbody></table>'
$newTable = '<div class="table-card sync-table"><table><thead><tr><th><input type="checkbox" id="select-all-sessions"></th><th>环境编号</th><th>环境名称</th><th>浏览器</th><th>标签页</th><th>状态</th><th>操作</th></tr></thead><tbody id="session-table"></tbody></table>'
$index = Replace-Exact $index $oldTable $newTable 'sync table html'
Write-Text $indexPath $index

$stylesPath = Join-Path $PSScriptRoot 'styles.css'
$styles = Read-Text $stylesPath
$styles += @'

.danger-sync{border:1px solid #ff4d5a;background:#ff4d5a;color:#fff;border-radius:7px;padding:9px 13px;font-weight:700}.sync-selected{font-size:10px;color:#263249;font-weight:700}.sync-table tbody tr.selected-row{background:#d9efff}.sync-table tbody tr.master-row{background:#c9e9ff}.sync-role{color:#245cff;font-weight:700}.sync-role:before{content:"◉";margin-right:5px}.sync-show{border:1px solid #c8d2e4;background:#fff;color:#31415e;border-radius:6px;padding:5px 8px}.sync-toolbar button:disabled{opacity:.45;cursor:not-allowed}
'@
Write-Text $stylesPath $styles

$rendererPath = Join-Path $PSScriptRoot 'renderer.js'
$renderer = Read-Text $rendererPath
$renderer = Replace-Exact $renderer "let currentExtension = null;" "let currentExtension = null;`r`nlet syncState = { active: false, master: null, selected: [] };" 'renderer sync state'
$newRenderSessions = @'
function renderSessions() {
  const table = $('#session-table'); table.replaceChildren();
  for (const value of sessions) {
    const selected = selectedSessions.has(value.id);
    const role = syncState.active && syncState.master === value.id ? '主控窗口' : syncState.active && syncState.selected.includes(value.id) ? '被控窗口' : '待同步';
    const row = document.createElement('tr');
    if (selected) row.classList.add('selected-row');
    if (syncState.active && syncState.master === value.id) row.classList.add('master-row');
    const selectCell = document.createElement('td'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected; checkbox.dataset.sessionSelect = value.id; selectCell.append(checkbox);
    const statusCell = document.createElement('td'); statusCell.append(element('span', 'sync-role', role));
    const actionCell = document.createElement('td'); const show = element('button', 'sync-show', '▱ 显示窗口'); show.dataset.showWindow = value.id; actionCell.append(show);
    row.append(selectCell, element('td', '', value.id), element('td', '', value.profile?.name || value.id), element('td', '', value.browser), element('td', '', String(value.tabs.length)), statusCell, actionCell); table.append(row);
  }
  $('#session-empty').style.display = sessions.length ? 'none' : 'block';
  $('#selected-count').textContent = `已选 ${selectedSessions.size}`;
  $('#sync-selected').textContent = `已选择 ${selectedSessions.size} 列`;
  renderSyncState(); renderTabInventory();
}

function renderSyncState() {
  $('#start-sync').hidden = syncState.active;
  $('#stop-sync').hidden = !syncState.active;
  $('#restart-sync').disabled = selectedSessions.size < 2;
}

function pushSyncSelection() {
  const ids = [...selectedSessions];
  syncState.selected = ids;
  window.ops.setSyncSelection(ids).catch((error) => log('Error', error.message));
  renderSyncState();
}

'@
$renderer = [regex]::Replace($renderer, '(?s)function renderSessions\(\) \{.*?(?=function renderTabInventory\(\))', $newRenderSessions, 1)
$renderer = Replace-Exact $renderer "  try { sessions = await window.ops.syncSessions(); const runningIds = new Set(sessions.map((item) => item.id)); selectedSessions = new Set([...selectedSessions].filter((id) => runningIds.has(id))); renderSessions(); }" "  try { sessions = await window.ops.syncSessions(); const runningIds = new Set(sessions.map((item) => item.id)); selectedSessions = new Set([...selectedSessions].filter((id) => runningIds.has(id))); pushSyncSelection(); renderSessions(); }" 'refresh selection push'
$renderer = Replace-Exact $renderer "if (action?.dataset.action === 'select-sync') { selectedSessions.add(action.dataset.id); switchView('sync'); }" "if (action?.dataset.action === 'select-sync') { selectedSessions.add(action.dataset.id); pushSyncSelection(); switchView('sync'); }" 'profile select sync'
$renderer = Replace-Exact $renderer "  const windowButton = event.target.closest('[data-window]'); if (windowButton) runSyncAction('窗口操作', () => window.ops.windowAction(selectedSessionIds(), windowButton.dataset.window));" "  const windowButton = event.target.closest('[data-window]'); if (windowButton) runSyncAction('窗口操作', () => window.ops.windowAction(selectedSessionIds(), windowButton.dataset.window));`r`n  const showWindow = event.target.closest('[data-show-window]'); if (showWindow) runSyncAction('显示窗口', () => window.ops.windowAction([showWindow.dataset.showWindow], 'normal'));" 'show window action'
$renderer = Replace-Exact $renderer "  if (event.target.dataset.sessionSelect) { event.target.checked ? selectedSessions.add(event.target.dataset.sessionSelect) : selectedSessions.delete(event.target.dataset.sessionSelect); $('#selected-count').textContent = ``已选 `${selectedSessions.size}``; renderTabInventory(); }" "  if (event.target.dataset.sessionSelect) { event.target.checked ? selectedSessions.add(event.target.dataset.sessionSelect) : selectedSessions.delete(event.target.dataset.sessionSelect); pushSyncSelection(); renderSessions(); }" 'session checkbox'
$renderer = Replace-Exact $renderer "$('#select-all-sessions').addEventListener('change', (event) => { selectedSessions = event.target.checked ? new Set(sessions.map((item) => item.id)) : new Set(); renderSessions(); });" "$('#select-all-sessions').addEventListener('change', (event) => { selectedSessions = event.target.checked ? new Set(sessions.map((item) => item.id)) : new Set(); pushSyncSelection(); renderSessions(); });" 'select all sessions'
$renderer = Replace-Exact $renderer "$('#refresh-sessions').addEventListener('click', refreshSessions); $('#start-sync').addEventListener('click', () => runSyncAction('启动同步', () => window.ops.startSync(selectedSessionIds(2))));" "$('#refresh-sessions').addEventListener('click', refreshSessions);`r`n$('#start-sync').addEventListener('click', () => runSyncAction('启动同步', () => window.ops.startSync(selectedSessionIds(2))));`r`n$('#stop-sync').addEventListener('click', () => runSyncAction('停止同步', () => window.ops.stopSync()));`r`n$('#restart-sync').addEventListener('click', () => runSyncAction('重启同步', () => window.ops.restartSync()));" 'sync button handlers'
$renderer = Replace-Exact $renderer "window.ops.onEvent(async (value) => { if (value.type === 'status') { await refreshStatus(); await refreshSessions(); } if (value.type === 'extensions') await refreshExtensions(); });" "window.ops.onEvent(async (value) => { if (value.type === 'status') { await refreshStatus(); await refreshSessions(); } if (value.type === 'extensions') await refreshExtensions(); if (value.type === 'sync-state') { syncState = { active: value.active, master: value.master, selected: value.selected || [] }; renderSessions(); log('Sync', value.active ? '同步已启动' : '同步已停止'); } if (value.type === 'sync-error') { toast(value.message); log('Error', value.message); } });" 'engine sync events'
$renderer = Replace-Exact $renderer "  engineProfiles = await window.ops.syncProfiles(ui.profiles); await refreshExtensions();" "  syncState = await window.ops.getSyncState();`r`n  engineProfiles = await window.ops.syncProfiles(ui.profiles); await refreshExtensions();" 'initial sync state'
Write-Text $rendererPath $renderer

Write-Output 'Shortcut patch applied.'
