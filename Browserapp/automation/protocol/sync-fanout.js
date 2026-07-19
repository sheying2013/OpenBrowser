'use strict';

/**
 * End-to-end fanout: OpenBrowser payload → event type → Browser.* → standard CDP list.
 * Used by live-sync and selftests on Win/macOS.
 */

const { payloadToSyncEvent, operateAllows, syncEventToCommand, settingsToOperateList } = require('./event-map');
const { translateToStandardCdp, parseOperateList } = require('./window-sync-protocol');

function resolveOperateList(options = {}) {
  if (options.operate || options.syncOperateList) {
    return parseOperateList(options.operate || options.syncOperateList);
  }
  if (options.syncSettings) return settingsToOperateList(options.syncSettings);
  return ['click', 'move', 'scroll', 'keyboard'];
}

/**
 * @returns {{ skip:boolean, reason?:string, syncEvent?:object, proprietary?:object, standard?:array, delayMs?:number, eventType?:number }}
 */
function planFanoutFromPayload(payload, options = {}) {
  const operateList = resolveOperateList(options);
  const settings = options.syncSettings || {};
  const syncEvent = payloadToSyncEvent(payload, options);
  if (!syncEvent) return { skip: true, reason: 'unmapped-payload' };

  if (!operateAllows(syncEvent.type, operateList)) {
    return { skip: true, reason: 'operate-gate', syncEvent, eventType: syncEvent.type, operateList };
  }

  const proprietary = syncEventToCommand(syncEvent);
  if (!proprietary) return { skip: true, reason: 'no-command', syncEvent, eventType: syncEvent.type };

  const delayClick = options.delayClick ?? settings.delayClick;
  const delayInput = options.delayInput ?? settings.delayInput;
  const isDelay = options.isDelay === true || options.isDelay === '1'
    || (delayClick && (payload.type === 'click' || (payload.type === 'mouse' && payload.phase !== 'move')))
    || (delayInput && (payload.type === 'key' || payload.type === 'beforeinput' || payload.type === 'input'));

  let delayMs = 0;
  if (isDelay) {
    const clickMin = options.clickMinMs ?? settings.clickMinMs;
    const clickMax = options.clickMaxMs ?? settings.clickMaxMs;
    const inputMin = options.inputMinMs ?? settings.inputMinMs;
    const inputMax = options.inputMaxMs ?? settings.inputMaxMs;
    const useInput = payload.type === 'key' || payload.type === 'beforeinput' || payload.type === 'input';
    const min = Number(options.mouseDelayMin ?? (useInput ? inputMin : clickMin) ?? 0) || 0;
    const max = Math.max(min, Number(options.mouseDelayMax ?? (useInput ? inputMax : clickMax) ?? min) || min);
    delayMs = min + Math.random() * Math.max(0, max - min);
  }

  return {
    skip: false,
    syncEvent,
    eventType: syncEvent.type,
    proprietary,
    standard: translateToStandardCdp(proprietary.command, proprietary.params),
    delayMs,
    operateList,
  };
}

async function applyStandardCommands(sendCommand, commands, delayMs = 0) {
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  for (const cmd of commands || []) {
    await sendCommand(cmd.method, cmd.params || {});
  }
}

module.exports = {
  planFanoutFromPayload,
  applyStandardCommands,
  resolveOperateList,
};
