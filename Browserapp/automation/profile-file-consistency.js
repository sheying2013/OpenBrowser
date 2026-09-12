'use strict';

/**
 * Keep the profile language surface aligned across the file layer.
 *
 * The browser owns several preference groups and rewrites them asynchronously
 * (for example spellcheck dictionaries). Only the language chain is written
 * here; every other group is preserved verbatim so a native preference and
 * a CDP/JS override cannot drift apart.
 */

const fsp = require('fs/promises');
const path = require('path');
const { writeRawAtomically } = require('../engine/state-storage');

const MANAGED_PREFERENCE_KEYS = Object.freeze([
  'intl.accept_languages',
  'intl.selected_languages',
]);

// These groups are intentionally left to the browser. Writing guessed values for
// them creates a difference between the file and the native preference layer.
const NATIVE_MANAGED_PREFERENCE_KEYS = Object.freeze([
  'spellcheck.dictionaries',
  'safebrowsing.enabled',
  'safebrowsing.enhanced',
  'safebrowsing.scout_reporting_enabled',
  'safebrowsing.metrics_reporting_enabled',
  'autofill.profile_enabled',
  'autofill.credit_card_enabled',
  'autofill.address_autofill_enabled',
  'translate.enabled',
  'download.default_directory',
]);

function languagePreferenceChain(language) {
  const parts = String(language || 'en-US')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const primary = parts[0] || 'en-US';
  const base = primary.split('-')[0];
  const chain = [primary];
  if (base && base.toLowerCase() !== primary.toLowerCase()) chain.push(base);
  for (const item of parts.slice(1)) {
    if (!chain.some((value) => value.toLowerCase() === item.toLowerCase())) chain.push(item);
  }
  return chain.join(',');
}

function expectedLanguagePreferences(profile = {}) {
  const acceptLanguages = languagePreferenceChain(profile.language);
  return {
    intl: {
      accept_languages: acceptLanguages,
      selected_languages: acceptLanguages,
    },
  };
}

function applyLanguagePreferences(prefs, profile = {}) {
  const expected = expectedLanguagePreferences(profile);
  prefs.intl ||= {};
  prefs.intl.accept_languages = expected.intl.accept_languages;
  prefs.intl.selected_languages = expected.intl.selected_languages;
  return expected;
}

function verifyLanguagePreferences(prefs, profile = {}) {
  const expected = expectedLanguagePreferences(profile);
  const issues = [];
  for (const key of MANAGED_PREFERENCE_KEYS) {
    const [, leaf] = key.split('.');
    const actual = prefs?.intl?.[leaf];
    const wanted = expected.intl[leaf];
    if (actual !== wanted) issues.push({ key, expected: wanted, actual: actual ?? null });
  }
  return issues;
}

async function readPreferences(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function syncProfileLanguagePreferences(root, profile = {}) {
  const file = path.join(root, 'Default', 'Preferences');
  const prefs = await readPreferences(file);
  const expected = applyLanguagePreferences(prefs, profile);
  await writeRawAtomically(file, JSON.stringify(prefs), 0o600);
  const persisted = await readPreferences(file);
  const issues = verifyLanguagePreferences(persisted, profile);
  if (issues.length) {
    const error = new Error('Profile language preference readback mismatch');
    error.code = 'PROFILE_LANGUAGE_MISMATCH';
    error.issues = issues;
    throw error;
  }
  return { file, expected, issues };
}

module.exports = {
  MANAGED_PREFERENCE_KEYS,
  NATIVE_MANAGED_PREFERENCE_KEYS,
  languagePreferenceChain,
  expectedLanguagePreferences,
  applyLanguagePreferences,
  verifyLanguagePreferences,
  syncProfileLanguagePreferences,
};
