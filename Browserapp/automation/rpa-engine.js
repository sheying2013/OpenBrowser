'use strict';

const cdp = require('../cdp');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const {
  parseProcessContent,
  randomNum,
  RPA_PLUS_ACTIONS,
  isRegistered,
} = require('./protocol/rpa-registry');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OUTPUT_DIRECTORY = path.join(process.cwd(), 'rpa-output');
const RPA_DIAGNOSTIC_LIMIT = 512 * 1024;
const CDP_AUTOMATION_BLOCKED = 'Browser automation requires a paid Donut Browser plan.';

/** True when a missing element should not fail the whole flow. */
function isOptionalElementStep(params = {}) {
  // Explicit optional only. Do NOT treat isShow=0 as optional: catalog often uses
  // isShow for visibility mode, not "skip if missing".
  if (params.optional === true || params.optional === 1 || params.optional === '1' || params.optional === 'true') {
    return true;
  }
  const selector = String(params.selector || '');
  // Known ephemeral overlays / geo chrome that commonly absents on locale pages.
  // Keep this list narrow; prefer step.optional=true from sanitizeOptionalOverlaySteps.
  if (/redir-overlay|redir-dismiss|nav-global-location|GLUXZip|GLUXZipUpdateInput|GLUXZipInputSection|GLUXConfirmClose|glow-ingress|#sp-cc-accept/i.test(selector)) {
    return true;
  }
  return false;
}

/** Optional steps may skip only element-missing errors, never CDP/session failures. */
function isMissingElementError(error) {
  const message = String(error?.message || error || '');
  if (!message) return false;
  if (message.includes(CDP_AUTOMATION_BLOCKED)) return false;
  return /Element not found|Selector not found|selectElement failed|No page tab for CDP|useExcel file not found|file path required/i.test(message);
}

function isPathInsideRoot(candidate, root) {
  const child = path.resolve(candidate);
  const base = path.resolve(root);
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  return normalize(child) === normalize(base) || normalize(child).startsWith(normalize(base) + path.sep);
}

/**
 * Resolve a user-supplied local file path for RPA steps.
 * Absolute paths must stay under OUTPUT_DIRECTORY (or optional extraRoots).
 * Relative paths resolve under OUTPUT_DIRECTORY only.
 */
function resolveSafeRpaPath(filePath, { extraRoots = [], mustExist = false } = {}) {
  const raw = String(filePath || '').trim();
  if (!raw) throw new Error('file path required');
  if (raw.includes('\0')) throw new Error('invalid file path');
  const roots = [OUTPUT_DIRECTORY, ...extraRoots].map((item) => path.resolve(item));
  const resolved = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(OUTPUT_DIRECTORY, raw);
  if (!roots.some((root) => isPathInsideRoot(resolved, root))) {
    throw new Error('RPA file path must be inside the RPA output directory');
  }
  return resolved;
}

const EXECUTABLE_STEP_TYPES = new Set([
  'wait', 'sleep', 'delay', 'waittime',
  'goto', 'navigate', 'open', 'gotourl',
  'reload', 'refreshpage',
  'newtab', 'new_tab', 'newpage',
  'closetab', 'close_tab', 'closepage',
  'typetext', 'type', 'input', 'inserttext', 'inputcontent',
  'click', 'clickelement', 'waitforselector', 'fortimes',
  'javascript', 'evaluate', 'script', 'js',
  'scroll', 'scrollpage', 'screenshotpage', 'screenshot',
  'geturl', 'clearcookies', 'startnode', 'noop', 'breakloop',
  'key', 'press', 'keyboard',
  'combineprocess', 'getelement', 'passingelement', 'focuselement',
  'selectelement', 'getrequest',
  'ifelse', 'forelements', 'forlists', 'whiledata', 'tojson', 'extractkey',
  'extractdata', 'savedata', 'exportexcel', 'saveremark', 'variableoperation',
  'goback', 'switchpage', 'uploadattachment', 'downloadfile',
  'waitforresponse', 'getresponse', 'stoplinsten', 'closebrowser',
  'opennewbrowser', 'getopenai',
  'useexcel',
  'importtext', 'randomget', 'get2facode', 'googlesheet', 'getcookies', 'getclipboard', 'getactiveelement',
  'keycombination', 'applysubprocess', 'getcaptcha', 'closeotherpage',
]);

function findUnsupportedSteps(steps, path = []) {
  if (!Array.isArray(steps)) return [{ path, type: '', reason: 'steps must be an array' }];
  const unsupported = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] || {};
    const type = String(step.type || step.action || '').toLowerCase();
    const currentPath = [...path, index + 1];
    if (!EXECUTABLE_STEP_TYPES.has(type)) {
      unsupported.push({ path: currentPath, type: type || '(empty)' });
    }
    const children = Array.isArray(step.children)
      ? step.children
      : (Array.isArray(step.params?.children) ? step.params.children : null);
    if (children) unsupported.push(...findUnsupportedSteps(children, currentPath));
    const elseChildren = Array.isArray(step.elseChildren)
      ? step.elseChildren
      : (Array.isArray(step.params?.elseChildren) ? step.params.elseChildren : null);
    if (elseChildren) unsupported.push(...findUnsupportedSteps(elseChildren, currentPath));
  }
  return unsupported;
}

function randomBetween(min, max) {
  return randomNum(min, max);
}

function interpolate(value, variables = {}) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const result = variables[String(key).trim()];
    return result == null ? '' : String(result);
  });
}

function getVariableValue(value, variables = {}) {
  if (Array.isArray(value)) return value.map((item) => getVariableValue(item, variables));
  if (typeof value !== 'string') return value;
  const match = value.match(/^\$\{([^}]+)\}$/);
  return match ? variables[match[1].trim()] : interpolate(value, variables);
}

function defaultRpaLogPath(userDataPath = null) {
  if (process.env.OPENBROWSER_RPA_LOG) return String(process.env.OPENBROWSER_RPA_LOG);
  if (userDataPath) return path.join(userDataPath, 'logs', 'rpa-automation.log');
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'openbrowser', 'logs', 'rpa-automation.log');
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'openbrowser', 'logs', 'rpa-automation.log');
  }
  return path.join(os.homedir(), '.config', 'openbrowser', 'logs', 'rpa-automation.log');
}

function compactError(error) {
  const message = String(error?.message || error || 'Unknown RPA error');
  return {
    name: error?.name || 'Error',
    message,
    stack: String(error?.stack || '').split(/\r?\n/).slice(0, 12).join('\n'),
  };
}

function formatRpaError(error) {
  const message = String(error?.message || error || 'Unknown RPA error');
  if (message.includes(CDP_AUTOMATION_BLOCKED)) {
    return [
      '当前浏览器内核拒绝 CDP/RPA 自动化（独立内核未就绪或策略不匹配）。请使用安装包内置 kernels/windows-x64 并清理 userData 过期内核。',
      '请改用支持本地 CDP 自动化的内核，或在本机浏览器回退中手动选择 Chrome/Edge 后再运行自动脚本。',
    ].join(' ');
  }
  return message;
}

/**
 * CDP-based RPA step runner for OpenBrowser.
 * Independent reimplementation (puppeteer-core / CDP steps + plan/task store).
 */
class RpaEngine {
  constructor({ engine, store, emit = () => {}, userDataPath = null, rpaLogPath = null } = {}) {
    this.engine = engine;
    this.store = store;
    this.emit = emit;
    this.rpaLogPath = rpaLogPath || defaultRpaLogPath(userDataPath);
    this.running = new Map();
    this.profileStarts = new Map();
    this.cancelled = new Set();
  }

  async writeDiagnostic(record) {
    if (!this.rpaLogPath) return;
    try {
      await fs.mkdir(path.dirname(this.rpaLogPath), { recursive: true });
      const line = JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n';
      await fs.appendFile(this.rpaLogPath, line, 'utf8');
      const stat = await fs.stat(this.rpaLogPath);
      if (stat.size > RPA_DIAGNOSTIC_LIMIT) {
        const content = await fs.readFile(this.rpaLogPath, 'utf8');
        await fs.writeFile(this.rpaLogPath, content.slice(-Math.floor(RPA_DIAGNOSTIC_LIMIT / 2)), 'utf8');
      }
    } catch (_) {}
  }

  getStatus() {
    return {
      running: [...this.running.keys()],
      count: this.running.size,
    };
  }

  async stop(taskId) {
    if (taskId) {
      this.cancelled.add(taskId);
      this.running.delete(taskId);
      return { success: true, taskId };
    }
    for (const id of [...this.running.keys()]) this.cancelled.add(id);
    this.running.clear();
    return { success: true, stoppedAll: true };
  }

  async runPlan(planId, options = {}) {
    const plan = this.store.getPlan(planId);
    if (!plan) throw new Error('RPA plan not found: ' + planId);
    const profileIds = Array.isArray(options.profile_ids) && options.profile_ids.length
      ? options.profile_ids.map(String)
      : (plan.profile_ids || []);
    if (!profileIds.length) throw new Error('No profile_ids on plan');

    const planVariables = plan.variables && typeof plan.variables === 'object' && !Array.isArray(plan.variables)
      ? plan.variables
      : {};
    const tasks = typeof this.store.createTasks === 'function'
      ? await this.store.createTasks(profileIds.map((profileId) => ({
        plan_id: plan.id,
        profile_id: profileId,
        process_name: plan.process_name || plan.plan_name,
        steps: plan.steps,
        process_content: plan.process_content || null,
        variables: planVariables,
      })))
      : await Promise.all(profileIds.map((profileId) => this.store.createTask({
        plan_id: plan.id,
        profile_id: profileId,
        process_name: plan.process_name || plan.plan_name,
        steps: plan.steps,
        process_content: plan.process_content || null,
        variables: planVariables,
      })));
    const results = await Promise.all(tasks.map((task) => this.runTask(task.id, options)));
    return { success: results.every((item) => item.success), results };
  }

  async runTask(taskId, options = {}) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error('RPA task not found: ' + taskId);
    if (this.running.has(taskId)) throw new Error('Task already running: ' + taskId);

    this.running.set(taskId, { startedAt: Date.now() });
    this.cancelled.delete(taskId);
    await this.store.updateTask(taskId, { status: 'running', start_time: new Date().toISOString(), process_logs: [] }, { save: false });
    this.emit({ type: 'rpa-task', taskId, status: 'running', profileId: task.profile_id });
    await this.writeDiagnostic({
      type: 'rpa-task-start',
      taskId,
      planId: task.plan_id || null,
      profileId: task.profile_id,
      processName: task.process_name || null,
    });

    const logs = [];
    const log = async (message, level = 'info') => {
      const entry = { time: new Date().toISOString(), level, message: String(message) };
      logs.push(entry);
      // Log events remain live in the UI; persist the completed task once,
      // rather than rewriting the complete JSON store after every step.
      await this.store.updateTask(taskId, { process_logs: logs }, { save: false });
      this.emit({ type: 'rpa-log', taskId, ...entry });
    };

    try {
      const entry = await this.ensureProfileRunning(task.profile_id, { log });
      const port = entry.port;
      // process_content task field or steps array
      let steps = Array.isArray(task.steps) ? task.steps : [];
      if ((!steps.length) && task.process_content) {
        steps = parseProcessContent(task.process_content);
      } else if (typeof task.steps === 'string') {
        steps = parseProcessContent(task.steps);
      }
      await log(`start task on profile ${task.profile_id}, steps=${steps.length}`);

      const context = {
        log,
        options,
        variables: this.initialVariables(task),
        task,
        remarks: [],
        port,
        activeProfileId: task.profile_id,
      };
      for (let index = 0; index < steps.length; index += 1) {
        if (this.cancelled.has(taskId)) throw new Error('cancelled');
        const step = steps[index] || {};
        const type = String(step.type || step.action || '').toLowerCase();
        await log(`step ${index + 1}/${steps.length}: ${type}`);
        await this.executeStep(port, step, context);
      }

      const result = { ok: true, steps: steps.length };
      await this.store.updateTask(taskId, {
        status: 'success',
        complete_time: new Date().toISOString(),
        process_result: result,
        process_logs: logs,
      });
      await this.writeDiagnostic({
        type: 'rpa-task-success',
        taskId,
        planId: task.plan_id || null,
        profileId: task.profile_id,
        steps: steps.length,
      });
      this.emit({ type: 'rpa-task', taskId, status: 'success', profileId: task.profile_id });
      return { success: true, taskId, result };
    } catch (error) {
      const status = this.cancelled.has(taskId) ? 'cancelled' : 'failed';
      const message = formatRpaError(error);
      await log(message, status === 'failed' ? 'error' : 'info').catch(() => {});
      await this.writeDiagnostic({
        type: 'rpa-task-' + status,
        taskId,
        planId: task.plan_id || null,
        profileId: task.profile_id,
        processName: task.process_name || null,
        error: message,
        rawError: compactError(error),
      });
      await this.store.updateTask(taskId, {
        status,
        complete_time: new Date().toISOString(),
        process_result: { ok: false, error: message },
        process_logs: logs,
      });
      this.emit({ type: 'rpa-task', taskId, status, profileId: task.profile_id, message });
      return { success: false, taskId, error: message, status };
    } finally {
      this.running.delete(taskId);
      this.cancelled.delete(taskId);
    }
  }

  async ensureProfileRunning(profileId, { log } = {}) {
    const id = String(profileId || '').trim();
    if (!id) throw new Error('RPA task missing profile_id');
    const current = this.engine?.running?.get?.(id);
    if (current?.port) return current;

    const profile = this.engine?.profiles?.get?.(id);
    if (!profile) throw new Error('Profile not found for RPA task: ' + id);
    if (typeof this.engine?.start !== 'function') {
      throw new Error('Profile is not running and engine.start is unavailable: ' + id);
    }

    let startPromise = this.profileStarts.get(id);
    if (!startPromise) {
      if (log) await log('profile is not running; starting before RPA: ' + id);
      startPromise = Promise.resolve()
        .then(() => this.engine.start(profile))
        .finally(() => this.profileStarts.delete(id));
      this.profileStarts.set(id, startPromise);
    } else if (log) {
      await log('profile start already in progress; waiting before RPA: ' + id);
    }

    const started = await startPromise;
    const entry = this.engine.running?.get?.(id) || started;
    if (!entry?.port) throw new Error('Profile started but has no CDP port: ' + id);
    return entry;
  }

  async executeStep(port, step, ctx) {
    port = ctx?.port || port;
    const type = String(step.type || step.action || '').toLowerCase();
    const rawParams = step.params && typeof step.params === 'object' ? step.params : step;
    const params = rawParams.config && typeof rawParams.config === 'object' ? rawParams.config : rawParams;
    const variables = ctx.variables || (ctx.variables = {});
    const value = (input) => getVariableValue(input, variables);
    const text = (input) => String(value(input) ?? '');

    // Action aliases (gotoUrl/clickElement/inputContent/waitTime/...)

    if (type === 'wait' || type === 'sleep' || type === 'delay' || type === 'waittime') {
      let ms = Number(params.ms ?? params.timeout ?? params.time ?? 1000);
      // timeoutType === "randomInterval" → random between timeoutMin/timeoutMax
      if (params.timeoutType === 'randomInterval' || params.timeoutType === 'random') {
        ms = randomBetween(params.timeoutMin ?? params.minMs ?? 300, params.timeoutMax ?? params.maxMs ?? 800);
      }
      await sleep(Math.max(0, Math.min(120000, ms || 1000)));
      return;
    }

    if (type === 'goto' || type === 'navigate' || type === 'open' || type === 'gotourl') {
      const url = text(params.url || params.href || 'about:blank');
      await cdp.navigate(port, url);
      return;
    }

    if (type === 'reload') {
      await cdp.reload(port);
      return;
    }

    if (type === 'newtab' || type === 'new_tab' || type === 'newpage') {
      await cdp.newTab(port, text(params.url || 'about:blank'));
      return;
    }

    if (type === 'closetab' || type === 'close_tab' || type === 'closepage') {
      const tab = await cdp.firstTab(port);
      if (tab) await cdp.closeTab(port, tab.id);
      return;
    }

    if (type === 'typetext' || type === 'type' || type === 'input' || type === 'inserttext' || type === 'inputcontent') {
      const inputText = text(params.text ?? params.value ?? params.content ?? (params.isRandom ? params.randomContent : ''));
      const clear = params.clear || params.isClear;
      const optional = isOptionalElementStep(params);
      if (clear && !params.selector) await cdp.clearFocused(port).catch(() => {});
      if (params.selector) {
        try {
          await this.withPage(port, async (ws) => {
            await this.focusSelector(ws, params.selector, params.selectorRadio);
            if (clear) {
              await cdp.call(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 65, modifiers: 2 });
              await cdp.call(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 65, modifiers: 2 });
              await cdp.call(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 8 });
              await cdp.call(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8 });
            }
            // intervals / human typing
            const human = params.human || params.intervals;
            if (human) {
              for (const ch of inputText) {
                await cdp.call(ws, 'Input.insertText', { text: ch });
                await sleep(randomBetween(params.minDelay || 30, params.maxDelay || 120));
              }
            } else {
              await cdp.call(ws, 'Input.insertText', { text: inputText });
            }
          });
        } catch (error) {
          if (optional && isMissingElementError(error)) {
            if (ctx?.log) await ctx.log('optional input skipped (not found): ' + params.selector);
            return;
          }
          throw error;
        }
      } else {
        await cdp.insertText(port, inputText);
      }
      return;
    }

    if (type === 'click' || type === 'clickelement') {
      const optional = isOptionalElementStep(params);
      await this.withPage(port, async (ws) => {
        if (params.selector) {
          const box = await this.boundingBox(ws, params.selector, params.selectorRadio);
          if (!box) {
            if (optional) {
              if (ctx?.log) await ctx.log('optional click skipped (not found): ' + params.selector);
              return;
            }
            throw new Error('Element not found: ' + params.selector);
          }
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          const button = params.button === 'right' ? 'right' : params.button === 'middle' ? 'middle' : 'left';
          const clickCount = params.type === 'dblclick' ? 2 : 1;
          await cdp.call(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          await cdp.call(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
          await cdp.call(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
        } else if (Number.isFinite(Number(params.x)) && Number.isFinite(Number(params.y))) {
          const x = Number(params.x);
          const y = Number(params.y);
          await cdp.call(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await cdp.call(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        } else {
          throw new Error('click requires selector or x/y');
        }
      });
      return;
    }

    if (type === 'selectelement') {
      const optional = isOptionalElementStep(params);
      const selector = text(params.selector || variables[params.element]?.selector);
      const selectedValue = text(params.value);
      if (!selector) {
        if (optional) {
          if (ctx?.log) await ctx.log('optional selectElement skipped (no selector)');
          return;
        }
        throw new Error('selectElement requires selector or a stored element');
      }
      try {
        await this.withPage(port, async (ws) => {
          const expression = this.elementExpression(selector, params.selectorRadio, `el => {
            if (!(el instanceof HTMLSelectElement)) return false;
            el.value = ${JSON.stringify(selectedValue)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return el.value === ${JSON.stringify(selectedValue)};
          }`);
          const result = await cdp.call(ws, 'Runtime.evaluate', { expression, returnByValue: true });
          if (result.result?.value !== true) throw new Error('selectElement failed: ' + selector);
        });
      } catch (error) {
        if (optional && isMissingElementError(error)) {
          if (ctx?.log) await ctx.log('optional selectElement skipped (not found): ' + selector);
          return;
        }
        throw error;
      }
      return;
    }

    if (type === 'waitforselector') {
      const timeout = Number(params.timeout) || 30000;
      const selector = String(params.selector || '');
      if (!selector) throw new Error('waitForSelector requires selector');
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (this.cancelled.has?.(null)) break;
        const found = await this.withPage(port, async (ws) => {
          try {
            await this.focusSelector(ws, selector, params.selectorRadio);
            return true;
          } catch (_) { return false; }
        });
        if (found) return;
        await sleep(200);
      }
      if (isOptionalElementStep(params)) return;
      throw new Error('waitForSelector timeout: ' + selector);
    }

    if (type === 'fortimes') {
      const times = Math.max(0, Math.min(1000, Number(value(params.times)) || 1));
      const children = Array.isArray(step.children) ? step.children : (Array.isArray(params.children) ? params.children : []);
      for (let i = 0; i < times; i += 1) {
        if (params.variableIndex) variables[params.variableIndex] = i;
        for (const child of children) await this.executeStep(port, child, ctx);
      }
      return;
    }

    if (type === 'combineprocess') {
      const children = Array.isArray(step.children) ? step.children : (Array.isArray(params.children) ? params.children : []);
      for (const child of children) await this.executeStep(port, child, ctx);
      return;
    }

    if (type === 'forlists') {
      const list = value(params.content);
      let items = Array.isArray(list) ? list : [];
      if (!items.length && typeof list === 'string') {
        try { items = JSON.parse(list); } catch (_) { items = list.split(/\r?\n/).filter(Boolean); }
      }
      if (!Array.isArray(items)) throw new Error('forLists requires an array variable: ' + String(params.content || ''));
      const children = Array.isArray(step.children) ? step.children : (Array.isArray(params.children) ? params.children : []);
      for (let index = 0; index < items.length; index += 1) {
        variables[params.variable || 'item'] = items[index];
        if (params.variableIndex) variables[params.variableIndex] = index;
        for (const child of children) await this.executeStep(port, child, ctx);
      }
      return;
    }

    if (type === 'ifelse' || type === 'whiledata') {
      const condition = this.evaluateCondition(params, variables);
      const children = Array.isArray(step.children) ? step.children : (Array.isArray(params.children) ? params.children : []);
      const elseChildren = Array.isArray(step.elseChildren) ? step.elseChildren : (Array.isArray(params.elseChildren) ? params.elseChildren : []);
      if (type === 'ifelse' && !condition) {
        for (const child of elseChildren) await this.executeStep(port, child, ctx);
        return;
      }
      const max = type === 'whiledata' ? 100 : 1;
      for (let count = 0; count < max && (type === 'ifelse' || this.evaluateCondition(params, variables)); count += 1) {
        for (const child of children) await this.executeStep(port, child, ctx);
      }
      return;
    }

    if (type === 'getelement' || type === 'passingelement' || type === 'focuselement') {
      const optional = isOptionalElementStep(params);
      const selector = text(params.selector || (params.selectorType === 'element' ? variables[params.element]?.selector : ''));
      const referenced = params.element && variables[params.element];
      if (!selector && !referenced) {
        if (optional) {
          if (ctx?.log) await ctx.log(`optional ${type} skipped (no selector)`);
          return;
        }
        throw new Error(`${type} requires selector or a stored element`);
      }
      if (type === 'focuselement') {
        try {
          await this.withPage(port, (ws) => this.focusSelector(ws, selector || referenced.selector, params.selectorRadio));
        } catch (error) {
          if (optional && isMissingElementError(error)) {
            if (ctx?.log) await ctx.log('optional focus skipped: ' + (selector || referenced.selector));
            return;
          }
          throw error;
        }
        return;
      }
      const result = await this.withPage(port, async (ws) => this.readElement(ws, selector || referenced.selector, params));
      if (result == null) {
        if (optional) {
          if (ctx?.log) await ctx.log('optional getElement skipped (not found): ' + (selector || referenced.selector));
          if (params.variable) variables[params.variable] = null;
          return;
        }
        throw new Error('Element not found: ' + (selector || referenced.selector));
      }
      if (params.variable) variables[params.variable] = result;
      return;
    }

    if (type === 'forelements') {
      const selector = text(params.selector);
      if (!selector) throw new Error('forElements requires selector');
      const elements = await this.withPage(port, (ws) => this.listElements(ws, selector, params));
      const children = Array.isArray(step.children) ? step.children : (Array.isArray(params.children) ? params.children : []);
      for (let index = 0; index < elements.length; index += 1) {
        variables[params.variable || 'element'] = elements[index];
        if (params.variableIndex) variables[params.variableIndex] = index;
        for (const child of children) await this.executeStep(port, child, ctx);
      }
      return;
    }

    if (type === 'tojson' || type === 'extractkey' || type === 'extractdata') {
      const source = value(params.content);
      let result = source;
      if (type === 'tojson') {
        try { result = typeof source === 'string' ? JSON.parse(source) : source; } catch (error) { throw new Error('toJson failed: ' + error.message); }
      } else if (type === 'extractkey') {
        const object = typeof source === 'string' ? JSON.parse(source) : source;
        result = params.key ? String(params.key).split('.').reduce((item, key) => item?.[key], object) : object;
      } else {
        const sourceText = String(source ?? '');
        const match = new RegExp(String(params.reg || ''), params.notUpper ? '' : 'i').exec(sourceText);
        result = match ? (params.onlyGetFirst ? match[1] || match[0] : match[0]) : '';
      }
      if (params.variable) variables[params.variable] = result;
      return;
    }

    if (type === 'savedata') {
      const filename = this.outputPath(text(params.name || 'data'), '.txt');
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.appendFile(filename, text(params.template ?? params.content ?? '') + '\n', 'utf8');
      if (ctx?.log) await ctx.log('saved data: ' + filename);
      return;
    }

    if (type === 'exportexcel') {
      const records = this.exportRecords(params, variables);
      const fields = Array.isArray(params.fields) && params.fields.length
        ? params.fields.map(String)
        : [...new Set(records.flatMap((record) => Object.keys(record || {})))];
      const csv = [fields, ...records.map((record) => fields.map((field) => record?.[field] ?? ''))]
        .map((row) => row.map((cell) => this.csvCell(cell)).join(','))
        .join('\n') + '\n';
      const filename = this.outputPath(text(params.name || 'export'), '.csv');
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, csv, 'utf8');
      if (ctx?.log) await ctx.log('exported CSV: ' + filename);
      return;
    }

    if (type === 'saveremark') {
      const remark = text(params.content ?? params.remark ?? '');
      ctx.remarks.push(remark);
      if (ctx?.log) await ctx.log('remark: ' + remark);
      return;
    }

    if (type === 'variableoperation') {
      const fields = Array.isArray(params.fields) ? params.fields.map(String) : [];
      if (String(params.type || '').toLowerCase() === 'export') {
        variables.__exported = Object.fromEntries(fields.map((field) => [field, variables[field]]));
      }
      return;
    }

    if (type === 'useexcel') {
      const targetVar = params.variable || 'data';
      const skippable = (
        params.isSkip === true
        || params.isSkip === 1
        || params.isSkip === '1'
        || params.isSkip === 'true'
        || params.optional === true
        || params.optional === '1'
        || params.optional === 'true'
      );
      let filePath = text(
        params.path
        ?? params.filePath
        ?? params.file
        ?? params.dataExcelPath
        ?? params.excelPath
        ?? params.content
      ).trim();
      // Unresolved ${var} placeholders mean the user has not configured a spreadsheet yet.
      if (!filePath || /\$\{[^}]+\}/.test(filePath)) {
        if (!skippable) {
          throw new Error(
            filePath
              ? 'useExcel path is unresolved (' + filePath + '); set the template variable to a local CSV/JSON file'
              : 'useExcel requires a CSV or JSON file path'
          );
        }
        variables[targetVar] = [];
        if (ctx?.log) {
          await ctx.log('useExcel skipped: no spreadsheet path configured (set a CSV/JSON path in template variables)');
        }
        return;
      }

      let safePath;
      try {
        safePath = await this.resolveSpreadsheetPath(filePath);
      } catch (error) {
        if (skippable) {
          variables[targetVar] = [];
          if (ctx?.log) await ctx.log('useExcel skipped: ' + error.message);
          return;
        }
        throw error;
      }

      const extension = path.extname(safePath).toLowerCase();
      if (extension === '.xlsx' || extension === '.xls') {
        const message = 'useExcel does not read .xlsx/.xls yet; convert to .csv or .json and set the path variable';
        if (skippable) {
          variables[targetVar] = [];
          if (ctx?.log) await ctx.log('useExcel skipped: ' + message);
          return;
        }
        throw new Error(message);
      }
      if (extension !== '.csv' && extension !== '.json') {
        const message = 'useExcel currently accepts .csv or .json (got ' + extension + ')';
        if (skippable) {
          variables[targetVar] = [];
          if (ctx?.log) await ctx.log('useExcel skipped: ' + message);
          return;
        }
        throw new Error(message);
      }

      let raw;
      try {
        raw = await fs.readFile(safePath, 'utf8');
      } catch (error) {
        if (skippable) {
          variables[targetVar] = [];
          if (ctx?.log) await ctx.log('useExcel skipped: cannot read file ' + safePath);
          return;
        }
        throw new Error('useExcel cannot read file: ' + safePath);
      }

      let records;
      if (extension === '.json') {
        records = JSON.parse(raw);
      } else {
        const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
        if (!lines.length) {
          variables[targetVar] = [];
          return;
        }
        const headers = lines[0].split(',').map((item) => item.trim());
        records = lines.slice(1).map((row) => Object.fromEntries(
          row.split(',').map((item, index) => [headers[index] || ('col' + index), item.trim()])
        ));
      }
      if (!Array.isArray(records)) throw new Error('useExcel JSON content must be an array');
      variables[targetVar] = records;
      if (ctx?.log) await ctx.log(`useExcel loaded ${records.length} row(s) from ${safePath}`);
      return;
    }

    if (type === 'importtext') {
      const filePath = text(params.path || params.filePath || params.file);
      if (!filePath) throw new Error('importText requires a file path');
      const resolved = resolveSafeRpaPath(filePath);
      const raw = await fs.readFile(resolved, 'utf8');
      const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
      variables[params.variable || 'textLines'] = lines;
      return;
    }

    if (type === 'randomget') {
      const source = getVariableValue(params.variable || params.list || params.content, variables);
      const list = Array.isArray(source)
        ? source
        : String(source == null ? '' : source).split(/\r?\n/).filter((item) => item.length > 0);
      if (!list.length) {
        variables[params.saveVariable || params.target || 'randomItem'] = '';
        return;
      }
      const pick = list[Math.floor(Math.random() * list.length)];
      variables[params.saveVariable || params.target || params.variable || 'randomItem'] = pick;
      return;
    }

    if (type === 'get2facode') {
      // Best-effort: read a pre-supplied code from variables or params.
      const code = text(params.code || params.content || variables[params.variable || 'otp'] || '');
      variables[params.saveVariable || params.variable || 'otpCode'] = code;
      if (!code && ctx?.log) await ctx.log('get2faCode: no code provided in variables/params');
      return;
    }

    if (type === 'googlesheet') {
      // Offline-safe stub: accept preloaded sheet data from variables.
      const sheet = variables[params.variable || 'sheetData'];
      if (sheet == null) {
        if (ctx?.log) await ctx.log('googleSheet: no local sheetData variable; skipped remote Google API');
        variables[params.saveVariable || params.variable || 'sheetData'] = [];
      }
      return;
    }

    if (type === 'getcookies') {
      const cookies = await this.withPage(port, (ws) => cdp.call(ws, 'Network.getCookies', {}));
      variables[params.variable || 'cookies'] = cookies?.cookies || cookies || [];
      return;
    }

    if (type === 'getclipboard' || type === 'getactiveelement') {
      variables[params.variable || type] = variables[params.variable || type] || '';
      return;
    }

    if (type === 'keycombination' || type === 'applysubprocess' || type === 'getcaptcha' || type === 'closeotherpage') {
      if (ctx?.log) await ctx.log(`${type}: best-effort no-op in current runtime`);
      return;
    }

    if (type === 'goback') {
      await this.withPage(port, (ws) => cdp.call(ws, 'Runtime.evaluate', {
        expression: 'history.back(); true', returnByValue: true,
      }));
      await sleep(Math.max(0, Math.min(30000, Number(params.timeout) || 500)));
      return;
    }

    if (type === 'switchpage') {
      const expected = text(params.content || params.url || '');
      const relation = String(params.relation || 'contain').toLowerCase();
      const tabs = await cdp.tabs(port);
      const tab = tabs.find((candidate) => {
        const haystack = `${candidate.url || ''} ${candidate.title || ''}`;
        return relation === 'equal' ? haystack === expected : haystack.includes(expected);
      });
      if (!tab) throw new Error('switchPage target not found: ' + expected);
      await cdp.activateTab(port, tab.id);
      return;
    }

    if (type === 'uploadattachment') {
      const selector = text(params.selector);
      const filePath = text(params.url || params.path);
      if (!selector || !filePath) throw new Error('uploadAttachment requires selector and local file path');
      const safePath = resolveSafeRpaPath(filePath);
      await fs.access(safePath);
      if (String(params.selectorRadio || 'CSS').toUpperCase().startsWith('X')) {
        throw new Error('uploadAttachment currently requires a CSS selector');
      }
      await this.withPage(port, async (ws) => {
        const document = await cdp.call(ws, 'DOM.getDocument', { depth: 1 });
        const node = await cdp.call(ws, 'DOM.querySelector', { nodeId: document.root.nodeId, selector });
        if (!node.nodeId) throw new Error('uploadAttachment selector not found: ' + selector);
        await cdp.call(ws, 'DOM.setFileInputFiles', { nodeId: node.nodeId, files: [safePath] });
      });
      return;
    }

    if (type === 'downloadfile') {
      const url = text(params.url);
      if (!url) throw new Error('downloadFile requires url');
      const target = this.outputPath(text(params.path || 'downloads'), path.extname(new URL(url, 'https://localhost').pathname) || '.bin');
      const payload = await this.withPage(port, async (ws) => {
        const expression = `(async () => { const response = await fetch(${JSON.stringify(url)}, { credentials: 'include' }); if (!response.ok) throw new Error('HTTP ' + response.status); const bytes = new Uint8Array(await response.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); })()`;
        const result = await cdp.call(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 60000);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'downloadFile failed');
        return result.result?.value;
      });
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(String(payload || ''), 'base64'));
      return;
    }

    if (type === 'getrequest' || type === 'waitforresponse' || type === 'getresponse' || type === 'stoplinsten') {
      if (type === 'stoplinsten') return;
      const matcher = text(params.url || '');
      const timeout = Math.max(0, Math.min(120000, Number(params.timeout) || 30000));
      const resource = await this.findNetworkResource(port, matcher, timeout);
      if (type === 'waitforresponse') return;
      if (type === 'getrequest') {
        const requestUrl = resource.name;
        const key = text(params.key || '');
        let result = requestUrl;
        if (String(params.type).toLowerCase() === 'getparams' && key) result = new URL(requestUrl).searchParams.get(key) || '';
        if (params.variable) variables[params.variable] = result;
        return;
      }
      const body = await this.withPage(port, async (ws) => {
        const expression = `(async () => { const response = await fetch(${JSON.stringify(resource.name)}, { credentials: 'include' }); return await response.text(); })()`;
        const result = await cdp.call(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 30000);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'getResponse failed');
        return result.result?.value || '';
      });
      if (params.variable) variables[params.variable] = body;
      return;
    }

    if (type === 'getopenai') {
      const apiKey = text(params.apiKey);
      if (!apiKey) throw new Error('getOpenAI requires an apiKey variable');
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: text(params.type || 'gpt-4o-mini'), messages: [{ role: 'user', content: text(params.prompt) }], max_tokens: Number(params.token) || 4096 }),
      });
      if (!response.ok) throw new Error(`getOpenAI request failed: HTTP ${response.status}`);
      const responseBody = await response.json();
      if (params.variable) variables[params.variable] = responseBody.choices?.[0]?.message?.content || '';
      return;
    }

    if (type === 'javascript' || type === 'evaluate' || type === 'script' || type === 'js') {
      // handled below with evaluate
    }

    if (type === 'scroll' || type === 'scrollpage') {
      await this.withPage(port, async (ws) => {
        const deltaX = Number(params.deltaX || 0);
        const deltaY = Number(params.deltaY ?? params.y ?? 400);
        await cdp.call(ws, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Number(params.x || 200),
          y: Number(params.y || 200),
          deltaX,
          deltaY,
        });
      });
      return;
    }

    if (type === 'evaluate' || type === 'script' || type === 'js' || type === 'javascript') {
      const expression = text(params.expression || params.code || params.script || params.content || '');
      if (!expression) throw new Error('evaluate requires expression');
      await this.withPage(port, async (ws) => {
        const names = Array.isArray(params.params) ? params.params.map(String) : [];
        const values = names.map((name) => variables[name]);
        const wrapped = names.length
          ? `(() => { const fn = new Function(...${JSON.stringify(names)}, ${JSON.stringify(expression)}); return fn(...${JSON.stringify(values)}); })()`
          : expression;
        const result = await cdp.call(ws, 'Runtime.evaluate', {
          expression: wrapped,
          returnByValue: true,
          awaitPromise: true,
        }, 30000);
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.text || 'evaluate failed');
        }
        const resultValue = result.result?.value;
        if (params.variable) variables[params.variable] = resultValue;
        if (ctx?.log) await ctx.log('evaluate result: ' + JSON.stringify(resultValue));
      });
      return;
    }

    if (type === 'refreshpage' || type === 'reload') {
      await cdp.reload(port);
      return;
    }

    if (type === 'screenshotpage' || type === 'screenshot') {
      await this.withPage(port, async (ws) => {
        const shot = await cdp.call(ws, 'Page.captureScreenshot', { format: 'png' }, 15000);
        if (ctx?.log) await ctx.log('screenshot bytes(base64 length)=' + String(shot.data || '').length);
      });
      return;
    }

    if (type === 'geturl') {
      await this.withPage(port, async (ws) => {
        const result = await cdp.call(ws, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true });
        if (params.variable) variables[params.variable] = result.result?.value || '';
        if (ctx?.log) await ctx.log('getUrl=' + result.result?.value);
      });
      return;
    }

    if (type === 'clearcookies') {
      await this.withPage(port, async (ws) => {
        await cdp.call(ws, 'Network.enable', {});
        await cdp.call(ws, 'Network.clearBrowserCookies', {});
      });
      return;
    }

    if (type === 'closebrowser') {
      if (typeof this.engine?.stop !== 'function') throw new Error('closeBrowser is unavailable: browser engine cannot stop profiles');
      await this.engine.stop(ctx.activeProfileId || ctx.task.profile_id);
      return;
    }

    if (type === 'opennewbrowser') {
      if (!(this.engine?.profiles instanceof Map) || typeof this.engine?.start !== 'function') {
        throw new Error('openNewBrowser is unavailable: local profile management is not configured');
      }
      const requestedNumber = Number(String(text(params.accounts || params.account || '')).split(/[\s,;]+/)[0]);
      if (!Number.isInteger(requestedNumber) || requestedNumber < 1) {
        throw new Error('openNewBrowser requires a local environment number in accounts');
      }
      const profile = [...this.engine.profiles.values()].find((item) => Number(item.number) === requestedNumber);
      if (!profile) throw new Error('openNewBrowser local environment not found: ' + requestedNumber);
      const started = await this.engine.start(profile);
      if (!started?.port) throw new Error('openNewBrowser did not return a CDP port');
      ctx.port = started.port;
      ctx.activeProfileId = profile.id;
      variables.openedBrowserProfileId = profile.id;
      return;
    }

    if (type === 'startnode' || type === 'noop' || type === 'breakloop') return;

    if (type === 'key' || type === 'press' || type === 'keyboard') {
      await this.withPage(port, async (ws) => {
        const key = text(params.key || params.type || 'Enter');
        await cdp.call(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key });
        await cdp.call(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key });
      });
      return;
    }

    if (!type) return;
    throw new Error('Unsupported RPA step type: ' + type);
  }

  initialVariables(task) {
    const variables = {};
    // Explicit plan/task variables win first (installed templates may store these without process_content).
    const explicit = task?.variables || task?.global_variables || task?.globalVariable || {};
    if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) {
      for (const [key, value] of Object.entries(explicit)) {
        if (key) variables[String(key)] = value ?? '';
      }
    }
    let process = task.process_content;
    if (typeof process === 'string') {
      try { process = JSON.parse(process); } catch (_) { process = null; }
    }
    const start = process?.nodes?.find((node) => node.type === 'startNode');
    const definitions = start?.globalVariable || start?.config?.variableObjList || [];
    for (const item of definitions) {
      if (item?.key && !(String(item.key) in variables)) {
        variables[String(item.key)] = item.value ?? '';
      }
    }
    return variables;
  }

  /**
   * Resolve spreadsheet paths for useExcel.
   * Allows RPA output dir plus common user folders (Desktop/Documents/Downloads/home),
   * because catalog templates expect user-picked absolute paths.
   */
  async resolveSpreadsheetPath(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) throw new Error('useExcel requires a CSV or JSON file path');
    if (raw.includes('\0')) throw new Error('invalid file path');

    const home = os.homedir();
    const candidates = [];
    if (path.isAbsolute(raw)) {
      candidates.push(path.resolve(raw));
    } else {
      candidates.push(path.resolve(OUTPUT_DIRECTORY, raw));
      candidates.push(path.resolve(home, raw));
      candidates.push(path.resolve(home, 'Desktop', raw));
      candidates.push(path.resolve(home, 'Documents', raw));
      candidates.push(path.resolve(home, 'Downloads', raw));
      if (process.platform === 'win32') {
        const userProfile = process.env.USERPROFILE || home;
        candidates.push(path.resolve(userProfile, 'Desktop', raw));
        candidates.push(path.resolve(userProfile, 'Documents', raw));
        candidates.push(path.resolve(userProfile, 'Downloads', raw));
      }
    }

    const allowedRoots = [
      OUTPUT_DIRECTORY,
      home,
      path.join(home, 'Desktop'),
      path.join(home, 'Documents'),
      path.join(home, 'Downloads'),
    ];
    if (process.platform === 'win32') {
      const userProfile = process.env.USERPROFILE || home;
      allowedRoots.push(userProfile, path.join(userProfile, 'Desktop'), path.join(userProfile, 'Documents'), path.join(userProfile, 'Downloads'));
    }

    let lastError = null;
    for (const candidate of candidates) {
      const okRoot = allowedRoots.some((root) => isPathInsideRoot(candidate, root));
      if (!okRoot) {
        lastError = new Error('useExcel path is outside allowed folders (home/Desktop/Documents/Downloads/rpa-output)');
        continue;
      }
      try {
        await fs.access(candidate);
        return candidate;
      } catch (error) {
        lastError = new Error('useExcel file not found: ' + candidate);
      }
    }
    throw lastError || new Error('useExcel requires a CSV or JSON file path');
  }

  evaluateCondition(params, variables) {
    const conditions = Array.isArray(params.condition) ? params.condition : [params.condition];
    const values = conditions.filter((item) => item != null && item !== '').map((item) => valueOf(item, variables));
    const actual = values.length <= 1 ? values[0] : values;
    const expected = valueOf(params.result, variables);
    const relation = String(params.relation || 'exist').toLowerCase();
    if (relation === 'exist') return Array.isArray(actual) ? actual.every(Boolean) : Boolean(actual);
    if (relation === 'notexist') return Array.isArray(actual) ? actual.every((item) => !item) : !actual;
    if (relation === 'contain') return String(actual ?? '').includes(String(expected ?? ''));
    if (relation === 'equal') return String(actual ?? '') === String(expected ?? '');
    if (relation === 'notequal') return String(actual ?? '') !== String(expected ?? '');
    if (relation === 'less') return Number(actual) < Number(expected);
    if (relation === 'lessequal') return Number(actual) <= Number(expected);
    if (relation === 'more') return Number(actual) > Number(expected);
    if (relation === 'moreequal') return Number(actual) >= Number(expected);
    return Boolean(actual);
  }

  async readElement(ws, selector, params) {
    const elementType = String(params.type || 'object');
    const key = String(params.key || '');
    const expression = this.elementExpression(selector, params.selectorRadio, `el => {
      if (${JSON.stringify(elementType)} === 'object') return { selector: ${JSON.stringify(selector)} };
      if (${JSON.stringify(elementType)} === 'attribute') return el.getAttribute(${JSON.stringify(key)}) || '';
      if (${JSON.stringify(elementType)} === 'innerText') return el.innerText || el.textContent || '';
      if (${JSON.stringify(elementType)} === 'innerHTML') return el.innerHTML || '';
      if (${JSON.stringify(elementType)} === 'value') return el.value || '';
      if (${JSON.stringify(elementType)} === 'childrenNode') { const child = el.querySelector(${JSON.stringify(key)}); return child ? { selector: ${JSON.stringify(selector)} + ' ' + ${JSON.stringify(key)} } : null; }
      return { selector: ${JSON.stringify(selector)} };
    }`);
    const result = await cdp.call(ws, 'Runtime.evaluate', { expression, returnByValue: true });
    return result.result?.value ?? null;
  }

  async listElements(ws, selector, params) {
    const elementType = String(params.type || 'object');
    const key = String(params.key || '');
    const expression = this.elementExpression(selector, params.selectorRadio, `el => {
      if (${JSON.stringify(elementType)} === 'attribute') return el.getAttribute(${JSON.stringify(key)}) || '';
      if (${JSON.stringify(elementType)} === 'innerText') return el.innerText || el.textContent || '';
      return { selector: ${JSON.stringify(selector)} };
    }`, true);
    const result = await cdp.call(ws, 'Runtime.evaluate', { expression, returnByValue: true });
    return Array.isArray(result.result?.value) ? result.result.value : [];
  }

  elementExpression(selector, selectorRadio, mapper, multiple = false) {
    const finder = String(selectorRadio || 'CSS').toUpperCase().startsWith('X')
      ? `Array.from(document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null), (_, i) => document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotItem(i))`
      : `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`;
    return `(() => { const nodes = ${finder}; const map = ${mapper}; const values = nodes.map(map).filter((item) => item != null); return ${multiple ? 'values' : 'values[0] ?? null'}; })()`;
  }

  outputPath(name, extension) {
    const raw = String(name || 'output').replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+$/, 'output');
    const suffix = path.extname(raw) ? '' : extension;
    return path.join(OUTPUT_DIRECTORY, raw + suffix);
  }

  csvCell(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return `"${String(text).replace(/"/g, '""')}"`;
  }

  exportRecords(params, variables) {
    const candidate = getVariableValue(params.data || params.content || params.variable || '', variables);
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') return [candidate];
    const list = Object.values(variables).find(Array.isArray);
    return Array.isArray(list) ? list : [];
  }

  async findNetworkResource(port, matcher, timeout) {
    const deadline = Date.now() + timeout;
    do {
      const resources = await this.withPage(port, async (ws) => {
        const result = await cdp.call(ws, 'Runtime.evaluate', {
          expression: 'performance.getEntriesByType("resource").map((entry) => ({ name: entry.name, initiatorType: entry.initiatorType }))',
          returnByValue: true,
        });
        return result.result?.value || [];
      });
      const resource = resources.slice().reverse().find((entry) => !matcher || String(entry.name).includes(matcher));
      if (resource) return resource;
      if (!timeout) break;
      await sleep(250);
    } while (Date.now() < deadline);
    throw new Error('network resource not found: ' + matcher);
  }

  async withPage(port, fn) {
    const tab = await cdp.firstTab(port);
    if (!tab?.webSocketDebuggerUrl) throw new Error('No page tab for CDP port ' + port);
    return fn(tab.webSocketDebuggerUrl);
  }

  async focusSelector(ws, selector, selectorRadio = 'CSS') {
    const mode = String(selectorRadio || 'CSS').toUpperCase();
    const expression = mode === 'XPATH' || mode === 'XP'
      ? `(() => { const r = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); const el = r.singleNodeValue; if (!el) return false; el.focus?.(); el.scrollIntoView?.({block:'center', inline:'center'}); return true; })()`
      : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); el.scrollIntoView({block:'center', inline:'center'}); return true; })()`;
    const result = await cdp.call(ws, 'Runtime.evaluate', { expression, returnByValue: true });
    if (result.result?.value !== true) throw new Error('Selector not found: ' + selector);
  }

  async boundingBox(ws, selector, selectorRadio = 'CSS') {
    const mode = String(selectorRadio || 'CSS').toUpperCase();
    const expression = mode === 'XPATH' || mode === 'XP'
      ? `(() => { const r = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); const el = r.singleNodeValue; if (!el || !el.getBoundingClientRect) return null; el.scrollIntoView?.({block:'center', inline:'center'}); const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`
      : `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({block:'center', inline:'center'});
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`;
    const result = await cdp.call(ws, 'Runtime.evaluate', { expression, returnByValue: true });
    return result.result?.value || null;
  }
}

function valueOf(input, variables) {
  return getVariableValue(input, variables);
}

module.exports = { RpaEngine, RPA_PLUS_ACTIONS, parseProcessContent, findUnsupportedSteps };
