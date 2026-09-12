'use strict';

/**
 * Validation for values that reach the browser configuration surface.
 *
 * Every field here arrives from a form, a control-plane request or a proxy
 * paste box, so "it parsed as a number" is not good enough. Two failure modes
 * motivated this module:
 *
 *   - `Number(null)` and `Number('')` are `0`, which is finite. Coercing an
 *     absent coordinate that way silently relocates a profile to a real
 *     place on the equator instead of reporting it as unknown.
 *   - A coordinate, port or host that is out of range is not merely wrong
 *     data: it makes the profile internally inconsistent, which is exactly
 *     the kind of contradiction that automated checks look for.
 *
 * The rules are intentionally dependency-free and take values of unknown
 * type, because that is how they arrive from JSON.
 */

const net = require('net');

const MIN_PORT = 1;
const MAX_PORT = 65535;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/* ------------------------------------------------------------------ *
 * Numeric coercion
 * ------------------------------------------------------------------ */

/**
 * Convert a value to a finite number, or null when it does not denote one.
 *
 * Unlike `Number()`, this rejects `null`, `''`, whitespace and booleans.
 * `Number(null) === 0` and `Number(true) === 1`, both of which turn an absent
 * or unrelated value into a plausible-looking number.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // `Number('   ')` is 0, and `Number('0x10')` is 16; accept only plain
    // decimal notation so a stray string cannot masquerade as a coordinate.
    if (trimmed === '' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Convert to an integer within [min, max], or null when out of range. */
function toBoundedInteger(value, min, max) {
  const n = toFiniteNumber(value);
  if (n === null || !Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/* ------------------------------------------------------------------ *
 * Geographic coordinates
 * ------------------------------------------------------------------ */

const MAX_LATITUDE = 90;
const MAX_LONGITUDE = 180;

/** True when the value is a usable latitude in [-90, 90]. */
function isValidLatitude(value) {
  const n = toFiniteNumber(value);
  return n !== null && n >= -MAX_LATITUDE && n <= MAX_LATITUDE;
}

/** True when the value is a usable longitude in [-180, 180]. */
function isValidLongitude(value) {
  const n = toFiniteNumber(value);
  return n !== null && n >= -MAX_LONGITUDE && n <= MAX_LONGITUDE;
}

/**
 * Latitude as a number, or null when the value is absent or out of range.
 * Prefer this over a bare `Number.isFinite(Number(v))` test.
 */
function normalizeLatitude(value) {
  return isValidLatitude(value) ? toFiniteNumber(value) : null;
}

/** Longitude as a number, or null when the value is absent or out of range. */
function normalizeLongitude(value) {
  return isValidLongitude(value) ? toFiniteNumber(value) : null;
}

/**
 * Normalise a coordinate pair.
 *
 * A pair is only useful as a pair: if either half is unusable both are
 * reported as unknown, so a caller can never persist half a location and
 * end up rendering a point derived from a default of zero.
 *
 * @returns {{latitude:number|null, longitude:number|null, valid:boolean}}
 */
function normalizeCoordinates(latitude, longitude) {
  const lat = normalizeLatitude(latitude);
  const lon = normalizeLongitude(longitude);
  if (lat === null || lon === null) return { latitude: null, longitude: null, valid: false };
  return { latitude: lat, longitude: lon, valid: true };
}

/* ------------------------------------------------------------------ *
 * Addresses, ports and hosts
 * ------------------------------------------------------------------ */

/**
 * True when the string is a bare IP address (version 4 or 6).
 * A scope or zone suffix (`fe80::1%en0`) is accepted, matching the platform.
 */
function isIP(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return false;
  return net.isIP(trimmed) !== 0;
}

/** True when the string is a dotted-quad IPv4 address. */
function isIPv4(value) {
  return typeof value === 'string' && net.isIP(value.trim()) === 4;
}

/** True when the string is an IPv6 address. */
function isIPv6(value) {
  return typeof value === 'string' && net.isIP(value.trim()) === 6;
}

/** True when the value is an integer port in [1, 65535]. */
function isValidPort(value) {
  return toBoundedInteger(value, MIN_PORT, MAX_PORT) !== null;
}

/**
 * Validate a hostname against the length and label rules of RFC 1123.
 * A bare IP address is accepted, since proxy input allows either.
 */
function isValidHostname(value) {
  if (typeof value !== 'string') return false;
  const host = value.trim().replace(/^\[|\]$/g, '');
  if (host === '' || host.length > MAX_HOSTNAME_LENGTH) return false;
  if (isIP(host)) return true;
  if (host.endsWith('.')) return isValidHostname(host.slice(0, -1));
  const labels = host.split('.');
  return labels.every((label) => {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return false;
    return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label);
  });
}

/**
 * Split `host:port` into its parts.
 *
 * Bracketed IPv6 literals are handled, since `[::1]:8080` would otherwise
 * split on the wrong colon. Returns null when the shape is unusable.
 *
 * @returns {{host:string, port:number}|null}
 */
function parseHostPort(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return null;

  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(raw);
  if (bracketed) {
    const host = bracketed[1];
    const port = toBoundedInteger(bracketed[2], MIN_PORT, MAX_PORT);
    if (port === null || !isValidHostname(host)) return null;
    return { host, port };
  }

  const idx = raw.lastIndexOf(':');
  if (idx < 0) return null;
  // More than one colon and no brackets means a bare IPv6 literal, which
  // cannot carry a port unambiguously.
  if (raw.indexOf(':') !== idx) return null;

  const host = raw.slice(0, idx).trim();
  const port = toBoundedInteger(raw.slice(idx + 1), MIN_PORT, MAX_PORT);
  if (port === null || !isValidHostname(host)) return null;
  return { host, port };
}

/* ------------------------------------------------------------------ *
 * Contact details
 * ------------------------------------------------------------------ */

/**
 * True when the string looks like an address that can be delivered to.
 * Deliberately permissive: the authoritative test is delivery, not this.
 */
function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const address = value.trim();
  if (address === '' || address.length > 254) return false;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || /\s/.test(address) || local.startsWith('.') || local.endsWith('.')) return false;
  if (local.includes('..')) return false;
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return false;
  return isValidHostname(domain) && domain.includes('.');
}

const PHONE_RULES = {
  CN: { pattern: /^1[3-9]\d{9}$/, example: '13800138000' },
  US: { pattern: /^[2-9]\d{2}[2-9]\d{6}$/, example: '4155550123' },
  E164: { pattern: /^\+?[1-9]\d{6,14}$/, example: '+14155550123' },
};

/**
 * Validate a subscriber number for a region.
 *
 * The input is stripped of the separators people actually type (spaces,
 * dashes, parentheses, dots). National trunk prefixes are not guessed: a
 * caller that stores international numbers should pass `E164`.
 *
 * @param {string} value
 * @param {{region?:'CN'|'US'|'E164'}} [options]
 */
function isValidPhone(value, options = {}) {
  if (typeof value !== 'string') return false;
  const region = options.region || 'CN';
  const rule = PHONE_RULES[region];
  if (!rule) throw new Error('Unsupported phone region: ' + region);
  const digits = value.replace(/[\s().-]/g, '');
  if (digits === '') return false;
  return rule.pattern.test(digits);
}

/* ------------------------------------------------------------------ *
 * URLs
 * ------------------------------------------------------------------ */

/**
 * True when the string parses as an absolute URL over an accepted scheme.
 *
 * @param {string} value
 * @param {{protocols?:string[]}} [options]
 */
function isValidUrl(value, options = {}) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const protocols = options.protocols || ['http:', 'https:'];
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (_) {
    return false;
  }
  if (!protocols.includes(parsed.protocol)) return false;
  return parsed.hostname !== '';
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

const IPV4_PATTERN = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}';
const IPV6_SEGMENT = '[0-9A-Fa-f]{1,4}';
const IPV6_PATTERN = [
  `(?:${IPV6_SEGMENT}:){7}(?:${IPV6_SEGMENT}|:)`,
  `(?:${IPV6_SEGMENT}:){6}(?:${IPV4_PATTERN}|:${IPV6_SEGMENT}|:)`,
  `(?:${IPV6_SEGMENT}:){5}(?::${IPV4_PATTERN}|(?::${IPV6_SEGMENT}){1,2}|:)`,
  `(?:${IPV6_SEGMENT}:){4}(?:(?::${IPV6_SEGMENT}){0,1}:${IPV4_PATTERN}|(?::${IPV6_SEGMENT}){1,3}|:)`,
  `(?:${IPV6_SEGMENT}:){3}(?:(?::${IPV6_SEGMENT}){0,2}:${IPV4_PATTERN}|(?::${IPV6_SEGMENT}){1,4}|:)`,
  `(?:${IPV6_SEGMENT}:){2}(?:(?::${IPV6_SEGMENT}){0,3}:${IPV4_PATTERN}|(?::${IPV6_SEGMENT}){1,5}|:)`,
  `(?:${IPV6_SEGMENT}:){1}(?:(?::${IPV6_SEGMENT}){0,4}:${IPV4_PATTERN}|(?::${IPV6_SEGMENT}){1,6}|:)`,
  `(?::(?:(?::${IPV6_SEGMENT}){0,5}:${IPV4_PATTERN}|(?::${IPV6_SEGMENT}){1,7}|:))`,
].join('|');

// Compiled once. A `/g` regex carries `lastIndex` between calls, so the
// extraction helpers below never share an instance with a caller.
//
// The guards matter as much as the pattern. Without a leading guard,
// `999.1.1.1` yields the substring `99.1.1.1`; without a trailing one,
// `1.2.3.4.5` yields `1.2.3.4`. A letter on the left means the run belongs to
// a larger token such as `0x11` or `v1`, so it is not an address either.
//
// A single trailing dot is still allowed, because prose ends sentences with
// one; a dot followed by another digit is not, which keeps five-part version
// numbers from being split. IPv6 is listed first so a mapped address such as
// `::ffff:10.0.0.1` is taken whole rather than reduced to its dotted quad.
const IP_EXTRACT = new RegExp(
  `(?<![A-Za-z0-9_.])(?:${IPV6_PATTERN}|${IPV4_PATTERN})(?![A-Za-z0-9_])(?!\\.[0-9])`,
  'g',
);

/**
 * Extract every IP address appearing in free-form text.
 *
 * Each candidate is re-checked with the platform parser, which rejects the
 * near-misses the regex alone would accept (an over-long octet, a truncated
 * IPv6 group).
 *
 * @param {string} text
 * @returns {string[]} unique addresses, in order of appearance
 */
function findIPs(text) {
  if (typeof text !== 'string' || text === '') return [];
  const seen = new Set();
  const out = [];
  for (const candidate of text.match(IP_EXTRACT) || []) {
    const bare = candidate.replace(/^\[|\]$/g, '');
    if (!isIP(bare) || seen.has(bare)) continue;
    seen.add(bare);
    out.push(bare);
  }
  return out;
}

module.exports = {
  toFiniteNumber,
  toBoundedInteger,
  isValidLatitude,
  isValidLongitude,
  normalizeLatitude,
  normalizeLongitude,
  normalizeCoordinates,
  isIP,
  isIPv4,
  isIPv6,
  isValidPort,
  isValidHostname,
  parseHostPort,
  isValidEmail,
  isValidPhone,
  isValidUrl,
  findIPs,
  MAX_LATITUDE,
  MAX_LONGITUDE,
  MIN_PORT,
  MAX_PORT,
  PHONE_RULES,
};
