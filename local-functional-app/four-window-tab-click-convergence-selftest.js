const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const cdp = require('./cdp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(tab, expression) { const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true }); return result.result?.value; }
async function pageTabs(session, origin) { return (await cdp.tabs(session.port)).filter((tab) => tab.url.startsWith(origin)); }
async function counts(sessions) { return Promise.all(sessions.map(async (session) => (await cdp.tabs(session.port)).length)); }

async function waitFor(check, label, timeout = 10000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) { try { last = await check(); if (last?.pass) return { ...last, latencyMs: Date.now() - started }; } catch (_) {} await sleep(100); }
  throw new Error(`${label} timeout: ${JSON.stringify(last)}`);
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const match = request.url.match(/\/step\/(\d+)/); const step = match ? Number(match[1]) : 0;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(`<!doctype html><meta charset=utf-8><title>step-${step}</title><style>body{font:18px Segoe UI,sans-serif;padding:45px}button{font:18px Segoe UI;padding:18px 34px}</style><h1>step ${step}</h1><button id=next>next</button><script>next.onclick=()=>{const value=Number(localStorage.getItem('openbrowser-durable-clicks')||0)+1;localStorage.setItem('openbrowser-durable-clicks',String(value));location.href='/step/${step + 1}';};</script>`);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const server = await startServer(); const origin = `http://127.0.0.1:${server.address().port}`;
  const root = path.join(__dirname, '..', 'four-window-tab-click-convergence-data'); await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  const profiles = Array.from({ length: 4 }, (_, index) => ({ id: `converge-env-${index + 1}`, name: index ? `Converge Slave ${index}` : 'Converge Master', browser: 'Google Chrome', proxy: 'Direct' }));
  const events = []; let sync;
  try {
    await engine.init(null); engine.syncProfiles(profiles); const sessions = [];
    for (const profile of profiles) sessions.push(await engine.start(profile));
    await Promise.all(sessions.map((session) => cdp.navigate(session.port, `${origin}/step/0`))); await sleep(900);

    for (const session of sessions.slice(1)) { await cdp.newTab(session.port, 'about:blank'); await cdp.newTab(session.port, 'about:blank'); }
    const beforeStart = await counts(sessions);
    sync = new LiveSyncController(engine, (event) => events.push(event)); await sync.start(profiles.map((profile) => profile.id));
    const startupConvergence = await waitFor(async () => { const value = await counts(sessions); return { pass: value.every((count) => count === value[0]) && value[0] === 1, counts: value }; }, 'startup convergence');

    const created = await Promise.all(sessions.map((session) => cdp.newTab(session.port, `${origin}/step/0`)));
    const adoptedCreation = await waitFor(async () => { const value = await counts(sessions); return { pass: value.every((count) => count === 2), counts: value }; }, 'native/CDP duplicate adoption');
    await sleep(1500); const stableCounts = await counts(sessions); if (!stableCounts.every((count) => count === 2)) throw new Error('duplicate tabs returned: ' + JSON.stringify(stableCounts));
    await cdp.activateTab(sessions[0].port, created[0].id);
    const mappingReady = await waitFor(async () => { const mapping = sync.tabMap.get(created[0].id); return { pass: Boolean(mapping && sync.slaves.every((slave) => mapping.get(slave.id))), targets: mapping ? [...mapping.entries()] : [] }; }, 'tab mapping');

    const steps = [];
    for (let step = 1; step <= 12; step += 1) {
      if (step === 7) {
        const previous = sync.connections.get(created[0].id)?.connection; previous?.close();
        await waitFor(async () => { const current = sync.connections.get(created[0].id)?.connection; return { pass: Boolean(current && current !== previous && current.socket?.readyState === 1) }; }, 'persistent CDP reconnect');
      }
      const masterTab = (await cdp.tabs(sessions[0].port)).find((tab) => tab.id === created[0].id); if (!masterTab) throw new Error('master tab disappeared');
      const point = await evaluate(masterTab, `(() => { const r=document.querySelector('#next').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
      await cdp.call(masterTab.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.call(masterTab.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      const result = await waitFor(async () => {
        const mapping = sync.tabMap.get(created[0].id); const values = [];
        for (let index = 0; index < sessions.length; index += 1) {
          const id = index === 0 ? created[0].id : mapping?.get(sync.slaves[index - 1].id);
          const tab = (await cdp.tabs(sessions[index].port)).find((item) => item.id === id); if (!tab) return { pass: false, values };
          const clicks = await evaluate(tab, `Number(localStorage.getItem('openbrowser-durable-clicks')||0)`); values.push({ url: tab.url, clicks });
        }
        return { pass: values.every((value) => value.url.endsWith(`/step/${step}`) && value.clicks === step), values };
      }, `click step ${step}`);
      steps.push({ step, latencyMs: result.latencyMs, values: result.values });
    }

    await cdp.closeTab(sessions[0].port, created[0].id);
    const closeConvergence = await waitFor(async () => { const value = await counts(sessions); return { pass: value.every((count) => count === 1), counts: value }; }, 'close convergence');
    const errors = events.filter((event) => event.type === 'sync-error' || event.type === 'sync-disconnected');
    if (errors.length) throw new Error('sync errors: ' + JSON.stringify(errors));
    process.stdout.write(JSON.stringify({ success: true, windows: 4, beforeStart, startupConvergence, adoptedCreation, stableCounts, mappingReady, durableClicks: steps.length, maxClickLatencyMs: Math.max(...steps.map((item) => item.latencyMs)), reconnectedAtStep: 7, closeConvergence, reconciliationEvents: events.filter((event) => event.type === 'live-sync-tab-reconcile') }, null, 2));
  } finally {
    sync?.stop(); await engine.stopAll().catch(() => {}); await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
