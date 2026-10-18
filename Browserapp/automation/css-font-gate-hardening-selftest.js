#!/usr/bin/env node
'use strict';

/**
 * Regression selftest for two CSS font-gate defects reported in issue #36.
 *
 * 1. Pathological-input cost: the gate used to run
 *    /@font-face(?:\\s|\\/\\*[\\s\\S]*?\\*\\/)*\\{([^{}]*)\\}/gi and the local() rule over
 *    page-controlled CSS. Twenty-eight balanced comments after the at-rule name stalled the first
 *    for seconds and an unterminated local( made the second quadratic. Both rewrites are now
 *    linear scanners; this file feeds them the exact adversarial shapes and asserts wall time.
 *
 * 2. Subset shadowing: on a host that already ships the persona family, appending the trimmed
 *    subset payload to @font-face src shadowed the complete system font and every missing glyph
 *    fell back on its own, mixing typefaces inside one run of text. The generator now decides
 *    from (persona platform, host platform) whether the payload may be appended, and never lets
 *    a caller force a subset over a host font.
 *
 * The scanners are extracted from the real generator source by marker so this test always runs
 * the shipped implementation instead of a copy.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const gatePath = path.join(__dirname, 'css-font-local-gate.js');
const gateSource = fs.readFileSync(gatePath, 'utf8');
const { buildCssFontLocalGateSource } = require('./css-font-local-gate');

const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
    console.log('  PASS  ' + name + (detail ? ' - ' + detail : ''));
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    console.log('  FAIL  ' + name + ' - ' + error.message);
    process.exitCode = 1;
  }
};

const SPAN_START = '  function isCssSpaceChar(ch) {';
const SPAN_END = '  const isStyleElement = (el) => {';
const spanStart = gateSource.indexOf(SPAN_START);
const spanEnd = gateSource.indexOf(SPAN_END);
assert.ok(spanStart !== -1 && spanEnd > spanStart, 'scanner span markers must exist in css-font-local-gate.js');
const scannerSource = gateSource.slice(spanStart, spanEnd);

const buildScanners = ({ allowed, subsets, blocked, inject }) => {
  const preamble = [
    'const allowedFamilies = new Set(' + JSON.stringify(allowed) + ');',
    'const fontSubsets = ' + JSON.stringify(subsets || {}) + ';',
    'const BLOCKED_FONT = ' + JSON.stringify(blocked || 'BlockedFamily') + ';',
    'const injectSubsets = ' + (inject ? 'true' : 'false') + ';',
    'const rawToCleanBlobUrl = new Map();',
    'const sanitizeDataUri = (value) => value;',
  ].join('\n');
  const postamble = 'return { sanitizeCss, sanitizeSrcValue, mapFontFaceBlocks, rewriteLocalTokens };';
  // eslint-disable-next-line no-new-func
  return new Function(preamble + '\n' + scannerSource + '\n' + postamble)();
};

const SUBSET_B64 = 'AAAA' + 'B'.repeat(64);

const scannersWithSubset = buildScanners({
  allowed: ['segoe ui', 'simsun'],
  subsets: { 'segoe ui': { format: 'font/woff2', base64: SUBSET_B64 } },
  blocked: 'BlockedFamily',
  inject: true,
});
const scannersNoSubset = buildScanners({
  allowed: ['segoe ui', 'simsun'],
  subsets: { 'segoe ui': { format: 'font/woff2', base64: SUBSET_B64 } },
  blocked: 'BlockedFamily',
  inject: false,
});

const timed = (fn) => {
  const started = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { value, ms };
};

check('comment flood after @font-face stays linear', () => {
  const input = '@font-face' + '/* comment */'.repeat(28) + ';';
  const { ms, value } = timed(() => scannersWithSubset.sanitizeCss(input));
  assert.strictEqual(value, input, 'ill-formed at-rule must pass through unchanged');
  assert.ok(ms < 250, 'expected < 250ms, took ' + ms.toFixed(1) + 'ms');
  return ms.toFixed(2) + 'ms';
});

check('unterminated local( stays linear', () => {
  const input = '@font-face { font-family: x; src: local("' + 'a'.repeat(200000);
  const { ms } = timed(() => scannersWithSubset.sanitizeCss(input));
  assert.ok(ms < 250, 'expected < 250ms, took ' + ms.toFixed(1) + 'ms');
  return ms.toFixed(2) + 'ms';
});

check('many at-rule heads stay linear', () => {
  const input = '@font-face{src:local("' + 'a'.repeat(4096) + '"}' + '@font-face url('.repeat(4000);
  const { ms } = timed(() => scannersWithSubset.sanitizeCss(input));
  assert.ok(ms < 500, 'expected < 500ms, took ' + ms.toFixed(1) + 'ms');
  return ms.toFixed(2) + 'ms';
});

check('host font keeps its own local() when subsets are disabled', () => {
  const input = '@font-face { font-family: Body; src: local("SimSun"); }';
  const out = scannersNoSubset.sanitizeCss(input);
  assert.strictEqual(out, input);
  assert.ok(!out.includes('data:'), 'no subset payload may be appended');
});

check('cross-platform persona still receives the subset payload', () => {
  const input = '@font-face { font-family: Body; src: local("Segoe UI"), format("woff2"); }';
  const out = scannersWithSubset.sanitizeCss(input);
  assert.ok(out.includes('local("segoe ui")'), 'local() must stay first: ' + out);
  assert.ok(out.includes('url("data:font/woff2;base64,' + SUBSET_B64 + '")'), 'subset payload appended: ' + out);
});

check('foreign family is still rewritten to the placeholder', () => {
  const out = scannersNoSubset.sanitizeCss('@font-face { font-family: Other; src: local("Comic Sans MS"); }');
  assert.ok(out.includes('local("BlockedFamily")'), out);
});

check('prefix bytes and surrounding CSS are preserved verbatim', () => {
  const input = 'a{color:red}@font-face /* x */ { font-family: Body; src: local("Comic Sans MS"); }b{color:blue}';
  const out = scannersNoSubset.sanitizeCss(input);
  assert.ok(out.startsWith('a{color:red}@font-face /* x */ {'), out);
  assert.ok(out.endsWith('}b{color:blue}'), out);
  assert.ok(out.includes('local("BlockedFamily")'), out);
});

check('braces inside quoted strings do not end the block early', () => {
  const input = '@font-face { font-family: "A}B"; src: local("Comic Sans MS"); }';
  const out = scannersNoSubset.sanitizeCss(input);
  assert.ok(out.includes('local("BlockedFamily")'), out);
  assert.ok(out.startsWith('@font-face { font-family: "A}B";'), out);
});

check('unterminated block leaves the stylesheet untouched', () => {
  const input = '@font-face { font-family: Body; src: local("Comic Sans MS"); ';
  assert.strictEqual(scannersNoSubset.sanitizeCss(input), input);
});

check('sanitizeSrcValue reuses the same linear local() scanner', () => {
  const out = scannersNoSubset.sanitizeSrcValue('local( Comic Sans MS ) format("woff2")');
  assert.strictEqual(out, 'local("BlockedFamily") format("woff2")');
  const kept = scannersNoSubset.sanitizeSrcValue('local("SimSun")');
  assert.strictEqual(kept, 'local("SimSun")');
});

const generate = (options) => buildCssFontLocalGateSource(
  ['Segoe UI', 'SimSun'],
  [{ family: 'Segoe UI', format: 'font/woff2', base64: SUBSET_B64 }],
  options,
);

const readInjectionFlag = (script) => {
  const match = /const injectSubsets = (true|false);/.exec(script);
  assert.ok(match, 'generated source must declare injectSubsets');
  return match[1] === 'true';
};

check('windows persona on a windows host never appends subsets', () => {
  const script = generate({ platform: 'windows', hostPlatform: 'win32' });
  assert.strictEqual(readInjectionFlag(script), false);
  assert.ok(!script.includes(SUBSET_B64), 'payload bytes must not be embedded');
});

check('windows persona on a macOS host keeps subsets for missing families', () => {
  const script = generate({ platform: 'windows', hostPlatform: 'darwin' });
  assert.strictEqual(readInjectionFlag(script), true);
  assert.ok(script.includes(SUBSET_B64));
});

check('macOS persona on a macOS host never appends subsets', () => {
  const script = generate({ platform: 'macos', hostPlatform: 'darwin' });
  assert.strictEqual(readInjectionFlag(script), false);
});

check('a caller cannot force a subset over a host font', () => {
  const script = generate({ platform: 'windows', hostPlatform: 'win32', injectSubsets: true });
  assert.strictEqual(readInjectionFlag(script), false);
});

check('no host platform keeps the previous cross-platform default', () => {
  const script = generate({ platform: 'windows' });
  assert.strictEqual(readInjectionFlag(script), true);
});

const failed = results.filter((item) => !item.ok);
console.log('');
console.log('css-font-gate-hardening: ' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exitCode = failed.length === 0 ? 0 : 1;
