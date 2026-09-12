'use strict';

/** Unit self-test for native CDP input helpers. */

const assert = require('assert');
const {
  applyTrustedChange,
  applyTrustedInput,
  backspaceSequence,
  buildEditableProbeExpression,
  buildFocusAndSelectExpression,
  buildSelectKeyPlan,
  buildSelectProbeExpression,
  tabSequence,
} = require('./trusted-input');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, err: error.message || String(error) }); }
}
function valueResponse(value) {
  return { result: { result: { value } } };
}

(async () => {
  await check('editable probe expression contains deep lookup and editability rules', () => {
    const expression = buildEditableProbeExpression({ selector: '#field', x: 4, y: 5 });
    assert.ok(expression.includes("querySelectorAll('input,textarea,select,[contenteditable=\"true\"]')"));
    assert.ok(expression.includes('element.isContentEditable'));
    assert.ok(expression.includes("'datetime-local'"));
  });

  await check('focus expression selects inputs and ranges contenteditable nodes', () => {
    const expression = buildFocusAndSelectExpression({ selector: '#field' });
    assert.ok(expression.includes('element.select()'));
    assert.ok(expression.includes('range.selectNodeContents(element)'));
  });

  await check('select probe resolves a target index from a value', () => {
    const expression = buildSelectProbeExpression({ selector: '#select', value: 'b' });
    assert.ok(expression.includes('HTMLSelectElement'));
    assert.ok(expression.includes('element.options[index].value'));
  });

  await check('select key plan advances from current to target', () => {
    const plan = buildSelectKeyPlan({ selectedIndex: 0, targetIndex: 2 });
    assert.strictEqual(plan.length, 4);
    assert.deepStrictEqual(plan.map((item) => item.key), ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown']);
  });

  await check('select key plan goes home when the target is above', () => {
    const plan = buildSelectKeyPlan({ selectedIndex: 3, targetIndex: 1 });
    assert.strictEqual(plan.length, 4);
    assert.deepStrictEqual(plan.map((item) => item.key), ['Home', 'Home', 'ArrowDown', 'ArrowDown']);
  });

  await check('backspace and tab sequences produce trusted key pairs', () => {
    assert.deepStrictEqual(backspaceSequence().map((item) => item.type), ['keyDown', 'keyUp']);
    assert.deepStrictEqual(tabSequence().map((item) => item.key), ['Tab', 'Tab']);
    assert.strictEqual(tabSequence(8)[0].modifiers, 8);
  });

  await check('trusted input accepts both full-message and cdp.call result shapes', async () => {
    const calls = [];
    const call = async (method, params) => {
      calls.push({ method, params });
      if (method !== 'Runtime.evaluate') return {};
      const expression = String(params.expression);
      if (expression.includes('const excluded')) return { result: { value: { found: true, editable: true, x: 7, y: 8, tag: 'input' } } };
      if (expression.includes('element.select()')) return { result: { value: { ok: true, mode: 'select' } } };
      if (expression.includes('element.blur()')) return { result: { value: { ok: true } } };
      return { result: { value: { ok: false } } };
    };
    const result = await applyTrustedInput(call, { selector: '#field', value: 'shape' });
    assert.strictEqual(result.ok, true);
    assert.ok(calls.some((entry) => entry.method === 'Input.insertText' && entry.params.text === 'shape'));
  });

  await check('trusted input uses insertText and blur instead of dispatchEvent', async () => {
    const calls = [];
    const call = async (method, params) => {
      calls.push({ method, params });
      if (method !== 'Runtime.evaluate') return {};
      const expression = String(params.expression);
      if (expression.includes('const excluded')) return valueResponse({ found: true, editable: true, x: 10, y: 20, tag: 'input' });
      if (expression.includes('element.select()')) return valueResponse({ ok: true, mode: 'select' });
      if (expression.includes('element.blur()')) return valueResponse({ ok: true });
      return valueResponse({ ok: false });
    };
    const result = await applyTrustedInput(call, { selector: '#field', value: 'hello' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.native, true);
    assert.ok(calls.some((entry) => entry.method === 'Input.insertText' && entry.params.text === 'hello'));
    assert.ok(calls.some((entry) => entry.method === 'Input.dispatchMouseEvent'));
    assert.strictEqual(calls.some((entry) => JSON.stringify(entry.params || {}).includes('dispatchEvent')), false);
  });

  await check('empty trusted input clears the selection with Backspace', async () => {
    const calls = [];
    const call = async (method, params) => {
      calls.push({ method, params });
      if (method !== 'Runtime.evaluate') return {};
      const expression = String(params.expression);
      if (expression.includes('const excluded')) return valueResponse({ found: true, editable: true, x: 3, y: 4, tag: 'textarea' });
      if (expression.includes('element.select()')) return valueResponse({ ok: true, mode: 'select' });
      if (expression.includes('element.blur()')) return valueResponse({ ok: true });
      return valueResponse({ ok: false });
    };
    const result = await applyTrustedInput(call, { selector: '#field', value: '' });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(calls.filter((entry) => entry.method === 'Input.dispatchKeyEvent').map((entry) => entry.params.key), ['Backspace', 'Backspace']);
  });

  await check('select change succeeds when native selection reaches the target', async () => {
    let selectProbes = 0;
    const call = async (method, params) => {
      if (method !== 'Runtime.evaluate') return {};
      const expression = String(params.expression);
      if (expression.includes('optionCount')) {
        selectProbes += 1;
        return valueResponse({ found: true, isSelect: true, x: 50, y: 60, selectedIndex: selectProbes === 1 ? 0 : 2, targetIndex: 2, optionCount: 3 });
      }
      return valueResponse({ ok: false });
    };
    const result = await applyTrustedChange(call, { selector: '#select', selectedIndex: 2 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.native, true);
    assert.strictEqual(result.reason, 'native-select');
  });

  await check('select change keeps a synthetic fallback when native selection cannot move', async () => {
    const call = async (method, params) => {
      if (method !== 'Runtime.evaluate') return {};
      const expression = String(params.expression);
      if (expression.includes('optionCount')) return valueResponse({ found: true, isSelect: true, x: 50, y: 60, selectedIndex: 0, targetIndex: 2, optionCount: 3 });
      if (expression.includes("dispatchEvent(new Event('change'")) return valueResponse({ ok: true, native: false });
      return valueResponse({ ok: false });
    };
    const result = await applyTrustedChange(call, { selector: '#select', selectedIndex: 2 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.native, false);
    assert.strictEqual(result.fallback, true);
  });

  const failed = results.filter((item) => !item.ok);
  for (const item of results) {
    if (item.ok) console.log('  PASS  ' + item.name);
    else console.error('  FAIL  ' + item.name + ': ' + item.err);
  }
  if (failed.length) {
    console.error(`trusted-input-selftest: FAIL ${results.length - failed.length}/${results.length}`);
    process.exitCode = 1;
  } else {
    console.log(`trusted-input-selftest: OK ${results.length}/${results.length}`);
  }
})();
