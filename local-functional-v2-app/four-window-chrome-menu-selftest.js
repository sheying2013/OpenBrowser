const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const cdp = require('./cdp');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true }); let out = ''; let err = '';
    child.stdout.on('data', (value) => { out += value; }); child.stderr.on('data', (value) => { err += value; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err || out || `menu driver exited ${code}`)));
  });
}

async function main() {
  const root = path.join(__dirname, '..', 'four-window-chrome-menu-data');
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  const profiles = Array.from({ length: 4 }, (_, index) => ({ id: `menu-env-${index + 1}`, name: String(index + 1), browser: 'Google Chrome', proxy: 'Direct' }));
  const controller = new LiveSyncController(engine, () => {});
  try {
    await engine.init(null); engine.syncProfiles(profiles);
    const sessions = [];
    for (const profile of profiles) sessions.push(await engine.start(profile));
    const bounds = [
      { left: 0, top: 0, width: 900, height: 480 }, { left: 900, top: 0, width: 900, height: 480 },
      { left: 0, top: 480, width: 900, height: 480 }, { left: 900, top: 480, width: 900, height: 480 },
    ];
    await Promise.all(sessions.map((session, index) => cdp.setWindowBounds(session.port, bounds[index])));
    await controller.start(profiles.map((profile) => profile.id)); await wait(1200);
    const driver = path.join(__dirname, 'native-extension-popup-driver.exe');
    const clickOutput = await run(driver, ['--coordinates', '878', '52']);
    await wait(1200);
    const menuOutput = await run(driver, ['--check-menus', ...sessions.map((session) => String(session.pid))]);
    process.stdout.write(JSON.stringify({ success: true, fourChrome: sessions.map((session) => ({ id: session.id, pid: session.pid })), clickOutput, menuOutput }, null, 2));
  } finally {
    controller.stop(); await engine.stopAll().catch(() => {}); await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
