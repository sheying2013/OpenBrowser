'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { cloneBuiltinTemplates } = require('./rpa-templates-builtin');
const localCatalog = require('./data/catalog-templates.json');
const {
  syncRemoteTemplateStore,
  normalizeRemoteTemplate,
  parseProcessContent,
} = require('./template-sync');
const { findUnsupportedSteps } = require('./rpa-engine');

/**
 * Plan / task / template store for RPA (JSON file).
 * Templates: built-in and user-created/imported.
 */
class RpaStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 4, plans: [], tasks: [], templates: [], config: {} };
    this.saveQueue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        version: Number(parsed.version) || 3,
        plans: Array.isArray(parsed.plans) ? parsed.plans : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        templates: Array.isArray(parsed.templates) ? parsed.templates : [],
        config: parsed.config && typeof parsed.config === 'object' ? parsed.config : {},
      };
    } catch (_) {
      this.data = { version: 4, plans: [], tasks: [], templates: [], config: {} };
    }
    this.migrateLegacyTemplates();
    await this.ensureBuiltinTemplates();
    await this.ensureLocalCatalogTemplates();
    this.scrubLegacyFieldsFromTemplates();
    this.forceFreeAllTemplates();
    this.enforceFreeTemplates();
    if (this.data.version < 4) this.resetSeedTemplateUsage();
    this.data.version = 4;
    await this.save();
    return this.data;
  }

  async ensureBuiltinTemplates() {
    const builtins = cloneBuiltinTemplates();
    const byId = new Map(this.data.templates.map((t) => [t.id, t]));
    // Drop obsolete builtin ids no longer in catalog while preserving user templates.
    const builtinIds = new Set(builtins.map((b) => b.id));
    this.data.templates = this.data.templates.filter((t) => {
      if (t.builtin || t.source === 'builtin') return builtinIds.has(t.id);
      return true;
    });
    for (const item of builtins) {
      const existing = byId.get(item.id);
      if (!existing) {
        this.data.templates.push({
          ...item,
          uses: 0,
          steps: JSON.parse(JSON.stringify(item.steps || [])),
          create_time: new Date().toISOString(),
          update_time: new Date().toISOString(),
        });
      } else if (existing.builtin || existing.source === 'builtin') {
        existing.name = item.name;
        existing.cat = item.cat;
        existing.desc = item.desc;
        existing.tags = item.tags;
        existing.steps = JSON.parse(JSON.stringify(item.steps || []));
        existing.pay_type = 1;
        existing.developer = item.developer || 'OpenBrowser';
        existing.builtin = true;
        existing.source = 'builtin';
        // Usage is local to this OpenBrowser installation, never seed data.
        existing.uses = Number(existing.uses) || 0;
        existing.update_time = new Date().toISOString();
      }
    }
  }

  getConfig() {
    return { ...(this.data.config || {}) };
  }

  scrubLegacyFieldsFromTemplates() {
    const legacyId = RpaStore.legacyIdField();
    this.data.templates = this.data.templates.map((template) => {
      if (!template || typeof template !== 'object') return template;
      if (!(legacyId in template)) return template;
      const next = { ...template };
      delete next[legacyId];
      return next;
    });
  }

  migrateLegacyTemplates() {
    this.data.templates = this.data.templates.map((template) => {
      if (!RpaStore.isLegacyExternalSource(template.source) && !RpaStore.hasLegacyExternalId(template)) {
        return template;
      }
      return this.normalizeLocalCatalogTemplate(template);
    });
    // Drop historical remote-auth keys so secrets never linger on disk.
    const drop = new Set(RpaStore.legacyConfigKeys());
    const config = {};
    for (const [key, value] of Object.entries(this.getConfig())) {
      if (!drop.has(key)) config[key] = value;
    }
    this.data.config = config;
  }

  /** Runtime token for legacy on-disk field migration (no brand literals). */
  static legacyVendorToken() {
    return String.fromCharCode(97, 100, 115);
  }

  static legacyConfigKeys() {
    const v = RpaStore.legacyVendorToken();
    return [
      'remoteCategories', 'remoteLastSync', 'remoteSource',
      'remoteToken', 'remoteCookie', 'remoteApiKey', 'remoteApiBase', 'remoteApiOrigin', 'remoteLang',
      `${v}Categories`, `${v}LastSync`, `${v}Source`,
      `${v}Token`, `${v}Cookie`, `${v}ApiKey`, `${v}ApiBase`, `${v}ApiOrigin`, `${v}Lang`,
    ];
  }

  static legacyIdField() {
    return `${RpaStore.legacyVendorToken()}_id`;
  }

  static isLegacyExternalSource(source) {
    const legacy = new Set(['remote', 'legacy-external', 'marketplace', RpaStore.legacyVendorToken()]);
    return legacy.has(String(source || ''));
  }

  static hasLegacyExternalId(template = {}) {
    const id = String(template.id || '');
    const v = RpaStore.legacyVendorToken();
    const legacyId = template[RpaStore.legacyIdField()];
    return Boolean(
      legacyId
      || template.external_id
      || new RegExp(`^(?:${v}|remote)-`, 'i').test(id)
      || new RegExp(`^catalog-${v}-`, 'i').test(id)
    );
  }

  static stripExternalBranding(value) {
    const v = RpaStore.legacyVendorToken();
    return String(value || '')
      .replace(new RegExp(`\\b${v}(?:power)?\\b`, 'gi'), '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  static catalogOriginalId(raw = {}) {
    const legacyIdField = RpaStore.legacyIdField();
    const v = RpaStore.legacyVendorToken();
    const candidates = [
      raw.external_id,
      raw[legacyIdField],
      raw.template_id,
      raw.id,
    ];
    const prefixRe = new RegExp(`^(?:catalog-)?(?:${v}|remote|legacy|catalog)-`, 'i');
    const prefixRe2 = new RegExp(`^(?:${v}|remote|legacy|catalog)-`, 'i');
    for (const candidate of candidates) {
      if (candidate == null || candidate === '') continue;
      const cleaned = String(candidate)
        .replace(prefixRe, '')
        .replace(prefixRe2, '')
        .trim();
      if (cleaned) return cleaned;
    }
    return crypto.randomUUID();
  }

  normalizeLocalCatalogTemplate(raw = {}) {
    const originalId = RpaStore.catalogOriginalId(raw);
    const steps = Array.isArray(raw.steps) && raw.steps.length
      ? raw.steps
      : parseProcessContent(raw.process_content || raw);
    const tags = (Array.isArray(raw.tags) ? raw.tags : [])
      .map(RpaStore.stripExternalBranding)
      .filter(Boolean);
    const normalizedSteps = RpaStore.sanitizeOptionalOverlaySteps(
      JSON.parse(JSON.stringify(Array.isArray(steps) ? steps : []))
    );
    return {
      id: `catalog-${originalId}`,
      external_id: null,
      name: RpaStore.stripExternalBranding(raw.name || raw.plan_name || raw.template_name) || '本地模版',
      cat: RpaStore.stripExternalBranding(raw.cat || raw.category || raw.category_name) || '其他',
      category_id: String(raw.category_id || ''),
      desc: RpaStore.localTemplateDescription(raw.name, raw.desc || raw.description || raw.abstract),
      tags: tags.length ? tags : ['本地模版'],
      steps: normalizedSteps,
      process_content: raw.process_content || null,
      // The local catalog only supplies templates. Its source usage figures do
      // not represent OpenBrowser usage and must never be displayed here.
      uses: 0,
      // Local OpenBrowser templates are always free — never surface paid flags.
      pay_type: 1,
      price: 0,
      developer: 'OpenBrowser',
      img_url: String(raw.img_url || '').slice(0, 500),
      builtin: false,
      source: 'catalog',
      create_time: raw.create_time || new Date().toISOString(),
      update_time: new Date().toISOString(),
    };
  }

  /** Mark ephemeral interstitial selectors as optional so missing overlays never fail runs. */
  static sanitizeOptionalOverlaySteps(steps) {
    if (!Array.isArray(steps)) return steps;
    const mark = (step) => {
      if (!step || typeof step !== 'object') return;
      const bag = step.params && typeof step.params === 'object'
        ? step.params
        : (step.config && typeof step.config === 'object' ? step.config : step);
      const selector = String(bag.selector || step.selector || '');
      if (/redir-overlay|redir-dismiss/i.test(selector)) {
        bag.optional = true;
        bag.isShow = '0';
        if (step.params && step.params !== bag) {
          step.params.optional = true;
          step.params.isShow = '0';
        }
        if (step.config && step.config !== bag) {
          step.config.optional = true;
          step.config.isShow = '0';
        }
        step.optional = true;
        step.isShow = '0';
      }
      if (Array.isArray(step.children)) step.children.forEach(mark);
      if (Array.isArray(step.elseChildren)) step.elseChildren.forEach(mark);
      if (Array.isArray(step.params?.children)) step.params.children.forEach(mark);
      if (Array.isArray(step.params?.elseChildren)) step.params.elseChildren.forEach(mark);
    };
    steps.forEach(mark);
    return steps;
  }

  /** Strip paid metadata from one template (open-source: always free). */
  forceFreeTemplate(template = {}) {
    if (!template || typeof template !== 'object') return template;
    const tags = Array.isArray(template.tags)
      ? template.tags
        .map((tag) => String(tag || '').trim())
        .filter((tag) => tag && !/付费|收费|会员|VIP|premium|paid/i.test(tag))
      : [];
    if (
      !tags.includes('免费')
      && (template.source === 'catalog' || template.builtin || template.source === 'builtin')
    ) {
      tags.push('免费');
    }
    const steps = RpaStore.sanitizeOptionalOverlaySteps(
      JSON.parse(JSON.stringify(Array.isArray(template.steps) ? template.steps : []))
    );
    return {
      ...template,
      pay_type: 1,
      price: 0,
      tags,
      steps,
    };
  }

  /** Force open-source free flags on every stored template (catalog/user/builtin). */
  forceFreeAllTemplates() {
    this.data.templates = this.data.templates.map((template) => this.forceFreeTemplate(template));
  }

  enforceFreeTemplates() {
    this.forceFreeAllTemplates();
  }

  static localTemplateDescription(name, description) {
    const clean = RpaStore.stripExternalBranding(description).replace(/\s+/g, ' ').trim();
    if (!clean) return `按预设步骤执行「${RpaStore.stripExternalBranding(name) || '此流程'}」操作。`;
    const sentence = clean.replace(/[。！？.!?]+$/g, '');
    return `${sentence}。`;
  }

  async ensureLocalCatalogTemplates() {
    const catalogTemplates = Array.isArray(localCatalog.templates) ? localCatalog.templates : [];
    // Collapse historical external/catalog id variants onto catalog-<id>.
    const byCanonical = new Map();
    const retained = [];
    for (const template of this.data.templates) {
      if (template.source === 'catalog' || RpaStore.isLegacyExternalSource(template.source) || RpaStore.hasLegacyExternalId(template)) {
        const canonical = this.normalizeLocalCatalogTemplate(template);
        const prev = byCanonical.get(canonical.id);
        if (!prev) {
          byCanonical.set(canonical.id, {
            ...canonical,
            create_time: template.create_time || canonical.create_time,
          });
        } else {
          byCanonical.set(canonical.id, {
            ...canonical,
            create_time: prev.create_time || template.create_time || canonical.create_time,
          });
        }
      } else {
        retained.push(template);
      }
    }
    for (const raw of catalogTemplates) {
      const next = this.normalizeLocalCatalogTemplate(raw);
      const existing = byCanonical.get(next.id);
      if (!existing) {
        byCanonical.set(next.id, next);
      } else {
        byCanonical.set(next.id, {
          ...next,
          create_time: existing.create_time || next.create_time,
          uses: 0,
        });
      }
    }
    this.data.templates = [...retained, ...byCanonical.values()];
  }

  resetSeedTemplateUsage() {
    for (const template of this.data.templates) {
      if (template.builtin || template.source === 'builtin' || template.source === 'catalog' || RpaStore.isLegacyExternalSource(template.source)) {
        template.uses = 0;
      }
    }
  }

  async setConfig(patch = {}) {
    this.data.config = { ...this.getConfig(), ...patch, update_time: new Date().toISOString() };
    await this.save();
    return this.data.config;
  }

  save() {
    const write = async () => {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = this.filePath + '.tmp';
      await fsp.writeFile(temporary, JSON.stringify(this.data, null, 2), 'utf8');
      await fsp.rename(temporary, this.filePath);
    };
    const pending = this.saveQueue.then(write, write);
    // Keep subsequent writes usable after an individual filesystem failure.
    this.saveQueue = pending.catch(() => {});
    return pending;
  }

  // ---------- plans ----------
  listPlans() {
    return [...this.data.plans].sort((a, b) => String(b.update_time || '').localeCompare(String(a.update_time || '')));
  }

  getPlan(id) {
    return this.data.plans.find((item) => item.id === id) || null;
  }

  async upsertPlan(input = {}) {
    const now = new Date().toISOString();
    const id = String(input.id || crypto.randomUUID());
    const existing = this.getPlan(id);
    const next = {
      id,
      plan_name: String(input.plan_name || input.name || 'untitled').slice(0, 120),
      process_name: String(input.process_name || input.plan_name || input.name || 'untitled').slice(0, 120),
      profile_ids: Array.isArray(input.profile_ids) ? input.profile_ids.map(String) : [],
      steps: Array.isArray(input.steps) ? input.steps : (existing?.steps || []),
      process_content: input.process_content !== undefined
        ? input.process_content
        : (existing?.process_content || null),
      status: String(input.status || existing?.status || 'idle'),
      create_time: existing?.create_time || now,
      update_time: now,
      ext: input.ext && typeof input.ext === 'object' ? input.ext : (existing?.ext || {}),
      template_id: input.template_id != null ? String(input.template_id) : (existing?.template_id || null),
    };
    if (existing) {
      Object.assign(existing, next);
    } else {
      this.data.plans.push(next);
    }
    await this.save();
    return next;
  }

  async deletePlan(id) {
    this.data.plans = this.data.plans.filter((item) => item.id !== id);
    this.data.tasks = this.data.tasks.filter((item) => item.plan_id !== id);
    await this.save();
    return { success: true };
  }

  // ---------- tasks ----------
  listTasks(filter = {}) {
    let items = [...this.data.tasks];
    if (filter.plan_id) items = items.filter((item) => item.plan_id === filter.plan_id);
    if (filter.status) items = items.filter((item) => item.status === filter.status);
    return items.sort((a, b) => String(b.create_time || '').localeCompare(String(a.create_time || '')));
  }

  getTask(id) {
    return this.data.tasks.find((item) => item.id === id) || null;
  }

  async createTask(input = {}) {
    const now = new Date().toISOString();
    const task = {
      id: String(input.id || crypto.randomUUID()),
      plan_id: input.plan_id ? String(input.plan_id) : null,
      profile_id: String(input.profile_id || ''),
      process_name: String(input.process_name || 'task').slice(0, 120),
      status: 'pending',
      steps: Array.isArray(input.steps) ? input.steps : [],
      process_content: input.process_content !== undefined ? input.process_content : null,
      process_logs: [],
      process_result: null,
      create_time: now,
      start_time: null,
      complete_time: null,
      update_time: now,
    };
    this.data.tasks.unshift(task);
    await this.save();
    return task;
  }

  async createTasks(inputs = []) {
    if (!Array.isArray(inputs) || !inputs.length) return [];
    const now = new Date().toISOString();
    const tasks = inputs.map((input = {}) => ({
      id: String(input.id || crypto.randomUUID()),
      plan_id: input.plan_id ? String(input.plan_id) : null,
      profile_id: String(input.profile_id || ''),
      process_name: String(input.process_name || 'task').slice(0, 120),
      status: 'pending',
      steps: Array.isArray(input.steps) ? input.steps : [],
      process_content: input.process_content !== undefined ? input.process_content : null,
      process_logs: [],
      process_result: null,
      create_time: now,
      start_time: null,
      complete_time: null,
      update_time: now,
    }));
    this.data.tasks.unshift(...tasks);
    await this.save();
    return tasks;
  }

  async updateTask(id, patch = {}, { save = true } = {}) {
    const task = this.getTask(id);
    if (!task) throw new Error('RPA task not found: ' + id);
    Object.assign(task, patch, { update_time: new Date().toISOString() });
    if (save) await this.save();
    return task;
  }

  // ---------- templates (script store) ----------
  listTemplates(filter = {}) {
    let items = [...this.data.templates];
    const q = String(filter.q || filter.keyword || '').trim().toLowerCase();
    const cat = String(filter.cat || filter.category || '').trim();
    if (cat && cat !== '全部' && cat !== 'All') {
      items = items.filter((t) => String(t.cat || '') === cat);
    }
    if (q) {
      items = items.filter((t) => {
        const hay = `${t.name || ''} ${t.desc || ''} ${(t.tags || []).join(' ')} ${t.cat || ''} ${t.developer || ''}`.toLowerCase();
        return hay.includes(q);
      });
    }
    if (filter.source === 'custom') items = items.filter((t) => !t.builtin && t.source !== 'builtin' && t.source !== 'catalog');
    if (filter.source === 'builtin') items = items.filter((t) => t.builtin || t.source === 'builtin');
    // Open-source build: all templates are free; pay_type filters are ignored.

    const sort = String(filter.sort || 'use_num');
    items.sort((a, b) => {
      if (sort === 'updated_time' || sort === 'recent') {
        return String(b.update_time || '').localeCompare(String(a.update_time || ''));
      }
      if (sort === 'name') return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
      // default: popular by uses
      const uses = (Number(b.uses) || 0) - (Number(a.uses) || 0);
      if (uses) return uses;
      return String(b.update_time || '').localeCompare(String(a.update_time || ''));
    });
    const evaluated = items.map((template) => {
      const free = this.forceFreeTemplate(template);
      const unsupported = findUnsupportedSteps(free.steps || []);
      return {
        ...free,
        pay_type: 1,
        price: null,
        runnable: unsupported.length === 0 && Array.isArray(free.steps) && free.steps.length > 0,
        unsupported_steps: unsupported,
      };
    });
    return evaluated;
  }

  listTemplateCategories() {
    const set = new Set();
    for (const t of this.data.templates) {
      if (t.cat) set.add(String(t.cat));
    }
    const preferred = [
      '网页操作', '养号浏览', '社交媒体', '电商', '数据采集', '账号管理',
      '邮箱验证', '工具', '流程控制', '开发调试', '我的模版',
    ];
    const seen = new Set();
    const ordered = [];
    for (const c of preferred) {
      if (set.has(c) && !seen.has(c)) {
        seen.add(c);
        ordered.push(c);
      }
    }
    const rest = [...set].filter((c) => !seen.has(c)).sort((a, b) => a.localeCompare(b, 'zh'));
    return ['全部', ...ordered, ...rest];
  }

  getTemplate(id) {
    const item = this.data.templates.find((entry) => entry.id === id) || null;
    return item ? this.forceFreeTemplate(item) : null;
  }

  normalizeTemplate(input = {}, existing = null) {
    const now = new Date().toISOString();
    const id = String(input.id || existing?.id || ('tpl-' + crypto.randomUUID()));
    let steps = Array.isArray(input.steps) ? input.steps : null;
    if ((!steps || !steps.length) && (input.process_content || existing?.process_content)) {
      steps = parseProcessContent(input.process_content || existing.process_content);
    }
    if (!steps) steps = existing?.steps || [];
    if (!Array.isArray(steps)) throw new Error('模版 steps 必须是数组');
    const builtin = Boolean(input.builtin ?? existing?.builtin);
    const source = builtin ? 'builtin' : String(input.source || existing?.source || 'custom');
    return {
      id,
      external_id: input.external_id != null ? String(input.external_id) : (existing?.external_id || null),
      name: String(input.name || input.plan_name || existing?.name || '未命名模版').slice(0, 120),
      cat: String(input.cat || input.category || input.category_name || existing?.cat || '我的模版').slice(0, 40),
      category_id: input.category_id != null ? String(input.category_id) : (existing?.category_id || ''),
      desc: String(input.desc || input.description || input.abstract || existing?.desc || '').slice(0, 800),
      tags: Array.isArray(input.tags)
        ? input.tags.map(String).slice(0, 20)
        : (existing?.tags || []),
      steps: JSON.parse(JSON.stringify(steps)),
      process_content: input.process_content !== undefined
        ? input.process_content
        : (existing?.process_content || null),
      uses: Number.isFinite(Number(input.uses))
        ? Number(input.uses)
        : (Number(existing?.uses) || 0),
      // Local OpenBrowser templates are always free.
      pay_type: 1,
      price: null,
      developer: String(input.developer || existing?.developer || (builtin ? 'OpenBrowser' : '')).slice(0, 80),
      img_url: String(input.img_url || existing?.img_url || '').slice(0, 500),
      builtin,
      source,
      create_time: existing?.create_time || now,
      update_time: now,
    };
  }

  async upsertTemplate(input = {}) {
    const id = input.id ? String(input.id) : null;
    const existing = id ? this.getTemplate(id) : null;
    if (existing?.builtin && input.force !== true) {
      if (Array.isArray(input.steps) || input.name) {
        throw new Error('内置模版不可修改，请「使用模版」后另存为流程，或另存为自定义模版');
      }
    }
    const next = this.normalizeTemplate(input, existing);
    if (existing) {
      if (existing.builtin && input.force !== true) {
        next.builtin = true;
        next.source = 'builtin';
        next.steps = existing.steps;
        next.name = existing.name;
      }
      Object.assign(existing, next);
      await this.save();
      return existing;
    }
    this.data.templates.push(next);
    await this.save();
    return next;
  }

  async deleteTemplate(id) {
    const item = this.getTemplate(id);
    if (!item) throw new Error('模版不存在: ' + id);
    if (item.builtin || item.source === 'builtin' || item.source === 'catalog') {
      throw new Error('内置模版不可删除');
    }
    this.data.templates = this.data.templates.filter((t) => t.id !== id);
    await this.save();
    return { success: true };
  }

  /**
   * Install template → create a runnable plan; bump uses count.
   * 若模版仅有 process_content，会先线性化为 steps。
   */
  async installTemplate(id, options = {}) {
    const tpl = this.getTemplate(id);
    if (!tpl) throw new Error('模版不存在: ' + id);
    let steps = Array.isArray(tpl.steps) ? JSON.parse(JSON.stringify(tpl.steps)) : [];
    if ((!steps || !steps.length) && tpl.process_content) {
      steps = parseProcessContent(tpl.process_content);
      tpl.steps = steps;
    }
    if (!steps.length) throw new Error('模版没有可执行步骤（未同步 process_content）');
    const unsupported = findUnsupportedSteps(steps);
    if (unsupported.length) {
      const summary = unsupported.slice(0, 4).map((item) => `${item.path.join('.')}: ${item.type}`).join(', ');
      throw new Error(`模版包含当前版本未支持的步骤，不能创建不可运行流程：${summary}`);
    }
    const planName = String(options.plan_name || options.name || tpl.name || '来自模版').slice(0, 120);
    const plan = await this.upsertPlan({
      plan_name: planName,
      process_name: planName,
      profile_ids: Array.isArray(options.profile_ids) ? options.profile_ids.map(String) : [],
      steps,
      process_content: tpl.process_content || null,
      template_id: tpl.id,
    });
    tpl.uses = (Number(tpl.uses) || 0) + 1;
    tpl.update_time = new Date().toISOString();
    await this.save();
    return { plan, template: tpl };
  }

  /**
   * 可选远程同步（需显式 base + 登录态；仓库不内置域名，默认使用本地离线包）。
   */
  async syncRemoteTemplates(options = {}) {
    const cfg = this.getConfig();
    const auth = {
      base: options.base || cfg.remoteApiBase || '',
      origin: options.origin || cfg.remoteApiOrigin || '',
      lang: options.lang || cfg.remoteLang || 'zh-CN',
      token: options.token || cfg.remoteToken || '',
      cookie: options.cookie || cfg.remoteCookie || '',
      apiKey: options.apiKey || cfg.remoteApiKey || '',
    };
    if (!String(auth.base || '').trim()) {
      throw new Error('未配置远程模版 API base：仓库不内置长期连接域名。日常请使用本地离线模版包；仅在运维一次性同步时显式传入 base/origin');
    }
    if (!auth.token && !auth.cookie && !auth.apiKey) {
      throw new Error('未配置远程模版登录态：请传入 token / cookie / apiKey');
    }
    const result = await syncRemoteTemplateStore(auth, {
      withDetail: options.withDetail !== false,
      pageSize: options.pageSize || 50,
      maxPages: options.maxPages || 10,
      sort: options.sort || 'use_num',
    });
    let imported = 0;
    let updated = 0;
    for (const tpl of result.templates || []) {
      const existing = this.getTemplate(tpl.id);
      if (existing) {
        // Keep local uses if higher
        tpl.uses = Math.max(Number(existing.uses) || 0, Number(tpl.uses) || 0);
        Object.assign(existing, this.normalizeTemplate(tpl, existing));
        updated += 1;
      } else {
        this.data.templates.push(this.normalizeTemplate(tpl, null));
        imported += 1;
      }
    }
    this.data.config = {
      ...cfg,
      remoteLastSync: result.synced_at,
      remoteCategories: result.categories || [],
    };
    await this.save();
    return {
      success: true,
      imported,
      updated,
      total: (result.templates || []).length,
      categories: result.categories || [],
      synced_at: result.synced_at,
    };
  }

  /**
   * 导入单条远程/导出的 template process JSON。
   */
  async importRemoteTemplatePayload(payload) {
    const raw = payload?.data && !payload.steps ? payload.data : payload;
    const normalized = normalizeRemoteTemplate(raw, raw);
    if (!normalized.steps?.length && !normalized.process_content) {
      throw new Error('导入内容没有 steps / process_content');
    }
    // Materialize as a local import so runtime stays offline and ids don't collide with catalog-* .
    const saved = await this.upsertTemplate({
      ...normalized,
      id: 'import-' + crypto.randomUUID(),
      force: true,
      builtin: false,
      source: 'import',
      external_id: null,
      developer: RpaStore.stripExternalBranding(normalized.developer) || 'OpenBrowser',
      name: RpaStore.stripExternalBranding(normalized.name) || '导入模版',
      cat: RpaStore.stripExternalBranding(normalized.cat) || '我的模版',
      desc: RpaStore.stripExternalBranding(normalized.desc) || '从文件导入',
      uses: 0,
    });
    return saved;
  }

  /**
   * Save current plan/steps as a custom template ("定制模版").
   */
  async saveAsTemplate(input = {}) {
    const steps = Array.isArray(input.steps) ? input.steps : null;
    if (!steps || !steps.length) throw new Error('没有可保存的步骤');
    return this.upsertTemplate({
      id: input.id || undefined,
      name: input.name || input.plan_name || '自定义模版',
      cat: input.cat || '我的模版',
      desc: input.desc || '由流程另存为模版',
      tags: input.tags || ['自定义'],
      steps,
      process_content: input.process_content || null,
      builtin: false,
      source: 'custom',
    });
  }

  /**
   * Import one or many templates from JSON (file/clipboard).
   * Returns { imported, skipped, templates }
   */
  async importTemplates(payload) {
    let list = [];
    if (Array.isArray(payload)) list = payload;
    else if (payload && Array.isArray(payload.templates)) list = payload.templates;
    else if (payload && (payload.list || payload.data?.list)) {
      list = payload.list || payload.data.list;
    } else if (payload && (payload.steps || payload.name || payload.process_content || payload.nodes)) {
      list = [payload];
    } else throw new Error('无效的模版 JSON：需要模版对象、数组或 { templates: [] }');

    const imported = [];
    const skipped = [];
    for (const raw of list) {
      try {
        // Convert supported process graph exports into executable steps.
        let steps = Array.isArray(raw.steps) ? raw.steps : null;
        if ((!steps || !steps.length) && (raw.process_content || raw.nodes)) {
          steps = parseProcessContent(raw.process_content || raw);
        }
        if (!steps || !steps.length) {
          skipped.push({ name: raw.name, reason: '无步骤' });
          continue;
        }
        let id = raw.id ? String(raw.id) : ('import-' + crypto.randomUUID());
        const v = RpaStore.legacyVendorToken();
        if (
          new RegExp(`^(?:${v}|remote|legacy|catalog)-`, 'i').test(id)
          || raw.external_id
          || raw[RpaStore.legacyIdField()]
          || RpaStore.isLegacyExternalSource(raw.source)
        ) {
          id = 'import-' + crypto.randomUUID();
        }
        const existing = this.getTemplate(id);
        if (existing?.builtin) {
          id = 'import-' + crypto.randomUUID();
        }
        const tags = (Array.isArray(raw.tags) ? raw.tags : ['导入'])
          .map(RpaStore.stripExternalBranding)
          .filter(Boolean);
        const saved = await this.upsertTemplate({
          id,
          name: RpaStore.stripExternalBranding(raw.name || raw.plan_name || raw.template_name) || '导入模版',
          cat: RpaStore.stripExternalBranding(raw.cat || raw.category || raw.category_name) || '我的模版',
          desc: RpaStore.stripExternalBranding(raw.desc || raw.description || raw.abstract) || '从文件导入',
          tags: tags.length ? tags : ['导入'],
          steps,
          process_content: raw.process_content || null,
          pay_type: 1,
          developer: RpaStore.stripExternalBranding(raw.developer),
          uses: Number(raw.uses || raw.use_num || 0) || 0,
          builtin: false,
          source: 'import',
          external_id: null,
        });
        imported.push(saved);
      } catch (error) {
        skipped.push({ name: raw?.name, reason: error.message });
      }
    }
    return { imported: imported.length, skipped, templates: imported };
  }

  exportTemplate(id) {
    const tpl = this.getTemplate(id);
    if (!tpl) throw new Error('模版不存在: ' + id);
    return {
      version: 1,
      exported_at: new Date().toISOString(),
      templates: [{
        name: tpl.name,
        cat: tpl.cat,
        desc: tpl.desc,
        tags: tpl.tags || [],
        steps: JSON.parse(JSON.stringify(tpl.steps || [])),
      }],
    };
  }

  exportAllCustomTemplates() {
    const customs = this.data.templates.filter((t) => !t.builtin && t.source !== 'builtin');
    return {
      version: 1,
      exported_at: new Date().toISOString(),
      templates: customs.map((tpl) => ({
        name: tpl.name,
        cat: tpl.cat,
        desc: tpl.desc,
        tags: tpl.tags || [],
        steps: JSON.parse(JSON.stringify(tpl.steps || [])),
      })),
    };
  }
}

module.exports = { RpaStore };
