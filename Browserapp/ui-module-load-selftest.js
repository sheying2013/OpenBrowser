'use strict';

// Browser `<script>` tags share a global lexical environment. This test loads the
// extracted UI modules after representative renderer bindings, so a future top-level
// `const`/`let` collision fails here instead of leaving a white Electron window.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = __dirname;
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const expectedModules = [
  'ui/ui-dialogs.js',
  'ui/ui-rpa.js',
  'ui/ui-api-mcp.js',
  'ui/ui-kernel.js',
  'ui/ui-cloud.js',
];
const scripts = [...index.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1].split('?')[0]);
const rendererIndex = scripts.indexOf('renderer.js');

assert.ok(rendererIndex >= 0, 'index.html loads renderer.js');
assert.deepStrictEqual(scripts.slice(rendererIndex + 1, rendererIndex + 1 + expectedModules.length), expectedModules,
  'UI modules load immediately after renderer.js in dependency order');

const noop = () => {};
function nodeStub() {
  const value = {
    hidden: false,
    style: {},
    dataset: {},
    checked: false,
    value: '',
    textContent: '',
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop,
    append: noop,
    appendChild: noop,
    replaceChildren: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute: noop,
    getAttribute: () => null,
    showModal: noop,
    close: noop,
  };
  return new Proxy(value, {
    get(target, key) { return key in target ? target[key] : noop; },
    set(target, key, next) { target[key] = next; return true; },
  });
}

const document = {
  addEventListener: noop,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: nodeStub,
};

const context = vm.createContext({
  console,
  document,
  navigator: { clipboard: { writeText: async () => {} } },
  setTimeout: () => 0,
  clearTimeout: noop,
  confirm: () => false,
  structuredClone: (value) => JSON.parse(JSON.stringify(value)),
  Option: function Option() {},
  Blob: function Blob() {},
  URL,
  FileReader: function FileReader() {},
  engineProfiles: [],
  selectedProfiles: new Set(),
  editingProfileId: null,
  switchView: noop,
});
context.window = context;
context.ops = new Proxy({ onEvent: noop }, {
  get(target, key) { return key in target ? target[key] : async () => ({}); },
});

// These bindings mirror the names owned by renderer.js. The extracted files must
// not redeclare any of them in the shared top-level script scope.
new vm.Script(`
  const $ = () => null;
  const $$ = () => [];
  let ui = { profiles: [], groups: [] };
  function save() {}
  function toast() {}
  function tx(value) { return value; }
  function t(value) { return value; }
  function log() {}
  function element() { return null; }
  function buildSquareMark() { return null; }
  function displayProfileNumber(profile) { return profile?.name || ''; }
  function updateEngineBadge() {}
  function afterUiRender() {}
  function syncThemedSelects() {}
  function editorDraft() { return {}; }
  function openProfileEditor() {}
  function renderProfiles() {}
  window.OpenBrowserApp = {
    get ui() { return ui; },
    get engineProfiles() { return engineProfiles; },
    get editingProfileId() { return editingProfileId; },
    save, toast, tx, t, log, $, $$, element, buildSquareMark, displayProfileNumber,
    updateEngineBadge, afterUiRender, syncThemedSelects, editorDraft, openProfileEditor, renderProfiles,
  };
`, { filename: 'renderer-bindings.js' }).runInContext(context);

for (const script of expectedModules) {
  const source = fs.readFileSync(path.join(root, script), 'utf8');
  new vm.Script(source, { filename: script }).runInContext(context);
}

for (const name of [
  'confirmAction', 'confirmDialog', 'showRpaPanel', 'refreshRpaPage', 'appendRpaLog', 'refreshApiMcpPage',
  'setLocalApiStatus', 'refreshKernelPanel', 'refreshCloudPanel',
]) {
  assert.strictEqual(typeof context[name], 'function', name + ' is exported after module load');
}

new vm.Script(`
  if (typeof confirmAction !== 'function') throw new Error('renderer modules cannot resolve confirmation export');
  if (typeof showRpaPanel !== 'function') throw new Error('renderer cannot resolve RPA export');
  if (typeof refreshApiMcpPage !== 'function') throw new Error('renderer cannot resolve API/MCP export');
  if (typeof refreshKernelPanel !== 'function') throw new Error('renderer cannot resolve kernel export');
  if (typeof refreshCloudPanel !== 'function') throw new Error('renderer cannot resolve cloud export');
`, { filename: 'renderer-module-consumer.js' }).runInContext(context);

console.log('ui-module-load-selftest: all extracted browser scripts load in one global context.');
