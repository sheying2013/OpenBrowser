'use strict';

// Font probing is one of the strongest OS signals available, and on a stock Chromium kernel
// nothing shields it — the host's real fonts answer. A profile presenting as Windows while
// running on a Mac is contradicted the moment a page asks about Helvetica Neue.
//
// The direct-report APIs (Local Font Access and document.fonts.check) are answered from the
// persona's platform set. Text-measurement probing is deliberately NOT intercepted, since
// that means touching the geometry pages use for layout; this test pins down what is and is
// not covered so the boundary stays explicit.

const vm = require('vm');
const assert = require('assert');
const { buildFingerprint, buildInjectionScript } = require('./automation/fingerprint');
const { fontsForOs, exclusiveFontsForOtherOs, OS_FONTS } = require('./automation/device-personas');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  PASS  ' + n); passed += 1; };

const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- the platform tables themselves ---
{
  ok('Windows set has Segoe UI and Calibri', fontsForOs('windows').includes('Segoe UI') && fontsForOs('windows').includes('Calibri'));
  ok('Windows set has no Helvetica Neue', !fontsForOs('windows').includes('Helvetica Neue'));
  ok('macOS set has Helvetica Neue and Menlo', fontsForOs('macos').includes('Helvetica Neue') && fontsForOs('macos').includes('Menlo'));
  ok('macOS set has no Segoe UI', !fontsForOs('macos').includes('Segoe UI'));
  ok('Linux set is DejaVu/Liberation based', fontsForOs('linux').includes('DejaVu Sans') && fontsForOs('linux').includes('Liberation Sans'));

  const winForeign = exclusiveFontsForOtherOs('windows').map((f) => f.toLowerCase());
  ok('Windows treats Helvetica Neue as foreign', winForeign.includes('helvetica neue'));
  ok('Windows does not treat Arial as foreign (shared everywhere)', !winForeign.includes('arial'));
  const macForeign = exclusiveFontsForOtherOs('macos').map((f) => f.toLowerCase());
  ok('macOS treats Segoe UI as foreign', macForeign.includes('segoe ui'));
  ok('a platform never lists its own font as foreign', OS_FONTS.windows.every((f) => !winForeign.includes(f.toLowerCase())));
}

// --- escaping guard for the emitted script ---
// The injection scripts are built as template literals, so a backslash written once is eaten
// before it reaches the page: \s arrives as a literal "s" and the regex silently stops
// matching. That is invisible in the source and only shows up as a hook that never fires.
{
  const fp = buildFingerprint({ id: 'escape', userAgent: WIN_UA, privacy: { deviceProfile: 'persona' }, advanced: {} });
  const src = buildInjectionScript(fp);
  const literals = src.match(/\/(?![/*])(?:\\.|\[[^\]]*\]|[^/\n\\])+\/[gimsuy]*/g) || [];
  const suspicious = literals.filter((r) => /\((\?:)?\^\|s\)/.test(r) || /\)s\*/.test(r) || /[^\\]\bs\+/.test(r) || /[^\\]\bd\+/.test(r));
  ok(`emitted regexes keep their escapes (${literals.length} scanned)`, suspicious.length === 0);
  if (suspicious.length) suspicious.forEach((r) => console.log('     x ' + r));
}

// --- fingerprint output ---
{
  const persona = buildFingerprint({ id: 'font-a', userAgent: WIN_UA, privacy: { deviceProfile: 'persona' }, advanced: {} });
  ok('persona profile carries a font set', persona.fonts && persona.fonts.list.length > 0);
  ok('persona font set matches the claimed OS', persona.fonts.os === 'windows' && persona.fonts.list.includes('Segoe UI'));

  const legacy = buildFingerprint({ id: 'font-a', userAgent: WIN_UA, privacy: {}, advanced: {} });
  ok('profiles without the opt-in carry no font claim', legacy.fonts === null);
}

/** Minimal DOM with the two font APIs a page can use to ask directly. */
function makeCtx(fp, opts = {}) {
  function Navigator() {}
  function Screen() {}
  const webFonts = new Set(opts.webFonts || []);
  const fontFaces = [...webFonts].map((family) => ({ family }));
  const nativeCheckCalls = [];
  const win = {
    Navigator, Screen,
    navigator: Object.create(Navigator.prototype),
    screen: Object.create(Screen.prototype),
    devicePixelRatio: 1, screenX: 0, screenY: 0, innerWidth: 1280, innerHeight: 800,
    outerWidth: 1280, outerHeight: 800,
    document: {
      createElement: () => ({ getContext: () => null }),
      fonts: {
        check(spec, text) { nativeCheckCalls.push(spec); return opts.nativeCheck === undefined ? true : opts.nativeCheck; },
        [Symbol.iterator]() { return fontFaces[Symbol.iterator](); },
      },
    },
    queryLocalFonts: async () => (opts.hostFonts || ['Helvetica Neue', 'SF Pro']).map((family) => ({ family, fullName: family, postscriptName: family })),
    location: { href: 'https://example.com/', hostname: 'example.com' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    Intl, Date, Math, JSON, Object, Function, Array, String, Number, Boolean, Symbol,
    Promise, WeakMap, Map, Set, Reflect, Proxy, Error, TypeError, RangeError,
    DOMException: function DOMException(m) { this.message = m; },
  };
  win.window = win; win.globalThis = win; win.self = win; win.top = win;
  const ctx = vm.createContext(win);
  try { vm.runInContext(buildInjectionScript(fp), ctx, { timeout: 10000 }); } catch (_) {}
  ctx.__nativeCheckCalls = nativeCheckCalls;
  return ctx;
}

// --- Local Font Access reports the persona, not the host ---
{
  const fp = buildFingerprint({ id: 'font-b', userAgent: WIN_UA, privacy: { deviceProfile: 'persona' }, advanced: {} });
  const ctx = makeCtx(fp, { hostFonts: ['Helvetica Neue', 'SF Pro', 'Menlo'] });
  const families = vm.runInContext('queryLocalFonts().then(list => list.map(f => f.family))', ctx);
  return families.then((list) => {
    ok('queryLocalFonts returns the persona set', list.includes('Segoe UI'));
    ok('queryLocalFonts hides the host fonts', !list.includes('Helvetica Neue') && !list.includes('SF Pro'));

    // --- document.fonts.check answers per platform ---
    const check = (c, spec) => vm.runInContext(`document.fonts.check(${JSON.stringify(spec)})`, c);
    ok('check() confirms a font the platform ships', check(ctx, '12px "Segoe UI"') === true);
    ok('check() denies a font exclusive to another platform', check(ctx, '12px "Helvetica Neue"') === false);

    const macFp = buildFingerprint({ id: 'font-c', userAgent: MAC_UA, privacy: { deviceProfile: 'persona' }, advanced: {} });
    const macCtx = makeCtx(macFp);
    ok('macOS persona confirms Helvetica Neue', check(macCtx, '12px "Helvetica Neue"') === true);
    ok('macOS persona denies Segoe UI', check(macCtx, '12px "Segoe UI"') === false);

    // A page's own web font must keep the browser's answer, so loading logic still works.
    const webCtx = makeCtx(fp, { webFonts: ['Helvetica Neue'], nativeCheck: true });
    ok('a loaded web font defers to the browser', check(webCtx, '12px "Helvetica Neue"') === true);

    // Unmodelled families must fall through rather than being guessed at.
    const before = webCtx.__nativeCheckCalls.length;
    check(webCtx, '12px "Some Web Font 123"');
    ok('unknown families fall through to the browser', webCtx.__nativeCheckCalls.length > before);

    // Profiles without the opt-in must not have the hook installed at all.
    const plainFp = buildFingerprint({ id: 'font-d', userAgent: WIN_UA, privacy: {}, advanced: {} });
    const plainCtx = makeCtx(plainFp, { nativeCheck: false });
    ok('no persona means no font interception', check(plainCtx, '12px "Segoe UI"') === false);

    console.log(`\nfont-persona-selftest: ${passed} checks passed.`);
  });
}
