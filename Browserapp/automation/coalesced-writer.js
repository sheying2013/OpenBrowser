'use strict';

/**
 * Whole-value persistence with coalesced writes.
 *
 * Callers hand in a writer that persists the current state. A burst of requests
 * runs that writer once after a quiet period, and every caller still learns
 * whether the state it asked for reached the disk — awaiting the request means
 * the write has finished, not merely that it was queued.
 *
 * This also makes the writer single-flight: concurrent callers used to race on
 * the same temporary file, so one of them could rename a path another had just
 * removed.
 */

const { DeferredQueue } = require('./deferred-queue');

const DEFAULT_DELAY_MS = 40;

/**
 * @param {object} options
 * @param {() => (void|Promise<void>)} options.write persists the current state
 * @param {number} [options.delayMs] quiet period before a run
 * @param {() => boolean} [options.shouldWrite] skip the write when the current
 *   state already matches what was persisted. A predicate that throws is
 *   treated as "write", because persisting is the safe outcome.
 * @param {(err:Error) => void} [options.onError] observer for write failures
 */
function createCoalescedWriter(options = {}) {
  const write = options.write;
  if (typeof write !== 'function') throw new TypeError('write must be a function');
  const delayMs = Number.isFinite(options.delayMs) && options.delayMs >= 0
    ? Number(options.delayMs)
    : DEFAULT_DELAY_MS;

  const shouldWrite = typeof options.shouldWrite === 'function' ? options.shouldWrite : () => true;
  let waiters = [];
  let lastError = null;
  let skipped = 0;

  const queue = new DeferredQueue({
    delayMs,
    handler: async () => {
      const batch = waiters;
      waiters = [];
      lastError = null;
      try {
        // Nothing changed since the last successful write, so the disk already
        // holds this state. A predicate that throws cannot prove that, so the
        // write proceeds.
        let needWrite = true;
        try {
          needWrite = shouldWrite() !== false;
        } catch (_) {
          needWrite = true;
        }

        if (!needWrite) {
          skipped += 1;
          for (const waiter of batch) waiter.resolve();
          return;
        }

        try {
          await write();
        } catch (error) {
          lastError = error;
          if (typeof options.onError === 'function') {
            try { options.onError(error); } catch (_) { /* observer */ }
          }
          for (const waiter of batch) waiter.reject(error);
          throw error; // the queue keeps the item so a later request retries
        }

        for (const waiter of batch) waiter.resolve();
      } finally {
        // A request that arrived while this run was in flight needs another
        // run: the queue returns 0 for a flush that overlaps a running one.
        if (queue.size) queue.start(delayMs);
      }
    },  });

  return {
    /** Ask for the current state to be persisted; resolves once it is on disk. */
    request() {
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
        queue.add(1);
        queue.start(delayMs);
      });
    },
    /** Persist immediately, ignoring the quiet period. */
    flushNow() {
      return queue.flush();
    },
    /** Wait until no write is in flight. */
    idle() {
      return queue.idle();
    },
    stats() {
      return {
        ...queue.stats(),
        waiters: waiters.length,
        skipped,
        lastError: lastError ? String(lastError.message || lastError) : null,
      };
    },
  };
}

module.exports = { createCoalescedWriter, DEFAULT_DELAY_MS };
