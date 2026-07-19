'use strict';

/**
 * Master → slave event type codes from live-sync control flow switch(e.type).
 *
 * type | handler                    | operate gate
 * -----|----------------------------|---------------------------
 *  20  | navigateMouseWithSize      | click+move  (Browser.clickheadbox_withsize)
 *   1  | webMouse                   | click+move  (Browser.click)
 *   2  | webWheel                   | scroll+move (Browser.scroll)
 *   3  | webKey                     | keyboard    (Browser.keyboard)
 *   4  | navigateKey                | keyboard    (Browser.keyboard_toheadbox)
 *   5  | navigateChat               | keyboard
 *   6  | webChat                    | keyboard
 *   7  | navigateActionEvent        | keyboard
 *   8  | webActionEvent             | keyboard
 *  10  | closePluginWindow          | click+move
 *  11  | subBrowserCustomerClose    | click+move
 *  21  | scrollHeadBoxEvent         | scroll+move (Browser.scrollHeadBox)
 */

const EVENT_TYPE = Object.freeze({
  WEB_MOUSE: 1,
  WEB_WHEEL: 2,
  WEB_KEY: 3,
  NAVIGATE_KEY: 4,
  NAVIGATE_CHAT: 5,
  WEB_CHAT: 6,
  NAVIGATE_ACTION: 7,
  WEB_ACTION: 8,
  CLOSE_PLUGIN: 10,
  SUB_BROWSER_CLOSE: 11,
  HEADBOX_MOUSE: 20,
  HEADBOX_SCROLL: 21,
});

const OPERATE_GATES = Object.freeze({
  [EVENT_TYPE.HEADBOX_MOUSE]: ['click', 'move'],
  [EVENT_TYPE.WEB_MOUSE]: ['click', 'move'],
  [EVENT_TYPE.WEB_WHEEL]: ['scroll', 'move'],
  [EVENT_TYPE.HEADBOX_SCROLL]: ['scroll', 'move'],
  [EVENT_TYPE.WEB_KEY]: ['keyboard'],
  [EVENT_TYPE.NAVIGATE_KEY]: ['keyboard'],
  [EVENT_TYPE.NAVIGATE_CHAT]: ['keyboard'],
  [EVENT_TYPE.WEB_CHAT]: ['keyboard'],
  [EVENT_TYPE.NAVIGATE_ACTION]: ['keyboard'],
  [EVENT_TYPE.WEB_ACTION]: ['keyboard'],
  [EVENT_TYPE.CLOSE_PLUGIN]: ['click', 'move'],
  [EVENT_TYPE.SUB_BROWSER_CLOSE]: ['click', 'move'],
});

/**
 * Map OpenBrowser openBrowserSync payload → protocol master event.
 */
function payloadToSyncEvent(payload = {}, options = {}) {
  const type = String(payload.type || '');
  const headbox = Boolean(options.headbox || payload.headbox);

  if (type === 'mouse') {
    const phase = String(payload.phase || '');
    let action = 0; // move
    if (phase === 'down') action = 1;
    else if (phase === 'up') action = 2;
    else if (phase === 'move') action = 0;
    return {
      type: headbox ? EVENT_TYPE.HEADBOX_MOUSE : EVENT_TYPE.WEB_MOUSE,
      action,
      x: Number(payload.x) || 0,
      y: Number(payload.y) || 0,
      width: Number(payload.width) || 0,
      height: Number(payload.height) || 0,
      name: payload.name || undefined,
      button: payload.button,
      buttons: payload.buttons,
    };
  }

  if (type === 'click') {
    return {
      type: headbox ? EVENT_TYPE.HEADBOX_MOUSE : EVENT_TYPE.WEB_MOUSE,
      action: 3,
      x: Number(payload.x) || 0,
      y: Number(payload.y) || 0,
      width: Number(payload.width) || 0,
      height: Number(payload.height) || 0,
      button: payload.button,
    };
  }

  if (type === 'wheel') {
    return {
      type: headbox ? EVENT_TYPE.HEADBOX_SCROLL : EVENT_TYPE.WEB_WHEEL,
      dX: Number(payload.deltaX) || 0,
      dY: Number(payload.deltaY) || 0,
      x: Number(payload.x) || 0,
      y: Number(payload.y) || 0,
      Phase: payload.phase || 'update',
    };
  }

  if (type === 'key') {
    return {
      type: headbox ? EVENT_TYPE.NAVIGATE_KEY : EVENT_TYPE.WEB_KEY,
      key: payload.key,
      code: payload.code,
      keyCode: payload.keyCode,
      windowsVirtualKeyCode: payload.keyCode,
      location: payload.location,
      modifiers: modifiersFromPayload(payload),
      phase: payload.phase,
      alt: payload.alt,
      ctrl: payload.ctrl,
      meta: payload.meta,
      shift: payload.shift,
    };
  }

  if (type === 'beforeinput' || type === 'input') {
    return {
      type: EVENT_TYPE.WEB_ACTION,
      text: payload.data != null ? String(payload.data) : String(payload.value || ''),
      inputType: payload.inputType,
    };
  }

  if (type === 'scroll') {
    return {
      type: EVENT_TYPE.WEB_WHEEL,
      dX: 0,
      dY: 0,
      x: Number(payload.x) || 0,
      y: Number(payload.y) || 0,
      scrollX: payload.x,
      scrollY: payload.y,
      Phase: 'scroll',
    };
  }

  return null;
}

function modifiersFromPayload(payload) {
  let value = 0;
  if (payload.alt) value |= 1;
  if (payload.ctrl) value |= 2;
  if (payload.meta) value |= 4;
  if (payload.shift) value |= 8;
  return value;
}

function operateAllows(eventType, operateList) {
  const need = OPERATE_GATES[eventType];
  if (!need) return false;
  const set = new Set(operateList || []);
  return need.every((flag) => set.has(flag));
}

/**
 * Convert protocol event → Browser.* command for translateToStandardCdp.
 */
function syncEventToCommand(event) {
  if (!event || event.type == null) return null;
  const t = Number(event.type);
  if (t === EVENT_TYPE.HEADBOX_MOUSE) {
    return { command: 'Browser.clickheadbox_withsize', params: event };
  }
  if (t === EVENT_TYPE.WEB_MOUSE) {
    return { command: 'Browser.click', params: event };
  }
  if (t === EVENT_TYPE.WEB_WHEEL) {
    return { command: 'Browser.scroll', params: event };
  }
  if (t === EVENT_TYPE.HEADBOX_SCROLL) {
    return { command: 'Browser.scrollHeadBox', params: event };
  }
  if (t === EVENT_TYPE.WEB_KEY || t === EVENT_TYPE.NAVIGATE_KEY) {
    return {
      command: t === EVENT_TYPE.NAVIGATE_KEY ? 'Browser.keyboard_toheadbox' : 'Browser.keyboard',
      params: event,
    };
  }
  if (t === EVENT_TYPE.WEB_ACTION || t === EVENT_TYPE.NAVIGATE_ACTION || t === EVENT_TYPE.WEB_CHAT || t === EVENT_TYPE.NAVIGATE_CHAT) {
    if (event.text) return { command: 'Browser.sendTextToDom', params: { text: event.text } };
    return { command: 'Browser.actionToDom', params: event };
  }
  return null;
}

/**
 * syncSettings (openbrowser) ↔ operate list
 */
function settingsToOperateList(settings = {}) {
  const list = [];
  if (settings.click !== false) list.push('click');
  if (settings.track !== false || settings.move !== false) list.push('move');
  if (settings.scroll !== false) list.push('scroll');
  if (settings.keyboard !== false) list.push('keyboard');
  return list;
}

function operateListToSettings(operateList = []) {
  const set = new Set(operateList);
  return {
    click: set.has('click'),
    track: set.has('move') || set.has('track'),
    scroll: set.has('scroll'),
    keyboard: set.has('keyboard'),
  };
}

module.exports = {
  EVENT_TYPE,
  OPERATE_GATES,
  payloadToSyncEvent,
  operateAllows,
  syncEventToCommand,
  settingsToOperateList,
  operateListToSettings,
  modifiersFromPayload,
};
