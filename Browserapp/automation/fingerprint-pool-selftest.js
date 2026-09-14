'use strict';

/**
 * OpenBrowser Fingerprint Pool Self-Test Suite
 *
 * Verifies the cross-environment fingerprint pool module:
 * 1. Default disabled state (zero allocation, no mutation)
 * 2. Deterministic reproducibility across seeds
 * 3. 100x stability for identical envIds
 * 4. Zero collisions across N unexhausted environments
 * 5. Bounded graceful reuse under exhaustion
 * 6. Internal consistency positive validation
 * 7. Negative rejection: GPU ↔ Platform contradiction
 * 8. Negative rejection: Font ↔ OS contradiction
 * 9. Negative rejection: Media device label ↔ OS contradiction
 * 10. Hardware coherence: CPU/Memory and Screen/DPR boundaries
 * 11. Provenance transparency (verified vs structural placeholders)
 * 12. State export and import persistence roundtrip
 */

const assert = require('assert');
const {
  createFingerprintPool,
  verifyPersonaConsistency,
  FingerprintPool,
  DEFAULT_OS_MIX,
  hashSeedToInt,
} = require('./fingerprint-pool');
const { PERSONAS_BY_OS } = require('./device-personas');

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    results.push({ name, ok: false, error: err });
  }
}

// ============================================================================
// 1. Default Disabled Behavior
// ============================================================================
test('1. Default disabled: enabled === false by default with zero side effects', () => {
  const pool = createFingerprintPool();
  assert.strictEqual(pool.enabled, false);
  assert.strictEqual(pool.assignPersona('env-1'), null);
  assert.strictEqual(pool.getPersona('env-1'), null);
  assert.strictEqual(pool.getAssignment('env-1'), null);
  assert.strictEqual(pool.hasPersona('env-1'), false);
  assert.strictEqual(pool.releasePersona('env-1'), false);

  const stats = pool.getPoolStats();
  assert.strictEqual(stats.enabled, false);
  assert.strictEqual(stats.poolSize, 0);
  assert.strictEqual(stats.assignedCount, 0);
  assert.strictEqual(stats.reusedCount, 0);
  assert.strictEqual(stats.availableCount, 0);
});

test('2. Default disabled: does not mutate incoming arguments or objects', () => {
  const pool = createFingerprintPool();
  const inputArg = { envId: 'env-test', customProp: 'untouched', flags: [1, 2, 3] };
  const serializedBefore = JSON.stringify(inputArg);

  pool.assignPersona(inputArg.envId);
  pool.getPersona(inputArg.envId);

  const serializedAfter = JSON.stringify(inputArg);
  assert.strictEqual(serializedBefore, serializedAfter);
  assert.deepStrictEqual(inputArg.flags, [1, 2, 3]);
});

// ============================================================================
// 2. Deterministic Reproducibility
// ============================================================================
test('3. Reproducibility: identical seed creates byte-for-byte identical pool personas', () => {
  const seed = 'openbrowser-reproducibility-test-seed-42';
  const pool1 = createFingerprintPool({ seed, enabled: true, size: 10 });
  const pool2 = createFingerprintPool({ seed, enabled: true, size: 10 });

  assert.strictEqual(pool1.personas.length, 10);
  assert.strictEqual(pool2.personas.length, 10);
  assert.deepStrictEqual(pool1.personas, pool2.personas);
  assert.strictEqual(JSON.stringify(pool1.personas), JSON.stringify(pool2.personas));
});

test('4. Reproducibility: identical seed produces identical assignment records for same envIds', () => {
  const seed = 'openbrowser-reproducibility-test-seed-42';
  const pool1 = createFingerprintPool({ seed, enabled: true, size: 8 });
  const pool2 = createFingerprintPool({ seed, enabled: true, size: 8 });

  const envs = ['tenant-alpha', 'tenant-beta', 'tenant-gamma', 'tenant-delta'];
  const res1 = envs.map((e) => pool1.assignPersona(e));
  const res2 = envs.map((e) => pool2.assignPersona(e));

  assert.strictEqual(res1.length, res2.length);
  for (let i = 0; i < envs.length; i++) {
    assert.strictEqual(res1[i].personaId, res2[i].personaId);
    assert.strictEqual(res1[i].reused, res2[i].reused);
    assert.strictEqual(res1[i].reuseCount, res2[i].reuseCount);
    assert.deepStrictEqual(res1[i].persona, res2[i].persona);
  }
});

// ============================================================================
// 3. Stability (100x idempotence)
// ============================================================================
test('5. Stability: calling assignPersona 100 times with identical envId returns identical result', () => {
  const pool = createFingerprintPool({ seed: 'openbrowser-stability-seed-100x', enabled: true, size: 15 });
  const envId = 'persistent-workstation-env-001';

  const baseline = pool.assignPersona(envId);
  assert.ok(baseline && baseline.personaId);
  assert.strictEqual(baseline.reused, false);

  for (let i = 0; i < 100; i++) {
    const current = pool.assignPersona(envId);
    assert.strictEqual(current.personaId, baseline.personaId);
    assert.strictEqual(current.reused, false);
    assert.strictEqual(current.reuseCount, 0);
    assert.strictEqual(current.persona.id, baseline.persona.id);
    assert.strictEqual(pool.getPersona(envId).id, baseline.persona.id);
    assert.strictEqual(pool.hasPersona(envId), true);
  }
});

// ============================================================================
// 4. Uniqueness (N envIds with 0 collisions in unexhausted pool)
// ============================================================================
test('6. Uniqueness: N environments in pool of size N assign with 0 collisions', () => {
  const N = 12;
  const pool = createFingerprintPool({ seed: 'uniqueness-pool-seed-12', enabled: true, size: N });

  const envIds = Array.from({ length: N }, (_, i) => `isolated-env-${i}`);
  const assignments = envIds.map((id) => pool.assignPersona(id));

  // Verify all returned personas are unique
  const personaIds = assignments.map((a) => a.personaId);
  const uniqueIds = new Set(personaIds);
  assert.strictEqual(uniqueIds.size, N, `Expected ${N} unique personas, got ${uniqueIds.size}`);

  // Verify all assignments are marked un-reused
  for (const a of assignments) {
    assert.strictEqual(a.reused, false, `Env ${a.envId} unexpectedly marked as reused`);
    assert.strictEqual(a.reuseCount, 0);
  }

  // Verify pool stats
  const stats = pool.getPoolStats();
  assert.strictEqual(stats.assignedCount, N);
  assert.strictEqual(stats.reusedCount, 0);
  assert.strictEqual(stats.availableCount, 0);
});

// ============================================================================
// 5. Exhaustion Reuse (Capacity overflow without crashing)
// ============================================================================
test('7. Exhaustion reuse: exceeding pool capacity reuses personas gracefully without crashing', () => {
  const poolSize = 6;
  const pool = createFingerprintPool({ seed: 'exhaustion-seed-6', enabled: true, size: poolSize });

  // 1. Fill the pool
  const initialEnvs = Array.from({ length: poolSize }, (_, i) => `base-env-${i}`);
  for (const id of initialEnvs) {
    const a = pool.assignPersona(id);
    assert.strictEqual(a.reused, false);
  }

  // 2. Overflow the pool with 4 additional environments
  const overflowEnvs = ['overflow-env-1', 'overflow-env-2', 'overflow-env-3', 'overflow-env-4'];
  const overflowAssignments = overflowEnvs.map((id) => pool.assignPersona(id));

  for (const a of overflowAssignments) {
    assert.ok(a && a.persona, `Overflow env ${a.envId} received null or undefined persona`);
    assert.strictEqual(a.reused, true, `Overflow env ${a.envId} must have reused: true`);
    assert.ok(a.reuseCount >= 1, `Overflow env ${a.envId} reuseCount must be >= 1, got ${a.reuseCount}`);
  }

  const stats = pool.getPoolStats();
  assert.strictEqual(stats.assignedCount, poolSize + overflowEnvs.length);
  assert.strictEqual(stats.reusedCount, overflowEnvs.length);
  assert.strictEqual(stats.availableCount, 0);
});

// ============================================================================
// 6. Consistency: Positive Validation
// ============================================================================
test('8. Consistency positive: all generated personas in a 25-size pool pass validation', () => {
  const pool = createFingerprintPool({ seed: 'positive-audit-seed-25', enabled: true, size: 25 });
  assert.strictEqual(pool.personas.length, 25);

  for (let i = 0; i < pool.personas.length; i++) {
    const persona = pool.personas[i];
    const audit = verifyPersonaConsistency(persona);
    assert.strictEqual(audit.valid, true, `Persona ${i} failed consistency: ${audit.violations.map((v) => v.message).join(', ')}`);
    assert.strictEqual(audit.ok, true);
    assert.strictEqual(audit.violations.length, 0);
  }
});

test('9. Consistency positive: all hardware templates from device-personas.js pass validation', () => {
  for (const [os, list] of Object.entries(PERSONAS_BY_OS)) {
    for (const tpl of list) {
      const persona = {
        os,
        platform: os === 'windows' ? 'Win32' : (os.startsWith('mac') ? 'MacIntel' : (os === 'linux' ? 'Linux x86_64' : 'Linux armv8l')),
        cores: tpl.cores,
        memory: tpl.memory,
        screen: tpl.screen,
        devicePixelRatio: tpl.devicePixelRatio,
        webgl: tpl.webgl,
      };
      const audit = verifyPersonaConsistency(persona);
      assert.strictEqual(audit.valid, true, `Template for ${os} failed: ${audit.violations.map((v) => v.message).join('; ')}`);
    }
  }
});

// ============================================================================
// 7. Consistency Counterexample 1: GPU ↔ Platform Contradiction
// ============================================================================
test('10. Counterexample 1A: Windows persona with Apple M1 GPU renderer rejected', () => {
  const badPersona = {
    os: 'windows',
    platform: 'Win32',
    cores: 8,
    memory: 8,
    screen: { width: 1920, height: 1080, devicePixelRatio: 1 },
    webgl: {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
    },
  };
  const audit = verifyPersonaConsistency(badPersona);
  assert.strictEqual(audit.valid, false);
  const mismatch = audit.violations.find((v) => v.code === 'gpu-platform-mismatch');
  assert.ok(mismatch, 'Expected gpu-platform-mismatch violation');
  assert.ok(mismatch.message.includes('Apple') || mismatch.message.includes('incompatible'));
});

test('11. Counterexample 1B: macOS persona with Direct3D11 GPU renderer rejected', () => {
  const badPersona = {
    os: 'macos',
    platform: 'MacIntel',
    cores: 8,
    memory: 8,
    screen: { width: 1440, height: 900, devicePixelRatio: 2 },
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
  };
  const audit = verifyPersonaConsistency(badPersona);
  assert.strictEqual(audit.valid, false);
  const mismatch = audit.violations.find((v) => v.code === 'gpu-platform-mismatch');
  assert.ok(mismatch, 'Expected gpu-platform-mismatch violation');
  assert.ok(mismatch.message.includes('Direct3D') || mismatch.message.includes('incompatible'));
});

test('12. Counterexample 1C: Linux persona with Direct3D11 GPU renderer rejected', () => {
  const badPersona = {
    os: 'linux',
    platform: 'Linux x86_64',
    cores: 8,
    memory: 8,
    screen: { width: 1920, height: 1080, devicePixelRatio: 1 },
    webgl: {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
  };
  const audit = verifyPersonaConsistency(badPersona);
  assert.strictEqual(audit.valid, false);
  assert.ok(audit.violations.some((v) => v.code === 'gpu-platform-mismatch'));
});

// ============================================================================
// 8. Consistency Counterexample 2: Font ↔ OS Contradiction
// ============================================================================
test('13. Counterexample 2A: Windows persona with exclusive macOS font (PingFang SC) rejected', () => {
  const badPersona = {
    os: 'windows',
    platform: 'Win32',
    cores: 8,
    memory: 8,
    screen: { width: 1920, height: 1080, devicePixelRatio: 1 },
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    fonts: {
      list: ['Arial', 'Calibri', 'PingFang SC', 'Segoe UI'],
    },
  };
  const audit = verifyPersonaConsistency(badPersona);
  assert.strictEqual(audit.valid, false);
  const mismatch = audit.violations.find((v) => v.code === 'font-os-mismatch');
  assert.ok(mismatch, 'Expected font-os-mismatch violation');
  assert.ok(mismatch.message.includes('PingFang SC') || mismatch.message.includes('pingfang sc'));
});

test('14. Counterexample 2B: macOS persona with exclusive Windows font (Segoe UI) rejected', () => {
  const badPersona = {
    os: 'macos',
    platform: 'MacIntel',
    cores: 8,
    memory: 8,
    screen: { width: 1440, height: 900, devicePixelRatio: 2 },
    webgl: {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
    },
    fonts: {
      list: ['Helvetica Neue', 'Segoe UI', 'Arial'],
    },
  };
  const audit = verifyPersonaConsistency(badPersona);
  assert.strictEqual(audit.valid, false);
  const mismatch = audit.violations.find((v) => v.code === 'font-os-mismatch');
  assert.ok(mismatch, 'Expected font-os-mismatch violation');
  assert.ok(mismatch.message.includes('Segoe UI') || mismatch.message.includes('segoe ui'));
});

test('15. Counterexample 2C: Windows persona with exclusive Linux font (Ubuntu) rejected', () => {
  const badPersona = {
    os: 'windows',
    platform: 'Win32',
    cores: 8,
    memory: 8,
    screen: { width: 1920, height: 1080, devicePixelRatio: 1 },
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    fonts: {
      list: ['Arial', 'Ubuntu', 'Calibri'],
    },
  };
  const audit = verifyPersonaConsistency(badPersona);
  assert.strictEqual(audit.valid, false);
  assert.ok(audit.violations.some((v) => v.code === 'font-os-mismatch'));
});

// ============================================================================
// 9. Consistency Counterexample 3: Media Device Label ↔ OS Contradiction
// ============================================================================
test('16. Counterexample 3A: Windows persona with macOS media label (FaceTime HD Camera) rejected', () => {
  const badPersona = {
    os: 'windows',
    platform: 'Win32',
    cores: 8,
    memory: 8,
    screen: { width: 1920, height: 1080, devicePixelRatio: 1 },
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    mediaDevices: {
      input: 'Microphone Array (Realtek High Definition Audio)',
      output: 'Speaker (Realtek High Definition Audio)',
      video: 'FaceTime HD Camera',
    },
  };
  const audit = verifyPersonaConsistency(badPersona);
  assert.strictEqual(audit.valid, false);
  const mismatch = audit.violations.find((v) => v.code === 'media-label-os-mismatch');
  assert.ok(mismatch, 'Expected media-label-os-mismatch violation');
  assert.ok(mismatch.message.includes('FaceTime'));
});

test('17. Counterexample 3B: macOS persona with Windows media label (Realtek) rejected', () => {
  const badPersona = {
    os: 'macos',
    platform: 'MacIntel',
    cores: 8,
    memory: 8,
    screen: { width: 1440, height: 900, devicePixelRatio: 2 },
    webgl: {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
    },
    mediaDevices: {
      input: 'Microphone Array (2- Realtek High Definition Audio)',
      output: 'MacBook Pro Speakers',
      video: 'FaceTime HD Camera',
    },
  };
  const audit = verifyPersonaConsistency(badPersona);
  assert.strictEqual(audit.valid, false);
  const mismatch = audit.violations.find((v) => v.code === 'media-label-os-mismatch');
  assert.ok(mismatch, 'Expected media-label-os-mismatch violation');
  assert.ok(mismatch.message.includes('Realtek'));
});

test('18. Counterexample 3C: Android persona with MacBook Pro Speakers rejected', () => {
  const badPersona = {
    os: 'android',
    platform: 'Linux armv8l',
    cores: 8,
    memory: 8,
    screen: { width: 412, height: 915, devicePixelRatio: 3 },
    webgl: {
      vendor: 'Google Inc. (Qualcomm)',
      renderer: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)',
    },
    mediaDevices: {
      output: 'MacBook Pro Speakers',
    },
  };
  const audit = verifyPersonaConsistency(badPersona);
  assert.strictEqual(audit.valid, false);
  assert.ok(audit.violations.some((v) => v.code === 'media-label-os-mismatch'));
});

// ============================================================================
// 10. Strict Pool Creation Rejection & Incoherence
// ============================================================================
test('19. Pool strict mode: constructor throws when passed inconsistent custom personas', () => {
  const badPersona = {
    os: 'windows',
    platform: 'Win32',
    webgl: { renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
  };

  assert.throws(
    () => {
      createFingerprintPool({ enabled: true, strict: true, personas: [badPersona] });
    },
    /Inconsistent persona rejected/
  );
});

test('20. Coherence: single-core CPU with 32GB RAM rejected as incoherent', () => {
  const badPersona = {
    os: 'windows',
    platform: 'Win32',
    cores: 1,
    memory: 32,
    screen: { width: 1920, height: 1080, devicePixelRatio: 1 },
    webgl: { renderer: 'ANGLE (Intel, Direct3D11)' },
  };
  const audit = verifyPersonaConsistency(badPersona);
  assert.strictEqual(audit.valid, false);
  assert.ok(audit.violations.some((v) => v.code === 'cpu-memory-incoherent'));
});

test('21. Coherence: macOS with DPR < 2 rejected (Retina standard requirement)', () => {
  const badPersona = {
    os: 'macos',
    platform: 'MacIntel',
    cores: 8,
    memory: 8,
    screen: { width: 1440, height: 900, devicePixelRatio: 1 },
    webgl: { renderer: 'ANGLE (Apple, Metal)' },
  };
  const audit = verifyPersonaConsistency(badPersona);
  assert.strictEqual(audit.valid, false);
  assert.ok(audit.violations.some((v) => v.code === 'screen-dpr-mismatch'));
});

// ============================================================================
// 11. Pool Stats & Provenance Transparency
// ============================================================================
test('22. Pool stats: accurately tracks assigned, reused, and OS breakdown', () => {
  const pool = createFingerprintPool({
    seed: 'stats-audit-seed',
    enabled: true,
    size: 10,
    osMix: { windows: 0.6, macos: 0.4, linux: 0, android: 0 },
  });

  pool.assignPersona('env-1');
  pool.assignPersona('env-2');
  pool.assignPersona('env-3');

  const stats = pool.getPoolStats();
  assert.strictEqual(stats.enabled, true);
  assert.strictEqual(stats.poolSize, 10);
  assert.strictEqual(stats.assignedCount, 3);
  assert.strictEqual(stats.reusedCount, 0);
  assert.strictEqual(stats.availableCount, 7);
  assert.ok(typeof stats.osDistribution.windows === 'number');
  assert.ok(typeof stats.osDistribution.macos === 'number');
});

test('23. Provenance audit: honest status tracking without falsified verified claims', () => {
  const pool = createFingerprintPool({ seed: 'provenance-seed', enabled: true, size: 5 });
  const p = pool.personas[0];

  assert.ok(p.provenance, 'Persona must carry provenance record');
  assert.strictEqual(p.provenance.status, 'verified');
  assert.ok(Array.isArray(p.provenance.verifiedAxes));
  assert.ok(p.provenance.verifiedAxes.includes('webgl'));
  assert.ok(p.provenance.verifiedAxes.includes('fonts'));
  assert.ok(p.provenance.verifiedAxes.includes('mediaDevices'));

  // Must explicitly disclose structural placeholders awaiting physical lab sampling
  assert.ok(Array.isArray(p.provenance.structuralPlaceholders));
  assert.ok(p.provenance.structuralPlaceholders.includes('webgpu_adapter_limits'));
  assert.ok(typeof p.provenance.notes === 'string');
});

// ============================================================================
// 12. Dynamic Release & State Persistence
// ============================================================================
test('24. Release: releasePersona frees allocated slot for subsequent unexhausted use', () => {
  const pool = createFingerprintPool({ seed: 'release-test-seed', enabled: true, size: 2 });
  pool.assignPersona('env-A');
  pool.assignPersona('env-B');

  assert.strictEqual(pool.getPoolStats().availableCount, 0);

  const released = pool.releasePersona('env-A');
  assert.strictEqual(released, true);
  assert.strictEqual(pool.hasPersona('env-A'), false);
  assert.strictEqual(pool.getPoolStats().availableCount, 1);

  // New environment can now claim the freed slot without exhaustion reuse
  const aC = pool.assignPersona('env-C');
  assert.strictEqual(aC.reused, false);
});

test('25. Persistence roundtrip: exportAssignments and importAssignments maintain exact mapping', () => {
  const seed = 'persistence-roundtrip-seed';
  const pool1 = createFingerprintPool({ seed, enabled: true, size: 5 });
  const envs = ['tenant-1', 'tenant-2', 'tenant-3'];
  const p1Map = envs.map((e) => pool1.assignPersona(e).personaId);

  // Export state
  const exported = pool1.exportAssignments();
  assert.ok(exported && Array.isArray(exported.assignments));
  assert.strictEqual(exported.assignments.length, 3);

  // Create clean pool and import
  const pool2 = createFingerprintPool({ seed, enabled: true, size: 5, initialAssignments: exported });
  for (let i = 0; i < envs.length; i++) {
    const rec = pool2.getAssignment(envs[i]);
    assert.ok(rec, `Expected assignment for ${envs[i]}`);
    assert.strictEqual(rec.personaId, p1Map[i]);
  }
});

// ============================================================================
// Summary & Exit
// ============================================================================
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`fingerprint-pool-selftest: FAIL (${results.length - failed.length}/${results.length} passed)`);
  for (const f of failed) {
    console.error(`  - ${f.name}: ${f.error?.message}`);
  }
  process.exit(1);
} else {
  console.log(`fingerprint-pool-selftest: OK ${results.length}/${results.length}`);
}
