'use strict';

/**
 * CDP Fetch response rewrite module for CSS @font-face local() leakage prevention.
 *
 * Intercepts incoming Document (HTML) and Stylesheet (CSS) network responses at the CDP
 * Fetch layer (Response stage) before Blink tokenization and style resolution.
 * Rewrites foreign local() font family declarations outside the allowed persona whitelist
 * to a neutral nonexistent local family, neutralizing static <style> and external <link> font leaks
 * while leaving external url(), data: font sources, and persona fonts intact.
 */

const crypto = require('crypto');
const { deriveFontPlaceholder } = require('./font-placeholder');

const DEFAULT_BLOCKED_FONT = deriveFontPlaceholder('response-rewrite-default');
const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB limit to prevent excessive memory usage

/**
 * Extract case-insensitive font family whitelist set from persona options or fingerprint.
 *
 * @param {Array<string>|Object} personaFonts - Font family array or fingerprint object.
 * @returns {Set<string>}
 */
function normalizePersonaFontSet(personaFonts) {
  let list = [];
  if (Array.isArray(personaFonts)) {
    list = personaFonts;
  } else if (personaFonts && personaFonts.fonts && Array.isArray(personaFonts.fonts.list)) {
    list = personaFonts.fonts.list;
  } else if (personaFonts && Array.isArray(personaFonts.list)) {
    list = personaFonts.list;
  }
  const set = new Set();
  for (const name of list) {
    if (typeof name === 'string') {
      const clean = name.trim().replace(/\s+/g, ' ').toLowerCase();
      if (clean) set.add(clean);
    }
  }
  return set;
}

/**
 * Sanitize @font-face local() sources within CSS text.
 *
 * Replaces any local("ForeignFont") that is not in the allowedFamilies set
 * with a neutral nonexistent local family. Web fonts with url(...) and data:...
 * remain untouched.
 *
 * @param {string} css - Raw CSS stylesheet content.
 * @param {Set<string>} allowedFamilies - Normalized allowed font family names.
 * @param {string} [blockedFont] - Fallback placeholder font name.
 * @returns {string} - Sanitized CSS content.
 */
function sanitizeCss(css, allowedFamilies, blockedFont = DEFAULT_BLOCKED_FONT) {
  if (typeof css !== 'string') return css;
  if (!css.includes('@font-face') && !css.includes('@FONT-FACE')) {
    return css;
  }

  // Match @font-face blocks and sanitize their local() declarations
  return css.replace(/@font-face\b[^{]*\{([^{}]*)\}/gi, (match, inner) => {
    const prefix = match.slice(0, match.indexOf('{') + 1);
    const sanitizedInner = inner.replace(/local\s*\(\s*(["']?)([^"')]+)\1\s*\)/gi, (localMatch, quote, fontName) => {
      const cleanName = fontName.trim().replace(/\s+/g, ' ').toLowerCase();
      if (allowedFamilies.has(cleanName)) {
        return localMatch;
      }
      return `local("${blockedFont}")`;
    });
    return prefix + sanitizedInner + '}';
  });
}

/**
 * Sanitize HTML content by rewriting inline <style> tags and static data:text/css <link> tags.
 *
 * @param {string} html - Raw HTML document content.
 * @param {Set<string>} allowedFamilies - Normalized allowed font family names.
 * @param {string} [blockedFont] - Fallback placeholder font name.
 * @param {Function} [onStyleReplaced] - Callback invoked when a <style> block is modified.
 * @returns {string} - Sanitized HTML content.
 */
function sanitizeHtml(html, allowedFamilies, blockedFont = DEFAULT_BLOCKED_FONT, onStyleReplaced = null) {
  if (typeof html !== 'string') return html;

  // 1. Sanitize inline <style> elements
  let result = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (match, openTag, content, closeTag) => {
    const sanitized = sanitizeCss(content, allowedFamilies, blockedFont);
    if (sanitized !== content && typeof onStyleReplaced === 'function') {
      onStyleReplaced(content, sanitized);
    }
    return openTag + sanitized + closeTag;
  });

  // 2. Sanitize static data:text/css stylesheets declared in <link> tags
  result = result.replace(/(<link\b[^>]*href=["'])(data:text\/css[^"']*)(["'][^>]*>)/gi, (match, openTag, dataUri, closeTag) => {
    const commaIdx = dataUri.indexOf(',');
    if (commaIdx === -1) return match;
    const meta = dataUri.slice(0, commaIdx);
    const rawData = dataUri.slice(commaIdx + 1);
    const isBase64 = meta.toLowerCase().includes(';base64');
    try {
      const decoded = isBase64 ? Buffer.from(rawData, 'base64').toString('utf8') : decodeURIComponent(rawData);
      const sanitized = sanitizeCss(decoded, allowedFamilies, blockedFont);
      if (sanitized === decoded) return match;
      const reencoded = isBase64 ? Buffer.from(sanitized, 'utf8').toString('base64') : encodeURIComponent(sanitized);
      return openTag + meta + ',' + reencoded + closeTag;
    } catch (_) {
      return match;
    }
  });

  return result;
}

/**
 * Calculate SHA-256 base64 digest of a string or buffer.
 */
function sha256Base64(data) {
  return crypto.createHash('sha256').update(data).digest('base64');
}

/**
 * Update Content-Security-Policy headers when inline <style> elements are modified.
 *
 * If the original CSP specified sha256 hashes for inline styles, updates matching
 * hashes to the new rewritten style hashes so CSP validation does not fail.
 *
 * @param {Array<{name: string, value: string}>} headers
 * @param {Array<{oldContent: string, newContent: string}>} styleReplacements
 * @returns {Array<{name: string, value: string}>}
 */
function updateCspHeaders(headers, styleReplacements) {
  if (!styleReplacements || !styleReplacements.length || !headers || !headers.length) {
    return headers;
  }

  const hashPairs = styleReplacements.map((pair) => ({
    oldHash: sha256Base64(pair.oldContent),
    newHash: sha256Base64(pair.newContent),
  })).filter((pair) => pair.oldHash !== pair.newHash);

  if (!hashPairs.length) return headers;

  return headers.map((header) => {
    const name = header.name.toLowerCase();
    if (name === 'content-security-policy' || name === 'content-security-policy-report-only') {
      let updatedVal = header.value;
      for (const { oldHash, newHash } of hashPairs) {
        if (updatedVal.includes(oldHash)) {
          updatedVal = updatedVal.replace(new RegExp(oldHash.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), newHash);
        }
      }
      return { name: header.name, value: updatedVal };
    }
    return header;
  });
}

class CssFontResponseRewriter {
  /**
   * @param {Object} options
   * @param {Array<string>|Object} [options.personaFonts] - Persona font list or fingerprint object.
   * @param {number} [options.maxBodySize] - Maximum body byte size to process (default: 10MB).
   * @param {string} [options.blockedFont] - Placeholder blocked font name.
   * @param {boolean} [options.enabled] - Whether response rewriting is enabled (default: true).
   * @param {Function} [options.logger] - Optional diagnostic logging function.
   */
  constructor(options = {}) {
    this.allowedFamilies = normalizePersonaFontSet(options.personaFonts);
    this.maxBodySize = Number(options.maxBodySize) || DEFAULT_MAX_BODY_SIZE;
    this.blockedFont = options.blockedFont || deriveFontPlaceholder(options.fingerprint || options.seed || options.personaFonts || DEFAULT_BLOCKED_FONT);
    this.enabled = options.enabled !== false;
    this.logger = typeof options.logger === 'function' ? options.logger : null;
    this.inFlightRequests = new Set();
  }

  /**
   * Update allowed font families.
   * @param {Array<string>|Object} personaFonts
   */
  setPersonaFonts(personaFonts) {
    this.allowedFamilies = normalizePersonaFontSet(personaFonts);
  }

  /**
   * Enable CDP Fetch domain response interception for Document and Stylesheet resources.
   *
   * @param {Object} connection - CDP connection or client exposing .command() or .send()
   * @param {Object} [options] - Options including sessionId
   */
  async enable(connection, options = {}) {
    const params = {
      patterns: [
        { requestStage: 'Response', resourceType: 'Document' },
        { requestStage: 'Response', resourceType: 'Stylesheet' },
      ],
    };
    return this._sendCommand(connection, 'Fetch.enable', params, options);
  }

  /**
   * Disable CDP Fetch domain interception.
   *
   * @param {Object} connection
   * @param {Object} [options]
   */
  async disable(connection, options = {}) {
    return this._sendCommand(connection, 'Fetch.disable', {}, options);
  }

  /**
   * Attach rewriter to a PersistentConnection instance.
   * Automatically chains onEvent and enables Fetch interception.
   *
   * @param {Object} connection
   * @param {Object} [options]
   */
  attach(connection, options = {}) {
    if (!connection) return;
    const existingOnEvent = connection.onEvent;
    connection.onEvent = (event, conn) => {
      this.handleEvent(event, conn || connection);
      if (typeof existingOnEvent === 'function') {
        try { existingOnEvent(event, conn || connection); } catch (_) {}
      }
    };
    this.enable(connection, options).catch((err) => {
      this._log('enable-error', { error: err.message });
    });
  }

  /**
   * Handle incoming CDP events (specifically Fetch.requestPaused).
   *
   * Deadlock prevention guarantees:
   * - Strict synchronous dispatch into async handler.
   * - In-flight tracking with timeout protection.
   * - Every requestPaused event is guaranteed to either continueRequest or fulfillRequest.
   *
   * @param {Object} event - CDP event object.
   * @param {Object} connection - CDP connection object.
   */
  handleEvent(event, connection) {
    if (!event || event.method !== 'Fetch.requestPaused' || !event.params) {
      return;
    }
    const { requestId, request, resourceType, responseStatusCode, responseHeaders, responseStatusText } = event.params;
    const sessionId = event.sessionId;

    if (!requestId) return;

    this.inFlightRequests.add(requestId);

    (async () => {
      let settled = false;
      const doContinue = async () => {
        if (settled) return;
        settled = true;
        this.inFlightRequests.delete(requestId);
        try {
          await this._sendCommand(connection, 'Fetch.continueRequest', { requestId }, { sessionId, timeout: 6000 });
        } catch (_) {}
      };

      try {
        // 1. If rewrite is disabled, pass through immediately
        if (!this.enabled) {
          return await doContinue();
        }

        // 2. Only handle responses (responseStatusCode is provided)
        if (responseStatusCode == null) {
          return await doContinue();
        }

        // 3. Skip 206 Partial Content and Range responses
        if (responseStatusCode === 206 || this._hasHeader(responseHeaders, 'content-range')) {
          return await doContinue();
        }

        // 4. Validate Content-Type / ResourceType whitelist (only HTML and CSS)
        const contentType = (this._getHeaderValue(responseHeaders, 'content-type') || '').toLowerCase();
        const isHtml = resourceType === 'Document' || contentType.includes('text/html');
        const isCss = resourceType === 'Stylesheet' || contentType.includes('text/css');

        if (!isHtml && !isCss) {
          return await doContinue();
        }

        // 5. Check Content-Length size boundary
        const rawContentLength = this._getHeaderValue(responseHeaders, 'content-length');
        if (rawContentLength) {
          const parsedLength = parseInt(rawContentLength, 10);
          if (parsedLength > this.maxBodySize) {
            this._log('skip-oversized', { url: request?.url, size: parsedLength });
            return await doContinue();
          }
        }

        // 6. Request response body from CDP
        const bodyMessage = await this._sendCommand(
          connection,
          'Fetch.getResponseBody',
          { requestId },
          { sessionId, timeout: 8000 }
        );

        const bodyData = bodyMessage?.result || bodyMessage;
        if (!bodyData || bodyData.body == null) {
          return await doContinue();
        }

        // 7. Decode body to UTF-8 text
        let bodyText = '';
        if (bodyData.base64Encoded) {
          bodyText = Buffer.from(bodyData.body, 'base64').toString('utf8');
        } else {
          bodyText = String(bodyData.body);
        }

        // 8. Sanitize content
        const styleReplacements = [];
        const onStyleReplaced = (oldContent, newContent) => {
          styleReplacements.push({ oldContent, newContent });
        };

        let rewritten = bodyText;
        if (isHtml) {
          rewritten = sanitizeHtml(bodyText, this.allowedFamilies, this.blockedFont, onStyleReplaced);
        } else if (isCss) {
          rewritten = sanitizeCss(bodyText, this.allowedFamilies, this.blockedFont, onStyleReplaced);
        }

        // If nothing was modified, continue original request to preserve network streaming
        if (rewritten === bodyText) {
          return await doContinue();
        }

        // 9. Prepare fulfilled headers:
        // - Recalculate Content-Length to match rewritten byte size
        // - Strip Content-Encoding because CDP getResponseBody decodes transparently,
        //   so the fulfilled payload is uncompressed identity stream.
        // - Strip Transfer-Encoding (chunked) as the body is delivered as a single entity.
        // - Update Content-Security-Policy if style sha256 hashes changed.
        const newBodyBuffer = Buffer.from(rewritten, 'utf8');
        let fulfilledHeaders = (responseHeaders || []).filter((h) => {
          const lower = h.name.toLowerCase();
          return lower !== 'content-length' && lower !== 'content-encoding' && lower !== 'transfer-encoding';
        });
        fulfilledHeaders.push({ name: 'Content-Length', value: String(newBodyBuffer.length) });

        if (styleReplacements.length > 0) {
          fulfilledHeaders = updateCspHeaders(fulfilledHeaders, styleReplacements);
        }

        settled = true;
        this.inFlightRequests.delete(requestId);

        await this._sendCommand(
          connection,
          'Fetch.fulfillRequest',
          {
            requestId,
            responseCode: responseStatusCode || 200,
            responsePhrase: responseStatusText || undefined,
            responseHeaders: fulfilledHeaders,
            body: newBodyBuffer.toString('base64'),
          },
          { sessionId, timeout: 8000 }
        );

        this._log('rewritten', {
          url: request?.url,
          resourceType,
          originalLength: bodyData.body.length,
          newLength: newBodyBuffer.length,
        });

      } catch (err) {
        this._log('handle-error', { error: err.message, url: request?.url });
        await doContinue();
      }
    })();
  }

  _hasHeader(headers, targetName) {
    if (!Array.isArray(headers)) return false;
    const lowerTarget = targetName.toLowerCase();
    return headers.some((h) => h && typeof h.name === 'string' && h.name.toLowerCase() === lowerTarget);
  }

  _getHeaderValue(headers, targetName) {
    if (!Array.isArray(headers)) return null;
    const lowerTarget = targetName.toLowerCase();
    const entry = headers.find((h) => h && typeof h.name === 'string' && h.name.toLowerCase() === lowerTarget);
    return entry ? entry.value : null;
  }

  async _sendCommand(connection, method, params = {}, options = {}) {
    if (!connection) throw new Error('No CDP connection available');
    if (typeof connection.command === 'function') {
      return connection.command(method, params, options);
    }
    if (typeof connection.call === 'function') {
      return connection.call(method, params, options);
    }
    if (typeof connection.send === 'function') {
      return connection.send(method, params, options);
    }
    throw new Error('Unsupported connection object (missing command/call/send)');
  }

  _log(type, details) {
    if (this.logger) {
      try { this.logger({ type, ...details }); } catch (_) {}
    }
  }
}

function createCssFontResponseRewriter(options = {}) {
  return new CssFontResponseRewriter(options);
}

module.exports = {
  DEFAULT_BLOCKED_FONT,
  DEFAULT_MAX_BODY_SIZE,
  normalizePersonaFontSet,
  sanitizeCss,
  sanitizeHtml,
  updateCspHeaders,
  CssFontResponseRewriter,
  createCssFontResponseRewriter,
};
