'use strict';

/**
 * Profile task queue with independent concurrency lanes.
 *
 * Two task kinds share one ordered queue but have separate limits:
 *   - `open`   : launching a profile, bounded by `openConcurrency`
 *   - `batch`  : long-running background work on an opened profile,
 *                bounded by a per-batch concurrency supplied at enqueue time
 *
 * Enqueueing is idempotent: ids already queued or duplicated within the same
 * request are reported back instead of being queued twice.
 */

const DEFAULT_OPEN_CONCURRENCY = 1;
const MAX_BATCH_CONCURRENCY = 20;

const QUEUED = 'queued';
const OPENING = 'opening';
const PAUSED = 'paused';
const ACTIVE = 'active';

class TaskQueue {
  /** @param {number} [openConcurrency] Simultaneous `open` tasks. */
  constructor(openConcurrency = DEFAULT_OPEN_CONCURRENCY) {
    this.tasks = [];
    this.openingIds = new Set();
    this.activeBatchIds = new Set();
    this.currentBatchConcurrency = undefined;
    this.openConcurrency = this.normalizeOpenConcurrency(openConcurrency);
  }

  // ---- queries ----

  get queueIds() {
    return this.tasks.map((task) => task.profileId);
  }

  get pendingOpenIds() {
    return this.tasks
      .filter((task) => task.state === QUEUED || task.state === OPENING || task.state === PAUSED)
      .map((task) => task.profileId);
  }

  get runningIds() {
    return [...this.openingIds];
  }

  get batchActiveCount() {
    return this.activeBatchIds.size;
  }

  get batchConcurrency() {
    return this.currentBatchConcurrency;
  }

  get hasPendingOrOpening() {
    return this.tasks.some((task) => task.state === QUEUED || task.state === OPENING);
  }

  get size() {
    return this.tasks.length;
  }

  getTask(profileId) {
    return this.tasks.find((task) => task.profileId === profileId);
  }

  getQueuedIds() {
    return this.tasks.filter((task) => task.state === QUEUED).map((task) => task.profileId);
  }

  // ---- configuration ----

  setOpenConcurrency(concurrency) {
    this.openConcurrency = this.normalizeOpenConcurrency(concurrency);
  }

  // ---- enqueue ----

  enqueueOpen(profileIds, prepend = false) {
    const result = this.buildEnqueueResult(profileIds);
    const tasks = result.acceptedIds.map((profileId) => ({
      profileId,
      type: 'open',
      state: QUEUED,
    }));
    this.tasks = prepend ? [...tasks, ...this.tasks] : [...this.tasks, ...tasks];
    return result;
  }

  /**
   * @param {Array<{profileId:number, identity:object}>} items
   * @param {number} concurrency
   */
  enqueueBatch(items, concurrency) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_BATCH_CONCURRENCY) {
      throw new Error(`batch concurrency must be an integer between 1 and ${MAX_BATCH_CONCURRENCY}`);
    }
    if (!this.hasBatchTask()) {
      this.currentBatchConcurrency = concurrency;
    }

    const result = this.buildEnqueueResult(items.map((item) => item.profileId));
    const byId = new Map();
    for (const item of items) {
      if (!byId.has(item.profileId)) byId.set(item.profileId, item);
    }

    const accepted = result.acceptedIds.map((profileId) => {
      const item = byId.get(profileId);
      if (!item) throw new Error(`missing task identity for profile ${profileId}`);
      return {
        profileId,
        type: 'batch',
        state: QUEUED,
        identity: item.identity,
      };
    });
    this.tasks.push(...accepted);

    return Object.assign({}, result, {
      concurrency: this.currentBatchConcurrency == null ? concurrency : this.currentBatchConcurrency,
    });
  }

  // ---- scheduling ----

  /** Claim the next runnable task, respecting each lane's concurrency. */
  acquireNext() {
    const task = this.tasks.find((candidate) => {
      if (candidate.state !== QUEUED) return false;
      if (candidate.type === 'open') {
        return this.countOpening('open') < this.openConcurrency;
      }
      return typeof this.currentBatchConcurrency === 'number'
        && this.activeBatchIds.size < this.currentBatchConcurrency;
    });
    if (!task) return undefined;

    task.state = OPENING;
    this.openingIds.add(task.profileId);
    if (task.type === 'batch') this.activeBatchIds.add(task.profileId);
    return Object.assign({}, task);
  }

  /**
   * Report the outcome of an `open` task.
   *
   * A successful batch task moves to `active` and **keeps occupying its lane
   * slot** until `completeBatch` is called — this models "work is running on
   * this profile". Anything else is removed and frees its slot right away.
   */
  settleOpen(profileId, success) {
    const task = this.getTask(profileId);
    if (!task || task.state !== OPENING || !this.openingIds.has(profileId)) return undefined;

    this.openingIds.delete(profileId);
    if (task.type === 'batch' && success) {
      task.state = ACTIVE;
      return Object.assign({}, task);
    }
    this.removeTask(profileId);
    return Object.assign({}, task);
  }

  pauseBatchOpen(profileId, identity) {
    const task = this.getTask(profileId);
    if (
      !task || task.type !== 'batch' || task.state !== OPENING
      || !this.openingIds.has(profileId)
      || !sameIdentity(task.identity, identity)
    ) {
      return undefined;
    }
    this.openingIds.delete(profileId);
    this.activeBatchIds.delete(profileId);
    task.state = PAUSED;
    return Object.assign({}, task);
  }

  resumeBatch(profileId, identity) {
    const task = this.getTask(profileId);
    if (!task || task.type !== 'batch' || task.state !== PAUSED || !sameIdentity(task.identity, identity)) {
      return false;
    }
    task.state = QUEUED;
    return true;
  }

  completeBatch(profileId, identity) {
    const task = this.getTask(profileId);
    if (!task || task.type !== 'batch' || !sameIdentity(task.identity, identity)) return false;
    this.removeTask(profileId);
    return true;
  }

  // ---- removal ----

  cancel(profileId) {
    const task = this.getTask(profileId);
    if (!task) return undefined;
    this.removeTask(profileId);
    return Object.assign({}, task);
  }

  clear() {
    const snapshot = this.tasks.map((task) => Object.assign({}, task));
    this.tasks = [];
    this.openingIds.clear();
    this.activeBatchIds.clear();
    this.currentBatchConcurrency = undefined;
    return snapshot;
  }

  /** Drop every not-yet-finished task and return what was removed. */
  cancelPending() {
    const cancelled = this.tasks
      .filter((task) => task.state === QUEUED || task.state === OPENING || task.state === PAUSED)
      .map((task) => Object.assign({}, task));
    if (!cancelled.length) return [];

    const ids = new Set(cancelled.map((task) => task.profileId));
    this.tasks = this.tasks.filter((task) => !ids.has(task.profileId));
    for (const id of ids) {
      this.openingIds.delete(id);
      this.activeBatchIds.delete(id);
    }
    if (!this.hasBatchTask()) this.currentBatchConcurrency = undefined;
    return cancelled;
  }

  // ---- internals ----

  buildEnqueueResult(profileIds) {
    const existing = new Set(this.queueIds);
    const seen = new Set();
    const acceptedIds = [];
    const skipped = [];

    for (const profileId of profileIds) {
      if (existing.has(profileId)) {
        skipped.push({ profileId, reason: 'ALREADY_IN_QUEUE' });
        continue;
      }
      if (seen.has(profileId)) {
        skipped.push({ profileId, reason: 'DUPLICATE_INPUT' });
        continue;
      }
      seen.add(profileId);
      acceptedIds.push(profileId);
    }
    return { acceptedIds, skipped };
  }

  removeTask(profileId) {
    this.tasks = this.tasks.filter((task) => task.profileId !== profileId);
    this.openingIds.delete(profileId);
    this.activeBatchIds.delete(profileId);
    if (!this.hasBatchTask()) this.currentBatchConcurrency = undefined;
  }

  hasBatchTask() {
    return this.tasks.some((task) => task.type === 'batch');
  }

  countOpening(type) {
    return this.tasks.filter(
      (task) => task.type === type && task.state === OPENING && this.openingIds.has(task.profileId)
    ).length;
  }

  normalizeOpenConcurrency(concurrency) {
    return Number.isInteger(concurrency) && concurrency > 0 ? concurrency : DEFAULT_OPEN_CONCURRENCY;
  }
}

function sameIdentity(left, right) {
  if (!left || !right) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

module.exports = {
  TaskQueue,
  sameIdentity,
  DEFAULT_OPEN_CONCURRENCY,
  MAX_BATCH_CONCURRENCY,
  STATES: { QUEUED, OPENING, PAUSED, ACTIVE },
};
