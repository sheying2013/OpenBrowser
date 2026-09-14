'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  MANAGED_LOCAL_STATE_KEYS,
  primaryProfileLocale,
  expectedLocalState,
  applyLocalStateLanguage,
  verifyLocalStateLanguage,
  syncProfileLocalState,
} = require('./profile-file-consistency');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message || String(error) });
  }
}

(async () => {
  await check('primaryProfileLocale extracts single primary locale', async () => {
    assert.strictEqual(primaryProfileLocale('ja-JP,ja'), 'ja-JP');
    assert.strictEqual(primaryProfileLocale('zh-CN,zh;q=0.9'), 'zh-CN');
    assert.strictEqual(primaryProfileLocale('en-US'), 'en-US');
    assert.strictEqual(primaryProfileLocale(''), 'en-US');
    assert.strictEqual(primaryProfileLocale(null), 'en-US');
  });

  await check('expectedLocalState formats intl.app_locale correctly', async () => {
    assert.deepStrictEqual(expectedLocalState({ language: 'fr-FR' }), {
      intl: { app_locale: 'fr-FR' },
    });
  });

  await check('syncProfileLocalState writes intl.app_locale and preserves existing keys', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'local-state-'));
    try {
      const existingState = {
        browser: { enabled_labs_experiments: ['test@1'] },
        intl: { some_other_intl_key: 'preserved' },
      };
      await fsp.writeFile(path.join(root, 'Local State'), JSON.stringify(existingState), 'utf8');

      const res = await syncProfileLocalState(root, { language: 'de-DE,de' });
      assert.strictEqual(res.expected.intl.app_locale, 'de-DE');

      const persisted = JSON.parse(await fsp.readFile(path.join(root, 'Local State'), 'utf8'));
      assert.strictEqual(persisted.intl.app_locale, 'de-DE');
      assert.strictEqual(persisted.intl.some_other_intl_key, 'preserved');
      assert.deepStrictEqual(persisted.browser.enabled_labs_experiments, ['test@1']);
    } finally {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  await check('syncProfileLocalState creates Local State if not existing', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'local-state-new-'));
    try {
      const res = await syncProfileLocalState(root, { language: 'ja-JP' });
      assert.strictEqual(res.expected.intl.app_locale, 'ja-JP');

      const persisted = JSON.parse(await fsp.readFile(path.join(root, 'Local State'), 'utf8'));
      assert.strictEqual(persisted.intl.app_locale, 'ja-JP');
    } finally {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  await check('verifyLocalStateLanguage catches drift and reports issues', async () => {
    const state = { intl: { app_locale: 'en-US' } };
    const issues = verifyLocalStateLanguage(state, { language: 'zh-CN' });
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].key, 'intl.app_locale');
    assert.strictEqual(issues[0].expected, 'zh-CN');
    assert.strictEqual(issues[0].actual, 'en-US');
  });

  const failed = results.filter((item) => !item.ok);
  for (const item of results) {
    if (item.ok) console.log('  PASS  ' + item.name);
    else console.error('  FAIL  ' + item.name + ': ' + item.error);
  }
  if (failed.length) {
    console.error("profile-local-state-selftest: FAIL " + (results.length - failed.length) + "/" + results.length);
    process.exitCode = 1;
  } else {
    console.log("profile-local-state-selftest: OK " + results.length + "/" + results.length);
  }
})();
