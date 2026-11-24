'use strict';

// /api/fingerprint-report body limits: 64 KiB cap, chunked accounting, and early client aborts.

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbrowser-fp-limit-'));
process.env.OPENBROWSER_FP_LOG = path.join(logDir, 'fp.log');
// Never take the user's default start-page port while this test runs.
process.env.OPENBROWSER_START_PAGE_PORT = '0';

const { StartPageServer } = require('./start-page-server');

const reports = [];
function record(name, error) {
  reports.push({ name, ok: !error });
  if (error) {
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS  ${name}`);
  }
}

function request(port, { method = 'POST', pathname, headers = {}, body = null, chunked = false }) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    if (body && !chunked) finalHeaders['Content-Length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: finalHeaders, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (body) {
      // Slice the write so a chunked oversize upload really streams.
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      const slice = 8192;
      let offset = 0;
      const pump = () => {
        if (offset >= buf.length) { req.end(); return; }
        req.write(buf.subarray(offset, offset + slice));
        offset += slice;
        setImmediate(pump);
      };
      pump();
    } else {
      req.end();
    }
  });
}

function abortMidBody(port, { pathname, headers, declaredLength, partial }) {
  return new Promise((resolve, reject) => {
    let status = 0;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: { ...headers, 'Content-Length': declaredLength },
      timeout: 8000,
    }, (res) => { status = res.statusCode; res.resume(); });
    req.on('error', (error) => {
      // The server drops the connection; a reset here is the expected outcome.
      if (error.code === 'ECONNRESET' || error.code === 'EPIPE') return resolve(status);
      reject(error);
    });
    req.on('close', () => resolve(status));
    req.write(partial, () => setTimeout(() => req.destroy(), 60));
  });
}

async function main() {
  const server = new StartPageServer();
  await server.start();
  const port = server.port;
  try {
    const url = server.registerSession({ id: 'fp-limit', name: 'fp limit', number: 1, proxy: 'direct' });
    const token = new URL(url).searchParams.get('token');
    assert.ok(token, 'session must issue a token');
    const auth = { 'X-OpenBrowser-Start-Token': token, 'Content-Type': 'application/json' };
    const reportPath = '/api/fingerprint-report?pid=fp-limit';

    const small = await request(port, { pathname: reportPath, headers: auth, body: JSON.stringify({ phase: 't0', live: { userAgent: 'UA', hardwareConcurrency: 8 } }) });
    assert.strictEqual(small.status, 200);
    assert.strictEqual(small.json.ok, true);
    record('small report accepted with a valid session token', null);

    const putSmall = await request(port, { method: 'PUT', pathname: reportPath, headers: auth, body: JSON.stringify({ phase: 't350', live: { platform: 'MacIntel' } }) });
    assert.strictEqual(putSmall.status, 200);
    record('PUT reports stay accepted', null);

    const byLength = await request(port, { pathname: reportPath, headers: auth, body: 'a'.repeat(64 * 1024 + 1) });
    assert.strictEqual(byLength.status, 413);
    assert.strictEqual(byLength.json.ok, false);
    record('Content-Length over 64 KiB rejected with 413', null);

    const multibyteOk = JSON.stringify({ phase: 't0', pad: '你'.repeat(7000) });
    assert.ok(Buffer.byteLength(multibyteOk) < 64 * 1024, 'fixture must fit under the cap');
    const multibyteOkRes = await request(port, { pathname: reportPath, headers: auth, body: multibyteOk });
    assert.strictEqual(multibyteOkRes.status, 200);
    record('multibyte report under the byte cap accepted', null);

    // 23k CJK chars: under the cap in characters, over it in UTF-8 bytes.
    const multibyteOver = JSON.stringify({ phase: 't0', pad: '你'.repeat(23000) });
    assert.ok(multibyteOver.length < 64 * 1024, 'fixture must be under the char cap');
    assert.ok(Buffer.byteLength(multibyteOver) > 64 * 1024, 'fixture must exceed the byte cap');
    const multibyteOverRes = await request(port, { pathname: reportPath, headers: auth, body: multibyteOver });
    assert.strictEqual(multibyteOverRes.status, 413);
    record('multibyte report over the byte cap rejected with 413', null);

    const chunkedOver = Buffer.from(JSON.stringify({ phase: 't0', pad: 'x'.repeat(64 * 1024) }), 'utf8');
    assert.ok(chunkedOver.length > 64 * 1024);
    const chunkedRes = await request(port, {
      pathname: reportPath,
      headers: { ...auth, 'Transfer-Encoding': 'chunked' },
      body: chunkedOver,
      chunked: true,
    });
    assert.strictEqual(chunkedRes.status, 413);
    record('chunked upload over 64 KiB rejected with 413', null);

    for (const payload of ['null', '[]', '[1,2,3]', '"text"']) {
      const res = await request(port, { pathname: reportPath, headers: auth, body: payload });
      assert.strictEqual(res.status, 400, `${payload} must be 400`);
      assert.strictEqual(res.json.ok, false);
    }
    record('null / array / string JSON return 400 instead of throwing', null);

    const unauth = await request(port, { pathname: reportPath, headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(unauth.status, 401);
    record('report without session token stays 401', null);

    // Small body, client hangs up mid-upload: no log line, no 200 — the handler just stops.
    const partial = Buffer.from(JSON.stringify({ phase: 't0', pad: 'y'.repeat(4096) }), 'utf8');
    const abortStatus = await abortMidBody(port, {
      pathname: reportPath,
      headers: auth,
      declaredLength: partial.length + 8192,
      partial,
    });
    assert.strictEqual(abortStatus, 0, `aborted upload must not get a response status, got ${abortStatus}`);
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Oversize refusals and the aborted upload must not reach the diagnostic log.
    const logText = await fsp.readFile(process.env.OPENBROWSER_FP_LOG, 'utf8').catch(() => '');
    const welcomeLines = logText.split('\n').filter((line) => line.includes('"event":"welcome.report"'));
    assert.strictEqual(welcomeLines.length, 3, `expected 3 logged reports (small + PUT + multibyte ok), got ${welcomeLines.length}`);
    assert.ok(!logText.includes('yyyy'), 'partial aborted body must not be logged');
    record('413 reports and aborted uploads are not logged', null);
  } finally {
    if (server.server) await server.stop();
    await fsp.rm(logDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().then(() => {
  const failed = reports.filter((item) => !item.ok).length;
  console.log(`\n${reports.length - failed}/${reports.length} PASS`);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
