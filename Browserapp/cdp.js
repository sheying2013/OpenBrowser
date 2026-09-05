const http = require('http');

function request(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`CDP HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('CDP HTTP timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function json(url, method = 'GET') {
  return JSON.parse(await request(url, method));
}

function call(webSocketUrl, method, params = {}, timeout = 6000) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') return reject(new Error('WebSocket API is unavailable in this host runtime'));
    const id = Math.floor(Math.random() * 1_000_000_000);
    const socket = new WebSocket(webSocketUrl);
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) {}
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error(`CDP timeout: ${method}`)), timeout);
    socket.addEventListener('open', () => {
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { finish(reject, error instanceof Error ? error : new Error(`CDP send failed: ${method}`)); }
    });
    socket.addEventListener('message', (event) => {
      let value;
      try { value = JSON.parse(String(event.data)); } catch (_) { return; }
      if (value.id !== id) return;
      if (value.error) finish(reject, new Error(value.error.message || `CDP error: ${method}`));
      else finish(resolve, value.result || {});
    });
    socket.addEventListener('error', () => finish(reject, new Error(`CDP socket error: ${method}`)));
    // Without this, a target that closes before replying leaves the caller hanging until
    // the full timeout elapses instead of failing fast.
    socket.addEventListener('close', () => finish(reject, new Error(`CDP socket closed before response: ${method}`)));
  });
}

class PersistentConnection {
  constructor(webSocketUrl, options = {}) {
    this.webSocketUrl = webSocketUrl;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    this.onDisconnect = typeof options.onDisconnect === 'function' ? options.onDisconnect : null;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = options.socket || null;
    this.closed = false;
    this.opened = false;
    this.disconnectNotified = false;
  }

  async open(timeout = 6000) {
    if (typeof WebSocket !== 'function') throw new Error('WebSocket API is unavailable in this host runtime');
    if (this.closed) throw new Error('CDP persistent connection is closed');
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.webSocketUrl);
      this.socket = socket;
      let settled = false;
      const fail = (error, closeSocket = false) => {
        const value = error instanceof Error ? error : new Error(String(error || 'CDP persistent socket failed'));
        // Do not leave a disconnected transport available for later commands. A stale
        // socket would otherwise make those commands wait until their individual timeout.
        if (this.socket === socket) {
          this.socket = null;
          this.closed = true;
        }
        const unexpectedDisconnect = this.opened && !this.disconnectNotified;
        this.opened = false;
        this.failAll(value);
        if (unexpectedDisconnect) {
          this.disconnectNotified = true;
          try { this.onDisconnect?.(value, this); } catch (_) {}
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (closeSocket) {
          try { socket.close(); } catch (_) {}
        }
        reject(value);
      };
      const timer = setTimeout(() => {
        fail(new Error('CDP connection timeout'));
        try { socket.close(); } catch (_) {}
      }, timeout);
      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.opened = true;
        resolve();
      });
      socket.addEventListener('message', (event) => this.handleMessage(event));
      socket.addEventListener('error', () => {
        const error = new Error('CDP persistent socket error');
        if (!this.closed) fail(error, true);
      });
      socket.addEventListener('close', () => {
        const error = new Error('CDP persistent socket closed');
        if (!this.closed) fail(error);
      });
    });
    return this;
  }

  handleMessage(event) {
    let value;
    try { value = JSON.parse(String(event.data)); } catch (_) { return; }
    if (value.id != null) {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error) pending.reject(new Error(value.error.message || 'CDP command failed'));
      else pending.resolve(value.result || {});
      return;
    }
    if (value.method && this.onEvent) {
      try { Promise.resolve(this.onEvent(value, this)).catch(() => {}); } catch (_) {}
    }
  }

  command(method, params = {}, options = {}) {
    if (this.closed || !this.socket) return Promise.reject(new Error('CDP persistent connection is closed'));
    const id = this.nextId++;
    const timeout = Number(options.timeout) || 6000;
    const message = { id, method, params };
    if (options.sessionId) message.sessionId = options.sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      const socket = this.socket;
      try { socket.send(JSON.stringify(message)); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
        if (this.socket === socket) {
          this.socket = null;
          this.closed = true;
          const unexpectedDisconnect = this.opened && !this.disconnectNotified;
          this.opened = false;
          this.failAll(error);
          if (unexpectedDisconnect) {
            this.disconnectNotified = true;
            try { this.onDisconnect?.(error, this); } catch (_) {}
          }
        }
      }
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.opened = false;
    this.failAll(new Error('CDP persistent connection closed'));
    try { this.socket?.close(); } catch (_) {}
    this.socket = null;
  }
}

async function connect(webSocketUrl, options = {}) {
  return new PersistentConnection(webSocketUrl, options).open(options.timeout);
}

async function targets(port) {
  const values = await json(`http://127.0.0.1:${port}/json/list`);
  return values.filter((item) => item.webSocketDebuggerUrl).map((item) => ({
    id: item.id,
    type: item.type,
    title: item.title,
    url: item.url,
    webSocketDebuggerUrl: item.webSocketDebuggerUrl
  }));
}

async function tabs(port) {
  return (await targets(port)).filter((item) => item.type === 'page');
}

async function browserSocket(port) {
  const version = await json(`http://127.0.0.1:${port}/json/version`);
  return version.webSocketDebuggerUrl;
}

async function newTab(port, url = 'about:blank') {
  return json(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, 'PUT');
}

async function closeTab(port, targetId) {
  return request(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(targetId)}`);
}

async function activateTab(port, targetId) {
  return request(`http://127.0.0.1:${port}/json/activate/${encodeURIComponent(targetId)}`);
}

async function firstTab(port) {
  const list = await tabs(port);
  return list.find((item) => !item.url.startsWith('chrome://') && !item.url.startsWith('edge://')) || list[0] || null;
}

const focusedEditableExpression = `(() => {
  const deepestActiveElement = () => {
    let value = document.activeElement;
    const seen = new Set();
    while (value && !seen.has(value)) {
      seen.add(value);
      const nested = value.shadowRoot && value.shadowRoot.activeElement;
      if (!nested) break;
      value = nested;
    }
    return value;
  };
  const element = deepestActiveElement();
  const tag = String(element?.tagName || '').toLowerCase();
  const type = String(element?.getAttribute?.('type') || '').toLowerCase();
  const rejectedInputTypes = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);
  const editable = Boolean(element && !element.disabled && !element.readOnly &&
    ((tag === 'input' && !rejectedInputTypes.has(type)) || tag === 'textarea' || element.isContentEditable));
  let value = '';
  let selectionStart = null;
  let selectionEnd = null;
  if (editable) {
    value = 'value' in element ? String(element.value ?? '') : String(element.textContent ?? '');
    if (typeof element.selectionStart === 'number') selectionStart = element.selectionStart;
    if (typeof element.selectionEnd === 'number') selectionEnd = element.selectionEnd;
  }
  return { visible: document.visibilityState === 'visible', editable, tag, type, value, selectionStart, selectionEnd };
})()`;

function chooseFocusedEditable(inspected) {
  const visible = inspected.filter((item) => item.state.visible);
  if (visible.length) return visible.find((item) => item.state.editable) || null;
  return inspected.find((item) => item.state.editable) || null;
}

async function focusedEditableTab(port) {
  const list = await tabs(port);
  const inspected = [];
  for (const tab of list) {
    try {
      const result = await call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: focusedEditableExpression, returnByValue: true });
      inspected.push({ tab, state: result.result?.value || {} });
    } catch (_) {}
  }
  return chooseFocusedEditable(inspected);
}

function textWasInserted(before, after, text) {
  const inserted = String(text);
  if (before && Number.isInteger(before.selectionStart) && Number.isInteger(before.selectionEnd)) {
    const expected = String(before.value).slice(0, before.selectionStart) + inserted + String(before.value).slice(before.selectionEnd);
    return String(after.value) === expected;
  }
  if (!inserted) return String(after.value) === String(before?.value || '');
  return String(after.value) !== String(before?.value || '') && String(after.value).includes(inserted);
}

async function insertText(port, text) {
  const focused = await focusedEditableTab(port);
  if (!focused) throw new Error('No focused text input was found in the visible tab');
  const value = String(text);
  await call(focused.tab.webSocketDebuggerUrl, 'Input.insertText', { text: value });
  const checked = await call(focused.tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: focusedEditableExpression, returnByValue: true });
  const after = checked.result?.value || {};
  if (!after.editable || !textWasInserted(focused.state, after, value)) throw new Error('The focused input did not accept the assigned text');
  return { success: true, targetId: focused.tab.id, title: focused.tab.title, insertedLength: value.length };
}

async function clearFocused(port) {
  const focused = await focusedEditableTab(port);
  if (!focused) throw new Error('No focused text input was found in the visible tab');
  const expression = `(() => { let e=document.activeElement;const seen=new Set();while(e&&!seen.has(e)){seen.add(e);const nested=e.shadowRoot&&e.shadowRoot.activeElement;if(!nested)break;e=nested;}if(!e)return false;if('value' in e){e.value='';e.dispatchEvent(new Event('input',{bubbles:true,composed:true}));e.dispatchEvent(new Event('change',{bubbles:true,composed:true}));return e.value==='';}if(e.isContentEditable){e.textContent='';e.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'deleteContentBackward'}));return e.textContent==='';}return false;})()`;
  const result = await call(focused.tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true });
  if (result.result?.value !== true) throw new Error('The focused input could not be cleared');
  return { success: true, targetId: focused.tab.id, title: focused.tab.title };
}

async function navigate(port, url) {
  const tab = await firstTab(port) || await newTab(port, 'about:blank');
  await call(tab.webSocketDebuggerUrl, 'Page.navigate', { url }, 20000);
  return { targetId: tab.id };
}

async function reload(port) {
  const tab = await firstTab(port);
  if (!tab) throw new Error('No page tab is available');
  await call(tab.webSocketDebuggerUrl, 'Page.reload', { ignoreCache: false });
  return { targetId: tab.id };
}

async function windowForTarget(port, targetId = null) {
  const tab = targetId
    ? (await tabs(port)).find((item) => String(item.id) === String(targetId))
    : await firstTab(port);
  if (!tab) throw new Error('No page tab is available');
  const socket = await browserSocket(port);
  const result = await call(socket, 'Browser.getWindowForTarget', { targetId: tab.id });
  let bounds = result.bounds || {};
  if ((!bounds || typeof bounds !== 'object' || !Object.keys(bounds).length) && result.windowId !== undefined) {
    // Older Chromium builds omit bounds from getWindowForTarget. A missing or
    // unsupported follow-up must not prevent callers from changing state.
    try { bounds = (await call(socket, 'Browser.getWindowBounds', { windowId: result.windowId })).bounds || {}; } catch (_) {}
  }
  return { socket, tab, windowId: result.windowId, bounds: bounds || {} };
}

async function windowForPort(port, targetId = null) {
  return windowForTarget(port, targetId);
}

async function readWindowBounds(socket, windowId, targetId = null) {
  try {
    const result = await call(socket, 'Browser.getWindowBounds', { windowId });
    if (result?.bounds && typeof result.bounds === 'object') return result.bounds;
  } catch (error) {
    if (!targetId) throw error;
  }
  if (!targetId) return {};
  const result = await call(socket, 'Browser.getWindowForTarget', { targetId });
  return result?.bounds || {};
}

async function waitForWindowState(socket, windowId, expected, options = {}) {
  const attempts = Math.max(1, Math.min(8, Number(options.attempts) || 3));
  const delayMs = Math.max(0, Math.min(500, Number(options.delayMs) || 60));
  let bounds = {};
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    bounds = await readWindowBounds(socket, windowId, options.targetId || null);
    if (String(bounds.windowState || '').toLowerCase() === expected) return { matched: true, bounds };
    if (attempt + 1 < attempts && delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { matched: false, bounds };
}

async function setWindowState(port, state, options = {}) {
  const normalized = String(state || '').toLowerCase();
  if (!['normal', 'minimized', 'maximized', 'fullscreen'].includes(normalized)) throw new Error(`Invalid browser window state: ${state}`);
  const value = await windowForPort(port, options.targetId || null);
  let primaryError = null;
  try {
    await call(value.socket, 'Browser.setWindowBounds', { windowId: value.windowId, bounds: { windowState: normalized } });
  } catch (error) {
    primaryError = error;
  }
  if (!primaryError && options.verify !== true) return { windowId: value.windowId, state: normalized };

  let verified = null;
  if (!primaryError) {
    verified = await waitForWindowState(value.socket, value.windowId, normalized, { ...options, targetId: value.tab.id }).catch((error) => {
      primaryError = error;
      return null;
    });
    if (verified?.matched) return { windowId: value.windowId, state: normalized, bounds: verified.bounds, degraded: false };
    if (!primaryError && verified && !verified.bounds?.windowState) {
      return { windowId: value.windowId, state: normalized, bounds: verified.bounds, degraded: false, unverified: true };
    }
  }

  const fallback = String(options.fallbackState || '').toLowerCase();
  if (fallback && fallback !== normalized && ['normal', 'minimized', 'maximized'].includes(fallback)) {
    try {
      await call(value.socket, 'Browser.setWindowBounds', { windowId: value.windowId, bounds: { windowState: fallback } });
      const fallbackState = options.verify === true
        ? await waitForWindowState(value.socket, value.windowId, fallback, { ...options, targetId: value.tab.id })
        : { matched: true, bounds: { windowState: fallback } };
      if (fallbackState.matched) {
        return {
          windowId: value.windowId,
          requestedState: normalized,
          state: fallback,
          bounds: fallbackState.bounds,
          degraded: true,
          error: String(primaryError?.message || `Window state ${normalized} was not applied`),
        };
      }
    } catch (error) {
      if (!primaryError) primaryError = error;
    }
  }

  const actual = String(verified?.bounds?.windowState || value.bounds?.windowState || '').toLowerCase();
  const error = primaryError || new Error(`Browser window state did not converge to ${normalized}${actual ? ` (actual: ${actual})` : ''}`);
  error.code = error.code || 'WINDOW_STATE_NOT_APPLIED';
  error.requestedState = normalized;
  error.actualState = actual || null;
  throw error;
}

async function setWindowBounds(port, bounds, options = {}) {
  const value = await windowForPort(port, options.targetId || null);
  const requestedState = String(bounds?.windowState || '').toLowerCase();
  if (requestedState && !['normal', 'minimized', 'maximized', 'fullscreen'].includes(requestedState)) throw new Error(`Invalid browser window state: ${bounds.windowState}`);
  const hasGeometry = ['left', 'top', 'width', 'height'].some((key) => bounds?.[key] !== undefined);
  if (requestedState && requestedState !== 'normal') {
    await call(value.socket, 'Browser.setWindowBounds', { windowId: value.windowId, bounds: { windowState: requestedState } });
    return { windowId: value.windowId, bounds: { windowState: requestedState } };
  }
  if (!hasGeometry) {
    if (requestedState === 'normal') await call(value.socket, 'Browser.setWindowBounds', { windowId: value.windowId, bounds: { windowState: 'normal' } });
    return { windowId: value.windowId, bounds: requestedState ? { windowState: requestedState } : {} };
  }
  const next = {
    left: Math.round(Number(bounds.left) || 0),
    top: Math.round(Number(bounds.top) || 0),
    width: Math.max(320, Math.round(Number(bounds.width) || 800)),
    height: Math.max(240, Math.round(Number(bounds.height) || 600)),
  };
  const forceNormal = options.forceNormal !== false;
  // Explicit layout commands keep the historical behavior. Background live-sync callers
  // can opt out so a geometry refresh never collapses fullscreen/maximized windows or
  // dismisses browser-owned menus merely by re-applying windowState=normal.
  if (forceNormal || requestedState === 'normal') {
    try { await call(value.socket, 'Browser.setWindowBounds', { windowId: value.windowId, bounds: { windowState: 'normal' } }); } catch (_) {}
  }
  await call(value.socket, 'Browser.setWindowBounds', { windowId: value.windowId, bounds: next });
  // Some Chromium builds need a second pass after leaving maximized state. Passive
  // synchronization deliberately avoids the retry: even a redundant resize can close a
  // native menu, picker, or extension popup owned by the browser chrome.
  if (!forceNormal) return { windowId: value.windowId, bounds: next };
  try {
    const current = await call(value.socket, 'Browser.getWindowBounds', { windowId: value.windowId });
    const actual = current?.bounds || {};
    if (actual.windowState === 'maximized' || actual.windowState === 'fullscreen') {
      await call(value.socket, 'Browser.setWindowBounds', { windowId: value.windowId, bounds: next });
    }
  } catch (_) {}
  return { windowId: value.windowId, bounds: next };
}

module.exports = { json, call, connect, PersistentConnection, targets, tabs, browserSocket, newTab, closeTab, activateTab, firstTab, focusedEditableTab, insertText, clearFocused, navigate, reload, windowForTarget, windowForPort, setWindowState, setWindowBounds, __test: { focusedEditableExpression, chooseFocusedEditable, textWasInserted, waitForWindowState } };
