'use strict';

/**
 * Map ISO 3166-1 alpha-2 country codes → BCP47 browser locale.
 * Used when language mode is "based on exit IP".
 */
const COUNTRY_TO_LOCALE = {
  JP: 'ja-JP',
  CN: 'zh-CN',
  TW: 'zh-TW',
  HK: 'zh-HK',
  MO: 'zh-MO',
  SG: 'en-SG',
  US: 'en-US',
  GB: 'en-GB',
  AU: 'en-AU',
  CA: 'en-CA',
  NZ: 'en-NZ',
  IE: 'en-IE',
  IN: 'en-IN',
  PH: 'en-PH',
  KR: 'ko-KR',
  DE: 'de-DE',
  AT: 'de-AT',
  CH: 'de-CH',
  FR: 'fr-FR',
  BE: 'fr-BE',
  ES: 'es-ES',
  MX: 'es-MX',
  AR: 'es-AR',
  CL: 'es-CL',
  CO: 'es-CO',
  PE: 'es-PE',
  PT: 'pt-PT',
  BR: 'pt-BR',
  RU: 'ru-RU',
  UA: 'uk-UA',
  PL: 'pl-PL',
  NL: 'nl-NL',
  IT: 'it-IT',
  SE: 'sv-SE',
  NO: 'nb-NO',
  DK: 'da-DK',
  FI: 'fi-FI',
  TR: 'tr-TR',
  SA: 'ar-SA',
  AE: 'ar-AE',
  EG: 'ar-EG',
  IL: 'he-IL',
  TH: 'th-TH',
  VN: 'vi-VN',
  ID: 'id-ID',
  MY: 'ms-MY',
  CZ: 'cs-CZ',
  RO: 'ro-RO',
  HU: 'hu-HU',
  GR: 'el-GR',
  BG: 'bg-BG',
  HR: 'hr-HR',
  SK: 'sk-SK',
  SI: 'sl-SI',
  RS: 'sr-RS',
  LT: 'lt-LT',
  LV: 'lv-LV',
  EE: 'et-EE',
  IS: 'is-IS',
  ZA: 'en-ZA',
  NG: 'en-NG',
  KE: 'en-KE',
  PK: 'ur-PK',
  BD: 'bn-BD',
  MM: 'my-MM',
  KH: 'km-KH',
  LA: 'lo-LA',
  NP: 'ne-NP',
  LK: 'si-LK',
};

function localeFromCountryCode(countryCode, fallback = 'en-US') {
  const code = String(countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return fallback;
  return COUNTRY_TO_LOCALE[code] || fallback;
}

/**
 * Resolve effective browser language for a profile.
 * languageMode: 'ip' | 'system' | locale like 'zh-CN'
 * langFromIp: legacy checkbox (true => treat as ip when mode missing)
 */
function resolveProfileLanguage(profile = {}, network = {}) {
  const privacy = profile.privacy || {};
  let mode = String(privacy.languageMode || '').trim();
  if (!mode) {
    if (privacy.langFromIp !== false && (privacy.uiLanguage === 'profile' || !privacy.uiLanguage)) {
      mode = 'ip';
    } else if (privacy.uiLanguage && privacy.uiLanguage !== 'profile') {
      mode = privacy.uiLanguage;
    } else {
      mode = 'ip';
    }
  }

  if (mode === 'system') {
    try {
      return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
    } catch (_) {
      return 'en-US';
    }
  }

  if (mode === 'ip') {
    const cc = network.countryCode || profile.exitCountryCode || '';
    return localeFromCountryCode(cc, profile.language || 'en-US');
  }

  // explicit locale
  if (/^[a-z]{2}(-[A-Za-z]{2})?$/.test(mode)) {
    const [lang, region] = mode.split('-');
    return region ? `${lang.toLowerCase()}-${region.toUpperCase()}` : lang.toLowerCase();
  }

  return profile.language || 'en-US';
}

module.exports = {
  COUNTRY_TO_LOCALE,
  localeFromCountryCode,
  resolveProfileLanguage,
};
