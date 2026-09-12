'use strict';

/**
 * Page-level local-port probe protection.
 *
 * This is a defence-in-depth layer for profiles that opt into port-scan protection. The page
 * script blocks observable probes to loopback / mDNS targets on non-default ports while leaving
 * ordinary local web servers on 80 and 443 usable. The allow list is an explicit escape hatch for
 * applications that genuinely need a local high port.
 *
 * The kernel may provide a native local_port gate on builds that implement it; this script keeps
 * the contract meaningful when that native layer is absent or inert.
 */

function normalizePortAllowList(value) {
  const raw = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[,\s]+/);
  const ports = new Set();
  for (const item of raw) {
    const port = Number(String(item).trim());
    if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function buildPortScanProtectionScript(value) {
  const allow = normalizePortAllowList(value);
  return `(() => {
  const allow = new Set(${JSON.stringify(allow)});
  const nativeText = new WeakMap();
  const previousToString = Function.prototype.toString;
  const markNative = (fn, text) => {
    try { nativeText.set(fn, text); } catch (_) {}
    return fn;
  };
  const install = (target, key, value) => {
    if (!target) return false;
    try {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: value,
      });
      return true;
    } catch (_) {
      try { target[key] = value; return true; } catch (_) { return false; }
    }
  };
  const securityError = (message) => {
    try { return new DOMException(message, 'SecurityError'); } catch (_) {
      const error = new Error(message);
      error.name = 'SecurityError';
      return error;
    }
  };
  const currentHref = () => {
    try { return location && location.href ? location.href : 'http://localhost/'; }
    catch (_) { return 'http://localhost/'; }
  };
  const parseTarget = (value) => {
    try {
      const raw = value && typeof value === 'object' && typeof value.url === 'string' ? value.url : value;
      if (raw == null) return null;
      return new URL(String(raw), currentHref());
    } catch (_) { return null; }
  };
  const normalizeHost = (value) => String(value || '').toLowerCase().replace(/^\\[|\\]$/g, '');
  const isLocalHost = (value) => {
    const host = normalizeHost(value);
    return !host
      || host === 'localhost'
      || host.endsWith('.localhost')
      || host === '::1'
      || host === '0:0:0:0:0:0:0:1'
      || host === '0.0.0.0'
      || /^127\\./.test(host)
      || host.endsWith('.local');
  };
  const defaultPort = (protocol) => (protocol === 'https:' || protocol === 'wss:' ? 443 : 80);
  const isBlocked = (value) => {
    const target = parseTarget(value);
    if (!target || !isLocalHost(target.hostname)) return false;
    const port = Number(target.port || defaultPort(String(target.protocol || '').toLowerCase()));
    if (!Number.isInteger(port) || port === 80 || port === 443) return false;
    return !allow.has(port);
  };

  // fetch(input, init)
  if (typeof globalThis.fetch === 'function') {
    const originalFetch = globalThis.fetch;
    const wrappedFetch = markNative(function fetch(input) {
      if (isBlocked(input)) return Promise.reject(new TypeError('Failed to fetch'));
      return originalFetch.apply(this, arguments);
    }, 'function fetch() { [native code] }');
    install(globalThis, 'fetch', wrappedFetch);
  }

  // XMLHttpRequest.open(method, url, ...)
  try {
    const xhrProto = globalThis.XMLHttpRequest && XMLHttpRequest.prototype;
    if (xhrProto && typeof xhrProto.open === 'function') {
      const originalOpen = xhrProto.open;
      const wrappedOpen = markNative(function open(method, url) {
        if (isBlocked(url)) throw securityError("Failed to execute 'open' on 'XMLHttpRequest': local port probe blocked");
        return originalOpen.apply(this, arguments);
      }, 'function open() { [native code] }');
      install(xhrProto, 'open', wrappedOpen);
    }
  } catch (_) {}

  // WebSocket(url, protocols)
  try {
    const OriginalWebSocket = globalThis.WebSocket;
    if (typeof OriginalWebSocket === 'function') {
      const WrappedWebSocket = markNative(function WebSocket(url, protocols) {
        if (isBlocked(url)) throw securityError("Failed to construct 'WebSocket': local port probe blocked");
        return protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
      }, 'function WebSocket() { [native code] }');
      WrappedWebSocket.prototype = OriginalWebSocket.prototype;
      install(globalThis, 'WebSocket', WrappedWebSocket);
    }
  } catch (_) {}

  // EventSource(url, options)
  try {
    const OriginalEventSource = globalThis.EventSource;
    if (typeof OriginalEventSource === 'function') {
      const WrappedEventSource = markNative(function EventSource(url, options) {
        if (isBlocked(url)) throw securityError("Failed to construct 'EventSource': local port probe blocked");
        return options === undefined ? new OriginalEventSource(url) : new OriginalEventSource(url, options);
      }, 'function EventSource() { [native code] }');
      WrappedEventSource.prototype = OriginalEventSource.prototype;
      install(globalThis, 'EventSource', WrappedEventSource);
    }
  } catch (_) {}

  // navigator.sendBeacon(url, data)
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (nav && typeof nav.sendBeacon === 'function') {
      const originalSendBeacon = nav.sendBeacon;
      const wrappedSendBeacon = markNative(function sendBeacon(url) {
        if (isBlocked(url)) return false;
        return originalSendBeacon.apply(this, arguments);
      }, 'function sendBeacon() { [native code] }');
      install(nav, 'sendBeacon', wrappedSendBeacon);
    }
  } catch (_) {}

  // Element.src setters used by image / script / media probes. A blocked target is kept for the
  // getter (so page code still observes the requested URL) while the network load is suppressed and
  // an asynchronous error event gives the page the normal failure signal.
  const blockedSource = new WeakMap();
  const guardSource = (constructor) => {
    try {
      const proto = constructor && constructor.prototype;
      if (!proto) return;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'src');
      if (!descriptor || typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function') return;
      const wrappedDescriptor = {
        configurable: true,
        enumerable: descriptor.enumerable === true,
        get: function src() {
          const attempted = blockedSource.get(this);
          return attempted === undefined ? descriptor.get.call(this) : attempted;
        },
        set: function src(value) {
          if (isBlocked(value)) {
            let attempted = String(value);
            try { attempted = new URL(String(value), currentHref()).href; } catch (_) {}
            blockedSource.set(this, attempted);
            try { descriptor.set.call(this, ''); } catch (_) {
              try { this.setAttribute('src', ''); } catch (_) {}
            }
            try {
              queueMicrotask(() => {
                try { this.dispatchEvent(new Event('error')); } catch (_) {}
              });
            } catch (_) {}
            return;
          }
          return descriptor.set.call(this, value);
        },
      };
      Object.defineProperty(proto, 'src', wrappedDescriptor);
    } catch (_) {}
  };
  if (typeof HTMLImageElement !== 'undefined') guardSource(HTMLImageElement);
  if (typeof HTMLScriptElement !== 'undefined') guardSource(HTMLScriptElement);
  if (typeof HTMLMediaElement !== 'undefined') guardSource(HTMLMediaElement);

  try {
    const patchedToString = markNative(function toString() {
      const native = nativeText.get(this);
      return native === undefined ? previousToString.call(this) : native;
    }, 'function toString() { [native code] }');
    install(Function.prototype, 'toString', patchedToString);
  } catch (_) {}
})();`;
}

module.exports = {
  normalizePortAllowList,
  buildPortScanProtectionScript,
};
