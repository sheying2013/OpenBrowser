'use strict';

/**
 * Download filename resolution, failure classification and the RPA download
 * step that uses them.
 *
 * The step drives the REAL RpaEngine.executeStep; only the CDP transport and
 * the page evaluation are stubbed, so the naming and error paths are exercised
 * exactly as they run in the app.
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

const naming = require('./download-naming');

// The engine resolves its output directory from the working directory at
// require time, so point that at a scratch directory first.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-download-'));
process.chdir(scratch);
const OUTPUT = path.join(scratch, 'rpa-output');

const cdp = require('../cdp');
const { RpaEngine } = require('./rpa-engine');

function makeEngine() {
  const engine = new RpaEngine({ engine: {}, store: null, emit: () => {} });
  engine.withPage = async (_port, fn) => fn({});
  return engine;
}

function stubPage(bodyText, disposition) {
  cdp.call = async () => ({
    result: { value: { body: Buffer.from(bodyText).toString('base64'), disposition: disposition || '' } },
  });
}

const readStep = (params) => ({ type: 'downloadfile', params });

(async () => {
  // ---------- filename sanitising (unit) ----------
  check('reserved device names are escaped', () => {
    assert.strictEqual(naming.sanitizeFileName('CON'), '_CON');
    assert.strictEqual(naming.sanitizeFileName('nul.txt'), '_nul.txt');
    assert.strictEqual(naming.sanitizeFileName('com7'), '_com7');
    assert.strictEqual(naming.sanitizeFileName('console.txt'), 'console.txt');
  });
  check('path separators and illegal characters become underscores', () => {
    assert.strictEqual(naming.sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  });
  check('control characters are stripped', () => {
    assert.strictEqual(naming.sanitizeFileName('re\u0000port\u001f.txt'), 're_port_.txt');
  });
  check('trailing dots and spaces never survive', () => {
    // A run of trailing dots/spaces collapses into a single underscore.
    assert.strictEqual(naming.sanitizeFileName('report...'), 'report_');
    assert.strictEqual(naming.sanitizeFileName('report . . '), 'report_');
    assert.ok(!/[. ]$/.test(naming.sanitizeFileName('report. ')));
  });
  check('relative directory markers are rejected outright', () => {
    assert.strictEqual(naming.sanitizeFileName('..'), undefined);
    assert.strictEqual(naming.sanitizeFileName('.'), undefined);
    assert.strictEqual(naming.sanitizeFileName('   '), undefined);
  });

  // ---------- name resolution (unit) ----------
  check('an explicit name wins over the url', () => {
    assert.strictEqual(naming.getDownloadFileName('https://a.test/remote.zip', 'local.zip'), 'local.zip');
  });
  check('the url path names the file when nothing else does', () => {
    assert.strictEqual(naming.getDownloadFileName('https://a.test/dir/report%20Q3.xlsx'), 'report Q3.xlsx');
  });
  check('an unusable name falls back instead of throwing', () => {
    assert.strictEqual(naming.getDownloadFileName('https://a.test/', '..', 'fallback.bin'), 'fallback.bin');
    assert.strictEqual(naming.getDownloadFileName('not a url', '', 'fallback.bin'), 'fallback.bin');
  });
  check('a query string never leaks into the filename', () => {
    assert.strictEqual(naming.getDownloadFileName('https://a.test/file.csv?token=abc#frag'), 'file.csv');
  });

  // ---------- content-disposition (unit) ----------
  check('quoted disposition names are read', () => {
    assert.strictEqual(naming.getFileNameFromContentDisposition('attachment; filename="Q3 report.xlsx"'), 'Q3 report.xlsx');
  });
  check('bare disposition names are read', () => {
    assert.strictEqual(naming.getFileNameFromContentDisposition('attachment; filename=report.csv'), 'report.csv');
  });
  check('rfc 5987 encoded names win and decode as utf-8', () => {
    assert.strictEqual(
      naming.getFileNameFromContentDisposition("attachment; filename=plain.csv; filename*=UTF-8''%E6%8A%A5%E8%A1%A8.csv"),
      '报表.csv',
    );
  });
  check('escaped quotes inside a disposition name survive', () => {
    assert.strictEqual(naming.getFileNameFromContentDisposition('attachment; filename="a\\"b.txt"'), 'a"b.txt');
  });
  check('a missing disposition yields undefined', () => {
    assert.strictEqual(naming.getFileNameFromContentDisposition(''), undefined);
    assert.strictEqual(naming.getFileNameFromContentDisposition(null), undefined);
    assert.strictEqual(naming.getFileNameFromContentDisposition('attachment'), undefined);
  });

  // ---------- failure classification (unit) ----------
  check('a busy destination is reported as busy', () => {
    assert.strictEqual(naming.classifyTargetFileFailure({ code: 'EBUSY' }), 'TARGET_FILE_BUSY');
    assert.strictEqual(naming.classifyTargetFileFailure({ code: 'OTHER' }, { code: 'EBUSY' }), 'TARGET_FILE_BUSY');
  });
  check('permission failures are reported as access denied', () => {
    assert.strictEqual(naming.classifyTargetFileFailure({ code: 'EPERM' }), 'TARGET_FILE_ACCESS_DENIED');
    assert.strictEqual(naming.classifyTargetFileFailure({ code: 'EACCES' }), 'TARGET_FILE_ACCESS_DENIED');
  });
  check('anything else stays a generic download failure', () => {
    assert.strictEqual(naming.classifyTargetFileFailure({ code: 'ECONNRESET' }), 'DOWNLOAD_FAILED');
    assert.strictEqual(naming.isDownloadFailureCode('DOWNLOAD_FAILED'), true);
    assert.strictEqual(naming.isDownloadFailureCode('NOPE'), false);
  });
  check('messages name the file and stay actionable', () => {
    assert.ok(naming.getDownloadFailureMessage('TARGET_FILE_BUSY', 'a.xlsx').includes('a.xlsx'));
    assert.ok(naming.getDownloadFailureMessage('TARGET_FILE_BUSY', 'a.xlsx').includes('占用'));
    assert.ok(naming.getDownloadFailureMessage('TARGET_FILE_ACCESS_DENIED', 'a.xlsx').includes('无法写入'));
    assert.strictEqual(naming.getDownloadFailureMessage(undefined, 'a.xlsx'), '文件下载失败，请重试');
  });

  // ---------- the RPA step ----------
  await checkAsync('a server-supplied name is used for the saved file', async () => {
    stubPage('column,value\n1,2\n', 'attachment; filename="Q3 report.csv"');
    const engine = makeEngine();
    await engine.executeStep(9222, readStep({ url: 'https://example.test/export?id=7' }), { variables: {} });
    const saved = path.join(OUTPUT, 'Q3 report.csv');
    assert.ok(fs.existsSync(saved), `expected ${saved}`);
    assert.strictEqual(await fsp.readFile(saved, 'utf8'), 'column,value\n1,2\n');
  });

  await checkAsync('an encoded disposition name keeps its unicode', async () => {
    stubPage('x', "attachment; filename*=UTF-8''%E6%8A%A5%E8%A1%A8.xlsx");
    const engine = makeEngine();
    await engine.executeStep(9222, readStep({ url: 'https://example.test/dl' }), { variables: {} });
    assert.ok(fs.existsSync(path.join(OUTPUT, '报表.xlsx')));
  });

  await checkAsync('without a disposition the url names the file', async () => {
    stubPage('hello', '');
    const engine = makeEngine();
    await engine.executeStep(9222, readStep({ url: 'https://example.test/invoice%20march.pdf' }), { variables: {} });
    assert.ok(fs.existsSync(path.join(OUTPUT, 'invoice march.pdf')));
  });

  await checkAsync('an explicit path still overrides the server name', async () => {
    stubPage('override', 'attachment; filename="server.csv"');
    const engine = makeEngine();
    await engine.executeStep(9222, readStep({ url: 'https://example.test/x', path: 'chosen.txt' }), { variables: {} });
    assert.ok(fs.existsSync(path.join(OUTPUT, 'chosen.txt')));
    assert.ok(!fs.existsSync(path.join(OUTPUT, 'server.csv')));
  });

  await checkAsync('a traversal attempt cannot escape the output directory', async () => {
    stubPage('nope', 'attachment; filename="../../escape.sh"');
    const engine = makeEngine();
    await engine.executeStep(9222, readStep({ url: 'https://example.test/x' }), { variables: {} });
    const written = (await fsp.readdir(OUTPUT)).filter((name) => name.includes('escape'));
    assert.strictEqual(written.length, 1, `expected exactly one file, got ${written.join(', ')}`);
    const resolved = path.resolve(OUTPUT, written[0]);
    assert.ok(resolved.startsWith(path.resolve(OUTPUT) + path.sep), `escaped to ${resolved}`);
    assert.ok(!written[0].includes('/') && !written[0].includes('\\'));
    assert.ok(!fs.existsSync(path.join(scratch, 'escape.sh')));
  });

  await checkAsync('a reserved device name cannot be written verbatim', async () => {
    stubPage('x', 'attachment; filename="CON.txt"');
    const engine = makeEngine();
    await engine.executeStep(9222, readStep({ url: 'https://example.test/x' }), { variables: {} });
    const listed = await fsp.readdir(OUTPUT);
    assert.ok(!listed.includes('CON.txt'), `reserved name used: ${listed.join(', ')}`);
    assert.ok(listed.includes('_CON.txt'), `expected escaped name, got ${listed.join(', ')}`);
  });

  await checkAsync('a locked destination explains itself instead of leaking errno', async () => {
    stubPage('locked', 'attachment; filename="locked.csv"');
    const original = fsp.writeFile;
    fsp.writeFile = async () => { const error = new Error('EBUSY: resource busy or locked'); error.code = 'EBUSY'; throw error; };
    try {
      const engine = makeEngine();
      let error = null;
      try { await engine.executeStep(9222, readStep({ url: 'https://example.test/x' }), { variables: {} }); } catch (e) { error = e; }
      assert.ok(error, 'the step should fail');
      assert.ok(error.message.includes('正在被其他程序占用'), error.message);
      assert.ok(error.message.includes('locked.csv'), error.message);
      assert.ok(!error.message.includes('EBUSY'), `raw errno leaked: ${error.message}`);
    } finally {
      fsp.writeFile = original;
    }
  });

  await checkAsync('a permission failure is reported as such', async () => {
    stubPage('denied', 'attachment; filename="denied.csv"');
    const original = fsp.writeFile;
    fsp.writeFile = async () => { const error = new Error('EPERM: operation not permitted'); error.code = 'EPERM'; throw error; };
    try {
      const engine = makeEngine();
      let error = null;
      try { await engine.executeStep(9222, readStep({ url: 'https://example.test/x' }), { variables: {} }); } catch (e) { error = e; }
      assert.ok(error, 'the step should fail');
      assert.ok(error.message.includes('无法写入文件'), error.message);
    } finally {
      fsp.writeFile = original;
    }
  });

  await checkAsync('a missing url is still rejected up front', async () => {
    const engine = makeEngine();
    let error = null;
    try { await engine.executeStep(9222, readStep({}), { variables: {} }); } catch (e) { error = e; }
    assert.ok(error && /requires url/.test(error.message), error && error.message);
  });

  // ================= report =================
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nDOWNLOAD_NAMING_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${results.filter((r) => r.ok).length}/${results.length}`);
  if (failed.length) process.exitCode = 1;
  await fsp.rm(scratch, { recursive: true, force: true });
})();
