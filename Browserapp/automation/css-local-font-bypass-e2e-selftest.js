#!/usr/bin/env node
'use strict';

/**
 * End-to-end audit for CSS @font-face src:local() bypass and mitigation in OpenBrowser.
 *
 * Background:
 * Web applications can query system fonts by injecting CSS @font-face rules with `src: local(...)`.
 * In OpenBrowser, the production injection layer employs a multi-tiered defense:
 * 1. Dynamic DOM & CSSOM gate (css-font-local-gate.js):
 *    - Intercepts style.textContent, style.innerHTML, appendChild, replaceChildren
 *    - Intercepts CSSStyleSheet insertRule, replace, replaceSync, adoptedStyleSheets
 *    - Intercepts dynamic <link rel="stylesheet"> with data:text/css and blob: URLs
 *    - Sanitizes foreign local() references to NetworkError while providing authentic platform
 *      WOFF2 subset fallbacks for persona fonts (e.g. Arial, Segoe UI on Windows persona).
 * 2. Static HTML & external stylesheet network rewriter (css-font-response-rewrite.js):
 *    - In the full browser engine, CDP Fetch response interception rewrites static <style>
 *      blocks in Document responses and external Stylesheet responses before browser parsing.
 *      (Verified separately in css-font-response-rewrite-e2e-selftest.js and css-font-response-wiring-selftest.js).
 *
 * This test suite:
 * 1. Verifies raw host baseline leakage across all pathways.
 * 2. Verifies production gate enforcement across dynamic pathways: foreign local fonts trigger
 *    NetworkError, persona fonts (Arial, Segoe UI) load via authentic WOFF2 subsets, and secondary
 *    leaks via Canvas, DOM offsetWidth, and SVG text length are suppressed.
 * 3. Verifies positive controls (custom web fonts via data: URI and HTTP URL, mixed source fallbacks).
 * 4. Verifies prototype descriptor preservation and native appearance.
 * 5. Accurately records isolated document-injection boundaries (static HTML parser <style> and external <link>)
 *    as KNOWN GAPs while documenting full-engine CDP response-rewriter coverage.
 * 6. Supports --mutate flag to verify test sensitivity when the gate is stripped.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const {
  buildFingerprint,
  buildInjectionScript,
  loadFontSubsetPayload,
  mapPlatformToSubsetKey,
} = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const { buildCssFontLocalGateSource } = require('./css-font-local-gate');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const fontPath = path.join(appRoot, 'assets', 'font-subsets', 'windows', 'segoe-ui.woff2');

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const isMutateMode = process.argv.includes('--mutate') || process.env.MUTATE === '1';

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
    await sleep(300);
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
      res.setHeader('Content-Type', 'text/css');
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
    const sampleText = "mmmmmmmmmmlli";
    const out = {
      marker: typeof window.__marker !== "undefined" ? window.__marker : null,
      fontFaceDirect: {},
      path1_textContent: {},
      path1_innerHTML: {},
      path2_textNode: {},
      path3_insertRule: {},
      path4_replaceSync: {},
      path4_replace: {},
      path5_adoptedStyleSheets: {},
      path6_dataLink: {},
      path7_blobLink: {},
      secondaryLeaks: {},
      positiveControl: {},
      tamperingDetections: {}
    };

    // 0. Direct FontFace constructor
    try {
      const ffH = new FontFace("Helvetica Neue", 'local("Helvetica Neue")');
      await ffH.load();
      out.fontFaceDirect.helv = ffH.status;
    } catch (e) { out.fontFaceDirect.helv = "ERR:" + e.name; }

    try {
      const ffA = new FontFace("Arial", 'local("Arial")');
      await ffA.load();
      out.fontFaceDirect.arial = ffA.status;
    } catch (e) { out.fontFaceDirect.arial = "ERR:" + e.name; }

    try {
      const ffS = new FontFace("Segoe UI", 'local("Segoe UI")');
      await ffS.load();
      out.fontFaceDirect.segoe = ffS.status;
    } catch (e) { out.fontFaceDirect.segoe = "ERR:" + e.name; }

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
      const s1_ih = document.createElement("style");
      s1_ih.innerHTML = '@font-face { font-family: "p_ih_helv"; src: local("Helvetica Neue"); }';
      document.head.appendChild(s1_ih);
      out.path1_innerHTML.helv = await document.fonts.load('16px "p_ih_helv"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path1_innerHTML.helv = "EX:" + e.name; }

    try {
      const s1_ih_a = document.createElement("style");
      s1_ih_a.innerHTML = '@font-face { font-family: "p_ih_arial"; src: local("Arial"); }';
      document.head.appendChild(s1_ih_a);
      out.path1_innerHTML.arial = await document.fonts.load('16px "p_ih_arial"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path1_innerHTML.arial = "EX:" + e.name; }

    try {
      const s1_ih_s = document.createElement("style");
      s1_ih_s.innerHTML = '@font-face { font-family: "p_ih_segoe"; src: local("Segoe UI"); }';
      document.head.appendChild(s1_ih_s);
      out.path1_innerHTML.segoe = await document.fonts.load('16px "p_ih_segoe"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path1_innerHTML.segoe = "EX:" + e.name; }

    // 2. Path 2: Text nodes appendChild & replaceChildren
    try {
      const s2_ac = document.createElement("style");
      const t2_ac = document.createTextNode('@font-face { font-family: "p_ac_helv"; src: local("Helvetica Neue"); }');
      s2_ac.appendChild(t2_ac);
      document.head.appendChild(s2_ac);
      out.path2_textNode.appendChild = await document.fonts.load('16px "p_ac_helv"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path2_textNode.appendChild = "EX:" + e.name; }

    try {
      const s2_rc = document.createElement("style");
      const t2_rc = document.createTextNode('@font-face { font-family: "p_rc_helv"; src: local("Helvetica Neue"); }');
      s2_rc.replaceChildren(t2_rc);
      document.head.appendChild(s2_rc);
      out.path2_textNode.replaceChildren = await document.fonts.load('16px "p_rc_helv"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path2_textNode.replaceChildren = "EX:" + e.name; }

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

    // 4. Path 4: adoptedStyleSheets replaceSync & replace
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
      const s4_sync_a = new CSSStyleSheet();
      s4_sync_a.replaceSync('@font-face { font-family: "p_rs_arial"; src: local("Arial"); }');
      document.adoptedStyleSheets = [s4_sync_a];
      out.path4_replaceSync.arial = await document.fonts.load('16px "p_rs_arial"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path4_replaceSync.arial = "EX:" + e.name; }

    try {
      const s4_rep = new CSSStyleSheet();
      await s4_rep.replace('@font-face { font-family: "p_ra_helv"; src: local("Helvetica Neue"); }');
      document.adoptedStyleSheets = [s4_rep];
      out.path4_replace.helv = await document.fonts.load('16px "p_ra_helv"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path4_replace.helv = "EX:" + e.name; }

    // 5. Path 5: dynamic <link rel="stylesheet"> with data: URI
    try {
      const l5 = document.createElement("link");
      l5.rel = "stylesheet";
      l5.href = "data:text/css;charset=utf-8," + encodeURIComponent('@font-face { font-family: "p_data_helv"; src: local("Helvetica Neue"); }');
      const p5 = new Promise(r => { l5.onload = r; l5.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(l5);
      await p5;
      out.path6_dataLink.helv = await document.fonts.load('16px "p_data_helv"').then(r => r.length, e => "ERR:" + e.name);

      const l5_hf = document.createElement("link");
      l5_hf.href = "data:text/css;charset=utf-8," + encodeURIComponent('@font-face { font-family: "p_data_hf_helv"; src: local("Helvetica Neue"); }');
      l5_hf.rel = "stylesheet";
      const p5_hf = new Promise(r => { l5_hf.onload = r; l5_hf.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(l5_hf);
      await p5_hf;
      out.path6_dataLink.hrefFirst = await document.fonts.load('16px "p_data_hf_helv"').then(r => r.length, e => "ERR:" + e.name);

      const l5_sa = document.createElement("link");
      l5_sa.setAttribute("rel", "stylesheet");
      l5_sa.setAttribute("href", "data:text/css;charset=utf-8," + encodeURIComponent('@font-face { font-family: "p_data_sa_helv"; src: local("Helvetica Neue"); }'));
      const p5_sa = new Promise(r => { l5_sa.onload = r; l5_sa.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(l5_sa);
      await p5_sa;
      out.path6_dataLink.setAttr = await document.fonts.load('16px "p_data_sa_helv"').then(r => r.length, e => "ERR:" + e.name);

      const l5_a = document.createElement("link");
      l5_a.rel = "stylesheet";
      l5_a.href = "data:text/css;charset=utf-8," + encodeURIComponent('@font-face { font-family: "p_data_arial"; src: local("Arial"); }');
      const p5_a = new Promise(r => { l5_a.onload = r; l5_a.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(l5_a);
      await p5_a;
      out.path6_dataLink.arial = await document.fonts.load('16px "p_data_arial"').then(r => r.length, e => "ERR:" + e.name);

      const l5_s = document.createElement("link");
      l5_s.rel = "stylesheet";
      l5_s.href = "data:text/css;charset=utf-8," + encodeURIComponent('@font-face { font-family: "p_data_segoe"; src: local("Segoe UI"); }');
      const p5_s = new Promise(r => { l5_s.onload = r; l5_s.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(l5_s);
      await p5_s;
      out.path6_dataLink.segoe = await document.fonts.load('16px "p_data_segoe"').then(r => r.length, e => "ERR:" + e.name);
    } catch (e) { out.path6_dataLink.helv = "EX:" + e.name; }

    // 6. Path 6: dynamic <link rel="stylesheet"> with blob: URL
    try {
      const blobCssH = '@font-face { font-family: "p_blob_helv"; src: local("Helvetica Neue"); }';
      const blobH = new Blob([blobCssH], { type: "text/css" });
      const blobUrlH = URL.createObjectURL(blobH);
      const l6_h = document.createElement("link");
      l6_h.rel = "stylesheet";
      l6_h.href = blobUrlH;
      const p6_h = new Promise(r => { l6_h.onload = r; l6_h.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(l6_h);
      await p6_h;
      out.path7_blobLink.helv = await document.fonts.load('16px "p_blob_helv"').then(r => r.length, e => "ERR:" + e.name);
      URL.revokeObjectURL(blobUrlH);

      const blobCssA = '@font-face { font-family: "p_blob_arial"; src: local("Arial"); }';
      const blobA = new Blob([blobCssA], { type: "text/css" });
      const blobUrlA = URL.createObjectURL(blobA);
      const l6_a = document.createElement("link");
      l6_a.rel = "stylesheet";
      l6_a.href = blobUrlA;
      const p6_a = new Promise(r => { l6_a.onload = r; l6_a.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(l6_a);
      await p6_a;
      out.path7_blobLink.arial = await document.fonts.load('16px "p_blob_arial"').then(r => r.length, e => "ERR:" + e.name);
      URL.revokeObjectURL(blobUrlA);

      const blobCssS = '@font-face { font-family: "p_blob_segoe"; src: local("Segoe UI"); }';
      const blobS = new Blob([blobCssS], { type: "text/css" });
      const blobUrlS = URL.createObjectURL(blobS);
      const l6_s = document.createElement("link");
      l6_s.rel = "stylesheet";
      l6_s.href = blobUrlS;
      const p6_s = new Promise(r => { l6_s.onload = r; l6_s.onerror = r; setTimeout(r, 400); });
      document.head.appendChild(l6_s);
      await p6_s;
      out.path7_blobLink.segoe = await document.fonts.load('16px "p_blob_segoe"').then(r => r.length, e => "ERR:" + e.name);
      URL.revokeObjectURL(blobUrlS);
    } catch (e) { out.path7_blobLink.helv = "EX:" + e.name; }

    // 7. Secondary leaks (Canvas measureText, DOM offsetWidth, SVG text length)
    try {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      ctx.font = "72px monospace";
      const monoW = ctx.measureText(sampleText).width;
      ctx.font = '72px "p_tc_helv", monospace';
      const helvW = ctx.measureText(sampleText).width;

      const span = document.createElement("span");
      span.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:72px "p_tc_helv", monospace;';
      span.textContent = sampleText;
      document.body.appendChild(span);
      const spanW = span.offsetWidth;

      const spanMono = document.createElement("span");
      spanMono.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:72px monospace;';
      spanMono.textContent = sampleText;
      document.body.appendChild(spanMono);
      const spanMonoW = spanMono.offsetWidth;

      let svgDetected = false;
      let svgDiff = 0;
      try {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.style.position = "absolute";
        svg.style.visibility = "hidden";
        document.body.appendChild(svg);
        const tM = document.createElementNS("http://www.w3.org/2000/svg", "text");
        tM.setAttribute("font-family", "monospace");
        tM.setAttribute("font-size", "72px");
        tM.textContent = sampleText;
        svg.appendChild(tM);
        const svgMonoLen = tM.getComputedTextLength();

        const tH = document.createElementNS("http://www.w3.org/2000/svg", "text");
        tH.setAttribute("font-family", '"p_tc_helv", monospace');
        tH.setAttribute("font-size", "72px");
        tH.textContent = sampleText;
        svg.appendChild(tH);
        const svgHelvLen = tH.getComputedTextLength();
        svgDiff = svgHelvLen - svgMonoLen;
        svgDetected = Math.abs(svgDiff) > 0.01;
      } catch (_) {}

      out.secondaryLeaks = {
        monoW, helvW,
        canvasDiff: helvW - monoW,
        canvasDetected: Math.abs(helvW - monoW) > 0.01,
        spanW, spanMonoW,
        domDiff: spanW - spanMonoW,
        domDetected: Math.abs(spanW - spanMonoW) > 0.01,
        svgDiff,
        svgDetected
      };
    } catch (e) { out.secondaryLeaks = { error: e.name + ": " + e.message }; }

    // 8. Positive Controls (Custom Web Font via data:, URL, and mixed sources)
    try {
      const b64 = ${JSON.stringify(fontB64)};
      const sWeb = document.createElement("style");
      sWeb.textContent = '@font-face { font-family: "PositiveDataFont"; src: url("data:font/woff2;base64,' + b64 + '"); }';
      document.head.appendChild(sWeb);
      out.positiveControl.dataFontLoad = await document.fonts.load('16px "PositiveDataFont"').then(r => r.length, e => "ERR:" + e.name);

      if (${Number(serverPort) || 0} > 0) {
        const sUrl = document.createElement("style");
        sUrl.textContent = '@font-face { font-family: "PositiveUrlFont"; src: url("http://127.0.0.1:' + ${Number(serverPort)} + '/subset.woff2"); }';
        document.head.appendChild(sUrl);
        out.positiveControl.urlFontLoad = await document.fonts.load('16px "PositiveUrlFont"').then(r => r.length, e => "ERR:" + e.name);
      }

      const sMixedForeign = document.createElement("style");
      sMixedForeign.textContent = '@font-face { font-family: "MixedForeignFont"; src: local("Helvetica Neue"), url("data:font/woff2;base64,' + b64 + '"); }';
      document.head.appendChild(sMixedForeign);
      out.positiveControl.mixedFontLoad = await document.fonts.load('16px "MixedForeignFont"').then(r => r.length, e => "ERR:" + e.name);

      const sMixedAllowed = document.createElement("style");
      sMixedAllowed.textContent = '@font-face { font-family: "MixedAllowedFont"; src: local("Segoe UI"), url("data:font/woff2;base64,' + b64 + '"); }';
      document.head.appendChild(sMixedAllowed);
      out.positiveControl.mixedAllowedLoad = await document.fonts.load('16px "MixedAllowedFont"').then(r => r.length, e => "ERR:" + e.name);

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      ctx.font = '72px "PositiveDataFont", monospace';
      const webW = ctx.measureText(sampleText).width;
      ctx.font = "72px monospace";
      const monoW = ctx.measureText(sampleText).width;
      out.positiveControl.canvasWebDiff = webW - monoW;
      out.positiveControl.canvasDistinct = Math.abs(webW - monoW) > 0.01;
    } catch (e) { out.positiveControl = { error: e.name + ": " + e.message }; }

    // 9. Tampering Detection Checks
    const testLink = document.createElement("link");
    out.tamperingDetections = {
      styleHasOwnTextContent: Object.prototype.hasOwnProperty.call(HTMLStyleElement.prototype, "textContent"),
      styleHasOwnInnerHTML: Object.prototype.hasOwnProperty.call(HTMLStyleElement.prototype, "innerHTML"),
      linkHasOwnHref: Object.prototype.hasOwnProperty.call(testLink, "href"),
      linkHasOwnRel: Object.prototype.hasOwnProperty.call(testLink, "rel"),
      linkProtoHasHref: Object.prototype.hasOwnProperty.call(HTMLLinkElement.prototype, "href"),
      linkProtoHasRel: Object.prototype.hasOwnProperty.call(HTMLLinkElement.prototype, "rel"),
      insertRuleLooksNative: /^\\s*function\\s+insertRule\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(CSSStyleSheet.prototype.insertRule)),
      replaceSyncLooksNative: /^\\s*function\\s+replaceSync\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(CSSStyleSheet.prototype.replaceSync)),
      createObjectURLLooksNative: /^\\s*function\\s+createObjectURL\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(URL.createObjectURL)),
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

async function runSession(mode, serverPort, fontB64, mutate = false) {
  const profile = {
    id: 'css-font-audit-' + mode + (mutate ? '-mutate' : ''),
    name: 'css-font-audit-' + mode,
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    userAgent: WINDOWS_UA,
    privacy: { deviceProfile: 'persona' },
  };

  const fp = buildFingerprint(profile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-css-audit-' + mode + '-'));
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

    if (mode === 'injected') {
      await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__marker = true;' });
      let injectionScript = buildInjectionScript(fp);
      if (mutate) {
        // In mutate mode, strip the CSS font local gate to verify test sensitivity
        const platformKey = mapPlatformToSubsetKey(fp.platform);
        const fontSubsets = platformKey ? loadFontSubsetPayload(platformKey) : [];
        const gateSource = buildCssFontLocalGateSource(fp.fonts.list, fontSubsets);
        if (gateSource && injectionScript.includes(gateSource)) {
          injectionScript = injectionScript.replace(gateSource, '');
        }
      }
      await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: injectionScript });
    }

    // Dynamic test execution
    await cdp.call('Page.navigate', { url: 'http://127.0.0.1:' + serverPort + '/' });
    await sleep(2000);
    const dynamicResult = await cdp.value(buildDynamicProbeScript(fontB64, serverPort));

    // Static parser test execution (navigating to static-probe.html)
    await cdp.call('Page.navigate', { url: 'http://127.0.0.1:' + serverPort + '/static-probe.html' });
    await sleep(2000);
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
    console.log(`css-local-font-bypass-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const fontBuf = fs.readFileSync(fontPath);
  const fontB64 = fontBuf.toString('base64');
  const { server, port } = await startServer(fontBuf);

  let raw = null;
  let injected = null;

  try {
    if (isMutateMode) {
      console.log('Running MUTATED session (gate disabled to verify test sensitivity)...');
      injected = await runSession('injected', port, fontB64, true);
      if (injected?.dynamic?.error) throw new Error('Mutated dynamic session failed: ' + injected.dynamic.error);
    } else {
      console.log('Running RAW baseline session...');
      raw = await runSession('raw', port, fontB64, false);
      if (raw?.dynamic?.error) throw new Error('Raw dynamic session failed: ' + raw.dynamic.error);

      console.log('Running INJECTED production session...');
      injected = await runSession('injected', port, fontB64, false);
      if (injected?.dynamic?.error) throw new Error('Injected dynamic session failed: ' + injected.dynamic.error);
    }
  } finally {
    server.close();
  }

  if (isMutateMode) {
    const dyn = injected.dynamic;

    check('MUTATION CHECK: style.textContent foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.path1_textContent.helv, 1, 'foreign local font must leak via textContent without gate');
    });

    check('MUTATION CHECK: style.innerHTML foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.path1_innerHTML.helv, 1, 'foreign local font must leak via innerHTML without gate');
    });

    check('MUTATION CHECK: style Text node appendChild foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.path2_textNode.appendChild, 1, 'foreign local font must leak via appendChild without gate');
    });

    check('MUTATION CHECK: CSSStyleSheet.prototype.insertRule foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.path3_insertRule.helv, 1, 'foreign local font must leak via insertRule without gate');
    });

    check('MUTATION CHECK: CSSStyleSheet.prototype.replaceSync foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.path4_replaceSync.helv, 1, 'foreign local font must leak via replaceSync without gate');
    });

    check('MUTATION CHECK: Dynamic data: link foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.path6_dataLink.helv, 1, 'foreign local font must leak via data: link without gate');
    });

    check('MUTATION CHECK: Dynamic blob: link foreign local leaks host font when gate is disabled', () => {
      assert.strictEqual(dyn.path7_blobLink.helv, 1, 'foreign local font must leak via blob: link without gate');
    });

    check('MUTATION CHECK: Secondary Canvas metrics detect foreign local font when gate is disabled', () => {
      assert.strictEqual(dyn.secondaryLeaks.canvasDetected, true, 'canvas metrics must detect foreign local font leak');
    });

    check('MUTATION CHECK: Secondary DOM and SVG metrics detect foreign local font when gate is disabled', () => {
      assert.strictEqual(dyn.secondaryLeaks.domDetected, true, 'DOM width must detect foreign local font leak');
      assert.strictEqual(dyn.secondaryLeaks.svgDetected, true, 'SVG length must detect foreign local font leak');
    });

    console.log('[MUTATION TEST] Gate disabled: foreign local font leaked across dynamic pathways as expected (sensitivity verified).');
  } else {
    // 1. Baseline verification: FontFace JS hook
    check('baseline: JS FontFace constructor local() hook is active in injected mode', () => {
      assert.strictEqual(raw.dynamic.fontFaceDirect.helv, 'loaded', 'raw engine resolves host Helvetica Neue via new FontFace');
      assert.strictEqual(injected.dynamic.fontFaceDirect.helv, 'ERR:NetworkError', 'injected engine rejects foreign Helvetica Neue via new FontFace');
      assert.strictEqual(injected.dynamic.fontFaceDirect.arial, 'loaded', 'injected engine resolves persona Arial');
      assert.strictEqual(injected.dynamic.fontFaceDirect.segoe, 'loaded', 'injected engine resolves persona Segoe UI');
    });

    // 2. Path 1: style.textContent & innerHTML
    check('production gate: style.textContent blocks foreign local() and allows persona fonts', () => {
      assert.strictEqual(raw.dynamic.path1_textContent.helv, 1, 'raw mode loads host font via textContent');
      assert.strictEqual(injected.dynamic.path1_textContent.helv, 'ERR:NetworkError', 'injected mode blocks foreign local font via textContent');
      assert.strictEqual(injected.dynamic.path1_textContent.arial, 1, 'persona Arial loads via textContent');
      assert.strictEqual(injected.dynamic.path1_textContent.segoe, 1, 'persona Segoe UI loads via textContent (genuine WOFF2 subset)');
    });

    check('production gate: style.innerHTML blocks foreign local() and allows persona fonts', () => {
      assert.strictEqual(injected.dynamic.path1_innerHTML.helv, 'ERR:NetworkError', 'injected mode blocks foreign local font via innerHTML');
      assert.strictEqual(injected.dynamic.path1_innerHTML.arial, 1, 'persona Arial loads via innerHTML');
      assert.strictEqual(injected.dynamic.path1_innerHTML.segoe, 1, 'persona Segoe UI loads via innerHTML (genuine WOFF2 subset)');
    });

    // 3. Path 2: Text nodes appendChild & replaceChildren
    check('production gate: Node.prototype.appendChild & replaceChildren intercept style Text nodes', () => {
      assert.strictEqual(injected.dynamic.path2_textNode.appendChild, 'ERR:NetworkError', 'injected mode blocks foreign font via appendChild');
      assert.strictEqual(injected.dynamic.path2_textNode.replaceChildren, 'ERR:NetworkError', 'injected mode blocks foreign font via replaceChildren');
    });

    // 4. Path 3: sheet.insertRule
    check('production gate: sheet.insertRule blocks foreign local() and allows persona fonts', () => {
      assert.strictEqual(raw.dynamic.path3_insertRule.helv, 1, 'raw mode loads host font via insertRule');
      assert.strictEqual(injected.dynamic.path3_insertRule.helv, 'ERR:NetworkError', 'injected mode blocks foreign local font via insertRule');
      assert.strictEqual(injected.dynamic.path3_insertRule.arial, 1, 'persona Arial loads via insertRule');
      assert.strictEqual(injected.dynamic.path3_insertRule.segoe, 1, 'persona Segoe UI loads via insertRule (genuine WOFF2 subset)');
    });

    // 5. Path 4: adoptedStyleSheets replaceSync & replace
    check('production gate: adoptedStyleSheets replaceSync & replace block foreign local() and allow persona fonts', () => {
      assert.strictEqual(raw.dynamic.path4_replaceSync.helv, 1, 'raw mode loads host font via replaceSync');
      assert.strictEqual(injected.dynamic.path4_replaceSync.helv, 'ERR:NetworkError', 'injected mode blocks foreign local font via replaceSync');
      assert.strictEqual(injected.dynamic.path4_replace.helv, 'ERR:NetworkError', 'injected mode blocks foreign local font via replace');
      assert.strictEqual(injected.dynamic.path4_replaceSync.arial, 1, 'persona Arial loads via replaceSync');
      assert.strictEqual(injected.dynamic.path4_replaceSync.segoe, 1, 'persona Segoe UI loads via replaceSync (genuine WOFF2 subset)');
    });

    // 6. Path 5: dynamic <link rel="stylesheet"> with data: URI
    check('production gate: dynamic <link rel="stylesheet"> with data: URI blocks foreign local() and allows persona fonts', () => {
      assert.strictEqual(raw.dynamic.path6_dataLink.helv, 1, 'raw mode loads host font via data: link stylesheet');
      assert.strictEqual(injected.dynamic.path6_dataLink.helv, 'ERR:NetworkError', 'injected mode blocks foreign local font via data: link');
      assert.strictEqual(injected.dynamic.path6_dataLink.hrefFirst, 'ERR:NetworkError', 'injected mode blocks foreign font when href set before rel');
      assert.strictEqual(injected.dynamic.path6_dataLink.setAttr, 'ERR:NetworkError', 'injected mode blocks foreign font via setAttribute');
      assert.strictEqual(injected.dynamic.path6_dataLink.arial, 1, 'persona Arial loads via data: link');
      assert.strictEqual(injected.dynamic.path6_dataLink.segoe, 1, 'persona Segoe UI loads via data: link (genuine WOFF2 subset)');
    });

    // 7. Path 6: dynamic <link rel="stylesheet"> with blob: URL
    check('production gate: dynamic <link rel="stylesheet"> with blob: URL blocks foreign local() and allows persona fonts', () => {
      assert.strictEqual(injected.dynamic.path7_blobLink.helv, 'ERR:NetworkError', 'injected mode blocks foreign local font via blob: link');
      assert.strictEqual(injected.dynamic.path7_blobLink.arial, 1, 'persona Arial loads via blob: link');
      assert.strictEqual(injected.dynamic.path7_blobLink.segoe, 1, 'persona Segoe UI loads via blob: link (genuine WOFF2 subset)');
    });

    // 8. Secondary canvas path
    check('production gate: Canvas metrics do not reveal a foreign local font through the CSS alias', () => {
      assert.strictEqual(raw.dynamic.secondaryLeaks.canvasDetected, true, 'raw mode detects Canvas metric shift on host font');
      assert.strictEqual(injected.dynamic.secondaryLeaks.canvasDetected, false, 'canvas must fall back after the foreign local font is blocked');
      assert.ok(Math.abs(injected.dynamic.secondaryLeaks.canvasDiff) <= 0.01, 'canvas text width delta stays at fallback precision');
    });

    // 9. Secondary DOM and SVG paths
    check('production gate: DOM and SVG metrics do not reveal a foreign local font through the CSS alias', () => {
      assert.strictEqual(raw.dynamic.secondaryLeaks.domDetected, true, 'raw mode detects DOM offsetWidth shift on host font');
      assert.strictEqual(injected.dynamic.secondaryLeaks.domDetected, false, 'DOM width must fall back after the foreign local font is blocked');
      assert.ok(Math.abs(injected.dynamic.secondaryLeaks.domDiff) <= 0.01, 'DOM width delta stays at fallback precision');
      assert.strictEqual(injected.dynamic.secondaryLeaks.svgDetected, false, 'SVG width must fall back after the foreign local font is blocked');
      assert.ok(Math.abs(injected.dynamic.secondaryLeaks.svgDiff) <= 0.01, 'SVG text length delta stays at fallback precision');
    });

    // 10. Positive control: Custom web font via data: URI
    check('positive control: data URI woff2 web font loads and renders normally in both modes', () => {
      assert.strictEqual(raw.dynamic.positiveControl.dataFontLoad, 1, 'raw mode loads data: woff2 font');
      assert.strictEqual(injected.dynamic.positiveControl.dataFontLoad, 1, 'injected mode loads data: woff2 font');
      assert.strictEqual(injected.dynamic.positiveControl.canvasDistinct, true, 'custom web font metrics are visually distinct');
    });

    // 11. Positive control: Custom web font via URL
    check('positive control: HTTP URL woff2 web font loads normally', () => {
      assert.strictEqual(injected.dynamic.positiveControl.urlFontLoad, 1, 'injected mode loads web font from URL');
    });

    // 12. Positive control: Mixed local() and url() sources
    check('positive control: mixed local() and url() web font loads fallback gracefully', () => {
      assert.strictEqual(raw.dynamic.positiveControl.mixedFontLoad, 1, 'raw mode loads mixed source font');
      assert.strictEqual(injected.dynamic.positiveControl.mixedFontLoad, 1, 'injected mode loads mixed source font');
      assert.strictEqual(injected.dynamic.positiveControl.mixedAllowedLoad, 1, 'injected mode loads mixed allowed local + url font');
    });

    // 13. Tampering detection checks: prototype descriptor preservation
    check('tampering integrity: wrapped DOM and CSSOM APIs preserve native descriptor characteristics', () => {
      assert.strictEqual(injected.dynamic.tamperingDetections.styleHasOwnTextContent, false, 'HTMLStyleElement must not have own textContent');
      assert.strictEqual(injected.dynamic.tamperingDetections.styleHasOwnInnerHTML, false, 'HTMLStyleElement must not have own innerHTML');
      assert.strictEqual(injected.dynamic.tamperingDetections.linkHasOwnHref, false, 'link element must not have own href');
      assert.strictEqual(injected.dynamic.tamperingDetections.linkHasOwnRel, false, 'link element must not have own rel');
      assert.strictEqual(injected.dynamic.tamperingDetections.linkProtoHasHref, true, 'HTMLLinkElement prototype must have href');
      assert.strictEqual(injected.dynamic.tamperingDetections.linkProtoHasRel, true, 'HTMLLinkElement prototype must have rel');
      assert.strictEqual(injected.dynamic.tamperingDetections.insertRuleLooksNative, true, 'insertRule must look native');
      assert.strictEqual(injected.dynamic.tamperingDetections.replaceSyncLooksNative, true, 'replaceSync must look native');
      assert.strictEqual(injected.dynamic.tamperingDetections.createObjectURLLooksNative, true, 'createObjectURL must look native');
      assert.strictEqual(injected.dynamic.tamperingDetections.setAttributeLooksNative, true, 'setAttribute must look native');
    });

    // 14. Known gap: HTML parser static <style> in isolated document injection
    checkKnownGap('isolated document injection: static HTML parser <style> bypasses JS document hooks', () => {
      assert.strictEqual(raw.static.staticHtmlParser, 1, 'raw mode parses static <style>');
      assert.strictEqual(injected.static.staticHtmlParser, 1, 'in isolated doc-injection, C++ HTML parser bypasses JS hooks');
    });

    // 15. Known gap: static external <link rel="stylesheet"> in isolated document injection
    checkKnownGap('isolated document injection: static external <link rel="stylesheet"> bypasses JS document hooks', () => {
      assert.strictEqual(injected.static.staticExtLink, 1, 'in isolated doc-injection, external stylesheet bypasses JS hooks');
    });

    console.log('[ARCHITECTURAL NOTE] Static HTML parser <style> and external <link> pathways bypass document-level JS injection.');
    console.log('[PRODUCTION COVERAGE] In the full OpenBrowser engine (engine.js), the CDP Fetch response-rewriter (css-font-response-rewrite.js)');
    console.log('                      intercepts Document and Stylesheet network responses before parsing, sanitizing static local() references.');
    console.log('                      Verified by css-font-response-rewrite-e2e-selftest.js and css-font-response-wiring-selftest.js.');
  }

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`css-local-font-bypass-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`css-local-font-bypass-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('css-local-font-bypass-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
