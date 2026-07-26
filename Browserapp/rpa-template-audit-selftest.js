'use strict';

// Health gate for the shipped RPA "script repository" (catalog + builtin templates).
// This project is open-source but its templates were migrated from a paid product, so this
// guards against the two migration hazards: (1) a template using a step type the OSS engine
// does not implement → runtime "Unsupported RPA step type" throw; (2) leftover paid/commercial
// fields or hardcoded secrets. Uses the engine's own validator + the store's own free-sanitizer
// (no reimplementation), so it reflects real runtime behavior.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { RpaStore } = require('./automation/rpa-store.js');
const { findUnsupportedSteps, parseProcessContent } = require('./automation/rpa-engine.js');

const applyFree = RpaStore.prototype.applyFreeTemplateInPlace; // uses no `this`
let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  PASS  ' + n); passed += 1; };

// --- load shipped templates (catalog + builtin) ---
const catalogRaw = fs.readFileSync(path.join(__dirname, 'automation/data/catalog-templates.json'), 'utf8');
const catalog = JSON.parse(catalogRaw).templates || [];
let builtin = [];
try {
  const b = require('./automation/rpa-templates-builtin.js');
  builtin = b.BUILTIN_TEMPLATES || (typeof b.cloneBuiltinTemplates === 'function' ? b.cloneBuiltinTemplates() : []);
} catch (e) { console.log('  (builtin load note: ' + e.message + ')'); }
const all = [...catalog, ...builtin];
ok(`loaded shipped templates (${all.length})`, all.length > 0);

const execSteps = (t) => (Array.isArray(t.steps) && t.steps.length)
  ? t.steps
  : (t.process_content ? parseProcessContent(t.process_content) : []);

// --- 1. Runtime-error gate: no template uses an unsupported step type ---
{
  const offenders = [];
  for (const t of all) {
    const un = findUnsupportedSteps(execSteps(t)) || [];
    if (un.length) offenders.push(`${t.name || t.id}: ${[...new Set(un.map((u) => u.type || '(empty)'))].join(',')}`);
  }
  ok(`no unsupported step types across all templates (would throw at runtime)`, offenders.length === 0);
  if (offenders.length) offenders.slice(0, 10).forEach((o) => console.log('     ✗ ' + o));
}

// --- 2. No leftover paid metadata after the store's free-sanitizer runs on load ---
{
  const paidTag = /付费|收费|会员|VIP|premium|paid/i;
  let bad = 0;
  for (const t of all) {
    const clone = JSON.parse(JSON.stringify(t));
    applyFree.call({}, clone);
    if (clone.pay_type !== 1 || clone.price !== 0) bad += 1;
    if (Array.isArray(clone.tags) && clone.tags.some((tag) => paidTag.test(String(tag)))) bad += 1;
  }
  ok('every template is free (pay_type=1, price=0, no paid tags) after sanitize', bad === 0);
}

// --- 3. Sanitizer actually neutralizes an injected paid field (regression guard) ---
{
  const evil = { pay_type: 2, price: 99, tags: ['付费', 'VIP', '电商'], source: 'catalog', steps: [] };
  applyFree.call({}, evil);
  ok('sanitizer forces an injected paid template to free', evil.pay_type === 1 && evil.price === 0);
  ok('sanitizer strips paid tags but keeps normal ones', !evil.tags.some((t) => /付费|VIP/i.test(t)) && evil.tags.includes('电商'));
}

// --- 4. No hardcoded secrets / non-variable API keys in the shipped catalog ---
{
  const skKeys = catalogRaw.match(/sk-[A-Za-z0-9]{16,}/g) || [];
  const hardApiKeys = [...catalogRaw.matchAll(/"apiKey"\s*:\s*"([^"]+)"/g)]
    .map((m) => m[1]).filter((v) => v && !/^\$\{/.test(v));
  ok('no hardcoded sk- secrets in catalog', skKeys.length === 0);
  ok('no hardcoded (non-variable) apiKey defaults in catalog', hardApiKeys.length === 0);
}

// --- 5. No original commercial-product branding leaked into template data ---
{
  const branding = /donut browser|adspower|bitbrowser|hubstudio|morelogin|multilogin|ixbrowser/gi;
  const hits = catalogRaw.match(branding) || [];
  ok('no competitor/original-product branding in catalog', hits.length === 0);
}

// --- 6. Every config-requiring template must carry a user-visible hint in its desc ---
//     (getOpenAI needs a BYO key or it throws; get2faCode / googleSheet are stubs that
//     silently do nothing unless configured — users must be warned in the description.)
{
  const NEEDS_HINT = [
    { feat: 'getopenai', marker: /OpenAI API Key|自备.*Key/i },
    { feat: 'get2facode', marker: /2FA|双重验证|验证码/i },
    { feat: 'googlesheet', marker: /离线|不会联网|CSV\/JSON|需改用/i },
  ];
  const missing = [];
  for (const t of all) {
    const blob = JSON.stringify(t).toLowerCase();
    const desc = String(t.desc || '');
    for (const { feat, marker } of NEEDS_HINT) {
      if (blob.includes(feat) && !marker.test(desc)) missing.push(`${t.name || t.id} (${feat})`);
    }
  }
  ok('every config-requiring template (getOpenAI/get2faCode/googleSheet) has a desc hint', missing.length === 0);
  if (missing.length) missing.slice(0, 10).forEach((m) => console.log('     ✗ missing hint: ' + m));
}

console.log(`\nrpa-template-audit-selftest: ${passed} checks passed over ${all.length} templates.`);
