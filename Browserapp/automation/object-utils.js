'use strict';

/**
 * Object helpers for building request payloads and config records.
 *
 * Optional fields often arrive as `undefined`, `null` or an empty array. Those
 * are omitted before sending so the receiver does not have to distinguish
 * "absent" from "explicitly empty".
 *
 * All helpers here return new objects; the input is never modified.
 */

/** Plain-object test that excludes arrays, dates and class instances. */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Values that carry no information and are safe to drop. */
function isEmptyValue(value) {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

/**
 * Remove entries whose value is empty, without touching the input.
 *
 * @param {object} object
 * @param {{keepNull?:boolean, dropEmptyString?:boolean}} [options]
 * @returns {object}
 */
function filterUndefined(object, options = {}) {
  if (!isPlainObject(object)) return object;

  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) continue;
    if (!options.keepNull && value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (options.dropEmptyString && value === '') continue;
    out[key] = value;
  }
  return out;
}

/**
 * Recursively remove empty entries from nested plain objects.
 * Arrays keep their shape; only empty arrays themselves are dropped.
 *
 * @param {*} value
 * @param {{keepNull?:boolean, dropEmptyString?:boolean}} [options]
 */
function filterEmptyDeep(value, options = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => filterEmptyDeep(item, options));
  }
  if (!isPlainObject(value)) return value;

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    if (!options.keepNull && child === null) continue;
    if (Array.isArray(child) && child.length === 0) continue;
    if (options.dropEmptyString && child === '') continue;

    const cleaned = filterEmptyDeep(child, options);
    // A nested object that became empty carries no information either.
    if (isPlainObject(child) && Object.keys(cleaned).length === 0 && !options.keepEmptyObjects) continue;
    out[key] = cleaned;
  }
  return out;
}

/** Keep only the listed keys that are present. */
function pick(object, keys) {
  if (!isPlainObject(object)) return {};
  const wanted = new Set(keys || []);
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (wanted.has(key)) out[key] = value;
  }
  return out;
}

/** Drop the listed keys. */
function omit(object, keys) {
  if (!isPlainObject(object)) return {};
  const drop = new Set(keys || []);
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (!drop.has(key)) out[key] = value;
  }
  return out;
}

/** Shallow merge that skips `undefined` overrides. */
function mergeDefined(target, source) {
  const out = isPlainObject(target) ? Object.assign({}, target) : {};
  if (!isPlainObject(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Compare two values for a deep equality that is safe on cyclic input.
 * Used by tests and config diffing, not on hot paths.
 */
function deepEqual(a, b, seen = new WeakMap()) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);

  const cached = seen.get(a);
  if (cached === b) return true;
  seen.set(a, b);

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i], seen));
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key], seen));
}

module.exports = {
  isPlainObject,
  isEmptyValue,
  filterUndefined,
  filterEmptyDeep,
  pick,
  omit,
  mergeDefined,
  deepEqual,
};
