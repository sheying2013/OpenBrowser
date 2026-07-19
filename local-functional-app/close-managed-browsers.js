const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const cdp = require('./cdp');

function userDataRoot() {
  if (process.env.OPENBROWSER_USER_DATA) return process.env.OPENBROWSER_USER_DATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'openbrowser');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', 'openbrowser');
  return path.join(os.homedir(), '.config', 'openbrowser');
}

async function main() {
  const root = path.join(userDataRoot(), 'browser-profiles-v2');
  let names = [];
  try { names = await fs.readdir(root); } catch (_) { process.stdout.write(JSON.stringify({ closed: 0, root })); return; }
  let closed = 0;
  for (const name of names) {
    try {
      const raw = await fs.readFile(path.join(root, name, 'DevToolsActivePort'), 'utf8');
      const port = Number(raw.split(/\r?\n/)[0]);
      const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      await cdp.call(version.webSocketDebuggerUrl, 'Browser.close');
      closed += 1;
    } catch (_) {}
  }
  process.stdout.write(JSON.stringify({ closed, root }));
}

main().catch((error) => {
  process.stderr.write(String(error && error.message || error));
  process.exitCode = 1;
});
