'use strict';

/**
 * API & MCP page selftest.
 *
 * The page must generate client configuration from the port the Local API is
 * actually listening on. When the preferred port is busy the API moves, and a
 * config that kept advertising the requested port would point clients at
 * somebody else's process.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, 'ui-api-mcp.js'), 'utf8');

let passed = 0;
const results = [];
function case_(name, fn) {
  try { fn(); results.push({ name, ok: true }); passed += 1; }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

class MockElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.value = '';
    this.placeholder = '';
    this._textContent = '';
    this.listeners = {};
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
  }
  get textContent() { return this._textContent; }
  set textContent(v) { this._textContent = String(v ?? ''); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  appendChild(child) { this.children.push(child); return child; }
  remove() {}
}

function buildSandbox(info, paths) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new MockElement('div'));
      return elements.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tag) { return new MockElement(tag); },
  };
  const window = {
    ops: {
      localApiInfo: async () => info,
      mcpPaths: async () => paths,
      localApiVersion: async () => ({ version: '1.0.0' }),
      onEvent: () => {},
    },
    toast: () => {},
    tx: (s) => String(s ?? ''),
    t: (k) => k,
    log: () => {},
    element: (tag, className, text) => {
      const el = new MockElement(tag);
      el.className = className || '';
      if (text !== undefined) el.textContent = text;
      return el;
    },
    buildSquareMark: () => new MockElement('span'),
    displayProfileNumber: (n) => String(n ?? ''),
    updateEngineBadge: () => {},
    afterUiRender: () => {},
    syncThemedSelects: () => {},
    confirmAction: async () => false,
    ui: { profiles: [] },
    save: () => {},
    appendRpaLog: () => {},
  };
  window.$ = (selector, root = document) => root.querySelector(selector);
  window.$$ = (selector, root = document) => root.querySelectorAll(selector);
  window.window = window;

  const sandbox = {
    window,
    document,
    navigator: { clipboard: { writeText: async () => {} } },
    console,
    setTimeout,
    clearTimeout,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    RegExp,
    Set,
    Map,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'ui-api-mcp.js' });
  return { window, elements };
}

const LIVE_PORT = 51423;
const BUSY_PORT = 50325;

(async () => {
  // ---- default port, no fallback ----
  {
    const { window, elements } = buildSandbox(
      { host: '127.0.0.1', port: BUSY_PORT, requestedPort: BUSY_PORT, portFallback: null, url: `http://127.0.0.1:${BUSY_PORT}/`, apiKeyRequired: true },
      { mcpScript: '/app/automation/mcp-server.js', apiKey: 'k-123', apiKeyFile: '/app/local-api-key.txt', port: BUSY_PORT },
    );
    await window.refreshApiMcpPage();
    case_('config uses the default port when nothing moved', () => {
      const cfg = JSON.parse(elements.get('mcp-config-json').textContent);
      const env = cfg.mcpServers['openbrowser-local-api'].env;
      assert.strictEqual(env.OPENBROWSER_API_PORT, String(BUSY_PORT));
      assert.strictEqual(env.PORT, String(BUSY_PORT));
      assert.ok(!elements.get('mcp-key-note').textContent.includes('已自动改用'));
    });
  }

  // ---- preferred port busy: the API moved ----
  {
    const { window, elements } = buildSandbox(
      { host: '127.0.0.1', port: LIVE_PORT, requestedPort: BUSY_PORT, portFallback: { requested: BUSY_PORT, port: LIVE_PORT, reason: 'in-use' }, url: `http://127.0.0.1:${LIVE_PORT}/`, apiKeyRequired: true },
      { mcpScript: '/app/automation/mcp-server.js', apiKey: 'k-123', apiKeyFile: '/app/local-api-key.txt', port: LIVE_PORT },
    );
    await window.refreshApiMcpPage();
    case_('panel shows the live port, not the requested one', () => {
      assert.ok(elements.get('api-status-url').textContent.includes(String(LIVE_PORT)));
      assert.ok(!elements.get('api-status-url').textContent.includes(String(BUSY_PORT)));
    });
    case_('generated client config points at the live port', () => {
      const cfg = JSON.parse(elements.get('mcp-config-json').textContent);
      const server = cfg.mcpServers['openbrowser-local-api'];
      assert.strictEqual(server.env.OPENBROWSER_API_PORT, String(LIVE_PORT));
      assert.strictEqual(server.env.PORT, String(LIVE_PORT));
    });
    case_('copyable shell command points at the live port', () => {
      const hint = elements.get('mcp-cmd-hint').textContent;
      assert.ok(hint.includes(`OPENBROWSER_API_PORT='${LIVE_PORT}'`), hint);
      assert.ok(hint.includes('mcp-server.js'), hint);
    });
    case_('curl hint targets the live port', () => {
      assert.ok(elements.get('api-curl-hint').textContent.includes(`http://127.0.0.1:${LIVE_PORT}/`));
    });
    case_('panel explains why the port changed', () => {
      const note = elements.get('mcp-key-note').textContent;
      assert.ok(note.includes('默认端口已被占用'), note);
      assert.ok(note.includes('已自动改用实际端口'), note);
      assert.ok(note.includes('配置已写入当前 API Key'), 'the key note must survive');
    });
    case_('the port change surfaces in the connection pill', () => {
      const pill = elements.get('api-conn-pill');
      assert.strictEqual(pill.textContent, '运行中');
      assert.strictEqual(pill.classList.contains('off'), false);
    });
  }

  // ---- platform tab regenerates from the stored config ----
  {
    const { window, elements } = buildSandbox(
      { host: '127.0.0.1', port: LIVE_PORT, requestedPort: BUSY_PORT, portFallback: { requested: BUSY_PORT, port: LIVE_PORT, reason: 'in-use' }, url: `http://127.0.0.1:${LIVE_PORT}/`, apiKeyRequired: true },
      { mcpScript: '/app/automation/mcp-server.js', apiKey: 'k-123', apiKeyFile: '/app/local-api-key.txt', port: LIVE_PORT },
    );
    await window.refreshApiMcpPage();
    case_('both config variants carry the live port', () => {
      assert.strictEqual(window.__mcpConfigCommon.mcpServers['openbrowser-local-api'].env.OPENBROWSER_API_PORT, String(LIVE_PORT));
      assert.strictEqual(window.__mcpConfigPlatform.mcpServers['openbrowser-local-api'].env.OPENBROWSER_API_PORT, String(LIVE_PORT));
    });
  }

  // ---- server not reachable ----
  {
    const { window, elements } = buildSandbox(null, { mcpScript: '', apiKey: '', apiKeyFile: '', port: BUSY_PORT });
    await window.refreshApiMcpPage();
    case_('a missing API marks the panel as stopped without throwing', () => {
      assert.strictEqual(elements.get('api-conn-pill').textContent, '未启动');
      assert.strictEqual(elements.get('api-conn-pill').classList.contains('off'), true);
    });
  }

  // ================= report =================
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nUI_API_MCP_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
