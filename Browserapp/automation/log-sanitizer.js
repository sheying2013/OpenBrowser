'use strict';

/**
 * Log sanitisation.
 *
 * Log files outlive the session that produced them, so identifiers that are
 * stable per machine or per account must not be written verbatim. This module
 * masks those values while leaving the rest of the record readable.
 *
 * Two paths are covered:
 *   - structured data  : keys are matched and their values replaced
 *   - free-form text   : inline `key: value` fragments are rewritten
 */

const DEFAULT_SENSITIVE_KEYS = [
  'machine',
  'machineString',
  'machine_string',
  'machine_string_new',
  'MacheCode',
  'macheCode',
  'unionId',
  'oauthToken',
  'oauth_token',
  'kernelCode',
  'password',
  'proxyPassword',
  'proxy_password',
  'apiKey',
  'api_key',
  'secret',
  'token',
];

/** Keep a short prefix/suffix so values remain distinguishable in logs. */
/**
 * Query parameter names whose values must never be persisted verbatim.
 * Credentials, session handles and direct identifiers all reach servers as
 * query parameters often enough that logging a raw URL is unsafe.
 */
const SENSITIVE_QUERY_KEY = /^(?:token|access_?token|refresh_?token|id_?token|auth|authorization|api_?key|apikey|secret|client_?secret|password|passwd|pwd|session|session_?id|sid|jwt|assertion|code|signature|sig|credential|credentials|email|e_?mail|mail|phone|mobile|username|user_?name|user|account|login)$/i;

/**
 * Reduce a URL to a form that is safe to write to a log file.
 *
 * Scheme, host, path and parameter *names* stay readable — that is what makes
 * the record useful for diagnosis — while the values of credential-shaped and
 * identifying parameters are masked. The fragment is dropped outright, since
 * single-page applications routinely carry access tokens there.
 *
 * Anything that does not parse as an absolute URL falls back to inline text
 * redaction rather than being dropped.
 *
 * @param {string} url
 * @returns {string}
 */
function sanitizeUrlForLog(url) {
  if (url === null || url === undefined || url === '') return '';
  const raw = String(url);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return redactInlineText(raw);
  }

  if (parsed.username || parsed.password) {
    // Proxy and callback URLs can carry basic-auth credentials inline.
    parsed.username = parsed.username ? maskSecretString(decodeURIComponent(parsed.username)) : '';
    parsed.password = parsed.password ? maskSecretString(decodeURIComponent(parsed.password)) : '';
  }

  for (const key of Array.from(new Set(parsed.searchParams.keys()))) {
    if (!SENSITIVE_QUERY_KEY.test(key)) continue;
    const values = parsed.searchParams.getAll(key);
    parsed.searchParams.delete(key);
    for (const value of values) {
      parsed.searchParams.append(key, value ? maskSecretString(value) : '');
    }
  }

  parsed.hash = '';
  return parsed.toString();
}

function maskSecretString(value) {
  if (value === null || value === undefined || value === '') return '';
  const str = String(value);
  if (str.length <= 4) return '****';
  if (str.length <= 8) return `${str[0]}***${str[str.length - 1]}`;
  return `${str.slice(0, 2)}***${str.slice(-2)}`;
}

function maskScalar(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return '***';
  if (typeof value === 'string') return maskSecretString(value);
  return '***';
}

/**
 * Deep-copy an object with sensitive values masked.
 *
 * @param {*} input
 * @param {{sensitiveKeys?: Iterable<string>}} [options]
 */
function sanitizeForLog(input, options = {}) {
  const keys = options.sensitiveKeys
    ? new Set(options.sensitiveKeys)
    : new Set(DEFAULT_SENSITIVE_KEYS);

  const walk = (value) => {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== 'object') return value;

    const out = {};
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (keys.has(key)) {
        out[key] = maskScalar(child);
      } else if (child !== null && typeof child === 'object') {
        out[key] = walk(child);
      } else {
        out[key] = child;
      }
    }
    return out;
  };

  return walk(input);
}

function sanitizeJsonForLog(value, options) {
  try {
    return JSON.stringify(sanitizeForLog(value, options));
  } catch (_) {
    return '[unserializable]';
  }
}

/** Rewrite `key: value` fragments inside an otherwise unstructured string. */
function redactInlineText(text) {
  let out = String(text);
  const keyPattern = (key) => new RegExp(`"${key}"\\s*:\\s*"[^"]*"`, 'gi');
  for (const key of DEFAULT_SENSITIVE_KEYS) {
    out = out.replace(keyPattern(key), `"${key}":"***"`);
  }
  // Numeric identifiers need their own pattern.
  out = out.replace(/"unionId"\s*:\s*-?\d+/gi, '"unionId":***');
  out = out.replace(/\bmachineId=([a-fA-F0-9]{32})\b/g, 'machineId=***');
  // Bare `key=value` pairs that never appear as JSON.
  out = out.replace(/\b(token|password|secret)=([^\s&,;]+)/gi, '$1=***');
  return out;
}

/** Sanitise a payload that may or may not be JSON. */
function sanitizeStringPayloadForLog(data, options) {
  const text = String(data == null ? '' : data);
  const trimmed = text.trim();
  const looksJson = (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'));

  if (looksJson) {
    try {
      return sanitizeJsonForLog(JSON.parse(text), options);
    } catch (_) {
      return redactInlineText(text);
    }
  }
  if (text.length > 24) return `${text.slice(0, 6)}***${text.slice(-6)}`;
  return '***';
}

/**
 * Entry point for a logger transport: normalise one argument before it is
 * written to disk. Console output is intentionally left untouched so local
 * debugging stays readable.
 */
function sanitizeLogArg(value, options) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitizeStringPayloadForLog(value, options);
  if (typeof value === 'function') {
    const name = value.name || '';
    const kind = value.constructor && value.constructor.name === 'AsyncFunction'
      ? 'AsyncFunction'
      : 'Function';
    return name ? `[${kind}: ${name}]` : `[${kind}]`;
  }
  if (value instanceof Error) {
    return redactInlineText(`${value.message}\n${value.stack || ''}`);
  }
  if (typeof value === 'object') {
    try {
      return sanitizeJsonForLog(JSON.parse(JSON.stringify(value)), options);
    } catch (_) {
      return redactInlineText(String(value));
    }
  }
  return redactInlineText(String(value));
}

/** Sanitise a whole argument list in one call. */
function sanitizeLogArgs(args, options) {
  return Array.from(args || []).map((arg) => sanitizeLogArg(arg, options));
}

module.exports = {
  DEFAULT_SENSITIVE_KEYS,
  maskSecretString,
  maskScalar,
  sanitizeForLog,
  sanitizeJsonForLog,
  sanitizeStringPayloadForLog,
  redactInlineText,
  sanitizeLogArg,
  sanitizeLogArgs,
  sanitizeUrlForLog,
  SENSITIVE_QUERY_KEY,
};
