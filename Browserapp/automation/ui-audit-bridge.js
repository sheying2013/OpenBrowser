'use strict';
// Test-only Electron IPC substitute. No production accounts, kernels or network requests.
window.__uiAuditErrors = [];
window.__uiAuditCalls = [];
window.addEventListener('error', (event) => window.__uiAuditErrors.push(event.message));
window.addEventListener('unhandledrejection', (event) => window.__uiAuditErrors.push(String(event.reason?.message || event.reason)));
const bridge = {
  onEvent: () => {},
  getInfo: async () => ({ platform: 'darwin', appVersion: '1.0.24', browsers: [], profileRoot: 'UI-AUDIT-FIXTURE' }),
  getSyncState: async () => ({ active: false, selected: [] }),
  setSyncSettings: async () => ({}),
  proxyList: async () => [],
  profileStatus: async () => [],
  syncProfiles: async (profiles) => { window.__uiAuditSavedProfiles = profiles; return profiles.map((profile) => ({ ...profile, running: false })); },
  extensionList: async () => [],
  appCenterList: async () => ({ list: { builtin: [], recommended: [], local: [] }, counts: {} }),
  syncSessions: async () => [],
  setSyncSelection: async () => ({}),
  setUiTheme: async () => ({}),
  setUiChrome: async () => ({}),
};
window.ops = new Proxy(bridge, {
  get(target, key) {
    if (key in target) return target[key];
    if (typeof key !== 'string') return undefined;
    return (...args) => { window.__uiAuditCalls.push(key); return Promise.resolve({}); };
  },
});
