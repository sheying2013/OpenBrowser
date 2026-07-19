'use strict';

/**
 * Control surface that exposes OpenBrowser live-sync (window sync).
 * Does not reimplement CDP fan-out; delegates to existing LiveSyncController.
 */
class WindowSyncBridge {
  constructor({
    getLiveSync,
    beginSync,
    endSync,
    restartSync,
    getSyncState,
    setSelection,
    tile,
    getSettings,
    updateSettings,
  }) {
    this.getLiveSync = getLiveSync;
    this.beginSync = beginSync;
    this.endSync = endSync;
    this.restartSync = restartSync;
    this.getSyncState = getSyncState;
    this.setSelection = setSelection;
    this.tile = tile;
    this.getSettings = getSettings;
    this.updateSettings = updateSettings;
  }

  status() {
    const state = this.getSyncState() || {};
    const settings = this.getSettings ? this.getSettings() : {};
    const operate = Array.isArray(settings.operate)
      ? settings.operate
      : Object.entries(settings)
        .filter(([key, value]) => ['keyboard', 'click', 'scroll', 'track', 'move'].includes(key) && value !== false)
        .map(([key]) => (key === 'track' ? 'move' : key));
    return {
      active: Boolean(state.active),
      master: state.master || null,
      selected: state.selected || [],
      settings,
      platform: process.platform,
      capabilities: settings.capabilities || null,
      // Compatibility aliases for Local API clients
      startSync: Boolean(state.active),
      syncOperateList: operate.includes('move') || operate.includes('track')
        ? [...new Set(operate.map((k) => (k === 'track' ? 'move' : k)))]
        : operate,
    };
  }

  async start(profileIds = [], options = {}) {
    const ids = Array.isArray(profileIds) ? profileIds.map(String) : [];
    if (ids.length) this.setSelection?.(ids);
    if (options.settings) this.updateSettings?.(options.settings);
    if (options.tile !== false && ids.length >= 2) {
      await this.tile?.(ids, options.cascade === true);
    }
    return this.beginSync(ids.length ? ids : undefined);
  }

  stop() {
    return this.endSync();
  }

  async restart() {
    return this.restartSync();
  }

  async arrange(profileIds = [], mode = 'tile') {
    const ids = Array.isArray(profileIds) ? profileIds.map(String) : [];
    if (!ids.length) throw new Error('handles required');
    if (mode === 'cascade') return this.tile(ids, true);
    return this.tile(ids, false);
  }

  updateOperateList(list = []) {
    const set = new Set(Array.isArray(list) ? list.map(String) : String(list).split(',').map((s) => s.trim()).filter(Boolean));
    const settings = {
      keyboard: set.has('keyboard') || set.has('key'),
      click: set.has('click'),
      scroll: set.has('scroll'),
      track: set.has('track') || set.has('move'),
    };
    return this.updateSettings?.(settings);
  }
}

module.exports = { WindowSyncBridge };
