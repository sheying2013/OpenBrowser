$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Read-Text([string]$path) { [System.IO.File]::ReadAllText($path) }
function Write-Text([string]$path, [string]$value) { [System.IO.File]::WriteAllText($path, $value, $utf8) }

$indexPath = Join-Path $PSScriptRoot 'index.html'
$index = Read-Text $indexPath
$toolbar = '<div class="sync-toolbar"><select id="sync-group"><option>全部运行环境</option></select><button class="primary" id="start-sync">▶ 启动同步 (Ctrl+Alt+A)</button><button class="danger-sync" id="stop-sync" hidden>■ 停止同步 (Ctrl+Alt+D)</button><button class="outline" id="restart-sync" disabled>↻ 重启同步 (Ctrl+Alt+R)</button><button class="outline" id="refresh-sessions">刷新会话</button><span class="sync-selected" id="sync-selected">已选择 0 列</span></div>'
$index = [regex]::Replace($index, '<div class="sync-toolbar">.*?</div>', $toolbar, 1)
$header = '<div class="table-card sync-table"><table><thead><tr><th><input type="checkbox" id="select-all-sessions"></th><th>环境编号</th><th>环境名称</th><th>浏览器</th><th>标签页</th><th>状态</th><th>操作</th></tr></thead><tbody id="session-table"></tbody></table>'
$index = [regex]::Replace($index, '<div class="table-card sync-table"><table><thead><tr>.*?</tr></thead><tbody id="session-table"></tbody></table>', $header, 1)
Write-Text $indexPath $index

$stylesPath = Join-Path $PSScriptRoot 'styles.css'
$styles = Read-Text $stylesPath
if (-not $styles.Contains('.danger-sync{')) {
  $styles += '.danger-sync{border:1px solid #ff4d5a;background:#ff4d5a;color:#fff;border-radius:7px;padding:9px 13px;font-weight:700}.sync-selected{font-size:10px;color:#263249;font-weight:700}.sync-table tbody tr.selected-row{background:#d9efff}.sync-table tbody tr.master-row{background:#c9e9ff}.sync-role{color:#245cff;font-weight:700}.sync-role:before{content:"◉";margin-right:5px}.sync-show{border:1px solid #c8d2e4;background:#fff;color:#31415e;border-radius:6px;padding:5px 8px}.sync-toolbar button:disabled{opacity:.45;cursor:not-allowed}'
}
Write-Text $stylesPath $styles

$rendererPath = Join-Path $PSScriptRoot 'renderer.js'
$renderer = Read-Text $rendererPath
if (-not $renderer.Contains('let syncState =')) { $renderer = $renderer.Replace('let currentExtension = null;', "let currentExtension = null;`r`nlet syncState = { active: false, master: null, selected: [] };") }
$sessionFunctions = @'
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
  const ids = [...selectedSessions]; syncState.selected = ids;
  window.ops.setSyncSelection(ids).catch((error) => log('Error', error.message));
  renderSyncState();
}

'@
$renderer = [regex]::Replace($renderer, '(?s)function renderSessions\(\) \{.*?(?=function renderTabInventory\(\))', $sessionFunctions, 1)
$refresh = @'
async function refreshSessions() {
  try {
    sessions = await window.ops.syncSessions();
    const runningIds = new Set(sessions.map((item) => item.id));
    selectedSessions = new Set([...selectedSessions].filter((id) => runningIds.has(id)));
    pushSyncSelection(); renderSessions();
  } catch (error) { log('CDP', error.message); }
}

'@
$renderer = [regex]::Replace($renderer, '(?s)async function refreshSessions\(\) \{.*?(?=function selectedSessionIds)', $refresh, 1)
$renderer = $renderer.Replace("selectedSessions.add(action.dataset.id); switchView('sync');", "selectedSessions.add(action.dataset.id); pushSyncSelection(); switchView('sync');")
$renderer = [regex]::Replace($renderer, "(?m)^(  const windowButton = event\.target\.closest\('\[data-window\]'\);.*)$", '$1' + "`r`n  const showWindow = event.target.closest('[data-show-window]'); if (showWindow) runSyncAction('显示窗口', () => window.ops.windowAction([showWindow.dataset.showWindow], 'normal'));", 1)
$renderer = [regex]::Replace($renderer, "(?m)^  if \(event\.target\.dataset\.sessionSelect\) \{.*$", "  if (event.target.dataset.sessionSelect) { event.target.checked ? selectedSessions.add(event.target.dataset.sessionSelect) : selectedSessions.delete(event.target.dataset.sessionSelect); pushSyncSelection(); renderSessions(); }", 1)
$renderer = [regex]::Replace($renderer, "(?m)^\$\('#select-all-sessions'\)\.addEventListener.*$", "$('#select-all-sessions').addEventListener('change', (event) => { selectedSessions = event.target.checked ? new Set(sessions.map((item) => item.id)) : new Set(); pushSyncSelection(); renderSessions(); });", 1)
$buttonHandlers = @'
$('#refresh-sessions').addEventListener('click', refreshSessions);
$('#start-sync').addEventListener('click', () => runSyncAction('启动同步', () => window.ops.startSync(selectedSessionIds(2))));
$('#stop-sync').addEventListener('click', () => runSyncAction('停止同步', () => window.ops.stopSync()));
$('#restart-sync').addEventListener('click', () => runSyncAction('重启同步', () => window.ops.restartSync()));
'@
$renderer = [regex]::Replace($renderer, "(?m)^\$\('#refresh-sessions'\)\.addEventListener.*$", $buttonHandlers.TrimEnd(), 1)
$eventHandler = "window.ops.onEvent(async (value) => { if (value.type === 'status') { await refreshStatus(); await refreshSessions(); } if (value.type === 'extensions') await refreshExtensions(); if (value.type === 'sync-state') { syncState = { active: value.active, master: value.master, selected: value.selected || [] }; renderSessions(); log('Sync', value.active ? '同步已启动' : '同步已停止'); } if (value.type === 'sync-error') { toast(value.message); log('Error', value.message); } });"
$renderer = [regex]::Replace($renderer, '(?m)^window\.ops\.onEvent.*$', $eventHandler, 1)
$renderer = $renderer.Replace('  engineProfiles = await window.ops.syncProfiles(ui.profiles);', "  syncState = await window.ops.getSyncState();`r`n  engineProfiles = await window.ops.syncProfiles(ui.profiles);")
Write-Text $rendererPath $renderer
Write-Output 'Shortcut UI patch applied.'
