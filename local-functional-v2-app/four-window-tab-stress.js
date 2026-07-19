const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const cdp = require('./cdp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function run(file, args) { return new Promise((resolve, reject) => { const started = Date.now(); const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve(Date.now() - started) : reject(new Error(`shortcut driver exited ${code}`))); }); }
async function counts(sessions) { return Promise.all(sessions.map(async (session) => (await cdp.tabs(session.port)).length)); }
async function waitForCounts(sessions, expected, timeout = 6000) { const started = Date.now(); while (Date.now() - started < timeout) { const values = await counts(sessions); if (values.every((value) => value === expected)) return { latency: Date.now() - started, counts: values }; await sleep(50); } throw new Error(`tab propagation timeout: expected ${expected}, got ${JSON.stringify(await counts(sessions))}`); }

async function main() {
  const root = path.join(__dirname, '..', 'four-window-tab-stress-data'); await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  const profiles = Array.from({ length: 4 }, (_, index) => ({ id: `stress-env-${index + 1}`, name: index ? `Stress Slave ${index}` : 'Stress Master', browser: 'Google Chrome', proxy: 'Direct' }));
  const events = []; let sync;
  try {
    await engine.init(null); engine.syncProfiles(profiles); const sessions = [];
    for (const profile of profiles) sessions.push(await engine.start(profile));
    sync = new LiveSyncController(engine, (event) => events.push(event)); await sync.start(profiles.map((profile) => profile.id)); await sleep(1600);
    const driver = path.join(__dirname, 'native-tab-shortcut-driver.exe'); const initial = (await counts(sessions))[0];
    const opens = [];
    for (let index = 1; index <= 6; index += 1) { const shortcutMs = await run(driver, [String(sessions[0].pid), 'open']); const propagated = await waitForCounts(sessions, initial + index); opens.push({ index, shortcutMs, propagationMs: propagated.latency, counts: propagated.counts }); await sleep(180); }
    const closes = [];
    for (let index = 1; index <= 4; index += 1) { const shortcutMs = await run(driver, [String(sessions[0].pid), 'close']); const propagated = await waitForCounts(sessions, initial + 6 - index); closes.push({ index, shortcutMs, propagationMs: propagated.latency, counts: propagated.counts }); await sleep(180); }
    const errors = events.filter((event) => event.type === 'sync-error' || event.type === 'sync-disconnected');
    if (errors.length) throw new Error('sync errors: ' + JSON.stringify(errors));
    const propagation = [...opens, ...closes].map((entry) => entry.propagationMs); const shortcut = [...opens, ...closes].map((entry) => entry.shortcutMs);
    process.stdout.write(JSON.stringify({ success: true, windows: 4, operations: 10, opens, closes, maxPropagationMs: Math.max(...propagation), averagePropagationMs: Math.round(propagation.reduce((a, b) => a + b, 0) / propagation.length), maxShortcutMs: Math.max(...shortcut), skippedOverlappingRefreshes: sync.skippedRefreshes, finalCounts: await counts(sessions) }, null, 2));
  } finally { sync?.stop(); await engine.stopAll().catch(() => {}); await fs.rm(root, { recursive: true, force: true }).catch(() => {}); }
}
main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
