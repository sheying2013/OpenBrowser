'use strict';

/**
 * Protocol map for window sync.
 *
 * Custom Browser.* CDP methods are not available on stock Chromium.
 * This module:
 *  1) Documents custom method names + payloads
 *  2) Translates them to standard CDP for OpenBrowser (Google Chrome / Edge)
 *
 * Slave fan-out:
 *  - Browser.clickheadbox_withsize  { action, x, y, width, height, name? }
 *  - Browser.click                  { action, x, y }
 *  - Browser.scroll                 { dX, dY, x, y, phase }
 *  - Browser.keyboard               { ...keyEvent, type stripped }
 *  - Browser.keyboard_toheadbox     { ...keyEvent }
 *  - Browser.chartoheadbox
 *  - Browser.actionToDom / actionToHeadBox
 *  - Browser.sendTextToDom
 *  - Browser.scrollHeadBox
 *  - Browser.conTrolWidget
 *
 * operate flags: "click,move,scroll,keyboard" → syncOperateList.includes(...)
 * Delay: isDelay === "1" → sleep(random(mouseDelayMin, mouseDelayMax)) before each slave cmd
 */

const CUSTOM_BROWSER_METHODS = Object.freeze([
  'Browser.click',
  'Browser.clickheadbox_withsize',
  'Browser.scroll',
  'Browser.scrollHeadBox',
  'Browser.keyboard',
  'Browser.keyboard_toheadbox',
  'Browser.chartoheadbox',
  'Browser.actionToDom',
  'Browser.actionToHeadBox',
  'Browser.sendTextToDom',
  'Browser.conTrolWidget',
  'Browser.setNoSubWin',
]);

/** Mouse action codes used with Browser.click* */
const MOUSE_ACTION = Object.freeze({
  MOVE: 0,
  DOWN: 1,
  UP: 2,
  // 3 also treated as click-position save in navigateMouseWithSize
  CLICK_SAVE: 3,
});

function parseOperateList(operate) {
  if (Array.isArray(operate)) return operate.map(String);
  if (!operate) return ['click', 'move', 'scroll', 'keyboard'];
  return String(operate).split(',').map((s) => s.trim()).filter(Boolean);
}

function shouldHandle(operateList, eventKind) {
  const set = new Set(operateList);
  if (eventKind === 'mouse' || eventKind === 'click') return set.has('click') && set.has('move');
  if (eventKind === 'scroll') return set.has('scroll') && set.has('move');
  if (eventKind === 'keyboard') return set.has('keyboard');
  return false;
}

/**
 * Translate one custom Browser.* command into standard CDP calls.
 * Returns array of { method, params } for sequential send.
 */
function translateToStandardCdp(command, params = {}) {
  const method = String(command || '');
  const p = params || {};

  if (method === 'Browser.click' || method === 'Browser.clickheadbox_withsize') {
    const x = Number(p.x) || 0;
    const y = Number(p.y) || 0;
    // Scale if size-aware headbox payload present
    let sx = x;
    let sy = y;
    if (method === 'Browser.clickheadbox_withsize' && p.width && p.height) {
      // Master coords already absolute; keep as-is for standard Chrome page viewport
      sx = x;
      sy = y;
    }
    const action = Number(p.action);
    if (action === MOUSE_ACTION.MOVE || action === 0) {
      return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: sx, y: sy } }];
    }
    if (action === MOUSE_ACTION.DOWN || action === 1) {
      return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1 } }];
    }
    if (action === MOUSE_ACTION.UP || action === 2 || action === MOUSE_ACTION.CLICK_SAVE || action === 3) {
      // full click if only release/save action
      return [
        { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1 } },
        { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: sx, y: sy, button: 'left', clickCount: 1 } },
      ];
    }
    // default: click
    return [
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: sx, y: sy } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: sx, y: sy, button: 'left', clickCount: 1 } },
    ];
  }

  if (method === 'Browser.scroll' || method === 'Browser.scrollHeadBox') {
    return [{
      method: 'Input.dispatchMouseEvent',
      params: {
        type: 'mouseWheel',
        x: Number(p.x) || 0,
        y: Number(p.y) || 0,
        deltaX: Number(p.dX ?? p.deltaX ?? 0),
        deltaY: Number(p.dY ?? p.deltaY ?? 0),
      },
    }];
  }

  if (method === 'Browser.keyboard' || method === 'Browser.keyboard_toheadbox') {
    const event = { ...p };
    delete event.type; // strip type before fanout
    const key = event.key || event.code || 'Unidentified';
    const windowsVirtualKeyCode = event.windowsVirtualKeyCode || event.keyCode || 0;
    return [
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyDown',
          key,
          code: event.code || key,
          windowsVirtualKeyCode,
          nativeVirtualKeyCode: windowsVirtualKeyCode,
          modifiers: Number(event.modifiers) || 0,
          text: event.text || undefined,
          unmodifiedText: event.unmodifiedText || event.text || undefined,
        },
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyUp',
          key,
          code: event.code || key,
          windowsVirtualKeyCode,
          nativeVirtualKeyCode: windowsVirtualKeyCode,
          modifiers: Number(event.modifiers) || 0,
        },
      },
    ];
  }

  if (method === 'Browser.sendTextToDom' || method === 'Browser.chartoheadbox') {
    const text = String(p.text ?? p.char ?? p.value ?? '');
    return [{ method: 'Input.insertText', params: { text } }];
  }

  if (method === 'Browser.actionToDom' || method === 'Browser.actionToHeadBox') {
    // High-level UI actions → best-effort key/text
    if (p.text) return [{ method: 'Input.insertText', params: { text: String(p.text) } }];
    return [];
  }

  // Unknown custom method — no standard mapping
  return [];
}

/**
 * Build fan-out plan for one master event.
 */
function buildFanoutPlan(masterEvent, options = {}) {
  const operateList = parseOperateList(options.operate || options.syncOperateList);
  const isDelay = options.isDelay === true || options.isDelay === '1' || options.isDelay === 1;
  const delayMin = Number(options.mouseDelayMin) || 0;
  const delayMax = Math.max(delayMin, Number(options.mouseDelayMax) || delayMin);
  const delayMs = isDelay ? delayMin + Math.random() * Math.max(0, delayMax - delayMin) : 0;

  const kind = String(masterEvent.kind || masterEvent.channel || '');
  let command;
  let params;

  if (kind === 'headbox-mouse' || masterEvent.command === 'Browser.clickheadbox_withsize') {
    if (!shouldHandle(operateList, 'mouse')) return { skip: true, reason: 'operate' };
    command = 'Browser.clickheadbox_withsize';
    params = masterEvent.params || masterEvent;
  } else if (kind === 'mouse' || masterEvent.command === 'Browser.click') {
    if (!shouldHandle(operateList, 'mouse')) return { skip: true, reason: 'operate' };
    command = 'Browser.click';
    params = masterEvent.params || masterEvent;
  } else if (kind === 'scroll' || masterEvent.command === 'Browser.scroll') {
    if (!shouldHandle(operateList, 'scroll')) return { skip: true, reason: 'operate' };
    command = 'Browser.scroll';
    params = masterEvent.params || masterEvent;
  } else if (kind === 'keyboard' || masterEvent.command === 'Browser.keyboard') {
    if (!shouldHandle(operateList, 'keyboard')) return { skip: true, reason: 'operate' };
    command = masterEvent.headbox ? 'Browser.keyboard_toheadbox' : 'Browser.keyboard';
    params = masterEvent.params || masterEvent;
  } else if (masterEvent.command) {
    command = masterEvent.command;
    params = masterEvent.params || masterEvent;
  } else {
    return { skip: true, reason: 'unknown-event' };
  }

  return {
    skip: false,
    proprietary: { method: command, params },
    standard: translateToStandardCdp(command, params),
    delayMs,
  };
}

/** operateRang range=1: cascade left = left + vs * abs(indexFromEnd) */
function computeCascadeBounds(handles, options = {}) {
  const ids = Array.isArray(handles) ? handles : String(handles || '').split(',').filter(Boolean);
  const width = Number(options.width) || 1200;
  const height = Number(options.height) || 800;
  const top = Number(options.top) || 0;
  const left = Number(options.left) || 0;
  const vs = Number(options.vs) || 40;
  return ids.map((id, indexFromStart) => {
    const h = ids.length - 1 - indexFromStart; // reverse index from length-1 down to 0
    const leftPos = left + vs * Math.abs(h - (ids.length - 1));
    // When iterating reverse, abs(h-(len-1)) = indexFromStart
    return {
      handle: id,
      bounds: { width, height, top, left: left + vs * indexFromStart },
    };
  });
}

module.exports = {
  CUSTOM_BROWSER_METHODS,
  MOUSE_ACTION,
  parseOperateList,
  shouldHandle,
  translateToStandardCdp,
  buildFanoutPlan,
  computeCascadeBounds,
};
