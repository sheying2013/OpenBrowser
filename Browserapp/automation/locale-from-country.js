'use strict';

/**
 * Map ISO 3166-1 alpha-2 country codes -> BCP47 browser locale.
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

/**
 * Primary / capital IANA timezone mapped from ISO 3166-1 alpha-2 country code.
 * For countries spanning multiple timezones (e.g. US, CA, RU, AU, BR, ID, MX),
 * a conservative capital or primary commercial center is used as deterministic fallback.
 */
const COUNTRY_TO_TIMEZONE = {
  // Americas
  US: 'America/New_York',
  CA: 'America/Toronto',
  MX: 'America/Mexico_City',
  BR: 'America/Sao_Paulo',
  AR: 'America/Argentina/Buenos_Aires',
  CL: 'America/Santiago',
  CO: 'America/Bogota',
  PE: 'America/Lima',
  VE: 'America/Caracas',
  EC: 'America/Guayaquil',
  UY: 'America/Montevideo',
  PY: 'America/Asuncion',
  BO: 'America/La_Paz',
  CR: 'America/Costa_Rica',
  PA: 'America/Panama',
  DO: 'America/Santo_Domingo',
  GT: 'America/Guatemala',
  PR: 'America/Puerto_Rico',

  // Western & Northern Europe
  GB: 'Europe/London',
  UK: 'Europe/London',
  IE: 'Europe/Dublin',
  FR: 'Europe/Paris',
  DE: 'Europe/Berlin',
  AT: 'Europe/Vienna',
  CH: 'Europe/Zurich',
  NL: 'Europe/Amsterdam',
  BE: 'Europe/Brussels',
  LU: 'Europe/Luxembourg',
  ES: 'Europe/Madrid',
  PT: 'Europe/Lisbon',
  IT: 'Europe/Rome',
  SE: 'Europe/Stockholm',
  NO: 'Europe/Oslo',
  DK: 'Europe/Copenhagen',
  FI: 'Europe/Helsinki',
  IS: 'Atlantic/Reykjavik',

  // Central & Eastern Europe
  PL: 'Europe/Warsaw',
  CZ: 'Europe/Prague',
  SK: 'Europe/Bratislava',
  HU: 'Europe/Budapest',
  RO: 'Europe/Bucharest',
  BG: 'Europe/Sofia',
  GR: 'Europe/Athens',
  HR: 'Europe/Zagreb',
  SI: 'Europe/Ljubljana',
  RS: 'Europe/Belgrade',
  BA: 'Europe/Sarajevo',
  ME: 'Europe/Podgorica',
  MK: 'Europe/Skopje',
  AL: 'Europe/Tirane',
  LT: 'Europe/Vilnius',
  LV: 'Europe/Riga',
  EE: 'Europe/Tallinn',
  UA: 'Europe/Kyiv',
  BY: 'Europe/Minsk',
  MD: 'Europe/Chisinau',
  RU: 'Europe/Moscow',
  TR: 'Europe/Istanbul',
  CY: 'Asia/Nicosia',

  // Asia - East & Southeast
  CN: 'Asia/Shanghai',
  TW: 'Asia/Taipei',
  HK: 'Asia/Hong_Kong',
  MO: 'Asia/Macau',
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  SG: 'Asia/Singapore',
  MY: 'Asia/Kuala_Lumpur',
  TH: 'Asia/Bangkok',
  VN: 'Asia/Ho_Chi_Minh',
  ID: 'Asia/Jakarta',
  PH: 'Asia/Manila',
  MM: 'Asia/Yangon',
  KH: 'Asia/Phnom_Penh',
  LA: 'Asia/Vientiane',
  BN: 'Asia/Brunei',

  // Asia - South & Central
  IN: 'Asia/Kolkata',
  PK: 'Asia/Karachi',
  BD: 'Asia/Dhaka',
  NP: 'Asia/Kathmandu',
  LK: 'Asia/Colombo',
  KZ: 'Asia/Almaty',
  UZ: 'Asia/Tashkent',
  GE: 'Asia/Tbilisi',
  AM: 'Asia/Yerevan',
  AZ: 'Asia/Baku',
  MN: 'Asia/Ulaanbaatar',

  // Middle East
  AE: 'Asia/Dubai',
  SA: 'Asia/Riyadh',
  IL: 'Asia/Jerusalem',
  QA: 'Asia/Qatar',
  KW: 'Asia/Kuwait',
  OM: 'Asia/Muscat',
  BH: 'Asia/Bahrain',
  JO: 'Asia/Amman',
  LB: 'Asia/Beirut',
  IQ: 'Asia/Baghdad',
  IR: 'Asia/Tehran',

  // Oceania
  AU: 'Australia/Sydney',
  NZ: 'Pacific/Auckland',
  FJ: 'Pacific/Fiji',

  // Africa
  EG: 'Africa/Cairo',
  ZA: 'Africa/Johannesburg',
  NG: 'Africa/Lagos',
  KE: 'Africa/Nairobi',
  GH: 'Africa/Accra',
  MA: 'Africa/Casablanca',
  TN: 'Africa/Tunis',
  DZ: 'Africa/Algiers',
  ET: 'Africa/Addis_Ababa',
  TZ: 'Africa/Dar_es_Salaam',
  UG: 'Africa/Kampala',
};

function localeFromCountryCode(countryCode, fallback = 'en-US') {
  const code = String(countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return fallback;
  return COUNTRY_TO_LOCALE[code] || fallback;
}

/**
 * Validate whether a string is a recognized IANA timezone identifier.
 */
function isIanaTimezoneId(value) {
  if (typeof value !== 'string') return false;
  const tz = value.trim();
  if (!tz || tz.length > 100) return false;
  if (!/^[A-Za-z0-9_+\-\/]+$/.test(tz)) return false;
  if (tz.includes('..') || tz.startsWith('/') || tz.endsWith('/')) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Derive a stable IANA timezone identifier from an ISO 3166-1 alpha-2 country code.
 */
function timezoneFromCountryCode(countryCode, fallback = '') {
  const code = String(countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return fallback;
  return COUNTRY_TO_TIMEZONE[code] || fallback;
}

/**
 * Resolve effective IANA timezone for a profile.
 * - 'real' mode: returns '' (explicitly indicates using host system timezone, no spoofing).
 * - 'custom' mode: uses custom privacy timezone if valid, falling back to profile/network.
 * - 'ip' mode (default):
 *   1. Prioritizes a valid IANA timezone returned directly by the network exit probe.
 *   2. If network lacks a valid timezone, preserves existing valid profile timezone
 *      (as long as the exit country has not changed).
 *   3. Stably derives a conservative IANA timezone from the exit ISO country code.
 *   4. If country derivation is not possible, preserves any known profile timezone.
 *      Never clears to '' when a profile timezone is known.
 */
function resolveProfileTimezone(profile = {}, network = {}) {
  const privacy = (profile && profile.privacy) || {};
  const mode = String(privacy.timezoneMode || 'ip').trim().toLowerCase();

  if (mode === 'real') {
    return '';
  }

  const pickValid = (...candidates) => {
    for (const c of candidates) {
      if (typeof c === 'string' && isIanaTimezoneId(c)) {
        return c.trim();
      }
    }
    return '';
  };

  const pickFirstNonEmpty = (...candidates) => {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) {
        return c.trim();
      }
    }
    return '';
  };

  if (mode === 'custom') {
    return pickValid(privacy.timezone, profile?.exitTimezone, network?.timezone)
      || pickFirstNonEmpty(privacy.timezone, profile?.exitTimezone, network?.timezone);
  }

  // mode === 'ip' (default)
  const netTz = typeof network?.timezone === 'string' ? network.timezone.trim() : '';
  const netCountry = String(network?.countryCode || '').trim().toUpperCase();
  const profCountry = String(profile?.exitCountryCode || '').trim().toUpperCase();

  // 1. Highest priority: explicit valid IANA timezone directly from exit network probe
  if (isIanaTimezoneId(netTz)) {
    return netTz;
  }

  // 2. Network geo lookup lacks timezone.
  // Check if existing profile timezone is valid and country did not change.
  const profTz = pickValid(profile?.exitTimezone, privacy.timezone, profile?.timezone);
  const countryChanged = Boolean(netCountry && profCountry && netCountry !== profCountry);

  if (profTz && !countryChanged) {
    return profTz;
  }

  // 3. Stably derive from ISO country code
  const targetCountry = netCountry || profCountry;
  const derivedTz = targetCountry ? timezoneFromCountryCode(targetCountry) : '';
  if (derivedTz) {
    return derivedTz;
  }

  // 4. When derivation is not possible (unknown/empty country), preserve known profile timezone
  if (profTz) {
    return profTz;
  }

  const fallbackKnown = pickFirstNonEmpty(profile?.exitTimezone, privacy.timezone, profile?.timezone);
  if (fallbackKnown) {
    return fallbackKnown;
  }

  return '';
}

/**
 * Resolve effective browser language for a profile.
 * languageMode: 'ip' | 'system' | locale like 'zh-CN'
 * langFromIp: legacy checkbox (true => treat as ip when mode missing)
 */
function resolveProfileLanguage(profile = {}, network = {}) {
  const privacy = (profile && profile.privacy) || {};
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
    const cc = (network && network.countryCode) || (profile && profile.exitCountryCode) || '';
    return localeFromCountryCode(cc, (profile && profile.language) || 'en-US');
  }

  // explicit locale
  if (/^[a-z]{2}(-[A-Za-z]{2})?$/.test(mode)) {
    const [lang, region] = mode.split('-');
    return region ? `${lang.toLowerCase()}-${region.toUpperCase()}` : lang.toLowerCase();
  }

  return (profile && profile.language) || 'en-US';
}

module.exports = {
  COUNTRY_TO_LOCALE,
  COUNTRY_TO_TIMEZONE,
  localeFromCountryCode,
  timezoneFromCountryCode,
  isIanaTimezoneId,
  resolveProfileTimezone,
  resolveProfileLanguage,
};
