'use strict';

/**
 * Lightweight aspect manager for outgoing/incoming HTTP traffic.
 *
 * Register matchers that fire before a request is sent or after a response
 * arrives. Matchers may pin the path (exact string or pattern), require
 * specific parameters, and — for after-hooks — require a status code.
 *
 * Parameter parsing is lazy: the request body is only decoded when a matcher
 * actually inspects parameters, so the common case costs nothing.
 *
 * Handler exceptions are contained; a misbehaving aspect never breaks the
 * request pipeline it is observing.
 */

/** Minimal pattern test that is safe to call repeatedly. */
function matchesPath(matcher, path) {
  if (!matcher) return true;
  if (typeof matcher === 'string') return path === matcher;
  if (matcher instanceof RegExp) {
    // Reset sticky/global state so repeated calls stay consistent.
    matcher.lastIndex = 0;
    return matcher.test(path);
  }
  return true;
}

/**
 * Merge query parameters with body parameters.
 * The body is decoded according to Content-Type, falling back to a JSON
 * attempt and then to form encoding.
 */
function parseAllParams(requestBody, queryParams, headers = {}) {
  const params = {};
  if (queryParams && typeof queryParams === 'object') {
    Object.assign(params, queryParams);
  }
  if (!requestBody) return params;

  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();

  if (contentType.includes('application/json')) {
    return Object.assign(params, tryParseJson(requestBody));
  }
  if (contentType.includes('application/x-www-form-urlencoded')
    || contentType.includes('multipart/form-data')) {
    return Object.assign(params, parseFormData(requestBody));
  }

  const asJson = tryParseJson(requestBody);
  if (asJson) return Object.assign(params, asJson);
  // Content-Type is unknown, so only treat the body as a form when it actually
  // looks like one; otherwise a stray string would become a phantom parameter.
  if (looksLikeFormBody(requestBody)) {
    Object.assign(params, parseFormData(requestBody));
  }
  return params;
}

function tryParseJson(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return null;
  } catch (_) {
    return null;
  }
}

/** Heuristic: a key=value pair is present, so the body is probably a form. */
function looksLikeFormBody(formString) {
  if (typeof formString !== 'string' || !formString) return false;
  return formString.split('&').some((pair) => pair.includes('='));
}

/**
 * Decode `a=1&b=2` into an object, honouring percent- and plus-encoding.
 * @param {string} formString
 * @param {{requireEquals?:boolean}} [options] Skip pairs without `=`.
 */
function parseFormData(formString, options = {}) {
  const params = {};
  if (typeof formString !== 'string' || !formString) return params;
  const requireEquals = options.requireEquals === true;

  for (const pair of formString.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1 && requireEquals) continue;
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    if (!rawKey) continue;
    params[safeDecode(rawKey)] = safeDecode(rawValue);
  }
  return params;
}

function safeDecode(value) {
  // `+` denotes a space in form encoding; percent-decoding alone would miss it.
  try {
    return decodeURIComponent(String(value).replace(/\+/g, ' '));
  } catch (_) {
    return String(value);
  }
}

class AspectManager {
  constructor() {
    this.aspects = [];
  }

  /** Register a full aspect definition. Chainable. */
  addAspect(config) {
    if (!config || typeof config !== 'object') {
      throw new TypeError('aspect config must be an object');
    }
    this.aspects.push(config);
    return this;
  }

  addAspects(configs) {
    for (const config of configs) this.addAspect(config);
    return this;
  }

  /** Register a before-hook. */
  before(matcher, handler) {
    return this.addAspect(Object.assign({}, matcher, { before: handler }));
  }

  /** Register an after-hook. */
  after(matcher, handler) {
    return this.addAspect(Object.assign({}, matcher, { after: handler }));
  }

  /**
   * Remove aspects matching a predicate or an exact handler reference.
   * @returns {number} how many were removed
   */
  removeAspects(predicate) {
    const before = this.aspects.length;
    this.aspects = this.aspects.filter((aspect) => !predicate(aspect));
    return before - this.aspects.length;
  }

  get count() {
    return this.aspects.length;
  }

  clearAspects() {
    this.aspects = [];
    return this;
  }

  buildContext(context) {
    let cached = null;
    const parseParams = () => {
      if (cached === null) {
        cached = parseAllParams(context.requestBody, context.queryParams, context.requestHeaders);
      }
      return cached;
    };
    return Object.assign({}, context, { parseParams });
  }

  matchCommon(aspect, context) {
    if (!matchesPath(aspect.path, context.path)) return false;
    if (aspect.params) {
      const params = context.parseParams();
      for (const [key, value] of Object.entries(aspect.params)) {
        if (params[key] !== value) return false;
      }
    }
    return true;
  }

  matchAfter(aspect, context) {
    if (!this.matchCommon(aspect, context)) return false;
    if (aspect.statusCode !== undefined && context.statusCode !== aspect.statusCode) return false;
    return true;
  }

  /** Fire every matching before-hook. @returns {number} hooks invoked */
  executeBefore(context) {
    const full = this.buildContext(context);
    let fired = 0;
    for (const aspect of this.aspects) {
      if (!aspect.before) continue;
      if (!this.matchCommon(aspect, full)) continue;
      fired += 1;
      try {
        aspect.before(full);
      } catch (err) {
        this.reportError('before', err);
      }
    }
    return fired;
  }

  /** Fire every matching after-hook. @returns {number} hooks invoked */
  executeAfter(context) {
    const full = this.buildContext(context);
    let fired = 0;
    for (const aspect of this.aspects) {
      if (!aspect.after) continue;
      if (!this.matchAfter(aspect, full)) continue;
      fired += 1;
      try {
        aspect.after(full);
      } catch (err) {
        this.reportError('after', err);
      }
    }
    return fired;
  }

  reportError(phase, err) {
    // Aspects observe traffic; a failure here must not surface to the caller.
    this.lastError = { phase, error: err };
  }

  /** Inspect the most recent contained handler error, if any. */
  getLastError() {
    return this.lastError || null;
  }
}

module.exports = {
  AspectManager,
  parseAllParams,
  parseFormData,
  looksLikeFormBody,
  matchesPath,
  safeDecode,
};
