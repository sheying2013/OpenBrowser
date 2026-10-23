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
  trashProfiles: async (ids) => {
    for (const id of ids) {
      const p = (window.__uiAuditSavedProfiles || []).find((x) => x.id === id);
      if (p) { p.trashed = true; p.trashedAt = new Date().toISOString(); }
    }
    return { success: true, trashed: ids.length, ids };
  },
  restoreProfiles: async (ids) => {
    for (const id of ids) {
      const p = (window.__uiAuditSavedProfiles || []).find((x) => x.id === id);
      if (p) { p.trashed = false; p.trashedAt = null; }
    }
    return { success: true, restored: ids.length, ids };
  },
  purgeProfiles: async (ids) => {
    window.__uiAuditSavedProfiles = (window.__uiAuditSavedProfiles || []).filter((x) => !ids.includes(x.id));
    return { success: true, purged: ids.length, ids };
  },
  emptyTrash: async () => {
    window.__uiAuditSavedProfiles = (window.__uiAuditSavedProfiles || []).filter((x) => !x.trashed);
    return { success: true };
  },
};
window.ops = new Proxy(bridge, {
  get(target, key) {
    if (key in target) return target[key];
    if (typeof key !== 'string') return undefined;
    return (...args) => { window.__uiAuditCalls.push(key); return Promise.resolve({}); };
  },
});
