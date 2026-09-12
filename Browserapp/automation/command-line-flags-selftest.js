'use strict';

/** Self-test for command-line flag list utilities. */

const assert = require('assert');
const f = require('./command-line-flags');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

// ---- parsing ----

check('normalizeName strips the prefix and trailing equals', () => {
  assert.strictEqual(f.normalizeName('--disable-features'), 'disable-features');
  assert.strictEqual(f.normalizeName('disable-features='), 'disable-features');
  assert.strictEqual(f.normalizeName('--disable-features='), 'disable-features');
  assert.strictEqual(f.normalizeName(null), '');
});

check('parseFlag splits a valued flag', () => {
  assert.deepStrictEqual(f.parseFlag('--user-agent=Mozilla/5.0'), {
    name: 'user-agent', value: 'Mozilla/5.0', hasValue: true, raw: '--user-agent=Mozilla/5.0',
  });
});

check('parseFlag marks a valueless flag', () => {
  const parsed = f.parseFlag('--no-sandbox');
  assert.strictEqual(parsed.name, 'no-sandbox');
  assert.strictEqual(parsed.hasValue, false);
  assert.strictEqual(parsed.value, null);
});

check('parseFlag keeps an empty value distinct from no value', () => {
  const parsed = f.parseFlag('--flag=');
  assert.strictEqual(parsed.hasValue, true);
  assert.strictEqual(parsed.value, '');
});

check('escapeRegExp neutralises regex metacharacters', () => {
  assert.strictEqual(f.escapeRegExp('a.b*c'), 'a\\.b\\*c');
});

// ---- lookup ----

check('indexOfFlag finds a valued flag', () => {
  assert.strictEqual(f.indexOfFlag(['--a=1', '--disable-features=X'], '--disable-features'), 1);
});

check('indexOfFlag finds a valueless flag', () => {
  assert.strictEqual(f.indexOfFlag(['--no-sandbox'], 'no-sandbox'), 0);
});

check('indexOfFlag does not match a longer flag sharing the prefix', () => {
  const args = ['--disable-features-extended=1'];
  assert.strictEqual(f.indexOfFlag(args, '--disable-features'), -1, 'prefix similarity alone must not match');
});

check('indexOfFlag does not match a flag that merely contains the name', () => {
  assert.strictEqual(f.indexOfFlag(['--foo-disable-features=1'], 'disable-features'), -1);
});

check('indexOfFlag returns -1 for missing input', () => {
  assert.strictEqual(f.indexOfFlag([], 'x'), -1);
  assert.strictEqual(f.indexOfFlag(null, 'x'), -1);
  assert.strictEqual(f.indexOfFlag(['--x=1'], ''), -1);
});

check('getFlag returns the value or null', () => {
  assert.strictEqual(f.getFlag(['--a=1'], 'a'), '1');
  assert.strictEqual(f.getFlag(['--a'], 'a'), null, 'valueless flags have no value');
  assert.strictEqual(f.getFlag(['--b=1'], 'a'), null);
});

check('getFlag preserves a comma separated payload', () => {
  assert.strictEqual(f.getFlag(['--disable-features=A,B'], 'disable-features'), 'A,B');
});

check('hasFlag detects presence regardless of value', () => {
  assert.strictEqual(f.hasFlag(['--a'], 'a'), true);
  assert.strictEqual(f.hasFlag(['--a='], 'a'), true);
  assert.strictEqual(f.hasFlag([], 'a'), false);
});

// ---- set / remove ----

check('setFlag appends a new flag', () => {
  assert.deepStrictEqual(f.setFlag([], '--window-size', '800,600'), ['--window-size=800,600']);
});

check('setFlag replaces an existing flag in place', () => {
  const out = f.setFlag(['--a=1', '--b=2'], 'a', '9');
  assert.deepStrictEqual(out, ['--a=9', '--b=2'], 'position preserved');
});

check('setFlag collapses duplicate occurrences into one', () => {
  const out = f.setFlag(['--a=1', '--a=2'], 'a', '3');
  assert.deepStrictEqual(out, ['--a=3', '--a=2'], 'only the first occurrence is replaced');
  assert.strictEqual(f.flagNames(out).filter((n) => n === 'a').length, 2);
});

check('setFlag writes a valueless flag when no value is given', () => {
  assert.deepStrictEqual(f.setFlag([], '--no-sandbox'), ['--no-sandbox']);
  assert.deepStrictEqual(f.setFlag(['--a=1'], 'a', null), ['--a']);
});

check('setFlag does not mutate the input array', () => {
  const args = ['--a=1'];
  f.setFlag(args, 'a', '2');
  assert.deepStrictEqual(args, ['--a=1']);
});

check('removeFlag drops every occurrence', () => {
  assert.deepStrictEqual(f.removeFlag(['--a=1', '--b=2', '--a=3'], 'a'), ['--b=2']);
  assert.deepStrictEqual(f.removeFlag(['--no-sandbox'], 'no-sandbox'), []);
});

check('removeFlag leaves unrelated flags untouched', () => {
  const args = ['--disable-features-extended=1', '--disable-features=2'];
  assert.deepStrictEqual(f.removeFlag(args, 'disable-features'), ['--disable-features-extended=1']);
});

// ---- list value merging ----

check('appendFlagValue creates the flag when absent', () => {
  assert.deepStrictEqual(f.appendFlagValue([], '--disable-features', 'A'), ['--disable-features=A']);
});

check('appendFlagValue extends an existing list', () => {
  const out = f.appendFlagValue(['--disable-features=A'], 'disable-features', 'B');
  assert.deepStrictEqual(out, ['--disable-features=A,B']);
});

check('appendFlagValue de-duplicates entries', () => {
  const out = f.appendFlagValue(['--disable-features=A,B'], 'disable-features', 'B,C');
  assert.deepStrictEqual(out, ['--disable-features=A,B,C']);
});

check('appendFlagValue can prepend', () => {
  const out = f.appendFlagValue(['--enable-features=B'], 'enable-features', 'A', { insertBefore: true });
  assert.deepStrictEqual(out, ['--enable-features=A,B']);
});

check('appendFlagValue accepts a comma separated payload', () => {
  const out = f.appendFlagValue([], 'enable-features', 'A, B ,C');
  assert.deepStrictEqual(out, ['--enable-features=A,B,C']);
});

check('appendFlagValue ignores an empty payload', () => {
  assert.deepStrictEqual(f.appendFlagValue(['--x=1'], 'x', ''), ['--x=1']);
  assert.deepStrictEqual(f.appendFlagValue(['--x=1'], 'x', null), ['--x=1']);
});

check('appendFlagValue handles a valueless existing flag', () => {
  const out = f.appendFlagValue(['--disable-features'], 'disable-features', 'A');
  assert.deepStrictEqual(out, ['--disable-features=A']);
});

check('appendFlagValues merges several payloads at once', () => {
  const out = f.appendFlagValues([], 'enable-features', ['A', 'B,C']);
  assert.deepStrictEqual(out, ['--enable-features=A,B,C']);
});

check('appendFlagValues tolerates an empty list', () => {
  assert.deepStrictEqual(f.appendFlagValues(['--x=1'], 'x', []), ['--x=1']);
});

check('removeFlagValue drops selected entries only', () => {
  const out = f.removeFlagValue(['--disable-features=A,B,C'], 'disable-features', 'B');
  assert.deepStrictEqual(out, ['--disable-features=A,C']);
});

check('removeFlagValue deletes the flag when nothing remains', () => {
  const out = f.removeFlagValue(['--disable-features=A'], 'disable-features', 'A');
  assert.deepStrictEqual(out, []);
});

// ---- merge ----

check('mergeFlags keeps list values combined', () => {
  const out = f.mergeFlags(['--disable-features=A'], ['--disable-features=B'], { listFlags: ['disable-features'] });
  assert.deepStrictEqual(out, ['--disable-features=A,B']);
});

check('mergeFlags keeps the target scalar and drops the duplicate', () => {
  const out = f.mergeFlags(['--user-agent=first'], ['--user-agent=second']);
  assert.deepStrictEqual(out, ['--user-agent=first'], 'first occurrence wins by default');
});

check('mergeFlags overwrites a scalar when asked', () => {
  const out = f.mergeFlags(['--user-agent=first'], ['--user-agent=second'], { overwrite: true });
  assert.deepStrictEqual(out, ['--user-agent=second']);
});

check('mergeFlags appends new flags from the source', () => {
  const out = f.mergeFlags(['--a=1'], ['--b=2', '--c']);
  assert.deepStrictEqual(out, ['--a=1', '--b=2', '--c']);
});

check('mergeFlags handles empty inputs', () => {
  assert.deepStrictEqual(f.mergeFlags([], ['--a=1']), ['--a=1']);
  assert.deepStrictEqual(f.mergeFlags(['--a=1'], []), ['--a=1']);
  assert.deepStrictEqual(f.mergeFlags(null, null), []);
});

check('mergeFlags skips empty entries in the source', () => {
  assert.deepStrictEqual(f.mergeFlags(['--a=1'], ['', null, undefined, '--b=2']), ['--a=1', '--b=2']);
});

check('mergeFlags does not mutate either input', () => {
  const target = ['--disable-features=A'];
  const source = ['--disable-features=B'];
  f.mergeFlags(target, source, { listFlags: ['disable-features'] });
  assert.deepStrictEqual(target, ['--disable-features=A']);
  assert.deepStrictEqual(source, ['--disable-features=B']);
});

check('mergeFlags carries non-flag entries through unchanged', () => {
  const out = f.mergeFlags(['--a=1'], ['about:blank', '--b=2']);
  assert.deepStrictEqual(out, ['--a=1', 'about:blank', '--b=2'], 'positional arguments are preserved verbatim');
});

// ---- introspection ----

check('flagNames lists flags in order, ignoring positionals', () => {
  assert.deepStrictEqual(f.flagNames(['--a=1', 'file.txt', '--b', '-x']), ['a', 'b']);
});

check('findDuplicates reports repeated flags', () => {
  const dupes = f.findDuplicates(['--x=1', '--x=2', '--y', '--y', '--z']);
  assert.deepStrictEqual(dupes, [{ name: 'x', count: 2 }, { name: 'y', count: 2 }]);
});

check('findDuplicates returns nothing for a clean list', () => {
  assert.deepStrictEqual(f.findDuplicates(['--a=1', '--b=2']), []);
});

// ---- the scenario this module exists for ----

check('repeated feature extension never produces a duplicate flag', () => {
  // Three independent contributors each extend the same list flag.
  let args = [];
  args = f.appendFlagValue(args, '--disable-features', 'AutomationControlled');
  args = f.appendFlagValue(args, '--disable-features', 'SafetyCheckExtensions');
  args = f.appendFlagValue(args, '--disable-features', 'SafetyCheckExtensions,Translate');

  assert.strictEqual(args.length, 1, 'one flag, not three');
  assert.strictEqual(args[0], '--disable-features=AutomationControlled,SafetyCheckExtensions,Translate');
  assert.deepStrictEqual(f.findDuplicates(args), []);
});

// ---- integration: browser launch argument assembly ----

check('fingerprint flags merge into a browser base list without losing either side', () => {
  const { chromeArgsForFingerprint } = require('./fingerprint');
  const base = [
    '--no-first-run',
    '--enable-features=AutomaticFullscreenContentSetting,WindowPlacement,WindowManagement',
    '--remote-debugging-port=0',
  ];
  const merged = f.mergeFlags(
    base,
    chromeArgsForFingerprint(
      { uaProfile: { chromeMajor: 131, os: 'windows' }, userAgent: 'UA', screen: { width: 1920, height: 1080 } },
      {},
    ),
    { listFlags: f.LIST_VALUE_FLAGS },
  );

  const enableFeatures = merged.filter((a) => a.startsWith('--enable-features='));
  assert.strictEqual(enableFeatures.length, 1, 'list flags must not be duplicated');
  for (const kept of ['AutomaticFullscreenContentSetting', 'WindowPlacement', 'WindowManagement', 'PermuteTLSExtensions']) {
    assert.ok(enableFeatures[0].includes(kept), `${kept} should survive the merge`);
  }
  assert.strictEqual(
    enableFeatures[0].split('=')[1].split(',').length,
    new Set(enableFeatures[0].split('=')[1].split(',')).size,
    'no feature name is repeated',
  );
  assert.ok(merged.includes('--no-first-run'), 'base scalars are kept');
  assert.ok(merged.includes('--remote-debugging-port=0'), 'base scalars are kept');
  assert.ok(merged.some((a) => a.startsWith('--window-size=')), 'fingerprint scalars are added');
});

check('list value flags are declared once and cover both feature switches', () => {
  assert.deepStrictEqual([...f.LIST_VALUE_FLAGS], ['enable-features', 'disable-features']);
  assert.ok(Object.isFrozen(f.LIST_VALUE_FLAGS), 'the constant must not be mutable at runtime');
});

check('appending disabled features does not repeat what is already declared', () => {
  const base = ['--disable-features=OldThing'];
  const once = f.appendFlagValue(base, 'disable-features', ['OldThing', 'NewThing'].join(','));
  assert.deepStrictEqual(once, ['--disable-features=OldThing,NewThing']);
  const twice = f.appendFlagValue(once, 'disable-features', ['NewThing', 'Third'].join(','));
  assert.deepStrictEqual(twice, ['--disable-features=OldThing,NewThing,Third']);
});

// ---- report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
console.log(`\nCOMMAND_LINE_FLAGS_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
if (failed.length) process.exitCode = 1;
