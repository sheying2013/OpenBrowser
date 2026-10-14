'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const engine = require('./locale-from-country');
const source = fs.readFileSync(path.join(__dirname, 'locale-from-country.js'), 'utf8');
const context = vm.createContext({ Intl });
vm.runInContext(source, context, { filename: 'locale-from-country.js' });
const browser = context.OpenBrowserLocale;
assert.ok(browser, 'browser API export');
assert.equal(context.resolveProfileLanguage, undefined, 'helpers do not leak into global scope');
assert.deepEqual(Object.keys(browser).sort(), Object.keys(engine).sort());
for (const [country, locale] of Object.entries(engine.COUNTRY_TO_LOCALE)) {
  const code = ' ' + country.toLowerCase() + ' ';
  assert.equal(browser.localeFromCountryCode(code), locale);
  const profile = { language: 'ja-JP', privacy: { languageMode: 'ip' } };
  assert.equal(browser.resolveProfileLanguage(profile, { countryCode: code }), engine.resolveProfileLanguage(profile, { countryCode: code }));
}
for (const [country, zone] of Object.entries(engine.COUNTRY_TO_TIMEZONE)) {
  assert.equal(browser.timezoneFromCountryCode(country), zone);
  const profile = { privacy: { timezoneMode: 'ip' } };
  assert.equal(browser.resolveProfileTimezone(profile, { countryCode: country }), engine.resolveProfileTimezone(profile, { countryCode: country }));
}
for (const mode of ['ip', 'system', 'fr-FR', 'zh-CN', 'invalid']) {
  const profile = { language: 'ja-JP', privacy: { languageMode: mode } };
  assert.equal(browser.resolveProfileLanguage(profile, { countryCode: 'ZZ' }), engine.resolveProfileLanguage(profile, { countryCode: 'ZZ' }));
}
const commonJsContext = vm.createContext({ Intl, module: { exports: {} } });
vm.runInContext(source, commonJsContext);
assert.equal(commonJsContext.OpenBrowserLocale, undefined, 'CommonJS exports do not attach browser globals');
assert.equal(commonJsContext.module.exports.localeFromCountryCode(' de '), 'de-DE');
console.log('locale-bridge-selftest: OK countries=' + Object.keys(engine.COUNTRY_TO_LOCALE).length + ' timezones=' + Object.keys(engine.COUNTRY_TO_TIMEZONE).length + ' browser-commonjs-parity=1');
