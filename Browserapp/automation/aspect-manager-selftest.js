'use strict';

/** Self-test for the HTTP aspect manager. */

const assert = require('assert');
const {
  AspectManager,
  parseAllParams,
  parseFormData,
  matchesPath,
  safeDecode,
} = require('./aspect-manager');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

const baseContext = (over = {}) => Object.assign({
  path: '/api/profile/open',
  method: 'POST',
  requestBody: '{"profileId":7}',
  requestHeaders: { 'content-type': 'application/json' },
  queryParams: {},
  responseData: { ok: true },
  statusCode: 200,
}, over);

// ---- parameter parsing ----

check('parseFormData decodes percent and plus encoding', () => {
  const parsed = parseFormData('name=hello+world&tag=a%2Fb&empty=');
  assert.strictEqual(parsed.name, 'hello world');
  assert.strictEqual(parsed.tag, 'a/b');
  assert.strictEqual(parsed.empty, '');
});

check('parseFormData tolerates a key without a value', () => {
  assert.deepStrictEqual(parseFormData('flag'), { flag: '' });
});

check('parseFormData survives malformed escapes', () => {
  assert.strictEqual(parseFormData('bad=%E0%A4%A').bad, '%E0%A4%A');
});

check('safeDecode leaves undecodable input intact', () => {
  assert.strictEqual(safeDecode('%'), '%');
  assert.strictEqual(safeDecode('a+b'), 'a b');
});

check('parseAllParams merges query and json body', () => {
  const params = parseAllParams('{"a":1,"b":2}', { c: 3 }, { 'content-type': 'application/json' });
  assert.deepStrictEqual(params, { c: 3, a: 1, b: 2 });
});

check('parseAllParams handles form bodies', () => {
  const params = parseAllParams('a=1&b=two', {}, { 'content-type': 'application/x-www-form-urlencoded' });
  assert.deepStrictEqual(params, { a: '1', b: 'two' });
});

check('parseAllParams falls back to json then form', () => {
  assert.deepStrictEqual(parseAllParams('{"x":9}', {}, {}), { x: 9 });
  assert.deepStrictEqual(parseAllParams('x=9', {}, {}), { x: '9' });
});

check('parseAllParams ignores an unparseable body', () => {
  const params = parseAllParams('{not json}', { q: 1 }, {});
  assert.deepStrictEqual(params, { q: 1 });
});

check('parseAllParams returns query params only when body is empty', () => {
  assert.deepStrictEqual(parseAllParams('', { a: 1 }, {}), { a: 1 });
});

check('parseAllParams handles a json array body without polluting params', () => {
  const params = parseAllParams('[1,2,3]', { a: 1 }, { 'content-type': 'application/json' });
  assert.deepStrictEqual(params, { a: 1 });
});

// ---- path matching ----

check('matchesPath handles exact strings', () => {
  assert.strictEqual(matchesPath('/a', '/a'), true);
  assert.strictEqual(matchesPath('/a', '/b'), false);
  assert.strictEqual(matchesPath(null, '/b'), true);
});

check('matchesPath handles regexes', () => {
  assert.strictEqual(matchesPath(/^\/api\//, '/api/x'), true);
  assert.strictEqual(matchesPath(/^\/api\//, '/web/x'), false);
});

check('matchesPath stays stable for global regexes', () => {
  const pattern = /\/open/g;
  for (let i = 0; i < 5; i += 1) {
    assert.strictEqual(matchesPath(pattern, '/api/profile/open'), true, `call ${i} must match`);
  }
});

// ---- before hooks ----

check('executeBefore fires a matching hook', () => {
  const manager = new AspectManager();
  const seen = [];
  manager.before({ path: '/api/profile/open' }, (ctx) => seen.push(ctx.path));
  const fired = manager.executeBefore(baseContext());
  assert.strictEqual(fired, 1);
  assert.deepStrictEqual(seen, ['/api/profile/open']);
});

check('executeBefore skips a non-matching path', () => {
  const manager = new AspectManager();
  let called = false;
  manager.before({ path: '/other' }, () => { called = true; });
  assert.strictEqual(manager.executeBefore(baseContext()), 0);
  assert.strictEqual(called, false);
});

check('parameter matchers gate the hook', () => {
  const manager = new AspectManager();
  const seen = [];
  manager.before({ params: { profileId: 7 } }, (ctx) => seen.push(ctx.parseParams().profileId));
  manager.before({ params: { profileId: 99 } }, () => seen.push('wrong'));
  const fired = manager.executeBefore(baseContext());
  assert.strictEqual(fired, 1);
  assert.deepStrictEqual(seen, [7]);
});

check('before hooks may match on query parameters', () => {
  const manager = new AspectManager();
  let hit = 0;
  manager.before({ params: { action: 'restart' } }, () => { hit += 1; });
  manager.executeBefore(baseContext({ queryParams: { action: 'restart' }, requestBody: '' }));
  assert.strictEqual(hit, 1);
});

check('lazy parameter parsing runs at most once per execution', () => {
  const manager = new AspectManager();
  let parses = 0;
  manager.before({}, (ctx) => {
    const original = ctx.parseParams;
    // Second call must return the cached object, not re-parse.
    assert.strictEqual(ctx.parseParams(), ctx.parseParams());
    void original;
    parses += 1;
  });
  manager.before({ params: {} }, () => {});
  manager.executeBefore(baseContext());
  assert.strictEqual(parses, 1);
});

// ---- after hooks ----

check('executeAfter fires on matching status code', () => {
  const manager = new AspectManager();
  const codes = [];
  manager.after({ path: '/api/profile/open', statusCode: 200 }, (ctx) => codes.push(ctx.statusCode));
  manager.after({ path: '/api/profile/open', statusCode: 500 }, (ctx) => codes.push(ctx.statusCode));
  const fired = manager.executeAfter(baseContext());
  assert.strictEqual(fired, 1);
  assert.deepStrictEqual(codes, [200]);
});

check('after hooks receive response data', () => {
  const manager = new AspectManager();
  let payload = null;
  manager.after({}, (ctx) => { payload = ctx.responseData; });
  manager.executeAfter(baseContext({ responseData: { id: 42 } }));
  assert.deepStrictEqual(payload, { id: 42 });
});

check('after hooks without a status filter fire on any status', () => {
  const manager = new AspectManager();
  let hit = 0;
  manager.after({}, () => { hit += 1; });
  manager.executeAfter(baseContext({ statusCode: 503 }));
  assert.strictEqual(hit, 1);
});

// ---- isolation & bookkeeping ----

check('a throwing hook does not stop the others', () => {
  const manager = new AspectManager();
  const order = [];
  manager.before({}, () => { order.push('first'); throw new Error('boom'); });
  manager.before({}, () => order.push('second'));
  const fired = manager.executeBefore(baseContext());
  assert.strictEqual(fired, 2);
  assert.deepStrictEqual(order, ['first', 'second']);
  const last = manager.getLastError();
  assert.ok(last && last.phase === 'before' && /boom/.test(last.error.message));
});

check('a throwing after hook is contained', () => {
  const manager = new AspectManager();
  manager.after({}, () => { throw new Error('nope'); });
  assert.doesNotThrow(() => manager.executeAfter(baseContext()));
  assert.strictEqual(manager.getLastError().phase, 'after');
});

check('addAspect rejects a non-object config', () => {
  const manager = new AspectManager();
  assert.throws(() => manager.addAspect(null), /must be an object/);
  assert.throws(() => manager.addAspect('x'), /must be an object/);
});

check('addAspects registers several at once and is chainable', () => {
  const manager = new AspectManager();
  const returned = manager.addAspects([{ before: () => {} }, { after: () => {} }]);
  assert.strictEqual(returned, manager);
  assert.strictEqual(manager.count, 2);
});

check('removeAspects reports how many were dropped', () => {
  const manager = new AspectManager();
  const keepHandler = () => {};
  manager.before({ path: '/a' }, keepHandler);
  manager.before({ path: '/b' }, () => {});
  const removed = manager.removeAspects((a) => a.path === '/b');
  assert.strictEqual(removed, 1);
  assert.strictEqual(manager.count, 1);
});

check('clearAspects empties the registry and is chainable', () => {
  const manager = new AspectManager();
  manager.before({}, () => {});
  assert.strictEqual(manager.clearAspects(), manager);
  assert.strictEqual(manager.count, 0);
  assert.strictEqual(manager.executeBefore(baseContext()), 0);
});

check('hooks that are not registered for a phase are skipped', () => {
  const manager = new AspectManager();
  manager.before({}, () => {});
  assert.strictEqual(manager.executeAfter(baseContext()), 0, 'no after hook to run');
});

// ---- report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
console.log(`\nASPECT_MANAGER_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
if (failed.length) process.exitCode = 1;
