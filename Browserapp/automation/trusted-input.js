'use strict';

/**
 * Native-input helpers for synchronization and RPA paths.
 *
 * JavaScript-created events are permanently marked as untrusted and the
 * isTrusted accessor cannot be safely redefined on an event instance. The only
 * portable way to produce the same event chain as real user input is to use
 * Chromium's native Input.* commands. This module keeps the element lookup,
 * selection, key planning and fallback behaviour in one place.
 */

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function locatorSource(payload = {}) {
  const selector = JSON.stringify(String(payload.selector || ''));
  const x = finiteNumber(payload.x, 0);
  const y = finiteNumber(payload.y, 0);
  const tag = JSON.stringify(String(payload.tag || '').toLowerCase());
  const type = JSON.stringify(String(payload.elementType || '').toLowerCase());
  const name = JSON.stringify(String(payload.name || ''));
  const placeholder = JSON.stringify(String(payload.placeholder || ''));
  return `
    const deep = (path) => {
      let root = document;
      let element = null;
      for (const part of path.split(/\\s*>>>\\s*/)) {
        try { element = root.querySelector(part); } catch (_) { return null; }
        if (!element) return null;
        root = element.shadowRoot || element;
      }
      return element;
    };
    const at = (doc, px, py) => {
      let element = doc.elementFromPoint(px, py);
      if (element && element.tagName === 'IFRAME') {
        try {
          const rect = element.getBoundingClientRect();
          const inner = element.contentDocument;
          if (inner) return at(inner, px - rect.left, py - rect.top);
        } catch (_) {}
      }
      return element;
    };
    const similar = () => {
      const list = [...document.querySelectorAll('input,textarea,select,[contenteditable="true"]')];
      let best = null;
      let score = -1e9;
      for (const element of list) {
        const rect = element.getBoundingClientRect();
        let value = -Math.hypot(rect.left + rect.width / 2 - ${x}, rect.top + rect.height / 2 - ${y});
        if (${tag} && element.tagName.toLowerCase() === ${tag}) value += 400;
        if (${type} && String(element.type || '').toLowerCase() === ${type}) value += 120;
        if (${name} && element.name === ${name}) value += 300;
        if (${placeholder} && element.placeholder === ${placeholder}) value += 240;
        if (value > score) { score = value; best = element; }
      }
      return best;
    };
    const element = deep(${selector}) || at(document, ${x}, ${y}) || similar();
  `;
}

function buildEditableProbeExpression(payload = {}) {
  return `(() => {${locatorSource(payload)}
    if (!element) return { found: false };
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const inputType = String(element.type || '').toLowerCase();
    const excluded = new Set(['button','submit','reset','checkbox','radio','file','image','range','color','date','datetime-local','month','time','week']);
    const editable = (element instanceof HTMLTextAreaElement)
      || (element instanceof HTMLInputElement && !excluded.has(inputType))
      || Boolean(element.isContentEditable);
    return {
      found: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      tag,
      type: inputType,
      editable,
      contenteditable: Boolean(element.isContentEditable),
      valueLength: typeof element.value === 'string' ? element.value.length : 0,
    };
  })()`;
}

function buildFocusAndSelectExpression(payload = {}) {
  return `(() => {${locatorSource(payload)}
    if (!element) return { ok: false, found: false };
    try { element.focus({ preventScroll: false }); } catch (_) { try { element.focus(); } catch (__) {} }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (typeof element.select === 'function') element.select();
      return { ok: true, found: true, mode: 'select' };
    }
    if (element.isContentEditable) {
      const selection = document.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      return { ok: true, found: true, mode: 'range' };
    }
    return { ok: false, found: true, mode: 'not-editable' };
  })()`;
}

function buildBlurExpression(payload = {}) {
  return `(() => {${locatorSource(payload)}
    if (!element) return { ok: false, found: false };
    try { if (typeof element.blur === 'function') element.blur(); } catch (_) { return { ok: false, found: true }; }
    return { ok: true, found: true };
  })()`;
}

function buildSelectProbeExpression(payload = {}) {
  const value = JSON.stringify(String(payload.value ?? ''));
  const selectedIndex = Number.isInteger(payload.selectedIndex) ? payload.selectedIndex : -1;
  return `(() => {${locatorSource(payload)}
    if (!element) return { found: false };
    if (!(element instanceof HTMLSelectElement)) return { found: true, isSelect: false };
    let targetIndex = ${selectedIndex};
    if (targetIndex < 0 || targetIndex >= element.options.length) {
      targetIndex = -1;
      for (let index = 0; index < element.options.length; index += 1) {
        if (element.options[index].value === ${value}) { targetIndex = index; break; }
      }
    }
    const rect = element.getBoundingClientRect();
    return {
      found: true,
      isSelect: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      selectedIndex: element.selectedIndex,
      targetIndex,
      optionCount: element.options.length,
    };
  })()`;
}

function buildSyntheticChangeExpression(payload = {}) {
  const value = JSON.stringify(String(payload.value ?? ''));
  const selectedIndex = Number.isInteger(payload.selectedIndex) ? payload.selectedIndex : -1;
  return `(() => {${locatorSource(payload)}
    if (!element) return { ok: false, found: false, native: false };
    if (element instanceof HTMLSelectElement) {
      if (${selectedIndex} >= 0 && ${selectedIndex} < element.options.length) element.selectedIndex = ${selectedIndex};
      else if (${value} !== '') element.value = ${value};
    } else if ('value' in element) {
      element.value = ${value};
    } else {
      element.textContent = ${value};
    }
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { ok: true, found: true, native: false };
  })()`;
}

function keyEventParams(type, key, code, windowsVirtualKeyCode, extra = {}) {
  return {
    type,
    key,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    ...extra,
  };
}

function keySequence(key, code, windowsVirtualKeyCode, extra = {}) {
  return [
    keyEventParams('keyDown', key, code, windowsVirtualKeyCode, extra),
    keyEventParams('keyUp', key, code, windowsVirtualKeyCode, extra),
  ];
}

function tabSequence(modifiers = 0) {
  return keySequence('Tab', 'Tab', 9, { modifiers });
}

function backspaceSequence(modifiers = 0) {
  return keySequence('Backspace', 'Backspace', 8, { modifiers });
}

function buildSelectKeyPlan(probe = {}) {
  const current = Number(probe.selectedIndex);
  const target = Number(probe.targetIndex);
  if (!Number.isInteger(current) || !Number.isInteger(target) || target < 0) return [];
  const sequence = [];
  if (target < current) {
    sequence.push(...keySequence('Home', 'Home', 36));
    for (let index = 0; index < target; index += 1) sequence.push(...keySequence('ArrowDown', 'ArrowDown', 40));
  } else if (target > current) {
    for (let index = current; index < target; index += 1) sequence.push(...keySequence('ArrowDown', 'ArrowDown', 40));
  }
  return sequence.slice(0, 1024);
}

function responseValue(response) {
  const exception = response?.result?.exceptionDetails || response?.exceptionDetails;
  if (exception) return { __exception: exception.text || String(exception) };
  if (response?.result?.result && 'value' in response.result.result) return response.result.result.value;
  if (response?.result && 'value' in response.result) return response.result.value;
  if (response && 'value' in response) return response.value;
  return undefined;
}

async function evaluate(call, expression) {
  const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return responseValue(response);
}

async function clickCenter(call, probe) {
  if (!probe || !Number.isFinite(probe.x) || !Number.isFinite(probe.y)) return false;
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: probe.x, y: probe.y });
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: probe.x, y: probe.y, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: probe.x, y: probe.y, button: 'left', clickCount: 1 });
  return true;
}

async function applyTrustedInput(call, payload = {}, options = {}) {
  if (typeof call !== 'function') throw new TypeError('call must be a CDP command function');
  const normalized = { ...payload, selector: payload.selector || '' };
  const probe = await evaluate(call, buildEditableProbeExpression(normalized));
  if (!probe?.found) return { ok: false, native: false, reason: 'element-not-found' };
  if (!probe.editable) return { ok: false, native: false, reason: 'element-not-editable' };

  await clickCenter(call, probe).catch(() => false);
  const focused = await evaluate(call, buildFocusAndSelectExpression(normalized));
  if (!focused?.ok) return { ok: false, native: false, reason: focused?.mode || 'focus-failed' };

  const text = String(payload.value ?? '');
  if (text) await call('Input.insertText', { text });
  else for (const params of backspaceSequence()) await call('Input.dispatchKeyEvent', params);

  if (options.commit !== false) {
    const blurred = await evaluate(call, buildBlurExpression(normalized));
    if (!blurred?.ok) return { ok: false, native: true, reason: 'blur-failed' };
  }
  return { ok: true, native: true, reason: 'input-inserted', probe };
}

async function applyTrustedChange(call, payload = {}, options = {}) {
  if (typeof call !== 'function') throw new TypeError('call must be a CDP command function');
  const normalized = { ...payload, selector: payload.selector || '' };
  const selectProbe = await evaluate(call, buildSelectProbeExpression(normalized));
  if (selectProbe?.found && selectProbe.isSelect) {
    if (selectProbe.targetIndex === selectProbe.selectedIndex) return { ok: true, native: true, reason: 'already-selected', probe: selectProbe };
    await clickCenter(call, selectProbe).catch(() => false);
    const plan = buildSelectKeyPlan(selectProbe);
    for (const params of plan) await call('Input.dispatchKeyEvent', params);
    const after = await evaluate(call, buildSelectProbeExpression(normalized));
    if (after?.found && after.isSelect && after.selectedIndex === after.targetIndex) {
      return { ok: true, native: true, reason: 'native-select', probe: after };
    }
    if (options.allowSyntheticFallback === false) return { ok: false, native: false, reason: 'native-select-failed', probe: after || selectProbe };
    const fallback = await evaluate(call, buildSyntheticChangeExpression(normalized));
    return { ...(fallback || { ok: false, native: false, reason: 'fallback-failed' }), fallback: true, probe: after || selectProbe };
  }

  const editable = await applyTrustedInput(call, normalized, options);
  if (editable.ok) return editable;
  if (options.allowSyntheticFallback === false) return editable;
  const fallback = await evaluate(call, buildSyntheticChangeExpression(normalized));
  return { ...(fallback || { ok: false, native: false, reason: 'fallback-failed' }), fallback: true, cause: editable.reason };
}

module.exports = {
  buildBlurExpression,
  buildEditableProbeExpression,
  buildFocusAndSelectExpression,
  buildSelectKeyPlan,
  buildSelectProbeExpression,
  buildSyntheticChangeExpression,
  applyTrustedChange,
  applyTrustedInput,
  backspaceSequence,
  keyEventParams,
  keySequence,
  tabSequence,
};
