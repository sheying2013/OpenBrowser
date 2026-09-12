'use strict';

/**
 * Self-test for version comparison.
 */

const assert = require('assert');
const v = require('./version-compare');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

// ---- numeric segments ----

check('every numeric segment takes part in the comparison', () => {
  // A browser engine build carries four segments; stopping at three reports
  // these as identical and an update is never offered.
  assert.strictEqual(v.compareVersions('125.0.6422.100', '125.0.6422.101'), -1);
  assert.strictEqual(v.compareVersions('125.0.6422.101', '125.0.6422.100'), 1);
  assert.strictEqual(v.compareVersions('1.2.3.4', '1.2.3.5'), -1);
  assert.strictEqual(v.compareVersions('1.2.3.4.5', '1.2.3.4.6'), -1);
});

check('versions with different segment counts are padded with zeros', () => {
  assert.strictEqual(v.compareVersions('1.2', '1.2.0'), 0);
  assert.strictEqual(v.compareVersions('1', '1.0.0.0'), 0);
  assert.strictEqual(v.compareVersions('1.2', '1.2.1'), -1);
});

check('the numeric segments are ordered left to right', () => {
  assert.strictEqual(v.compareVersions('2.0.0', '1.9.9'), 1);
  assert.strictEqual(v.compareVersions('1.10.0', '1.9.0'), 1, 'ten is greater than nine');
  assert.strictEqual(v.compareVersions('125.0.1', '125.0.2'), -1);
});

check('very long numeric segments do not lose precision', () => {
  const big = '9007199254740993';
  const bigger = '9007199254740994';
  assert.strictEqual(v.compareVersions(`1.0.${big}`, `1.0.${bigger}`), -1,
    'Number() would round both of these to the same value');
  assert.strictEqual(v.compareVersions(`1.0.${bigger}`, `1.0.${big}`), 1);
  assert.strictEqual(v.compareVersions(`1.0.${big}`, `1.0.${big}`), 0);
});

check('leading zeros do not change the value', () => {
  assert.strictEqual(v.compareVersions('1.02.3', '1.2.3'), 0);
  assert.strictEqual(v.compareVersions('1.0.0', '1.0.00'), 0);
});

// ---- prerelease ----

check('a prerelease sorts below its release', () => {
  assert.strictEqual(v.compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.strictEqual(v.compareVersions('1.0.0', '1.0.0-beta'), 1);
  assert.strictEqual(v.compareVersions('125.0.6422.100-beta', '125.0.6422.100'), -1,
    'a four-segment build with a suffix is still a prerelease');
});

check('alphanumeric prerelease identifiers order lexically', () => {
  assert.strictEqual(v.compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.strictEqual(v.compareVersions('1.0.0-beta', '1.0.0-alpha'), 1);
});

check('numeric prerelease identifiers order numerically, not as text', () => {
  assert.strictEqual(v.compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  assert.strictEqual(v.compareVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1);
});

check('a numeric prerelease identifier sorts below an alphanumeric one', () => {
  assert.strictEqual(v.compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.strictEqual(v.compareVersions('1.0.0-alpha', '1.0.0-1'), 1);
});

check('a shorter prerelease list sorts below one that extends it', () => {
  assert.strictEqual(v.compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.strictEqual(v.compareVersions('1.0.0-alpha.1', '1.0.0-alpha'), 1);
});

check('identical prereleases are equal', () => {
  assert.strictEqual(v.compareVersions('1.0.0-rc.1', '1.0.0-rc.1'), 0);
  assert.strictEqual(v.compareVersions('1.0.0-alpha.beta', '1.0.0-alpha.beta'), 0);
});

// ---- normalisation ----

check('a leading v and surrounding space are ignored', () => {
  assert.strictEqual(v.compareVersions('v1.2.3', '1.2.3'), 0);
  assert.strictEqual(v.compareVersions('V1.2.3', '1.2.3'), 0);
  assert.strictEqual(v.compareVersions('  1.2.3  ', '1.2.3'), 0);
  assert.strictEqual(v.compareVersions('v2.0.0', '1.0.0'), 1);
});

check('build metadata carries no ordering', () => {
  assert.strictEqual(v.compareVersions('1.0.0+build1', '1.0.0+build2'), 0);
  assert.strictEqual(v.compareVersions('1.0.0', '1.0.0+build9'), 0);
  assert.strictEqual(v.compareVersions('1.0.0-rc+build9', '1.0.0-rc'), 0);
});

check('numbers are accepted as well as strings', () => {
  assert.strictEqual(v.compareVersions(2, '1.9.9'), 1);
  assert.strictEqual(v.compareVersions(2, 2), 0);
});

// ---- parsing ----

check('parseVersion separates numbers from the prerelease', () => {
  assert.deepStrictEqual(v.parseVersion('v125.0.6422.100-beta.2'), {
    numbers: ['125', '0', '6422', '100'],
    pre: ['beta', '2'],
    raw: 'v125.0.6422.100-beta.2',
  });
  assert.deepStrictEqual(v.parseVersion('1.2.3').pre, []);
});

check('unparseable values are reported as null', () => {
  for (const bad of ['', '   ', 'not-a-version', 'v', '.1.2', 'x.y.z', null, undefined, {}]) {
    assert.strictEqual(v.parseVersion(bad), null, `${JSON.stringify(bad)} should not parse`);
  }
});

check('comparing an unparseable value reports equality rather than throwing', () => {
  assert.strictEqual(v.compareVersions('not-a-version', '1.0.0'), 0);
  assert.strictEqual(v.compareVersions('1.0.0', null), 0);
  assert.strictEqual(v.isComparable('not-a-version', '1.0.0'), false);
  assert.strictEqual(v.isComparable('1.0.0', '2.0.0'), true);
});

// ---- convenience ----

check('isNewer accepts only a strictly newer, comparable candidate', () => {
  assert.strictEqual(v.isNewer('1.0.1', '1.0.0'), true);
  assert.strictEqual(v.isNewer('1.0.0', '1.0.0'), false);
  assert.strictEqual(v.isNewer('0.9.9', '1.0.0'), false);
  assert.strictEqual(v.isNewer('nonsense', '1.0.0'), false, 'an unreadable version never triggers an update');
  assert.strictEqual(v.isNewer('1.0.0', 'nonsense'), false);
});

check('isSameVersion ignores build metadata but not a real difference', () => {
  assert.strictEqual(v.isSameVersion('1.0.0+build1', '1.0.0+build2'), true);
  assert.strictEqual(v.isSameVersion('v1.0.0', '1.0.0'), true);
  assert.strictEqual(v.isSameVersion('1.0.0', '1.0.1'), false);
  assert.strictEqual(v.isSameVersion('nonsense', 'nonsense'), false, 'unreadable input is not "the same"');
});

check('highestVersion picks the greatest entry and keeps its original form', () => {
  assert.strictEqual(v.highestVersion(['1.2.0', '1.10.0', '1.9.9']), '1.10.0');
  assert.strictEqual(v.highestVersion(['v2.0.0', '1.9.9']), 'v2.0.0');
  assert.strictEqual(v.highestVersion(['1.0.0-rc.1', '1.0.0-rc.2']), '1.0.0-rc.2');
  assert.strictEqual(v.highestVersion(['1.0.0-beta', '1.0.0']), '1.0.0');
  assert.strictEqual(v.highestVersion(['garbage', '1.0.0']), '1.0.0');
  assert.strictEqual(v.highestVersion(['garbage']), null);
  assert.strictEqual(v.highestVersion([]), null);
  assert.strictEqual(v.highestVersion(null), null);
});

// ---- segment helper ----

check('compareNumericStrings handles length and leading zeros', () => {
  assert.strictEqual(v.compareNumericStrings('10', '9'), 1);
  assert.strictEqual(v.compareNumericStrings('9', '10'), -1);
  assert.strictEqual(v.compareNumericStrings('007', '7'), 0);
  assert.strictEqual(v.compareNumericStrings('0', '0'), 0);
  assert.strictEqual(v.compareNumericStrings('100', '099'), 1);
});

// ---- report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
console.log(`\nVERSION_COMPARE_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
if (failed.length) process.exitCode = 1;
