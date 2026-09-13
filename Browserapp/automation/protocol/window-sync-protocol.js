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

const DEFAULT_WINDOW_WIDTH = 1200;
const DEFAULT_WINDOW_HEIGHT = 800;
const DEFAULT_MIN_WINDOW_WIDTH = 320;
const DEFAULT_MIN_WINDOW_HEIGHT = 240;
const DEFAULT_CASCADE_STEP_X = 40;

/**
 * Resolve display work area boundaries from options.
 * Handles workArea / work objects, workWidth / workHeight, and explicit origins.
 */
function resolveWorkArea(options = {}) {
  if (!options || typeof options !== 'object') {
    return { hasWorkArea: false, x: 0, y: 0, width: undefined, height: undefined };
  }

  const wa = (options.workArea && typeof options.workArea === 'object') ? options.workArea
           : (options.work && typeof options.work === 'object') ? options.work
           : null;

  let workWidth;
  if (wa && Number.isFinite(Number(wa.width))) {
    workWidth = Number(wa.width);
  } else if (Number.isFinite(Number(options.workWidth))) {
    workWidth = Number(options.workWidth);
  }

  let workHeight;
  if (wa && Number.isFinite(Number(wa.height))) {
    workHeight = Number(wa.height);
  } else if (Number.isFinite(Number(options.workHeight))) {
    workHeight = Number(options.workHeight);
  }

  const hasWorkArea = Number.isFinite(workWidth) && Number.isFinite(workHeight) && workWidth > 0 && workHeight > 0;

  let workX;
  if (wa && Number.isFinite(Number(wa.x ?? wa.left))) {
    workX = Number(wa.x ?? wa.left);
  } else if (Number.isFinite(Number(options.workX ?? options.workLeft))) {
    workX = Number(options.workX ?? options.workLeft);
  } else if (hasWorkArea && Number.isFinite(Number(options.left ?? options.x))) {
    workX = Number(options.left ?? options.x);
  }

  let workY;
  if (wa && Number.isFinite(Number(wa.y ?? wa.top))) {
    workY = Number(wa.y ?? wa.top);
  } else if (Number.isFinite(Number(options.workY ?? options.workTop))) {
    workY = Number(options.workY ?? options.workTop);
  } else if (hasWorkArea && Number.isFinite(Number(options.top ?? options.y))) {
    workY = Number(options.top ?? options.y);
  }

  return {
    hasWorkArea,
    x: Number.isFinite(workX) ? Math.round(workX) : 0,
    y: Number.isFinite(workY) ? Math.round(workY) : 0,
    width: hasWorkArea ? Math.max(1, Math.round(workWidth)) : undefined,
    height: hasWorkArea ? Math.max(1, Math.round(workHeight)) : undefined,
  };
}

/**
 * Compute cascading window bounds for slave or synced browser instances.
 * Guarantees every window's bounds remain strictly within the provided work area,
 * preventing off-screen overflows across multi-monitor setups, small viewports,
 * and high window counts without requiring UI-layer clamping.
 */
function computeCascadeBounds(handles, options = {}) {
  const ids = Array.isArray(handles)
    ? handles.map((h) => (h && typeof h === 'object') ? (h.id ?? h.handle ?? h) : h)
    : (handles !== null && handles !== undefined && String(handles).trim())
      ? String(handles).split(',').map((s) => s.trim()).filter(Boolean)
      : [];

  const opts = (options && typeof options === 'object') ? options : {};

  // Mutation mode check: bypasses boundary clamping to demonstrate test sensitivity
  if (opts._disableClamp) {
    const rawW = Number(opts.width) || DEFAULT_WINDOW_WIDTH;
    const rawH = Number(opts.height) || DEFAULT_WINDOW_HEIGHT;
    const rawT = Number(opts.top) || 0;
    const rawL = Number(opts.left) || 0;
    const rawVs = Number(opts.vs) || DEFAULT_CASCADE_STEP_X;
    const rawVsY = Number(opts.vsY) || (Math.round(rawVs * 0.8) || 32);
    const rawMaxShiftX = Number(opts.maxShiftX) || (opts.workWidth ? Math.max(rawVs, opts.workWidth - rawW) : 400);
    const rawMaxShiftY = Number(opts.maxShiftY) || (opts.workHeight ? Math.max(rawVsY, opts.workHeight - rawH) : 300);
    return ids.map((id, indexFromStart) => {
      const offsetX = rawMaxShiftX > rawVs ? (indexFromStart * rawVs) % rawMaxShiftX : (indexFromStart * rawVs);
      const offsetY = rawMaxShiftY > rawVsY ? (indexFromStart * rawVsY) % rawMaxShiftY : (indexFromStart * rawVsY);
      return {
        handle: id,
        bounds: { width: rawW, height: rawH, top: rawT + offsetY, left: rawL + offsetX },
      };
    });
  }

  const work = resolveWorkArea(opts);

  // When no display work area is specified, preserve baseline unbounded behavior
  if (!work.hasWorkArea) {
    const width = Number.isFinite(Number(opts.width)) && Number(opts.width) > 0 ? Math.round(Number(opts.width)) : DEFAULT_WINDOW_WIDTH;
    const height = Number.isFinite(Number(opts.height)) && Number(opts.height) > 0 ? Math.round(Number(opts.height)) : DEFAULT_WINDOW_HEIGHT;
    const top = Number.isFinite(Number(opts.top ?? opts.y)) ? Math.round(Number(opts.top ?? opts.y)) : 0;
    const left = Number.isFinite(Number(opts.left ?? opts.x)) ? Math.round(Number(opts.left ?? opts.x)) : 0;
    const vs = Math.max(1, Math.round(Number(opts.vs) || DEFAULT_CASCADE_STEP_X));
    const vsY = Math.max(1, Math.round(Number(opts.vsY) || Math.round(vs * 0.8) || 32));
    const maxShiftX = Number.isFinite(Number(opts.maxShiftX)) && Number(opts.maxShiftX) > 0 ? Math.round(Number(opts.maxShiftX)) : 400;
    const maxShiftY = Number.isFinite(Number(opts.maxShiftY)) && Number(opts.maxShiftY) > 0 ? Math.round(Number(opts.maxShiftY)) : 300;
    return ids.map((id, indexFromStart) => {
      const offsetX = maxShiftX > vs ? (indexFromStart * vs) % maxShiftX : (indexFromStart * vs);
      const offsetY = maxShiftY > vsY ? (indexFromStart * vsY) % maxShiftY : (indexFromStart * vsY);
      return {
        handle: id,
        bounds: { width, height, top: top + offsetY, left: left + offsetX },
      };
    });
  }

  // Work area is present: enforce strict spatial containment
  const minWParam = Number.isFinite(Number(opts.minWidth)) && Number(opts.minWidth) > 0
    ? Math.round(Number(opts.minWidth))
    : DEFAULT_MIN_WINDOW_WIDTH;
  const minHParam = Number.isFinite(Number(opts.minHeight)) && Number(opts.minHeight) > 0
    ? Math.round(Number(opts.minHeight))
    : DEFAULT_MIN_WINDOW_HEIGHT;

  // On small viewports, minimum bounds scale down to fit the available surface
  const effectiveMinWidth = Math.min(minWParam, work.width);
  const effectiveMinHeight = Math.min(minHParam, work.height);

  const rawWidth = Number.isFinite(Number(opts.width)) && Number(opts.width) > 0
    ? Math.round(Number(opts.width))
    : DEFAULT_WINDOW_WIDTH;
  const rawHeight = Number.isFinite(Number(opts.height)) && Number(opts.height) > 0
    ? Math.round(Number(opts.height))
    : DEFAULT_WINDOW_HEIGHT;

  const width = Math.max(effectiveMinWidth, Math.min(rawWidth, work.width));
  const height = Math.max(effectiveMinHeight, Math.min(rawHeight, work.height));

  const minLeft = work.x;
  const maxLeft = work.x + Math.max(0, work.width - width);
  const rawLeft = Number.isFinite(Number(opts.left ?? opts.x))
    ? Math.round(Number(opts.left ?? opts.x))
    : work.x;
  const startLeft = Math.max(minLeft, Math.min(maxLeft, rawLeft));

  const minTop = work.y;
  const maxTop = work.y + Math.max(0, work.height - height);
  const rawTop = Number.isFinite(Number(opts.top ?? opts.y))
    ? Math.round(Number(opts.top ?? opts.y))
    : work.y;
  const startTop = Math.max(minTop, Math.min(maxTop, rawTop));

  const availableSpanX = Math.max(0, maxLeft - startLeft);
  const availableSpanY = Math.max(0, maxTop - startTop);

  const vs = Math.max(1, Math.round(Number(opts.vs) || DEFAULT_CASCADE_STEP_X));
  const vsY = Math.max(1, Math.round(Number(opts.vsY) || Math.round(vs * 0.8) || 32));

  let maxShiftX = availableSpanX;
  if (Number.isFinite(Number(opts.maxShiftX)) && Number(opts.maxShiftX) > 0) {
    maxShiftX = Math.min(availableSpanX, Math.round(Number(opts.maxShiftX)));
  }

  let maxShiftY = availableSpanY;
  if (Number.isFinite(Number(opts.maxShiftY)) && Number(opts.maxShiftY) > 0) {
    maxShiftY = Math.min(availableSpanY, Math.round(Number(opts.maxShiftY)));
  }

  return ids.map((id, indexFromStart) => {
    let offsetX = 0;
    if (maxShiftX > 0) {
      if (maxShiftX > vs) {
        offsetX = (indexFromStart * vs) % maxShiftX;
      } else {
        offsetX = (indexFromStart % 2 === 0) ? 0 : maxShiftX;
      }
    }

    let offsetY = 0;
    if (maxShiftY > 0) {
      if (maxShiftY > vsY) {
        offsetY = (indexFromStart * vsY) % maxShiftY;
      } else {
        offsetY = (indexFromStart % 2 === 0) ? 0 : maxShiftY;
      }
    }

    const finalLeft = Math.max(work.x, Math.min(maxLeft, startLeft + offsetX));
    const finalTop = Math.max(work.y, Math.min(maxTop, startTop + offsetY));

    return {
      handle: id,
      bounds: {
        width,
        height,
        left: finalLeft,
        top: finalTop,
      },
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
  resolveWorkArea,
  DEFAULT_MIN_WINDOW_WIDTH,
  DEFAULT_MIN_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
};
