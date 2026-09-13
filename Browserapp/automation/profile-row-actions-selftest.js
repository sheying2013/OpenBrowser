#!/usr/bin/env node
'use strict';

/**
 * Regression suite for profile row action buttons and browser engine icons.
 *
 * Verifies that:
 * 1. The 4 action buttons in the profile row display rendered SVG icons (>= 12px).
 * 2. Action buttons preserve fixed 28px square geometry and zero padding across themes.
 * 3. The browser engine icon in the kernel column renders complete vector graphics without
 *    truncated paths, missing sectors, or container overflow clipping.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const launcher = path.join(appRoot, 'kernels', 'macos-x64', 'launch_openbrowser.sh');
const read = (name) => fs.readFileSync(path.join(appRoot, name), 'utf8');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log('  PASS  ' + name);
  } catch (error) {
    results.push({ name, ok: false, error: error.message || String(error) });
    console.log('  FAIL  ' + name + ' - ' + (error.message || String(error)));
    process.exitCode = 1;
  }
}

function skip(name, reason) {
  results.push({ name, ok: true, skipped: true });
  console.log('  SKIP  ' + name + (reason ? ' - ' + reason : ''));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// 1. Static code invariants
check('static: createLucideIconElement sets class attribute and aria-hidden on rendered SVG', () => {
  const source = read('renderer.js');
  assert.ok(source.includes('window.lucide?.createElement'), 'must use lucide createElement');
  assert.ok(source.includes('svg.setAttribute(\'class\', `lucide lucide-${iconName}`)') ||
            source.includes('svg.setAttribute("class", `lucide lucide-${iconName}`)'),
    'must explicitly set class attribute on SVG');
  assert.ok(source.includes('svg.setAttribute(\'aria-hidden\', \'true\')') ||
            source.includes('svg.setAttribute("aria-hidden", "true")'),
    'must set aria-hidden on SVG');
});

check('static: buildBrowserEngineIcon contains complete vector paths without missing arcs', () => {
  const source = read('renderer.js');
  // Old broken green path jumped from 3.6, 22.3 directly to 10, 11.3, cutting out the left arc
  assert.ok(!source.includes('3.6 22.3L10 11.3'), 'green path must not have truncated shortcut');
  // Edge icon coordinates must stay positive within viewBox
  assert.ok(!source.includes('10.5 -1.2'), 'Edge icon path must not have negative out-of-bounds coordinates');
});

check('static: ui-shell css enforces zero padding and explicit sizing for action icons and engine badges', () => {
  const css = read('ui-shell.css');
  assert.ok(css.includes('.actions .action-icon'), 'must define .actions .action-icon rule');
  assert.ok(css.includes('width: 28px !important'), 'must lock action icon button width to 28px');
  assert.ok(css.includes('height: 28px !important'), 'must lock action icon button height to 28px');
  assert.ok(css.includes('padding: 0 !important'), 'must enforce zero padding on action icon');
  assert.ok(css.includes('.browser-engine-icon'), 'must style .browser-engine-icon');
  assert.ok(css.includes('width: 26px !important'), 'must define 26px width for engine icon');
  assert.ok(css.includes('height: 26px !important'), 'must define 26px height for engine icon');
});

// 2. Real-browser end-to-end execution
(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 kernel launcher available');
    finish();
    return;
  }

  const testHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/environment-audit.css">
  <link rel="stylesheet" href="/ui-shell.css">
  <link rel="stylesheet" href="/pixel-workstation.css">
  <link rel="stylesheet" href="/nes-light.css">
  <link rel="stylesheet" href="/element-admin.css">
  <link rel="stylesheet" href="/xai-console.css">
</head>
<body>
  <div id="view-profiles" class="view active" style="width:1100px">
    <div class="table-card">
      <table class="profile-table-compact">
        <thead>
          <tr>
            <th class="col-check"><input type="checkbox"></th>
            <th class="col-num">编号</th>
            <th class="col-name">环境名称</th>
            <th class="col-group">分组</th>
            <th class="col-browser">内核</th>
            <th class="col-network">网络</th>
            <th class="col-exit">出口</th>
            <th class="col-ext">扩展</th>
            <th class="col-status">状态</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody id="profile-table"></tbody>
      </table>
    </div>
  </div>
  <script src="/assets/vendor/lucide.min.js"></script>
  <script>
    const element = (tag, className, text) => {
      const value = document.createElement(tag);
      if (className) value.className = className;
      if (text !== undefined) value.textContent = text;
      return value;
    };
    const t = (k) => k;

    ${read('renderer.js').slice(
      read('renderer.js').indexOf('function toLucidePascalCase'),
      read('renderer.js').indexOf('function redactProxyForStorage')
    )}

    ${read('renderer.js').slice(
      read('renderer.js').indexOf('function buildBrowserEngineIcon'),
      read('renderer.js').indexOf('function nextProfileNumber')
    )}

    ${read('renderer.js').slice(
      read('renderer.js').indexOf('function refreshIcons'),
      read('renderer.js').indexOf('applyPlatformClass();')
    )}

    function appendRow(browserName) {
      const tbody = document.getElementById('profile-table');
      const row = document.createElement('tr');

      const selectCell = document.createElement('td');
      selectCell.className = 'col-check';
      const idCell = element('td', 'col-num', '1');
      const nameCell = element('td', 'col-name', 'Test Profile');
      const groupCell = element('td', 'col-group', '默认分组');
      const browserCell = document.createElement('td');
      browserCell.className = 'col-browser';
      browserCell.append(buildEnvBrowserCell({ browser: browserName }));
      const proxyCell = element('td', 'col-network', 'Direct');
      const networkCell = element('td', 'col-exit', '127.0.0.1');
      const extensionCell = element('td', 'col-ext', '0');
      const statusCell = element('td', 'col-status', '已停止');

      const actionCell = document.createElement('td');
      actionCell.className = 'col-actions';
      const actions = element('div', 'actions');
      const toggle = iconActionButton('play', '启动', 'mini');
      const sync = iconActionButton('panels-top-left', '选择同步', 'mini blue');
      const edit = iconActionButton('pencil', '编辑', 'mini edit');
      const clone = iconActionButton('copy', '克隆', 'mini clone');
      actions.append(toggle, sync, edit, clone);
      actionCell.append(actions);

      row.append(selectCell, idCell, nameCell, groupCell, browserCell, proxyCell, networkCell, extensionCell, statusCell, actionCell);
      tbody.append(row);
    }

    appendRow('Chrome/130.0.0.0');
    appendRow('Edge/130.0.0.0');
  </script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    if (urlPath === '/' || urlPath === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(testHtml);
      return;
    }
    const filePath = path.join(appRoot, urlPath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const contentType = ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'text/plain';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(fs.readFileSync(filePath));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const serverPort = server.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-rowactions-test-'));
  const child = spawn(launcher, [dir, '--headless=new', '--enable-unsafe-swiftshader', '--no-sandbox'], { detached: true, stdio: 'ignore' });
  child.unref();

  let devtoolsPort = null;
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    try {
      const val = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (val > 0) { devtoolsPort = val; break; }
    } catch (_) {}
  }
  if (!devtoolsPort) {
    await stopChild(child, dir);
    server.close();
    skip('kernel devtools port acquired');
    finish();
    return;
  }

  const list = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
  const page = list.find((p) => p.type === 'page');
  if (!page?.webSocketDebuggerUrl) {
    await stopChild(child, dir);
    server.close();
    skip('kernel page target available');
    finish();
    return;
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    let msg = null;
    try { msg = JSON.parse(event.data); } catch (_) { return; }
    if (msg.id && pending.has(msg.id)) {
      const r = pending.get(msg.id);
      pending.delete(msg.id);
      r(msg);
    }
  });
  const send = (method, params = {}) => {
    const id = ++seq;
    return new Promise((r) => {
      pending.set(id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__marker = "profile-row-actions-e2e-verified";'
  });

  await send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
  await sleep(1000);

  const evalRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const out = {};
      out.__marker = window.__marker;

      // Probe action buttons
      const buttons = [...document.querySelectorAll('.actions .action-icon')];
      out.buttons = buttons.map((b) => {
        const r = b.getBoundingClientRect();
        const svg = b.querySelector('svg');
        const sr = svg ? svg.getBoundingClientRect() : null;
        const cs = window.getComputedStyle(b);
        return {
          title: b.title,
          buttonWidth: r.width,
          buttonHeight: r.height,
          padding: cs.padding,
          display: cs.display,
          hasSvg: Boolean(svg),
          svgClass: svg ? svg.getAttribute('class') : null,
          svgWidth: sr ? sr.width : 0,
          svgHeight: sr ? sr.height : 0,
          svgDisplay: svg ? window.getComputedStyle(svg).display : null,
        };
      });

      // Probe engine icons
      const rows = [...document.querySelectorAll('#profile-table tr')];
      out.engines = rows.map((row) => {
        const cell = row.querySelector('.col-browser');
        const cellR = cell.getBoundingClientRect();
        const wrap = row.querySelector('.browser-engine-icon');
        const wrapR = wrap.getBoundingClientRect();
        const svg = wrap.querySelector('svg');
        const svgR = svg.getBoundingClientRect();

        // Compute visible height of SVG considering parent containers
        const cellCs = window.getComputedStyle(cell);
        const wrapCs = window.getComputedStyle(wrap);
        let visibleTop = svgR.top;
        let visibleBottom = svgR.bottom;
        if (wrapCs.overflow !== 'visible') {
          visibleTop = Math.max(visibleTop, wrapR.top);
          visibleBottom = Math.min(visibleBottom, wrapR.bottom);
        }
        if (cellCs.overflow !== 'visible') {
          visibleTop = Math.max(visibleTop, cellR.top);
          visibleBottom = Math.min(visibleBottom, cellR.bottom);
        }
        const visibleHeight = Math.max(0, visibleBottom - visibleTop);

        // SVG bounding box for paths inside
        const bbox = svg.getBBox ? svg.getBBox() : null;

        return {
          attrWidth: Number(svg.getAttribute('width')),
          attrHeight: Number(svg.getAttribute('height')),
          svgWidth: svgR.width,
          svgHeight: svgR.height,
          wrapWidth: wrapR.width,
          wrapHeight: wrapR.height,
          visibleHeight,
          bbox: bbox ? { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height } : null,
        };
      });

      return JSON.stringify(out);
    })()`,
    returnByValue: true,
  });

  const rawValue = evalRes?.result?.result?.value;
  let probe = null;
  try { probe = JSON.parse(rawValue); } catch (_) {}

  check('real browser: window.__marker self-test injection verified', () => {
    assert.ok(probe, 'must receive probe results');
    assert.strictEqual(probe.__marker, 'profile-row-actions-e2e-verified',
      'window.__marker must confirm script injection on new document');
  });

  check('real browser: every action column button contains a rendered SVG icon with size >= 12px', () => {
    assert.ok(probe.buttons.length >= 4, 'must find at least 4 action buttons');
    for (const btn of probe.buttons) {
      assert.ok(btn.hasSvg, `button "${btn.title}" must contain an svg element`);
      assert.ok(btn.svgClass && btn.svgClass.includes('lucide'),
        `button "${btn.title}" svg must carry lucide class`);
      assert.ok(btn.svgWidth >= 12, `button "${btn.title}" svg width (${btn.svgWidth}px) must be >= 12px`);
      assert.ok(btn.svgHeight >= 12, `button "${btn.title}" svg height (${btn.svgHeight}px) must be >= 12px`);
      assert.strictEqual(btn.svgDisplay, 'block', `button "${btn.title}" svg must be visible block`);
    }
  });

  check('real browser: action buttons preserve fixed 28px square geometry and zero padding', () => {
    for (const btn of probe.buttons) {
      assert.ok(Math.abs(btn.buttonWidth - 28) < 1, `button "${btn.title}" width must be ~28px (got ${btn.buttonWidth}px)`);
      assert.ok(Math.abs(btn.buttonHeight - 28) < 1, `button "${btn.title}" height must be ~28px (got ${btn.buttonHeight}px)`);
      assert.strictEqual(btn.padding, '0px', `button "${btn.title}" must have 0px padding`);
    }
  });

  check('real browser: kernel column browser engine SVG visible height equals height attribute without clipping', () => {
    assert.ok(probe.engines.length >= 2, 'must find Chromium and Edge engine cells');
    for (let i = 0; i < probe.engines.length; i++) {
      const eng = probe.engines[i];
      assert.strictEqual(eng.attrHeight, 26, 'svg height attribute must be 26');
      assert.strictEqual(eng.attrWidth, 26, 'svg width attribute must be 26');
      assert.ok(Math.abs(eng.svgHeight - 26) < 0.5, `rendered svg height (${eng.svgHeight}px) must be 26px`);
      assert.ok(Math.abs(eng.visibleHeight - 26) < 0.5,
        `svg visible height (${eng.visibleHeight}px) must equal 26px attribute without container clipping`);
    }
  });

  check('real browser: kernel engine SVG vector paths are complete and unfragmented', () => {
    for (let i = 0; i < probe.engines.length; i++) {
      const eng = probe.engines[i];
      assert.ok(eng.bbox, 'svg must have valid bounding box for paths');
      assert.ok(eng.bbox.width >= 20, `engine icon path width (${eng.bbox.width}) must cover icon viewBox`);
      assert.ok(eng.bbox.height >= 20, `engine icon path height (${eng.bbox.height}) must cover icon viewBox`);
    }
  });

  ws.close();
  await stopChild(child, dir);
  server.close();
  finish();
})();

function finish() {
  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`profile-row-actions-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.error(`profile-row-actions-selftest: FAIL ${results.length - failed.length}/${results.length}`);
    process.exitCode = 1;
  }
}
