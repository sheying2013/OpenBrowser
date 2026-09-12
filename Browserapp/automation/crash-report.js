'use strict';

/**
 * Structured crash reports for a multi-process application shell.
 *
 * When a renderer or a helper process dies, the useful question is never just
 * "it crashed" — it is which page, under which build, on which platform, and
 * whether the process was killed, ran out of memory, or failed to start.
 * Those facts are cheap to capture at the moment of the event and impossible
 * to reconstruct afterwards.
 *
 * The report is assembled as a plain object so it can be logged, attached to a
 * support bundle, or asserted on in a test. No logging framework is required:
 * the caller supplies a sink.
 *
 * Two things this deliberately does that a naive handler does not:
 *
 *   - The page URL is sanitised, not merely truncated. A crash on an OAuth
 *     callback would otherwise write the access token straight into the crash
 *     log, which is exactly the kind of record that gets shared for support.
 *   - Reading from a destroyed `webContents` throws. Each field is read
 *     defensively, so one unavailable property cannot cost the whole report.
 */

const { sanitizeUrlForLog } = require('./log-sanitizer');

const MAX_URL_LENGTH = 500;

/** Electron's render-process-gone reasons, with a short operator-facing hint. */
const RENDER_REASONS = Object.freeze({
  crashed: 'The renderer process stopped unexpectedly.',
  oom: 'The renderer process ran out of memory.',
  killed: 'The renderer process was terminated by the system or another process.',
  'launch-failed': 'The renderer process could not be started.',
  'integrity-failure': 'The renderer failed a code-integrity check.',
});

/** Reasons reported for helper processes. */
const HELPER_REASONS = Object.freeze({
  crashed: 'The helper process stopped unexpectedly.',
  oom: 'The helper process ran out of memory.',
  killed: 'The helper process was terminated.',
  'launch-failed': 'The helper process could not be started.',
  'integrity-failure': 'The helper failed a code-integrity check.',
  'abnormal-exit': 'The helper exited abnormally.',
});

/**
 * Describe a crash reason in one line, falling back to the raw value.
 *
 * @param {string} reason
 * @param {'renderer'|'helper'} [kind]
 */
function describeReason(reason, kind = 'renderer') {
  const table = kind === 'helper' ? HELPER_REASONS : RENDER_REASONS;
  const known = table[String(reason || '').trim()];
  return known || `Process ended with reason ${JSON.stringify(String(reason || 'unknown'))}.`;
}

/**
 * Read a property without letting an unavailable object abort the report.
 *
 * A destroyed `webContents` throws from most accessors, so every read is
 * guarded individually rather than wrapping the whole assembly in one
 * try/catch that would discard the fields that were still available.
 *
 * @template T
 * @param {() => T} read
 * @param {T} fallback
 * @returns {T}
 */
function safeRead(read, fallback) {
  try {
    const value = read();
    return value === undefined ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

/** Sanitise and bound a URL so a crash log cannot carry credentials. */
function safeUrl(raw) {
  const sanitised = sanitizeUrlForLog(safeRead(() => String(raw || ''), ''));
  return sanitised.slice(0, MAX_URL_LENGTH);
}

/**
 * Build the report for a renderer-process crash.
 *
 * @param {{details?:object, webContents?:object, event?:object,
 *          processInfo?:object, appInfo?:object}} [input]
 * @returns {object}
 */
function buildRenderProcessGoneReport(input = {}) {
  const details = input.details || {};
  const contents = input.webContents || null;
  const processInfo = input.processInfo || {};
  const appInfo = input.appInfo || {};

  const destroyed = safeRead(() => (typeof contents.isDestroyed === 'function' ? contents.isDestroyed() : null), null);

  return {
    context: {
      mainProcessId: processInfo.pid ?? null,
      appVersion: appInfo.version ?? null,
      runtimeVersion: processInfo.versions ? processInfo.versions.electron ?? null : null,
      platform: processInfo.platform ?? null,
      architecture: processInfo.arch ?? null,
    },
    event: {
      type: safeRead(() => (input.event && input.event.type) || null, null),
      senderProcessId: safeRead(() => (input.event && input.event.sender && input.event.sender.id) || null, null),
    },
    page: contents
      ? {
        renderProcessId: safeRead(() => contents.id, null),
        title: safeRead(() => contents.getTitle(), ''),
        url: safeUrl(safeRead(() => contents.getURL(), '')),
        destroyed,
      }
      : null,
    crash: {
      reason: details.reason ?? null,
      exitCode: details.exitCode ?? null,
      description: describeReason(details.reason, 'renderer'),
    },
  };
}

/**
 * Build the report for a helper-process crash (GPU, utility, network, ...).
 *
 * @param {{details?:object, processInfo?:object, appInfo?:object}} [input]
 * @returns {object}
 */
function buildHelperProcessGoneReport(input = {}) {
  const details = input.details || {};
  const processInfo = input.processInfo || {};
  const appInfo = input.appInfo || {};

  return {
    context: {
      mainProcessId: processInfo.pid ?? null,
      appVersion: appInfo.version ?? null,
      runtimeVersion: processInfo.versions ? processInfo.versions.electron ?? null : null,
      platform: processInfo.platform ?? null,
      architecture: processInfo.arch ?? null,
    },
    helper: {
      type: details.type ?? null,
      name: details.name ?? null,
      serviceName: details.serviceName ?? null,
      reason: details.reason ?? null,
      exitCode: details.exitCode ?? null,
      description: describeReason(details.reason, 'helper'),
    },
  };
}

/**
 * Render a report as a single log line.
 *
 * @param {object} report
 * @param {string} [label]
 * @returns {string}
 */
function formatCrashReport(report, label = 'process-gone') {
  const tag = String(label || 'process-gone');
  let body;
  try {
    body = JSON.stringify(report);
  } catch (_) {
    // A report built here is always serialisable, but a caller may pass its
    // own object; degrade rather than throw inside a crash handler.
    body = '{"error":"report was not serialisable"}';
  }
  return `${tag} ${body}`;
}

/**
 * Wrap a report builder into a handler shaped for the process event.
 *
 * The sink receives one line. A failing sink must not propagate into the
 * runtime's event emitter, so it is called defensively.
 *
 * @param {{build?:Function, log?:Function, app?:object, processInfo?:object,
 *          label?:string}} [options]
 * @returns {(event:object, details:object, webContents?:object) => object}
 */
function createCrashHandler(options = {}) {
  const build = typeof options.build === 'function' ? options.build : buildRenderProcessGoneReport;
  const log = typeof options.log === 'function' ? options.log : null;
  const label = options.label || 'renderer-process-gone';
  const processInfo = options.processInfo || process;
  const appInfo = options.appInfo
    || (options.app && { version: safeRead(() => options.app.getVersion(), null) })
    || {};

  return function crashHandler(event, details, webContents) {
    const report = build({ details, event, webContents, processInfo, appInfo });
    if (log) {
      try {
        log(formatCrashReport(report, label), report);
      } catch (_) {
        // A sink that throws must not take the process down while it is
        // already handling a failure.
      }
    }
    return report;
  };
}

/**
 * True when a crash reason means the process should not simply be restarted
 * in place without operator attention.
 *
 * Repeatedly relaunching an out-of-memory renderer tends to produce a loop
 * that hides the underlying cause.
 *
 * @param {string} reason
 */
function shouldAlertOperator(reason) {
  return Object.prototype.hasOwnProperty.call(RENDER_REASONS, String(reason || '').trim())
    && String(reason).trim() !== 'killed';
}

module.exports = {
  buildRenderProcessGoneReport,
  buildHelperProcessGoneReport,
  formatCrashReport,
  createCrashHandler,
  describeReason,
  shouldAlertOperator,
  safeRead,
  safeUrl,
  RENDER_REASONS,
  HELPER_REASONS,
  MAX_URL_LENGTH,
};
