#!/usr/bin/env node
'use strict';

/**
 * End-to-end selftest for CSS @font-face local() dynamic path mitigation.
 *
 * Verifies that the CSS font local gate:
 * 1. Blocks foreign local() font leaks across all dynamic pathways:
 *    - style.textContent and style.innerHTML
 *    - Node.prototype.appendChild and Element.prototype.replaceChildren with Text nodes
 *    - CSSStyleSheet.prototype.insertRule
 *    - CSSStyleSheet.prototype.replaceSync and replace
 *    - constructable stylesheets in adoptedStyleSheets
 *    - dynamic <link rel="stylesheet"> with data:text/css URI
 *    - dynamic <link rel="stylesheet"> with blob: URL
 * 2. Allows whitelisted persona local fonts (e.g. Arial, Segoe UI on Windows persona),
 *    supplying authentic platform WOFF2 subsets so cross-platform runs succeed.
 * 3. Preserves custom web fonts (data: URI and HTTP URL) and mixed source fallbacks.
 * 4. Verifies native-like function wrapping and prototype integrity (HTMLLinkElement, URL, CSSStyleSheet).
 * 5. Accurately records known kernel-level bypasses (static HTML parser <style>, <link rel=stylesheet>) as KNOWN GAP.
 * 6. Supports --mutate flag to verify test sensitivity by confirming foreign local font leaks when gate is disabled.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildFingerprint, buildInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const { buildCssFontLocalGateSource } = require('./css-font-local-gate');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const fontPath = path.join(appRoot, 'assets', 'font-subsets', 'windows', 'segoe-ui.woff2');

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const isMutateMode = process.argv.includes('--mutate');

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
};

const checkKnownGap = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true, gap: true });
    console.log(`  KNOWN GAP (CONFIRMED)  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, gap: true });
    console.log(`  KNOWN GAP UNEXPECTED  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
};

const skip = (name, why) => {
  results.push({ name, ok: true });
  console.log(`  SKIP  ${name}${why ? ' - ' + why : ''}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.id && this.pending.has(message.id)) {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve(message);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: 'CDP timeout: ' + method } });
      }, 30000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  call(method, params = {}) { return this.send(method, params); }
  async value(expression) {
    const message = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const exception = message?.result?.exceptionDetails;
    if (exception) return { error: (exception.exception && exception.exception.description) || exception.text || JSON.stringify(exception) };
    const raw = message?.result?.result?.value;
    try { return JSON.parse(raw); } catch (_) { return { error: 'probe parse', raw: String(raw).slice(0, 240) }; }
  }
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync('pkill -f "user-data-dir=' + dir + '" 2>/dev/null || true'); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function waitForPage(port, timeoutMs = 16000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = (list || []).find((item) => item.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (_) {}
    await sleep(200);
  }
  return null;
}

function startServer(fontBuf) {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/subset.woff2') {
      res.setHeader('Content-Type', 'font/woff2');
      res.end(fontBuf);
      return;
    }
    if (req.url === '/static-style.css') {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.end('@font-face { font-family: "p_ext_link"; src: local("Helvetica Neue"); }');
      return;
    }
    if (req.url === '/static-probe.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Static Parser Style Probe</title>
  <style>
    @font-face { font-family: "p_html_parser"; src: local("Helvetica Neue"); }
  </style>
  <link rel="stylesheet" href="/static-style.css">
</head>
<body>
  <h1>Static Parser Test</h1>
</body>
</html>`);
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>Dynamic Probe Host</title></head><body><main>Dynamic Probe Host</main></body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function buildDynamicProbeScript(fontB64, serverPort) {
  return `(async () => {
    const out = {
      path1_textContent: {},
      path1_innerHTML: {},
      path2_appendChild: {},
      path2_replaceChildren: {},
      path3_insertRule: {},
      path4_replaceSync: {},
      path4_replace: {},
      path5_adoptedStyleSheets: {},
      positiveControl: {},
      dynamicDataLink: {},
      dynamicBlobLink: {},
      tamperingDetections: {}
    };

    // 1. Path 1: style.textContent & innerHTML
    try {
      const s1 = document.createElement("style");
      s1.textContent = '@font-face { font-family: "p_tc_helv"; src: local("Helvetica Neue"); }';
      document.head.appendChild(s1);
      out.path1_textContent.helv = await document.fonts.load('16px "p_tc_helv"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path1_textContent.helv = "EX:" + e.name; }

    try {
      const s1_a = document.createElement("style");
      s1_a.textContent = '@font-face { font-family: "p_tc_arial"; src: local("Arial"); }';
      document.head.appendChild(s1_a);
      out.path1_textContent.arial = await document.fonts.load('16px "p_tc_arial"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path1_textContent.arial = "EX:" + e.name; }

    try {
      const s1_s = document.createElement("style");
      s1_s.textContent = '@font-face { font-family: "p_tc_segoe"; src: local("Segoe UI"); }';
      document.head.appendChild(s1_s);
      out.path1_textContent.segoe = await document.fonts.load('16px "p_tc_segoe"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path1_textContent.segoe = "EX:" + e.name; }

    try {
      const s1_in_h = document.createElement("style");
      s1_in_h.innerHTML = '@font-face { font-family: "p_in_helv"; src: local("Helvetica Neue"); }';
      document.head.appendChild(s1_in_h);
      out.path1_innerHTML.helv = await document.fonts.load('16px "p_in_helv"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path1_innerHTML.helv = "EX:" + e.name; }

    try {
      const s1_in_a = document.createElement("style");
      s1_in_a.innerHTML = '@font-face { font-family: "p_in_arial"; src: local("Arial"); }';
      document.head.appendChild(s1_in_a);
      out.path1_innerHTML.arial = await document.fonts.load('16px "p_in_arial"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path1_innerHTML.arial = "EX:" + e.name; }

    // 2. Path 2: Text node appendChild & replaceChildren
    try {
      const s2_ac = document.createElement("style");
      const t2_ac = document.createTextNode('@font-face { font-family: "p_ac_helv"; src: local("Helvetica Neue"); }');
      s2_ac.appendChild(t2_ac);
      document.head.appendChild(s2_ac);
      out.path2_appendChild.helv = await document.fonts.load('16px "p_ac_helv"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path2_appendChild.helv = "EX:" + e.name; }

    try {
      const s2_rc = document.createElement("style");
      const t2_rc = document.createTextNode('@font-face { font-family: "p_rc_helv"; src: local("Helvetica Neue"); }');
      s2_rc.replaceChildren(t2_rc);
      document.head.appendChild(s2_rc);
      out.path2_replaceChildren.helv = await document.fonts.load('16px "p_rc_helv"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path2_replaceChildren.helv = "EX:" + e.name; }

    // 3. Path 3: CSSStyleSheet.prototype.insertRule
    try {
      const s3 = document.createElement("style");
      document.head.appendChild(s3);
      s3.sheet.insertRule('@font-face { font-family: "p_ir_helv"; src: local("Helvetica Neue"); }', 0);
      out.path3_insertRule.helv = await document.fonts.load('16px "p_ir_helv"').then(r => r.length, e => "ERR:" + e.name);

      s3.sheet.insertRule('@font-face { font-family: "p_ir_arial"; src: local("Arial"); }', 1);
      out.path3_insertRule.arial = await document.fonts.load('16px "p_ir_arial"').then(r => r.length, e => "ERR:" + e.name);

      s3.sheet.insertRule('@font-face { font-family: "p_ir_segoe"; src: local("Segoe UI"); }', 2);
      out.path3_insertRule.segoe = await document.fonts.load('16px "p_ir_segoe"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path3_insertRule.helv = "EX:" + e.name; }

    // 4. Path 4: CSSStyleSheet replaceSync & replace
    try {
      const s4_sync = new CSSStyleSheet();
      s4_sync.replaceSync('@font-face { font-family: "p_rs_helv"; src: local("Helvetica Neue"); }');
      document.adoptedStyleSheets = [s4_sync];
      out.path4_replaceSync.helv = await document.fonts.load('16px "p_rs_helv"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path4_replaceSync.helv = "EX:" + e.name; }

    try {
      const s4_sync_s = new CSSStyleSheet();
      s4_sync_s.replaceSync('@font-face { font-family: "p_rs_segoe"; src: local("Segoe UI"); }');
      document.adoptedStyleSheets = [s4_sync_s];
      out.path4_replaceSync.segoe = await document.fonts.load('16px "p_rs_segoe"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path4_replaceSync.segoe = "EX:" + e.name; }

    try {
      const s4_async = new CSSStyleSheet();
      await s4_async.replace('@font-face { font-family: "p_ra_helv"; src: local("Helvetica Neue"); }');
      document.adoptedStyleSheets = [s4_async];
      out.path4_replace.helv = await document.fonts.load('16px "p_ra_helv"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path4_replace.helv = "EX:" + e.name; }

    // 5. Path 5: adoptedStyleSheets constructable sheet allowed font
    try {
      const s5 = new CSSStyleSheet();
      s5.replaceSync('@font-face { font-family: "p_ass_arial"; src: local("Arial"); }');
      document.adoptedStyleSheets = [s5];
      out.path5_adoptedStyleSheets.arial = await document.fonts.load('16px "p_ass_arial"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path5_adoptedStyleSheets.arial = "EX:" + e.name; }

    try {
      const s5_s = new CSSStyleSheet();
      s5_s.replaceSync('@font-face { font-family: "p_ass_segoe"; src: local("Segoe UI"); }');
      document.adoptedStyleSheets = [s5_s];
      out.path5_adoptedStyleSheets.segoe = await document.fonts.load('16px "p_ass_segoe"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path5_adoptedStyleSheets.segoe = "EX:" + e.name; }

    // 6. Dynamic data: link stylesheet pathways
    try {
      // 6a: standard rel then href (foreign local)
      const lData = document.createElement("link");
      lData.rel = "stylesheet";
      lData.href = "data:text/css;charset=utf-8," + encodeURIComponent('@font-face { font-family: "p_data_helv"; src: local("Helvetica Neue"); }');
      const pData = new Promise((r) => { lData.onload = r; lData.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lData);
      await pData;
      out.dynamicDataLink.helv = await document.fonts.load('16px "p_data_helv"').then(r => r.length, e => "ERR:" + e.name);

      // 6b: href first then rel (foreign local)
      const lDataHf = document.createElement("link");
      lDataHf.href = "data:text/css;charset=utf-8," + encodeURIComponent('@font-face { font-family: "p_data_hf_helv"; src: local("Helvetica Neue"); }');
      lDataHf.rel = "stylesheet";
      const pDataHf = new Promise((r) => { lDataHf.onload = r; lDataHf.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lDataHf);
      await pDataHf;
      out.dynamicDataLink.hrefFirst = await document.fonts.load('16px "p_data_hf_helv"').then(r => r.length, e => "ERR:" + e.name);

      // 6c: setAttribute (foreign local)
      const lDataSa = document.createElement("link");
      lDataSa.setAttribute("rel", "stylesheet");
      lDataSa.setAttribute("href", "data:text/css;charset=utf-8," + encodeURIComponent('@font-face { font-family: "p_data_sa_helv"; src: local("Helvetica Neue"); }'));
      const pDataSa = new Promise((r) => { lDataSa.onload = r; lDataSa.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lDataSa);
      await pDataSa;
      out.dynamicDataLink.setAttr = await document.fonts.load('16px "p_data_sa_helv"').then(r => r.length, e => "ERR:" + e.name);

      // 6d: allowed local Arial via data link
      const lDataArial = document.createElement("link");
      lDataArial.rel = "stylesheet";
      lDataArial.href = "data:text/css;charset=utf-8," + encodeURIComponent('@font-face { font-family: "p_data_arial"; src: local("Arial"); }');
      const pDataA = new Promise((r) => { lDataArial.onload = r; lDataArial.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lDataArial);
      await pDataA;
      out.dynamicDataLink.arial = await document.fonts.load('16px "p_data_arial"').then(r => r.length, e => "ERR:" + e.name);

      // 6e: allowed local Segoe UI via data link (authentic WOFF2 subset)
      const lDataSegoe = document.createElement("link");
      lDataSegoe.rel = "stylesheet";
      lDataSegoe.href = "data:text/css;charset=utf-8," + encodeURIComponent('@font-face { font-family: "p_data_segoe"; src: local("Segoe UI"); }');
      const pDataS = new Promise((r) => { lDataSegoe.onload = r; lDataSegoe.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lDataSegoe);
      await pDataS;
      out.dynamicDataLink.segoe = await document.fonts.load('16px "p_data_segoe"').then(r => r.length, e => "ERR:" + e.name);

      // 6f: custom web font via data link
      const b64 = ${JSON.stringify(fontB64)};
      const lDataWeb = document.createElement("link");
      lDataWeb.rel = "stylesheet";
      lDataWeb.href = "data:text/css;charset=utf-8," + encodeURIComponent('@font-face { font-family: "p_data_web"; src: url("data:font/woff2;base64,' + b64 + '"); }');
      const pDataW = new Promise((r) => { lDataWeb.onload = r; lDataWeb.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lDataWeb);
      await pDataW;
      out.dynamicDataLink.dataFont = await document.fonts.load('16px "p_data_web"').then(r => r.length, e => "ERR:" + e.name);

      // 6g: mixed foreign local + web font url
      const lDataMixedF = document.createElement("link");
      lDataMixedF.rel = "stylesheet";
      lDataMixedF.href = "data:text/css;charset=utf-8," + encodeURIComponent('@font-face { font-family: "p_data_mixed_f"; src: local("Helvetica Neue"), url("data:font/woff2;base64,' + b64 + '"); }');
      const pDataMF = new Promise((r) => { lDataMixedF.onload = r; lDataMixedF.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lDataMixedF);
      await pDataMF;
      out.dynamicDataLink.mixedForeign = await document.fonts.load('16px "p_data_mixed_f"').then(r => r.length, e => "ERR:" + e.name);

      // 6h: mixed allowed local + web font url
      const lDataMixedA = document.createElement("link");
      lDataMixedA.rel = "stylesheet";
      lDataMixedA.href = "data:text/css;charset=utf-8," + encodeURIComponent('@font-face { font-family: "p_data_mixed_a"; src: local("Segoe UI"), url("data:font/woff2;base64,' + b64 + '"); }');
      const pDataMA = new Promise((r) => { lDataMixedA.onload = r; lDataMixedA.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lDataMixedA);
      await pDataMA;
      out.dynamicDataLink.mixedAllowed = await document.fonts.load('16px "p_data_mixed_a"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.dynamicDataLink.error = e.name + ": " + e.message; }

    // 7. Dynamic blob: link stylesheet pathways
    try {
      // 7a: standard blob link (foreign local)
      const bHelv = new Blob(['@font-face { font-family: "p_blob_helv"; src: local("Helvetica Neue"); }'], { type: "text/css" });
      const bUrlHelv = URL.createObjectURL(bHelv);
      const lBlobHelv = document.createElement("link");
      lBlobHelv.rel = "stylesheet";
      lBlobHelv.href = bUrlHelv;
      const pBlobH = new Promise((r) => { lBlobHelv.onload = r; lBlobHelv.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lBlobHelv);
      await pBlobH;
      out.dynamicBlobLink.helv = await document.fonts.load('16px "p_blob_helv"').then(r => r.length, e => "ERR:" + e.name);

      // 7b: href first then rel
      const bHf = new Blob(['@font-face { font-family: "p_blob_hf_helv"; src: local("Helvetica Neue"); }'], { type: "text/css" });
      const bUrlHf = URL.createObjectURL(bHf);
      const lBlobHf = document.createElement("link");
      lBlobHf.href = bUrlHf;
      lBlobHf.rel = "stylesheet";
      const pBlobHf = new Promise((r) => { lBlobHf.onload = r; lBlobHf.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lBlobHf);
      await pBlobHf;
      out.dynamicBlobLink.hrefFirst = await document.fonts.load('16px "p_blob_hf_helv"').then(r => r.length, e => "ERR:" + e.name);

      // 7c: setAttribute
      const bSa = new Blob(['@font-face { font-family: "p_blob_sa_helv"; src: local("Helvetica Neue"); }'], { type: "text/css" });
      const bUrlSa = URL.createObjectURL(bSa);
      const lBlobSa = document.createElement("link");
      lBlobSa.setAttribute("rel", "stylesheet");
      lBlobSa.setAttribute("href", bUrlSa);
      const pBlobSa = new Promise((r) => { lBlobSa.onload = r; lBlobSa.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lBlobSa);
      await pBlobSa;
      out.dynamicBlobLink.setAttr = await document.fonts.load('16px "p_blob_sa_helv"').then(r => r.length, e => "ERR:" + e.name);

      // 7d: allowed local Arial via blob link
      const bArial = new Blob(['@font-face { font-family: "p_blob_arial"; src: local("Arial"); }'], { type: "text/css" });
      const bUrlA = URL.createObjectURL(bArial);
      const lBlobA = document.createElement("link");
      lBlobA.rel = "stylesheet";
      lBlobA.href = bUrlA;
      const pBlobA = new Promise((r) => { lBlobA.onload = r; lBlobA.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lBlobA);
      await pBlobA;
      out.dynamicBlobLink.arial = await document.fonts.load('16px "p_blob_arial"').then(r => r.length, e => "ERR:" + e.name);

      // 7e: allowed local Segoe UI via blob link (authentic WOFF2 subset)
      const bSegoe = new Blob(['@font-face { font-family: "p_blob_segoe"; src: local("Segoe UI"); }'], { type: "text/css" });
      const bUrlS = URL.createObjectURL(bSegoe);
      const lBlobS = document.createElement("link");
      lBlobS.rel = "stylesheet";
      lBlobS.href = bUrlS;
      const pBlobS = new Promise((r) => { lBlobS.onload = r; lBlobS.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lBlobS);
      await pBlobS;
      out.dynamicBlobLink.segoe = await document.fonts.load('16px "p_blob_segoe"').then(r => r.length, e => "ERR:" + e.name);

      // 7f: custom web font URL via blob link
      const bWeb = new Blob(['@font-face { font-family: "p_blob_url"; src: url("http://127.0.0.1:' + ${serverPort} + '/subset.woff2"); }'], { type: "text/css" });
      const bUrlW = URL.createObjectURL(bWeb);
      const lBlobW = document.createElement("link");
      lBlobW.rel = "stylesheet";
      lBlobW.href = bUrlW;
      const pBlobW = new Promise((r) => { lBlobW.onload = r; lBlobW.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lBlobW);
      await pBlobW;
      out.dynamicBlobLink.urlFont = await document.fonts.load('16px "p_blob_url"').then(r => r.length, e => "ERR:" + e.name);

      // 7g: mixed foreign local + web font URL in blob link
      const bMixedF = new Blob(['@font-face { font-family: "p_blob_mixed_f"; src: local("Helvetica Neue"), url("http://127.0.0.1:' + ${serverPort} + '/subset.woff2"); }'], { type: "text/css" });
      const bUrlMF = URL.createObjectURL(bMixedF);
      const lBlobMF = document.createElement("link");
      lBlobMF.rel = "stylesheet";
      lBlobMF.href = bUrlMF;
      const pBlobMF = new Promise((r) => { lBlobMF.onload = r; lBlobMF.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lBlobMF);
      await pBlobMF;
      out.dynamicBlobLink.mixedForeign = await document.fonts.load('16px "p_blob_mixed_f"').then(r => r.length, e => "ERR:" + e.name);

      // 7h: mixed allowed local + web font URL in blob link
      const bMixedA = new Blob(['@font-face { font-family: "p_blob_mixed_a"; src: local("Segoe UI"), url("http://127.0.0.1:' + ${serverPort} + '/subset.woff2"); }'], { type: "text/css" });
      const bUrlMA = URL.createObjectURL(bMixedA);
      const lBlobMA = document.createElement("link");
      lBlobMA.rel = "stylesheet";
      lBlobMA.href = bUrlMA;
      const pBlobMA = new Promise((r) => { lBlobMA.onload = r; lBlobMA.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(lBlobMA);
      await pBlobMA;
      out.dynamicBlobLink.mixedAllowed = await document.fonts.load('16px "p_blob_mixed_a"').then(r => r.length, e => "ERR:" + e.name);

      // 7i: non-CSS blob untouched
      const nonCssBlob = new Blob(["binary-test-data"], { type: "image/png" });
      const nonCssUrl = URL.createObjectURL(nonCssBlob);
      out.dynamicBlobLink.nonCssBlobUntouched = typeof nonCssUrl === "string" && nonCssUrl.startsWith("blob:");

      // 7j: URL.revokeObjectURL cleanup
      URL.revokeObjectURL(nonCssUrl);
      out.dynamicBlobLink.revokeCleanup = true;
    } catch (e) { out.dynamicBlobLink.error = e.name + ": " + e.message; }

    // 8. Positive Controls on style elements
    try {
      const b64 = ${JSON.stringify(fontB64)};
      const sWebData = document.createElement("style");
      sWebData.textContent = '@font-face { font-family: "PositiveDataFont"; src: url("data:font/woff2;base64,' + b64 + '"); }';
      document.head.appendChild(sWebData);
      out.positiveControl.dataFont = await document.fonts.load('16px "PositiveDataFont"').then(r => r.length, e => "ERR:" + e.name);

      const sWebUrl = document.createElement("style");
      sWebUrl.textContent = '@font-face { font-family: "PositiveUrlFont"; src: url("http://127.0.0.1:' + ${serverPort} + '/subset.woff2"); }';
      document.head.appendChild(sWebUrl);
      out.positiveControl.urlFont = await document.fonts.load('16px "PositiveUrlFont"').then(r => r.length, e => "ERR:" + e.name);

      const sMixedForeign = document.createElement("style");
      sMixedForeign.textContent = '@font-face { font-family: "MixedForeignFont"; src: local("Helvetica Neue"), url("data:font/woff2;base64,' + b64 + '"); }';
      document.head.appendChild(sMixedForeign);
      out.positiveControl.mixedForeign = await document.fonts.load('16px "MixedForeignFont"').then(r => r.length, e => "ERR:" + e.name);

      const sMixedAllowed = document.createElement("style");
      sMixedAllowed.textContent = '@font-face { font-family: "MixedAllowedFont"; src: local("Arial"), url("data:font/woff2;base64,' + b64 + '"); }';
      document.head.appendChild(sMixedAllowed);
      out.positiveControl.mixedAllowed = await document.fonts.load('16px "MixedAllowedFont"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.positiveControl.error = e.name + ": " + e.message; }

    // 9. Tampering Detection Checks
    const sampleLink = document.createElement("link");
    const linkHrefDesc = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, "href");
    const linkRelDesc = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, "rel");
    const urlCreateDesc = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const urlRevokeDesc = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

    out.tamperingDetections = {
      styleHasOwnTextContent: HTMLStyleElement.prototype.hasOwnProperty("textContent"),
      styleHasOwnInnerHTML: HTMLStyleElement.prototype.hasOwnProperty("innerHTML"),
      linkHasOwnHref: sampleLink.hasOwnProperty("href"),
      linkHasOwnRel: sampleLink.hasOwnProperty("rel"),
      linkProtoHasHref: HTMLLinkElement.prototype.hasOwnProperty("href"),
      linkProtoHasRel: HTMLLinkElement.prototype.hasOwnProperty("rel"),
      linkHrefGetLooksNative: linkHrefDesc && /^\\s*function\\s+get href\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(linkHrefDesc.get)),
      linkHrefSetLooksNative: linkHrefDesc && /^\\s*function\\s+set href\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(linkHrefDesc.set)),
      linkRelGetLooksNative: linkRelDesc && /^\\s*function\\s+get rel\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(linkRelDesc.get)),
      linkRelSetLooksNative: linkRelDesc && /^\\s*function\\s+set rel\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(linkRelDesc.set)),
      insertRuleLooksNative: /^\\s*function\\s+insertRule\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(CSSStyleSheet.prototype.insertRule)),
      replaceSyncLooksNative: /^\\s*function\\s+replaceSync\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(CSSStyleSheet.prototype.replaceSync)),
      replaceLooksNative: /^\\s*function\\s+replace\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(CSSStyleSheet.prototype.replace)),
      createObjectURLName: URL.createObjectURL.name === "createObjectURL",
      createObjectURLLength: URL.createObjectURL.length === 1,
      createObjectURLLooksNative: /^\\s*function\\s+createObjectURL\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(URL.createObjectURL)),
      createObjectURLConfigurable: urlCreateDesc ? urlCreateDesc.configurable : false,
      revokeObjectURLName: URL.revokeObjectURL.name === "revokeObjectURL",
      revokeObjectURLLength: URL.revokeObjectURL.length === 1,
      revokeObjectURLLooksNative: /^\\s*function\\s+revokeObjectURL\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(URL.revokeObjectURL)),
      revokeObjectURLConfigurable: urlRevokeDesc ? urlRevokeDesc.configurable : false,
      setAttributeLooksNative: /^\\s*function\\s+setAttribute\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(Element.prototype.setAttribute))
    };

    return JSON.stringify(out);
  })()`;
}

function buildStaticProbeScript() {
  return `(async () => {
    const out = {};
    try {
      out.staticHtmlParser = await document.fonts.load('16px "p_html_parser"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.staticHtmlParser = "EX:" + e.name; }

    try {
      out.staticExtLink = await document.fonts.load('16px "p_ext_link"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.staticExtLink = "EX:" + e.name; }

    return JSON.stringify(out);
  })()`;
}

async function runSession(serverPort, fontB64, mutate) {
  const profile = {
    id: mutate ? 'css-gate-mutate' : 'css-gate-normal',
    name: mutate ? 'css-gate-mutate' : 'css-gate-normal',
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    userAgent: WINDOWS_UA,
    privacy: { deviceProfile: 'persona' },
  };

  const fp = buildFingerprint(profile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-css-gate-' + (mutate ? 'mutate-' : 'normal-')));
  let child = null;

  try {
    await writeOpenBrowserKernelInit(dir, {
      fingerprint: fp,
      profile,
      templatePath: path.join(kernelRoot, 'init_template.json'),
    });

    child = spawn(launcher, [dir, '--headless=new', '--enable-unsafe-swiftshader'], {
      cwd: kernelRoot,
      detached: true,
      stdio: 'ignore',
    });

    let port = 0;
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      try {
        const fileContent = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8');
        const value = parseInt(fileContent.trim().split('\n')[0], 10);
        if (value > 0) { port = value; break; }
      } catch (_) {}
    }
    if (!port) return { error: 'DevToolsActivePort not acquired' };

    const page = await waitForPage(port);
    if (!page?.webSocketDebuggerUrl) return { error: 'Page target not available' };

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);

    await cdp.call('Page.enable', {});

    // Always inject baseline fingerprint script
    let injectionScript = buildInjectionScript(fp);
    if (mutate) {
      // In mutate mode, strip the gate script to verify sensitivity
      const gateSource = buildCssFontLocalGateSource(fp.fonts.list);
      if (gateSource && injectionScript.includes(gateSource)) {
        injectionScript = injectionScript.replace(gateSource, '');
      }
    }
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: injectionScript });

    // Dynamic pathway test
    await cdp.call('Page.navigate', { url: 'http://127.0.0.1:' + serverPort + '/' });
    await sleep(1500);
    const dynamicResult = await cdp.value(buildDynamicProbeScript(fontB64, serverPort));

    // Static parser test
    await cdp.call('Page.navigate', { url: 'http://127.0.0.1:' + serverPort + '/static-probe.html' });
    await sleep(1500);
    const staticResult = await cdp.value(buildStaticProbeScript());

    try { ws.close(); } catch (_) {}
    return {
      dynamic: dynamicResult,
      static: staticResult,
    };
  } finally {
    if (child) await stopChild(child, dir);
  }
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 kernel launcher available');
    console.log(`css-font-local-gate-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const fontBuf = fs.readFileSync(fontPath);
  const fontB64 = fontBuf.toString('base64');
  const { server, port } = await startServer(fontBuf);

  let sessionResult = null;

  try {
    console.log(isMutateMode
      ? 'Running MUTATED session (gate disabled to verify sensitivity)...'
      : 'Running MITIGATED session (gate enabled for dynamic pathways)...');
    sessionResult = await runSession(port, fontB64, isMutateMode);
    if (sessionResult?.dynamic?.error) throw new Error('Dynamic session failed: ' + sessionResult.dynamic.error);
    if (sessionResult?.static?.error) throw new Error('Static session failed: ' + sessionResult.static.error);
  } finally {
    server.close();
  }

  const dyn = sessionResult.dynamic;
  const stat = sessionResult.static;

  if (isMutateMode) {
    // Mutation mode assertions: without gate, foreign local font MUST leak across all dynamic paths
    check('MUTATION CHECK: Path 1 - style.textContent foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.path1_textContent.helv, 1, 'foreign font must leak via textContent without gate');
    });

    check('MUTATION CHECK: Path 1 - style.innerHTML foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.path1_innerHTML.helv, 1, 'foreign font must leak via innerHTML without gate');
    });

    check('MUTATION CHECK: Path 2 - style.appendChild(Text) foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.path2_appendChild.helv, 1, 'foreign font must leak via appendChild without gate');
    });

    check('MUTATION CHECK: Path 2 - style.replaceChildren(Text) foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.path2_replaceChildren.helv, 1, 'foreign font must leak via replaceChildren without gate');
    });

    check('MUTATION CHECK: Path 3 - CSSStyleSheet.prototype.insertRule foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.path3_insertRule.helv, 1, 'foreign font must leak via insertRule without gate');
    });

    check('MUTATION CHECK: Path 4 - CSSStyleSheet.prototype.replaceSync foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.path4_replaceSync.helv, 1, 'foreign font must leak via replaceSync without gate');
    });

    check('MUTATION CHECK: Path 4 - CSSStyleSheet.prototype.replace foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.path4_replace.helv, 1, 'foreign font must leak via replace without gate');
    });

    check('MUTATION CHECK: Dynamic data: link foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.dynamicDataLink.helv, 1, 'foreign font must leak via data: link without gate');
    });

    check('MUTATION CHECK: Dynamic blob: link foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.dynamicBlobLink.helv, 1, 'foreign font must leak via blob: link without gate');
    });

    console.log('[MUTATION TEST] Gate disabled: foreign local font leaked across dynamic paths as expected (sensitivity verified).');
  } else {
    // Normal mode assertions: gate blocks foreign local font across all dynamic pathways
    check('Path 1: style.textContent foreign local Helvetica Neue rejected with NetworkError', () => {
      assert.strictEqual(dyn.path1_textContent.helv, 'ERR:NetworkError', 'foreign local font must trigger NetworkError');
    });

    check('Path 1: style.innerHTML foreign local Helvetica Neue rejected with NetworkError', () => {
      assert.strictEqual(dyn.path1_innerHTML.helv, 'ERR:NetworkError', 'foreign local font must trigger NetworkError');
    });

    check('Path 1: style.textContent allowed local Arial successfully loaded', () => {
      assert.strictEqual(dyn.path1_textContent.arial, 1, 'allowed local Arial must load via textContent');
    });

    check('Path 1: style.textContent allowed local Segoe UI successfully loaded (genuine WOFF2 subset)', () => {
      assert.strictEqual(dyn.path1_textContent.segoe, 1, 'allowed local Segoe UI must load via textContent');
    });

    check('Path 1: style.innerHTML allowed local Arial successfully loaded', () => {
      assert.strictEqual(dyn.path1_innerHTML.arial, 1, 'allowed local Arial must load via innerHTML');
    });

    check('Path 2: style.appendChild(Text) foreign local Helvetica Neue rejected with NetworkError', () => {
      assert.strictEqual(dyn.path2_appendChild.helv, 'ERR:NetworkError', 'foreign local font must trigger NetworkError');
    });

    check('Path 2: style.replaceChildren(Text) foreign local Helvetica Neue rejected with NetworkError', () => {
      assert.strictEqual(dyn.path2_replaceChildren.helv, 'ERR:NetworkError', 'foreign local font must trigger NetworkError');
    });

    check('Path 3: CSSStyleSheet.prototype.insertRule foreign local Helvetica Neue rejected with NetworkError', () => {
      assert.strictEqual(dyn.path3_insertRule.helv, 'ERR:NetworkError', 'foreign local font must trigger NetworkError');
    });

    check('Path 3: CSSStyleSheet.prototype.insertRule allowed local Arial successfully loaded', () => {
      assert.strictEqual(dyn.path3_insertRule.arial, 1, 'allowed local Arial must load via insertRule');
    });

    check('Path 3: CSSStyleSheet.prototype.insertRule allowed local Segoe UI successfully loaded (genuine WOFF2 subset)', () => {
      assert.strictEqual(dyn.path3_insertRule.segoe, 1, 'allowed local Segoe UI must load via insertRule');
    });

    check('Path 4: CSSStyleSheet.prototype.replaceSync foreign local Helvetica Neue rejected with NetworkError', () => {
      assert.strictEqual(dyn.path4_replaceSync.helv, 'ERR:NetworkError', 'foreign local font must trigger NetworkError');
    });

    check('Path 4: CSSStyleSheet.prototype.replace foreign local Helvetica Neue rejected with NetworkError', () => {
      assert.strictEqual(dyn.path4_replace.helv, 'ERR:NetworkError', 'foreign local font must trigger NetworkError');
    });

    check('Path 4: CSSStyleSheet.prototype.replaceSync allowed local Segoe UI successfully loaded (genuine WOFF2 subset)', () => {
      assert.strictEqual(dyn.path4_replaceSync.segoe, 1, 'allowed local Segoe UI must load via replaceSync');
    });

    check('Path 5: adoptedStyleSheets constructable sheet allowed local Arial successfully loaded', () => {
      assert.strictEqual(dyn.path5_adoptedStyleSheets.arial, 1, 'allowed local Arial must load via adoptedStyleSheets');
    });

    check('Path 5: adoptedStyleSheets constructable sheet allowed local Segoe UI successfully loaded (genuine WOFF2 subset)', () => {
      assert.strictEqual(dyn.path5_adoptedStyleSheets.segoe, 1, 'allowed local Segoe UI must load via adoptedStyleSheets');
    });

    // Dynamic data: link tests
    check('Dynamic data: link foreign local Helvetica Neue rejected with NetworkError', () => {
      assert.strictEqual(dyn.dynamicDataLink.helv, 'ERR:NetworkError', 'foreign local font must trigger NetworkError');
    });

    check('Dynamic data: link href set before rel foreign local rejected with NetworkError', () => {
      assert.strictEqual(dyn.dynamicDataLink.hrefFirst, 'ERR:NetworkError', 'foreign local font must trigger NetworkError');
    });

    check('Dynamic data: link setAttribute foreign local rejected with NetworkError', () => {
      assert.strictEqual(dyn.dynamicDataLink.setAttr, 'ERR:NetworkError', 'foreign local font must trigger NetworkError');
    });

    check('Dynamic data: link allowed local Arial successfully loaded', () => {
      assert.strictEqual(dyn.dynamicDataLink.arial, 1, 'allowed local Arial must load via data: link');
    });

    check('Dynamic data: link allowed local Segoe UI successfully loaded (genuine WOFF2 subset)', () => {
      assert.strictEqual(dyn.dynamicDataLink.segoe, 1, 'allowed local Segoe UI must load via data: link');
    });

    check('Dynamic data: link custom web font via data: URI loads successfully', () => {
      assert.strictEqual(dyn.dynamicDataLink.dataFont, 1, 'custom web font must load via data: link');
    });

    check('Dynamic data: link mixed foreign local and web font url falls back and loads', () => {
      assert.strictEqual(dyn.dynamicDataLink.mixedForeign, 1, 'mixed foreign font must fallback to url and load');
    });

    check('Dynamic data: link mixed allowed local and web font url loads successfully', () => {
      assert.strictEqual(dyn.dynamicDataLink.mixedAllowed, 1, 'mixed allowed font must load via data: link');
    });

    // Dynamic blob: link tests
    check('Dynamic blob: link foreign local Helvetica Neue rejected with NetworkError', () => {
      assert.strictEqual(dyn.dynamicBlobLink.helv, 'ERR:NetworkError', 'foreign local font must trigger NetworkError');
    });

    check('Dynamic blob: link href set before rel foreign local rejected with NetworkError', () => {
      assert.strictEqual(dyn.dynamicBlobLink.hrefFirst, 'ERR:NetworkError', 'foreign local font must trigger NetworkError');
    });

    check('Dynamic blob: link setAttribute foreign local rejected with NetworkError', () => {
      assert.strictEqual(dyn.dynamicBlobLink.setAttr, 'ERR:NetworkError', 'foreign local font must trigger NetworkError');
    });

    check('Dynamic blob: link allowed local Arial successfully loaded', () => {
      assert.strictEqual(dyn.dynamicBlobLink.arial, 1, 'allowed local Arial must load via blob: link');
    });

    check('Dynamic blob: link allowed local Segoe UI successfully loaded (genuine WOFF2 subset)', () => {
      assert.strictEqual(dyn.dynamicBlobLink.segoe, 1, 'allowed local Segoe UI must load via blob: link');
    });

    check('Dynamic blob: link custom web font URL loads successfully', () => {
      assert.strictEqual(dyn.dynamicBlobLink.urlFont, 1, 'custom web font URL must load via blob: link');
    });

    check('Dynamic blob: link mixed foreign local and web font url falls back and loads', () => {
      assert.strictEqual(dyn.dynamicBlobLink.mixedForeign, 1, 'mixed foreign font must fallback to url and load');
    });

    check('Dynamic blob: link mixed allowed local and web font url loads successfully', () => {
      assert.strictEqual(dyn.dynamicBlobLink.mixedAllowed, 1, 'mixed allowed font must load via blob: link');
    });

    check('Dynamic blob: non-CSS blob (image/binary) remains completely untouched', () => {
      assert.strictEqual(dyn.dynamicBlobLink.nonCssBlobUntouched, true, 'non-CSS blob must be preserved');
    });

    check('Dynamic blob: URL.revokeObjectURL cleanup operates cleanly', () => {
      assert.strictEqual(dyn.dynamicBlobLink.revokeCleanup, true, 'revokeObjectURL must succeed');
    });

    // Positive controls on style elements
    check('Positive control: custom web font via data: URI loads successfully', () => {
      assert.strictEqual(dyn.positiveControl.dataFont, 1, 'data: URI custom web font must load');
    });

    check('Positive control: custom web font via URL loads successfully', () => {
      assert.strictEqual(dyn.positiveControl.urlFont, 1, 'URL custom web font must load');
    });

    check('Positive control: mixed foreign local() and web font url() falls back and loads successfully', () => {
      assert.strictEqual(dyn.positiveControl.mixedForeign, 1, 'mixed foreign font must fallback to url and load');
    });

    check('Positive control: mixed allowed local() and web font url() loads successfully', () => {
      assert.strictEqual(dyn.positiveControl.mixedAllowed, 1, 'mixed allowed font must load');
    });

    // Tampering integrity checks
    check('Tampering integrity: no prototype descriptor anomaly on HTMLStyleElement', () => {
      assert.strictEqual(dyn.tamperingDetections.styleHasOwnTextContent, false, 'HTMLStyleElement must not have own textContent');
      assert.strictEqual(dyn.tamperingDetections.styleHasOwnInnerHTML, false, 'HTMLStyleElement must not have own innerHTML');
    });

    check('Tampering integrity: HTMLLinkElement prototype descriptor and own property parity', () => {
      assert.strictEqual(dyn.tamperingDetections.linkHasOwnHref, false, 'link element must not have own href');
      assert.strictEqual(dyn.tamperingDetections.linkHasOwnRel, false, 'link element must not have own rel');
      assert.strictEqual(dyn.tamperingDetections.linkProtoHasHref, true, 'HTMLLinkElement prototype must have href');
      assert.strictEqual(dyn.tamperingDetections.linkProtoHasRel, true, 'HTMLLinkElement prototype must have rel');
    });

    check('Tampering integrity: HTMLLinkElement href and rel accessors pass native toString check', () => {
      assert.strictEqual(dyn.tamperingDetections.linkHrefGetLooksNative, true, 'link get href must look native');
      assert.strictEqual(dyn.tamperingDetections.linkHrefSetLooksNative, true, 'link set href must look native');
      assert.strictEqual(dyn.tamperingDetections.linkRelGetLooksNative, true, 'link get rel must look native');
      assert.strictEqual(dyn.tamperingDetections.linkRelSetLooksNative, true, 'link set rel must look native');
    });

    check('Tampering integrity: URL.createObjectURL and revokeObjectURL pass native name and toString checks', () => {
      assert.strictEqual(dyn.tamperingDetections.createObjectURLName, true, 'createObjectURL name must be createObjectURL');
      assert.strictEqual(dyn.tamperingDetections.createObjectURLLength, true, 'createObjectURL length must be 1');
      assert.strictEqual(dyn.tamperingDetections.createObjectURLLooksNative, true, 'createObjectURL must look native');
      assert.strictEqual(dyn.tamperingDetections.createObjectURLConfigurable, true, 'createObjectURL must be configurable');
      assert.strictEqual(dyn.tamperingDetections.revokeObjectURLName, true, 'revokeObjectURL name must be revokeObjectURL');
      assert.strictEqual(dyn.tamperingDetections.revokeObjectURLLength, true, 'revokeObjectURL length must be 1');
      assert.strictEqual(dyn.tamperingDetections.revokeObjectURLLooksNative, true, 'revokeObjectURL must look native');
      assert.strictEqual(dyn.tamperingDetections.revokeObjectURLConfigurable, true, 'revokeObjectURL must be configurable');
    });

    check('Tampering integrity: Element.prototype.setAttribute passes native toString check', () => {
      assert.strictEqual(dyn.tamperingDetections.setAttributeLooksNative, true, 'setAttribute must look native');
    });

    check('Tampering integrity: CSSStyleSheet methods pass native toString check', () => {
      assert.strictEqual(dyn.tamperingDetections.insertRuleLooksNative, true, 'insertRule must look native');
      assert.strictEqual(dyn.tamperingDetections.replaceSyncLooksNative, true, 'replaceSync must look native');
      assert.strictEqual(dyn.tamperingDetections.replaceLooksNative, true, 'replace must look native');
    });

    // Known gaps: kernel-level static HTML parser and external network requests
    checkKnownGap('Static HTML parser <style> bypasses JS gate and resolves host font (kernel-level parser)', () => {
      assert.strictEqual(stat.staticHtmlParser, 1, 'HTML parser bypass exposes host font');
    });

    checkKnownGap('Static external <link rel="stylesheet"> bypasses JS gate and resolves host font (network parser)', () => {
      assert.strictEqual(stat.staticExtLink, 1, 'external stylesheet bypass exposes host font');
    });
  }

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`css-font-local-gate-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`css-font-local-gate-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('css-font-local-gate-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
