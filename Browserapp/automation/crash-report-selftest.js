'use strict';

/**
 * Self-test for structured crash reporting.
 */

const assert = require('assert');
const c = require('./crash-report');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

const PROCESS_INFO = {
  pid: 999,
  versions: { electron: '22.3.24' },
  platform: 'darwin',
  arch: 'arm64',
};
const APP_INFO = { version: '1.0.8' };

function contents(overrides = {}) {
  return Object.assign({
    id: 42,
    getTitle: () => 'Checkout',
    getURL: () => 'https://example.com/ok?page=2',
    isDestroyed: () => false,
  }, overrides);
}

// ---- renderer reports ----

check('a renderer report carries context, page and crash details', () => {
  const r = c.buildRenderProcessGoneReport({
    details: { reason: 'crashed', exitCode: 139 },
    event: { type: 'render-process-gone', sender: { id: 3 } },
    webContents: contents(),
    processInfo: PROCESS_INFO,
    appInfo: APP_INFO,
  });

  assert.strictEqual(r.context.mainProcessId, 999);
  assert.strictEqual(r.context.appVersion, '1.0.8');
  assert.strictEqual(r.context.runtimeVersion, '22.3.24');
  assert.strictEqual(r.context.platform, 'darwin');
  assert.strictEqual(r.event.type, 'render-process-gone');
  assert.strictEqual(r.event.senderProcessId, 3);
  assert.strictEqual(r.page.renderProcessId, 42);
  assert.strictEqual(r.page.title, 'Checkout');
  assert.strictEqual(r.page.destroyed, false);
  assert.strictEqual(r.crash.reason, 'crashed');
  assert.strictEqual(r.crash.exitCode, 139);
  assert.match(r.crash.description, /stopped unexpectedly/);
});

check('a crash url is sanitised rather than merely truncated', () => {
  const r = c.buildRenderProcessGoneReport({
    details: { reason: 'crashed' },
    webContents: contents({ getURL: () => 'https://shop.example.com/cb?token=SECRET123&page=2' }),
  });
  assert.ok(!r.page.url.includes('SECRET123'), 'the raw token must not reach the log');
  assert.ok(r.page.url.includes('page=2'), 'ordinary parameters stay readable');
  assert.ok(r.page.url.includes('shop.example.com'), 'the host stays diagnosable');
});

check('a crash url is bounded', () => {
  const long = 'https://example.com/' + 'a'.repeat(2000);
  const r = c.buildRenderProcessGoneReport({
    details: { reason: 'crashed' },
    webContents: contents({ getURL: () => long }),
  });
  assert.strictEqual(r.page.url.length, c.MAX_URL_LENGTH);
});

check('a destroyed web content degrades field by field', () => {
  const boom = () => { throw new Error('Object has been destroyed'); };
  const r = c.buildRenderProcessGoneReport({
    details: { reason: 'killed', exitCode: 9 },
    event: { type: 'render-process-gone' },
    webContents: { id: 7, getTitle: boom, getURL: boom, isDestroyed: () => true },
    processInfo: PROCESS_INFO,
    appInfo: APP_INFO,
  });

  assert.strictEqual(r.page.destroyed, true);
  assert.strictEqual(r.page.title, '', 'an unreadable title falls back');
  assert.strictEqual(r.page.url, '', 'an unreadable url falls back');
  assert.strictEqual(r.page.renderProcessId, 7, 'fields that did read are kept');
  assert.strictEqual(r.crash.reason, 'killed', 'the crash details still survive');
});

check('a missing web content produces a null page rather than an empty one', () => {
  const r = c.buildRenderProcessGoneReport({
    details: { reason: 'oom' },
    processInfo: PROCESS_INFO,
    appInfo: APP_INFO,
  });
  assert.strictEqual(r.page, null);
  assert.strictEqual(r.crash.reason, 'oom');
});

check('an empty input still yields a well-formed report', () => {
  const r = c.buildRenderProcessGoneReport();
  assert.strictEqual(r.page, null);
  assert.strictEqual(r.crash.reason, null);
  assert.strictEqual(r.crash.exitCode, null);
  assert.strictEqual(r.context.mainProcessId, null);
  assert.ok(typeof r.crash.description === 'string' && r.crash.description.length > 0);
});

check('a missing exit code stays null rather than becoming zero', () => {
  const r = c.buildRenderProcessGoneReport({ details: { reason: 'crashed' } });
  assert.strictEqual(r.crash.exitCode, null);
  const zero = c.buildRenderProcessGoneReport({ details: { reason: 'crashed', exitCode: 0 } });
  assert.strictEqual(zero.crash.exitCode, 0, 'a real zero is preserved');
});

// ---- reason descriptions ----

check('known reasons are described in operator terms', () => {
  assert.match(c.describeReason('oom', 'renderer'), /ran out of memory/);
  assert.match(c.describeReason('launch-failed', 'renderer'), /could not be started/);
  assert.match(c.describeReason('integrity-failure', 'renderer'), /integrity/);
  assert.match(c.describeReason('abnormal-exit', 'helper'), /abnormally/);
});

check('an unknown or absent reason is still reported verbatim', () => {
  assert.match(c.describeReason('something-new'), /something-new/);
  assert.match(c.describeReason(undefined), /unknown/);
  assert.match(c.describeReason(''), /unknown/);
});

check('helper and renderer descriptions come from different tables', () => {
  assert.notStrictEqual(c.describeReason('crashed', 'helper'), c.describeReason('crashed', 'renderer'));
});

// ---- helper reports ----

check('a helper report names the process and its role', () => {
  const r = c.buildHelperProcessGoneReport({
    details: { type: 'GPU', reason: 'crashed', exitCode: 1, name: 'gpu-process', serviceName: '' },
    processInfo: PROCESS_INFO,
    appInfo: APP_INFO,
  });
  assert.strictEqual(r.helper.type, 'GPU');
  assert.strictEqual(r.helper.name, 'gpu-process');
  assert.strictEqual(r.helper.reason, 'crashed');
  assert.strictEqual(r.helper.exitCode, 1);
  assert.match(r.helper.description, /helper process/);
  assert.strictEqual(r.context.platform, 'darwin');
});

check('a helper report has no page section and tolerates empty input', () => {
  const r = c.buildHelperProcessGoneReport();
  assert.strictEqual(r.page, undefined);
  assert.strictEqual(r.helper.type, null);
  assert.strictEqual(r.helper.reason, null);
});

// ---- formatting ----

check('a report formats as one labelled line', () => {
  const line = c.formatCrashReport({ a: 1 }, 'renderer-process-gone');
  assert.ok(line.startsWith('renderer-process-gone '));
  assert.deepStrictEqual(JSON.parse(line.slice('renderer-process-gone '.length)), { a: 1 });
});

check('formatting uses a default label and survives a circular object', () => {
  assert.ok(c.formatCrashReport({ a: 1 }).startsWith('process-gone '));
  const circular = {};
  circular.self = circular;
  const line = c.formatCrashReport(circular, 'x');
  assert.ok(line.startsWith('x '));
  assert.match(line, /not serialisable/);
});

// ---- handler ----

check('the handler reports once and returns the report', () => {
  const seen = [];
  const handler = c.createCrashHandler({
    log: (line, report) => seen.push({ line, report }),
    processInfo: PROCESS_INFO,
    appInfo: APP_INFO,
  });
  const report = handler(
    { type: 'render-process-gone', sender: { id: 1 } },
    { reason: 'oom', exitCode: 5 },
    contents(),
  );

  assert.strictEqual(seen.length, 1);
  assert.ok(seen[0].line.startsWith('renderer-process-gone '));
  assert.strictEqual(seen[0].report.crash.reason, 'oom');
  assert.strictEqual(report.crash.reason, 'oom');
});

check('a throwing sink cannot propagate out of the crash handler', () => {
  const handler = c.createCrashHandler({
    log: () => { throw new Error('sink exploded'); },
    processInfo: PROCESS_INFO,
    appInfo: APP_INFO,
  });
  const report = handler({ type: 'x' }, { reason: 'crashed' }, contents());
  assert.strictEqual(report.crash.reason, 'crashed');
});

check('the handler works without a sink and accepts a custom builder', () => {
  const silent = c.createCrashHandler({ processInfo: PROCESS_INFO, appInfo: APP_INFO });
  assert.strictEqual(silent({ type: 'x' }, { reason: 'killed' }, contents()).crash.reason, 'killed');

  let built = 0;
  const custom = c.createCrashHandler({
    build: (input) => { built += 1; return { custom: true, reason: input.details.reason }; },
    processInfo: PROCESS_INFO,
  });
  const r = custom({ type: 'x' }, { reason: 'oom' }, null);
  assert.strictEqual(built, 1);
  assert.deepStrictEqual(r, { custom: true, reason: 'oom' });
});

check('the handler derives the app version through a guarded read', () => {
  const handler = c.createCrashHandler({
    app: { getVersion: () => { throw new Error('not ready'); } },
    processInfo: PROCESS_INFO,
  });
  const r = handler({ type: 'x' }, { reason: 'crashed' }, contents());
  assert.strictEqual(r.context.appVersion, null);
});

// ---- operator attention ----

check('operator attention is requested for recoverable-shape reasons only', () => {
  assert.strictEqual(c.shouldAlertOperator('oom'), true);
  assert.strictEqual(c.shouldAlertOperator('crashed'), true);
  assert.strictEqual(c.shouldAlertOperator('integrity-failure'), true);
  assert.strictEqual(c.shouldAlertOperator('killed'), false, 'a kill is routine');
  assert.strictEqual(c.shouldAlertOperator('nonsense'), false);
  assert.strictEqual(c.shouldAlertOperator(undefined), false);
});

// ---- helpers ----

check('safeRead returns the fallback instead of throwing', () => {
  assert.strictEqual(c.safeRead(() => 7, null), 7);
  assert.strictEqual(c.safeRead(() => undefined, 'fallback'), 'fallback');
  assert.strictEqual(c.safeRead(() => { throw new Error('x'); }, 'fallback'), 'fallback');
});

check('safeUrl sanitises and bounds in one step', () => {
  assert.strictEqual(c.safeUrl('https://a.example/p?q=1'), 'https://a.example/p?q=1');
  assert.ok(!c.safeUrl('https://a.example/cb#access_token=abcdef123456').includes('access_token'));
  assert.strictEqual(c.safeUrl(null), '');
});

// ---- report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
console.log(`\nCRASH_REPORT_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
if (failed.length) process.exitCode = 1;
