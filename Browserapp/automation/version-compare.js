'use strict';

/**
 * Version comparison for release identifiers.
 *
 * The versions this has to handle are not all `major.minor.patch`. Browser
 * engine builds carry four numeric segments, and prereleases encode ordering
 * in a suffix. Two narrower implementations previously disagreed on exactly
 * those cases:
 *
 *   - Comparing only the first three segments makes `125.0.6422.100` and
 *     `125.0.6422.101` look identical, so an update check concludes it is
 *     already current and never offers the newer build.
 *   - Splitting on non-digits discards the suffix entirely, so `1.0.0-alpha`
 *     and `1.0.0-beta` also look identical.
 *
 * This module compares every numeric segment and applies the prerelease
 * ordering rules: numeric identifiers compare numerically, alphanumeric ones
 * compare lexically, a numeric identifier sorts below an alphanumeric one,
 * and a version without a prerelease outranks the same version with one.
 *
 * Build metadata (everything after `+`) is ignored, as it is defined to carry
 * no ordering.
 */

/** Compare two integer strings without losing precision on very long values. */
function compareNumericStrings(a, b) {
  const left = String(a).replace(/^0+(?=\d)/, '');
  const right = String(b).replace(/^0+(?=\d)/, '');
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Parse a version string.
 *
 * @param {string|number} value
 * @returns {{numbers:string[], pre:string[], raw:string}|null}
 *   null when the value does not start with a numeric identifier.
 */
function parseVersion(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;

  // Drop a leading `v`, then split off build metadata before anything else.
  const body = raw.replace(/^v/i, '').split('+', 1)[0];
  const dash = body.indexOf('-');
  const numericPart = dash === -1 ? body : body.slice(0, dash);
  const prePart = dash === -1 ? '' : body.slice(dash + 1);

  if (numericPart === '' || !/^\d+(?:\.\d+)*$/.test(numericPart)) return null;
  const numbers = numericPart.split('.');

  const pre = prePart === ''
    ? []
    : prePart.split('.').filter((part) => part !== '');

  return { numbers, pre, raw };
}

/** Compare two prerelease identifiers. */
function comparePrereleaseIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return compareNumericStrings(a, b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Compare two version strings.
 *
 * Returns 0 when either side cannot be parsed. Callers that must distinguish
 * "equal" from "not comparable" should use `isComparable` first, or
 * `parseVersion` directly.
 *
 * @param {string|number} left
 * @param {string|number} right
 * @returns {-1|0|1}
 */
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;

  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const diff = compareNumericStrings(a.numbers[index] || '0', b.numbers[index] || '0');
    if (diff !== 0) return diff;
  }

  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  // A released version outranks its own prereleases.
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;

  const preLength = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < preLength; index += 1) {
    if (a.pre[index] === undefined) return -1;
    if (b.pre[index] === undefined) return 1;
    const diff = comparePrereleaseIdentifier(a.pre[index], b.pre[index]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when both values parse, so a comparison result is meaningful. */
function isComparable(left, right) {
  return parseVersion(left) !== null && parseVersion(right) !== null;
}

/**
 * True when `candidate` is strictly newer than `current`.
 *
 * An unparseable pair reports false: an update should be driven by a version
 * that could actually be read, not by a comparison the code could not make.
 */
function isNewer(candidate, current) {
  if (!isComparable(candidate, current)) return false;
  return compareVersions(candidate, current) > 0;
}

/**
 * True when `candidate` is the same release as `current`.
 * Build metadata and a leading `v` do not make versions different.
 */
function isSameVersion(left, right) {
  if (!isComparable(left, right)) return false;
  return compareVersions(left, right) === 0;
}

/**
 * Pick the highest parseable version from a list.
 *
 * @param {Array<string|number>} versions
 * @returns {string|null} the original entry, not its normalised form
 */
function highestVersion(versions) {
  if (!Array.isArray(versions)) return null;
  let best = null;
  for (const entry of versions) {
    if (!parseVersion(entry)) continue;
    if (best === null || compareVersions(entry, best) > 0) best = entry;
  }
  return best === null ? null : String(best);
}

module.exports = {
  compareVersions,
  compareNumericStrings,
  comparePrereleaseIdentifier,
  parseVersion,
  isComparable,
  isNewer,
  isSameVersion,
  highestVersion,
};
