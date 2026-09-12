'use strict';

/**
 * Bounded-concurrency task scheduler.
 *
 * Runs async jobs with a cap on simultaneous execution. With a concurrency of
 * one the scheduler behaves as a serial queue, optionally leaving a gap
 * between jobs so a burst of work does not hammer a downstream service.
 *
 * Two properties matter for correctness here:
 *
 *   1. A rejected job must release its slot. Otherwise one failure stops the
 *      queue from ever draining.
 *   2. A timed-out job must not hold its slot while the underlying work keeps
 *      running. The wait is bounded and the slot is released on timeout.
 *
 * Schedulers are named so callers can share one instance per concern.
 */

const DEFAULT_CONCURRENCY = 1;

/** Reject after `ms`, and clear the timer whichever way the race resolves. */
function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`task timed out after ${ms}ms`), { code: 'ETIMEDOUT' }));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class TaskScheduler {
  /**
   * @param {object} [options]
   * @param {string} [options.name] Label used in diagnostics.
   * @param {number} [options.concurrency] Maximum simultaneous jobs.
   * @param {number} [options.serialInterval] Delay between jobs when serial.
   * @param {number} [options.defaultTimeout] Timeout applied when a job omits one.
   * @param {(ms:number)=>Promise<void>} [options.sleep] Pause implementation, so the
   *   spacing policy can be observed without waiting on the wall clock.
   */
  constructor(options = {}) {
    this.name = options.name || 'default';
    this.concurrency = normalizeConcurrency(options.concurrency);
    this.serialInterval = Number.isFinite(options.serialInterval) && options.serialInterval > 0
      ? Number(options.serialInterval)
      : 0;
    this.defaultTimeout = Number.isFinite(options.defaultTimeout) && options.defaultTimeout > 0
      ? Number(options.defaultTimeout)
      : 0;
    this.sleep = typeof options.sleep === 'function' ? options.sleep : sleep;

    this.pending = [];
    this.running = 0;
    this.destroyed = false;
    this.completedCount = 0;
    this.failedCount = 0;
    this.timedOutCount = 0;
    this.onError = typeof options.onError === 'function' ? options.onError : null;
  }

  get size() {
    return this.pending.length;
  }

  get busy() {
    return this.running > 0 || this.pending.length > 0;
  }

  stats() {
    return {
      name: this.name,
      concurrency: this.concurrency,
      running: this.running,
      pending: this.pending.length,
      completed: this.completedCount,
      failed: this.failedCount,
      timedOut: this.timedOutCount,
      destroyed: this.destroyed,
    };
  }

  /**
   * Queue a job.
   *
   * @param {(payload:*) => Promise<*>} handle
   * @param {*} [payload]
   * @param {{stepName?:string, timeout?:number}} [options]
   * @returns {Promise<*>} Resolves or rejects with the job outcome.
   */
  schedule(handle, payload, options = {}) {
    if (typeof handle !== 'function') {
      return Promise.reject(new TypeError('task handler must be a function'));
    }
    if (this.destroyed) {
      return Promise.reject(new Error(`scheduler "${this.name}" has been destroyed`));
    }

    return new Promise((resolve, reject) => {
      this.pending.push({
        handle,
        payload,
        stepName: options.stepName || '',
        timeout: Number.isFinite(options.timeout) && options.timeout > 0
          ? Number(options.timeout)
          : this.defaultTimeout,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  /** Start as many queued jobs as the concurrency limit allows. */
  pump() {
    while (!this.destroyed && this.running < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      this.running += 1;
      // `finally` is the single place that frees the slot, so a rejection or a
      // timeout can never strand it.
      this.runJob(job).finally(() => {
        this.running -= 1;
        if (!this.destroyed) this.pump();
      });
    }
  }

  async runJob(job) {
    const label = job.stepName ? `${this.name}.${job.stepName}` : this.name;
    try {
      const work = Promise.resolve().then(() => job.handle(job.payload));
      const result = await withTimeout(work, job.timeout);
      this.completedCount += 1;
      job.resolve(result);
    } catch (err) {
      if (err && err.code === 'ETIMEDOUT') this.timedOutCount += 1;
      else this.failedCount += 1;
      if (this.onError) {
        try { this.onError(err, { name: this.name, stepName: job.stepName }); } catch (_) { /* observer */ }
      }
      job.reject(err);
    } finally {
      if (this.concurrency === 1 && this.serialInterval > 0 && !this.destroyed) {
        await this.sleep(this.serialInterval);
      }
      void label;
    }
  }

  /** Resolve once nothing is running or queued. */
  async drain() {
    while (this.busy) {
      await sleep(5);
    }
  }

  /**
   * Reject everything still queued and stop accepting work.
   * Jobs already running are left to finish on their own.
   * @returns {number} how many queued jobs were rejected
   */
  destroy(reason) {
    this.destroyed = true;
    const dropped = this.pending.length;
    const error = reason instanceof Error ? reason : new Error(`scheduler "${this.name}" was destroyed`);
    for (const job of this.pending) job.reject(error);
    this.pending = [];
    return dropped;
  }

  /** Adjust the concurrency limit and start any jobs that now fit. */
  setConcurrency(next) {
    this.concurrency = normalizeConcurrency(next);
    this.pump();
    return this.concurrency;
  }
}

function normalizeConcurrency(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_CONCURRENCY;
  return n;
}

/** Registry of named schedulers, so callers share one queue per concern. */
class SchedulerRegistry {
  constructor() {
    this.schedulers = new Map();
  }

  /**
   * Get or create a scheduler.
   * @param {string} name
   * @param {object} [options]
   */
  get(name, options = {}) {
    const key = String(name || 'default');
    let scheduler = this.schedulers.get(key);
    if (!scheduler || scheduler.destroyed) {
      scheduler = new TaskScheduler(Object.assign({ name: key }, options));
      this.schedulers.set(key, scheduler);
    }
    return scheduler;
  }

  /** Queue a job on a named scheduler. */
  run(name, handle, payload, options) {
    return this.get(name, options).schedule(handle, payload, options);
  }

  /** Destroy one scheduler and drop it from the registry. */
  destroy(name, reason) {
    const key = String(name || 'default');
    const scheduler = this.schedulers.get(key);
    if (!scheduler) return 0;
    const dropped = scheduler.destroy(reason);
    this.schedulers.delete(key);
    return dropped;
  }

  destroyAll(reason) {
    let dropped = 0;
    for (const scheduler of this.schedulers.values()) dropped += scheduler.destroy(reason);
    this.schedulers.clear();
    return dropped;
  }

  names() {
    return [...this.schedulers.keys()];
  }
}

module.exports = {
  TaskScheduler,
  SchedulerRegistry,
  withTimeout,
  normalizeConcurrency,
  DEFAULT_CONCURRENCY,
};
