#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for the timezone surface, run against the bundled kernel.
 *
 * Why this exists: the engine can be put into the target zone natively (the CDP timezone override
 * does exactly that), and the script layer used to re-implement every Date and Intl surface on top
 * of an already-correct engine. That second implementation is a hand-written copy of behaviour the
 * engine owns - zone names for instants outside the modern metazone range, the TypeError a Date
 * accessor owes a receiver without a [[DateValue]], the number of times an options getter is read,
 * and the wall clock at the very ends of the Date domain - so it installs only when the engine is
 * still reporting another zone.
 *
 * The test drives both paths and compares them against the same engine run natively in the target
 * zone:
 *   reference: bundled kernel + Emulation timezone / locale override, no inject
 *   production: bundled kernel + the real inject path (which also applies those overrides)
 *   fallback: bundled kernel + the emitted script only, so the script layer has to answer itself
 *
 * Every observation must match the reference. A zone whose historical zone names differ from the
 * engine's own choice is included on purpose: it fails if the script layer installs on top of an
 * engine that is already in the right zone.
 */

const assert = require('assert');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { buildFingerprint, buildInjectionScript, applyFingerprintToTab } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// A zone whose historical zone-name text differs from the engine's own choice is included on
// purpose, so a script layer that installs on top of a correct engine fails the comparison.
const MATRIX = [
  { tz: 'America/New_York', locale: 'en-US' },
  { tz: 'Australia/Lord_Howe', locale: 'en-US' },
  { tz: 'America/New_York', locale: 'de-DE' },
];

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${err.message}`); process.exitCode = 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INSTANTS = [
  ['epoch', 0],
  ['winter', Date.UTC(2026, 0, 15, 12, 0, 0)],
  ['summer', Date.UTC(2026, 6, 15, 12, 0, 0)],
  ['dst-start-utc', Date.UTC(2026, 2, 8, 6, 30, 0)],
  ['dst-end-utc', Date.UTC(2026, 10, 1, 5, 30, 0)],
  ['future', Date.UTC(2045, 11, 31, 23, 30, 0)],
  ['y1969', Date.UTC(1969, 11, 31, 23, 59, 59)],
  ['y1937', Date.UTC(1937, 6, 1, 12, 0, 0)],
  ['y1900', Date.UTC(1900, 0, 1, 12, 0, 0)],
  ['y1880', Date.UTC(1880, 0, 1, 12, 0, 0)],
];

const PROBE = `(() => {
  const out = {};
  const set = (k, fn) => { try { const v = fn(); out[k] = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { out[k] = 'THROW:' + e.name + ':' + String(e.message).slice(0, 60); } };
  const instants = ${JSON.stringify(INSTANTS)};
  for (const [label, ts] of instants) {
    const d = new Date(ts);
    set('date.' + label + '.toString', () => d.toString());
    set('date.' + label + '.toTimeString', () => d.toTimeString());
    set('date.' + label + '.toDateString', () => d.toDateString());
    set('date.' + label + '.getTimezoneOffset', () => d.getTimezoneOffset());
    set('date.' + label + '.components', () => [d.getFullYear(), d.getMonth(), d.getDate(), d.getDay(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]);
    set('date.' + label + '.toLocaleString', () => d.toLocaleString());
    set('date.' + label + '.toLocaleStringParts', () => new Intl.DateTimeFormat(undefined, { timeZoneName: 'long' }).formatToParts(d).map((p) => p.type + '=' + p.value).join('|'));
    set('intl.' + label + '.default', () => new Intl.DateTimeFormat().format(d));
    set('intl.' + label + '.withTzName', () => new Intl.DateTimeFormat('en-US', { timeZoneName: 'longOffset' }).format(d));
    set('intl.' + label + '.shortOffset', () => new Intl.DateTimeFormat('en-US', { timeZoneName: 'shortOffset', hour: '2-digit', minute: '2-digit' }).format(d));
    set('intl.' + label + '.defaultParsed', () => new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'long' }).format(d));
  }
  set('resolvedOptions', () => new Intl.DateTimeFormat().resolvedOptions());
  set('resolvedOptions.enUS', () => new Intl.DateTimeFormat('en-US').resolvedOptions());
  set('resolvedOptions.utc', () => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).resolvedOptions());
  set('resolvedOptions.none', () => new Intl.DateTimeFormat('en-US', { timeZone: undefined }).resolvedOptions());
  set('resolvedOptions.tzOnly', () => new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' }).resolvedOptions());
  set('intl.callForm', () => String(Object.prototype.toString.call(Intl.DateTimeFormat())));
  set('intl.instanceOf', () => [new Intl.DateTimeFormat() instanceof Intl.DateTimeFormat, Object.prototype.toString.call(new Intl.DateTimeFormat())]);
  set('intl.ctorProto', () => [Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat]);
  set('intl.statics', () => [Intl.DateTimeFormat.length, Intl.DateTimeFormat.name, String(Intl.DateTimeFormat).slice(0, 60), typeof Intl.DateTimeFormat.supportedLocalesOf, Intl.DateTimeFormat.supportedLocalesOf(['en-US']).join(',')]);
  set('intl.supportedValuesOf', () => { try { const v = Intl.supportedValuesOf('timeZone'); return [v.length, v.includes('America/New_York'), v.includes('Asia/Singapore'), v.includes('UTC')]; } catch (e) { return 'THROW:' + e.name; } });
  set('intl.badZone', () => { try { new Intl.DateTimeFormat('en-US', { timeZone: 'Not/AZone' }); return 'NO_THROW'; } catch (e) { return e.name; } });
  set('intl.noNew', () => Object.prototype.toString.call(Intl.DateTimeFormat.call(undefined)));
  // Date constructor / parse family
  set('date.ctorLocal', () => new Date(2026, 6, 15, 12, 0, 0).getTime());
  set('date.ctorLocalOverflow', () => new Date(2026, 0, 32).toString());
  set('date.ctorYear99', () => [new Date(99, 0, 1).getFullYear(), new Date(99, 0, 1).getTime()]);
  set('date.ctorYear0', () => [new Date(0, 0, 1).getFullYear(), new Date(0, 0, 1).toISOString()]);
  set('date.ctorOneString', () => new Date('2026-07-15 12:00:00').toISOString());
  set('date.ctorOneStringT', () => new Date('2026-07-15T12:00:00').toISOString());
  set('date.ctorOneDateStr', () => new Date('2026-07-15').toISOString());
  set('date.ctorOneIso', () => new Date('2026-07-15T12:00:00Z').toISOString());
  set('date.ctorOneIsoOffset', () => new Date('2026-07-15T12:00:00+05:00').toISOString());
  set('date.parse.local', () => Date.parse('2026-07-15 12:00:00'));
  set('date.parse.localT', () => Date.parse('2026-07-15T12:00:00'));
  set('date.parse.dateOnly', () => Date.parse('2026-07-15'));
  set('date.parse.rfc', () => Date.parse('Thu, 01 Jan 1970 00:00:00 GMT'));
  set('date.meta', () => [Date.length, Date.name, String(Date).slice(0, 40), Date.prototype.constructor === Date]);
  set('date.nowVsUtc', () => Math.abs(Date.now() - new Date().getTime()) < 50);
  set('date.noArgsString', () => typeof Date());
  set('date.setRoundTrip', () => { const d = new Date(2026, 0, 15, 12, 0, 0); d.setDate(20); return [d.toString(), d.getTime()]; });
  set('date.setAcrossDst', () => { const d = new Date(2026, 2, 7, 12, 0, 0); d.setDate(9); return [d.toString(), d.getTime()]; });
  set('date.setHoursDst', () => { const d = new Date(2026, 2, 8, 1, 30, 0); d.setHours(3, 30); return [d.toString(), d.getTime()]; });
  set('date.invalid', () => { const d = new Date(NaN); return [d.toString(), d.toTimeString(), d.toDateString(), String(d.getTimezoneOffset())]; });
  set('date.tzConsistency', () => {
    const d = new Date(1752600000000);
    const s = d.toString();
    const m = s.match(/GMT([+-]\\d{4})/);
    const off = -d.getTimezoneOffset();
    const hh = (off < 0 ? '-' : '+') + String(Math.floor(Math.abs(off) / 60)).padStart(2, '0') + String(Math.abs(off) % 60).padStart(2, '0');
    return [m ? m[1] : 'none', hh, m ? (m[1] === hh) : false];
  });
  // divergences the hand-written formatters can introduce: argument coercion, brand checks,
  // extreme years, and how many times an options getter is read
  set('coerce.nanMonth', () => new Date(2026, NaN).toString());
  set('coerce.nanDay', () => new Date(2026, 6, NaN).toString());
  set('coerce.nanSeconds', () => new Date(2026, 6, 15, 12, 0, NaN).toString());
  set('coerce.nanMs', () => new Date(2026, 6, 15, 12, 0, 0, NaN).toString());
  set('coerce.stringMonth', () => new Date(2026, 'abc').toString());
  set('coerce.stringMonthNumeric', () => new Date(2026, '6', '15').toString());
  set('coerce.infinityDate', () => new Date(Infinity).toString());
  set('brand.toStringPlain', () => { try { return Date.prototype.toString.call({ getTime: () => 0 }); } catch (e) { return 'THROW:' + e.name; } });
  set('brand.toStringEmpty', () => { try { return Date.prototype.toString.call({}); } catch (e) { return 'THROW:' + e.name; } });
  set('brand.toTimeStringEmpty', () => { try { return Date.prototype.toTimeString.call({}); } catch (e) { return 'THROW:' + e.name; } });
  set('brand.getHoursEmpty', () => { try { return String(Date.prototype.getHours.call({})); } catch (e) { return 'THROW:' + e.name; } });
  set('brand.getTimezoneOffsetEmpty', () => { try { return String(Date.prototype.getTimezoneOffset.call({})); } catch (e) { return 'THROW:' + e.name; } });
  set('brand.protoSubclass', () => { try { const o = Object.create(Date.prototype); return String(o.getTimezoneOffset()); } catch (e) { return 'THROW:' + e.name; } });
  set('brand.protoSubclassToString', () => { try { const o = Object.create(Date.prototype); return o.toString(); } catch (e) { return 'THROW:' + e.name; } });
  set('extreme.year10000', () => new Date(Date.UTC(10000, 0, 1)).toString());
  set('extreme.year10000Date', () => new Date(Date.UTC(10000, 0, 1)).toDateString());
  set('extreme.year0', () => { const d = new Date(Date.UTC(0, 0, 1)); return [d.toString(), d.toISOString(), d.getFullYear()]; });
  set('extreme.yearNeg', () => { const d = new Date(Date.UTC(-1, 0, 1)); return [d.toString(), d.getFullYear()]; });
  set('extreme.roundTripTm', () => { const d = new Date(Date.UTC(275760, 8, 13)); return [d.toString(), d.getTime()]; });
  set('meta.dateMethods', () => ['toString', 'toTimeString', 'toDateString', 'getTimezoneOffset', 'getHours', 'setHours'].map((k) => k + ':' + Date.prototype[k].name + '/' + Date.prototype[k].length + '/' + String(Date.prototype[k]).slice(0, 30)).join('|'));
  set('meta.dateProtoOwn', () => Object.getOwnPropertyNames(Date.prototype).length + ':' + Object.getOwnPropertyNames(Date.prototype).sort().join(','));
  set('meta.intlProps', () => Object.getOwnPropertyNames(Intl.DateTimeFormat).sort().join(',') + '|' + Object.getOwnPropertyNames(Intl.DateTimeFormat.prototype).sort().join(','));
  set('meta.intlCallForm', () => { try { return String(Intl.DateTimeFormat.call({}, 'en-US')); } catch (e) { return 'THROW:' + e.name; } });
  set('getterAccess', () => { let reads = 0; const options = {}; Object.defineProperty(options, 'timeZone', { enumerable: true, get() { reads += 1; return 'UTC'; } }); const fmt = new Intl.DateTimeFormat('en-US', options); return [reads, fmt.resolvedOptions().timeZone]; });
  set('getterThrows', () => { const options = {}; Object.defineProperty(options, 'timeZone', { enumerable: true, get() { throw new RangeError('tz-getter'); } }); try { new Intl.DateTimeFormat('en-US', options); return 'NO_THROW'; } catch (e) { return e.name + ':' + e.message; } });
  set('optionsFrozen', () => { const options = Object.freeze({ hour: '2-digit' }); return new Intl.DateTimeFormat('en-US', options).resolvedOptions().timeZone; });
  // Sub-frame realms: a real browser hands every frame its own realm objects.
  set('iframe.realm', () => {
    const f = document.createElement('iframe');
    f.srcdoc = '<html><body>frame</body></html>';
    document.body.appendChild(f);
    const w = f.contentWindow;
    const out = [w.Date === Date, w.Date.prototype === Date.prototype, w.Intl.DateTimeFormat === Intl.DateTimeFormat, (new w.Date(0)) instanceof Date, w.Date.name, typeof w.Date];
    f.remove();
    return out;
  });
  set('iframe.toString', () => {
    const f = document.createElement('iframe');
    f.srcdoc = '<html><body>frame</body></html>';
    document.body.appendChild(f);
    const w = f.contentWindow;
    const out = [String(w.Date.prototype.toString.call(new w.Date(1752600000000))), w.Intl.DateTimeFormat.prototype.constructor === w.Intl.DateTimeFormat];
    f.remove();
    return out;
  });
  set('extreme.yearNegOffset', () => { const d = new Date(Date.UTC(-1, 0, 1)); const n = new Intl.DateTimeFormat('en-US', { timeZoneName: 'longOffset' }).formatToParts(d).filter((p) => p.type === 'timeZoneName').map((p) => p.value).join(''); return [d.getTimezoneOffset(), n]; });
  set('extreme.year10000Offset', () => new Date(Date.UTC(10000, 0, 1)).getTimezoneOffset());
  set('extreme.tmOffset', () => new Date(8640000000000000).getTimezoneOffset());
  set('extreme.negGetFullYear', () => { const d = new Date(Date.UTC(-1, 0, 1)); return [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getTimezoneOffset()]; });
  set('opts.null', () => { try { return 'OK:' + new Intl.DateTimeFormat('en-US', null).resolvedOptions().timeZone; } catch (e) { return 'THROW:' + e.name; } });
  set('opts.number', () => { try { return 'OK:' + new Intl.DateTimeFormat('en-US', 5).resolvedOptions().timeZone; } catch (e) { return 'THROW:' + e.name; } });
  set('opts.string', () => { try { return 'OK:' + new Intl.DateTimeFormat('en-US', 'en').resolvedOptions().timeZone; } catch (e) { return 'THROW:' + e.name; } });
  set('opts.bool', () => { try { return 'OK:' + new Intl.DateTimeFormat('en-US', true).resolvedOptions().timeZone; } catch (e) { return 'THROW:' + e.name; } });
  set('opts.getterHour', () => { let reads = 0; const options = {}; Object.defineProperty(options, 'hour', { enumerable: true, get() { reads += 1; return '2-digit'; } }); const f = new Intl.DateTimeFormat('en-US', options); return [reads, f.resolvedOptions().hour]; });
  set('opts.getterNoTz', () => { let reads = 0; const options = {}; Object.defineProperty(options, 'minute', { enumerable: true, get() { reads += 1; return '2-digit'; } }); const f = new Intl.DateTimeFormat('en-US', options); return [reads, f.resolvedOptions().timeZone, f.resolvedOptions().minute]; });
  set('resolvedVsString', () => {
    const tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const long = new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' }).formatToParts(new Date(1752600000000)).filter((p) => p.type === 'timeZoneName').map((p) => p.value).join('');
    return [tz, long];
  });
  return JSON.stringify(out);
})()`;

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m = null; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) { const { res, timer } = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(timer); res(m); }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq; const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res) => {
      const timer = setTimeout(() => { this.pending.delete(id); res({ error: 'timeout', method }); }, 60000);
      this.pending.set(id, { res, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }
}

async function runCase(entry, mode) {
  const inject = mode === 'production';
  const scriptOnly = mode === 'fallback';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-tzfp-'));
  const profile = {
    id: 'tzfp', name: 'tzfp', kernelVersion: '148.0.7778.165', os: 'windows', userAgent: WINDOWS_UA,
    canvas: 'noise', webgl: 'noise', cores: 8, memory: 8,
    privacy: (inject || scriptOnly)
      ? { timezoneMode: 'custom', timezone: entry.tz, fingerprint: { languages: [entry.locale] } }
      : {},
  };
  const fp = buildFingerprint(profile);
  if (inject || scriptOnly) {
    await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, 'init_template.json') });
  }
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>tz</body></html>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const child = spawn(launcher, [dir, '--headless=new'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });
  child.unref();
  let port = null;
  for (let i = 0; i < 90; i += 1) {
    await sleep(400);
    try {
      const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (p > 0) { port = p; break; }
    } catch (_) {}
  }
  const stop = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { server.close(); } catch (_) {}
  };
  if (!port) { stop(); return { error: 'no devtools port' }; }
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; ws.onerror = r; });
  const cdp = new Cdp(ws);
  const out = {};
  try {
    const targets = await cdp.send('Target.getTargets', {});
    const page = ((targets.result || {}).targetInfos || []).find((t) => t.type === 'page');
    const att = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const sid = att.result.sessionId;
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Page.navigate', { url }, sid);
    await sleep(1200);
    if (inject) {
      await applyFingerprintToTab((m, p) => cdp.send(m, p, sid), null, fp, profile, { applyKey: `tzfp-${mode}-${Date.now()}` });
      await sleep(400);
    } else {
      await cdp.send('Emulation.setLocaleOverride', { locale: entry.locale }, sid);
      if (scriptOnly) {
        // No timezone override on purpose: the script layer is the only thing that can answer here,
        // which is the situation it exists for.
        const source = buildInjectionScript(fp);
        // Registered as well as evaluated, so frames that start later carry it too.
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, sid);
        await cdp.send('Runtime.evaluate', { expression: source, returnByValue: true }, sid);
        await sleep(400);
      } else {
        await cdp.send('Emulation.setTimezoneOverride', { timezoneId: entry.tz }, sid);
      }
    }
    const m = await cdp.send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true }, sid);
    const value = m && m.result && m.result.result ? m.result.result.value : null;
    out.observations = value ? JSON.parse(value) : { error: 'no value', raw: JSON.stringify(m).slice(0, 240) };
  } catch (error) {
    out.error = String((error && error.message) || error);
  }
  try { ws.close(); } catch (_) {}
  stop();
  return out;
}

function firstDifference(reference, candidate) {
  const keys = Array.from(new Set([...Object.keys(reference || {}), ...Object.keys(candidate || {})])).sort();
  for (const key of keys) {
    const a = reference ? reference[key] : undefined;
    const b = candidate ? candidate[key] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) return { key, reference: a, candidate: b };
  }
  return null;
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('  SKIP  macos-x64 148 kernel launcher unavailable');
    console.log('timezone-fidelity-e2e-selftest: ok');
    return;
  }

  for (const entry of MATRIX) {
    const label = `${entry.tz} / ${entry.locale}`;
    const reference = await runCase(entry, 'reference');
    const production = await runCase(entry, 'production');
    check(`${label}: the probe answers in both runs`, () => {
      assert.ok(reference.observations && !reference.observations.error, `reference: ${reference.error || JSON.stringify(reference.observations).slice(0, 160)}`);
      assert.ok(production.observations && !production.observations.error, `production: ${production.error || JSON.stringify(production.observations).slice(0, 160)}`);
      assert.ok(Object.keys(reference.observations).length > 100, 'the reference probe must cover the whole surface');
    });
    check(`${label}: the inject reports exactly what the engine reports natively`, () => {
      const diff = firstDifference(reference.observations, production.observations);
      assert.strictEqual(diff, null, diff ? `${diff.key}: reference=${String(diff.reference).slice(0, 120)} production=${String(diff.candidate).slice(0, 120)}` : '');
    });
  }

  // The script layer has to keep working when nothing else put the engine in the target zone, and it
  // has to do so without reassigning another realm's constructors.
  const fallbackEntry = { tz: 'Australia/Lord_Howe', locale: 'en-US' };
  const fallback = await runCase(fallbackEntry, 'fallback');
  check('the fallback path spoofs the zone when the engine is not in it', () => {
    assert.ok(fallback.observations && !fallback.observations.error, `fallback: ${fallback.error || JSON.stringify(fallback.observations).slice(0, 160)}`);
    // The probe serialises every observation, so structured values come back as JSON text.
    assert.strictEqual(JSON.parse(fallback.observations['resolvedOptions']).timeZone, 'Australia/Lord_Howe', 'resolvedOptions().timeZone');
    assert.ok(/\(Lord Howe (Standard|Daylight) Time\)/.test(fallback.observations['date.summer.toString']), `toString zone name: ${fallback.observations['date.summer.toString']}`);
    // July is winter in this zone: standard time is +10:30, which getTimezoneOffset reports as -630.
    assert.strictEqual(Number(fallback.observations['date.summer.getTimezoneOffset']), -630, 'the July offset is +10:30');
  });
  check('the fallback path does not claim another realm constructor', () => {
    assert.deepStrictEqual(JSON.parse(fallback.observations['iframe.realm']), [false, false, false, false, 'Date', 'function'], 'frame Date must stay its own');
  });

  // The fallback runs on its own, so it gets the full comparison as well. The only accepted
  // differences are the zone-name texts V8 prints for instants that predate the zone metazone data
  // (the engine answers those from an internal ICU call that Intl does not expose); everything else
  // - offsets, wall clocks, brand checks, option reads - has to match the native run too.
  const fallbackReference = await runCase(fallbackEntry, 'reference');
  check('the fallback path differs from the engine only in documented historical zone names', () => {
    assert.ok(fallbackReference.observations && !fallbackReference.observations.error, 'reference run for the fallback');
    const keys = Array.from(new Set([...Object.keys(fallbackReference.observations), ...Object.keys(fallback.observations)])).sort();
    const diffKeys = keys.filter((k) => JSON.stringify(fallbackReference.observations[k]) !== JSON.stringify(fallback.observations[k]));
    const allowed = /^(date\.y(1880|1900|1969)\.(toString|toTimeString)|extreme\.(year0|yearNeg|roundTripTm|year10000)(\.toString)?)$/;
    const unexpected = diffKeys.filter((k) => !allowed.test(k));
    assert.deepStrictEqual(unexpected, [], 'undocumented differences');
    assert.ok(diffKeys.length <= 12, `expected at most the documented historical names, got ${diffKeys.length}`);
  });

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log(`timezone-fidelity-e2e-selftest: OK ${results.length}/${results.length}`);
  else { console.log(`timezone-fidelity-e2e-selftest: FAILED ${failed.length}/${results.length}`); process.exitCode = 1; }
})().catch((err) => {
  console.error('timezone-fidelity-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
