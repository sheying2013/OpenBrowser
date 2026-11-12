'use strict';

// attemptTimeoutMs must exceed connectSocket's 8s TCP timeout (proxy-forwarder.js) so a real
// link error surfaces instead of being masked by the probe deadline; totalTimeoutMs bounds the
// whole serial sweep. Cross-border dynamic residential round-trips measure ~5-9s (measured on
// a rotating-residential gateway), so the old 2200/6500 pair killed usable-but-slow proxies.
const DEFAULT_PROBE_ATTEMPT_TIMEOUT_MS = Number(process.env.OPENBROWSER_PROBE_ATTEMPT_TIMEOUT_MS) || 10000;
const DEFAULT_PROBE_TOTAL_TIMEOUT_MS = Number(process.env.OPENBROWSER_PROBE_TOTAL_TIMEOUT_MS) || 20000;

async function runProxyProbes(tasks, { totalTimeoutMs = DEFAULT_PROBE_TOTAL_TIMEOUT_MS, attemptTimeoutMs = DEFAULT_PROBE_ATTEMPT_TIMEOUT_MS, isLinkError = () => false } = {}) {
  const deadline = Date.now() + totalTimeoutMs;
  const values = [];
  const errors = [];
  for (const task of tasks) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timeoutError = Object.assign(new Error('Proxy probe deadline exceeded'), { code: 'probe-unavailable', probeUnavailable: true });
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => task(controller.signal)),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(timeoutError); }, Math.min(remaining, attemptTimeoutMs)); }),
      ]);
      if (value?.ip) values.push(value);
      if (value?.ip && value?.countryCode) break;
    } catch (error) {
      errors.push(error);
      if (isLinkError(error)) break;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  values.errors = errors;
  return values;
}

module.exports = { runProxyProbes, DEFAULT_PROBE_ATTEMPT_TIMEOUT_MS, DEFAULT_PROBE_TOTAL_TIMEOUT_MS };
