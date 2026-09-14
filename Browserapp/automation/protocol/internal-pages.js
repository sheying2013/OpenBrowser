'use strict';

/**
 * Single source of truth for "which URL may a synced tab mirror, and which may it live-sync".
 *
 * main.js (IPC layer) and live-sync-v5.js (per-tab controller) must answer this identically.
 * If one permits a page the other refuses, a mirrored tab silently ends up one navigation
 * behind the master. The whitelist used to exist as two hand-copied blocks, which drifted
 * once already (main.js knew 19 internal hosts, live-sync-v5.js only 10), so both now share
 * this module instead of keeping private copies.
 *
 * Privilege separation is deliberate: a privileged `chrome://` page may be *mirrored* (the
 * slave navigates to the same URL) but must never be *live-synced* (no script injection, no
 * Runtime.addBinding) because the internal page has a different trust level than a web page.
 */

const BLOCKED_INTERNAL_SCHEMES = Object.freeze([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'chrome-devtools:',
  'devtools:',
  'view-source:',
]);

const BLOCKED_INTERNAL_HOSTS = Object.freeze(new Set([
  'crash',
  'kill',
  'quit',
  'restart',
  'hang',
  'shorthang',
  'gpuclean',
  'gpucrash',
  'gpuhang',
  'memory-exhaust',
  'inducebrowsercrashforrealz',
  'badcastcrash',
  'dcheck_failure',
  'inspect',
]));

const ALLOWED_INTERNAL_HOSTS = Object.freeze(new Set([
  'extensions',
  'settings',
  'downloads',
  'history',
  'version',
  'bookmarks',
  'flags',
  'about',
  'chrome-urls',
  'gpu',
  'newtab',
  'new-tab-page',
  'management',
  'system',
  'components',
  'policy',
  'credits',
  'terms',
  'favorites',
]));

const ALLOWED_INTERNAL_PAGES = new RegExp(
  '^(?:chrome|edge)://(' +
  Array.from(ALLOWED_INTERNAL_HOSTS).join('|') +
  ')(?=[/?#]|$)',
  'i'
);

function isNavigableInternalUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  const lower = url.trim().toLowerCase();
  if (!lower.startsWith('chrome://') && !lower.startsWith('edge://')) return false;
  const match = lower.match(/^(?:chrome|edge):\/\/([^/?#]+)/);
  if (!match) return false;
  const host = match[1];
  if (BLOCKED_INTERNAL_HOSTS.has(host)) return false;
  return ALLOWED_INTERNAL_HOSTS.has(host);
}

function isDangerousOrBlockedInternalUrl(url) {
  if (typeof url !== 'string' || !url) return true;
  const lower = url.trim().toLowerCase();
  for (const scheme of BLOCKED_INTERNAL_SCHEMES) {
    if (lower.startsWith(scheme)) return true;
  }
  const match = lower.match(/^(?:chrome|edge):\/\/([^/?#]+)/);
  if (match && BLOCKED_INTERNAL_HOSTS.has(match[1])) return true;
  return false;
}

/**
 * Build the two predicates for a caller that owns its own "is this our start page" test.
 * Keeping that predicate injectable is what lets main.js and live-sync-v5.js share the
 * rest of the policy without one importing the other.
 */
function createTabUrlPolicy({ isEnvironmentStartUrl } = {}) {
  const isStartUrl = typeof isEnvironmentStartUrl === 'function' ? isEnvironmentStartUrl : () => false;

  function canMirrorTabUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    const trimmed = url.trim();
    if (isDangerousOrBlockedInternalUrl(trimmed)) return false;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://')) return true;
    if (lower === 'about:blank' || isStartUrl(trimmed)) return true;
    if (isNavigableInternalUrl(trimmed)) return true;
    return false;
  }

  function canDomLiveSyncTabUrl(url) {
    if (!canMirrorTabUrl(url)) return false;
    if (isNavigableInternalUrl(url)) return false;
    return true;
  }

  return { canMirrorTabUrl, canDomLiveSyncTabUrl };
}

module.exports = {
  BLOCKED_INTERNAL_SCHEMES,
  BLOCKED_INTERNAL_HOSTS,
  ALLOWED_INTERNAL_HOSTS,
  ALLOWED_INTERNAL_PAGES,
  isNavigableInternalUrl,
  isDangerousOrBlockedInternalUrl,
  createTabUrlPolicy,
};
