'use strict';
// Headless regression: server paging, stale responses, editor generations, session selection. Real index.html + test-only IPC; headless only.
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const session = 'ob-async-state-' + process.pid;
const results = [];
function cli(...args) {
  const raw = execFileSync('agent-browser', ['--session', session, '--json', ...args], { encoding: 'utf8', timeout: 30000 });
  const response = JSON.parse(raw.trim());
  assert.equal(response.success, true, response.error || raw);
  return response.data;
}
const evaluate = (code) => cli('eval', code).result;
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.message }); }
}

const SETUP = `(() => {
  delete window.__uiAuditCalls;
  const profiles = [];
  for (let n = 1; n <= 25; n++) {
    profiles.push({ id: 'p' + n, number: n, name: String(n), groupId: n <= 10 ? 'g1' : 'g2', browser: 'Google Chrome', proxy: 'Direct', networkMode: 'direct', tag: '', trashed: false });
  }
  window.__profiles = profiles;
  window.__pending = [];
  window.__deferred = [];
  window.__groupFor = (f) => profiles.filter((p) => (f.activeGroupFilter === 'all' || f.activeGroupFilter === p.groupId) && (!f.query || String(p.number).includes(f.query)));
  window.__pageFor = (req) => {
    const all = window.__groupFor(req.filters);
    const size = req.pageSize;
    const totalPages = Math.max(1, Math.ceil(all.length / size));
    const page = Math.min(Math.max(1, req.page), totalPages);
    const offset = (page - 1) * size;
    // Mirrors the store: an out-of-range page answers with no rows rather than clamped rows.
    const rows = (req.page > totalPages || offset >= all.length) ? [] : all.slice(offset, offset + size);
    return { total: all.length, page, pageSize: size, rows, counts: { total: all.length, active: all.length } };
  };
  window.ops.queryProfiles = (req) => new Promise((resolve, reject) => window.__pending.push({ req, resolve, reject }));
  window.__settle = (index = 0) => {
    const item = window.__pending.splice(index, 1)[0];
    if (!item) throw new Error('no pending profile request');
    item.resolve(window.__pageFor(item.req));
    return item.req;
  };
  window.__settleReject = (index = 0) => {
    const item = window.__pending.splice(index, 1)[0];
    if (!item) throw new Error('no pending profile request');
    item.reject(new Error('fixture failure'));
    return item.req;
  };
  // Drain in-flight paging work so the next case starts from a clean slate.
  window.__drain = async () => {
    for (let guard = 0; guard < 8; guard++) {
      while (window.__pending.length) {
        const item = window.__pending.shift();
        item.resolve({ total: 0, page: 1, pageSize: 10, rows: [], counts: { total: 0, active: 0 } });
      }
      await new Promise((r) => setTimeout(r, 0));
      if (!window.__pending.length && !pagedQueryInProgress && !pendingPagedQuery) break;
    }
    pagedProfilesData = null; activeGroupFilter = 'all'; profilePage = 1; selectedProfiles.clear();
  };
  window.__resetSessions = () => { window.__deferred.length = 0; sessions = []; sessionsInitialized = true; selectedSessions = new Set(); };
  ui.profiles = profiles.slice(0, 10).map((p) => normalizeProfileSettings(p));
  ui.groups = [{ id: 'g1', name: 'G1', color: '#123456' }, { id: 'g2', name: 'G2', color: '#654321' }];
  renderGroupFilterChips();
  window.ops.syncSessions = () => new Promise((resolve) => window.__deferred.push({ kind: 'sync', resolve }));
  window.ops.setSyncSelection = async () => ({});
  window.ops.getProfile = (id) => new Promise((resolve, reject) => window.__deferred.push({ kind: 'getProfile', id, resolve, reject }));
  window.ops.testProfileProxy = () => new Promise((resolve, reject) => window.__deferred.push({ kind: 'proxy', resolve, reject }));
  window.ops.applyProxyFingerprint = () => new Promise((resolve, reject) => window.__deferred.push({ kind: 'fingerprint', resolve, reject }));
  window.ops.refreshProfileProxy = () => new Promise((resolve, reject) => window.__deferred.push({ kind: 'refreshProxy', resolve, reject }));
  window.__editorProfiles = () => [
    normalizeProfileSettings({ ...profiles[0], proxy: 'socks5://127.0.0.1:1080', networkMode: 'proxy' }),
    normalizeProfileSettings({ ...profiles[1], proxy: 'socks5://127.0.0.1:1081', networkMode: 'proxy' }),
  ];
  switchView('profiles');
  return true;
})()`;

try {
  cli('--allow-file-access', '--init-script', path.join(__dirname, 'ui-audit-bridge.js'), 'open', pathToFileURL(path.join(root, 'index.html')).href);
  cli('wait', '#profile-table');
  assert.equal(evaluate(SETUP), true);

  check('server-only first page: next requests page 2 and renders it', () => {
    const value = evaluate(`(async () => {
      await window.__drain();
      const first = requestProfilesPage();
      window.__settle();
      await first;
      const before = { page: profilePage, total: pagedProfilesData.total, rows: pagedProfilesData.rows.length };
      document.querySelector('#profile-next').click();
      const next = window.__pending[0];
      await new Promise((r) => setTimeout(r, 0));
      const requested = next ? next.req.page : null;
      window.__settle();
      await new Promise((r) => setTimeout(r, 0));
      return { before, requested, page: profilePage, label: document.querySelector('#profile-page').value, rows: pagedProfilesData.rows.map((r) => r.id) };
    })()`);
    assert.equal(value.before.page, 1);
    assert.equal(value.before.total, 25);
    assert.equal(value.before.rows, 10);
    assert.equal(value.requested, 2);
    assert.equal(value.page, 2);
    assert.equal(value.label, '2');
    assert.deepEqual(value.rows, ['p11', 'p12', 'p13', 'p14', 'p15', 'p16', 'p17', 'p18', 'p19', 'p20']);
  });

  check('late response for an old group does not replace the current filter', () => {
    const value = evaluate(`(async () => {
      await window.__drain();
      document.querySelector('[data-group-filter="g1"]').click();
      const oldFilter = window.__pending[0].req.filters.activeGroupFilter;
      document.querySelector('[data-group-filter="g2"]').click();
      const queued = pendingPagedQuery && pendingPagedQuery.filters.activeGroupFilter;
      window.__settle(0);
      await new Promise((r) => setTimeout(r, 0));
      window.__settle(0);
      await new Promise((r) => setTimeout(r, 0));
      return { oldFilter, queued, active: activeGroupFilter, cached: pagedProfilesData.activeGroupFilter, rows: pagedProfilesData.rows.map((r) => r.id) };
    })()`);
    assert.equal(value.oldFilter, 'g1');
    assert.equal(value.queued, 'g2');
    assert.equal(value.active, 'g2');
    assert.equal(value.cached, 'g2');
    assert.deepEqual(value.rows, ['p11', 'p12', 'p13', 'p14', 'p15', 'p16', 'p17', 'p18', 'p19', 'p20']);
  });

  check('queued newer page wins over the in-flight older page', () => {
    const value = evaluate(`(async () => {
      await window.__drain();
      const first = requestProfilesPage();
      const firstPage = window.__pending[0].req.page;
      profilePage = 3;
      requestProfilesPage();
      window.__settle(0);
      await new Promise((r) => setTimeout(r, 0));
      const queuedPage = window.__pending[0] && window.__pending[0].req.page;
      window.__settle(0);
      await new Promise((r) => setTimeout(r, 0));
      await first;
      return { firstPage, queuedPage, page: profilePage, cachedPage: pagedProfilesData.page };
    })()`);
    assert.equal(value.firstPage, 1);
    assert.equal(value.queuedPage, 3);
    assert.equal(value.page, 3);
    assert.equal(value.cachedPage, 3);
  });

  check('failed page keeps the visible rows and rolls the label back', () => {
    const value = evaluate(`(async () => {
      await window.__drain();
      const first = requestProfilesPage();
      window.__settle();
      await first;
      const shown = pagedProfilesData.rows.map((r) => r.id);
      document.querySelector('#profile-next').click();
      await new Promise((r) => setTimeout(r, 0));
      window.__settleReject();
      await new Promise((r) => setTimeout(r, 0));
      return { page: profilePage, label: document.querySelector('#profile-page').value, rows: pagedProfilesData.rows.map((r) => r.id), shown };
    })()`);
    assert.equal(value.page, 1);
    assert.equal(value.label, '1');
    assert.deepEqual(value.rows, value.shown);
  });

  check('stale failure does not change the current page', () => {
    const value = evaluate(`(async () => {
      await window.__drain();
      const first = requestProfilesPage();
      window.__settle();
      await first;
      document.querySelector('#profile-next').click();
      const stalePage = window.__pending[0].req.page;
      profilePage = 3;
      const newest = requestProfilesPage();
      window.__settleReject(0);
      await new Promise((r) => setTimeout(r, 0));
      window.__settle(0);
      await newest;
      await new Promise((r) => setTimeout(r, 0));
      return { stalePage, page: profilePage, cachedPage: pagedProfilesData.page, label: document.querySelector('#profile-page').value };
    })()`);
    assert.equal(value.stalePage, 2);
    assert.equal(value.page, 3);
    assert.equal(value.cachedPage, 3);
    assert.equal(value.label, '3');
  });

  check('A→B→A editor reopen ignores the first A response', () => {
    const value = evaluate(`(async () => {
      await window.__drain();
      window.__deferred.length = 0;
      ui.profiles = window.__editorProfiles();
      switchView('profiles');
      const openA1 = openProfileEditor('p1');
      const oldA = window.__deferred.filter((d) => d.kind === 'getProfile' && d.id === 'p1')[0];
      openProfileEditor('p2');
      const openA2 = openProfileEditor('p1');
      const newA = window.__deferred.filter((d) => d.kind === 'getProfile' && d.id === 'p1')[1];
      oldA.resolve({ ...window.__profiles[0], title: 'STALE-A' });
      await openA1;
      newA.resolve({ ...window.__profiles[0], title: 'FRESH-A' });
      await openA2;
      const open = { editor: document.querySelector('#editor-title').value, id: editingProfileId };
      switchView('profiles');
      return { open, leftId: editingProfileId };
    })()`);
    assert.equal(value.open.editor, 'FRESH-A');
    assert.equal(value.open.id, 'p1');
    assert.equal(value.leftId, null);
  });

  check('fingerprint result for a replaced profile does not touch the newer editor', () => {
    const value = evaluate(`(async () => {
      await window.__drain();
      window.__deferred.length = 0;
      ui.profiles = window.__editorProfiles();
      switchView('profiles');
      openProfileEditor('p1');
      const fingerprint = applyEditorProxyFingerprint();
      const pending = window.__deferred.filter((d) => d.kind === 'fingerprint')[0];
      openProfileEditor('p2');
      const before = document.querySelector('#editor-timezone').value;
      pending.resolve({ timezone: 'Asia/Tokyo', countryCode: 'JP', ip: '203.0.113.9' });
      await fingerprint;
      const after = document.querySelector('#editor-timezone').value;
      switchView('profiles');
      return { before, after, id: editingProfileId };
    })()`);
    assert.equal(value.after, value.before);
    assert.notEqual(value.after, 'Asia/Tokyo');
    assert.equal(value.id, null);
  });

  check('leaving the editor invalidates an in-flight proxy test', () => {
    const value = evaluate(`(async () => {
      await window.__drain();
      window.__deferred.length = 0;
      ui.profiles = window.__editorProfiles();
      switchView('profiles');
      openProfileEditor('p1');
      const output = document.querySelector('#editor-proxy-result');
      const test = testEditorProxy();
      const pending = window.__deferred.filter((d) => d.kind === 'proxy')[0];
      switchView('profiles');
      pending.resolve({ ip: '203.0.113.9', countryCode: 'JP' });
      await test;
      const afterLeave = { id: editingProfileId, text: output.textContent };
      openProfileEditor('p2');
      const reopened = { id: editingProfileId, text: output.textContent, busy: output.getAttribute('aria-busy'), disabled: document.querySelector('#editor-test-proxy').disabled, name: document.querySelector('#editor-name')?.value };
      switchView('profiles');
      return { afterLeave, reopened };
    })()`);
    assert.equal(value.afterLeave.id, null);
    assert.notEqual(value.afterLeave.text, '连接成功 · 203.0.113.9');
    assert.equal(value.reopened.id, 'p2');
    assert.equal(value.reopened.text, '尚未检测');
    assert.equal(value.reopened.busy, 'false');
    assert.equal(value.reopened.disabled, false);
    assert.equal(value.reopened.name, '2');
  });

  check('missing local id + leave to proxies keeps the old load from reopening the editor', () => {
    const value = evaluate(`(async () => {
      await window.__drain();
      window.__deferred.length = 0;
      ui.profiles = window.__profiles.slice(0, 10).map((p) => normalizeProfileSettings(p));
      switchView('profiles');
      document.querySelector('#editor-name').value = 'UNTOUCHED';
      const open = openProfileEditor('p25');
      const pending = window.__deferred.filter((d) => d.kind === 'getProfile' && d.id === 'p25')[0];
      const registered = editingProfileId;
      switchView('proxies');
      pending.resolve({ ...window.__profiles[24], title: 'LATE-25' });
      await open;
      const view = document.querySelector('.view.active').id;
      const name = document.querySelector('#editor-name').value;
      switchView('profiles');
      return { registered, view, name, id: editingProfileId };
    })()`);
    assert.equal(value.registered, 'p25');
    assert.equal(value.view, 'view-proxies');
    assert.equal(value.name, 'UNTOUCHED');
    assert.equal(value.id, null);
  });

  check('refresh result for A does not change B proxy fields', () => {
    const value = evaluate(`(async () => {
      await window.__drain();
      window.__deferred.length = 0;
      ui.profiles = window.__editorProfiles();
      switchView('profiles');
      openProfileEditor('p1');
      document.querySelector('#editor-refresh-url').value = 'http://127.0.0.1:9/refresh';
      const refresh = refreshEditorProxy();
      const pending = window.__deferred.filter((d) => d.kind === 'refreshProxy')[0];
      openProfileEditor('p2');
      const before = { host: document.querySelector('#editor-proxy-host').value, password: document.querySelector('#editor-proxy-password').value };
      pending.resolve({ profile: { proxy: 'socks5://evil.example:9999' }, network: { ip: '203.0.113.77', countryCode: 'RU' } });
      await refresh;
      const after = { host: document.querySelector('#editor-proxy-host').value, password: document.querySelector('#editor-proxy-password').value };
      const id = editingProfileId;
      switchView('profiles');
      return { before, after, id, leftId: editingProfileId };
    })()`);
    assert.deepEqual(value.after, value.before);
    assert.notEqual(value.after.host, 'evil.example');
    assert.equal(value.id, 'p2');
    assert.equal(value.leftId, null);
  });

  check('stale catch and finally do not clear the new editor request busy state', () => {
    const value = evaluate(`(async () => {
      await window.__drain();
      window.__deferred.length = 0;
      ui.profiles = window.__editorProfiles();
      switchView('profiles');
      openProfileEditor('p1');
      const oldTest = testEditorProxy();
      const oldPending = window.__deferred.filter((d) => d.kind === 'proxy')[0];
      openProfileEditor('p2');
      const newTest = testEditorProxy();
      const newPending = window.__deferred.filter((d) => d.kind === 'proxy')[1];
      const output = document.querySelector('#editor-proxy-result');
      const busyDuring = { busy: output.getAttribute('aria-busy'), disabled: document.querySelector('#editor-test-proxy').disabled };
      oldPending.reject(new Error('stale failure'));
      await oldTest;
      const afterStale = { busy: output.getAttribute('aria-busy'), disabled: document.querySelector('#editor-test-proxy').disabled, text: output.textContent };
      newPending.resolve({ ip: '203.0.113.5', countryCode: 'JP' });
      await newTest;
      const done = { busy: output.getAttribute('aria-busy'), disabled: document.querySelector('#editor-test-proxy').disabled, text: output.textContent };
      switchView('profiles');
      return { busyDuring, afterStale, done };
    })()`);
    assert.equal(value.busyDuring.busy, 'true');
    assert.equal(value.busyDuring.disabled, true);
    assert.equal(value.afterStale.busy, 'true');
    assert.equal(value.afterStale.disabled, true);
    assert.notEqual(value.afterStale.text, '检测失败 · stale failure');
    assert.equal(value.done.busy, 'false');
    assert.equal(value.done.disabled, false);
    assert.ok(value.done.text.startsWith('连接成功'), value.done.text);
  });

  check('empty-page correction never runs concurrently and the last page target wins', () => {
    const value = evaluate(`(async () => {
      await window.__drain();
      activeGroupFilter = 'all'; profilePage = 4; pagedProfilesData = null; window.__pending.length = 0;
      let maxPending = 0;
      const track = () => { maxPending = Math.max(maxPending, window.__pending.length); };
      const outOfRange = requestProfilesPage();
      track();
      const firstReq = window.__pending[0].req.page;
      window.__settle(0);
      await outOfRange;
      await new Promise((r) => setTimeout(r, 0));
      track();
      const corrected = window.__pending[0] && window.__pending[0].req.page;
      const afterCorrectionPending = window.__pending.length;
      profilePage = 1;
      requestProfilesPage();
      await new Promise((r) => setTimeout(r, 0));
      track();
      window.__settle(0);
      await new Promise((r) => setTimeout(r, 0));
      track();
      const lastQueued = window.__pending[0] && window.__pending[0].req.page;
      window.__settle(0);
      await new Promise((r) => setTimeout(r, 0));
      const result = { firstReq, corrected, afterCorrectionPending, lastQueued, maxPending, page: profilePage, cachedPage: pagedProfilesData && pagedProfilesData.page, rows: pagedProfilesData && pagedProfilesData.rows.map((r) => r.id) };
      activeGroupFilter = 'all'; profilePage = 1; pagedProfilesData = null;
      return result;
    })()`);
    assert.equal(value.firstReq, 4);
    assert.equal(value.corrected, 3);
    assert.equal(value.afterCorrectionPending, 1);
    assert.equal(value.lastQueued, 1);
    assert.equal(value.maxPending, 1);
    assert.equal(value.page, 1);
    assert.equal(value.cachedPage, 1);
    assert.deepEqual(value.rows, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10']);
  });

  check('selection made while sessions refresh is kept', () => {
    const value = evaluate(`(async () => {
      window.__resetSessions();
      switchView('sync');
      selectedSessions = new Set(['s1']);
      const refresh = refreshSessions();
      selectedSessions = new Set(['s1', 's2']);
      const sync = window.__deferred.find((d) => d.kind === 'sync');
      sync.resolve([{ id: 's1', tabs: [] }, { id: 's2', tabs: [] }]);
      await refresh;
      return { selected: [...selectedSessions].sort(), rows: document.querySelectorAll('#session-table tr').length };
    })()`);
    assert.deepEqual(value.selected, ['s1', 's2']);
    assert.equal(value.rows, 2);
  });
} finally {
  try { cli('close', '--all'); } catch (_) {}
  for (const item of results) {
    console.log((item.ok ? 'PASS ' : 'FAIL ') + item.name + (item.ok ? '' : ' :: ' + item.error));
  }
  const failed = results.filter((item) => !item.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
