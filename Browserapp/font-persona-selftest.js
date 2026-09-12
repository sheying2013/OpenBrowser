'use strict';

// Font probing is one of the strongest OS signals available, and on a stock Chromium kernel
// nothing shields it — the host's real fonts answer. A profile presenting as Windows while
// running on a Mac is contradicted the moment a page asks about Helvetica Neue.
//
// Only Local Font Access is answered from the persona's platform set here. Two boundaries are
// pinned deliberately:
//   * document.fonts.check() is left native. It answers true for every system family in this
//     engine, so denying "foreign" families would be a difference from an unmodified build (an
//     own member on the FontFaceSet, a false where every stock browser answers true, and no
//     SyntaxError for a spec without a size) that hides nothing.
//   * Text measurement is not intercepted, since that means touching the geometry pages use
//     for layout.
// The returned FontData objects must keep the engine's shape, because a plain object is itself
// a tell: it stringifies, enumerates and brands differently.

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

/**
 * Minimal DOM holding the two font surfaces a page can read: a FontFaceSet whose check() lives
 * on the prototype (exactly where the engine keeps it) and a Local Font Access method that
 * hands out FontData-branded objects with prototype accessors and no own members.
 */
function makeCtx(fp, opts = {}) {
  function Navigator() {}
  function Screen() {}
  const webFonts = new Set(opts.webFonts || []);
  const fontFaces = [...webFonts].map((family) => ({ family }));
  const nativeCheckCalls = [];

  const fontSlots = new WeakMap();
  function FontData(fields) { fontSlots.set(this, fields); }
  for (const key of ['postscriptName', 'fullName', 'family', 'style']) {
    Object.defineProperty(FontData.prototype, key, {
      configurable: true,
      enumerable: true,
      get() { return fontSlots.get(this)[key]; },
    });
  }
  // The engine keeps blob() enumerable on the prototype, so the stub has to as well or the
  // for-in comparison below would be testing the stub instead of the injector.
  Object.defineProperty(FontData.prototype, 'blob', {
    configurable: true,
    enumerable: true,
    value: function blob() { return Promise.resolve({ size: 0, type: 'application/octet-stream' }); },
  });
  Object.defineProperty(FontData.prototype, Symbol.toStringTag, {
    configurable: true,
    enumerable: false,
    get() { return 'FontData'; },
  });

  const hostRows = (opts.hostFonts || ['Helvetica Neue', 'SF Pro']).map((family) => ({
    family,
    fullName: family + ' Regular',
    postscriptName: family.replace(/\s+/g, ''),
    style: 'Regular',
  }));

  function FontFaceSet() {}
  FontFaceSet.prototype.check = function check(spec) {
    nativeCheckCalls.push(spec);
    return opts.nativeCheck === undefined ? true : opts.nativeCheck;
  };
  FontFaceSet.prototype[Symbol.iterator] = function () { return fontFaces[Symbol.iterator](); };
  const fontSet = new FontFaceSet();

  const win = {
    Navigator, Screen, FontData,
    navigator: Object.create(Navigator.prototype),
    screen: Object.create(Screen.prototype),
    devicePixelRatio: 1, screenX: 0, screenY: 0, innerWidth: 1280, innerHeight: 800,
    outerWidth: 1280, outerHeight: 800,
    document: {
      createElement: () => ({ getContext: () => null }),
      fonts: fontSet,
    },
    queryLocalFonts: async (options) => {
      const wanted = options && Array.isArray(options.postscriptNames)
        ? new Set(options.postscriptNames.map((name) => String(name)))
        : null;
      return hostRows
        .filter((row) => !wanted || wanted.has(row.postscriptName))
        .map((row) => new FontData(row));
    },
    location: { href: 'https://example.com/', hostname: 'example.com' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    Intl, Date, Math, JSON, Object, Function, Array, String, Number, Boolean, Symbol,
    Promise, WeakMap, WeakSet, Map, Set, Reflect, Proxy, Error, TypeError, RangeError,
    DOMException: function DOMException(m) { this.message = m; },
  };
  win.window = win; win.globalThis = win; win.self = win; win.top = win;
  const ctx = vm.createContext(win);
  try { vm.runInContext(buildInjectionScript(fp), ctx, { timeout: 10000 }); } catch (_) {}
  ctx.__nativeCheckCalls = nativeCheckCalls;
  ctx.__fontSet = fontSet;
  return ctx;
}

// --- Local Font Access reports the persona, not the host ---
async function main() {
  const fp = buildFingerprint({ id: 'font-b', userAgent: WIN_UA, privacy: { deviceProfile: 'persona' }, advanced: {} });
  const ctx = makeCtx(fp, { hostFonts: ['Helvetica Neue', 'SF Pro', 'Menlo'] });
  const list = await vm.runInContext('queryLocalFonts().then(list => list.map(f => f.family))', ctx);
  ok('queryLocalFonts returns the persona set', list.includes('Segoe UI'));
  ok('queryLocalFonts hides the host fonts', !list.includes('Helvetica Neue') && !list.includes('SF Pro'));

  const SHAPE_PROBE = `(async () => {
    const entries = await queryLocalFonts();
    const f = entries[0];
    const seen = [];
    for (const key in f) seen.push(key);
    return JSON.stringify({
      arrFrozen: Object.isFrozen(entries),
      proto: Object.getPrototypeOf(f) && Object.getPrototypeOf(f).constructor && Object.getPrototypeOf(f).constructor.name,
      ownKeys: Object.keys(f),
      getOwnNames: Object.getOwnPropertyNames(f),
      frozen: Object.isFrozen(f),
      extensible: Object.isExtensible(f),
      tag: Object.prototype.toString.call(f),
      symTag: f[Symbol.toStringTag],
      isFontData: f instanceof FontData,
      json: JSON.stringify(f),
      forIn: seen.join(','),
      family: f.family,
      postscriptName: f.postscriptName,
      style: f.style,
      fullName: f.fullName,
      formatted: f.postscriptName === f.family.split(' ').join('') && f.fullName === f.family && f.style === 'Regular',
    });
  })()`;
  const shape = JSON.parse(await vm.runInContext(SHAPE_PROBE, ctx));
  ok('queryLocalFonts entries keep the FontData brand', shape.proto === 'FontData' && shape.isFontData === true && shape.symTag === 'FontData');
  ok('queryLocalFonts entries carry no own members', shape.ownKeys.length === 0 && shape.getOwnNames.length === 0 && shape.json === '{}');
  ok('queryLocalFonts entries stay writable like the engine objects', shape.frozen === false && shape.extensible === true);
  ok('queryLocalFonts entries inherit the same accessors', shape.forIn === 'postscriptName,fullName,family,style,blob');
  ok('queryLocalFonts entries brand like the engine objects', shape.tag === '[object FontData]');
  ok('the persona answers the enumerated fields', shape.formatted === true && shape.family === fontsForOs('windows')[0]);
  ok('queryLocalFonts keeps the host array shape', shape.arrFrozen === false);

  const filteredList = await vm.runInContext(
    `queryLocalFonts({ postscriptNames: ['Calibri', 'SegoeUI'] }).then((l) => l.map((f) => f.family))`,
    ctx,
  );
  ok('queryLocalFonts honours a postscriptNames filter', filteredList.length === 2 && filteredList.includes('Calibri') && filteredList.includes('Segoe UI'));

  // --- document.fonts.check must stay exactly the browser implementation ---
  const check = (c, spec) => vm.runInContext(`document.fonts.check(${JSON.stringify(spec)})`, c);
  const calls = () => ctx.__nativeCheckCalls.length;
  const before = calls();
  ok('check() is left to the browser for a platform family', check(ctx, '12px "Segoe UI"') === true);
  ok('check() is left to the browser for a foreign family', check(ctx, '12px "Helvetica Neue"') === true);
  ok('check() is left to the browser for an unknown family', check(ctx, '12px "Some Web Font 123"') === true);
  ok('every check() reached the browser implementation', calls() === before + 3);

  const meta = JSON.parse(vm.runInContext(`JSON.stringify({
    own: Object.prototype.hasOwnProperty.call(document.fonts, 'check'),
    name: document.fonts.check.name,
    len: document.fonts.check.length,
    onProto: Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(document.fonts), 'check'),
  })`, ctx));
  ok('check() stays a prototype member (no own property is added)', meta.own === false && meta.onProto === true);
  ok('check() keeps its native name and arity', meta.name === 'check' && meta.len === 1);

  const webCtx = makeCtx(fp, { webFonts: ['Helvetica Neue'], nativeCheck: true });
  ok('a loaded web font defers to the browser', vm.runInContext(`document.fonts.check('12px "Helvetica Neue"')`, webCtx) === true);

  const plainFp = buildFingerprint({ id: 'font-d', userAgent: WIN_UA, privacy: {}, advanced: {} });
  const plainCtx = makeCtx(plainFp, { nativeCheck: false });
  ok('no persona means no font interception', vm.runInContext(`document.fonts.check('12px "Segoe UI"')`, plainCtx) === false);

  const macFp = buildFingerprint({ id: 'font-c', userAgent: MAC_UA, privacy: { deviceProfile: 'persona' }, advanced: {} });
  const macCtx = makeCtx(macFp);
  const macList = await vm.runInContext('queryLocalFonts().then(list => list.map(f => f.family))', macCtx);
  ok('macOS persona enumerates Helvetica Neue', macList.includes('Helvetica Neue'));
  ok('macOS persona does not enumerate Segoe UI', !macList.includes('Segoe UI'));

  console.log(`\nfont-persona-selftest: ${passed} checks passed.`);
}

main().catch((err) => { console.error('font-persona-selftest: crashed', (err && err.stack) || err); process.exitCode = 1; });
