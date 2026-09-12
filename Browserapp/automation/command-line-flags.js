'use strict';

/**
 * Command-line flag list utilities.
 *
 * Browser flags of the form `--name=value` are order sensitive and, for list
 * valued flags such as `--disable-features=A,B`, repeating the same flag is not
 * equivalent to extending its value. Passing the flag twice leaves the outcome
 * dependent on which occurrence the binary happens to read.
 *
 * These helpers treat a flag list as a map keyed by flag name, so extending a
 * value always produces a single, de-duplicated occurrence.
 */

const FLAG_PREFIX = '--';

/** Escape a string so it can be embedded in a RegExp literally. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip a leading `--` and a trailing `=` from a flag name. */
function normalizeName(name) {
  let out = String(name == null ? '' : name).trim();
  if (out.startsWith(FLAG_PREFIX)) out = out.slice(FLAG_PREFIX.length);
  if (out.endsWith('=')) out = out.slice(0, -1);
  return out;
}

/** Split a `--name=value` string into its parts. */
function parseFlag(flag) {
  const text = String(flag == null ? '' : flag);
  const eq = text.indexOf('=');
  if (eq === -1) {
    return { name: normalizeName(text), value: null, hasValue: false, raw: text };
  }
  return {
    name: normalizeName(text.slice(0, eq)),
    value: text.slice(eq + 1),
    hasValue: true,
    raw: text,
  };
}

/** Index of the flag whose name matches, or -1. */
function indexOfFlag(args, name) {
  const target = normalizeName(name);
  if (!target || !Array.isArray(args)) return -1;
  const pattern = new RegExp(`^${FLAG_PREFIX}?${escapeRegExp(target)}(?:=|$)`);
  return args.findIndex((arg) => typeof arg === 'string' && pattern.test(arg.trim()));
}

/** Read a flag's value, or null when the flag is absent or valueless. */
function getFlag(args, name) {
  const index = indexOfFlag(args, name);
  if (index === -1) return null;
  const parsed = parseFlag(args[index]);
  return parsed.hasValue ? parsed.value : null;
}

/** Whether the flag appears at all. */
function hasFlag(args, name) {
  return indexOfFlag(args, name) !== -1;
}

/** Insert or replace a flag, returning a new array. */
function setFlag(args, name, value) {
  const list = Array.isArray(args) ? args.slice() : [];
  const target = normalizeName(name);
  if (!target) return list;
  const rendered = value === undefined || value === null || value === ''
    ? `${FLAG_PREFIX}${target}`
    : `${FLAG_PREFIX}${target}=${value}`;

  const index = indexOfFlag(list, target);
  if (index === -1) list.push(rendered);
  else list[index] = rendered;
  return list;
}

/** Remove every occurrence of a flag, returning a new array. */
function removeFlag(args, name) {
  const list = Array.isArray(args) ? args.slice() : [];
  const target = normalizeName(name);
  if (!target) return list;
  const pattern = new RegExp(`^${FLAG_PREFIX}?${escapeRegExp(target)}(?:=|$)`);
  return list.filter((arg) => !(typeof arg === 'string' && pattern.test(arg.trim())));
}

function splitValues(value) {
  if (value === null || value === undefined) return [];
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Append a value to a list-style flag, de-duplicating entries.
 *
 * `--disable-features=A` extended with `B` yields `--disable-features=A,B`
 * rather than a second `--disable-features=B`.
 *
 * @param {string[]} args
 * @param {string} name
 * @param {string} value Comma separated list accepted.
 * @param {{insertBefore?:boolean}} [options] Prepend instead of append.
 * @returns {string[]} A new array.
 */
function appendFlagValue(args, name, value, options = {}) {
  const list = Array.isArray(args) ? args.slice() : [];
  const target = normalizeName(name);
  if (!target) return list;

  const incoming = splitValues(value);
  if (!incoming.length) return list;

  const index = indexOfFlag(list, target);
  if (index === -1) {
    list.push(`${FLAG_PREFIX}${target}=${incoming.join(',')}`);
    return list;
  }

  const existing = parseFlag(list[index]);
  const current = splitValues(existing.value);
  const merged = options.insertBefore
    ? [...incoming, ...current.filter((item) => !incoming.includes(item))]
    : [...current, ...incoming.filter((item) => !current.includes(item))];

  list[index] = `${FLAG_PREFIX}${target}=${merged.join(',')}`;
  return list;
}

/** Append several comma separated values in one call. */
function appendFlagValues(args, name, values, options) {
  const parts = Array.isArray(values) ? values.filter(Boolean) : [values];
  return parts.reduce((acc, part) => appendFlagValue(acc, name, part, options), args);
}

/** Remove specific entries from a list-style flag value. */
function removeFlagValue(args, name, value) {
  const list = Array.isArray(args) ? args.slice() : [];
  const target = normalizeName(name);
  const index = indexOfFlag(list, target);
  if (index === -1) return list;

  const drop = new Set(splitValues(value));
  const existing = parseFlag(list[index]);
  const kept = splitValues(existing.value).filter((item) => !drop.has(item));
  if (!kept.length) {
    list.splice(index, 1);
    return list;
  }
  list[index] = `${FLAG_PREFIX}${target}=${kept.join(',')}`;
  return list;
}

/**
 * Merge two flag lists into one, honouring the semantics of list-style flags.
 *
 * A plain flag present in either list appears once. A list-style flag has its
 * values combined. When `overwrite` is set, a scalar flag from `source`
 * replaces the target's value instead of being ignored.
 *
 * @param {string[]} target
 * @param {string[]} source
 * @param {{overwrite?:boolean, listFlags?:string[]}} [options]
 * @returns {string[]} A new array.
 */
/**
 * Switches whose value is a comma-separated list rather than a single scalar.
 * Merging two occurrences has to append and de-duplicate: replacing one with
 * the other silently drops whatever the first entry carried, and a plain
 * concatenation repeats names that are already present.
 */
const LIST_VALUE_FLAGS = Object.freeze(['enable-features', 'disable-features']);

function mergeFlags(target, source, options = {}) {
  let result = Array.isArray(target) ? target.slice() : [];
  const extra = Array.isArray(source) ? source : [];
  const listFlags = new Set((options.listFlags || []).map(normalizeName));

  for (const flag of extra) {
    if (typeof flag !== 'string' || !flag) continue;
    // Positional arguments are not flags; carry them through unchanged rather
    // than rewriting them into `--name` form.
    if (!flag.trim().startsWith(FLAG_PREFIX)) {
      result.push(flag);
      continue;
    }
    const parsed = parseFlag(flag);
    if (!parsed.name) continue;

    const isList = listFlags.has(parsed.name);
    const index = indexOfFlag(result, parsed.name);

    if (isList) {
      result = appendFlagValue(result, parsed.name, parsed.value || '');
      continue;
    }

    if (index === -1 || options.overwrite) {
      result = setFlag(result, parsed.name, parsed.hasValue ? parsed.value : undefined);
    }
    // Otherwise the existing scalar flag wins and the duplicate is dropped.
  }
  return result;
}

/** Names of the flags present, in order. */
function flagNames(args) {
  return (Array.isArray(args) ? args : [])
    .filter((arg) => typeof arg === 'string' && arg.trim().startsWith(FLAG_PREFIX))
    .map((arg) => parseFlag(arg).name);
}

/** Report flags that appear more than once, which is usually a bug. */
function findDuplicates(args) {
  const seen = new Map();
  for (const name of flagNames(args)) {
    seen.set(name, (seen.get(name) || 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([name, count]) => ({ name, count }));
}

module.exports = {
  FLAG_PREFIX,
  escapeRegExp,
  normalizeName,
  parseFlag,
  indexOfFlag,
  getFlag,
  hasFlag,
  setFlag,
  removeFlag,
  appendFlagValue,
  appendFlagValues,
  removeFlagValue,
  mergeFlags,
  LIST_VALUE_FLAGS,
  flagNames,
  findDuplicates,
};
