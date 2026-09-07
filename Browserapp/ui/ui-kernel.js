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
const ui = window.OpenBrowserApp?.ui || window.ui || { profiles: [] };
const save = window.OpenBrowserApp?.save || window.save || (() => {});

// ========== Independent browser kernel — Donut Wayfern channel ==========
function kernelSourceLabel(source) {
  if (source === 'donut-wayfern') return 'Donut Wayfern';
  if (source === 'chrome-stable') return 'Google Chrome Stable';
  if (source === 'chrome-for-testing') return 'Chrome for Testing';
  if (source === 'custom') return '自定义';
  return source || '—';
}

async function refreshKernelPanel() {
  const badge = document.getElementById('kernel-status-badge');
  const pathEl = document.getElementById('kernel-path');
  const verEl = document.getElementById('kernel-version');
  const activePathEl = document.getElementById('kernel-active-path');
  const launchModeEl = document.getElementById('kernel-launch-mode');
  const channelEl = document.getElementById('kernel-channel');
  const prefer = document.getElementById('kernel-prefer-independent');
  const allow = document.getElementById('kernel-allow-system');
  const systemBrowser = document.getElementById('kernel-system-browser');
  try {
    const info = await window.ops.getInfo();
    updateEngineBadge(info);
    const st = info.kernel || await window.ops.kernelStatus();
    const k = st.kernel;
    if (badge) {
      badge.textContent = k ? tx('已安装 · ') + kernelSourceLabel(k.source) : tx('未安装');
      badge.style.color = k ? '#15803d' : '#b45309';
    }
    if (pathEl) pathEl.textContent = k?.path || st.kernelsRoot || '—';
    if (verEl) {
      const remote = st.meta?.remoteVersion;
      verEl.textContent = k
        ? `${k.version || '—'} · ${kernelSourceLabel(k.source)}${remote && remote !== k.version ? tx(' · 远端 ') + remote : ''}`
        : tx('点击下方下载 Google Chrome Stable');
    }
    if (channelEl) {
      channelEl.textContent = st.channel
        ? [st.channel.name, st.channel.metaUrl].filter(Boolean).join(' · ')
        : 'Google Chrome Stable';
    }
    const selection = info.kernelSelection;
    if (activePathEl) activePathEl.textContent = selection?.browser?.path || selection?.message || tx('未选择可执行文件');
    if (launchModeEl) {
      const mode = selection?.mode;
      launchModeEl.textContent = mode === 'independent'
        ? `独立内核 · ${selection.browser.name}`
        : mode === 'system-manual'
          ? `手动选择本机浏览器 · ${selection.browser.name}`
          : mode === 'system'
            ? `本机浏览器 · ${selection.browser.name}`
            : tx('已阻止启动：需要独立内核');
    }
    if (prefer) prefer.checked = info.preferIndependentKernel !== false;
    if (allow) allow.checked = info.allowSystemBrowserFallback === true;
    if (systemBrowser) {
      const selected = info.systemBrowserPath || '';
      systemBrowser.replaceChildren(new Option(tx('未选择'), ''));
      for (const item of info.systemBrowsers || []) {
        systemBrowser.add(new Option(`${item.name} · ${item.path}`, item.path));
      }
      systemBrowser.value = selected;
    }
  } catch (error) {
    if (badge) badge.textContent = tx('读取失败');
  }
}

document.getElementById('kernel-refresh')?.addEventListener('click', refreshKernelPanel);
document.getElementById('kernel-download')?.addEventListener('click', async () => {
  const progress = document.getElementById('kernel-progress');
  const btn = document.getElementById('kernel-download');
  try {
    if (btn) btn.disabled = true;
    if (progress) progress.textContent = tx('正在准备 Google Chrome Stable…');
    toast(tx('开始下载 Google Chrome Stable…'));
    const kernel = await window.ops.kernelDownload(true);
    if (progress) progress.textContent = tx('内置内核就绪：') + (kernel?.path || '');
    toast(tx(`${kernelSourceLabel(kernel?.source)} 已就绪 v${kernel?.version || ''}`));
    await refreshKernelPanel();
    log('Kernel', `${kernelSourceLabel(kernel?.source)} ${kernel?.version || ''} · ${kernel?.path || ''}`);
  } catch (error) {
    const message = error?.message || String(error);
    if (progress) progress.textContent = tx('内置内核不可用：') + message;
    toast(tx('内置内核不可用：') + message);
  } finally {
    if (btn) btn.disabled = false;
  }
});
document.getElementById('kernel-check-update')?.addEventListener('click', async () => {
  const progress = document.getElementById('kernel-progress');
  try {
    if (progress) progress.textContent = tx('查询 Google Chrome Stable 版本…');
    const result = await window.ops.kernelCheckUpdate();
    if (result.error) {
      toast(tx('内置内核：') + result.error);
      if (progress) progress.textContent = tx('内置内核：') + result.error;
      return;
    }
    const remote = result.remote;
    const installed = result.installed;
    if (!installed && !remote) {
      toast(tx('未找到内置内核'));
      return;
    }
    const ver = installed?.version || remote?.version || '';
    const src = kernelSourceLabel(installed?.source || remote?.source);
    toast(tx(`内核 ${src} v${ver}${result.needsUpdate ? '（有新版本）' : '（已是最新）'}`));
    if (progress) progress.textContent = tx(`内核 ${src} · ${ver}${result.needsUpdate ? ' · 可下载更新' : ' · 已是最新'}`);
    await refreshKernelPanel();
  } catch (error) {
    toast(error.message);
    if (progress) progress.textContent = tx('读取失败：') + error.message;
  }
});
document.getElementById('kernel-choose')?.addEventListener('click', async () => {
  try {
    const result = await window.ops.kernelChooseCustom();
    if (result?.canceled) return;
    const kernel = result.kernel || result;
    const validation = kernel?.validation;
    const progress = document.getElementById('kernel-progress');
    if (validation?.browser) {
      toast(tx(`自定义内核验证通过：${validation.browser}`));
      if (progress) progress.textContent = tx(`兼容性验证通过：${validation.browser}`);
    } else {
      toast(tx('已设置自定义内核'));
    }
    await refreshKernelPanel();
  } catch (error) { toast(error.message); }
});
document.getElementById('kernel-prefer-independent')?.addEventListener('change', async (e) => {
  try {
    await window.ops.kernelPolicy({ preferIndependentKernel: e.target.checked });
    toast(e.target.checked ? tx('已优先独立内核') : tx('已允许使用候选列表第一项'));
  } catch (error) { toast(error.message); }
});
document.getElementById('kernel-allow-system')?.addEventListener('change', async (e) => {
  try {
    const systemBrowser = document.getElementById('kernel-system-browser');
    if (e.target.checked && !systemBrowser?.value) {
      e.target.checked = false;
      toast(tx('请先手动选择回退浏览器'));
      return;
    }
    await window.ops.kernelPolicy({ allowSystemBrowserFallback: e.target.checked });
    toast(e.target.checked
      ? tx('已允许在独立内核不可用时回退本机浏览器')
      : tx('已禁止自动回退本机浏览器'));
    await refreshKernelPanel();
  } catch (error) {
    e.target.checked = !e.target.checked;
    toast(error.message);
  }
});
document.getElementById('kernel-system-browser')?.addEventListener('change', async (e) => {
  try {
    const allow = document.getElementById('kernel-allow-system');
    await window.ops.kernelPolicy({ systemBrowserPath: e.target.value });
    if (allow && !e.target.value) allow.checked = false;
    toast(e.target.value ? tx('已选择手动回退浏览器') : tx('已清除手动回退浏览器'));
    await refreshKernelPanel();
  } catch (error) {
    toast(error.message);
    await refreshKernelPanel();
  }
});

window.refreshKernelPanel = refreshKernelPanel;
window.kernelSourceLabel = kernelSourceLabel;
