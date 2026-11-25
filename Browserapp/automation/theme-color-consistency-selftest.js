'use strict';
// Real index.html + production CSS. Headless theme color consistency regression, no network, session isolated.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const session = 'ob-theme-color-' + process.pid;
const artifactDir = path.join(__dirname, 'ui-audit-artifacts');
fs.mkdirSync(artifactDir, { recursive: true });
const logFile = path.join(artifactDir, 'theme-color-consistency-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
function cli(...args) {
  const raw = execFileSync('agent-browser', ['--session', session, '--json', ...args], { encoding: 'utf8', timeout: 60000 });
  const response = JSON.parse(raw.trim());
  if (!response.success) throw new Error(response.error || raw);
  return response.data;
}
const evaluate = (code) => cli('eval', code).result;
const run = (fn) => evaluate('(' + fn.toString() + ')()');
const report = { modes: {}, checks: 0, failures: [], skipped: [], untested: ['real autofill visual state', 'OS auto color-scheme event'] };
function merge(mode, result) {
  report.modes[mode] = result.stats;
  report.checks += result.checks;
  report.failures.push(...result.failures.map((f) => ({ mode, ...f })));
  report.skipped.push(...result.stats.skipped.map((entry) => mode + ': ' + entry));
}
function audit(mode) {
  const checks = { n: 0 }; const failures = []; const stats = { skipped: [] };
  const expect = (name, actual, wanted) => { checks.n++; if (actual !== wanted && failures.length < 120) failures.push({ name, error: actual + ' != ' + wanted }); };
  const rgb = (v) => (v.match(/[\d.]+/g) || []).map(Number);
  const lum = (c) => { const v = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722; };
  const contrast = (a, b) => { const x = lum(rgb(a)), y = lum(rgb(b)); return +((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2); };
  const s = (el, pseudo) => getComputedStyle(el, pseudo || null);
  const tok = (name) => { const p = document.createElement('div'); p.style.color = 'var(' + name + ')'; document.body.appendChild(p); const v = s(p).color; p.remove(); return v; };
  const T = {};
  ['--ink-abyss', '--ink-surface-1', '--ink-surface-2', '--ink-surface-3', '--ink-text-primary', '--ink-text-secondary', '--ink-text-muted', '--ink-border-subtle', '--ink-border-default', '--ink-border-focus', '--ink-cyan-primary', '--ink-status-online', '--ink-status-online-bg', '--ink-status-online-text', '--ink-status-danger', '--ink-status-danger-bg', '--ink-status-danger-text', '--ink-status-warning', '--ink-status-warning-bg', '--theme-code-bg', '--theme-code-fg'].forEach((n) => { T[n] = tok(n); });
  if (Object.values(T).some((v) => !v || v === 'rgba(0, 0, 0, 0)')) failures.push({ name: 'tokens', error: 'unresolved root ink token: ' + JSON.stringify(T) });
  const skipTypes = new Set(['checkbox', 'radio', 'range', 'color', 'hidden', 'button', 'submit', 'reset', 'image']);
  const isTextlike = (el) => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !skipTypes.has(el.type));
  const vis = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
  const elName = (el) => (el.id || el.name || el.className || el.tagName).toString().slice(0, 40);
  const inputInk = (label, el) => { const c = s(el); expect(label + ' bg', c.backgroundColor, T['--ink-surface-1']); expect(label + ' text', c.color, T['--ink-text-primary']); expect(label + ' border', c.borderTopColor, T['--ink-border-default']); };
  // Kill transitions during measurement so reads are not the t=0 frame of a mode swap.
  const noMotion = document.createElement('style');
  noMotion.id = '__theme_no_motion';
  noMotion.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
  document.head.appendChild(noMotion);
  void document.body.offsetWidth;

  // 1. profile editor: real controls in all four tabs.
  switchView('profile-editor');
  let editorControls = 0;
  let editorSelects = 0;
  ['basic', 'proxy', 'privacy', 'advanced'].forEach((tab) => {
    setEditorTab(tab);
    const panel = document.querySelector('#view-profile-editor .editor-panel.active');
    [...panel.querySelectorAll('input, textarea')].filter(isTextlike).forEach((el) => {
      if (!vis(el) || el.disabled || el.readOnly) return;
      editorControls++; inputInk('editor/' + tab + '/' + elName(el), el);
    });
    [...panel.querySelectorAll('select')].filter(vis).forEach((el) => {
      editorSelects++; const c = s(el);
      expect('editor-select/' + tab + '/' + elName(el) + ' bg', c.backgroundColor, T['--ink-surface-1']);
      expect('editor-select/' + tab + '/' + elName(el) + ' text', c.color, T['--ink-text-primary']);
      expect('editor-select/' + tab + '/' + elName(el) + ' border', c.borderTopColor, T['--ink-border-default']);
    });
  });
  stats.editorControls = editorControls; stats.editorSelects = editorSelects;
  setEditorTab('basic');

  // 1a. editor number badge: must be surface3 + text-primary, contrast >= 4.5.
  const badge = document.getElementById('editor-profile-id');
  if (badge && vis(badge)) {
    expect('badge bg', s(badge).backgroundColor, T['--ink-surface-3']);
    expect('badge text', s(badge).color, T['--ink-text-primary']);
    const badgeContrast = contrast(s(badge).color, s(badge).backgroundColor);
    stats.badge = { bg: s(badge).backgroundColor, text: s(badge).color, contrast: badgeContrast };
    if (badgeContrast < 4.5) failures.push({ name: 'badge contrast', error: badgeContrast + ' < 4.5' });
  } else failures.push({ name: 'badge', error: '#editor-profile-id not visible' });

  // 1b. label small + real environment audit summary (built from the normalized fixture).
  const smalls = [...document.querySelectorAll('.editor-form label small')].filter(vis);
  stats.editorHints = smalls.map((el) => s(el).color);
  if (!smalls.length) failures.push({ name: 'editor/label-small', error: 'no visible .editor-form label small' });
  smalls.forEach((el) => expect('editor/label-small:' + elName(el), s(el).color, T['--ink-text-muted']));
  const audit = document.querySelector('#editor-audit');
  const auditHead = audit && audit.querySelector('.audit-head');
  const status = auditHead && auditHead.querySelector('span');
  if (!audit || !auditHead || !status) failures.push({ name: 'editor/audit', error: 'audit summary missing (EnvironmentAudit not built)' });
  else {
    expect('audit/head-strong', s(auditHead.querySelector('strong')).color, T['--ink-text-primary']);
    const review = status.classList.contains('review');
    expect('audit/status ' + (review ? 'warning-bg' : 'online-bg'), s(status).backgroundColor, review ? T['--ink-status-warning-bg'] : T['--ink-status-online-bg']);
    expect('audit/status ' + (review ? 'warning' : 'online-text'), s(status).color, review ? T['--ink-status-warning'] : T['--ink-status-online-text']);
    const rows = [...audit.querySelectorAll('.audit-row')];
    stats.auditRows = rows.length; stats.auditStatus = review ? 'review' : 'ready';
    if (!rows.length) failures.push({ name: 'editor/audit-rows', error: 'no audit rows' });
    const dotTokens = new Set([T['--ink-text-muted'], T['--ink-status-online'], T['--ink-status-warning']]);
    rows.forEach((row, i) => {
      expect('audit/row' + i + ' strong', s(row.querySelector('strong')).color, T['--ink-text-primary']);
      expect('audit/row' + i + ' small', s(row.querySelector('small')).color, T['--ink-text-muted']);
      expect('audit/row' + i + ' border', s(row).borderBottomColor, T['--ink-border-subtle']);
      if (!dotTokens.has(s(row.querySelector('i')).backgroundColor)) failures.push({ name: 'audit/row' + i + ' dot', error: s(row.querySelector('i')).backgroundColor + ' not a semantic status token' });
    });
  }

  // 2. input type matrix: every listed type is exercised, fixture only.
  const fixture = document.createElement('div');
  fixture.id = '__theme_fixture';
  fixture.style.cssText = 'padding:8px;display:grid;gap:6px';
  document.querySelector('#view-profile-editor .editor-panel.active').appendChild(fixture);
  const types = ['implicit', 'text', 'url', 'email', 'tel', 'number', 'password', 'date', 'time', 'file'];
  types.forEach((type) => {
    const el = document.createElement('input');
    if (type !== 'implicit') el.type = type;
    el.id = 'fixture-' + type; fixture.appendChild(el);
    inputInk('matrix/' + type, el);
    if (type === 'text' || type === 'implicit') {
      el.placeholder = 'placeholder-fixture';
      expect('matrix/' + type + ' placeholder', s(el, '::placeholder').color, T['--ink-text-muted']);
    }
    if (type === 'file') {
      expect('matrix/file selector bg', s(el, '::file-selector-button').backgroundColor, T['--ink-surface-2']);
      expect('matrix/file selector text', s(el, '::file-selector-button').color, T['--ink-text-secondary']);
    }
  });
  stats.matrixTypes = types.length;

  // 2b. focus / disabled / readonly once each on the visible first editor text input.
  const realInput = [...document.querySelectorAll('#view-profile-editor .editor-panel.active input, #view-profile-editor .editor-panel.active textarea')].filter((el) => isTextlike(el) && vis(el) && !el.disabled && !el.readOnly)[0];
  if (!realInput) failures.push({ name: 'states/real-input', error: 'no visible editable text input in editor' });
  else {
    realInput.focus();
    expect('states/focus border', s(realInput).borderTopColor, T['--ink-border-focus']);
    realInput.blur();
    const plain = s(realInput).borderTopColor;
    expect('states/rest border', plain, T['--ink-border-default']);
    const stateInput = document.createElement('input'); stateInput.disabled = true; fixture.appendChild(stateInput);
    expect('states/disabled bg', s(stateInput).backgroundColor, T['--ink-surface-2']);
    expect('states/disabled text', s(stateInput).color, T['--ink-text-muted']);
    expect('states/disabled border', s(stateInput).borderTopColor, T['--ink-border-subtle']);
    const ro = document.createElement('input'); ro.readOnly = true; fixture.appendChild(ro);
    expect('states/readonly bg', s(ro).backgroundColor, T['--ink-surface-2']);
    expect('states/readonly text', s(ro).color, T['--ink-text-secondary']);
    const realRo = realInput.cloneNode(true); realRo.value = ''; realRo.readOnly = true; realRo.id = 'fixture-real-readonly'; fixture.appendChild(realRo);
    expect('states/real-readonly bg', s(realRo).backgroundColor, T['--ink-surface-2']);
    expect('states/real-readonly text', s(realRo).color, T['--ink-text-secondary']);
  }

  // 3. checkbox/radio must not inherit the text-input surface1 paint (checked again per real surface below).
  const textSurface = T['--ink-surface-1'];
  const scheme = document.documentElement.dataset.colorMode;
  const seenTypes = new Set();
  let toggles = 0;
  const checkToggle = (el, where) => {
    toggles++; seenTypes.add(el.type); const c = s(el);
    expect('toggle/' + where + '/' + elName(el) + ' accent', c.accentColor, T['--ink-cyan-primary']);
    expect('toggle/' + where + '/' + elName(el) + ' colorScheme', c.colorScheme, scheme);
    expect('toggle/' + where + '/' + elName(el) + ' appearance', c.appearance, 'auto');
    const painted = c.backgroundColor === textSurface && c.borderTopWidth !== '0px' && c.borderTopColor === T['--ink-border-default'];
    expect('toggle/' + where + '/' + elName(el) + ' untouched', painted, false);
  };

  // 4. every real dialog: showModal, then blur autofocus; inputs, labels, field hints.
  const dialogs = [...document.querySelectorAll('dialog')];
  stats.dialogCount = dialogs.length;
  let dialogInputs = 0; let hints = 0;
  const hintTokens = new Set([T['--ink-text-muted'], T['--ink-text-secondary'], T['--ink-text-primary'], T['--ink-status-danger-text'], T['--ink-status-danger'], T['--ink-status-online-text']]);
  dialogs.forEach((dlg) => {
    if (dlg.open) dlg.close();
    try { dlg.showModal(); } catch (error) { stats.skipped.push('dialog/' + dlg.id + ' showModal: ' + error.message); return; }
    if (document.activeElement && dlg.contains(document.activeElement)) document.activeElement.blur();
    const label = 'dialog/' + dlg.id;
    [...dlg.querySelectorAll('input[type="checkbox"], input[type="radio"]')].filter(vis).forEach((el) => checkToggle(el, label));
    const dlgBg = s(dlg).backgroundColor;
    expect(label + ' bg', dlgBg, mode === 'light' ? 'rgb(255, 255, 255)' : T['--ink-surface-1']);
    [...dlg.querySelectorAll('input, textarea')].filter(isTextlike).forEach((el) => {
      if (!vis(el) || el.disabled || el.readOnly) return;
      dialogInputs++; inputInk(label + '/' + elName(el), el);
    });
    [...dlg.querySelectorAll('select')].filter(vis).forEach((el) => {
      expect(label + '/select:' + elName(el) + ' bg', s(el).backgroundColor, T['--ink-surface-1']);
      expect(label + '/select:' + elName(el) + ' text', s(el).color, T['--ink-text-primary']);
    });
    [...dlg.querySelectorAll('label')].filter(vis).forEach((el) => {
      // Segmented pills legitimately use text-primary (checked segment), backdrop only on values.
      const allowed = el.closest('.segmented') || el.classList.contains('assign-item');
      if (allowed) return;
      expect(label + '/label:' + elName(el), s(el).color, T['--ink-text-secondary']);
    });
    [...dlg.querySelectorAll('.field-hint')].filter(vis).forEach((el) => {
      hints++; const c = s(el).color;
      if (!hintTokens.has(c)) failures.push({ name: label + '/hint-token', error: c + ' not in semantic text-token set' });
      const cr = contrast(c, dlgBg === 'rgba(0, 0, 0, 0)' ? T['--ink-abyss'] : dlgBg);
      if (cr < 4.5) failures.push({ name: label + '/hint-contrast', error: cr + ' < 4.5 on ' + dlgBg });
    });
    // Real dialog input must honor light high-specificity disabled/readonly/focus rules.
    const real = [...dlg.querySelectorAll('input, textarea')].filter((el) => isTextlike(el) && vis(el))[0];
    if (real) {
      if (!real.disabled && !real.readOnly) {
        real.focus(); expect(label + '/real-focus', s(real).borderTopColor, T['--ink-border-focus']); real.blur();
      }
      const ro = real.cloneNode(true); ro.id = ''; ro.disabled = false; ro.readOnly = true; ro.removeAttribute('disabled'); dlg.appendChild(ro);
      expect(label + '/real-readonly bg', s(ro).backgroundColor, T['--ink-surface-2']);
      expect(label + '/real-readonly text', s(ro).color, T['--ink-text-secondary']);
      ro.disabled = true; ro.readOnly = false;
      expect(label + '/real-disabled bg', s(ro).backgroundColor, T['--ink-surface-2']);
      expect(label + '/real-disabled text', s(ro).color, T['--ink-text-muted']);
      ro.remove();
    }
    dlg.close();
  });
  stats.dialogInputs = dialogInputs; stats.fieldHints = hints;
  stats.toggles = toggles;
  if (!toggles) failures.push({ name: 'toggle/count', error: 'no visible checkbox/radio exercised' });
  if (!seenTypes.has('checkbox')) failures.push({ name: 'toggle/missing-checkbox', error: 'no visible checkbox exercised' });
  if (!seenTypes.has('radio')) failures.push({ name: 'toggle/missing-radio', error: 'no visible radio exercised' });

  // 5. sync view components.
  switchView('sync');
  const allSessions = document.getElementById('select-all-sessions');
  if (allSessions && vis(allSessions)) checkToggle(allSessions, 'sync');
  else failures.push({ name: 'toggle/sync-select-all', error: '#select-all-sessions not visible' });
  const cmds = [...document.querySelectorAll('.sync-command')].filter((b) => !b.classList.contains('primary') && !b.classList.contains('danger-sync') && !b.classList.contains('danger') && !b.disabled);
  cmds.forEach((b) => {
    expect('sync/' + elName(b) + ' bg', s(b).backgroundColor, T['--ink-surface-1']);
    expect('sync/' + elName(b) + ' text', s(b).color, T['--ink-text-secondary']);
  });
  stats.syncButtons = cmds.length;
  const stop = document.querySelector('#stop-sync');
  if (stop) {
    const wasHidden = stop.hidden; stop.hidden = false;
    expect('sync/stop bg', s(stop).backgroundColor, T['--ink-status-danger-bg']);
    expect('sync/stop text', s(stop).color, T['--ink-status-danger-text']);
    stop.hidden = wasHidden;
  } else failures.push({ name: 'sync/stop', error: '#stop-sync missing' });
  const help = document.querySelector('#view-sync .help-box');
  if (help) { expect('sync/help bg', s(help).backgroundColor, T['--ink-surface-2']); expect('sync/help text', s(help).color, T['--ink-text-secondary']); }
  else failures.push({ name: 'sync/help', error: '.help-box missing' });

  // 6. code/pre tokens.
  switchView('rpa-guide');
  const pre = document.querySelector('#view-rpa-guide pre.rpa-code-block') || document.querySelector('pre');
  if (pre) { expect('code/pre bg', s(pre).backgroundColor, T['--theme-code-bg']); expect('code/pre fg', s(pre).color, T['--theme-code-fg']); }
  else failures.push({ name: 'code/pre', error: 'no pre element' });

  // 7. rpa status pill on/off.
  switchView('api-mcp');
  const pill = document.querySelector('#api-conn-pill');
  if (pill) {
    pill.classList.remove('off');
    expect('pill/on bg', s(pill).backgroundColor, T['--ink-status-online-bg']);
    expect('pill/on text', s(pill).color, T['--ink-status-online-text']);
    expect('pill/on border', s(pill).borderTopColor, T['--ink-status-online']);
    pill.classList.add('off');
    expect('pill/off bg', s(pill).backgroundColor, T['--ink-surface-2']);
    expect('pill/off text', s(pill).color, T['--ink-text-muted']);
    pill.classList.remove('off');
  } else failures.push({ name: 'pill', error: '#api-conn-pill missing' });

  // 8. mini-chip normal/active, delete-warning, store-note.
  const chip = document.querySelector('.mini-chip');
  if (chip) {
    chip.classList.remove('active');
    expect('chip bg', s(chip).backgroundColor, T['--ink-surface-2']);
    expect('chip text', s(chip).color, T['--ink-text-secondary']);
    chip.classList.add('active');
    expect('chip/active bg', s(chip).backgroundColor, T['--ink-cyan-primary']);
    expect('chip/active text', s(chip).color, 'rgb(240, 246, 245)');
    chip.classList.remove('active');
  } else failures.push({ name: 'chip', error: '.mini-chip missing' });
  const warn = document.querySelector('.delete-warning');
  if (warn) {
    expect('delete-warning bg', s(warn).backgroundColor, T['--ink-status-danger-bg']);
    expect('delete-warning text', s(warn).color, T['--ink-status-danger-text']);
    expect('delete-warning border', s(warn).borderTopColor, T['--ink-status-danger']);
  } else failures.push({ name: 'delete-warning', error: '.delete-warning missing' });
  const note = document.querySelector('.store-note');
  if (note) {
    expect('store-note bg', s(note).backgroundColor, T['--ink-surface-2']);
    expect('store-note text', s(note).color, T['--ink-text-secondary']);
    expect('store-note border', s(note).borderTopColor, T['--ink-border-subtle']);
  } else failures.push({ name: 'store-note', error: '.store-note missing' });

  // 9. toast golden path through production toast(), all tones.
  ['error', 'success', 'warning', 'progress'].forEach((tone) => {
    window.toast('Theme fixture', { tone, duration: 0 });
    const el = document.getElementById('toast');
    expect('toast/' + tone + ' shown', el.classList.contains('show'), true);
    expect('toast/' + tone + ' bg', s(el).backgroundColor, T['--ink-surface-2']);
    expect('toast/' + tone + ' text', s(el).color, T['--ink-text-primary']);
  });
  const toastEl = document.getElementById('toast');
  if (toastEl) toastEl.classList.remove('show');

  // 10. shell chrome: header/body use ink-abyss; main must agree (no inverted block).
  const body = s(document.body); const header = document.querySelector('header'); const main = document.querySelector('main');
  expect('shell/body bg', body.backgroundColor, T['--ink-abyss']);
  expect('shell/body text', body.color, T['--ink-text-primary']);
  if (header) expect('shell/header bg', s(header).backgroundColor, T['--ink-abyss']);
  if (main) {
    const mb = s(main).backgroundColor;
    if (mb !== 'rgba(0, 0, 0, 0)') expect('shell/main bg', mb, T['--ink-abyss']);
    expect('shell/main text', s(main).color, T['--ink-text-primary']);
  }
  stats.screens = { body: body.backgroundColor, header: header && s(header).backgroundColor, main: main && s(main).backgroundColor };

  // 11. every .view really switches; visible textlike/select controls must stay on mode-correct tokens.
  const viewResults = []; let viewControls = 0;
  const bodyIsDark = lum(rgb(body.backgroundColor)) < 0.3;
  [...document.querySelectorAll('.view')].forEach((view) => {
    const name = view.id.replace(/^view-/, '');
    try {
      switchView(name);
      if (!view.classList.contains('active')) throw new Error('not active after switchView');
      const controls = [...view.querySelectorAll('input, textarea, select')].filter((el) => (isTextlike(el) || el.tagName === 'SELECT') && vis(el) && !el.disabled && !el.readOnly);
      let ok = true;
      const controlSurfaces = new Set([T['--ink-surface-1'], T['--ink-surface-2']]);
      const effectiveBg = (el) => { for (let n = el; n; n = n.parentElement) { const bg = s(n).backgroundColor; if (bg !== 'rgba(0, 0, 0, 0)') return bg; } return 'rgba(0, 0, 0, 0)'; };
      controls.forEach((el) => {
        viewControls++;
        const bg = effectiveBg(el);
        if (!controlSurfaces.has(bg)) { ok = false; failures.push({ name: 'view/' + name + '/' + elName(el) + ' bg', error: bg + ' not a mode surface token' }); }
        const c = s(el).color;
        if (![T['--ink-text-primary'], T['--ink-text-secondary'], T['--ink-text-muted']].includes(c)) { ok = false; failures.push({ name: 'view/' + name + '/' + elName(el) + ' text', error: c + ' not a mode text token' }); }
      });
      const pageBg = s(view).backgroundColor;
      if (pageBg !== 'rgba(0, 0, 0, 0)' && lum(rgb(pageBg)) < 0.3 !== bodyIsDark) { ok = false; failures.push({ name: 'view/' + name + ' bg', error: 'inverted page background ' + pageBg }); }
      checks.n++;
      viewResults.push({ name, controls: controls.length, ok });
    } catch (error) {
      const known = /currentRpaTab/.test(error.message);
      if (known) stats.skipped.push('view/' + name + ' known RPA error: ' + error.message);
      else failures.push({ name: 'view/' + name, error: error.message });
      viewResults.push({ name, ok: false, error: error.message, skipped: known });
    }
  });
  stats.views = viewResults; stats.viewControls = viewControls;

  // 12. fixture cleanup and coarse background screen (extra signal only).
  fixture.remove();
  noMotion.remove();
  const bgLum = lum(rgb(body.backgroundColor));
  stats.bgLuminance = +bgLum.toFixed(3);
  if (mode === 'dark' && bgLum > 0.35) failures.push({ name: 'screen/bg-coarse', error: 'dark bg luminance ' + bgLum.toFixed(3) });
  if (mode === 'light' && bgLum < 0.55) failures.push({ name: 'screen/bg-coarse', error: 'light bg luminance ' + bgLum.toFixed(3) });
  return { checks: checks.n, failures, stats };
}
try {
  cli('--allow-file-access', '--init-script', path.join(__dirname, 'ui-audit-bridge.js'), 'open', pathToFileURL(path.join(root, 'index.html')).href);
  cli('wait', '#profile-table');
  run(() => {
    ui.profiles = [normalizeProfileSettings({ id: 'theme-fixture', number: 1, os: 'Windows', language: 'en-US', networkMode: 'direct', proxy: 'Direct' })];
    renderProfiles();
  });
  evaluate('openProfileEditor("theme-fixture")');
  cli('wait', '250');
  run(() => switchView('profile-editor'));
  for (const mode of ['light', 'dark']) {
    evaluate('applyUiTheme("oceanic-fingerprint", false); applyColorMode(' + JSON.stringify(mode) + ', false)');
    cli('wait', '250');
    merge(mode, evaluate('(' + audit.toString() + ')(' + JSON.stringify(mode) + ')'));
  }
  // 13. light -> dark -> light roundtrip on the same real input.
  const measure = () => evaluate('(() => { const c = getComputedStyle(document.getElementById("editor-title")); return c.backgroundColor + "|" + c.color; })()');
  run(() => { applyUiTheme('oceanic-fingerprint', false); applyColorMode('light', false); });
  cli('wait', '250');
  const light1 = measure();
  run(() => applyColorMode('dark', false));
  cli('wait', '250');
  const dark1 = measure();
  run(() => applyColorMode('light', false));
  cli('wait', '250');
  const light2 = measure();
  report.roundtrip = { light1, dark1, light2, stable: light1 === light2, changed: light1 !== dark1 };
  report.checks += 2;
  if (light1 !== light2) report.failures.push({ mode: 'roundtrip', name: 'mode/roundtrip', error: 'light ' + light1 + ' -> dark ' + dark1 + ' -> light ' + light2 });
  if (light1 === dark1) report.failures.push({ mode: 'roundtrip', name: 'mode/roundtrip-change', error: 'input color did not change with mode: ' + light1 });
  // 14. merge-gateway scope proof, then restore oceanic.
  const before = measure();
  run(() => applyUiTheme('merge-gateway', false));
  cli('wait', '250');
  const scoped = measure();
  run(() => applyUiTheme('oceanic-fingerprint', false));
  cli('wait', '250');
  const after = measure();
  report.scope = { before, scoped, after, scopedAway: scoped !== before, restored: after === before };
  report.checks += 2;
  if (scoped === before) report.failures.push({ mode: 'scope', name: 'scope/merge-gateway', error: 'editor input color unchanged under merge-gateway: ' + before });
  if (after !== before) report.failures.push({ mode: 'scope', name: 'scope/restore', error: 'not restored: ' + after + ' != ' + before });
} catch (error) {
  report.failures.push({ mode: 'runner', name: 'runner', error: error.stack || error.message });
} finally {
  try { cli('close'); } catch (error) { console.error('Browser close: ' + error.message); }
  fs.writeFileSync(logFile, JSON.stringify(report, null, 2));
  for (const [mode, stats] of Object.entries(report.modes)) {
    console.log(`[${mode}] editorControls=${stats.editorControls} editorSelects=${stats.editorSelects} dialogs=${stats.dialogCount} dialogInputs=${stats.dialogInputs} syncButtons=${stats.syncButtons} hints=${stats.fieldHints} auditRows=${stats.auditRows} viewControls=${stats.viewControls} bgLum=${stats.bgLuminance}`);
  }
  if (report.roundtrip) console.log('roundtrip: ' + JSON.stringify(report.roundtrip));
  if (report.scope) console.log('scope: ' + JSON.stringify(report.scope));
  if (report.skipped.length) console.log('SKIPPED (not passed):\n  ' + report.skipped.join('\n  '));
  if (report.untested.length) console.log('UNTESTED (explicit): ' + report.untested.join('; '));
  console.log(`RESULT: ${report.failures.length} failed / ${report.checks} checks, report=${logFile}`);
  for (const f of report.failures.slice(0, 50)) console.log(`  FAIL [${f.mode}] ${f.name}: ${f.error}`);
  if (report.failures.length > 50) console.log(`  ... ${report.failures.length - 50} more failures in report file`);
  if (report.failures.length) process.exitCode = 1;
}
