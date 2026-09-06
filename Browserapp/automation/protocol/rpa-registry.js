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
  let elseChildren = Array.isArray(step.elseChildren)
    ? step.elseChildren.map(normalizeStep)
    : (Array.isArray(params.elseChildren) ? params.elseChildren.map(normalizeStep) : undefined);
  let errorChildren = Array.isArray(step.errorChildren)
    ? step.errorChildren.map(normalizeStep)
    : (Array.isArray(params.errorChildren) ? params.errorChildren.map(normalizeStep) : undefined);
  delete params.elseChildren;
  delete params.errorChildren;
  if (blocks.length) {
    children = blocks.map((block) => normalizeStep(block.data || block));
    delete params.blocks;
  }
  const result = {
    type,
    params,
    children,
    id: step.id || null,
  };
  if (elseChildren) result.elseChildren = elseChildren;
  if (errorChildren) result.errorChildren = errorChildren;
  return result;
}

function isLoopType(type) {
  return ['forLists', 'forElements', 'forTimes', 'whileData'].includes(type);
}

function isContainerType(type) {
  return ['forLists', 'forElements', 'forTimes', 'whileData', 'openNewBrowser'].includes(type);
}

function edgeHandle(edge, nodeId) {
  return String(edge.sourceHandle || '').replace(String(nodeId), '');
}

function isRegistered(type) {
  return RPA_PLUS_ACTIONS.includes(type);
}

function findConvergence(startA, startB, outgoing, stopIds = new Set()) {
  if (!startA || !startB) return null;
  if (startA === startB) return startA;

  function getReachable(start) {
    const visited = new Set();
    const q = [start];
    while (q.length > 0) {
      const curr = q.shift();
      if (!curr || visited.has(curr) || stopIds.has(curr)) continue;
      visited.add(curr);
      const edges = outgoing.get(curr) || [];
      for (const e of edges) {
        const h = edgeHandle(e, curr);
        if (h === '-output-start' || h === '-output-error') continue;
        if (!visited.has(e.target) && !stopIds.has(e.target)) {
          q.push(e.target);
        }
      }
    }
    return visited;
  }

  const reachA = getReachable(startA);
  if (reachA.has(startB)) return startB;
  const reachB = getReachable(startB);
  if (reachB.has(startA)) return startA;

  const common = new Set([...reachA].filter((id) => reachB.has(id)));
  if (common.size === 0) return null;

  for (const c of common) {
    let hasPredecessor = false;
    for (const other of common) {
      if (other === c) continue;
      if (getReachable(other).has(c)) {
        hasPredecessor = true;
        break;
      }
    }
    if (!hasPredecessor) return c;
  }
  return null;
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
        let nextId = null;

        if (type !== 'startNode') {
          const step = normalizeStep(current);

          // Error branch (-output-error) available on all nodes
          const errorEdge = edges.find((edge) => /-output-error$/.test(edgeHandle(edge, currentId)));
          if (errorEdge) {
            step.errorChildren = compileSequence(errorEdge.target, new Set(stopIds), new Set(path));
          }

          if (type === 'ifElse') {
            const ifEdge = edges.find((edge) => /-output-if$/.test(edgeHandle(edge, currentId)));
            const elseEdge = edges.find((edge) => /-output-else$/.test(edgeHandle(edge, currentId)));
            const outEdge = edges.find((edge) => /-output$/.test(edgeHandle(edge, currentId)));

            if (ifEdge && outEdge) {
              // Explicit continuation edge
              step.children = compileSequence(ifEdge.target, new Set([...stopIds, outEdge.target]), new Set(path));
              if (elseEdge) {
                step.elseChildren = compileSequence(elseEdge.target, new Set([...stopIds, outEdge.target]), new Set(path));
              }
              nextId = outEdge.target;
            } else {
              const trueTarget = (ifEdge || outEdge)?.target;
              const falseTarget = elseEdge?.target;

              if (trueTarget && falseTarget) {
                const conv = findConvergence(trueTarget, falseTarget, outgoing, stopIds);
                const branchStops = conv ? new Set([...stopIds, conv]) : new Set(stopIds);
                step.children = (trueTarget === conv) ? [] : compileSequence(trueTarget, branchStops, new Set(path));
                step.elseChildren = (falseTarget === conv) ? [] : compileSequence(falseTarget, branchStops, new Set(path));
                nextId = conv || null;
              } else if (trueTarget) {
                step.children = compileSequence(trueTarget, new Set(stopIds), new Set(path));
                nextId = null;
              } else if (falseTarget) {
                step.elseChildren = compileSequence(falseTarget, new Set(stopIds), new Set(path));
                nextId = null;
              }
            }
          } else if (isContainerType(type) || edges.some((edge) => /-output-start$/.test(edgeHandle(edge, currentId)))) {
            const bodyEdge = edges.find((edge) => /-output-start$/.test(edgeHandle(edge, currentId)));
            if (bodyEdge) {
              step.children = compileSequence(bodyEdge.target, new Set([...stopIds, currentId]), new Set(path));
            }
            const contEdge = edges.find((edge) => /-output$/.test(edgeHandle(edge, currentId)));
            nextId = contEdge?.target || null;
          } else {
            const contEdge = edges.find((edge) => {
              const h = edgeHandle(edge, currentId);
              return !/-output-(?:start|else|if|error)$/.test(h);
            });
            nextId = contEdge?.target || null;
          }

          ordered.push(step);
        } else {
          const contEdge = edges.find((edge) => {
            const h = edgeHandle(edge, currentId);
            return !/-output-(?:start|else|if|error)$/.test(h);
          });
          nextId = contEdge?.target || null;
        }

        currentId = nextId;
      }
      return ordered;
    };

    const ordered = compileSequence(start?.id);
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
  findConvergence,
  isContainerType,
};
