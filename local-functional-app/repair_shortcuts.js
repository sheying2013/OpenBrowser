const fs = require('fs');
const path = require('path');
const root = __dirname;

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const toolbar = '<div class="sync-toolbar"><select id="sync-group"><option>&#20840;&#37096;&#36816;&#34892;&#29615;&#22659;</option></select><button class="primary" id="start-sync">&#9654; &#21551;&#21160;&#21516;&#27493; (Ctrl+Alt+A)</button><button class="danger-sync" id="stop-sync" hidden>&#9632; &#20572;&#27490;&#21516;&#27493; (Ctrl+Alt+D)</button><button class="outline" id="restart-sync" disabled>&#8635; &#37325;&#21551;&#21516;&#27493; (Ctrl+Alt+R)</button><button class="outline" id="refresh-sessions">&#21047;&#26032;&#20250;&#35805;</button><span class="sync-selected" id="sync-selected">&#24050;&#36873;&#25321; 0 &#21015;</span></div>';
html = html.replace(/<div class="sync-toolbar">.*?<\/div>/, toolbar);
const tableHead = '<div class="table-card sync-table"><table><thead><tr><th><input type="checkbox" id="select-all-sessions"></th><th>&#29615;&#22659;&#32534;&#21495;</th><th>&#29615;&#22659;&#21517;&#31216;</th><th>&#27983;&#35272;&#22120;</th><th>&#26631;&#31614;&#39029;</th><th>&#29366;&#24577;</th><th>&#25805;&#20316;</th></tr></thead><tbody id="session-table"></tbody></table>';
html = html.replace(/<div class="table-card sync-table"><table><thead><tr>.*?<\/tr><\/thead><tbody id="session-table"><\/tbody><\/table>/, tableHead);
fs.writeFileSync(path.join(root, 'index.html'), html, 'utf8');

let renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const sessionFunctions = String.raw`function renderSessions() {
  const table = $('#session-table'); table.replaceChildren();
  for (const value of sessions) {
    const selected = selectedSessions.has(value.id);
    const role = syncState.active && syncState.master === value.id ? '\u4e3b\u63a7\u7a97\u53e3' : syncState.active && syncState.selected.includes(value.id) ? '\u88ab\u63a7\u7a97\u53e3' : '\u5f85\u540c\u6b65';
    const row = document.createElement('tr');
    if (selected) row.classList.add('selected-row');
    if (syncState.active && syncState.master === value.id) row.classList.add('master-row');
    const selectCell = document.createElement('td'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected; checkbox.dataset.sessionSelect = value.id; selectCell.append(checkbox);
    const statusCell = document.createElement('td'); statusCell.append(element('span', 'sync-role', role));
    const actionCell = document.createElement('td'); const show = element('button', 'sync-show', '\u25b1 \u663e\u793a\u7a97\u53e3'); show.dataset.showWindow = value.id; actionCell.append(show);
    row.append(selectCell, element('td', '', value.id), element('td', '', value.profile?.name || value.id), element('td', '', value.browser), element('td', '', String(value.tabs.length)), statusCell, actionCell); table.append(row);
  }
  $('#session-empty').style.display = sessions.length ? 'none' : 'block';
  $('#selected-count').textContent = '\u5df2\u9009 ' + selectedSessions.size;
  $('#sync-selected').textContent = '\u5df2\u9009\u62e9 ' + selectedSessions.size + ' \u5217';
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

`;
renderer = renderer.replace(/function renderSessions\(\) \{[\s\S]*?(?=function renderTabInventory\(\))/, sessionFunctions);
renderer = renderer.replace(/^  const showWindow = .*$/m, String.raw`  const showWindow = event.target.closest('[data-show-window]'); if (showWindow) runSyncAction('\u663e\u793a\u7a97\u53e3', () => window.ops.windowAction([showWindow.dataset.showWindow], 'normal'));`);
renderer = renderer.replace(/^\$\('#refresh-sessions'\)\.addEventListener[\s\S]*?(?=^\$\('#send-text'\))/m, String.raw`$('#refresh-sessions').addEventListener('click', refreshSessions);
$('#start-sync').addEventListener('click', () => runSyncAction('\u542f\u52a8\u540c\u6b65', () => window.ops.startSync(selectedSessionIds(2))));
$('#stop-sync').addEventListener('click', () => runSyncAction('\u505c\u6b62\u540c\u6b65', () => window.ops.stopSync()));
$('#restart-sync').addEventListener('click', () => runSyncAction('\u91cd\u542f\u540c\u6b65', () => window.ops.restartSync()));
`);
renderer = renderer.replace(/^window\.ops\.onEvent.*$/m, String.raw`window.ops.onEvent(async (value) => { if (value.type === 'status') { await refreshStatus(); await refreshSessions(); } if (value.type === 'extensions') await refreshExtensions(); if (value.type === 'sync-state') { syncState = { active: value.active, master: value.master, selected: value.selected || [] }; renderSessions(); log('Sync', value.active ? '\u540c\u6b65\u5df2\u542f\u52a8' : '\u540c\u6b65\u5df2\u505c\u6b62'); } if (value.type === 'sync-error') { toast(value.message); log('Error', value.message); } });`);
fs.writeFileSync(path.join(root, 'renderer.js'), renderer, 'utf8');

let main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
main = main.replace(/if \(selected\.length < 2\) throw new Error\('.*?'\);/, String.raw`if (selected.length < 2) throw new Error('\u8bf7\u81f3\u5c11\u9009\u62e9\u4e24\u4e2a\u8fd0\u884c\u4e2d\u7684\u6d4f\u89c8\u5668\u73af\u5883');`);
fs.writeFileSync(path.join(root, 'main.js'), main, 'utf8');
process.stdout.write('Shortcut encoding repaired.\n');
