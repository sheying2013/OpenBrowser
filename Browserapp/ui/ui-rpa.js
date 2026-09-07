(() => {
'use strict';

/**
 * OpenBrowser UI submodule
 */
const {
  toast,
  tx,
  t,
  log,
  element,
  buildSquareMark,
  displayProfileNumber,
  updateEngineBadge,
  afterUiRender,
  syncThemedSelects,
} = window.OpenBrowserApp || window;
const $ = window.$ || ((s, root = document) => root.querySelector(s));
const $$ = window.$$ || ((s, root = document) => [...root.querySelectorAll(s)]);
const app = window.OpenBrowserApp || window;
const ui = app.ui || { profiles: [] };
const save = app.save || (() => {});

// ========== Automation scripts (local-only panels) ==========
let rpaPlans = [];
let rpaSelectedId = null;
let currentRpaTab = 'flows';
const RPA_TEMPLATE = `[
  { "type": "gotoUrl", "url": "https://www.baidu.com" },
  { "type": "waitTime", "timeout": 1500 },
  { "type": "inputContent", "selector": "#kw", "content": "openbrowser rpa", "isClear": true },
  { "type": "waitTime", "timeout": 400 },
  { "type": "click", "selector": "#su" },
  { "type": "waitTime", "timeout": 2000 }
]`;

let rpaStoreTemplates = [];
let rpaStoreCategories = ['全部'];
let rpaStoreActiveCat = '全部';
let rpaPreviewTemplateId = null;

function showRpaPanel(tab) {
  setTimeout(() => afterUiRender(document.getElementById('view-rpa') || document), 0);

  currentRpaTab = tab || 'flows';
  document.querySelectorAll('[data-rpa-panel]').forEach((el) => {
    el.hidden = el.getAttribute('data-rpa-panel') !== currentRpaTab;
  });
  document.querySelectorAll('[data-view="rpa"]').forEach((btn) => {
    const t = btn.dataset.rpaTab;
    if (t) {
      btn.classList.toggle('active', t === currentRpaTab);
    }
  });

  // Ensure RPA menu expands
  const menu = document.getElementById('nav-rpa-plus');
  const toggle = document.getElementById('rpa-menu-toggle');
  if (menu && menu.hidden) {
    menu.hidden = false;
    menu.style.display = 'block';
  }
  if (toggle && !toggle.classList.contains('open')) {
    toggle.setAttribute('aria-expanded', 'true');
    toggle.classList.add('open');
  }
}

function setRpaEditorVisible(show) {
  const empty = document.getElementById('rpa-flow-empty');
  const editor = document.getElementById('rpa-flow-editor');
  if (empty) empty.hidden = show;
  if (editor) editor.hidden = !show;
}

function fillRpaProfileSelect(selectedIds = []) {
  const sel = document.getElementById('rpa-profile-ids');
  if (!sel) return;
  const running = (app.engineProfiles || []).filter((p) => p.running);
  sel.replaceChildren();
  for (const profile of (ui.profiles || [])) {
    const opt = document.createElement('option');
    opt.value = profile.id;
    const live = running.some((r) => r.id === profile.id);
    opt.textContent = (live ? '● ' : '○ ') + displayProfileNumber(profile) + ' · ' + (profile.name || profile.id);
    if (selectedIds.includes(profile.id)) opt.selected = true;
    sel.append(opt);
  }
}

function selectedRpaProfileIds() {
  const sel = document.getElementById('rpa-profile-ids');
  if (!sel) return [];
  return [...sel.selectedOptions].map((o) => o.value);
}

function renderRpaPlans() {
  const table = document.getElementById('rpa-plan-table');
  const countEl = document.getElementById('rpa-flow-count');
  const q = (document.getElementById('rpa-flow-search')?.value || '').trim().toLowerCase();
  if (countEl) countEl.textContent = String(rpaPlans.length);
  if (!table) return;
  table.replaceChildren();
  const list = rpaPlans.filter((p) => !q || String(p.plan_name || '').toLowerCase().includes(q));
  for (const plan of list) {
    const row = document.createElement('tr');
    if (plan.id === rpaSelectedId) row.classList.add('active');
    row.dataset.rpaPlan = plan.id;
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.rpaPlanCheck = plan.id;
    const td0 = document.createElement('td'); td0.append(cb);
    row.append(
      td0,
      element('td', '', plan.plan_name || plan.id),
      element('td', '', String((plan.steps || []).length)),
      element('td', '', String((plan.profile_ids || []).length)),
      element('td', '', String(plan.update_time || plan.create_time || '—').replace('T', ' ').slice(0, 19))
    );
    table.append(row);
  }
  setRpaEditorVisible(list.length > 0 || Boolean(rpaSelectedId));
  if (!list.length && !rpaSelectedId) setRpaEditorVisible(false);
}

function loadRpaPlanToEditor(plan) {
  rpaSelectedId = plan?.id || null;
  const title = document.getElementById('rpa-editor-title');
  if (!plan) {
    if (title) title.textContent = tx('编辑流程');
    const name = document.getElementById('rpa-plan-name');
    const steps = document.getElementById('rpa-steps-json');
    if (name) name.value = '';
    if (steps) steps.value = '';
    fillRpaProfileSelect([]);
    renderRpaPlans();
    return;
  }
  setRpaEditorVisible(true);
  if (title) title.textContent = plan.plan_name || plan.id;
  document.getElementById('rpa-plan-name').value = plan.plan_name || '';
  document.getElementById('rpa-steps-json').value = JSON.stringify(plan.steps || [], null, 2);
  fillRpaProfileSelect(plan.profile_ids || []);
  renderRpaPlans();
}

function appendRpaLog(line) {
  const box = document.getElementById('rpa-log-list');
  if (!box) return;
  if (box.querySelector('.rpa-muted') && box.children.length === 1) box.replaceChildren();
  const raw = String(line || '');
  const levelMatch = raw.match(/^(error|fail|failed|warn|warning|ok|success|done|info)\s*[:：-]\s*/i);
  let level = 'info';
  let message = raw;
  if (levelMatch) {
    const token = String(levelMatch[1] || '').toLowerCase();
    level = /error|fail/.test(token) ? 'error'
      : /warn/.test(token) ? 'warn'
        : /ok|success|done/.test(token) ? 'ok'
          : 'info';
    message = raw.slice(levelMatch[0].length) || raw;
  } else if (/\berror\b|错误|失败/i.test(raw)) {
    level = 'error';
  } else if (/\bwarn(?:ing)?\b|警告/i.test(raw)) {
    level = 'warn';
  } else if (/完成|成功|started|已启动|done|success/i.test(raw)) {
    level = 'ok';
  }
  const levelLabel = level === 'error' ? 'ERROR'
    : level === 'warn' ? 'WARN'
      : level === 'ok' ? 'OK'
        : 'INFO';
  const row = document.createElement('div');
  row.className = 'log-line level-' + level;
  const timeEl = document.createElement('span');
  timeEl.className = 'log-time';
  timeEl.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const levelEl = document.createElement('span');
  levelEl.className = 'log-level';
  levelEl.textContent = levelLabel;
  const msgEl = document.createElement('span');
  msgEl.className = 'log-msg';
  msgEl.textContent = message;
  row.append(timeEl, levelEl, msgEl);
  box.prepend(row);
  // Keep the newest line visible without forcing the whole page to jump.
  try { box.scrollTop = 0; } catch (_) {}
}

async function refreshRpaStatusBadge() {
  try {
    const st = await window.ops.rpaStatus();
    const el = document.getElementById('rpa-run-status');
    if (el) el.textContent = st.count ? (tx('运行中 ') + st.count) : tx('空闲');
  } catch (_) {}
}

async function refreshRpaTasks() {
  const table = document.getElementById('rpa-task-table');
  const empty = document.getElementById('rpa-task-empty');
  const selectAll = document.getElementById('rpa-task-select-all');
  const deleteCheckedBtn = document.getElementById('rpa-task-delete-checked');
  if (!table) return;
  let tasks = [];
  try { tasks = await window.ops.rpaTasks({}); } catch (_) { tasks = []; }
  const q = (document.getElementById('rpa-task-search')?.value || '').trim().toLowerCase();
  table.replaceChildren();
  if (selectAll) selectAll.checked = false;
  if (deleteCheckedBtn) deleteCheckedBtn.style.display = 'none';

  const updateDeleteCheckedBtnVisibility = () => {
    const anyChecked = table.querySelectorAll('.rpa-task-checkbox:checked').length > 0;
    if (deleteCheckedBtn) deleteCheckedBtn.style.display = anyChecked ? 'inline-flex' : 'none';
  };

  const list = (tasks || []).filter((t) => !q || String(t.process_name || t.id).toLowerCase().includes(q));
  for (const t of list) {
    const row = document.createElement('tr');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'rpa-task-checkbox';
    cb.dataset.taskId = t.id;
    cb.onchange = () => {
      updateDeleteCheckedBtnVisibility();
      if (selectAll) {
        const total = table.querySelectorAll('.rpa-task-checkbox').length;
        const checked = table.querySelectorAll('.rpa-task-checkbox:checked').length;
        selectAll.checked = total > 0 && total === checked;
      }
    };
    const td0 = document.createElement('td'); td0.append(cb);
    const runBtn = element('button', 'outline', tx('详情'));
    runBtn.onclick = () => {
      appendRpaLog(JSON.stringify(t));
      showRpaPanel('runs');
      toast(tx('见运行记录/日志'));
    };
    const delBtn = element('button', 'danger outline', tx('删除'));
    delBtn.style.marginLeft = '6px';
    delBtn.onclick = async () => {
      if (!confirm(`确定要删除任务「${t.process_name || t.id}」吗？`)) return;
      try {
        await window.ops.rpaTaskDelete([t.id]);
        toast(tx('任务已删除'));
        await refreshRpaTasks();
        await refreshRpaRuns();
      } catch (err) {
        toast('删除失败：' + err.message);
      }
    };
    const tdOp = document.createElement('td');
    tdOp.style.whiteSpace = 'nowrap';
    tdOp.append(runBtn, delBtn);
    row.append(
      td0,
      element('td', '', t.process_name || t.id),
      element('td', '', '1'),
      element('td', '', t.process_name || '—'),
      element('td', '', t.type || '普通'),
      element('td', '', String(t.start_time || t.create_time || '—').replace('T', ' ').slice(0, 19)),
      element('td', '', t.status || '—'),
      tdOp
    );
    table.append(row);
  }
  if (empty) {
    empty.style.display = list.length ? 'none' : 'grid';
  }
}

async function refreshRpaRuns() {
  const table = document.getElementById('rpa-run-table');
  const empty = document.getElementById('rpa-run-empty');
  if (!table) return;
  let tasks = [];
  try { tasks = await window.ops.rpaTasks({}); } catch (_) { tasks = []; }
  const filter = document.getElementById('rpa-run-filter')?.value || 'all';
  const q = (document.getElementById('rpa-run-search')?.value || '').trim().toLowerCase();
  table.replaceChildren();
  let list = tasks || [];
  if (filter !== 'all') list = list.filter((t) => String(t.status) === filter);
  if (q) list = list.filter((t) => String(t.process_name || '').toLowerCase().includes(q));
  for (const t of list) {
    const row = document.createElement('tr');
    row.append(
      element('td', '', t.process_name || t.id),
      element('td', '', t.process_name || '—'),
      element('td', '', t.profile_id || '—'),
      element('td', '', t.status || '—'),
      element('td', '', String(t.start_time || t.create_time || '—').replace('T', ' ').slice(0, 19)),
      element('td', '', String(t.complete_time || '—').replace('T', ' ').slice(0, 19)),
      element('td', '', '')
    );
    table.append(row);
  }
  if (empty) empty.style.display = list.length ? 'none' : 'grid';
}

function rpaCategoryLabel(cat) {
  const c = String(cat || '');
  if (c === '全部' || c === 'All') return t('rpa.cat.all');
  return c;
}

function syncRpaStoreCategoryUi(categories) {
  rpaStoreCategories = Array.isArray(categories) && categories.length ? categories : ['全部'];
  const select = document.getElementById('rpa-store-cat');
  const chips = document.getElementById('rpa-store-chips');
  if (select) {
    const prev = select.value || rpaStoreActiveCat;
    select.replaceChildren();
    for (const c of rpaStoreCategories) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = rpaCategoryLabel(c);
      select.append(opt);
    }
    select.value = rpaStoreCategories.includes(prev) ? prev : '全部';
    rpaStoreActiveCat = select.value;
  }
  if (chips) {
    chips.replaceChildren();
    for (const c of rpaStoreCategories) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = rpaCategoryLabel(c);
      b.dataset.storeCat = c;
      if (c === rpaStoreActiveCat) b.classList.add('active');
      chips.append(b);
    }
  }
}

function rpaStoreSourceLabel(tpl) {
  if (tpl.builtin || tpl.source === 'builtin') return t('rpa.store.source.builtin');
  if (tpl.source === 'catalog') return t('rpa.store.source.local');
  if (tpl.source === 'import') return t('rpa.store.source.import');
  return t('rpa.store.source.mine');
}

function rpaStepSummary(steps, max = 12) {
  if (!Array.isArray(steps) || !steps.length) return '（无步骤）';
  return steps.slice(0, max).map((s, i) => {
    const t = s.type || s.action || '?';
    const hint = s.url || s.selector || s.content || s.expression || '';
    const short = String(hint).replace(/\s+/g, ' ').slice(0, 48);
    return `${i + 1}. ${t}${short ? ' · ' + short : ''}`;
  }).join('\n') + (steps.length > max ? `\n… 共 ${steps.length} 步` : '');
}

async function refreshRpaStore() {
  const q = (document.getElementById('rpa-store-search')?.value || '').trim();
  const cat = rpaStoreActiveCat || '全部';
  const sort = document.getElementById('rpa-store-sort')?.value || 'use_num';
  const source = document.getElementById('rpa-store-source')?.value || '';
  try {
    const result = await window.ops.rpaTemplates({ q, cat, sort, source });
    rpaStoreTemplates = Array.isArray(result?.list) ? result.list : [];
    syncRpaStoreCategoryUi(result?.categories);
    const meta = document.getElementById('rpa-store-sync-meta');
    if (meta) meta.textContent = t('rpa.store.localMeta');
  } catch (error) {
    rpaStoreTemplates = [];
    toast('加载模板仓库失败：' + error.message);
  }
  renderRpaStore();
}

function renderRpaStore() {
  const grid = document.getElementById('rpa-store-grid');
  const empty = document.getElementById('rpa-store-empty');
  const countEl = document.getElementById('rpa-store-count');
  if (!grid) return;
  // Server already filtered; keep light client filter for search-as-you-type without refetch lag
  const list = rpaStoreTemplates;
  if (countEl) {
    const wrap = countEl.parentElement;
    if (wrap && wrap.classList.contains('rpa-toolbar-right')) {
      wrap.innerHTML = `${t('rpa.store.countPrefix') || '共 '}<b id="rpa-store-count">${list.length}</b>${t('rpa.store.countMiddle') || ' 个 · '}<span id="rpa-store-sync-meta">${t('rpa.store.localMeta')}</span>`;
    } else {
      countEl.textContent = String(list.length);
    }
  }
  grid.replaceChildren();
  if (empty) empty.hidden = list.length > 0;
  for (const tpl of list) {
    const card = document.createElement('article');
    card.className = 'rpa-store-card';
    card.dataset.templateId = tpl.id;
    const sourceLabel = rpaStoreSourceLabel(tpl);
    const stepCount = Array.isArray(tpl.steps) ? tpl.steps.length : 0;
    const runnable = tpl.runnable === true;
    const tags = Array.isArray(tpl.tags) ? tpl.tags.slice(0, 4) : [];
    card.innerHTML = `
      <h4></h4>
      <p></p>
      <div class="rpa-store-tags"></div>
      <div class="rpa-store-meta"><span></span><span></span></div>
      <div class="rpa-store-actions"></div>`;
    card.querySelector('h4').textContent = tpl.name || tpl.id;
    card.querySelector('p').textContent = tpl.desc || '';
    const tagBox = card.querySelector('.rpa-store-tags');
    for (const tag of tags) {
      const i = document.createElement('i');
      i.textContent = tag;
      tagBox.append(i);
    }
    if (tpl.developer) {
      const i = document.createElement('i');
      i.textContent = tpl.developer;
      tagBox.append(i);
    }
    const meta = card.querySelectorAll('.rpa-store-meta span');
    meta[0].textContent = `${tpl.cat || '—'} · ${sourceLabel}`;
    meta[1].textContent = t('rpa.store.steps', { n: stepCount });
    const actions = card.querySelector('.rpa-store-actions');
    const useBtn = document.createElement('button');
    useBtn.type = 'button'; useBtn.className = 'primary'; useBtn.textContent = runnable ? t('action.use') : t('action.unavailable');
    useBtn.disabled = !runnable;
    useBtn.title = runnable
      ? t('rpa.store.createFlow')
      : (stepCount ? t('rpa.store.unsupportedPrefix', { items: (tpl.unsupported_steps || []).slice(0, 3).map((item) => item.type).join(', ') }) : t('rpa.store.noSteps'));
    useBtn.onclick = () => installRpaTemplate(tpl.id).catch((e) => toast(e.message));
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button'; previewBtn.className = 'outline'; previewBtn.textContent = t('action.preview');
    previewBtn.onclick = () => openRpaTemplatePreview(tpl);
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button'; exportBtn.className = 'outline'; exportBtn.textContent = t('action.export');
    exportBtn.onclick = async () => {
      try {
        const result = await window.ops.rpaTemplateExport(tpl.id);
        if (result?.canceled) return;
        toast(t('rpa.store.exported', { path: result.path || '' }));
      } catch (e) { toast(e.message); }
    };
    actions.append(useBtn, previewBtn, exportBtn);
    if (!tpl.builtin && tpl.source !== 'builtin' && tpl.source !== 'catalog') {
      const delBtn = document.createElement('button');
      delBtn.type = 'button'; delBtn.className = 'outline rpa-btn-danger'; delBtn.textContent = t('action.delete');
      delBtn.onclick = async () => {
        if (!confirm(t('rpa.store.deleteConfirm', { name: tpl.name || '' }))) return;
        try {
          await window.ops.rpaTemplateDelete(tpl.id);
          toast(t('toast.deleted'));
          await refreshRpaStore();
        } catch (e) { toast(e.message); }
      };
      actions.append(delBtn);
    }
    grid.append(card);
  }
}

async function installRpaTemplate(id) {
  const result = await window.ops.rpaTemplateInstall({ id });
  const plan = result?.plan;
  if (!plan) throw new Error(tx('安装模板失败'));
  rpaSelectedId = plan.id;
  showRpaPanel('flows');
  await refreshRpaPage();
  loadRpaPlanToEditor(plan);
  toast(`${t('rpa.store.createFlow')}：${plan.plan_name || plan.id}（${t('rpa.store.steps', { n: plan.steps?.length || 0 })}）`);
  afterUiRender(document.getElementById('view-rpa') || document);
  return plan;
}

function openRpaTemplatePreview(tpl) {
  rpaPreviewTemplateId = tpl.id;
  const dialog = document.getElementById('rpa-template-preview');
  const title = document.getElementById('rpa-preview-title');
  const meta = document.getElementById('rpa-preview-meta');
  const steps = document.getElementById('rpa-preview-steps');
  if (title) title.textContent = t('rpa.store.previewTitle');
  if (meta) {
    meta.textContent = `${tpl.cat || ''} · ${rpaStoreSourceLabel(tpl)} · ${t('rpa.store.steps', { n: Array.isArray(tpl.steps) ? tpl.steps.length : 0 })} · ${tpl.desc || ''}`;
  }
  if (steps) {
    const summary = rpaStepSummary(tpl.steps || []);
    steps.textContent = summary + '\n\n—— JSON ——\n' + JSON.stringify(tpl.steps || [], null, 2);
  }
  dialog?.showModal?.();
}

function openCustomTemplateDialog(seed = {}) {
  const dialog = document.getElementById('rpa-template-dialog');
  const nameEl = document.getElementById('rpa-tpl-name');
  const catEl = document.getElementById('rpa-tpl-cat');
  const descEl = document.getElementById('rpa-tpl-desc');
  const stepsEl = document.getElementById('rpa-tpl-steps');
  if (nameEl) nameEl.value = seed.name || '';
  if (catEl) catEl.value = seed.cat || '我的模板';
  if (descEl) descEl.value = seed.desc || '';
  if (stepsEl) {
    try {
      stepsEl.value = typeof seed.stepsJson === 'string'
        ? seed.stepsJson
        : JSON.stringify(seed.steps || JSON.parse(RPA_TEMPLATE), null, 2);
    } catch (_) {
      stepsEl.value = RPA_TEMPLATE;
    }
  }
  dialog?.showModal?.();
}

async function saveCustomTemplateFromDialog() {
  const name = document.getElementById('rpa-tpl-name')?.value?.trim() || '自定义模板';
  const cat = document.getElementById('rpa-tpl-cat')?.value?.trim() || '我的模板';
  const desc = document.getElementById('rpa-tpl-desc')?.value?.trim() || '';
  let steps;
  try {
    steps = JSON.parse(document.getElementById('rpa-tpl-steps')?.value || '[]');
  } catch (e) {
    throw new Error(tx('步骤 JSON 无效：') + e.message);
  }
  if (!Array.isArray(steps) || !steps.length) throw new Error(tx('步骤不能为空'));
  await window.ops.rpaTemplateSaveAs({ name, cat, desc, steps, tags: ['自定义'] });
  toast(tx('模板已保存到仓库'));
  showRpaPanel('store');
  await refreshRpaStore();
}

async function refreshRpaPage() {
  try {
    await refreshStatus();
    rpaPlans = await window.ops.rpaPlans();
    if (!Array.isArray(rpaPlans)) rpaPlans = [];
  } catch (error) {
    rpaPlans = [];
    toast('加载自动脚本失败：' + error.message);
  }
  if (rpaSelectedId) {
    const plan = rpaPlans.find((p) => p.id === rpaSelectedId) || await window.ops.rpaGetPlan(rpaSelectedId);
    if (plan) loadRpaPlanToEditor(plan);
    else { rpaSelectedId = null; renderRpaPlans(); }
  } else renderRpaPlans();
  await refreshRpaStatusBadge();
  await refreshRpaTasks();
  await refreshRpaRuns();
  await refreshRpaStore();
  afterUiRender(document.getElementById('view-rpa') || document);
}

async function createRpaPlan(name) {
  const plan = await window.ops.rpaSavePlan({
    plan_name: name || ('新流程 ' + new Date().toLocaleString()),
    profile_ids: [],
    steps: JSON.parse(RPA_TEMPLATE),
  });
  rpaSelectedId = plan.id;
  showRpaPanel('flows');
  await refreshRpaPage();
  loadRpaPlanToEditor(plan);
  toast(tx('已创建流程'));
}

document.getElementById('rpa-new-plan')?.addEventListener('click', () => createRpaPlan().catch((e) => toast(e.message)));
document.getElementById('rpa-new-plan-2')?.addEventListener('click', () => createRpaPlan().catch((e) => toast(e.message)));
document.getElementById('rpa-create-task')?.addEventListener('click', () => createRpaPlan('任务流程 ' + new Date().toLocaleString()).catch((e) => toast(e.message)));
document.getElementById('rpa-refresh')?.addEventListener('click', refreshRpaPage);
document.getElementById('rpa-task-refresh')?.addEventListener('click', refreshRpaTasks);
document.getElementById('rpa-task-select-all')?.addEventListener('change', (event) => {
  const checked = event.target.checked;
  const table = document.getElementById('rpa-task-table');
  if (!table) return;
  table.querySelectorAll('.rpa-task-checkbox').forEach((cb) => { cb.checked = checked; });
  const deleteCheckedBtn = document.getElementById('rpa-task-delete-checked');
  if (deleteCheckedBtn) deleteCheckedBtn.style.display = checked && table.querySelectorAll('.rpa-task-checkbox').length > 0 ? 'inline-flex' : 'none';
});
document.getElementById('rpa-task-delete-checked')?.addEventListener('click', async () => {
  const table = document.getElementById('rpa-task-table');
  if (!table) return;
  const checkedBoxes = [...table.querySelectorAll('.rpa-task-checkbox:checked')];
  const ids = checkedBoxes.map((cb) => cb.dataset.taskId).filter(Boolean);
  if (!ids.length) return toast(tx('请先勾选要删除的任务'));
  if (!confirm(`确定要删除选中的 ${ids.length} 个任务吗？`)) return;
  try {
    const res = await window.ops.rpaTaskDelete(ids);
    toast(`已删除 ${res?.deleted?.length || ids.length} 个任务`);
    await refreshRpaTasks();
    await refreshRpaRuns();
  } catch (err) {
    toast('删除失败：' + err.message);
  }
});
document.getElementById('rpa-run-refresh')?.addEventListener('click', refreshRpaRuns);
document.getElementById('rpa-flow-search')?.addEventListener('input', renderRpaPlans);
document.getElementById('rpa-task-search')?.addEventListener('input', refreshRpaTasks);
document.getElementById('rpa-run-search')?.addEventListener('input', refreshRpaRuns);
document.getElementById('rpa-run-filter')?.addEventListener('change', refreshRpaRuns);
document.getElementById('rpa-store-search')?.addEventListener('input', () => {
  // debounce refetch with filters
  clearTimeout(window.__rpaStoreSearchTimer);
  window.__rpaStoreSearchTimer = setTimeout(() => refreshRpaStore().catch((e) => toast(e.message)), 280);
});
document.getElementById('rpa-store-cat')?.addEventListener('change', (event) => {
  rpaStoreActiveCat = event.target.value || '全部';
  document.querySelectorAll('#rpa-store-chips button').forEach((b) => {
    b.classList.toggle('active', b.dataset.storeCat === rpaStoreActiveCat);
  });
  refreshRpaStore().catch((e) => toast(e.message));
});
document.getElementById('rpa-store-sort')?.addEventListener('change', () => refreshRpaStore().catch((e) => toast(e.message)));
document.getElementById('rpa-store-source')?.addEventListener('change', () => refreshRpaStore().catch((e) => toast(e.message)));
document.getElementById('rpa-store-refresh')?.addEventListener('click', () => refreshRpaStore().catch((e) => toast(e.message)));
document.getElementById('rpa-store-guide')?.addEventListener('click', () => {
  showRpaPanel('guide');
});
document.getElementById('rpa-guide-back')?.addEventListener('click', () => showRpaPanel('store'));
document.getElementById('rpa-guide-create')?.addEventListener('click', () => {
  showRpaPanel('store');
  openCustomTemplateDialog({
    name: '',
    cat: '我的模板',
    desc: '',
    stepsJson: document.getElementById('rpa-steps-json')?.value || RPA_TEMPLATE,
  });
});
document.getElementById('rpa-store-import')?.addEventListener('click', async () => {
  try {
    const result = await window.ops.rpaTemplateImport();
    if (result?.canceled) return;
    toast(`导入 ${result.imported || 0} 个模板` + (result.skipped?.length ? `，跳过 ${result.skipped.length}` : ''));
    await refreshRpaStore();
  } catch (e) { toast(e.message); }
});
document.getElementById('rpa-store-export-all')?.addEventListener('click', async () => {
  try {
    const result = await window.ops.rpaTemplateExport(null);
    if (result?.canceled) return;
    toast(result.count ? `已导出 ${result.count} 个自定义模板` : '没有可导出的自定义模板（已写空包）');
  } catch (e) { toast(e.message); }
});
document.getElementById('rpa-store-custom')?.addEventListener('click', () => {
  openCustomTemplateDialog({
    name: '',
    cat: '我的模板',
    desc: '',
    stepsJson: document.getElementById('rpa-steps-json')?.value || RPA_TEMPLATE,
  });
});
document.getElementById('rpa-save-as-template')?.addEventListener('click', () => {
  const name = document.getElementById('rpa-plan-name')?.value?.trim() || '来自流程';
  openCustomTemplateDialog({
    name,
    cat: '我的模板',
    desc: '由流程「' + name + '」另存',
    stepsJson: document.getElementById('rpa-steps-json')?.value || RPA_TEMPLATE,
  });
});
document.getElementById('rpa-template-dialog')?.addEventListener('close', async () => {
  const dialog = document.getElementById('rpa-template-dialog');
  if (dialog?.returnValue !== 'save') return;
  try {
    await saveCustomTemplateFromDialog();
  } catch (e) {
    toast(e.message);
    // re-open so user can fix
    setTimeout(() => dialog.showModal?.(), 0);
  }
});
document.getElementById('rpa-preview-use')?.addEventListener('click', async () => {
  try {
    if (!rpaPreviewTemplateId) return;
    document.getElementById('rpa-template-preview')?.close?.();
    await installRpaTemplate(rpaPreviewTemplateId);
  } catch (e) { toast(e.message); }
});

document.getElementById('rpa-plan-table')?.addEventListener('click', async (event) => {
  const tr = event.target.closest('[data-rpa-plan]');
  if (!tr || event.target.closest('input')) return;
  const plan = rpaPlans.find((p) => p.id === tr.dataset.rpaPlan) || await window.ops.rpaGetPlan(tr.dataset.rpaPlan);
  if (plan) loadRpaPlanToEditor(plan);
});

document.getElementById('rpa-save')?.addEventListener('click', async () => {
  try {
    let steps;
    try { steps = JSON.parse(document.getElementById('rpa-steps-json').value || '[]'); }
    catch (e) { throw new Error(tx('步骤 JSON 无效：') + e.message); }
    if (!Array.isArray(steps)) throw new Error(tx('步骤必须是数组'));
    const plan = await window.ops.rpaSavePlan({
      id: rpaSelectedId || undefined,
      plan_name: document.getElementById('rpa-plan-name').value.trim() || '未命名流程',
      profile_ids: selectedRpaProfileIds(),
      steps,
    });
    rpaSelectedId = plan.id;
    await refreshRpaPage();
    toast(tx('已保存'));
    log('自动脚本', '保存流程 ' + plan.plan_name);
  } catch (error) { toast(error.message); }
});

document.getElementById('rpa-delete')?.addEventListener('click', async () => {
  const checked = [...document.querySelectorAll('[data-rpa-plan-check]:checked')].map((el) => el.dataset.rpaPlanCheck);
  const ids = checked.length ? checked : (rpaSelectedId ? [rpaSelectedId] : []);
  if (!ids.length) return toast(tx('请先选择流程'));
  if (!confirm(tx('确定删除选中的 ') + ids.length + tx(' 个流程？'))) return;
  try {
    for (const id of ids) await window.ops.rpaDeletePlan(id);
    if (ids.includes(rpaSelectedId)) rpaSelectedId = null;
    await refreshRpaPage();
    toast(tx('已删除'));
  } catch (error) { toast(error.message); }
});

document.getElementById('rpa-run')?.addEventListener('click', async () => {
  try {
    let steps;
    try { steps = JSON.parse(document.getElementById('rpa-steps-json').value || '[]'); }
    catch (e) { throw new Error(tx('步骤 JSON 无效：') + e.message); }
    const profileIds = selectedRpaProfileIds();
    if (!profileIds.length) throw new Error(tx('请选择至少一个已启动的环境'));
    const plan = await window.ops.rpaSavePlan({
      id: rpaSelectedId || undefined,
      plan_name: document.getElementById('rpa-plan-name').value.trim() || '未命名流程',
      profile_ids: profileIds,
      steps,
    });
    rpaSelectedId = plan.id;
    appendRpaLog('开始运行：' + plan.plan_name + ' → ' + profileIds.join(','));
    toast(tx('自动脚本运行中…'));
    const result = await window.ops.rpaRun({ plan_id: plan.id, profile_ids: profileIds });
    appendRpaLog('完成：' + JSON.stringify(result));
    toast(result.success === false ? '自动脚本有失败任务' : '自动脚本完成');
    await refreshRpaStatusBadge();
    await refreshRpaTasks();
    await refreshRpaRuns();
    log('自动脚本', '运行 ' + plan.plan_name);
  } catch (error) {
    appendRpaLog('错误：' + error.message);
    toast('运行失败：' + error.message);
  }
});

document.getElementById('rpa-stop')?.addEventListener('click', async () => {
  try {
    await window.ops.rpaStop();
    appendRpaLog('已请求停止');
    await refreshRpaStatusBadge();
    toast(tx('已停止'));
  } catch (error) { toast(error.message); }
});

document.getElementById('rpa-load-template')?.addEventListener('click', () => {
  const ta = document.getElementById('rpa-steps-json');
  if (ta) { ta.value = RPA_TEMPLATE; toast(tx('已载入示例')); }
});
document.getElementById('rpa-format-json')?.addEventListener('click', () => {
  try {
    const ta = document.getElementById('rpa-steps-json');
    if (!ta) return;
    ta.value = JSON.stringify(JSON.parse(ta.value || '[]'), null, 2);
  } catch (error) { toast('JSON 无效：' + error.message); }
});

document.getElementById('rpa-store-chips')?.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-store-cat]');
  if (!btn) return;
  rpaStoreActiveCat = btn.dataset.storeCat || '全部';
  document.querySelectorAll('#rpa-store-chips button').forEach((b) => b.classList.toggle('active', b === btn));
  const select = document.getElementById('rpa-store-cat');
  if (select) select.value = rpaStoreActiveCat;
  refreshRpaStore().catch((e) => toast(e.message));
});

// fix nav: when clicking rpa child, switch view with tab
const _origNavHandler = null;
document.addEventListener('click', (event) => {
  const nav = event.target.closest('.nav[data-view]');
  if (!nav) return;
  if (nav.dataset.view === 'rpa') {
    currentRpaTab = nav.dataset.rpaTab || currentRpaTab || 'flows';
  }
});

document.getElementById('rpa-menu-toggle')?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const menu = document.getElementById('nav-rpa-plus');
  const toggle = document.getElementById('rpa-menu-toggle');
  if (!menu || !toggle) return;
  const isCurrentlyHidden = menu.hidden || menu.style.display === 'none';
  if (isCurrentlyHidden) {
    menu.hidden = false;
    menu.style.display = 'block';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.classList.add('open');
    switchView('rpa', currentRpaTab || 'flows'); // Automatically open first sub-menu when expanded
  } else {
    menu.hidden = true;
    menu.style.display = 'none';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.classList.remove('open');
  }
});

window.showRpaPanel = showRpaPanel;
window.refreshRpaPage = refreshRpaPage;
window.appendRpaLog = appendRpaLog;
window.refreshRpaStatusBadge = refreshRpaStatusBadge;
window.refreshRpaTasks = refreshRpaTasks;
window.refreshRpaRuns = refreshRpaRuns;
window.renderRpaStore = renderRpaStore;
})();
