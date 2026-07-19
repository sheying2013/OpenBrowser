const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const cdp = require('./cdp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true }); let out = ''; let err = '';
    child.stdout.on('data', (value) => { out += value; }); child.stderr.on('data', (value) => { err += value; });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve(out) : reject(new Error(`jitter driver exited ${code}: ${out}\n${err}`)));
  });
}

async function main() {
  const root = path.join(__dirname, '..', 'four-window-upper-ui-jitter-data');
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  const profiles = Array.from({ length: 4 }, (_, index) => ({ id: `upper-env-${index + 1}`, name: index ? `Upper Slave ${index}` : 'Upper Master', browser: 'Google Chrome', proxy: 'Direct' }));
  let sync;
  try {
    await engine.init(null); engine.syncProfiles(profiles); const sessions = [];
    for (const profile of profiles) sessions.push(await engine.start(profile));
    const bounds = [
      { left: 0, top: 0, width: 1000, height: 470 }, { left: 1000, top: 0, width: 1000, height: 470 },
      { left: 0, top: 470, width: 1000, height: 470 }, { left: 1000, top: 470, width: 1000, height: 470 },
    ];
    await Promise.all(sessions.map((session, index) => cdp.setWindowBounds(session.port, bounds[index])));
    sync = new LiveSyncController(engine, () => {}); await sync.start(profiles.map((item) => item.id)); await sleep(1800);
    const output = await run(path.join(__dirname, 'native-upper-ui-jitter-driver.exe'), sessions.map((item) => String(item.pid)));
    await sleep(800);
    const counts = await Promise.all(sessions.map(async (session) => (await cdp.tabs(session.port)).length));
    const urls = await Promise.all(sessions.map(async (session) => (await cdp.tabs(session.port)).map((tab) => tab.url)));
    if (!urls.every((list) => list.some((url) => url.startsWith('data:text/html')))) throw new Error(`navigation did not reach all four environments: ${JSON.stringify(urls)}`);
    if (!counts.every((value) => value === counts[0])) throw new Error(`tab counts differ: ${JSON.stringify(counts)}`);
    process.stdout.write(JSON.stringify({ success: true, windows: 4, layout: bounds, tabCounts: counts, urls, driver: output.trim().split(/\r?\n/) }, null, 2));
  } finally {
    sync?.stop(); await engine.stopAll().catch(() => {}); await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
