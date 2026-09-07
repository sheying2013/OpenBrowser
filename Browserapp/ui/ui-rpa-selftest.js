'use strict';

/**
 * OpenBrowser RPA UI Submodule Selftest
 * Verifies:
 * 1. Static security & accessibility invariants (safe DOM rendering and scoped afterUiRender).
 * 2. DOM card rendering safety (safe textContent, title/aria-label on dynamic buttons).
 * 3. confirmAction async delegation and safe cancellation when the service is unavailable.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rpaPath = path.join(__dirname, 'ui-rpa.js');
const source = fs.readFileSync(rpaPath, 'utf8');

// 1. Static Invariants Check
const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
assert.ok(!/\bconfirm\s*\(/.test(codeOnly), 'ui-rpa.js must not call native confirmation directly');
assert.ok(!/\.innerHTML\b/.test(source), 'ui-rpa.js must not use .innerHTML (all cards & toolbars use safe DOM APIs)');
assert.ok(!/afterUiRender\s*\([^)]*\|\|\s*document\s*\)/.test(source), 'ui-rpa.js must not fall back to full document afterUiRender');
assert.ok(!/afterUiRender\s*\(\s*document\s*\)/.test(source), 'ui-rpa.js must not pass document to afterUiRender');

// 2. Mock DOM & Runtime Environment
class MockElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.childNodes = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.classList = {
      _classes: new Set(),
      add(...c) { c.forEach((x) => this._classes.add(x)); },
      remove(...c) { c.forEach((x) => this._classes.delete(x)); },
      toggle(c, force) {
        if (force === true) this._classes.add(c);
        else if (force === false) this._classes.delete(c);
        else if (this._classes.has(c)) this._classes.delete(c);
        else this._classes.add(c);
      },
      contains(c) { return this._classes.has(c); },
    };
    this._textContent = '';
  }

  get className() { return [...this.classList._classes].join(' '); }
  set className(v) {
    this.classList._classes.clear();
    String(v || '').split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }

  get textContent() {
    if (this.childNodes.length > 0) {
      return this.childNodes.map((n) => n.textContent || '').join('');
    }
    return this._textContent;
  }
  set textContent(val) {
    this._textContent = String(val == null ? '' : val);
    this.childNodes = [];
    this.children = [];
  }

  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] != null ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  hasAttribute(k) { return k in this.attributes; }

  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? { nodeType: 3, textContent: n } : n;
      this.childNodes.push(node);
      if (node.nodeType === 1 || node.tagName) this.children.push(node);
      node.parentElement = this;
    }
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this.children = [];
    this.append(...nodes);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (matchesSelector(child, selector)) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (matchesSelector(curr, selector)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  addEventListener() {}
  removeEventListener() {}
}

function matchesSelector(el, selector) {
  if (!el || !el.tagName) return false;
  const s = selector.trim();
  if (s.startsWith('.')) return el.classList.contains(s.slice(1));
  if (s.startsWith('#')) return el.id === s.slice(1);
  if (s.startsWith('[data-')) {
    const m = s.match(/\[([a-zA-Z0-9_-]+)(?:=["']?([^"'\]]+)["']?)?\]/);
    if (m) {
      const attr = m[1];
      const val = m[2];
      const has = el.hasAttribute(attr) || (attr.startsWith('data-') && el.dataset[attr.slice(5)] != null);
      if (!has) return false;
      if (val !== undefined) {
        return (el.getAttribute(attr) || el.dataset[attr.slice(5)]) === val;
      }
      return true;
    }
  }
  return el.tagName.toLowerCase() === s.toLowerCase();
}

const elementsById = new Map();
function getOrCreate(id, tag = 'div') {
  if (!elementsById.has(id)) {
    const el = new MockElement(tag);
    el.id = id;
    elementsById.set(id, el);
  }
  return elementsById.get(id);
}

// Pre-create standard RPA DOM ids
const rpaGrid = getOrCreate('rpa-store-grid');
const rpaCountWrap = new MockElement('div');
rpaCountWrap.className = 'rpa-toolbar-right';
const rpaCountEl = getOrCreate('rpa-store-count', 'b');
rpaCountWrap.append(rpaCountEl);
const rpaPlanTable = getOrCreate('rpa-plan-table', 'tbody');
const rpaTaskTable = getOrCreate('rpa-task-table', 'tbody');
const rpaRunTable = getOrCreate('rpa-run-table', 'tbody');
const rpaLogList = getOrCreate('rpa-log-list');
const rpaView = getOrCreate('view-rpa');

const localRenderRoots = [];
const context = vm.createContext({
  console,
  document: {
    getElementById(id) { return elementsById.get(id) || null; },
    querySelector(s) {
      for (const el of elementsById.values()) {
        if (matchesSelector(el, s)) return el;
        const sub = el.querySelector(s);
        if (sub) return sub;
      }
      return null;
    },
    querySelectorAll() { return []; },
    createElement(tag) { return new MockElement(tag); },
    createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
    addEventListener() {},
    removeEventListener() {},
  },
  navigator: { clipboard: { writeText: async () => {} } },
  setTimeout: (fn) => { fn(); return 0; },
  clearTimeout: () => {},
  window: {},
  ops: {
    rpaPlans: async () => [],
    rpaTasks: async () => [],
    rpaTemplates: async () => ({ list: [], categories: ['全部'] }),
  },
});
context.window = context;

// Bind OpenBrowserApp mock
new vm.Script(`
  let confirmCalls = [];
  function tx(str) { return str; }
  function t(key, vars) {
    if (key === 'action.use') return '使用';
    if (key === 'action.preview') return '预览';
    if (key === 'action.export') return '导出';
    if (key === 'action.delete') return '删除';
    if (key === 'action.unavailable') return '不可用';
    if (key === 'rpa.store.steps') return (vars?.n || 0) + ' 步';
    if (key === 'rpa.store.deleteConfirm') return '确定删除模板 ' + (vars?.name || '');
    return key;
  }
  function toast() {}
  function log() {}
  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function buildSquareMark() { return null; }
  function displayProfileNumber() { return '1'; }
  function updateEngineBadge() {}
  function afterUiRender(root) {
    localRenderRoots.push(root);
  }
  function syncThemedSelects() {}

  window.OpenBrowserApp = {
    ui: { profiles: [] },
    engineProfiles: [],
    toast, tx, t, log, element, buildSquareMark, displayProfileNumber,
    updateEngineBadge, afterUiRender, syncThemedSelects,
    confirmAction: async (opts) => {
      confirmCalls.push(opts);
      return true;
    },
  };
  window.localRenderRoots = [];
`, { filename: 'host-bindings.js' }).runInContext(context);

// Load ui-rpa.js
new vm.Script(source, { filename: 'ui-rpa.js' }).runInContext(context);

// 3. Verification of Exports
assert.strictEqual(typeof context.window.renderRpaStore, 'function', 'renderRpaStore exported');
assert.strictEqual(typeof context.window.confirmRpaAction, 'function', 'confirmRpaAction exported');

// 4. Test confirmAction delegation
(async () => {
  // Provided confirmAction returns true
  const res1 = await context.window.confirmRpaAction({
    title: '测试确认',
    message: '确认操作？',
  });
  assert.strictEqual(res1, true, 'confirmRpaAction delegates to host confirmAction');

  // String message overload
  const res2 = await context.window.confirmRpaAction('简单提示');
  assert.strictEqual(res2, true, 'confirmRpaAction handles string payload');

  // Without the confirmation service, destructive work must be cancelled.
  const savedFn = context.window.OpenBrowserApp.confirmAction;
  context.window.OpenBrowserApp.confirmAction = null;
  const resFallback = await context.window.confirmRpaAction({ title: '无服务降级' });
  assert.strictEqual(resFallback, false, 'fallback cancels without a native confirmation popup');
  context.window.OpenBrowserApp.confirmAction = savedFn;

  console.log('ui-rpa-selftest: OK (All invariants and DOM safety checks verified)');
})().catch((err) => {
  console.error('ui-rpa-selftest failed:', err);
  process.exit(1);
});
