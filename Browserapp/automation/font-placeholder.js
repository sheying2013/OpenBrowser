'use strict';

const crypto = require('crypto');

/**
 * Produce a CSS-safe, deliberately nonexistent local font name without a product identifier.
 * The value is deterministic per fingerprint seed so the network-response and DOM gates agree,
 * while unrelated profiles do not expose one shared recognizable placeholder in CSSOM.
 */
function deriveFontPlaceholder(seedOrProfile = '') {
  const seed = typeof seedOrProfile === 'object' && seedOrProfile
    ? String(seedOrProfile.seed || seedOrProfile.id || JSON.stringify(seedOrProfile.fonts?.list || []))
    : String(seedOrProfile || 'font-fallback');
  const digest = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24);
  return `LocalFontFallback${digest}`;
}

function deriveBridgeToken(input = '') {
  let material = '';
  try { material = typeof input === 'string' ? input : JSON.stringify(input); } catch (_) { material = String(input); }
  return crypto.createHash('sha256').update('private-bridge:' + material).digest('hex').slice(0, 32);
}

module.exports = { deriveFontPlaceholder, deriveBridgeToken };
