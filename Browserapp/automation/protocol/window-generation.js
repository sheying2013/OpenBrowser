'use strict';

/**
 * Per-window generation guard for native and CDP window synchronization.
 *
 * A window number / handle may be reused by the operating system after the
 * original window closes. A delayed event from the old window must never be
 * accepted by the replacement window. Each logical window key therefore gets
 * a monotonically increasing generation. Retired keys keep their highest
 * generation so stale events cannot resurrect an old identity.
 */

const GENERATION_KEYS = Object.freeze([
  'windowGeneration',
  'nativeWindowGeneration',
  'generation',
]);

const WINDOW_KEYS = Object.freeze([
  ['windowKey', 'key'],
  ['nativeWindowKey', 'key'],
  ['windowNumber', 'window-number'],
  ['nativeWindowNumber', 'window-number'],
  ['windowId', 'window-id'],
  ['nativeWindowId', 'window-id'],
  ['browserWindowId', 'window-id'],
]);

function toPositiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function normalizeWindowKey(value) {
  if (value === undefined || value === null) return '';
  const key = String(value).trim();
  return key ? key : '';
}

function extractWindowGeneration(payload = {}) {
  for (const key of GENERATION_KEYS) {
    if (!(key in payload)) continue;
    const generation = toPositiveInteger(payload[key]);
    if (generation) return generation;
  }
  return 0;
}

function extractWindowIdentity(payload = {}, fallback = '') {
  for (const [key, prefix] of WINDOW_KEYS) {
    if (!(key in payload)) continue;
    const value = normalizeWindowKey(payload[key]);
    if (!value) continue;
    return prefix === 'key' ? value : `${prefix}:${value}`;
  }
  return normalizeWindowKey(fallback);
}

class WindowGenerationRegistry {
  constructor(options = {}) {
    this.current = new Map();
    this.retired = new Map();
    this.nextGeneration = 0;
    const start = toPositiveInteger(options.startsWith);
    if (start) this.nextGeneration = start;
  }

  get size() { return this.current.size; }
  get retiredSize() { return this.retired.size; }

  generationFor(key) {
    const normalized = normalizeWindowKey(key);
    if (!normalized) return 0;
    const existing = this.current.get(normalized);
    if (existing) return existing;
    const retired = this.retired.get(normalized) || 0;
    this.nextGeneration += 1;
    if (this.nextGeneration <= retired) this.nextGeneration = retired + 1;
    const generation = this.nextGeneration;
    this.current.set(normalized, generation);
    return generation;
  }

  currentGeneration(key) {
    return this.current.get(normalizeWindowKey(key)) || 0;
  }

  retiredGeneration(key) {
    return this.retired.get(normalizeWindowKey(key)) || 0;
  }

  isCurrent(key, generation) {
    const normalized = normalizeWindowKey(key);
    if (!normalized) return false;
    const current = this.current.get(normalized) || 0;
    const expected = toPositiveInteger(generation);
    return Boolean(current && expected && current === expected);
  }

  adopt(key, generation) {
    const normalized = normalizeWindowKey(key);
    const expected = toPositiveInteger(generation);
    if (!normalized || !expected) {
      return { ok: false, generation: 0, reason: 'invalid-generation' };
    }
    const current = this.current.get(normalized) || 0;
    if (current) {
      return current === expected
        ? { ok: true, generation: current, reason: 'current' }
        : { ok: false, generation: current, reason: 'stale-generation' };
    }
    const retired = this.retired.get(normalized) || 0;
    if (retired && expected <= retired) {
      return { ok: false, generation: 0, reason: 'retired-generation' };
    }
    if (expected > this.nextGeneration) this.nextGeneration = expected;
    this.current.set(normalized, expected);
    return { ok: true, generation: expected, reason: 'adopted' };
  }

  forget(key, generation = 0) {
    const normalized = normalizeWindowKey(key);
    if (!normalized) return false;
    const current = this.current.get(normalized) || 0;
    if (!current) return false;
    const expected = toPositiveInteger(generation);
    if (expected && expected !== current) return false;
    this.current.delete(normalized);
    this.retired.set(normalized, Math.max(this.retired.get(normalized) || 0, current));
    return true;
  }

  snapshot() {
    return {
      current: Object.fromEntries(this.current),
      retired: Object.fromEntries(this.retired),
      nextGeneration: this.nextGeneration,
    };
  }

  clear() {
    this.current.clear();
    this.retired.clear();
    this.nextGeneration = 0;
  }
}

/**
 * Validate one synchronization payload.
 *
 * Missing generation data is accepted for backwards compatibility and causes
 * the key to be allocated if it is new. Once a payload carries a generation,
 * it must match the live key; retired generations are never accepted.
 */
function acceptWindowEvent(registry, fallbackKey, payload = {}, options = {}) {
  if (!(registry instanceof WindowGenerationRegistry)) {
    throw new TypeError('registry must be a WindowGenerationRegistry');
  }
  const key = normalizeWindowKey(options.key) || extractWindowIdentity(payload, fallbackKey);
  if (!key) return { accept: false, generation: 0, key: '', reason: 'missing-window-key' };

  const provided = extractWindowGeneration(payload);
  if (!provided) {
    const generation = registry.generationFor(key);
    return { accept: true, generation, key, reason: 'unversioned' };
  }

  const current = registry.currentGeneration(key);
  if (current) {
    if (current !== provided) {
      return { accept: false, generation: current, key, reason: 'stale-generation' };
    }
    return { accept: true, generation: current, key, reason: 'current' };
  }

  const retired = registry.retiredGeneration(key);
  if (retired && provided <= retired) {
    return { accept: false, generation: 0, key, reason: 'retired-generation' };
  }

  if (options.adoptUnknown === false) {
    return { accept: false, generation: 0, key, reason: 'unknown-window' };
  }
  const adopted = registry.adopt(key, provided);
  return {
    accept: adopted.ok,
    generation: adopted.generation,
    key,
    reason: adopted.ok ? 'adopted' : adopted.reason,
  };
}

module.exports = {
  WindowGenerationRegistry,
  acceptWindowEvent,
  extractWindowGeneration,
  extractWindowIdentity,
  normalizeWindowKey,
  toPositiveInteger,
};
