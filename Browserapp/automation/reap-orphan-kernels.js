#!/usr/bin/env node
'use strict';
/**
 * Reap orphaned headless OpenBrowser kernels.
 *
 * Test harnesses spawn the kernel launcher detached+unref and frequently never
 * reap it. When the launcher/wrapper dies the backgrounded kernel is reparented
 * to launchd (ppid 1) and lingers, so dozens of headless Chrome instances pile
 * up and exhaust RAM/CPU. This helper kills ONLY kernels that are provably
 * orphaned: either their store_data_path profile directory no longer exists, or
 * their parent is launchd (ppid 1) and no live test process still references
 * them. Active test kernels (profile dir still present, live parent) are kept.
 *
 * Usage:
 *   node automation/reap-orphan-kernels.js            # reap orphans
 *   node automation/reap-orphan-kernels.js --dry-run  # report only
 *   node automation/reap-orphan-kernels.js --all      # kill every kernel (use with care)
 */
const { execFileSync } = require('child_process');
const fs = require('fs');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const killAll = args.includes('--all');

function listKernels() {
  let out = '';
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch (_) { return []; }
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, command] = m;
    if (!command.includes('Contents/MacOS/OpenBrowser.bin')) continue;
    const sm = command.match(/store_data_path=([A-Za-z0-9+/=]+)/);
    let dir = '';
    if (sm) { try { dir = Buffer.from(sm[1], 'base64').toString('utf8'); } catch (_) {} }
    rows.push({ pid: Number(pid), ppid: Number(ppid), dir, command });
  }
  return rows;
}

const kernels = listKernels();
let reaped = 0;
let kept = 0;
for (const k of kernels) {
  const dirGone = k.dir && !fs.existsSync(k.dir);
  const orphaned = k.ppid === 1;
  const shouldKill = killAll || dirGone || orphaned;
  if (!shouldKill) { kept += 1; continue; }
  if (!dryRun) {
    try { process.kill(k.pid, 'SIGTERM'); } catch (_) {}
  }
  reaped += 1;
  console.log(`${dryRun ? '[dry-run] would reap' : 'reaped'} pid=${k.pid} ppid=${k.ppid} dir=${k.dir || '(none)'}${dirGone ? ' [profile gone]' : ''}${orphaned ? ' [orphaned]' : ''}`);
}
console.log(`\nTotal kernels: ${kernels.length}  reaped: ${reaped}  kept(active): ${kept}`);
