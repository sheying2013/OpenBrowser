'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  NATIVE_MANAGED_PREFERENCE_KEYS,
  languagePreferenceChain,
  expectedLanguagePreferences,
  applyLanguagePreferences,
  verifyLanguagePreferences,
  syncProfileLanguagePreferences,
} = require('./profile-file-consistency');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.message || String(error) }); }
}

(async () => {
  await check('language chain matches native preference format', async () => {
    assert.strictEqual(languagePreferenceChain('ja-JP'), 'ja-JP,ja');
    assert.strictEqual(languagePreferenceChain('en-US'), 'en-US,en');
    assert.strictEqual(languagePreferenceChain('ja-JP,ja'), 'ja-JP,ja');
    assert.strictEqual(languagePreferenceChain('zh-Hans-CN'), 'zh-Hans-CN,zh');
  });

  await check('language sync preserves native-managed preference groups', async () => {
    const prefs = {
      intl: { accept_languages: 'en-US,en', selected_languages: 'en-US,en' },
      spellcheck: { dictionaries: ['en-US'], use_spelling_service: false },
      safebrowsing: { enabled: false, enhanced: false },
      autofill: { profile_enabled: true, credit_card_enabled: true },
      translate: { enabled: true },
      download: { default_directory: '/tmp/downloads' },
    };
    const snapshot = JSON.parse(JSON.stringify(prefs));
    applyLanguagePreferences(prefs, { language: 'ja-JP' });
    assert.deepStrictEqual(prefs.spellcheck, snapshot.spellcheck);
    assert.deepStrictEqual(prefs.safebrowsing, snapshot.safebrowsing);
    assert.deepStrictEqual(prefs.autofill, snapshot.autofill);
    assert.deepStrictEqual(prefs.translate, snapshot.translate);
    assert.deepStrictEqual(prefs.download, snapshot.download);
    assert.strictEqual(prefs.intl.accept_languages, 'ja-JP,ja');
    assert.strictEqual(prefs.intl.selected_languages, 'ja-JP,ja');
  });

  await check('verification reports both language paths when they drift', async () => {
    const prefs = { intl: { accept_languages: 'en-US,en', selected_languages: 'en-US' } };
    const issues = verifyLanguagePreferences(prefs, { language: 'ja-JP' });
    assert.strictEqual(issues.length, 2);
    assert.deepStrictEqual(issues.map((item) => item.key).sort(), ['intl.accept_languages', 'intl.selected_languages']);
  });

  await check('syncProfileLanguagePreferences writes and reads back the same chain', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'profile-language-'));
    try {
      await fsp.mkdir(path.join(root, 'Default'), { recursive: true });
      await fsp.writeFile(path.join(root, 'Default', 'Preferences'), JSON.stringify({
        spellcheck: { dictionaries: ['en-US'] },
      }), 'utf8');
      const report = await syncProfileLanguagePreferences(root, { language: 'ko-KR' });
      assert.strictEqual(report.expected.intl.accept_languages, 'ko-KR,ko');
      const prefs = JSON.parse(await fsp.readFile(path.join(root, 'Default', 'Preferences'), 'utf8'));
      assert.strictEqual(prefs.intl.accept_languages, 'ko-KR,ko');
      assert.strictEqual(prefs.intl.selected_languages, 'ko-KR,ko');
      assert.deepStrictEqual(prefs.spellcheck.dictionaries, ['en-US']);
    } finally {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  await check('the policy keeps native-owned keys out of the writer', async () => {
    assert.ok(NATIVE_MANAGED_PREFERENCE_KEYS.includes('spellcheck.dictionaries'));
    assert.ok(NATIVE_MANAGED_PREFERENCE_KEYS.includes('safebrowsing.enabled'));
    assert.ok(NATIVE_MANAGED_PREFERENCE_KEYS.includes('autofill.profile_enabled'));
    assert.ok(NATIVE_MANAGED_PREFERENCE_KEYS.includes('translate.enabled'));
    assert.ok(NATIVE_MANAGED_PREFERENCE_KEYS.includes('download.default_directory'));
  });

  const failed = results.filter((item) => !item.ok);
  for (const item of results) {
    if (item.ok) console.log('  PASS  ' + item.name);
    else console.error('  FAIL  ' + item.name + ': ' + item.error);
  }
  if (failed.length) {
    console.error(`profile-file-consistency-selftest: FAIL ${results.length - failed.length}/${results.length}`);
    process.exitCode = 1;
  } else {
    console.log(`profile-file-consistency-selftest: OK ${results.length}/${results.length}`);
  }
})();
