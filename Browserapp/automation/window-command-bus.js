'use strict';

/**
 * Named window command bus.
 *
 * Multiple windows coexist in one process, so window commands must be routed
 * by name rather than broadcast. Each window registers a handler set once and
 * receives commands addressed to it.
 *
 * Supported commands:
 *   close, minimize, maximize, unmaximize, focus, hide, show, setResizable
 *
 * Window handlers are attached and detached as a unit, which keeps listener
 * bookkeeping in one place and prevents the leak that accumulates when a
 * closed window leaves its handlers behind.
 */

const COMMANDS = [
  'close',
  'minimize',
  'maximize',
  'unmaximize',
  'focus',
  'hide',
  'show',
  'setResizable',
];

/** `command:windowName` — the window name is the last segment. */
function commandTopic(command, windowName) {
  return `${command}:${windowName}`;
}

/** Split a topic back into its command and window name (names may contain ':'). */
function parseTopic(topic) {
  const index = String(topic).indexOf(':');
  if (index === -1) return { command: String(topic), windowName: '' };
  return {
    command: topic.slice(0, index),
    windowName: topic.slice(index + 1),
  };
}

class WindowCommandBus {
  constructor() {
    /** @type {Map<string, Map<string, Function>>} window name -> command -> listener */
    this.listeners = new Map();
  }

  /**
   * Attach a handler set for one window.
   * Any previous registration for the same window is detached first, so a
   * window that is recreated does not end up with duplicate handlers.
   *
   * @param {string} windowName
   * @param {Record<string, Function>} handlers Partial map of command -> handler.
   * @returns {() => void} Detach function.
   */
  register(windowName, handlers = {}) {
    if (!windowName) throw new TypeError('window name is required');
    this.unregister(windowName);

    const perWindow = new Map();
    for (const [command, handler] of Object.entries(handlers)) {
      if (typeof handler !== 'function') continue;
      perWindow.set(command, handler);
    }
    this.listeners.set(windowName, perWindow);

    return () => this.unregister(windowName);
  }

  /**
   * Detach every handler for a window.
   * @returns {number} how many handlers were removed
   */
  unregister(windowName) {
    const perWindow = this.listeners.get(windowName);
    if (!perWindow) return 0;
    const count = perWindow.size;
    this.listeners.delete(windowName);
    return count;
  }

  /**
   * Attach a single command handler, leaving other commands in place.
   * @returns {() => void} Detach function for this handler only.
   */
  on(windowName, command, handler) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    let perWindow = this.listeners.get(windowName);
    if (!perWindow) {
      perWindow = new Map();
      this.listeners.set(windowName, perWindow);
    }
    perWindow.set(command, handler);
    return () => {
      const current = this.listeners.get(windowName);
      if (!current) return;
      // Only drop this entry, and only if it is still the one we installed.
      if (current.get(command) === handler) current.delete(command);
      if (current.size === 0) this.listeners.delete(windowName);
    };
  }

  /**
   * Dispatch a command to one window.
   *
   * @param {string} windowName
   * @param {string} command
   * @param {*} [payload]
   * @returns {boolean} true when a handler ran.
   */
  send(windowName, command, payload) {
    const perWindow = this.listeners.get(windowName);
    if (!perWindow) return false;
    const handler = perWindow.get(command);
    if (!handler) return false;
    handler(payload);
    return true;
  }

  /** Dispatch to a window identified by a `command:name` topic. */
  dispatch(topic, payload) {
    const { command, windowName } = parseTopic(topic);
    return this.send(windowName, command, payload);
  }

  /** Whether a window has a handler for a command. */
  has(windowName, command) {
    const perWindow = this.listeners.get(windowName);
    return Boolean(perWindow && perWindow.has(command));
  }

  /** Window names currently registered. */
  names() {
    return [...this.listeners.keys()];
  }

  /** Detach everything. */
  clear() {
    const count = [...this.listeners.values()].reduce((sum, m) => sum + m.size, 0);
    this.listeners.clear();
    return count;
  }

  get size() {
    return [...this.listeners.values()].reduce((sum, m) => sum + m.size, 0);
  }
}

/**
 * Build a handler set from an adapter.
 *
 * The adapter exposes the operations a concrete window supports; missing ones
 * are simply not registered, so a window that cannot be resized does not
 * advertise `setResizable`.
 *
 * @param {object} adapter
 * @param {Function} [adapter.close]        Receives `{force:boolean}`.
 * @param {Function} [adapter.minimize]
 * @param {Function} [adapter.maximize]
 * @param {Function} [adapter.unmaximize]
 * @param {Function} [adapter.focus]
 * @param {Function} [adapter.hide]
 * @param {Function} [adapter.show]
 * @param {Function} [adapter.setResizable] Receives a boolean.
 * @returns {Record<string, Function>}
 */
function handlersFromAdapter(adapter = {}) {
  const handlers = {};
  if (typeof adapter.close === 'function') {
    handlers.close = (payload) => {
      const force = Boolean(payload && payload.force);
      adapter.close(force);
    };
  }
  for (const command of ['minimize', 'maximize', 'unmaximize', 'focus', 'hide', 'show']) {
    if (typeof adapter[command] === 'function') {
      handlers[command] = () => adapter[command]();
    }
  }
  if (typeof adapter.setResizable === 'function') {
    handlers.setResizable = (value) => adapter.setResizable(Boolean(value));
  }
  return handlers;
}

module.exports = {
  WindowCommandBus,
  handlersFromAdapter,
  commandTopic,
  parseTopic,
  COMMANDS,
};
