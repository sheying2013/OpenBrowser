'use strict';
// Real index.html + production CSS/renderer. IPC is test-only; no build/live backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const session = 'ob-ui-regression-' + process.pid;
const output = path.join(__dirname, 'ui-audit-artifacts', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, { recursive: true });
const results = [];
function cli(...args) {
  const raw = execFileSync('agent-browser', ['--session', session, '--json', ...args], { encoding: 'utf8', timeout: 30000 });
  const response = JSON.parse(raw.trim());
  assert.equal(response.success, true, response.error || raw);
  return response.data;
}
const evaluate = (code) => cli('eval', code).result;
const run = (fn) => evaluate('(' + fn.toString() + ')()');
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.message }); }
}
const measurements = [];
try {
  cli('--allow-file-access', '--init-script', path.join(__dirname, 'ui-audit-bridge.js'), 'open', pathToFileURL(path.join(root, 'index.html')).href);
  cli('wait', '#profile-table');
  run(() => {
    ui.profiles = [normalizeProfileSettings({ id: 'audit-profile', number: 1, os: 'Windows', language: 'en-US', networkMode: 'direct', proxy: 'Direct' })];
    ui.logs = [{ time: '12:34:56', module: 'Audit', message: '双模回归：操作日志文字与表头对齐' }, { time: '12:34:57', module: 'LongModuleName', message: 'long/path/'.repeat(40) }];
    proxyLibrary = [{ id: 'audit-proxy', name: 'Very-long-proxy-name-'.repeat(8), host: 'proxy-fixture.example.invalid', port: 1080, protocol: 'socks5', remark: '备注'.repeat(50), lastIp: '192.0.2.1' }];
    extensions = ['all', 'none', 'partial'].map((id) => ({ id, name: 'Extension ' + id, description: '本地状态回归', version: '1.0', manifestVersion: 3, enabledAll: id === 'all', assignedProfiles: id === 'none' ? 0 : 1, assignedProfileIds: [], builtIn: false }));
    appCenterTab = 'local';
    appCenterData.local = extensions;
    renderLogs(); renderProxies(); renderExtensions();
  });
  for (const width of [1280, 900]) {
    cli('set', 'viewport', String(width), width === 900 ? '700' : '900');
    for (const mode of ['dark', 'light']) {
      evaluate('document.documentElement.dataset.uiTheme="oceanic-fingerprint";document.documentElement.dataset.colorMode=' + JSON.stringify(mode));
      const prefix = width + '/' + mode + ': ';
      const metrics = run(() => {
        function rgb(value) { return (value.match(/[\d.]+/g) || []).map(Number); }
        function composite(top, bottom) {
          const alpha = top[3] ?? 1;
          return top.slice(0, 3).map((c, i) => c * alpha + bottom[i] * (1 - alpha));
        }
        function background(node) {
          const layers = [];
          for (let el = node; el; el = el.parentElement) layers.push(rgb(getComputedStyle(el).backgroundColor));
          return layers.reverse().reduce((bg, fg) => composite(fg, bg), [255, 255, 255]);
        }
        function luminance(color) {
          const c = color.slice(0, 3).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
          return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
        }
        function contrast(el) {
          const bg = background(el), fg = composite(rgb(getComputedStyle(el).color), bg);
          const a = luminance(fg), b = luminance(bg);
          return +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2);
        }
        const root = getComputedStyle(document.documentElement);
        window.__auditContrast = contrast;
        switchView('logs');
        const heading = [...document.querySelectorAll('.retro-log-columns span')].map(el => el.getBoundingClientRect().x);
        const row = [...document.querySelectorAll('.log-row:first-child span')];
        const log = { offsets: row.map((el, i) => +(el.getBoundingClientRect().x - heading[i]).toFixed(2)), contrast: row.map(contrast), headerContrast: contrast(document.querySelector('.retro-log-columns')), overflow: document.querySelector('#log-list').scrollWidth > document.querySelector('#log-list').clientWidth };
        switchView('proxies');
        const card = document.querySelector('#view-proxies .table-card');
        const proxy = { overflowX: getComputedStyle(card).overflowX, clientWidth: card.clientWidth, scrollWidth: card.scrollWidth };
        card.scrollLeft = card.scrollWidth;
        const action = document.querySelector('[data-proxy-delete="audit-proxy"]');
        proxy.actionReachable = action.getBoundingClientRect().right <= card.getBoundingClientRect().right + 1;
        switchView('extensions');
        const toggles = [...document.querySelectorAll('.extension-toggle input')].map(input => ({ id: input.dataset.extensionToggle, checked: input.checked, partial: input.indeterminate, background: getComputedStyle(input.nextElementSibling).backgroundColor }));
        const cards = [...document.querySelectorAll('.extension-card')];
        const grid = { fits: cards.every(el => el.getBoundingClientRect().right <= document.querySelector('#extension-grid').getBoundingClientRect().right + 1) };
        switchView('sync');
        const health = document.querySelector('#sync-health');
        const status = {};
        for (const state of ['healthy', 'warning']) { health.className = 'sync-health ' + state; status[state] = contrast(health); }
        openProfileEditor('audit-profile'); setEditorTab('privacy');
        editorSet('#editor-language-mode', 'ip'); editorSet('#editor-language', 'ja-JP');
        editorNetworkResult = null;
        const draft = editorDraft(false);
        const section = document.querySelector('.editor-section-card');
        const editor = { language: draft.language, uiSurface: root.getPropertyValue('--ui-surface').trim(), inkSurface: root.getPropertyValue('--ink-surface-1').trim(), cardBackground: getComputedStyle(section).backgroundColor, nestedLabels: document.querySelectorAll('#view-profile-editor label label').length, fieldDisplay: getComputedStyle(document.querySelector('.field-inline-group')).display };
        return { mode: document.documentElement.dataset.colorMode, width: innerWidth, log, proxy, toggles, grid, status, editor };
      });
      measurements.push(metrics);
      check(prefix + 'log columns align', () => assert.ok(metrics.log.offsets.every(x => Math.abs(x) <= 2), JSON.stringify(metrics.log.offsets)));
      check(prefix + 'log text contrast >= 4.5', () => assert.ok([...metrics.log.contrast, metrics.log.headerContrast].every(x => x >= 4.5), JSON.stringify(metrics.log)));
      check(prefix + 'long log wraps within card', () => assert.equal(metrics.log.overflow, false));
      check(prefix + 'proxy scroll and actions reachable', () => { assert.equal(metrics.proxy.overflowX, 'auto'); assert.equal(metrics.proxy.actionReachable, true); });
      check(prefix + 'extension switches use theme states', () => { assert.equal(new Set(metrics.toggles.map(x => x.background)).size, 3); assert.ok(!metrics.toggles.some(x => ['rgb(36, 92, 255)', 'rgb(245, 158, 11)'].includes(x.background)), JSON.stringify(metrics.toggles)); });
      check(prefix + 'extension grid stays inside view', () => assert.equal(metrics.grid.fits, true));
      check(prefix + 'sync status contrast >= 4.5', () => assert.ok(Object.values(metrics.status).every(x => x >= 4.5), JSON.stringify(metrics.status)));
      check(prefix + 'fallback selection is serialized', () => assert.equal(metrics.editor.language, 'ja-JP'));
      check(prefix + 'editor tokens follow ink palette', () => assert.equal(metrics.editor.uiSurface, metrics.editor.inkSurface));
      check(prefix + 'compound fields have layout and valid labels', () => { assert.equal(metrics.editor.nestedLabels, 0); assert.ok(['flex', 'grid'].includes(metrics.editor.fieldDisplay), metrics.editor.fieldDisplay); });
      if (width === 1280) {
        evaluate('switchView("logs")'); cli('screenshot', path.join(output, mode + '-logs.png'));
        evaluate('switchView("extensions")'); cli('screenshot', path.join(output, mode + '-extensions.png'));
      }
    }
  }
  for (const mode of ['dark', 'light']) {
    evaluate('document.documentElement.dataset.uiTheme="oceanic-fingerprint";document.documentElement.dataset.colorMode=' + JSON.stringify(mode));
    check(mode + ': footer effective contrast >= 4.5 including inherited opacity', () => {
      const values = run(() => {
        switchView('logs');
        return ['#github-link span', '#app-version'].map(selector => {
          const el = document.querySelector(selector);
          let opacity = 1;
          for (let node = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
          return { selector, opacity, contrast: window.__auditContrast(el) };
        });
      });
      assert.ok(values.every(x => x.opacity === 1 && x.contrast >= 4.5), JSON.stringify(values));
    });
    check(mode + ': extension legend describes state rather than fixed palette names', () => {
      const legend = evaluate('document.querySelector(".extension-state-legend").textContent');
      assert.ok(!/蓝色|灰色|黄色/.test(legend), legend);
      const marks = run(() => [...document.querySelectorAll('.extension-state-legend i')].map(el => ({ state: el.className, hidden: el.getAttribute('aria-hidden'), color: getComputedStyle(el).backgroundColor })));
      assert.equal(marks.length, 3); assert.ok(marks.every(x => x.hidden === 'true'));
      const partial = evaluate('getComputedStyle(document.querySelector(".extension-toggle input:indeterminate + span")).backgroundColor');
      assert.equal(marks.find(x => x.state === 'partial').color, partial);
    });
    cli('set', 'viewport', '900', '500');
    check(mode + ': long log list scrolls inside a short window', () => {
      const values = run(() => {
        const saved = ui.logs;
        ui.logs = Array.from({ length: 100 }, (_, i) => ({ time: '12:34:56', module: 'Audit', message: 'Scrolling log ' + i }));
        renderLogs(); switchView('logs');
        const card = document.querySelector('.log-card');
        const viewportBottom = card.getBoundingClientRect().bottom;
        card.scrollTop = card.scrollHeight;
        const visibleLast = card.lastElementChild.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom + 1;
        const result = { viewportBottom, windowHeight: innerHeight, visibleLast, scrollTop: card.scrollTop };
        ui.logs = saved; renderLogs();
        return result;
      });
      assert.ok(values.viewportBottom <= values.windowHeight, JSON.stringify(values));
      assert.ok(values.scrollTop > 0 && values.visibleLast, JSON.stringify(values));
    });
    check(mode + ': log empty state fits the scroll area in a short window', () => {
      const values = run(() => {
        const saved = ui.logs; ui.logs = []; renderLogs();
        const card = document.querySelector('.log-card');
        const empty = document.querySelector('.log-empty');
        const result = { card: card.clientHeight, empty: empty.offsetHeight, contrast: window.__auditContrast(empty) };
        ui.logs = saved; renderLogs(); return result;
      });
      assert.ok(values.empty <= values.card && values.contrast >= 4.5, JSON.stringify(values));
    });
  }
  cli('set', 'viewport', '1280', '900');
  check('fixed strategy and known IP language precedence preserved', () => {
    const values = run(() => {
      openProfileEditor('audit-profile');
      editorSet('#editor-language', 'ja-JP'); editorSet('#editor-language-mode', 'fr-FR');
      const fixed = editorDraft(false).language;
      editorSet('#editor-language-mode', 'ip'); editorNetworkResult = { countryCode: 'DE' };
      return [fixed, editorDraft(false).language];
    });
    assert.deepEqual(values, ['fr-FR', 'de-DE']);
  });
  check('every supported exit country matches the canonical engine locale', () => {
    const { COUNTRY_TO_LOCALE } = require('./locale-from-country');
    const expected = Object.entries(COUNTRY_TO_LOCALE);
    const actual = evaluate('(' + ((entries) => {
      openProfileEditor('audit-profile'); editorSet('#editor-language-mode', 'ip'); editorSet('#editor-language', 'ja-JP');
      return entries.map(([country]) => { editorNetworkResult = { countryCode: ' ' + country.toLowerCase() + ' ' }; return editorDraft(false).language; });
    }).toString() + ')(' + JSON.stringify(expected) + ')');
    assert.deepEqual(actual, expected.map(([, locale]) => locale));
  });
  check('unknown-country, no-probe, and system language strategies remain deterministic', () => {
    const actual = run(() => {
      openProfileEditor('audit-profile'); editorSet('#editor-language', 'ja-JP'); editorSet('#editor-language-mode', 'ip');
      editorNetworkResult = { countryCode: 'ZZ' }; const unknown = editorDraft(false).language;
      editorNetworkResult = null; const noProbe = editorDraft(false).language;
      editorSet('#editor-language-mode', 'system');
      return [unknown, noProbe, editorDraft(false).language, Intl.DateTimeFormat().resolvedOptions().locale];
    });
    assert.deepEqual(actual.slice(0, 2), ['ja-JP', 'ja-JP']); assert.equal(actual[2], actual[3]);
  });
  check('extension switches have stateful accessible names', () => {
    const names = evaluate('[...document.querySelectorAll(".extension-toggle input")].map(x=>x.getAttribute("aria-label"))');
    assert.equal(names.length, 3); assert.ok(names.every(x => x && x.startsWith('Extension ')));
  });
  check('OS and language custom selects immediately echo values', () => {
    const values = run(() => { openProfileEditor('audit-profile'); return ['editor-os', 'editor-language'].map(id => { const select = document.getElementById(id); return { value: select.selectedOptions[0]?.textContent.trim(), echo: select.closest('.themed-select')?.querySelector('.themed-select-value')?.textContent.trim() }; }); });
    for (const value of values) assert.equal(value.echo, value.value);
  });
  check('keyboard focus is visible on extension switches in both modes', () => {
    evaluate('document.documentElement.dataset.uiTheme="oceanic-fingerprint"; switchView("extensions")');
    cli('press', 'Tab');
    for (const mode of ['dark', 'light']) {
      evaluate('document.documentElement.dataset.colorMode=' + JSON.stringify(mode));
      evaluate('document.querySelector(".extension-toggle input").focus()');
      cli('wait', '--fn', 'getComputedStyle(document.querySelector(".extension-toggle-slider")).outlineWidth === "2px"');
      const focus = run(() => {
        const input = document.querySelector('.extension-toggle input');
        const css = getComputedStyle(input.nextElementSibling);
        return { active: document.activeElement === input, visible: input.matches(':focus-visible'), width: css.outlineWidth, style: css.outlineStyle };
      });
      assert.equal(focus.active, true); assert.equal(focus.visible, true); assert.equal(focus.width, '2px'); assert.equal(focus.style, 'solid');
    }
  });
  check('actual editor submit persists fallback and reopen echoes it', () => {
    const value = evaluate('(' + (async () => {
      openProfileEditor('audit-profile');
      editorSet('#editor-name', 'UI Audit');
      editorSet('#editor-language-mode', 'ip'); editorSet('#editor-language', 'ja-JP');
      editorNetworkResult = null;
      document.querySelector('#profile-editor-form').requestSubmit();
      await Promise.resolve();
      openProfileEditor('audit-profile');
      return { saved: window.__uiAuditSavedProfiles?.[0]?.language, reopened: document.querySelector('#editor-language').value };
    }).toString() + ')()');
    assert.equal(value.saved, 'ja-JP'); assert.equal(value.reopened, 'ja-JP');
  });
  for (const theme of evaluate('Object.keys(UI_THEMES)')) {
    check(theme + ': editor selections and compound fields survive theme switch', () => {
      evaluate('document.documentElement.dataset.uiTheme=' + JSON.stringify(theme));
      const state = run(() => {
        openProfileEditor('audit-profile'); setEditorTab('privacy');
        const group = document.querySelector('.field-inline-group');
        const select = document.querySelector('#editor-language');
        return { display: getComputedStyle(group).display, nested: document.querySelectorAll('#view-profile-editor label label').length, value: select.selectedOptions[0]?.textContent.trim(), echo: select.closest('.themed-select')?.querySelector('.themed-select-value')?.textContent.trim() };
      });
      assert.equal(state.display, 'flex'); assert.equal(state.nested, 0); assert.equal(state.echo, state.value);
    });
  }
  check('proxy mode with an empty endpoint blocks save instead of becoming direct', () => {
    const value = run(() => {
      openProfileEditor('audit-profile');
      document.querySelector('input[name="editor-network"][value="custom"]').checked = true;
      editorSet('#editor-proxy-host', ''); editorSet('#editor-proxy-port', ''); editorSet('#editor-api-extract-url', '');
      let error = ''; try { editorDraft(true); } catch (e) { error = e.message; }
      return { error, mode: editorDraft(false).networkMode, normalized: normalizeProfileSettings({networkMode:'proxy',proxy:''}).networkMode };
    });
    assert.ok(value.error); assert.equal(value.mode, 'proxy'); assert.equal(value.normalized, 'proxy');
  });
  check('legacy direct-fallback profiles are migrated to blocking policy in the UI', () => {
    const value = run(() => normalizeProfileSettings({networkMode:'proxy',proxy:'socks5://127.0.0.1:9',proxyMeta:{notReadyPolicy:'direct',allowDirectFallback:true}}).proxyMeta);
    assert.equal(value.notReadyPolicy, 'block'); assert.equal(value.allowDirectFallback, false);
  });
  check('proxy test ignores double clicks and restores disabled/busy state', () => {
    const value = evaluate('(' + (async () => {
      openProfileEditor('audit-profile');
      document.querySelector('input[name="editor-network"][value="custom"]').checked = true;
      editorSet('#editor-proxy-host', '127.0.0.1'); editorSet('#editor-proxy-port', '9');
      const original = window.ops.testProfileProxy;
      let finish, calls = 0;
      window.ops.testProfileProxy = () => { calls++; return new Promise(resolve => {finish=resolve;}); };
      try {
        const first = testEditorProxy(); const second = testEditorProxy();
        const busy = document.querySelector('#editor-test-proxy').disabled;
        finish({ip:'192.0.2.1',countryCode:'US',latencyMs:20});
        await Promise.all([first, second]);
        return {calls,busy,restored:!document.querySelector('#editor-test-proxy').disabled,aria:document.querySelector('#editor-proxy-result').getAttribute('aria-busy')};
      } finally {window.ops.testProfileProxy=original;}
    }).toString() + ')()');
    assert.equal(value.calls, 1); assert.equal(value.busy, true); assert.equal(value.restored, true); assert.equal(value.aria,'false');
  });
  for (const mode of ['dark','light']) {
    evaluate('document.documentElement.dataset.uiTheme="oceanic-fingerprint";document.documentElement.dataset.colorMode=' + JSON.stringify(mode) + ';openProfileEditor("audit-profile");setEditorTab("privacy")');
    check(mode + ': editor header, footer, tabs and summary remain readable', () => {
      const values = run(() => ['.profile-editor-head h2', '.editor-tabs button.active', '#editor-summary dd', '.editor-actions .outline', '.profile-summary button', '.editor-back'].map(selector => window.__auditContrast(document.querySelector(selector))));
      assert.ok(values.every(x => x >= 4.5), JSON.stringify(values));
    });
    cli('screenshot',path.join(output, mode + '-editor.png'));
  }
  check('no page exceptions or renderer Error log', () => {
    const state = evaluate('({errors:window.__uiAuditErrors,logs:ui.logs.filter(x=>x.module==="Error"),unexpectedCalls:window.__uiAuditCalls})');
    assert.deepEqual(state.errors, []); assert.deepEqual(state.logs, []); assert.deepEqual(state.unexpectedCalls, []);
  });
} finally {
  try { cli('close'); } catch (error) { console.error('Browser close: ' + error.message); }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, measurements }, null, 2));
}
for (const result of results) console.log((result.ok ? 'PASS ' : 'FAIL ') + result.name + (result.error ? ': ' + result.error : ''));
console.log('Evidence: ' + output);
console.log('secondary-ui-runtime-selftest: ' + results.filter(x => x.ok).length + '/' + results.length);
if (!results.length || results.some(x => !x.ok)) process.exitCode = 1;
