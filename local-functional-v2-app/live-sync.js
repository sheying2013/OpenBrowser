const cdp = require('./cdp');

class PersistentCdp {
  constructor(url, onEvent) {
    this.url = url;
    this.onEvent = onEvent;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  open() {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket !== 'function') return reject(new Error('WebSocket API is unavailable'));
      const socket = new WebSocket(this.url); this.socket = socket;
      const timer = setTimeout(() => reject(new Error('Master CDP connection timeout')), 7000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      socket.addEventListener('message', (event) => {
        let value; try { value = JSON.parse(String(event.data)); } catch (_) { return; }
        if (value.id && this.pending.has(value.id)) {
          const pending = this.pending.get(value.id); this.pending.delete(value.id);
          if (value.error) pending.reject(new Error(value.error.message || 'CDP error')); else pending.resolve(value.result || {});
          return;
        }
        if (value.method) this.onEvent(value).catch(() => {});
      });
      socket.addEventListener('close', () => { for (const pending of this.pending.values()) pending.reject(new Error('Master CDP connection closed')); this.pending.clear(); });
      socket.addEventListener('error', () => reject(new Error('Master CDP connection error')));
    });
  }

  command(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return reject(new Error('Master CDP is not connected'));
      const id = this.nextId++; this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)); }, 6000);
    });
  }

  close() { try { this.socket?.close(); } catch (_) {} this.socket = null; }
}

const injection = String.raw`(() => {
  if (window.__openBrowserLiveSyncInstalled) return;
  window.__openBrowserLiveSyncInstalled = true;
  const send = (type, data) => { try { window.openBrowserSync(JSON.stringify({ type, ...data })); } catch (_) {} };
  const selector = (element) => {
    if (!(element instanceof Element)) return '';
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && parts.length < 7) {
      let part = current.tagName.toLowerCase();
      if (current.name) part += '[name="' + CSS.escape(current.name) + '"]';
      else if (current.parentElement) {
        const siblings = [...current.parentElement.children].filter((item) => item.tagName === current.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part); current = current.parentElement;
    }
    return parts.join(' > ');
  };
  document.addEventListener('click', (event) => send('click', { selector: selector(event.target), x: event.clientX, y: event.clientY, button: event.button }), true);
  document.addEventListener('input', (event) => {
    const target = event.target;
    const value = 'value' in target ? target.value : target.textContent;
    send('input', { selector: selector(target), value: String(value ?? '').slice(0, 100000), editable: Boolean(target.isContentEditable) });
  }, true);
  let scrollTimer = 0;
  const reportScroll = () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => send('scroll', { x: scrollX, y: scrollY }), 35); };
  addEventListener('scroll', reportScroll, true);
  document.addEventListener('scroll', reportScroll, true);
})();`;

class LiveSyncController {
  constructor(engine, emit) {
    this.engine = engine;
    this.emit = emit;
    this.connection = null;
    this.masterId = null;
    this.slaves = [];
    this.forwarding = Promise.resolve();
  }

  async start(ids) {
    this.stop();
    const entries = this.engine.runningWithCdp(ids);
    if (entries.length < 2) throw new Error('At least two CDP-enabled environments are required');
    const masterTab = await cdp.firstTab(entries[0].item.port);
    if (!masterTab) throw new Error('The master environment has no page tab');
    this.masterId = entries[0].id;
    this.slaves = entries.slice(1).map(({ id, item }) => ({ id, port: item.port }));
    this.connection = new PersistentCdp(masterTab.webSocketDebuggerUrl, (event) => this.handleMasterEvent(event));
    await this.connection.open();
    await this.connection.command('Runtime.addBinding', { name: 'openBrowserSync' });
    await this.connection.command('Page.addScriptToEvaluateOnNewDocument', { source: injection });
    await this.connection.command('Runtime.evaluate', { expression: injection });
    await this.connection.command('Page.enable');
    this.emit({ type: 'live-sync', active: true, master: this.masterId, slaves: this.slaves.map((item) => item.id) });
    return { active: true, master: this.masterId, slaves: this.slaves.map((item) => item.id) };
  }

  stop() {
    this.connection?.close(); this.connection = null;
    const previous = { master: this.masterId, slaves: this.slaves.map((item) => item.id) };
    this.masterId = null; this.slaves = [];
    this.emit({ type: 'live-sync', active: false, ...previous });
  }

  async handleMasterEvent(event) {
    if (event.method === 'Runtime.bindingCalled' && event.params?.name === 'openBrowserSync') {
      let payload; try { payload = JSON.parse(event.params.payload); } catch (_) { return; }
      this.forwarding = this.forwarding.then(() => this.forward(payload)).catch(() => {});
    }
    if (event.method === 'Page.frameNavigated' && !event.params?.frame?.parentId) {
      const url = event.params.frame.url;
      if (url && !url.startsWith('chrome://') && !url.startsWith('edge://')) this.forwarding = this.forwarding.then(() => Promise.all(this.slaves.map((item) => cdp.navigate(item.port, url)))).catch(() => {});
    }
  }

  async forward(payload) {
    if (!this.connection || !this.slaves.length) return;
    if (payload.type === 'click') {
      await Promise.all(this.slaves.map(async (item) => {
        const tab = await cdp.firstTab(item.port); if (!tab) return;
        if (payload.selector) {
          const selector = JSON.stringify(String(payload.selector));
          const clicked = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: `(() => { const e=document.querySelector(${selector}); if(!e)return false; e.click(); return true; })()`, returnByValue: true });
          if (clicked.result?.value) return;
        }
        await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: payload.x, y: payload.y, button: ['left', 'middle', 'right'][payload.button] || 'left', clickCount: 1 });
        await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: payload.x, y: payload.y, button: ['left', 'middle', 'right'][payload.button] || 'left', clickCount: 1 });
      }));
    } else if (payload.type === 'scroll') {
      const expression = `scrollTo(${Number(payload.x) || 0},${Number(payload.y) || 0});true`;
      await Promise.all(this.slaves.map(async (item) => { const tab = await cdp.firstTab(item.port); if (tab) await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression }); }));
    } else if (payload.type === 'input') {
      const selector = JSON.stringify(String(payload.selector || ''));
      const value = JSON.stringify(String(payload.value || ''));
      const expression = `(() => { const e=document.querySelector(${selector}); if(!e)return false; e.focus(); if('value' in e)e.value=${value};else e.textContent=${value}; e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${value}})); e.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`;
      await Promise.all(this.slaves.map(async (item) => { const tab = await cdp.firstTab(item.port); if (tab) await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression }); }));
    }
  }
}

module.exports = { LiveSyncController };
