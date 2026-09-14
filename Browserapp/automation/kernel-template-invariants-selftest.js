#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateKernelInitInvariants } = require('./kernel-init-sync');

console.log('=== Running kernel-template-invariants-selftest ===');

const templates = [
  {
    name: 'init_template.json',
    path: path.resolve(__dirname, '../kernels/macos-x64/init_template.json'),
  },
  {
    name: 'init_clean_standalone.json',
    path: path.resolve(__dirname, '../kernels/macos-x64/chrome_148/init_clean_standalone.json'),
  },
];

let totalChecks = 0;
let passedChecks = 0;

for (const tmpl of templates) {
  totalChecks++;
  console.log(`Checking template: ${tmpl.name}...`);
  assert.ok(fs.existsSync(tmpl.path), `Template file must exist: ${tmpl.path}`);

  const content = JSON.parse(fs.readFileSync(tmpl.path, 'utf8'));
  const res = validateKernelInitInvariants(content);

  assert.strictEqual(res.valid, true, `${tmpl.name} must be strictly valid according to kernel init invariants, issues: ${JSON.stringify(res.issues)}`);
  assert.strictEqual(res.issues.length, 0, `${tmpl.name} must have 0 invariant issues`);
  passedChecks++;
  console.log(`  PASS: ${tmpl.name} satisfies all kernel invariants with 0 issues.`);
}

console.log(`\nkernel-template-invariants-selftest: OK ${passedChecks}/${totalChecks} templates passed!`);
