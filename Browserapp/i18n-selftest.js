'use strict';

/**
 * Node selftest for UI i18n catalogs + exit-IP locale mapping.
 * Run: node i18n-selftest.js
 */
global.localStorage = {
  store: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
  setItem(k, v) { this.store[k] = String(v); },
};

const I = require('./i18n.js');
const { resolveProfileLanguage, localeFromCountryCode } = require('./automation/locale-from-country');
const fs = require('fs');
const path = require('path');
const EnvironmentAudit = require('./environment-audit.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const cases = [
  ['en', 'nav.profiles', 'Profiles'],
  ['zh-CN', 'nav.profiles', '环境管理'],
  ['ja', 'nav.system', 'ローカル設定'],
  ['vi', 'common.save', 'Lưu'],
  ['fr', 'common.cancel', 'Annuler'],
  ['de', 'common.start', 'Starten'],
  ['th', 'common.save', 'บันทึก'],
  ['id', 'common.save', 'Simpan'],
];

for (const [code, key, expect] of cases) {
  I.setPreference(code, { persist: false, silent: true });
  assert(I.t(key) === expect, `${code} ${key} => ${I.t(key)}`);
}

assert(I.SUPPORTED.some((x) => x.code === 'system'), 'system option missing');
for (const v of ['en-US', 'zh-CN', 'ja-JP', 'vi-VN', 'fr-FR', 'de-DE', 'th-TH', 'id-ID']) {
  assert(I.BROWSER_LOCALES.some((x) => x.value === v), `browser locale ${v}`);
}

const pairs = [
  ['JP', 'ja-JP'], ['VN', 'vi-VN'], ['TH', 'th-TH'], ['ID', 'id-ID'],
  ['FR', 'fr-FR'], ['DE', 'de-DE'], ['US', 'en-US'], ['CN', 'zh-CN'],
];
for (const [cc, loc] of pairs) {
  assert(localeFromCountryCode(cc) === loc, `country ${cc}`);
  assert(
    resolveProfileLanguage({ privacy: { languageMode: 'ip' } }, { countryCode: cc }) === loc,
    `resolve ${cc}`
  );
}

assert(resolveProfileLanguage({ privacy: { languageMode: 'zh-CN' } }, {}) === 'zh-CN');

// Dynamic UI strings often originate in renderer callbacks rather than declarative
// data-i18n nodes. They must never leave Chinese behind after switching language.
const runtimeSourceFiles = [
  'renderer.js',
  'ui/ui-rpa.js',
  'ui/ui-dialogs.js',
  'ui/ui-api-mcp.js',
  'ui/ui-kernel.js',
  'ui/ui-cloud.js',
  'environment-audit.js',
];
const runtimeChinese = new Set();
for (const file of runtimeSourceFiles) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  for (const match of source.matchAll(/(['"`])([^'"`\n]*[\u3400-\u9fff][^'"`\n]*)\1/g)) {
    const value = match[2].trim();
    if (value) runtimeChinese.add(value);
  }
}

const staticChinese = new Set();
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
for (const match of indexHtml.matchAll(/>([^<>]*[\u3400-\u9fff][^<>]*)</g)) {
  const value = match[1].replace(/\s+/g, ' ').trim();
  if (value) staticChinese.add(value);
}
for (const match of indexHtml.matchAll(/(?:placeholder|title|aria-label)="([^"]*[\u3400-\u9fff][^"]*)"/g)) {
  const value = match[1].trim();
  if (value) staticChinese.add(value);
}

for (const locale of ['en', 'ja', 'vi', 'fr', 'de', 'th', 'id']) {
  I.setPreference(locale, { persist: false, silent: true });
  // Japanese legitimately uses Kanji, so compare against the original source text
  // rather than rejecting Han code points outright.
  const unchangedJapanese = locale === 'ja' ? new Set(['操作', '保存']) : new Set();
  const leaks = [...runtimeChinese].filter((value) => (
    I.translateChineseUiText(value) === value && !unchangedJapanese.has(value)
  ));
  assert(leaks.length === 0, `${locale} runtime Chinese leaks: ${leaks.join(' | ')}`);
  const staticLeaks = [...staticChinese].filter((value) => (
    I.translateChineseUiText(value) === value && !unchangedJapanese.has(value)
  ));
  assert(staticLeaks.length === 0, `${locale} static Chinese leaks: ${staticLeaks.join(' | ')}`);
}

for (const locale of ['ja', 'vi', 'fr', 'de', 'th', 'id']) {
  I.setPreference(locale, { persist: false, silent: true });
  assert(
    I.translateChineseUiText('运行中') === I.t('status.running'),
    `${locale} dynamic catalog lookup should use the locale-specific running label`
  );
}

// Template literals in the environment audit contain nested expressions, so source
// scanning cannot reliably reconstruct their final text. Exercise real reports too.
I.setPreference('en', { persist: false, silent: true });
const auditSamples = [
  { id: 'direct', name: 'Direct', proxy: 'Direct', privacy: { timezoneMode: 'real', geoMode: 'disabled', webrtc: 'proxy' }, advanced: {} },
  { id: 'proxy', name: 'Proxy', proxy: 'socks5://127.0.0.1:1080', exitIp: '203.0.113.7', exitCountryCode: 'US', exitTimezone: 'America/New_York', privacy: { timezoneMode: 'ip', geoMode: 'ip', webrtc: 'real', canvas: 'blocked', webgl: 'blocked', webgpu: 'blocked', media: 'blocked' }, advanced: {} },
  { id: 'custom', name: 'Custom', os: 'macOS', proxy: 'socks5://127.0.0.1:1080', privacy: { timezoneMode: 'custom', geoMode: 'custom', webrtc: 'proxy', timezone: '', latitude: null, longitude: null }, advanced: { saveHistory: false } },
];
for (const sample of auditSamples) {
  const report = EnvironmentAudit.build(sample, { systemTimezone: 'UTC' });
  for (const check of report.checks) {
    const output = `${I.translateChineseUiText(check.label)} ${I.translateChineseUiText(check.detail)}`;
    assert(!/[\u3400-\u9fff]/.test(output), `environment audit English leak: ${output}`);
  }
}

console.log('i18n-selftest: OK');
