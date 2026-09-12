'use strict';

/**
 * Bounded fan-out for extension-store lookups.
 *
 * The app centre asks for icons and metadata for up to fifty store entries at
 * once, and each lookup downloads a package. Firing every lookup in parallel
 * looks fast right up to the point where the store starts refusing the burst,
 * so the work goes through a bounded queue instead.
 *
 * A lookup that fails or hangs yields no entry rather than failing the batch:
 * the panel shows the entries it did get.
 */

const { TaskScheduler } = require('./task-scheduler');

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_ENTRIES = 50;

/** Concurrency override, clamped to something sane. */
function resolveConcurrency(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_CONCURRENCY;
  return Math.min(n, MAX_ENTRIES);
}

/**
 * Run `fetcher(id)` for every id through a bounded queue.
 *
 * @param {string[]} ids
 * @param {(id:string) => Promise<*>} fetcher
 * @param {{concurrency?:number, timeoutMs?:number}} [options]
 * @returns {Promise<Object<string, *>>} keyed by id, entries that failed are omitted.
 */
async function fetchStoreEntries(ids, fetcher, options = {}) {
  if (typeof fetcher !== 'function') throw new TypeError('fetcher must be a function');
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))].slice(0, MAX_ENTRIES);
  if (!wanted.length) return {};

  const scheduler = new TaskScheduler({
    name: 'store-fetch',
    concurrency: resolveConcurrency(options.concurrency),
    defaultTimeout: Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS,
  });

  const results = await Promise.all(wanted.map((id) => scheduler.schedule(async () => {
    try {
      const value = await fetcher(id);
      return value === undefined ? null : value;
    } catch (_) {
      return null;
    }
    // The timeout is applied by the scheduler around the job, so it surfaces as
    // a rejection of schedule() itself - normalise that too, or one hung lookup
    // would take the whole batch with it.
  }).catch(() => null)));

  const out = {};
  for (let index = 0; index < wanted.length; index += 1) {
    const value = results[index];
    if (value === null || value === undefined) continue;
    out[wanted[index]] = value;
  }
  return out;
}

module.exports = {
  fetchStoreEntries,
  resolveConcurrency,
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  MAX_ENTRIES,
};
