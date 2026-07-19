const path = require('path');
const fs = require('fs/promises');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const cdp = require('./cdp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = path.join(__dirname, '..', 'disconnect-selftest-data');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  const profiles = [
    { id: 'disconnect-master', name: 'Disconnect Master', browser: 'Google Chrome', proxy: 'Direct' },
    { id: 'disconnect-slave', name: 'Disconnect Slave', browser: 'Google Chrome', proxy: 'Direct' },
  ];
  const events = [];
  let sync;
  try {
    await engine.init(null); engine.syncProfiles(profiles);
    await engine.start(profiles[0]); await engine.start(profiles[1]);
    sync = new LiveSyncController(engine, (event) => events.push({ ...event, at: Date.now() }));
    await sync.start(profiles.map((profile) => profile.id));
    await sleep(1500);
    const slavePort = engine.running.get(profiles[1].id).port;
    const version = await (await fetch('http://127.0.0.1:' + slavePort + '/json/version')).json();
    await cdp.call(version.webSocketDebuggerUrl, 'Browser.close');
    await sleep(4200);
    const disconnected = events.filter((event) => event.type === 'sync-disconnected');
    const refused = events.filter((event) => event.type === 'sync-error' && /ECONNREFUSED|connection refused/i.test(String(event.message)));
    if (disconnected.length !== 1) throw new Error(`expected one disconnect event, got ${disconnected.length}: ${JSON.stringify(events)}`);
    if (refused.length !== 0) throw new Error(`raw connection errors leaked: ${JSON.stringify(refused)}`);
    if (sync.timer !== null || sync.master !== null || sync.nativeInputMirror !== null) throw new Error('sync resources were not stopped');
    process.stdout.write(JSON.stringify({ success: true, disconnected: disconnected.length, rawConnectionErrors: refused.length, timerStopped: sync.timer === null, inputBridgeStopped: sync.nativeInputMirror === null, message: disconnected[0].message }, null, 2));
  } finally {
    sync?.stop(); await engine.stopAll().catch(() => {}); await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
