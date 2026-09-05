const cdp = require('./cdp');

class PersistentCdp {
  constructor(url, onEvent) { this.url = url; this.onEvent = onEvent; this.socket = null; this.nextId = 1; this.pending = new Map(); this.closed = false; }
  open() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url); this.socket = socket;
      let settled = false;
      const finishOpen = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const failPending = (error) => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
      };
      const timer = setTimeout(() => {
        const error = new Error('CDP connection timeout');
        finishOpen(reject, error);
        failPending(error);
        try { socket.close(); } catch (_) {}
      }, 8000);
      socket.addEventListener('open', () => finishOpen(resolve));
      socket.addEventListener('message', (event) => {
        let value; try { value = JSON.parse(String(event.data)); } catch (_) { return; }
        if (value.id && this.pending.has(value.id)) { const pending = this.pending.get(value.id); this.pending.delete(value.id); clearTimeout(pending.timer); return value.error ? pending.reject(new Error(value.error.message || 'CDP error')) : pending.resolve(value.result || {}); }
        if (value.method) Promise.resolve(this.onEvent(value)).catch(() => {});
      });
      socket.addEventListener('close', () => { this.closed = true; if (this.socket === socket) this.socket = null; const error = new Error('CDP connection closed'); failPending(error); finishOpen(reject, error); });
      socket.addEventListener('error', () => { const error = new Error('CDP connection error'); failPending(error); finishOpen(reject, error); });
    });
  }
  command(method, params = {}, options = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN) return reject(new Error('CDP is not connected'));
      const id = this.nextId++;
      const timeout = Math.max(1, Number(options.timeout) || 7000);
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      const message = { id, method, params };
      if (options.sessionId) message.sessionId = options.sessionId;
      try { this.socket.send(JSON.stringify(message)); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('CDP connection closed')); }
    this.pending.clear();
    try { this.socket?.close(); } catch (_) {}
    this.socket = null;
  }
}

const injection = String.raw`(() => {
  if (window.__openBrowserLiveSyncV4) return;
  window.__openBrowserLiveSyncV4 = true;
  const send = (type, data) => { try { window.openBrowserSync(JSON.stringify({ type, ...data })); } catch (_) {} };
  const localSelector = (element) => {
    if (!(element instanceof Element)) return ''; if (element.id) return '#' + CSS.escape(element.id);
    const parts = []; let current = element; while (current && current.nodeType === 1 && parts.length < 8) { let part = current.tagName.toLowerCase(); if (current.name) part += '[name="' + CSS.escape(current.name) + '"]'; else if (current.parentElement) { const siblings = [...current.parentElement.children].filter((item) => item.tagName === current.tagName); if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')'; } parts.unshift(part); current = current.parentElement; } return parts.join(' > ');
  };
  const selector = (element) => { const segments = []; let current = element; while (current instanceof Element) { segments.unshift(localSelector(current)); const root = current.getRootNode(); current = root instanceof ShadowRoot ? root.host : null; } return segments.filter(Boolean).join(' >>> '); };
  const actual = (event) => event.composedPath?.()[0] || event.target;
  const pointState = (target, x, y) => { let rx=.5,ry=.5; try { const r=target.getBoundingClientRect(); if(r.width>0)rx=Math.max(0,Math.min(1,(x-r.left)/r.width));if(r.height>0)ry=Math.max(0,Math.min(1,(y-r.top)/r.height)); } catch(_){} return { selector:selector(target),x,y,rx,ry,tag:String(target?.tagName||'').toLowerCase(),elementType:String(target?.type||''),role:String(target?.getAttribute?.('role')||''),ariaLabel:String(target?.getAttribute?.('aria-label')||''),text:String(target?.innerText||target?.textContent||'').trim().replace(/\s+/g,' ').slice(0,200) }; };
  const mouse = (phase, event) => { const target=actual(event); send('mouse', { phase, ...pointState(target,event.clientX,event.clientY), button: event.button, buttons: event.buttons }); };
  document.addEventListener('mousedown', (event) => mouse('down', event), true);
  document.addEventListener('mouseup', (event) => mouse('up', event), true);
  let moveFrame = 0; document.addEventListener('mousemove', (event) => { if (!event.buttons || moveFrame) return; moveFrame = requestAnimationFrame(() => { moveFrame = 0; mouse('move', event); }); }, true);
  document.addEventListener('click', (event) => { if (!event.isTrusted) send('click', { ...pointState(actual(event),event.clientX,event.clientY), button: event.button }); }, true);
  document.addEventListener('contextmenu', (event) => { send('contextmenu', { ...pointState(actual(event), event.clientX, event.clientY), button: 2 }); }, true);
  document.addEventListener('wheel', (event) => send('wheel', { ...pointState(actual(event),event.clientX,event.clientY), deltaX: event.deltaX, deltaY: event.deltaY, alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey }), { capture: true, passive: true });
  const focusState = (target) => {
    let x = 0, y = 0; try { const rect = target.getBoundingClientRect(); x = rect.left + rect.width / 2; y = rect.top + rect.height / 2; let current = window; while (current !== current.top) { const frame = current.frameElement; if (!frame) break; const frameRect = frame.getBoundingClientRect(); x += frameRect.left; y += frameRect.top; current = current.parent; } } catch (_) {}
    return { ...pointState(target,x,y), name: String(target.name || ''), placeholder: String(target.placeholder || ''), start: Number.isInteger(target.selectionStart) ? target.selectionStart : null, end: Number.isInteger(target.selectionEnd) ? target.selectionEnd : null };
  };
  document.addEventListener('focusin', (event) => send('focus', focusState(actual(event))), true);
  document.addEventListener('select', (event) => send('focus', focusState(actual(event))), true);
  document.addEventListener('beforeinput', (event) => send('beforeinput', { ...focusState(actual(event)), inputType: event.inputType || '', data: event.data == null ? null : String(event.data) }), true);
  document.addEventListener('input', (event) => { const target = actual(event); const value = 'value' in target ? target.value : target.textContent; send('input', { ...focusState(target), value: String(value ?? '').slice(0, 100000), editable: Boolean(target.isContentEditable), inputType: String(event.inputType || 'insertText'), data: event.data == null ? null : String(event.data) }); }, true);
  const key = (phase, event) => { const target=actual(event); const editable=Boolean(target && (target.isContentEditable || 'value' in target)); send('key', { phase, key: event.key, code: event.code, keyCode: event.keyCode, location: event.location, alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, editable }); };
  document.addEventListener('keydown', (event) => key('down', event), true);
  document.addEventListener('keyup', (event) => key('up', event), true);
  if (window === window.top) {
    let surfaceTimer = 0;
    const reportSurface = () => {
      clearTimeout(surfaceTimer);
      surfaceTimer = setTimeout(() => send('surface', {
        visible: document.visibilityState === 'visible',
        focused: typeof document.hasFocus !== 'function' || document.hasFocus(),
      }), 0);
    };
    window.addEventListener('blur', reportSurface, true);
    window.addEventListener('focus', reportSurface, true);
    window.addEventListener('pagehide', reportSurface, true);
    window.addEventListener('pageshow', reportSurface, true);
    document.addEventListener('visibilitychange', reportSurface, true);
    document.addEventListener('freeze', reportSurface, true);
    document.addEventListener('resume', reportSurface, true);
    reportSurface();
  }
  let scrollTimer = 0; const reportScroll = () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => send('scroll', { x: scrollX, y: scrollY }), 40); };
  addEventListener('scroll', reportScroll, true); document.addEventListener('scroll', reportScroll, true);
})();`;

const ALLOWED_INTERNAL_PAGES = new RegExp("^" + "(chrome|edge)://(newtab|new-tab-page|extensions|settings|downloads|history|flags|version|bookmarks|about)", "i");
function normalTabs(values) {
  return values.filter((tab) => {
    if (!tab || !tab.url) return false;
    if (/^(devtools|chrome-extension|edge-extension):/i.test(tab.url)) return false;
    if (/^(chrome|edge):/i.test(tab.url)) {
const ALLOWED_INTERNAL_PAGES = new RegExp("^" + "(chrome|edge)://(newtab|new-tab-page|extensions|settings|downloads|history|flags|version|bookmarks|about)", "i");
    }
    return true;
  });
}

class LiveSyncController {
  constructor(engine, emit) {
    this.engine = engine; this.emit = emit; this.master = null; this.slaves = []; this.connections = new Map(); this.masterTabs = []; this.timer = null;
    this.forwardQueue = []; this.forwardQueueRunning = false; this.coalescedForwards = new Map();
    this.forwardStats = { coalesced: 0, dropped: 0, processed: 0, lastLatencyMs: 0 }; this.lastHealthEmitAt = 0;
    this.lastWatchErrorAt = 0; this.refreshInFlight = false; this.refreshTask = null; this.refreshEpoch = 0; this.skippedRefreshes = 0;
    // Adaptive sync poll: active input stays fast; idle stretches to save CPU/CDP load.
    this.lastActivityAt = 0; this.refreshIntervalMs = 700; this.tickCount = 0;
  }

  async start(ids) {
    this.stop();
    const entries = this.engine.runningWithCdp(ids);
    if (entries.length < 2) throw new Error('至少需要两个具有 CDP 会话的运行环境');
    this.master = entries[0]; this.slaves = entries.slice(1).map(({ id, item }) => ({ id, port: item.port }));
    this.lastActivityAt = Date.now(); this.refreshIntervalMs = 700; this.tickCount = 0;
    await this.refreshMasterTabs();
    if (!this.connections.size) throw new Error('主控环境没有可同步的网页标签');
    this.scheduleRefreshTick();
    this.emit({ type: 'live-sync', active: true, master: this.master.id, slaves: this.slaves.map((item) => item.id), tabs: this.connections.size });
    return { active: true, master: this.master.id, slaves: this.slaves.map((item) => item.id), tabs: this.connections.size };
  }

  scheduleRefreshTick() {
    if (this.timer) clearTimeout(this.timer);
    if (!this.master) return;
    const refreshGeneration = this.getRefreshGeneration?.();
    const refreshEpoch = this.refreshEpoch;
    const idleMs = Date.now() - (this.lastActivityAt || 0);
    // Active: ~450ms; recent: ~700ms; idle: ~1400ms. Caps CDP churn when user is not driving.
    this.refreshIntervalMs = idleMs < 2500 ? 450 : idleMs < 12000 ? 700 : 1400;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runRefreshTick(refreshGeneration, refreshEpoch).finally(() => {
        if (this.refreshEpoch !== refreshEpoch) return;
        if (this.getRefreshGeneration && refreshGeneration !== this.getRefreshGeneration()) return;
        this.scheduleRefreshTick();
      });
    }, this.refreshIntervalMs);
    this.timer.unref?.();
  }

  markActivity() { this.lastActivityAt = Date.now(); }

  async runRefreshTick(refreshGeneration = null, refreshEpoch = this.refreshEpoch) {
    if (refreshEpoch !== this.refreshEpoch) return;
    if (refreshGeneration != null && this.getRefreshGeneration && refreshGeneration !== this.getRefreshGeneration()) return;
    if (!this.master || this.refreshInFlight) { if (this.refreshInFlight) this.skippedRefreshes += 1; return; }
    const task = { epoch: refreshEpoch, generation: refreshGeneration };
    this.refreshTask = task; this.refreshInFlight = true; this.tickCount = (this.tickCount || 0) + 1;
    try {
      await this.refreshMasterTabs(refreshGeneration);
    } catch (error) {
      if (refreshGeneration == null || !this.getRefreshGeneration || refreshGeneration === this.getRefreshGeneration()) {
        this.handleWatchError(error, refreshGeneration);
      }
    }
    finally {
      if (this.refreshTask === task) {
        this.refreshTask = null;
        this.refreshInFlight = false;
      }
    }
  }

  handleWatchError(error) {
    const message = String(error?.message || error || 'Unknown sync error');
    if (/ECONNREFUSED|connection refused|fetch failed|CDP connection closed/i.test(message)) {
      const master = this.master?.id || null; const slaves = this.slaves.map((item) => item.id);
      this.stop();
      this.emit({ type: 'sync-disconnected', active: false, master, slaves, message: '浏览器环境已关闭或调试端口失效，同步已自动停止' });
      return;
    }
    const now = Date.now(); if (now - this.lastWatchErrorAt < 5000) return; this.lastWatchErrorAt = now;
    this.emit({ type: 'sync-error', action: 'watch-tabs', message });
  }

  stop() {
    this.refreshEpoch += 1;
    this.lastWatchErrorAt = 0; this.refreshTask = null; this.refreshInFlight = false; this.skippedRefreshes = 0;
    this.forwardQueue.length = 0; this.coalescedForwards.clear(); this.forwardQueueRunning = false;
    if (this.timer) clearTimeout(this.timer); this.timer = null; this.tickCount = 0;
    for (const value of this.connections.values()) value.connection.close(); this.connections.clear();
    const previous = { master: this.master?.id || null, slaves: this.slaves.map((item) => item.id) };
    this.master = null; this.slaves = []; this.masterTabs = [];
    this.emit({ type: 'live-sync', active: false, ...previous });
  }

  async refreshMasterTabs() {
    if (!this.master) return;
    const tabs = normalTabs(await cdp.tabs(this.master.item.port)); this.masterTabs = tabs;
    const live = new Set(tabs.map((tab) => tab.id));
    for (const [id, value] of this.connections) if (!live.has(id)) { value.connection.close(); this.connections.delete(id); }
    for (const tab of tabs) if (!this.connections.has(tab.id)) await this.attach(tab);
    await Promise.all([...this.connections.values()].map((value) => this.pollScroll(value).catch(() => {})));
  }

  async attach(tab) {
    const connection = new PersistentCdp(tab.webSocketDebuggerUrl, (event) => this.handle(tab.id, event));
    await connection.open();
    const value = { tab, connection, scroll: { x: 0, y: 0 } }; this.connections.set(tab.id, value);
    try {
      await connection.command('Runtime.addBinding', { name: 'openBrowserSync' });
      await connection.command('Page.addScriptToEvaluateOnNewDocument', { source: injection });
      await connection.command('Runtime.enable');
      await connection.command('Runtime.evaluate', { expression: injection });
      await connection.command('Page.enable');
      const position = await connection.command('Runtime.evaluate', { expression: '({x:scrollX,y:scrollY})', returnByValue: true }).catch(() => null);
      value.scroll = position?.result?.value || { x: 0, y: 0 };
    } catch (error) { connection.close(); this.connections.delete(tab.id); throw error; }
  }

  async pollScroll(value) {
    const result = await value.connection.command('Runtime.evaluate', { expression: '({x:scrollX,y:scrollY})', returnByValue: true });
    const position = result.result?.value; if (!position) return;
    if (position.x !== value.scroll.x || position.y !== value.scroll.y) { value.scroll = position; this.enqueueForward(value.tab.id, { type: 'scroll', x: position.x, y: position.y }); }
  }

  forwardKey(tabId, payload, action = 'forward') {
    if (action === 'navigate') return `navigate:${tabId}`;
    if (payload.type === 'input') return `input:${tabId}:${payload.selector || payload.name || payload.placeholder || ''}`;
    if (payload.type === 'scroll') return `scroll:${tabId}`;
    if (payload.type === 'wheel') return `wheel:${tabId}:${payload.x || 0}:${payload.y || 0}`;
    if (payload.type === 'mouse' && payload.phase === 'move') return `move:${tabId}`;
    return '';
  }

  enqueueForward(tabId, payload, action = 'forward') {
    this.markActivity();
    const key = this.forwardKey(tabId, payload, action); const now = Date.now();
    if (key && this.coalescedForwards.has(key)) {
      const entry = this.coalescedForwards.get(key);
      if (payload.type === 'wheel') entry.payload = { ...payload, deltaX: (Number(entry.payload.deltaX) || 0) + (Number(payload.deltaX) || 0), deltaY: (Number(entry.payload.deltaY) || 0) + (Number(payload.deltaY) || 0) };
      else entry.payload = payload;
      entry.queuedAt = now; this.forwardStats.coalesced += 1; this.emitForwardHealth(); return;
    }
    if (key && this.forwardQueue.length >= 256) {
      const index = this.forwardQueue.findIndex((entry) => entry.key);
      if (index >= 0) { const [removed] = this.forwardQueue.splice(index, 1); this.coalescedForwards.delete(removed.key); this.forwardStats.dropped += 1; }
    }
    const entry = { tabId, payload, action, key, queuedAt: now }; this.forwardQueue.push(entry); if (key) this.coalescedForwards.set(key, entry);
    this.drainForwardQueue(); this.emitForwardHealth();
  }

  async drainForwardQueue() {
    if (this.forwardQueueRunning) return; this.forwardQueueRunning = true;
    try {
      while (this.master && this.forwardQueue.length) {
        const entry = this.forwardQueue.shift(); if (entry.key) this.coalescedForwards.delete(entry.key);
        const started = Date.now();
        try { if (entry.action === 'navigate') await this.navigateSlaves(entry.tabId, entry.payload.url); else await this.forward(entry.tabId, entry.payload); }
        catch (error) { this.emit({ type: 'sync-error', action: 'forward', message: error.message }); }
        this.forwardStats.processed += 1; this.forwardStats.lastLatencyMs = Date.now() - started; this.emitForwardHealth();
      }
    } finally { this.forwardQueueRunning = false; this.emitForwardHealth(true); }
  }

  emitForwardHealth(force = false) {
    const now = Date.now(); if (!force && now - this.lastHealthEmitAt < 1000) return; this.lastHealthEmitAt = now;
    this.emit({ type: 'sync-health', queueDepth: this.forwardQueue.length, skippedRefreshes: this.skippedRefreshes, ...this.forwardStats });
  }

  async handle(tabId, event) {
    if (event.method === 'Runtime.executionContextCreated') {
      const context = event.params?.context;
      const contextId = context?.id; const connection = this.connections.get(tabId)?.connection;
      // The DOM event bridge must be installed once in Chromium's default
      // world. Isolated worlds receive the same DOM events but keep their own
      // window sentinel, which otherwise duplicates every forwarded action.
      if (context?.auxData?.isDefault === false) return;
      if (contextId && connection) connection.command(
        'Runtime.evaluate',
        { expression: injection, contextId },
        event.sessionId ? { sessionId: event.sessionId } : {},
      ).catch(() => {});
    }
    if (event.method === 'Runtime.bindingCalled' && event.params?.name === 'openBrowserSync') {
      let payload; try { payload = JSON.parse(event.params.payload); } catch (_) { return; }
      this.enqueueForward(tabId, payload);
    }
    if (event.method === 'Page.frameNavigated' && !event.params?.frame?.parentId) {
      const url = event.params.frame.url;
      if (url && !/^(chrome|edge|devtools|chrome-extension|edge-extension):/i.test(url)) this.enqueueForward(tabId, { url }, 'navigate');
    }
  }

  masterIndex(tabId) { const index = this.masterTabs.findIndex((tab) => tab.id === tabId); return Math.max(0, index); }

  async slaveTab(slave, tabId) {
    const index = this.masterIndex(tabId); const masterTab = this.masterTabs[index]; let tabs = normalTabs(await cdp.tabs(slave.port));
    if (masterTab) { const sameUrl = tabs.find((tab) => tab.url === masterTab.url); if (sameUrl) return sameUrl; }
    while (tabs.length <= index) { await cdp.newTab(slave.port, masterTab?.url || 'about:blank'); tabs = normalTabs(await cdp.tabs(slave.port)); }
    return tabs[index] || tabs[0] || null;
  }

  async eachSlave(tabId, action) { await Promise.all(this.slaves.map(async (slave) => { const tab = await this.slaveTab(slave, tabId); if (tab) await action(tab, slave); })); }

  urlKey(url) {
    return String(url || '').replace(/\/$/, '').toLowerCase();
  }

  urlsMatch(a, b) {
    const x = this.urlKey(a); const y = this.urlKey(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const blank = (v) => v === 'about:blank' || v === 'chrome://newtab' || v === 'chrome://new-tab-page' || v === 'edge://newtab';
    return blank(x) && blank(y);
  }

  async navigateSlaves(tabId, url) {
    await this.eachSlave(tabId, (tab) => this.urlsMatch(tab.url, url)
      ? Promise.resolve()
      : cdp.call(tab.webSocketDebuggerUrl, 'Page.navigate', { url }));
  }

  async mappedMousePoint(tab, payload, focus = false) {
    const selector = JSON.stringify(String(payload.selector || '')); const fallbackX = Number(payload.x) || 0; const fallbackY = Number(payload.y) || 0;
    const rx = Math.max(0, Math.min(1, Number.isFinite(Number(payload.rx)) ? Number(payload.rx) : .5)); const ry = Math.max(0, Math.min(1, Number.isFinite(Number(payload.ry)) ? Number(payload.ry) : .5));
    const tag = JSON.stringify(String(payload.tag || '').toLowerCase()); const role = JSON.stringify(String(payload.role || '')); const aria = JSON.stringify(String(payload.ariaLabel || '')); const text = JSON.stringify(String(payload.text || '').trim().slice(0, 200)); const elementType = JSON.stringify(String(payload.elementType || ''));
    const expression = `(() => { const deep=(path)=>{let root=document,e=null;for(const part of path.split(/\s*>>>\s*/)){e=root.querySelector(part);if(!e)return null;root=e.shadowRoot||e;}return e;}; const visible=(e)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}; let e=deep(${selector}); if(!e){const query=${tag}||'button,input,textarea,select,a,[role],[tabindex],[contenteditable="true"]';let score=-1e9;for(const item of document.querySelectorAll(query)){if(!visible(item))continue;let value=0;const itemRole=String(item.getAttribute('role')||'');const itemAria=String(item.getAttribute('aria-label')||'');const itemText=String(item.innerText||item.textContent||'').trim().replace(/\s+/g,' ').slice(0,200);if(${tag}&&item.tagName.toLowerCase()===${tag})value+=100;if(${elementType}&&String(item.type||'')===${elementType})value+=120;if(${role}&&itemRole===${role})value+=250;if(${aria}&&itemAria===${aria})value+=500;if(${text}&&itemText===${text})value+=450;if(value>score){score=value;e=item;}}} if(!e)return{x:${fallbackX},y:${fallbackY},found:false};${focus ? "try{e.focus({preventScroll:true})}catch(_){try{e.focus()}catch(__){}}" : ''}const r=e.getBoundingClientRect();return{x:r.left+r.width*${rx},y:r.top+r.height*${ry},found:true};})()`;
    const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true }).catch(() => null);
    const value = result?.result?.value; return value && Number.isFinite(value.x) && Number.isFinite(value.y) ? value : { x: fallbackX, y: fallbackY, found: false };
  }

  async forward(tabId, payload) {
    if (!this.master || !this.slaves.length) return;
    if (payload.type === 'click') {
      await this.eachSlave(tabId, async (tab) => {
        const point = await this.mappedMousePoint(tab, payload, true); const button = ['left', 'middle', 'right'][payload.button] || 'left';
        await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, buttons: 1, clickCount: 1 });
        await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount: 1 });
      });
    } else if (payload.type === 'mouse') {
      const types = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' }; const type = types[payload.phase]; if (!type) return;
      await this.eachSlave(tabId, async (tab) => { const point = await this.mappedMousePoint(tab, payload, payload.phase === 'down'); await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: ['left', 'middle', 'right'][payload.button] || 'left', buttons: Number(payload.buttons) || 0, clickCount: payload.phase === 'move' ? 0 : 1 }); });
    } else if (payload.type === 'wheel') {
      if (payload.ctrl) return;
      await this.eachSlave(tabId, async (tab) => { const point = await this.mappedMousePoint(tab, payload, false); await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: Number(payload.deltaX) || 0, deltaY: Number(payload.deltaY) || 0 }); });
    } else if (payload.type === 'scroll') {
      const expression = `scrollTo(${Number(payload.x) || 0},${Number(payload.y) || 0});true`; await this.eachSlave(tabId, (tab) => cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression }));
    } else if (payload.type === 'focus' || payload.type === 'beforeinput') {
      const selector = JSON.stringify(String(payload.selector || '')); const start = Number.isInteger(payload.start) ? payload.start : null; const end = Number.isInteger(payload.end) ? payload.end : null;
      const x = Number(payload.x) || 0; const y = Number(payload.y) || 0; const tag = JSON.stringify(String(payload.tag || '')); const type = JSON.stringify(String(payload.elementType || '')); const name = JSON.stringify(String(payload.name || '')); const placeholder = JSON.stringify(String(payload.placeholder || ''));
      const expression = `(() => { const deep=(path)=>{let root=document,e=null;for(const part of path.split(/\s*>>>\s*/)){e=root.querySelector(part);if(!e)return null;root=e.shadowRoot||e;}return e;}; const at=(doc,px,py)=>{let e=doc.elementFromPoint(px,py);if(e&&e.tagName==='IFRAME'){try{const r=e.getBoundingClientRect(),d=e.contentDocument;if(d)return at(d,px-r.left,py-r.top);}catch(_){}}return e;}; const similar=()=>{const list=[...document.querySelectorAll('input,textarea,[contenteditable="true"]')];let best=null,score=-1e9;for(const e of list){const r=e.getBoundingClientRect();let s=-Math.hypot(r.left+r.width/2-${x},r.top+r.height/2-${y});if(${tag}&&e.tagName.toLowerCase()===${tag})s+=400;if(${type}&&e.type===${type})s+=120;if(${name}&&e.name===${name})s+=300;if(${placeholder}&&e.placeholder===${placeholder})s+=240;if(s>score){score=s;best=e;}}return best;}; const e=deep(${selector})||at(document,${x},${y})||similar(); if(!e)return false; e.focus(); if(typeof e.setSelectionRange==='function' && ${start}!==null)e.setSelectionRange(${start},${end}); return true; })()`;
      await this.eachSlave(tabId, async (tab) => { const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true }); if (result.result?.value || !x || !y) return; await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); });
    } else if (payload.type === 'input') {
      const selector = JSON.stringify(String(payload.selector || '')); const value = JSON.stringify(String(payload.value || '')); const start = Number.isInteger(payload.start) ? payload.start : null; const end = Number.isInteger(payload.end) ? payload.end : null;
      const x = Number(payload.x) || 0; const y = Number(payload.y) || 0; const tag = JSON.stringify(String(payload.tag || '')); const type = JSON.stringify(String(payload.elementType || '')); const name = JSON.stringify(String(payload.name || '')); const placeholder = JSON.stringify(String(payload.placeholder || '')); const inputType = JSON.stringify(String(payload.inputType || 'insertText')); const data = payload.data == null ? 'null' : JSON.stringify(String(payload.data));
      const expression = `(() => { const deep=(path)=>{let root=document,e=null;for(const part of path.split(/\s*>>>\s*/)){e=root.querySelector(part);if(!e)return null;root=e.shadowRoot||e;}return e;}; const at=(doc,px,py)=>{let e=doc.elementFromPoint(px,py);if(e&&e.tagName==='IFRAME'){try{const r=e.getBoundingClientRect(),d=e.contentDocument;if(d)return at(d,px-r.left,py-r.top);}catch(_){}}return e;}; const similar=()=>{const list=[...document.querySelectorAll('input,textarea,[contenteditable="true"]')];let best=null,score=-1e9;for(const e of list){const r=e.getBoundingClientRect();let s=-Math.hypot(r.left+r.width/2-${x},r.top+r.height/2-${y});if(${tag}&&e.tagName.toLowerCase()===${tag})s+=400;if(${type}&&e.type===${type})s+=120;if(${name}&&e.name===${name})s+=300;if(${placeholder}&&e.placeholder===${placeholder})s+=240;if(s>score){score=s;best=e;}}return best;}; const e=deep(${selector})||at(document,${x},${y})||similar(); if(!e)return false; e.focus(); if('value' in e){const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(setter)setter.call(e,${value});else e.value=${value};}else e.textContent=${value}; if(typeof e.setSelectionRange==='function' && ${start}!==null)e.setSelectionRange(${start},${end}); e.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:${inputType},data:${data}})); e.dispatchEvent(new Event('change',{bubbles:true,composed:true})); return true; })()`;
      await this.eachSlave(tabId, async (tab) => { const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true }); if (result.result?.value || !x || !y) return; await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }); await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }); await cdp.call(tab.webSocketDebuggerUrl, 'Input.insertText', { text: JSON.parse(value) }); });
    } else if (payload.type === 'key') {
      const keyName = String(payload.key || '').toLowerCase();
      if (payload.ctrl && ['c', 'x', 'v'].includes(keyName)) return;
      if (payload.ctrl && ['0','+','-','='].includes(String(payload.key || ''))) return;
      let modifiers = 0; if (payload.alt) modifiers |= 1; if (payload.ctrl) modifiers |= 2; if (payload.meta) modifiers |= 4; if (payload.shift) modifiers |= 8;
      const printable = String(payload.key || '').length === 1 && !payload.ctrl && !payload.alt && !payload.meta;
      if (payload.editable && (printable || ['backspace', 'delete'].includes(keyName))) return;
      const params = { type: payload.phase === 'up' ? 'keyUp' : 'keyDown', text: payload.phase === 'down' && printable ? String(payload.key) : '', unmodifiedText: payload.phase === 'down' && printable ? String(payload.key) : '', key: String(payload.key || ''), code: String(payload.code || ''), windowsVirtualKeyCode: Number(payload.keyCode) || 0, nativeVirtualKeyCode: Number(payload.keyCode) || 0, location: Number(payload.location) || 0, modifiers };
      await this.eachSlave(tabId, (tab) => cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', params));
    }
  }
}

module.exports = { LiveSyncController, PersistentCdp, injection };
