'use strict';

/**
 * Application shell navigation guard.
 *
 * The shell window renders local files only. Page content inside it must not be
 * able to navigate the shell to somewhere else, and must not be able to spawn a
 * child window (a child would inherit this window's preload).
 *
 * The allow-list mirrors the session request filter in the host process, so the
 * two cannot drift apart; `selftest:shellguard` fails if they ever do.
 */

const { createPolicy, evaluateNavigation } = require('./navigation-policy');

/** Window name used for the shell in policy look-ups. */
const SHELL_WINDOW = 'shell';
/** Protocols the shell may navigate to: local documents plus DevTools internals. */
const SHELL_ALLOWED_PROTOCOLS = ['file:', 'data:', 'devtools:'];
/** Exact URLs the shell may navigate to. */
const SHELL_ALLOWED_URLS = ['about:blank'];
/** Hosts served by the app itself; anything else is remote content. */
const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];

/** Build the policy used for the shell window. */
function createShellNavigationPolicy(options = {}) {
  return createPolicy({
    allowedProtocols: SHELL_ALLOWED_PROTOCOLS,
    allowedUrls: SHELL_ALLOWED_URLS,
    hostsByWindow: { [SHELL_WINDOW]: LOCAL_HOSTS.slice() },
    developmentMode: options.developmentMode === true,
  });
}

/**
 * Block shell navigation that the policy does not allow.
 *
 * Child windows stay denied for every target — stricter than the generic
 * policy on purpose, because a child of the shell would inherit its preload.
 *
 * @param {object} webContents Electron webContents (or any event emitter alike)
 * @param {{policy?:object, onBlocked?:Function}} [options]
 * @returns {() => void} Detach function.
 */
function attachShellNavigationGuard(webContents, options = {}) {
  if (!webContents || typeof webContents.on !== 'function') {
    throw new TypeError('webContents with .on is required');
  }
  const policy = options.policy || createShellNavigationPolicy();
  const onBlocked = typeof options.onBlocked === 'function' ? options.onBlocked : null;
  const initialUrl = typeof webContents.getURL === 'function' ? webContents.getURL() : undefined;

  const handleNavigate = (event, navigationUrl) => {
    const decision = evaluateNavigation(policy, SHELL_WINDOW, navigationUrl, { initialUrl });
    if (decision.allowed) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (onBlocked) onBlocked({ url: navigationUrl, reason: decision.reason });
  };

  webContents.on('will-navigate', handleNavigate);

  if (typeof webContents.setWindowOpenHandler === 'function') {
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  return function detach() {
    if (typeof webContents.removeListener === 'function') {
      webContents.removeListener('will-navigate', handleNavigate);
    }
  };
}

module.exports = {
  attachShellNavigationGuard,
  createShellNavigationPolicy,
  SHELL_WINDOW,
  SHELL_ALLOWED_PROTOCOLS,
  SHELL_ALLOWED_URLS,
  LOCAL_HOSTS,
};
