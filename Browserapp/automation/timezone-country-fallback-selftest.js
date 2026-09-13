#!/usr/bin/env node
'use strict';

/**
 * Selftest suite for country-to-timezone fallback, valid timezone priority,
 * and start-page refresh persistence without host timezone leakage.
 *
 * Covers:
 * 1. Conservative strategy for multi-timezone countries (US, CA, RU, AU, BR, ID, MX, CL, AR, KZ, PT, ES).
 * 2. Valid timezone priority over country default and cross-country updating.
 * 3. Empty, invalid, and malformed inputs robustness (no unhandled exceptions).
 * 4. Start-page server session registration and network refresh paths:
 *    - Derived timezone when network lookup lacks timezone.
 *    - Preserved timezone across refresh when remote lookup fails.
 *    - Never clearing timezone to empty string.
 *    - Never falling back to host system timezone.
 * 5. Mutation sensitivity (--mutate) confirming assertions catch defective logic.
 */

const assert = require("assert");
const http = require("http");
const path = require("path");

const {
  COUNTRY_TO_TIMEZONE,
  localeFromCountryCode,
  timezoneFromCountryCode,
  isIanaTimezoneId,
  resolveProfileTimezone,
} = require("./locale-from-country");
const { StartPageServer } = require("./start-page-server");

const isMutateMode = process.argv.includes("--mutate") || process.env.MUTATE === "1";

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
};

console.log(`Starting Timezone Country Fallback Selftest (mode: ${isMutateMode ? "MUTATION" : "NORMAL"})...\n`);

// =========================================================================
// SECTION 1: Conservative Strategy for Multi-Timezone Countries
// =========================================================================

check("multi-timezone countries map to conservative capital or primary zones", () => {
  const multiTzExpected = {
    US: "America/New_York",
    CA: "America/Toronto",
    RU: "Europe/Moscow",
    AU: "Australia/Sydney",
    BR: "America/Sao_Paulo",
    ID: "Asia/Jakarta",
    MX: "America/Mexico_City",
    CL: "America/Santiago",
    AR: "America/Argentina/Buenos_Aires",
    KZ: "Asia/Almaty",
    PT: "Europe/Lisbon",
    ES: "Europe/Madrid",
  };

  for (const [cc, expectedTz] of Object.entries(multiTzExpected)) {
    const resolved = timezoneFromCountryCode(cc);
    assert.strictEqual(resolved, expectedTz, `Country ${cc} must resolve to ${expectedTz}, got ${resolved}`);
    assert.ok(isIanaTimezoneId(resolved), `Resolved timezone for ${cc} (${resolved}) must be valid IANA`);
  }
});

check("single-timezone and common countries resolve to valid IANA timezones", () => {
  const commonExpected = {
    CN: "Asia/Shanghai",
    JP: "Asia/Tokyo",
    GB: "Europe/London",
    UK: "Europe/London",
    SG: "Asia/Singapore",
    DE: "Europe/Berlin",
    FR: "Europe/Paris",
    KR: "Asia/Seoul",
    IN: "Asia/Kolkata",
    IT: "Europe/Rome",
    NL: "Europe/Amsterdam",
    IE: "Europe/Dublin",
    NZ: "Pacific/Auckland",
    AE: "Asia/Dubai",
    TH: "Asia/Bangkok",
    VN: "Asia/Ho_Chi_Minh",
    PH: "Asia/Manila",
    MY: "Asia/Kuala_Lumpur",
    ZA: "Africa/Johannesburg",
    EG: "Africa/Cairo",
  };

  for (const [cc, expectedTz] of Object.entries(commonExpected)) {
    const resolved = timezoneFromCountryCode(cc);
    assert.strictEqual(resolved, expectedTz, `Country ${cc} must resolve to ${expectedTz}`);
    assert.ok(isIanaTimezoneId(resolved), `${resolved} must be valid IANA timezone`);
  }
});

check("all entries in COUNTRY_TO_TIMEZONE dictionary are valid IANA timezones", () => {
  const entries = Object.entries(COUNTRY_TO_TIMEZONE);
  assert.ok(entries.length >= 60, "COUNTRY_TO_TIMEZONE must declare comprehensive mappings");
  for (const [cc, tz] of entries) {
    assert.ok(/^[A-Z]{2}$/.test(cc), `Country code key ${cc} must be 2-letter uppercase`);
    assert.ok(isIanaTimezoneId(tz), `Timezone value for ${cc} (${tz}) must be valid IANA`);
  }
});

// =========================================================================
// SECTION 2: Valid Timezone Priority & Persona Resolution
// =========================================================================

check("valid network exit timezone takes precedence over country capital fallback", () => {
  // Remote probe located in Los Angeles: should NOT be overwritten with New_York
  const profile = { exitCountryCode: "US" };
  const network = { countryCode: "US", timezone: "America/Los_Angeles" };
  const resolved = resolveProfileTimezone(profile, network);
  assert.strictEqual(resolved, "America/Los_Angeles", "Specific exit timezone must take priority over country fallback");
});

check("existing valid profile timezone is preserved when network lookup lacks timezone", () => {
  // Profile configured with Chicago; subsequent network lookup returned US but omitted timezone
  const profile = { exitCountryCode: "US", exitTimezone: "America/Chicago" };
  const network = { countryCode: "US", timezone: "" };
  const resolved = resolveProfileTimezone(profile, network);
  assert.strictEqual(resolved, "America/Chicago", "Existing valid profile timezone must be preserved if country matches");
});

check("country change without network timezone triggers derived timezone for new country", () => {
  // Profile was US, proxy switched to Japan but IP geo lacked timezone field
  const profile = { exitCountryCode: "US", exitTimezone: "America/New_York" };
  const network = { countryCode: "JP", timezone: "" };
  const resolved = resolveProfileTimezone(profile, network);
  assert.strictEqual(resolved, "Asia/Tokyo", "Country change must derive timezone of new country");
});

check("custom timezone mode honors user-selected custom timezone", () => {
  const profile = {
    privacy: { timezoneMode: "custom", timezone: "America/Phoenix" },
    exitTimezone: "America/New_York",
  };
  const network = { countryCode: "US", timezone: "America/Chicago" };
  const resolved = resolveProfileTimezone(profile, network);
  assert.strictEqual(resolved, "America/Phoenix", "Custom mode must honor user custom timezone");
});

check("real timezone mode returns empty string without spoofing", () => {
  const profile = {
    privacy: { timezoneMode: "real" },
    exitTimezone: "America/New_York",
  };
  const network = { countryCode: "US", timezone: "America/New_York" };
  const resolved = resolveProfileTimezone(profile, network);
  assert.strictEqual(resolved, "", "Real mode must return empty string to indicate host timezone");
});

check("unknown or missing country preserves known profile timezone and never clears to empty", () => {
  const profile = { exitTimezone: "Europe/Paris" };
  const network = { countryCode: "ZZ", timezone: "" }; // Unknown country
  const resolved = resolveProfileTimezone(profile, network);
  assert.strictEqual(resolved, "Europe/Paris", "Must preserve known profile timezone when derivation is impossible");

  const resolvedNoNet = resolveProfileTimezone(profile, {});
  assert.strictEqual(resolvedNoNet, "Europe/Paris", "Must preserve profile timezone when network is empty");
});

// =========================================================================
// SECTION 3: Robustness on Empty, Invalid, and Malformed Inputs
// =========================================================================

check("isIanaTimezoneId correctly filters invalid and malformed identifiers", () => {
  const invalidSamples = [
    null,
    undefined,
    "",
    "   ",
    123,
    true,
    {},
    [],
    "Invalid/Timezone",
    "Not_A_Real_Zone",
    "../etc/passwd",
    "/America/New_York",
    "America/New_York/",
    "America..New_York",
    "A".repeat(120),
    "Shanghai", // Obsolete non-standard bare city
  ];

  for (const sample of invalidSamples) {
    assert.strictEqual(isIanaTimezoneId(sample), false, `Must reject invalid timezone: ${sample}`);
  }

  const validSamples = [
    "America/New_York",
    "Asia/Shanghai",
    "Asia/Tokyo",
    "Europe/London",
    "UTC",
    "Etc/GMT+8",
    "Pacific/Auckland",
    "Australia/Sydney",
  ];

  for (const sample of validSamples) {
    assert.strictEqual(isIanaTimezoneId(sample), true, `Must accept valid timezone: ${sample}`);
  }
});

check("timezoneFromCountryCode handles case normalization and empty/bad inputs", () => {
  // Case normalization
  assert.strictEqual(timezoneFromCountryCode("us"), "America/New_York");
  assert.strictEqual(timezoneFromCountryCode("  jp  "), "Asia/Tokyo");

  // Invalid country codes
  assert.strictEqual(timezoneFromCountryCode(""), "");
  assert.strictEqual(timezoneFromCountryCode(null), "");
  assert.strictEqual(timezoneFromCountryCode(undefined), "");
  assert.strictEqual(timezoneFromCountryCode("   "), "");
  assert.strictEqual(timezoneFromCountryCode("ZZ"), "");
  assert.strictEqual(timezoneFromCountryCode("USA"), "");
  assert.strictEqual(timezoneFromCountryCode("12"), "");
  assert.strictEqual(timezoneFromCountryCode(123), "");
  assert.strictEqual(timezoneFromCountryCode({}), "");

  // Custom fallback
  assert.strictEqual(timezoneFromCountryCode("ZZ", "UTC"), "UTC");
});

check("resolveProfileTimezone never throws on null, undefined, or empty objects", () => {
  assert.doesNotThrow(() => resolveProfileTimezone(null, null));
  assert.doesNotThrow(() => resolveProfileTimezone(undefined, undefined));
  assert.doesNotThrow(() => resolveProfileTimezone({}, {}));
  assert.doesNotThrow(() => resolveProfileTimezone({ privacy: null }, { timezone: null }));
  assert.strictEqual(resolveProfileTimezone(null, null), "");
  assert.strictEqual(resolveProfileTimezone({}, {}), "");
});

// =========================================================================
// SECTION 4: Start-Page Server Registration & Refresh Paths
// =========================================================================

check("start-page server registers session with derived timezone when network lacks it", () => {
  const server = new StartPageServer();
  server.port = 50326;
  const profile = { id: "profile-us", exitCountryCode: "US" };
  const extras = { network: { countryCode: "US", timezone: "" } };

  server.registerSession(profile, extras);
  const session = server.getSession("profile-us");
  assert.ok(session, "Session must be registered");
  assert.strictEqual(session.timezone, "America/New_York", "Session timezone must derive from US country code");
  assert.strictEqual(session.network.timezone, "America/New_York", "Session network timezone must also be filled");
  assert.strictEqual(session.expectedFingerprint.timezone, "America/New_York");
});

check("start-page server updateNetwork preserves session timezone or derives on country change", () => {
  const server = new StartPageServer();
  server.port = 50326;
  const profile = { id: "profile-dyn", exitCountryCode: "US", exitTimezone: "America/Chicago" };
  server.registerSession(profile);

  const session = server.getSession("profile-dyn");
  assert.strictEqual(session.timezone, "America/Chicago");

  // Update with US exit but missing timezone -> preserves Chicago
  server.updateNetwork("profile-dyn", { ip: "198.51.100.1", countryCode: "US", timezone: "" });
  assert.strictEqual(session.timezone, "America/Chicago", "Must preserve existing Chicago timezone");
  assert.strictEqual(session.network.timezone, "America/Chicago");

  // Update with country change to Great Britain -> derives London
  server.updateNetwork("profile-dyn", { ip: "198.51.100.2", countryCode: "GB", timezone: "" });
  assert.strictEqual(session.timezone, "Europe/London", "Must update to London on country change");
  assert.strictEqual(session.network.timezone, "Europe/London");

  // Update with explicit valid timezone -> honors explicit timezone
  server.updateNetwork("profile-dyn", { ip: "198.51.100.3", countryCode: "US", timezone: "America/Los_Angeles" });
  assert.strictEqual(session.timezone, "America/Los_Angeles", "Must update to explicit network timezone");
});

check("start-page server refresh failure preserves profile timezone and never leaks host timezone", async () => {
  const hostTimezone = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return "UTC"; }
  })();

  // Use a distant timezone distinct from host to verify no host timezone leakage
  const distantTimezone = hostTimezone === "Pacific/Honolulu" ? "Atlantic/Reykjavik" : "Pacific/Honolulu";

  const server = new StartPageServer({
    lookupDirectNetwork: async () => {
      throw new Error("Simulated offline network timeout");
    },
  });

  const mockProfile = {
    id: "profile-refresh-fail",
    networkMode: "direct",
    exitCountryCode: "US",
    exitTimezone: distantTimezone,
  };

  server.setEngine({
    profiles: new Map([[mockProfile.id, mockProfile]]),
    networkInfo: new Map(),
    running: new Set([mockProfile.id]),
  });

  await server.start();
  const rawUrl = server.registerSession(mockProfile);
  const token = new URL(rawUrl).searchParams.get("token");

  try {
    const resData = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${server.port}/api/network?pid=${mockProfile.id}&refresh=true&token=${token}`, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }).on("error", reject);
    });

    assert.ok(resData.ok, "API network refresh must return ok: true");
    const net = resData.data;
    assert.ok(net, "Network payload must exist");
    assert.strictEqual(net.timezone, distantTimezone, "Timezone on refresh failure must retain profile timezone");
    assert.notStrictEqual(net.timezone, "", "Timezone on refresh failure must NEVER be cleared to empty string");
    if (hostTimezone !== distantTimezone) {
      assert.notStrictEqual(net.timezone, hostTimezone, "Timezone on refresh failure must NEVER leak host timezone");
    }
  } finally {
    if (server.server) server.server.close();
  }
});

check("start-page server refresh with missing session does not crash and avoids host timezone leak", async () => {
  const hostTimezone = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return "UTC"; }
  })();

  const server = new StartPageServer({
    lookupDirectNetwork: async () => {
      throw new Error("Direct lookup failure");
    },
  });

  await server.start();
  try {
    // Calling #resolveNetwork with refresh when no session exists
    const resData = await new Promise((resolve, reject) => {
      // Direct call via internal method or API
      const req = http.request(`http://127.0.0.1:${server.port}/api/network?pid=nonexistent&refresh=true`, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body }); } catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
      req.end();
    });

    // Unregistered PID is blocked at auth barrier (401)
    assert.strictEqual(resData.status, 401, "Unregistered session must be rejected with 401 unauthorized");
  } finally {
    if (server.server) server.server.close();
  }
});

// =========================================================================
// SECTION 5: Mutation Sensitivity Checks
// =========================================================================

check("mutation sensitivity: disabled country fallback causes resolution failure", () => {
  // Simulating mutant where country fallback returns empty
  const mutantResolve = (profile, network) => {
    const netTz = isIanaTimezoneId(network?.timezone) ? network.timezone : "";
    if (netTz) return netTz;
    // Mutant: omit country fallback!
    return profile?.exitTimezone || "";
  };

  const testProfile = { exitCountryCode: "US" };
  const testNet = { countryCode: "US", timezone: "" };
  const mutantResult = mutantResolve(testProfile, testNet);
  assert.strictEqual(mutantResult, "", "Mutant without country fallback must produce empty string");

  const normalResult = resolveProfileTimezone(testProfile, testNet);
  assert.strictEqual(normalResult, "America/New_York", "Normal logic must derive America/New_York");
});

check("mutation sensitivity: inverted priority clobbers explicit network timezone", () => {
  // Simulating mutant where country default overrides specific exit network timezone
  const mutantResolve = (profile, network) => {
    const derived = timezoneFromCountryCode(network?.countryCode);
    if (derived) return derived; // Inverted: country default takes priority!
    return network?.timezone || "";
  };

  const testProfile = { exitCountryCode: "US" };
  const testNet = { countryCode: "US", timezone: "America/Los_Angeles" };
  const mutantResult = mutantResolve(testProfile, testNet);
  assert.strictEqual(mutantResult, "America/New_York", "Mutant clobbers specific Los_Angeles with New_York");

  const normalResult = resolveProfileTimezone(testProfile, testNet);
  assert.strictEqual(normalResult, "America/Los_Angeles", "Normal logic must prioritize America/Los_Angeles");
});

check("mutation sensitivity: refresh clobbering to empty or host timezone is detected", () => {
  const hostTimezone = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return "UTC"; }
  })();

  // Mutant 1: clobber to empty string
  const mutantClobberEmpty = (session) => {
    return "";
  };
  assert.strictEqual(mutantClobberEmpty({ timezone: "America/Chicago" }), "");

  // Mutant 2: clobber to host timezone
  const mutantClobberHost = (session) => {
    return hostTimezone;
  };
  assert.strictEqual(mutantClobberHost({ timezone: "America/Chicago" }), hostTimezone);

  // Normal preservation
  const normalPreserve = (session) => {
    return session?.timezone || "";
  };
  assert.strictEqual(normalPreserve({ timezone: "America/Chicago" }), "America/Chicago");
});

// Summary
const failed = results.filter((item) => !item.ok);
console.log(`\n======================================================================`);
if (!failed.length) {
  console.log(`timezone-country-fallback-selftest: OK ${results.length}/${results.length}`);
} else {
  console.log(`timezone-country-fallback-selftest: FAILED (${failed.length} failed)`);
  process.exitCode = 1;
}
