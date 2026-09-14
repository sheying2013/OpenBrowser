'use strict';

/**
 * Selftest for list render performance harvesting:
 * A. DocumentFragment batch mount in renderProxies() & renderGroupsPage()
 * B. View switching cache (loadedViews, scroll preservation, cache invalidation)
 * C. Environment editor Tab keyboard accessibility (Arrow Left/Right cycling, aria-selected, tabindex)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const rendererSource = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

const tests = [];
function test(name, fn) {
  try {
    fn();
    tests.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    tests.push({ name, ok: false, error: error.message || String(error) });
    console.error(`  FAIL  ${name}: ${error.message || error}`);
  }
}

console.log('Running list-render-cache-tabs-selftest...');

// =========================================================================
// Task A: DocumentFragment in renderProxies & renderGroupsPage
// =========================================================================

test('A1: renderGroupsPage uses new DocumentFragment() for batch mounting', () => {
  const funcMatch = rendererSource.match(/function renderGroupsPage\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(funcMatch, 'renderGroupsPage function declaration found');
  const body = funcMatch[1];
  assert.ok(body.includes('new DocumentFragment()'), 'must construct new DocumentFragment()');
  assert.ok(body.includes('fragment.append(row)'), 'must append rows to fragment in loop');
  assert.ok(body.includes('table.append(fragment)'), 'must batch append fragment to table once');
  // ensure no per-row table.append in the group loop
  const forLoop = body.match(/for\s*\(\s*const\s+g\s+of\s+groups\s*\)\s*\{([\s\S]*?)\}/);
  assert.ok(forLoop, 'groups for-of loop found');
  assert.ok(!forLoop[1].includes('table.append(row)'), 'group loop must not do table.append(row)');
});

test('A2: renderProxies uses new DocumentFragment() for batch mounting', () => {
  const funcMatch = rendererSource.match(/function renderProxies\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(funcMatch, 'renderProxies function declaration found');
  const body = funcMatch[1];
  assert.ok(body.includes('new DocumentFragment()'), 'must construct new DocumentFragment()');
  assert.ok(body.includes('fragment.append(row)'), 'must append rows to fragment in loop');
  assert.ok(body.includes('table.append(fragment)'), 'must batch append fragment to table once');
  const forLoop = body.match(/for\s*\(\s*const\s+item\s+of\s+list\s*\)\s*\{([\s\S]*?)\}/);
  assert.ok(forLoop, 'proxy for-of loop found');
  assert.ok(!forLoop[1].includes('table.append(row)'), 'proxy loop must not do table.append(row)');
});

// =========================================================================
// Task B: View switching cache & invalidations
// =========================================================================

test('B1: loadedViews and invalidateViewCache are defined', () => {
  assert.match(rendererSource, /const loadedViews = new Set\(\);/, 'loadedViews Set defined');
  assert.match(rendererSource, /function invalidateViewCache\(views\)/, 'invalidateViewCache function defined');
  assert.match(rendererSource, /const viewScrollPositions = new Map\(\);/, 'viewScrollPositions Map defined');
});

test('B2: switchView checks loadedViews before full IPC/render calls', () => {
  const switchMatch = rendererSource.match(/function switchView\(view\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(switchMatch, 'switchView function found');
  const body = switchMatch[1];
  assert.ok(body.includes("if (!loadedViews.has('sync'))"), 'sync view guarded by loadedViews');
  assert.ok(body.includes("if (!loadedViews.has('extensions'))"), 'extensions view guarded by loadedViews');
  assert.ok(body.includes("if (!loadedViews.has('proxies'))"), 'proxies view guarded by loadedViews');
  assert.ok(body.includes("if (!loadedViews.has('groups'))"), 'groups view guarded by loadedViews');
  assert.ok(body.includes("if (!loadedViews.has('profiles'))"), 'profiles view guarded by loadedViews');
});

test('B3: switchView preserves and restores scroll position across view switches', () => {
  const switchMatch = rendererSource.match(/function switchView\(view\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(switchMatch, 'switchView function found');
  const body = switchMatch[1];
  assert.ok(body.includes('viewScrollPositions.set(currentActive'), 'saves scroll position of active view');
  assert.ok(body.includes('window.scrollTo({ top: targetScroll'), 'restores scroll position of target view');
});

test('B4: loadedViews marks views as loaded upon successful render/pull', () => {
  assert.match(rendererSource, /loadedViews\.add\('proxies'\);/, 'proxies added to loadedViews');
  assert.match(rendererSource, /loadedViews\.add\('extensions'\);/, 'extensions added to loadedViews');
  assert.match(rendererSource, /loadedViews\.add\('sync'\);/, 'sync added to loadedViews');
  assert.match(rendererSource, /loadedViews\.add\('groups'\);/, 'groups added to loadedViews');
  assert.match(rendererSource, /loadedViews\.add\('profiles'\);/, 'profiles added to loadedViews');
});

test('B5: Cache invalidation points cover all data mutations', () => {
  // Profiles
  assert.ok(rendererSource.includes("invalidateViewCache(['profiles', 'groups', 'sync', 'extensions', 'proxies'])"),
    'profile creation/edit/batch-ops invalidate related views');
  // Groups
  assert.ok(rendererSource.includes("invalidateViewCache(['groups', 'profiles'])"),
    'group ops invalidate groups & profiles views');
  // Proxies
  assert.ok(rendererSource.includes("invalidateViewCache(['proxies', 'profiles'])"),
    'proxy ops invalidate proxies & profiles views');
  // Extensions
  assert.ok(rendererSource.includes("invalidateViewCache(['extensions', 'profiles', 'sync'])"),
    'extension ops invalidate extensions, profiles & sync views');
  // Language change
  assert.ok(rendererSource.includes('invalidateViewCache();'),
    'language change clears all view caches');
});

// =========================================================================
// Task C: Editor Tab keyboard accessibility
// =========================================================================

test('C1: setEditorTab synchronizes aria-selected and tabindex', () => {
  const setTabMatch = rendererSource.match(/function setEditorTab\(tab,\s*focus\s*=\s*false\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(setTabMatch, 'setEditorTab function found with focus parameter');
  const body = setTabMatch[1];
  assert.ok(body.includes("button.setAttribute('aria-selected', isActive ? 'true' : 'false')"), 'aria-selected updated');
  assert.ok(body.includes("button.setAttribute('tabindex', isActive ? '0' : '-1')"), 'tabindex updated');
  assert.ok(body.includes("button.classList.toggle('active', isActive)"), 'active class toggled');
});

test('C2: Arrow key navigation cycles between editor tabs', () => {
  assert.ok(rendererSource.includes("$$('[data-editor-tab]').forEach((button) => {"), 'editor tab listeners attached');
  assert.ok(rendererSource.includes("event.key !== 'ArrowRight' && event.key !== 'ArrowLeft'"), 'listens for ArrowRight and ArrowLeft');
  assert.ok(rendererSource.includes("(currentIndex + 1) % tabs.length"), 'ArrowRight cycles forward');
  assert.ok(rendererSource.includes("(currentIndex - 1 + tabs.length) % tabs.length"), 'ArrowLeft cycles backward');
  assert.ok(rendererSource.includes("setEditorTab(nextTabBtn.dataset.editorTab, true)"), 'activates and focuses next tab');
  assert.ok(rendererSource.includes("button.addEventListener('click'"), 'mouse click listener retained');
});

// =========================================================================
// Functional / Simulated DOM Verification
// =========================================================================

test('C3: Simulated keyboard cycling on editor tabs works correctly in both directions', () => {
  class MockClassList {
    constructor() { this.classes = new Set(); }
    add(c) { this.classes.add(c); }
    delete(c) { this.classes.delete(c); }
    has(c) { return this.classes.has(c); }
    toggle(c, state) {
      if (state) this.classes.add(c);
      else this.classes.delete(c);
    }
  }

  class MockElement {
    constructor(tag, attrs = {}) {
      this.tagName = tag.toUpperCase();
      this.attrs = { ...attrs };
      this.dataset = { ...attrs };
      this.classList = new MockClassList();
      this.listeners = {};
      this._focused = false;
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k]; }
    hasAttribute(k) { return k in this.attrs; }
    addEventListener(ev, fn) {
      if (!this.listeners[ev]) this.listeners[ev] = [];
      this.listeners[ev].push(fn);
    }
    dispatchEvent(ev) {
      const fns = this.listeners[ev.type] || [];
      fns.forEach((fn) => fn(ev));
    }
    focus() { this._focused = true; }
  }

  const tabs = [
    new MockElement('button', { editorTab: 'basic' }),
    new MockElement('button', { editorTab: 'proxy' }),
    new MockElement('button', { editorTab: 'privacy' }),
    new MockElement('button', { editorTab: 'advanced' }),
  ];
  const panels = [
    new MockElement('section', { editorPanel: 'basic' }),
    new MockElement('section', { editorPanel: 'proxy' }),
    new MockElement('section', { editorPanel: 'privacy' }),
    new MockElement('section', { editorPanel: 'advanced' }),
  ];

  function mockSetEditorTab(tab, focus = false) {
    tabs.forEach((button) => {
      const isActive = button.dataset.editorTab === tab;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      button.setAttribute('tabindex', isActive ? '0' : '-1');
      if (!button.hasAttribute('role')) button.setAttribute('role', 'tab');
      if (isActive && focus) button.focus();
    });
    panels.forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.editorPanel === tab);
    });
  }

  tabs.forEach((button) => {
    button.addEventListener('click', () => mockSetEditorTab(button.dataset.editorTab));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      const currentIndex = tabs.indexOf(button);
      if (currentIndex < 0) return;
      event.preventDefault();
      const nextIndex = event.key === 'ArrowRight'
        ? (currentIndex + 1) % tabs.length
        : (currentIndex - 1 + tabs.length) % tabs.length;
      const nextTabBtn = tabs[nextIndex];
      if (nextTabBtn?.dataset?.editorTab) {
        mockSetEditorTab(nextTabBtn.dataset.editorTab, true);
      }
    });
  });

  // Initial state: basic tab active
  mockSetEditorTab('basic');
  assert.strictEqual(tabs[0].getAttribute('aria-selected'), 'true');
  assert.strictEqual(tabs[0].getAttribute('tabindex'), '0');
  assert.strictEqual(tabs[1].getAttribute('aria-selected'), 'false');
  assert.strictEqual(tabs[1].getAttribute('tabindex'), '-1');
  assert.ok(panels[0].classList.has('active'));
  assert.ok(!panels[1].classList.has('active'));

  // Press ArrowRight from basic -> proxy
  let prevented = false;
  tabs[0].dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.strictEqual(tabs[1].getAttribute('aria-selected'), 'true');
  assert.strictEqual(tabs[1].getAttribute('tabindex'), '0');
  assert.strictEqual(tabs[0].getAttribute('aria-selected'), 'false');
  assert.strictEqual(tabs[0].getAttribute('tabindex'), '-1');
  assert.ok(tabs[1]._focused);
  assert.ok(panels[1].classList.has('active'));

  // Press ArrowRight through to last tab (advanced)
  tabs[1].dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} });
  assert.strictEqual(tabs[2].getAttribute('aria-selected'), 'true');
  tabs[2].dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} });
  assert.strictEqual(tabs[3].getAttribute('aria-selected'), 'true');

  // Press ArrowRight from advanced -> cycles back to basic (index 0)
  tabs[3].dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} });
  assert.strictEqual(tabs[0].getAttribute('aria-selected'), 'true');

  // Press ArrowLeft from basic -> cycles backward to advanced (index 3)
  tabs[0].dispatchEvent({ type: 'keydown', key: 'ArrowLeft', preventDefault() {} });
  assert.strictEqual(tabs[3].getAttribute('aria-selected'), 'true');

  // Mouse click on proxy tab still works
  tabs[1].dispatchEvent({ type: 'click' });
  assert.strictEqual(tabs[1].getAttribute('aria-selected'), 'true');
  assert.strictEqual(tabs[3].getAttribute('aria-selected'), 'false');
});

test('B6: loadedViews cache behavior and invalidation cycle', () => {
  const mockLoadedViews = new Set();
  function mockInvalidate(views) {
    if (!views) {
      mockLoadedViews.clear();
      return;
    }
    if (Array.isArray(views)) {
      for (const v of views) mockLoadedViews.delete(v);
      return;
    }
    mockLoadedViews.delete(views);
  }

  // Initial load
  assert.strictEqual(mockLoadedViews.has('proxies'), false);
  mockLoadedViews.add('proxies');
  assert.strictEqual(mockLoadedViews.has('proxies'), true);

  // Re-entering view without mutation: cache hit
  assert.strictEqual(mockLoadedViews.has('proxies'), true);

  // Invalidate proxies
  mockInvalidate('proxies');
  assert.strictEqual(mockLoadedViews.has('proxies'), false);

  // Invalidate multiple views
  mockLoadedViews.add('profiles');
  mockLoadedViews.add('groups');
  mockLoadedViews.add('sync');
  mockInvalidate(['profiles', 'groups', 'sync']);
  assert.strictEqual(mockLoadedViews.has('profiles'), false);
  assert.strictEqual(mockLoadedViews.has('groups'), false);
  assert.strictEqual(mockLoadedViews.has('sync'), false);

  // Invalidate all views
  mockLoadedViews.add('system');
  mockLoadedViews.add('extensions');
  mockInvalidate();
  assert.strictEqual(mockLoadedViews.size, 0);
});

// Summary
const failed = tests.filter((t) => !t.ok);
if (failed.length) {
  console.error(`\n${failed.length} test(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll ${tests.length} tests passed successfully!`);
}
