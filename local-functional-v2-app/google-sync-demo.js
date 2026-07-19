const fs = require('fs/promises');
const path = require('path');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const cdp = require('./cdp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dataRoot = path.join(__dirname, '..', 'google-sync-demo-data');
const statusFile = path.join(__dirname, '..', 'google-sync-demo-status.json');
async function closeExisting() { for (const id of ['google-master-direct', 'google-slave-direct']) { try { const raw = await fs.readFile(path.join(dataRoot, 'browser-profiles-v2', id, 'DevToolsActivePort'), 'utf8'); const port = Number(raw.split(/\r?\n/)[0]); const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); await cdp.call(version.webSocketDebuggerUrl, 'Browser.close'); } catch (_) {} } await sleep(1200); }
let engine; let sync; let finishing = false;

async function evaluate(port, expression) {
  const tab = await cdp.firstTab(port); const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.result?.value;
}

async function finish() {
  if (finishing) return; finishing = true; sync?.stop(); await engine?.stopAll().catch(() => {}); process.exit(0);
}

async function main() {
  await closeExisting();
  await fs.rm(dataRoot, { recursive: true, force: true }); await fs.mkdir(dataRoot, { recursive: true });
  const app = { getPath(name) { if (name === 'userData') return dataRoot; throw new Error(name); } };
  engine = new BrowserEngine(app); await engine.init(null);
  const profiles = [
    { id: 'google-master-direct', name: 'Google 主控（本地网络）', browser: 'Google Chrome', proxy: 'Direct', language: 'zh-CN' },
    { id: 'google-slave-direct', name: 'Google 被控（本地网络）', browser: 'Google Chrome', proxy: 'Direct', language: 'zh-CN' }
  ];
  engine.syncProfiles(profiles); const master = await engine.start(profiles[0]); const slave = await engine.start(profiles[1]);
  if (!master.port || !slave.port) throw new Error('Chrome CDP 端口未就绪');
  await Promise.all([cdp.navigate(master.port, 'https://www.google.com/'), cdp.navigate(slave.port, 'https://www.google.com/')]);
  await Promise.all([cdp.setWindowBounds(master.port, { left: 0, top: 0, width: 940, height: 880 }), cdp.setWindowBounds(slave.port, { left: 950, top: 0, width: 940, height: 880 })]);
  await sleep(7000);
  const pages = await Promise.all([master, slave].map(async (item) => ({ port: item.port, url: await evaluate(item.port, 'location.href'), title: await evaluate(item.port, 'document.title'), readyState: await evaluate(item.port, 'document.readyState'), searchBox: await evaluate(item.port, "Boolean(document.querySelector('textarea[name=q],input[name=q]'))") })));
  if (!pages.every((page) => /^https:\/\/(www\.)?google\./i.test(page.url) && ['interactive', 'complete'].includes(page.readyState) && page.searchBox)) throw new Error('Google 页面未在两个窗口正常完成加载：' + JSON.stringify(pages));
  sync = new LiveSyncController(engine, () => {}); await sync.start(profiles.map((item) => item.id));
  const testText = 'GPT Chrome 同步测试成功';
  const injected = await evaluate(master.port, `(() => { const e=document.querySelector('textarea[name=q],input[name=q]'); if(!e)return false; e.focus(); e.value=${JSON.stringify(testText)}; e.dispatchEvent(new InputEvent('input',{bubbles:true,data:${JSON.stringify(testText)},inputType:'insertText'})); return true; })()`);
  await sleep(1200); const slaveValue = await evaluate(slave.port, `document.querySelector('textarea[name=q],input[name=q]')?.value || ''`);
  const status = { success: injected && slaveValue === testText, network: 'Direct / Windows local network', browser: master.browser, masterPid: master.pid, slavePid: slave.pid, masterPort: master.port, slavePort: slave.port, pages, expected: testText, slaveValue, syncActive: true, startedAt: new Date().toISOString(), expiresInMinutes: 10 };
  await fs.writeFile(statusFile, JSON.stringify(status, null, 2), 'utf8'); process.stdout.write(JSON.stringify(status, null, 2));
  if (!status.success) throw new Error('Google 搜索框同步校验失败');
  setTimeout(finish, 10 * 60 * 1000);
}

process.on('SIGINT', finish); process.on('SIGTERM', finish);
main().catch(async (error) => { await fs.writeFile(statusFile, JSON.stringify({ success: false, error: error.message, at: new Date().toISOString() }, null, 2), 'utf8').catch(() => {}); process.stderr.write(error.stack || error.message); await finish(); process.exitCode = 1; });
