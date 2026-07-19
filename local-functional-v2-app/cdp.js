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
    const timer = setTimeout(() => { try { socket.close(); } catch (_) {} reject(new Error(`CDP timeout: ${method}`)); }, timeout);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id, method, params })));
    socket.addEventListener('message', (event) => {
      let value;
      try { value = JSON.parse(String(event.data)); } catch (_) { return; }
      if (value.id !== id) return;
      clearTimeout(timer); socket.close();
      if (value.error) reject(new Error(value.error.message || `CDP error: ${method}`));
      else resolve(value.result || {});
    });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP socket error: ${method}`)); });
  });
}

class PersistentConnection {
  constructor(webSocketUrl, options = {}) {
    this.webSocketUrl = webSocketUrl;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = options.socket || null;
    this.closed = false;
  }

  async open(timeout = 6000) {
    if (typeof WebSocket !== 'function') throw new Error('WebSocket API is unavailable in this host runtime');
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.webSocketUrl);
      this.socket = socket;
      const timer = setTimeout(() => { try { socket.close(); } catch (_) {} reject(new Error('CDP connection timeout')); }, timeout);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      socket.addEventListener('message', (event) => this.handleMessage(event));
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        if (!this.closed) this.failAll(new Error('CDP persistent socket error'));
      });
      socket.addEventListener('close', () => {
        if (!this.closed) this.failAll(new Error('CDP persistent socket closed'));
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
      try { this.onEvent(value, this); } catch (_) {}
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
      try { this.socket.send(JSON.stringify(message)); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
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

async function windowForPort(port) {
  const tab = await firstTab(port);
  if (!tab) throw new Error('No page tab is available');
  const socket = await browserSocket(port);
  const result = await call(socket, 'Browser.getWindowForTarget', { targetId: tab.id });
  return { socket, tab, windowId: result.windowId, bounds: result.bounds };
}

async function setWindowState(port, state) {
  const value = await windowForPort(port);
  await call(value.socket, 'Browser.setWindowBounds', { windowId: value.windowId, bounds: { windowState: state } });
  return { windowId: value.windowId, state };
}

async function setWindowBounds(port, bounds) {
  const value = await windowForPort(port);
  try { await call(value.socket, 'Browser.setWindowBounds', { windowId: value.windowId, bounds: { windowState: 'normal' } }); } catch (_) {}
  await call(value.socket, 'Browser.setWindowBounds', { windowId: value.windowId, bounds });
  return { windowId: value.windowId, bounds };
}

module.exports = { json, call, connect, PersistentConnection, targets, tabs, browserSocket, newTab, closeTab, activateTab, firstTab, focusedEditableTab, insertText, clearFocused, navigate, reload, windowForPort, setWindowState, setWindowBounds, __test: { focusedEditableExpression, chooseFocusedEditable, textWasInserted } };
