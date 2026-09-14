#!/usr/bin/env node
'use strict';

/**
 * Stability policy & skipHosts semantic locking selftest.
 *
 * Verifies and locks the intended design semantics:
 * 1. stability match -> active === true -> noiseAmplitude === 1 -> delta === 0 (zero noise, max consistency)
 * 2. skipHosts match -> active === false -> noiseAmplitude === 3 -> delta in {-1, 0, 1} (exception table retaining normal noise)
 * 3. mode 3-state semantics:
 *    - 'off': active is always false
 *    - 'force': active is true for all hosts except skipHosts
 *    - 'auto': active is true only for hosts in stability.hosts that are not in skipHosts
 * 4. Numerical assertion: delta = Math.floor(noise * amp) - Math.floor(amp / 2)
 *    yields exactly {0} for amp=1, and exactly {-1, 0, 1} for amp=3.
 */

const assert = require('assert');
const { resolveStabilityPolicy } = require('./fingerprint');

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
};

// 1. Target high-risk host matches stability policy -> active === true, noiseAmplitude === 1
check('resolveStabilityPolicy: www.amazon.com active is true with noiseAmplitude 1', () => {
  const res = resolveStabilityPolicy({}, { host: 'www.amazon.com' });
  assert.strictEqual(res.active, true, 'amazon.com must match stability.hosts');
  assert.strictEqual(res.noiseAmplitude, 1, 'stability active must set noiseAmplitude to 1');
  assert.strictEqual(res.sampleStepDivisor, 128, 'stability active must set sampleStepDivisor to 128');
});

// 2. Host on skipHosts exception table -> active === false, noiseAmplitude === 3 (retains normal noise)
check('resolveStabilityPolicy: www.sephora.com active is false with noiseAmplitude 3', () => {
  const res = resolveStabilityPolicy({}, { host: 'www.sephora.com' });
  assert.strictEqual(res.active, false, 'sephora.com must be skipped from stability');
  assert.strictEqual(res.skipped, true, 'skipped flag must be true');
  assert.strictEqual(res.noiseAmplitude, 3, 'skipped host must keep default noiseAmplitude 3');
  assert.strictEqual(res.sampleStepDivisor, 64, 'skipped host must keep default sampleStepDivisor 64');
});

// 3. Subdomain on wildcard skipHosts (cdn.*) -> active === false
check('resolveStabilityPolicy: cdn.sephora.com active is false via cdn. wildcard', () => {
  const res = resolveStabilityPolicy({}, { host: 'cdn.sephora.com' });
  assert.strictEqual(res.active, false, 'cdn.* wildcard must skip stability');
  assert.strictEqual(res.skipped, true, 'skipped flag must be true');
  assert.strictEqual(res.noiseAmplitude, 3, 'skipped host must keep default noiseAmplitude 3');
});

// 4. Neutral host not in stability.hosts -> active === false, noiseAmplitude === 3
check('resolveStabilityPolicy: example.com active is false with noiseAmplitude 3', () => {
  const res = resolveStabilityPolicy({}, { host: 'example.com' });
  assert.strictEqual(res.active, false, 'neutral host must not activate stability');
  assert.strictEqual(res.noiseAmplitude, 3, 'neutral host must keep default noiseAmplitude 3');
});

// 5. mode='off' -> active is always false even on high-risk hosts
check('resolveStabilityPolicy: mode=off forces active to false everywhere', () => {
  const resAmazon = resolveStabilityPolicy({ stabilityMode: 'off' }, { host: 'www.amazon.com' });
  assert.strictEqual(resAmazon.active, false, 'mode=off must disable stability on amazon');
  assert.strictEqual(resAmazon.noiseAmplitude, 3, 'mode=off must use noiseAmplitude 3');

  const resExample = resolveStabilityPolicy({ stabilityMode: 'off' }, { host: 'example.com' });
  assert.strictEqual(resExample.active, false, 'mode=off must disable stability on example');
  assert.strictEqual(resExample.noiseAmplitude, 3);
});

// 6. mode='force' -> active is true everywhere except skipHosts
check('resolveStabilityPolicy: mode=force enables stability everywhere except skipHosts', () => {
  const resExample = resolveStabilityPolicy({ stabilityMode: 'force' }, { host: 'example.com' });
  assert.strictEqual(resExample.active, true, 'mode=force must enable stability on example.com');
  assert.strictEqual(resExample.noiseAmplitude, 1, 'mode=force must use noiseAmplitude 1');

  const resSephora = resolveStabilityPolicy({ stabilityMode: 'force' }, { host: 'www.sephora.com' });
  assert.strictEqual(resSephora.active, false, 'mode=force must still respect skipHosts exception');
  assert.strictEqual(resSephora.skipped, true);
  assert.strictEqual(resSephora.noiseAmplitude, 3, 'skipHosts must retain noiseAmplitude 3');
});

// 7. Numerical delta formula proof: amp=1 delta is {0}, amp=3 delta is {-1, 0, 1}
check('Numerical proof: delta formula yields {0} for amp=1 and {-1, 0, 1} for amp=3', () => {
  const deltasAmp1 = new Set();
  const deltasAmp3 = new Set();
  const step = 1 / 10000;
  for (let i = 0; i < 10000; i++) {
    const n = i * step; // n in [0, 1)
    const d1 = Math.floor(n * 1) - Math.floor(1 / 2);
    const d3 = Math.floor(n * 3) - Math.floor(3 / 2);
    deltasAmp1.add(d1);
    deltasAmp3.add(d3);
  }

  assert.deepStrictEqual(Array.from(deltasAmp1), [0], 'amp=1 delta must be strictly {0} (zero noise)');
  assert.deepStrictEqual(Array.from(deltasAmp3).sort((a, b) => a - b), [-1, 0, 1], 'amp=3 delta must be strictly {-1, 0, 1}');
});

const failed = results.filter((r) => !r.ok);
if (!failed.length) {
  console.log(`\nstability-semantics-selftest: OK ${results.length}/${results.length}`);
} else {
  console.log(`\nstability-semantics-selftest: FAILED ${failed.length}/${results.length}`);
  process.exitCode = 1;
}
