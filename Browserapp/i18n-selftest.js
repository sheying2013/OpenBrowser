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
console.log('i18n-selftest: OK');
