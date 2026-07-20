#!/usr/bin/env node
'use strict';

/**
 * Print recent fingerprint-inject.log lines (and highlight mismatches).
 *   node scripts/read-fp-log.js
 *   node scripts/read-fp-log.js --tail 80
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { defaultLogPath } = require('../automation/fingerprint-debug-log');

function resolvePath() {
  if (process.env.OPENBROWSER_FP_LOG) return process.env.OPENBROWSER_FP_LOG;
  return defaultLogPath();
}

function main() {
  const file = resolvePath();
  const args = process.argv.slice(2);
  let tail = 60;
  const tIdx = args.indexOf('--tail');
  if (tIdx >= 0 && args[tIdx + 1]) tail = Math.max(1, Number(args[tIdx + 1]) || 60);

  console.log('log:', file);
  if (!fs.existsSync(file)) {
    console.log('(file not found yet — start an environment once after this build)');
    process.exit(0);
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\n/).filter(Boolean);
  const slice = lines.slice(-tail);
  for (const line of slice) {
    let row;
    try { row = JSON.parse(line); } catch (_) {
      console.log(line);
      continue;
    }
    const flag = row.mismatch && Object.values(row.mismatch).some(Boolean) ? '⚠ MISMATCH ' : '';
    const short = {
      ts: row.ts,
      event: row.event,
      phase: row.phase,
      profileId: row.profileId,
      intended: row.intended || row.injectFp || row.fullFp || row.expected,
      live: row.live,
      mismatch: row.mismatch,
      error: row.error,
      tabUrls: row.tabUrls,
    };
    console.log(flag + JSON.stringify(short));
  }
  console.log(`--- ${slice.length}/${lines.length} lines ---`);
}

main();
