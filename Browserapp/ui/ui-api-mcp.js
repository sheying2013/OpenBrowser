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

// ========== API & MCP (local-only) ==========
function shellQuote(value) {
  return "'" + String(value ?? '').replace(/'/g, "'\\''") + "'";
}

async function refreshApiMcpPage() {
  const pill = document.getElementById('api-conn-pill');
  const urlEl = document.getElementById('api-status-url');
  const keyEl = document.getElementById('api-key-display');
  const mcpTa = document.getElementById('mcp-config-json');
  const mcpHint = document.getElementById('mcp-cmd-hint');
  const curlHint = document.getElementById('api-curl-hint');
  const keyNote = document.getElementById('mcp-key-note');
  try {
    const info = await window.ops.localApiInfo();
    const paths = await window.ops.mcpPaths();
    const port = info?.port || paths?.port || 50325;
    const base = (info?.url || ('http://127.0.0.1:' + port + '/')).replace(/\/?$/, '/');
    const apiKey = paths?.apiKey || '';
    const apiKeyFile = paths?.apiKeyFile || '';
    if (pill) {
      pill.textContent = info ? tx('运行中') : tx('未启动');
      pill.classList.toggle('off', !info);
    }
    if (urlEl) urlEl.textContent = base.replace(/\/$/, '');
    if (keyEl) keyEl.value = apiKey;
    if (keyEl && !apiKey) keyEl.placeholder = tx('未设置（可选环境变量 OPENBROWSER_API_KEY）');
    const mcpScript = paths?.mcpScript || '';
    const keyPlaceholder = apiKey || '<从上方 API Key 框复制>';
    // Do not put a placeholder in OPENBROWSER_API_KEY when a key file exists:
    // the MCP process treats any non-empty env key as authoritative and would
    // ignore the valid file, producing a misleading 401.
    const authEnv = apiKey
      ? { API_KEY: apiKey, OPENBROWSER_API_KEY: apiKey }
      : (apiKeyFile ? { OPENBROWSER_API_KEY_FILE: apiKeyFile } : {});
    if (keyNote) {
      keyNote.textContent = apiKey
        ? '配置已写入当前 API Key。如要限制 AI 权限，请在 MCP 环境变量中追加 OPENBROWSER_MCP_MODE=manage|run|read（可选黑/白名单）。'
        : (apiKeyFile
          ? 'MCP 配置会从本机 key 文件读取鉴权；如迁移到另一台电脑，请同时迁移该文件或改填 API Key。'
          : '未取到 API Key：请先从上方 API Key 框复制，再手动填入下方配置；否则 MCP 会返回 401。');
    }
    // A busy default port makes the API move; say so instead of letting the
    // user wonder why the generated config no longer mentions the default.
    if (keyNote && info?.portFallback) {
      keyNote.textContent += ' ' + tx('默认端口已被占用，本地 API 已自动改用实际端口；下方配置与命令均按实际端口生成。');
    }
    const common = {
      mcpServers: {
        'openbrowser-local-api': {
          command: 'node',
          args: [mcpScript],
          env: {
            PORT: String(port),
            OPENBROWSER_API_PORT: String(port),
            ...authEnv,
          },
        },
      },
    };
    window.__mcpConfigCommon = common;
    window.__mcpConfigPlatform = {
      mcpServers: {
        'openbrowser-local-api': {
          command: 'node',
          args: [mcpScript],
          env: {
            OPENBROWSER_API_PORT: String(port),
            ...authEnv,
          },
        },
      },
    };
    const tab = document.querySelector('#mcp-config-tabs button.active')?.dataset.mcpTab || 'common';
    if (mcpTa) mcpTa.textContent = JSON.stringify(tab === 'platform' ? window.__mcpConfigPlatform : window.__mcpConfigCommon, null, 2);
    if (mcpHint) {
      const keyEnv = apiKey
        ? ' OPENBROWSER_API_KEY=' + shellQuote(apiKey)
        : (apiKeyFile ? ' OPENBROWSER_API_KEY_FILE=' + shellQuote(apiKeyFile) : ' OPENBROWSER_API_KEY=' + shellQuote(keyPlaceholder));
      mcpHint.textContent = 'OPENBROWSER_API_PORT=' + shellQuote(port) + keyEnv + ' node ' + shellQuote(mcpScript);
    }
    if (curlHint) curlHint.textContent = 'curl -s -H ' + shellQuote('api-key: ' + keyPlaceholder) + ' ' + shellQuote(base + 'api/getVersion');
    setLocalApiStatus(!!info);
  } catch (error) {
    if (pill) { pill.textContent = tx('未启动'); pill.classList.add('off'); }
    setLocalApiStatus(false);
  }
  afterUiRender(document.getElementById('view-api-mcp') || document);
}

function setLocalApiStatus(running) {
  const hint = document.getElementById('sidebar-api-hint');
  const card = document.getElementById('local-status-card');
  if (hint) hint.textContent = running ? tx('本地运行中') : tx('服务未启动');
  if (card) card.classList.toggle('is-off', !running);
}

document.getElementById('api-refresh')?.addEventListener('click', refreshApiMcpPage);
document.getElementById('api-copy-base')?.addEventListener('click', async () => {
  const url = document.getElementById('api-status-url')?.textContent || '';
  try { await navigator.clipboard.writeText(url); toast(tx('已复制')); } catch (_) { toast(url); }
});
document.getElementById('api-open-version')?.addEventListener('click', async () => {
  const out = document.getElementById('api-test-output');
  try {
    const result = await window.ops.localApiVersion();
    if (out) out.textContent = JSON.stringify(result, null, 2);
    toast(tx('接口正常'));
  } catch (error) {
    if (out) out.textContent = String(error);
    toast('请求失败：' + error.message);
  }
});
document.getElementById('api-copy-curl')?.addEventListener('click', async () => {
  const text = document.getElementById('api-curl-hint')?.textContent || '';
  try { await navigator.clipboard.writeText(text); toast(tx('已复制')); } catch (_) {}
});
document.getElementById('mcp-copy-config')?.addEventListener('click', async () => {
  const text = document.getElementById('mcp-config-json')?.textContent || '';
  try { await navigator.clipboard.writeText(text); toast(tx('已复制 MCP 配置')); } catch (_) {}
});
document.getElementById('mcp-copy-cmd')?.addEventListener('click', async () => {
  const text = document.getElementById('mcp-cmd-hint')?.textContent || '';
  try { await navigator.clipboard.writeText(text); toast(tx('已复制命令')); } catch (_) {}
});
document.getElementById('api-key-rotate')?.addEventListener('click', async () => {
  const approved = await app.confirmAction?.({
    title: tx('重新生成 API Key'),
    message: tx('重新生成 API Key？本地 mcp-key.json 会立即更新，使用此 Key 的 MCP 客户端需要同步更新。'),
    confirmLabel: tx('重新生成'),
    tone: 'danger',
  });
  if (!approved) return;
  try {
    const res = await window.ops.rotateApiKey();
    if (res?.apiKey) {
      const keyInput = document.getElementById('api-key-display');
      if (keyInput) keyInput.value = res.apiKey;
      toast(tx('已重新生成，请把新 Key 同步到 MCP 客户端配置'));
      if (typeof refreshApiMcpPage === 'function') await refreshApiMcpPage();
    }
  } catch (err) {
    toast(tx('重新生成失败：') + err.message);
  }
});
document.getElementById('mcp-config-tabs')?.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-mcp-tab]');
  if (!btn) return;
  document.querySelectorAll('#mcp-config-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  const tab = btn.dataset.mcpTab;
  const mcpTa = document.getElementById('mcp-config-json');
  if (mcpTa) mcpTa.textContent = JSON.stringify(tab === 'platform' ? window.__mcpConfigPlatform : window.__mcpConfigCommon, null, 2);
});

window.ops.onEvent((value) => {
  if (value?.type === 'rpa-log') window.appendRpaLog?.((value.level || 'info') + ': ' + value.message);
  if (value?.type === 'rpa-task') {
    window.appendRpaLog?.('task ' + value.taskId + ' → ' + value.status + (value.message ? ' · ' + value.message : ''));
    window.refreshRpaStatusBadge?.();
    window.refreshRpaTasks?.();
    window.refreshRpaRuns?.();
  }
  if (value?.type === 'local-api') {
    setLocalApiStatus(true);
  }
});

window.refreshApiMcpPage = refreshApiMcpPage;
window.setLocalApiStatus = setLocalApiStatus;
})();
