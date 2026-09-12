'use strict';

/**
 * Navigation policy for application windows.
 *
 * Rendering untrusted pages inside an Electron shell creates two risks: a page
 * navigating the shell itself to foreign content, and a page opening a new
 * window that inherits node integration. This module centralises the decision
 * so every window answers the same way.
 *
 * Decision order:
 *   1. development mode          -> allow everything
 *   2. exact allow-list URLs     -> allow (e.g. about:blank)
 *   3. allow-listed protocols    -> allow (e.g. file:)
 *   4. per-window host allow-list-> allow
 *   5. same-origin as the window's initial URL -> allow
 *   6. otherwise                 -> block
 */

const DEFAULT_ALLOWED_PROTOCOLS = ['file:'];
const DEFAULT_ALLOWED_URLS = ['about:blank'];

/**
 * Match a hostname against an allow-list entry.
 * Supports an exact host and a `*.example.com` wildcard (which also matches
 * the bare domain). Entries are compared case-insensitively.
 */
function hostMatches(hostname, pattern) {
  if (!hostname || !pattern) return false;
  const host = String(hostname).toLowerCase();
  const rule = String(pattern).toLowerCase().replace(/^\./, '');

  if (rule.startsWith('*.')) {
    const suffix = rule.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === rule;
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (_) {
    return null;
  }
}

/**
 * Build a policy object.
 *
 * @param {object} [options]
 * @param {Record<string, string[]>} [options.hostsByWindow] Per-window host allow-lists.
 * @param {string[]} [options.allowedProtocols]
 * @param {string[]} [options.allowedUrls]
 * @param {boolean} [options.developmentMode]
 */
function createPolicy(options = {}) {
  const hostsByWindow = {};
  const source = options.hostsByWindow || {};
  for (const [windowName, hosts] of Object.entries(source)) {
    hostsByWindow[windowName] = Array.isArray(hosts) ? hosts.slice() : [];
  }

  return {
    hostsByWindow,
    allowedProtocols: (options.allowedProtocols || DEFAULT_ALLOWED_PROTOCOLS).slice(),
    allowedUrls: (options.allowedUrls || DEFAULT_ALLOWED_URLS).slice(),
    developmentMode: Boolean(options.developmentMode),
  };
}

/**
 * Decide whether a navigation may proceed.
 *
 * @param {object} policy
 * @param {string} windowName
 * @param {string} navigationUrl
 * @param {{initialUrl?: string}} [context]
 * @returns {{allowed: boolean, reason: string, rule?: string}}
 */
function evaluateNavigation(policy, windowName, navigationUrl, context = {}) {
  if (!policy) return { allowed: false, reason: 'no policy configured' };
  if (policy.developmentMode) {
    return { allowed: true, reason: 'development mode', rule: 'development' };
  }

  if (policy.allowedUrls.includes(navigationUrl)) {
    return { allowed: true, reason: 'url is allow-listed', rule: 'allowed-url' };
  }

  let parsed;
  try {
    parsed = new URL(navigationUrl);
  } catch (_) {
    return { allowed: false, reason: 'malformed url' };
  }

  if (policy.allowedProtocols.includes(parsed.protocol)) {
    return { allowed: true, reason: 'protocol is allow-listed', rule: 'allowed-protocol' };
  }

  const perWindow = policy.hostsByWindow[windowName];
  if (Array.isArray(perWindow)) {
    if (perWindow.some((rule) => hostMatches(parsed.hostname, rule))) {
      return { allowed: true, reason: 'host is allow-listed for this window', rule: 'window-host' };
    }
  }

  if (context.initialUrl) {
    const initialOrigin = originOf(context.initialUrl);
    // file:, data:, blob: and javascript: all report the opaque origin "null".
    // Opaque origins are never same-origin with one another, so comparing them
    // as strings would let every one of those schemes ride this rule.
    const initialIsOpaque = !initialOrigin || initialOrigin === 'null';
    if (!initialIsOpaque && parsed.origin === initialOrigin) {
      return { allowed: true, reason: 'same-origin as initial url', rule: 'same-origin' };
    }
  }

  return { allowed: false, reason: `blocked navigation to ${parsed.hostname || navigationUrl}` };
}

/** Convenience boolean wrapper. */
function isNavigationAllowed(policy, windowName, navigationUrl, context) {
  return evaluateNavigation(policy, windowName, navigationUrl, context).allowed;
}

/**
 * Decide whether a window-creation request should be allowed.
 * External URLs are handed to the OS browser rather than opened in-app.
 *
 * @returns {{allow: false, openExternal: boolean, reason: string}}
 */
function evaluateWindowOpen(policy, windowName, targetUrl, context = {}) {
  const decision = evaluateNavigation(policy, windowName, targetUrl, context);
  if (decision.allowed) {
    return { allow: true, openExternal: false, reason: decision.reason };
  }
  let external = false;
  try {
    const parsed = new URL(targetUrl);
    external = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    external = false;
  }
  return { allow: false, openExternal: external, reason: decision.reason };
}

/**
 * Attach the policy to an Electron webContents instance.
 * `will-navigate` is blocked in place; `setWindowOpenHandler` denies new
 * windows and optionally forwards http(s) targets to the system browser.
 *
 * @param {object} webContents
 * @param {string} windowName
 * @param {object} policy
 * @param {object} [hooks]
 * @param {(url:string)=>void} [hooks.openExternal]
 * @param {(message:string)=>void} [hooks.onBlocked]
 * @returns {() => void} Detach function.
 */
function attachNavigationGuard(webContents, windowName, policy, hooks = {}) {
  if (!webContents || typeof webContents.on !== 'function') {
    throw new TypeError('webContents with .on is required');
  }
  const onBlocked = typeof hooks.onBlocked === 'function' ? hooks.onBlocked : null;
  const openExternal = typeof hooks.openExternal === 'function' ? hooks.openExternal : null;

  const initialUrl = typeof webContents.getURL === 'function' ? webContents.getURL() : undefined;

  const handleNavigate = (event, navigationUrl) => {
    const decision = evaluateNavigation(policy, windowName, navigationUrl, { initialUrl });
    if (!decision.allowed) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (onBlocked) onBlocked(`blocked navigation in "${windowName}" to ${navigationUrl}: ${decision.reason}`);
    }
  };

  webContents.on('will-navigate', handleNavigate);

  let previousHandler = null;
  if (typeof webContents.setWindowOpenHandler === 'function') {
    webContents.setWindowOpenHandler((details) => {
      const decision = evaluateWindowOpen(policy, windowName, details.url, { initialUrl });
      if (!decision.allow) {
        if (decision.openExternal && openExternal) openExternal(details.url);
        if (onBlocked) onBlocked(`blocked window open in "${windowName}" to ${details.url}: ${decision.reason}`);
        return { action: 'deny' };
      }
      if (onBlocked) onBlocked(`allowed window open in "${windowName}" to ${details.url}`);
      return { action: 'allow' };
    });
  }

  return function detach() {
    if (typeof webContents.removeListener === 'function') {
      webContents.removeListener('will-navigate', handleNavigate);
    }
    if (previousHandler && typeof webContents.setWindowOpenHandler === 'function') {
      webContents.setWindowOpenHandler(previousHandler);
    }
  };
}

module.exports = {
  createPolicy,
  evaluateNavigation,
  evaluateWindowOpen,
  isNavigationAllowed,
  attachNavigationGuard,
  hostMatches,
  originOf,
  DEFAULT_ALLOWED_PROTOCOLS,
  DEFAULT_ALLOWED_URLS,
};
