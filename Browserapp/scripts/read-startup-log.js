#!/usr/bin/env node
'use strict';

/**
 * Print recent browser-startup.log entries.
 *   node scripts/read-startup-log.js
 *   node scripts/read-startup-log.js --tail 80
 *   node scripts/read-startup-log.js --file C:\\path\\browser-startup.log
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function defaultLogPath() {
  if (process.env.OPENBROWSER_STARTUP_LOG) return String(process.env.OPENBROWSER_STARTUP_LOG);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'openbrowser', 'logs', 'browser-startup.log');
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'openbrowser', 'logs', 'browser-startup.log');
  }
  return path.join(os.homedir(), '.config', 'openbrowser', 'logs', 'browser-startup.log');
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function main() {
  const args = process.argv.slice(2);
  const file = argValue(args, '--file') || defaultLogPath();
  const tail = Math.max(1, Number(argValue(args, '--tail') || 80) || 80);

  console.log('log:', file);
  if (!fs.existsSync(file)) {
    console.log('(file not found yet — start an environment once after this build)');
    return;
  }

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const slice = lines.slice(-tail);
  for (const line of slice) {
    let row;
    try { row = JSON.parse(line); } catch (_) {
      console.log(line);
      continue;
    }
    const short = {
      at: row.at,
      type: row.type,
      profileId: row.profileId,
      browser: row.browser,
      source: row.source,
      exitCode: row.exitCode,
      signal: row.signal,
      executable: row.executable,
      profileRoot: row.profileRoot,
      error: row.error,
      stderr: row.stderr,
      stdout: row.stdout,
      spawnError: row.spawnError,
    };
    console.log(JSON.stringify(short));
  }
  console.log(`--- ${slice.length}/${lines.length} lines ---`);
}

main();
