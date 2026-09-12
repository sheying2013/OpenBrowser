'use strict';

/** Self-test for the profile task queue. Offline, no timing dependencies. */

const assert = require('assert');
const { TaskQueue, sameIdentity } = require('./task-queue');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

const identity = (n) => ({ protocolVersion: 1, batchId: `b${n}`, taskId: `t${n}` });

// ---- enqueue ----

check('enqueueOpen accepts new ids in order', () => {
  const q = new TaskQueue(2);
  const res = q.enqueueOpen([1, 2, 3]);
  assert.deepStrictEqual(res.acceptedIds, [1, 2, 3]);
  assert.deepStrictEqual(res.skipped, []);
  assert.deepStrictEqual(q.queueIds, [1, 2, 3]);
});

check('enqueueOpen reports ids already queued', () => {
  const q = new TaskQueue();
  q.enqueueOpen([1, 2]);
  const res = q.enqueueOpen([2, 3]);
  assert.deepStrictEqual(res.acceptedIds, [3]);
  assert.deepStrictEqual(res.skipped, [{ profileId: 2, reason: 'ALREADY_IN_QUEUE' }]);
});

check('enqueueOpen reports duplicates inside one request', () => {
  const q = new TaskQueue();
  const res = q.enqueueOpen([7, 7, 8]);
  assert.deepStrictEqual(res.acceptedIds, [7, 8]);
  assert.deepStrictEqual(res.skipped, [{ profileId: 7, reason: 'DUPLICATE_INPUT' }]);
});

check('enqueueOpen with prepend puts new ids first', () => {
  const q = new TaskQueue();
  q.enqueueOpen([1, 2]);
  q.enqueueOpen([9], true);
  assert.deepStrictEqual(q.queueIds, [9, 1, 2]);
});

// ---- scheduling ----

check('acquireNext honours the open concurrency limit', () => {
  const q = new TaskQueue(2);
  q.enqueueOpen([1, 2, 3]);
  const first = q.acquireNext();
  const second = q.acquireNext();
  const third = q.acquireNext();
  assert.strictEqual(first.profileId, 1);
  assert.strictEqual(second.profileId, 2);
  assert.strictEqual(third, undefined, 'third must wait for a free slot');
  assert.deepStrictEqual(q.runningIds, [1, 2]);
});

check('acquireNext marks tasks as opening', () => {
  const q = new TaskQueue(1);
  q.enqueueOpen([5]);
  assert.strictEqual(q.acquireNext().state, 'opening');
  assert.strictEqual(q.getTask(5).state, 'opening');
});

check('settleOpen frees a slot so the next task can start', () => {
  const q = new TaskQueue(1);
  q.enqueueOpen([1, 2]);
  q.acquireNext();
  assert.strictEqual(q.acquireNext(), undefined);
  const settled = q.settleOpen(1, true);
  assert.strictEqual(settled.profileId, 1);
  assert.strictEqual(q.acquireNext().profileId, 2);
});

check('settleOpen ignores unknown or non-opening ids', () => {
  const q = new TaskQueue(1);
  q.enqueueOpen([1]);
  assert.strictEqual(q.settleOpen(1, true), undefined, 'still queued');
  assert.strictEqual(q.settleOpen(99, true), undefined, 'unknown');
});

check('concurrency can be raised at runtime', () => {
  const q = new TaskQueue(1);
  q.enqueueOpen([1, 2, 3]);
  q.acquireNext();
  assert.strictEqual(q.acquireNext(), undefined);
  q.setOpenConcurrency(3);
  assert.strictEqual(q.acquireNext().profileId, 2);
});

check('invalid open concurrency falls back to 1', () => {
  const q = new TaskQueue(0);
  assert.strictEqual(q.openConcurrency, 1);
  q.setOpenConcurrency(-5);
  assert.strictEqual(q.openConcurrency, 1);
});

// ---- batch lane ----

check('enqueueBatch records identity and concurrency', () => {
  const q = new TaskQueue(1);
  const res = q.enqueueBatch([{ profileId: 1, identity: identity(1) }], 4);
  assert.deepStrictEqual(res.acceptedIds, [1]);
  assert.strictEqual(res.concurrency, 4);
  assert.deepStrictEqual(q.getTask(1).identity, identity(1));
});

check('enqueueBatch rejects out-of-range concurrency', () => {
  const q = new TaskQueue();
  assert.throws(() => q.enqueueBatch([{ profileId: 1, identity: identity(1) }], 0), /between 1 and 20/);
  assert.throws(() => q.enqueueBatch([{ profileId: 1, identity: identity(1) }], 21), /between 1 and 20/);
  assert.throws(() => q.enqueueBatch([{ profileId: 1, identity: identity(1) }], 2.5), /between 1 and 20/);
});

check('batch tasks respect their own concurrency separately from open tasks', () => {
  const q = new TaskQueue(1);
  q.enqueueBatch([
    { profileId: 1, identity: identity(1) },
    { profileId: 2, identity: identity(2) },
    { profileId: 3, identity: identity(3) },
  ], 2);
  const a = q.acquireNext();
  const b = q.acquireNext();
  assert.ok(a && b, 'two batch tasks admitted');
  assert.strictEqual(q.acquireNext(), undefined, 'third blocked by batch limit');
  assert.strictEqual(q.batchActiveCount, 2);
});

check('successful batch open becomes active and keeps holding a slot', () => {
  const q = new TaskQueue(1);
  q.enqueueBatch([
    { profileId: 1, identity: identity(1) },
    { profileId: 2, identity: identity(2) },
  ], 1);

  q.acquireNext();
  const active = q.settleOpen(1, true);
  assert.strictEqual(active.state, 'active');
  assert.strictEqual(q.getTask(1).state, 'active');
  assert.strictEqual(q.acquireNext(), undefined, 'active batch still occupies its lane slot');
  assert.strictEqual(q.batchActiveCount, 1);

  // Finishing the batch frees the slot for the next queued task.
  assert.strictEqual(q.completeBatch(1, identity(1)), true);
  assert.strictEqual(q.batchActiveCount, 0);
  assert.strictEqual(q.acquireNext().profileId, 2);
});

check('failed batch open releases its slot immediately', () => {
  const q = new TaskQueue(1);
  q.enqueueBatch([
    { profileId: 1, identity: identity(1) },
    { profileId: 2, identity: identity(2) },
  ], 1);

  q.acquireNext();
  const dropped = q.settleOpen(1, false);
  assert.strictEqual(dropped.profileId, 1);
  assert.strictEqual(q.getTask(1), undefined);
  assert.strictEqual(q.batchActiveCount, 0);
  assert.strictEqual(q.acquireNext().profileId, 2, 'next task admitted after failure');
});

check('pause and resume require a matching identity', () => {
  const q = new TaskQueue(1);
  q.enqueueBatch([{ profileId: 1, identity: identity(1) }], 1);
  q.acquireNext();

  assert.strictEqual(q.pauseBatchOpen(1, identity(99)), undefined, 'wrong identity rejected');
  const paused = q.pauseBatchOpen(1, identity(1));
  assert.strictEqual(paused.state, 'paused');
  assert.strictEqual(q.resumeBatch(1, identity(99)), false, 'wrong identity cannot resume');
  assert.strictEqual(q.resumeBatch(1, identity(1)), true);
  assert.strictEqual(q.getTask(1).state, 'queued');
});

check('completeBatch removes only on identity match', () => {
  const q = new TaskQueue(1);
  q.enqueueBatch([{ profileId: 1, identity: identity(1) }], 1);
  assert.strictEqual(q.completeBatch(1, identity(99)), false);
  assert.strictEqual(q.completeBatch(1, identity(1)), true);
  assert.strictEqual(q.size, 0);
});

check('batch concurrency lock releases when no batch tasks remain', () => {
  const q = new TaskQueue(1);
  q.enqueueBatch([{ profileId: 1, identity: identity(1) }], 5);
  assert.strictEqual(q.batchConcurrency, 5);
  q.cancel(1);
  assert.strictEqual(q.batchConcurrency, undefined, 'lock cleared with the last batch task');
});

// ---- removal ----

check('cancel removes a single task and returns it', () => {
  const q = new TaskQueue();
  q.enqueueOpen([1, 2]);
  const removed = q.cancel(1);
  assert.strictEqual(removed.profileId, 1);
  assert.deepStrictEqual(q.queueIds, [2]);
  assert.strictEqual(q.cancel(99), undefined);
});

check('cancelPending clears queued, opening and paused tasks', () => {
  const q = new TaskQueue(1);
  q.enqueueOpen([1, 2]);
  q.enqueueBatch([{ profileId: 3, identity: identity(3) }], 1);
  q.acquireNext(); // 1 -> opening
  const cancelled = q.cancelPending();
  assert.deepStrictEqual(cancelled.map((t) => t.profileId).sort(), [1, 2, 3]);
  assert.strictEqual(q.size, 0);
  assert.strictEqual(q.runningIds.length, 0);
});

check('cancelPending returns an empty list when nothing is pending', () => {
  const q = new TaskQueue();
  assert.deepStrictEqual(q.cancelPending(), []);
});

check('clear resets every lane and returns a snapshot', () => {
  const q = new TaskQueue(2);
  q.enqueueOpen([1, 2]);
  q.enqueueBatch([{ profileId: 3, identity: identity(3) }], 2);
  q.acquireNext();
  const snapshot = q.clear();
  assert.strictEqual(snapshot.length, 3);
  assert.strictEqual(q.size, 0);
  assert.strictEqual(q.batchConcurrency, undefined);
  assert.deepStrictEqual(q.pendingOpenIds, []);
});

// ---- computed state ----

check('pendingOpenIds and getQueuedIds reflect task states', () => {
  const q = new TaskQueue(1);
  q.enqueueOpen([1, 2]);
  assert.deepStrictEqual(q.pendingOpenIds, [1, 2]);
  assert.deepStrictEqual(q.getQueuedIds(), [1, 2]);
  q.acquireNext();
  assert.deepStrictEqual(q.pendingOpenIds, [1, 2], 'opening still pending');
  assert.deepStrictEqual(q.getQueuedIds(), [2]);
});

check('hasPendingOrOpening tracks in-flight work', () => {
  const q = new TaskQueue(1);
  assert.strictEqual(q.hasPendingOrOpening, false);
  q.enqueueOpen([1]);
  assert.strictEqual(q.hasPendingOrOpening, true);
  q.acquireNext();
  q.settleOpen(1, true);
  assert.strictEqual(q.hasPendingOrOpening, false);
});

check('sameIdentity compares all keys regardless of order', () => {
  assert.strictEqual(sameIdentity({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.strictEqual(sameIdentity({ a: 1 }, { a: 2 }), false);
  assert.strictEqual(sameIdentity({ a: 1 }, { a: 1, b: 2 }), false);
  assert.strictEqual(sameIdentity(null, { a: 1 }), false);
});

// ---- report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
console.log(`\nTASK_QUEUE_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
if (failed.length) process.exitCode = 1;
