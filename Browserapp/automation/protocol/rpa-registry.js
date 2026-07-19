'use strict';

/**
 * RPA action registry (registerAction list + param schemas).
 *
 * process model:
 *   task { id, fbcc_user_id, process_content, process_id, process_name, type }
 *   runner connects: puppeteer.connect({ browserWSEndpoint, defaultViewport: null })
 *   timeout race 180s, retry up to 5
 *   runProcess({ browser, page, content, variableObj, isChildren, isLoop, ... })
 *
 * process_content is a node graph / step list; each node has type matching registerAction names.
 */

/** Full RPA Plus action set (order from registerAction calls) */
const RPA_PLUS_ACTIONS = Object.freeze([
  'startNode',
  'newPage',
  'closePage',
  'closeOtherPage',
  'switchPage',
  'gotoUrl',
  'refreshPage',
  'goBack',
  'screenshotPage',
  'passingElement',
  'selectElement',
  'focusElement',
  'click',
  'inputContent',
  'scrollPage',
  'uploadAttachment',
  'javaScript',
  'keyboard',
  'keyCombination',
  'waitTime',
  'waitForSelector',
  'waitForResponse',
  'getUrl',
  'getClipboard',
  'getElement',
  'getActiveElement',
  'saveData',
  'exportExcel',
  'downloadFile',
  'useExcel',
  'importText',
  'getEmail',
  'get2faCode',
  'getRequest',
  'getResponse',
  'stopLinsten', // historical typo preserved for template compatibility
  'getCookies',
  'clearCookies',
  'extractData',
  'toJson',
  'extractKey',
  'randomGet',
  'saveRemark',
  'saveTag',
  'openNewBrowser',
  'applySubProcess',
  'ifElse',
  'forElements',
  'forTimes',
  'forLists',
  'whileData',
  'breakLoop',
  'closeBrowser',
  'getCaptcha',
  'googleSheet',
  'getOpenAI',
]);

/**
 * Parameter schemas for RPA actions.
 * Used for validation + documentation of step payloads.
 */
const ACTION_PARAM_SCHEMA = Object.freeze({
  gotoUrl: { fields: ['url', 'timeout'], defaults: { timeout: null } },
  waitTime: { fields: ['timeout', 'timeoutType', 'timeoutMin', 'timeoutMax'], defaults: { timeout: 1000, timeoutType: 'fixed' } },
  click: {
    fields: ['selectorRadio', 'selector', 'serial', 'button', 'type', 'serialType', 'serialMin', 'serialMax', 'selectorType', 'element'],
    defaults: { selectorRadio: 'CSS', button: 'left', type: 'click' },
  },
  inputContent: { fields: ['selector', 'selectorRadio', 'serial', 'content', 'intervals', 'isClear'], defaults: { selectorRadio: 'CSS' } },
  scrollPage: {
    fields: ['distance', 'type', 'scrollType', 'position', 'rangeType', 'selectorRadio', 'selector', 'serial', 'randomWheelDistance', 'randomWheelSleepTime'],
    defaults: { type: 'smooth', rangeType: 'window', selectorRadio: 'CSS' },
  },
  waitForSelector: {
    fields: ['selectorRadio', 'selector', 'isShow', 'timeout', 'serial', 'variable'],
    defaults: { selectorRadio: 'CSS' },
  },
  selectElement: {
    fields: ['selectorRadio', 'selector', 'serialType', 'serialMin', 'serialMax', 'value', 'serial', 'selectorType', 'element'],
    defaults: { selectorRadio: 'CSS' },
  },
  newPage: { fields: ['url'], defaults: {} },
  closePage: { fields: [], defaults: {} },
  refreshPage: { fields: [], defaults: {} },
  screenshotPage: { fields: ['path', 'fullPage'], defaults: { fullPage: true } },
  javaScript: { fields: ['code', 'expression'], defaults: {} },
  keyboard: { fields: ['key', 'selector'], defaults: {} },
  ifElse: { fields: ['condition', 'children'], defaults: {} },
  forTimes: { fields: ['times', 'children'], defaults: { times: 1 } },
  forElements: { fields: ['selector', 'children'], defaults: {} },
  whileData: { fields: ['condition', 'children'], defaults: {} },
  breakLoop: { fields: [], defaults: {} },
  clearCookies: { fields: [], defaults: {} },
  getCookies: { fields: ['variable'], defaults: {} },
  getUrl: { fields: ['variable'], defaults: {} },
  closeBrowser: { fields: [], defaults: {} },
});

function normalizeStep(step = {}) {
  const type = String(step.type || step.action || step.name || '').trim();
  let params = step.params && typeof step.params === 'object'
    ? { ...step.params }
    : { ...step };
  // Marketplace graph nodes store action options under `config`.  Keep the
  // graph wrapper out of executable steps so every action reads one shape.
  if (params.config && typeof params.config === 'object' && !Array.isArray(params.config)) {
    params = { ...params.config };
  }
  delete params.type;
  delete params.action;
  delete params.name;
  delete params.children;
  delete params.id;
  const blocks = Array.isArray(params.blocks) ? params.blocks : [];
  let children = Array.isArray(step.children) ? step.children.map(normalizeStep) : [];
  if (blocks.length) {
    children = blocks.map((block) => normalizeStep(block.data || block));
    delete params.blocks;
  }
  return {
    type,
    params,
    children,
    id: step.id || null,
  };
}

function isLoopType(type) {
  return ['forLists', 'forElements', 'forTimes', 'whileData'].includes(type);
}

function edgeHandle(edge, nodeId) {
  return String(edge.sourceHandle || '').replace(String(nodeId), '');
}

function isRegistered(type) {
  return RPA_PLUS_ACTIONS.includes(type);
}

/**
 * Parse process_content from task row (string JSON or object).
 * Supports:
 *  - Array of steps
 *  - { steps: [] }
 *  - { nodes: [], edges: [] }  (graph; linearize by startNode)
 */
function parseProcessContent(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { return []; }
  }
  if (!value) return [];
  if (Array.isArray(value)) return value.map(normalizeStep);
  if (Array.isArray(value.steps)) return value.steps.map(normalizeStep);
  if (Array.isArray(value.content)) return value.content.map(normalizeStep);
  if (Array.isArray(value.nodes)) {
    // Compile the graph into nested steps. Loop bodies return through an
    // `input-end` edge, while condition branches use `output` / `output-else`.
    // Keeping these boundaries prevents marketplace workflows from silently
    // becoming a one-pass linear sequence.
    const byId = new Map(value.nodes.map((n) => [n.id, n]));
    const start = value.nodes.find((n) => n.type === 'startNode') || value.nodes[0];
    const outgoing = new Map();
    for (const edge of value.edges || []) {
      if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
      const list = outgoing.get(edge.source) || [];
      list.push(edge);
      outgoing.set(edge.source, list);
    }

    const compileSequence = (nodeId, stopIds = new Set(), pathIds = new Set()) => {
      const ordered = [];
      let currentId = nodeId;
      const path = new Set(pathIds);
      while (currentId && !stopIds.has(currentId) && !path.has(currentId)) {
        const current = byId.get(currentId);
        if (!current) break;
        path.add(currentId);
        const edges = outgoing.get(currentId) || [];
        const type = String(current.type || '');

        if (type !== 'startNode') {
          const step = normalizeStep(current);
          if (type === 'ifElse') {
            const trueEdge = edges.find((edge) => /-output$/.test(edgeHandle(edge, currentId)));
            const falseEdge = edges.find((edge) => /-output-else$/.test(edgeHandle(edge, currentId)));
            step.children = trueEdge
              ? compileSequence(trueEdge.target, new Set(stopIds), new Set(path))
              : step.children;
            if (falseEdge) {
              step.elseChildren = compileSequence(falseEdge.target, new Set(stopIds), new Set(path));
            }
          } else if (isLoopType(type)) {
            const bodyEdge = edges.find((edge) => /-output-start$/.test(edgeHandle(edge, currentId)));
            if (bodyEdge) {
              step.children = compileSequence(bodyEdge.target, new Set([...stopIds, currentId]), new Set(path));
            }
          }
          ordered.push(step);
        }

        const continuation = edges.find((edge) => {
          const handle = edgeHandle(edge, currentId);
          if (type === 'ifElse') return false;
          if (isLoopType(type)) return /-output$/.test(handle);
          return !/-output-(?:start|else)$/.test(handle);
        });
        currentId = continuation?.target || null;
      }
      return ordered;
    };

    const ordered = compileSequence(start?.id);
    // Fallback: array order excluding startNode (workflow export without edges)
    if (!ordered.length) {
      return value.nodes.filter((n) => n && n.type !== 'startNode').map(normalizeStep);
    }
    return ordered;
  }
  return [];
}

function randomNum(min, max) {
  const a = Number(min) || 0;
  const b = Math.max(a, Number(max) || a);
  return a + Math.random() * (b - a);
}

module.exports = {
  RPA_PLUS_ACTIONS,
  ACTION_PARAM_SCHEMA,
  normalizeStep,
  isRegistered,
  parseProcessContent,
  randomNum,
};
