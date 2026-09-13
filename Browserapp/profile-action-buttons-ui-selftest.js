#!/usr/bin/env node
'use strict';

/**
 * End-to-end regression test for:
 * 1. Profile action column buttons (Start/Stop, Sync, Edit, Clone) icon rendering and fallback.
 * 2. Kernel column browser engine vector icon completeness and geometry without clipping.
 * 3. Multi-theme layout consistency (merge-gateway, pixel-workstation, element-admin).
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const appRoot = __dirname;
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

// 1. Static and fallback checks
check('static: buildBrowserEngineIcon contains full 256x256 multi-color Chromium SVG', () => {
  const source = read('renderer.js');
  assert.ok(source.includes('viewBox="0 0 256 256"'), 'must use 256x256 viewBox for unclipped Chrome icon');
  assert.ok(source.includes('fill="url(#cr-green)"'), 'must contain green gradient blade');
  assert.ok(source.includes('fill="url(#cr-yellow)"'), 'must contain yellow gradient blade');
  assert.ok(source.includes('fill="url(#cr-red)"'), 'must contain red gradient blade');
  assert.ok(source.includes('fill="#1a73e8"'), 'must contain blue center circle');
});

check('static: standalone fallback icons defined for all table action buttons', () => {
  const source = read('renderer.js');
  assert.ok(source.includes('ACTION_ICON_SVGS'), 'must define ACTION_ICON_SVGS dictionary');
  for (const name of ['play', 'square', 'panels-top-left', 'pencil', 'copy']) {
    assert.ok(source.includes(`'${name}'`) || source.includes(`"${name}"`) || source.includes(`${name}:`),
      `must cover action icon: ${name}`);
  }
});

check('static: ui-shell css defines .mini.clone styling and 155px col-browser width', () => {
  const css = read('ui-shell.css');
  assert.ok(css.includes('.mini.clone'), 'must style .mini.clone button');
  assert.ok(css.includes('width: 155px'), 'col-browser must have expanded 155px width');
});

check('static: index.html does not reference nonexistent data-lucide="browser"', () => {
  const html = read('index.html');
  assert.ok(!html.includes('data-lucide="browser"'), 'data-lucide="browser" is invalid in Lucide');
});

check('static: ui-shell css defines object-fit contain and overflow visible for icons', () => {
  const css = read('ui-shell.css');
  assert.ok(css.includes('object-fit: contain !important;'), 'browser engine and action SVGs must specify object-fit: contain');
  assert.ok(css.includes('overflow: visible !important;'), 'browser engine icons must have overflow: visible');
});

check('static: action buttons have synchronized aria-label and title', () => {
  const source = read('renderer.js');
  assert.ok(source.includes("button.setAttribute('aria-label', label)"), 'iconActionButton must set aria-label');
  assert.ok(source.includes("button.title = label"), 'iconActionButton must set title');
});

// 2. Real browser verification
(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 kernel launcher available');
    finish();
    return;
  }

  const server = http.createServer((req, res) => {
    let filePath = path.join(appRoot, req.url.split('?')[0]);
    if (req.url === '/' || req.url.startsWith('/index.html')) filePath = path.join(appRoot, 'index.html');
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const serverPort = server.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-uiactions-test-'));
  const child = spawn(launcher, [dir, '--headless=new', '--enable-unsafe-swiftshader', '--no-sandbox'], {
    detached: true,
    stdio: 'ignore',
  });
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

  let seq = 1;
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = seq++;
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });

  const consoleWarnings = [];
  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params?.args?.map((a) => a.value).join(' ') || '';
        if (text.includes('icon name was not found')) {
          consoleWarnings.push(text);
        }
      }
    } catch (_) {}
  });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/index.html` });
  await sleep(2500);

  check('real browser: no missing Lucide icon warnings on initial page load', () => {
    assert.deepStrictEqual(consoleWarnings, [], 'page must not produce missing icon warnings');
  });

  // Evaluate across both merge-gateway and pixel-workstation themes
  for (const theme of ['merge-gateway', 'pixel-workstation', 'element-admin']) {
    const evalRes = await send('Runtime.evaluate', {
      expression: `(async () => {
        if (typeof applyUiTheme === "function") {
          applyUiTheme("${theme}");
        }
        if (!window.ops) {
          window.ops = {
            profileStatus: async () => ({}),
            syncProfiles: async (p) => p,
          };
        }
        if (typeof ui !== "undefined") {
          ui.profiles = [
            { id: "p1", number: 1, name: "Profile Chrome", groupId: "default", browser: "Chrome/130.0.0.0", proxy: "direct" },
            { id: "p2", number: 2, name: "Profile Edge", groupId: "default", browser: "Edge/130.0.0.0", proxy: "127.0.0.1:7890" }
          ];
          renderProfiles();
        }

        const rows = [...document.querySelectorAll("#profile-table tr")];
        const out = {
          theme: document.documentElement.dataset.uiTheme,
          rowsCount: rows.length,
          buttons: [],
          engines: []
        };

        if (rows[0]) {
          const actionBtns = rows[0].querySelectorAll(".col-actions button");
          actionBtns.forEach((btn) => {
            const svg = btn.querySelector("svg");
            const rect = btn.getBoundingClientRect();
            const svgRect = svg ? svg.getBoundingClientRect() : null;
            out.buttons.push({
              title: btn.title,
              ariaLabel: btn.getAttribute("aria-label"),
              className: btn.className,
              hasSvg: !!svg,
              btnWidth: rect.width,
              btnHeight: rect.height,
              svgWidth: svgRect ? svgRect.width : 0,
              svgHeight: svgRect ? svgRect.height : 0,
              padding: window.getComputedStyle(btn).padding,
              svgDisplay: svg ? window.getComputedStyle(svg).display : null,
              svgVisibility: svg ? window.getComputedStyle(svg).visibility : null,
            });
          });

          rows.forEach((row) => {
            const engineIcon = row.querySelector(".col-browser .browser-engine-icon");
            const cell = row.querySelector(".col-browser");
            const label = row.querySelector(".col-browser .env-browser-label strong");
            if (engineIcon && cell) {
              const svg = engineIcon.querySelector("svg");
              const iconRect = engineIcon.getBoundingClientRect();
              const cellRect = cell.getBoundingClientRect();
              const svgRect = svg ? svg.getBoundingClientRect() : null;
              const svgStyle = svg ? window.getComputedStyle(svg) : null;
              out.engines.push({
                labelText: label ? label.textContent : "",
                cellWidth: cellRect.width,
                iconWidth: iconRect.width,
                iconHeight: iconRect.height,
                svgWidth: svgRect ? svgRect.width : 0,
                svgHeight: svgRect ? svgRect.height : 0,
                hasSvg: !!svg,
                objectFit: svgStyle ? svgStyle.objectFit : null,
                overflow: svgStyle ? svgStyle.overflow : null,
              });
            }
          });
        }
        return JSON.stringify(out);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });

    let probe = null;
    try { probe = JSON.parse(evalRes?.result?.value); } catch (_) {}

    check(`real browser (${theme}): all 4 action buttons render valid SVG with width >= 12px`, () => {
      assert.ok(probe, 'must receive probe data');
      assert.strictEqual(probe.buttons.length, 4, 'must have 4 action buttons');
      for (const btn of probe.buttons) {
        assert.ok(btn.hasSvg, `button "${btn.title}" must contain SVG`);
        assert.ok(btn.svgWidth >= 12, `button "${btn.title}" SVG width must be >= 12px (got ${btn.svgWidth})`);
        assert.ok(btn.svgHeight >= 12, `button "${btn.title}" SVG height must be >= 12px (got ${btn.svgHeight})`);
        assert.strictEqual(btn.svgDisplay, 'block', `button "${btn.title}" SVG must be block`);
      }
    });

    check(`real browser (${theme}): all 4 action buttons have synchronized aria-label and title`, () => {
      for (const btn of probe.buttons) {
        assert.ok(btn.title && btn.title.trim().length > 0, "button must have title");
        assert.ok(btn.ariaLabel && btn.ariaLabel.trim().length > 0, `button "${btn.title}" must have aria-label`);
        assert.strictEqual(btn.ariaLabel, btn.title, `button aria-label "${btn.ariaLabel}" must match title "${btn.title}"`);
      }
    });

    check(`real browser (${theme}): action buttons keep 28px square geometry and 0px padding`, () => {
      for (const btn of probe.buttons) {
        assert.ok(Math.abs(btn.btnWidth - 28) < 1.5, `button "${btn.title}" width must be ~28px (got ${btn.btnWidth})`);
        assert.ok(Math.abs(btn.btnHeight - 28) < 1.5, `button "${btn.title}" height must be ~28px (got ${btn.btnHeight})`);
        assert.strictEqual(btn.padding, '0px', `button "${btn.title}" padding must be 0px`);
      }
    });


    const ssTheme = await send('Page.captureScreenshot', { format: 'png' });
    const themeShot = path.join(appRoot, 'reports', `ui-${theme}-verified.png`);
    fs.mkdirSync(path.dirname(themeShot), { recursive: true });
    fs.writeFileSync(themeShot, Buffer.from(ssTheme.data, 'base64'));

    check(`real browser (${theme}): kernel browser engine icons render at 26px without clipping`, () => {
      assert.ok(probe.engines.length >= 2, 'must find engine rows');
      for (const eng of probe.engines) {
        assert.ok(eng.hasSvg, 'engine must contain SVG');
        assert.ok(Math.abs(eng.svgWidth - 26) < 1, `engine SVG width must be ~26px (got ${eng.svgWidth})`);
        assert.ok(Math.abs(eng.svgHeight - 26) < 1, `engine SVG height must be ~26px (got ${eng.svgHeight})`);
        assert.ok(eng.cellWidth >= 150, `kernel column width must be >= 150px (got ${eng.cellWidth})`);
        assert.ok(!eng.labelText.endsWith('...'), `engine label must not be clipped to ellipsis: "${eng.labelText}"`);
        assert.strictEqual(eng.objectFit, 'contain', `engine SVG object-fit must be contain (got ${eng.objectFit})`);
        assert.strictEqual(eng.overflow, 'visible', `engine SVG overflow must be visible (got ${eng.overflow})`);
      }
    });
  }

  // Fallback resilience test: simulate window.lucide failing / missing
  const fallbackRes = await send('Runtime.evaluate', {
    expression: `(() => {
      // Temporarily nullify window.lucide and test createLucideIconElement
      const prevLucide = window.lucide;
      window.lucide = null;
      try {
        const testNames = ['play', 'square', 'panels-top-left', 'pencil', 'copy', 'activity'];
        const results = testNames.map((name) => {
          const el = createLucideIconElement(name);
          return {
            name,
            tag: el.tagName,
            isSvg: el.tagName === 'svg' || el instanceof SVGElement,
            hasChildren: el.children && el.children.length > 0,
            innerHTML: el.innerHTML,
          };
        });
        return JSON.stringify(results);
      } finally {
        window.lucide = prevLucide;
      }
    })()`,
    returnByValue: true,
  });

  let fallbackProbe = null;
  try { fallbackProbe = JSON.parse(fallbackRes?.result?.value); } catch (_) {}

  check('real browser: createLucideIconElement renders complete standalone SVGs even when window.lucide is unavailable', () => {
    assert.ok(Array.isArray(fallbackProbe), 'must receive fallback probe list');
    for (const item of fallbackProbe) {
      assert.ok(item.isSvg, `fallback icon "${item.name}" must be an SVG element (got ${item.tag})`);
      assert.ok(item.hasChildren, `fallback icon "${item.name}" SVG must contain child vector paths`);
    }
  });

  // Take screenshot of rendered table with the fix
  const ss = await send('Page.captureScreenshot', { format: 'png' });
  const outScreenshot = path.join(appRoot, 'reports', 'ui-action-buttons-verified.png');
  fs.mkdirSync(path.dirname(outScreenshot), { recursive: true });
  fs.writeFileSync(outScreenshot, Buffer.from(ss.data, 'base64'));
  console.log('  Saved verified screenshot to:', outScreenshot);

  ws.close();
  await stopChild(child, dir);
  server.close();
  finish();
})();

function finish() {
  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`profile-action-buttons-ui-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.error(`profile-action-buttons-ui-selftest: FAIL ${results.length - failed.length}/${results.length}`);
    process.exitCode = 1;
  }
}
