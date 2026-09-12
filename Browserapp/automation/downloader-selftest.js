'use strict';

/**
 * Self-test for the streaming downloader.
 * Uses a throwaway loopback HTTP server, so no external network is involved.
 */

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');

const { Downloader, STATUS } = require('./downloader');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

async function makeTempDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'dl-selftest-'));
}

/** Spin up a server with per-test routes; returns {url, close, hits}. */
function startServer(handler) {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push({ url: req.url, range: req.headers.range || null });
      handler(req, res, hits.length);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: (p) => `http://127.0.0.1:${port}${p}`,
        close: () => new Promise((r) => server.close(r)),
        hits,
      });
    });
  });
}

(async () => {
  // ---- helpers ----
  check('fileNameFromUrl derives a name from the path', () => {
    const { fileNameFromUrl } = require('./downloader');
    assert.strictEqual(fileNameFromUrl('https://x.test/files/kernel.zip'), 'kernel.zip');
    assert.strictEqual(fileNameFromUrl('https://x.test/a/b.tar.gz?token=1'), 'b.tar.gz');
    assert.strictEqual(fileNameFromUrl('https://x.test/dir/'), 'dir');
  });

  await checkAsync('digestOf and digestFile agree for the same bytes', async () => {
    const payload = Buffer.from('digest-consistency-check');
    const dir = await makeTempDir();
    const file = path.join(dir, 'd.bin');
    await fsp.writeFile(file, payload);
    assert.strictEqual(Downloader.digestOf(payload), md5(payload));
    assert.strictEqual(await Downloader.digestFile(file), md5(payload));
    assert.strictEqual(Downloader.digestOf(payload), await Downloader.digestFile(file));
  });

  // ---- successful download ----
  await checkAsync('downloads a file and verifies its digest', async () => {
    const payload = Buffer.from('kernel-payload-'.repeat(500));
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-length': payload.length });
      res.end(payload);
    });
    const dir = await makeTempDir();
    try {
      const dl = new Downloader(server.url('/kernel.zip'), {
        destPath: path.join(dir, 'kernel.zip'),
        expectedMd5: md5(payload),
      });
      const events = [];
      dl.on('status', (s) => events.push(s.status));
      const result = await dl.start();

      assert.strictEqual(result.skipped, false);
      assert.strictEqual(result.md5, md5(payload));
      assert.strictEqual(result.attempts, 1);
      assert.deepStrictEqual(await fsp.readFile(result.path), payload);
      assert.ok(events.includes(STATUS.DOWNLOADING), 'emitted downloading');
      assert.ok(events.includes(STATUS.VERIFYING), 'emitted verifying');
      assert.strictEqual(events[events.length - 1], STATUS.COMPLETED);
      assert.strictEqual(dl.progress, 1);
    } finally {
      await server.close();
    }
  });

  await checkAsync('reports byte-level progress', async () => {
    const payload = Buffer.alloc(256 * 1024, 7);
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-length': payload.length });
      res.end(payload);
    });
    const dir = await makeTempDir();
    try {
      const dl = new Downloader(server.url('/big.bin'), { destPath: path.join(dir, 'big.bin') });
      let lastReceived = 0;
      let sawFinal = false;
      dl.on('progress', ({ received, total }) => {
        assert.ok(received >= lastReceived, 'bytes must not go backwards');
        lastReceived = received;
        if (total && received === total) sawFinal = true;
      });
      const result = await dl.start();
      assert.strictEqual(result.bytes, payload.length);
      assert.ok(sawFinal, 'final progress event observed');
    } finally {
      await server.close();
    }
  });

  await checkAsync('derives the filename from the url when not specified', async () => {
    const payload = Buffer.from('abc');
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-length': payload.length });
      res.end(payload);
    });
    const dir = await makeTempDir();
    try {
      const dl = new Downloader(server.url('/assets/tool.bin'), { dir });
      const result = await dl.start();
      assert.strictEqual(path.basename(result.path), 'tool.bin');
      assert.deepStrictEqual(await fsp.readFile(result.path), payload);
    } finally {
      await server.close();
    }
  });

  // ---- reuse & verification ----
  await checkAsync('reuses an existing file with a matching digest', async () => {
    const payload = Buffer.from('already-here');
    const dir = await makeTempDir();
    const destPath = path.join(dir, 'cached.bin');
    await fsp.writeFile(destPath, payload);

    const server = await startServer((req, res) => {
      res.writeHead(200);
      res.end('should-not-be-fetched');
    });
    try {
      const dl = new Downloader(server.url('/cached.bin'), { destPath, expectedMd5: md5(payload) });
      const result = await dl.start();
      assert.strictEqual(result.skipped, true);
      assert.strictEqual(server.hits.length, 0, 'no request issued');
      assert.deepStrictEqual(await fsp.readFile(destPath), payload);
    } finally {
      await server.close();
    }
  });

  await checkAsync('re-downloads when the existing file has the wrong digest', async () => {
    const payload = Buffer.from('fresh-content');
    const dir = await makeTempDir();
    const destPath = path.join(dir, 'stale.bin');
    await fsp.writeFile(destPath, 'stale-content');

    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-length': payload.length });
      res.end(payload);
    });
    try {
      const dl = new Downloader(server.url('/stale.bin'), { destPath, expectedMd5: md5(payload) });
      const result = await dl.start();
      assert.strictEqual(result.skipped, false);
      assert.deepStrictEqual(await fsp.readFile(destPath), payload);
      assert.strictEqual(server.hits.length, 1);
    } finally {
      await server.close();
    }
  });

  await checkAsync('rejects a body whose digest does not match', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-length': 5 });
      res.end('wrong');
    });
    const dir = await makeTempDir();
    try {
      const dl = new Downloader(server.url('/bad.bin'), {
        destPath: path.join(dir, 'bad.bin'),
        expectedMd5: md5(Buffer.from('right')),
      });
      await assert.rejects(() => dl.start(), /digest mismatch/);
      assert.strictEqual(dl.status, STATUS.FAILED);
      assert.strictEqual(await Downloader.fileExists(path.join(dir, 'bad.bin')), false, 'nothing promoted');
    } finally {
      await server.close();
    }
  });

  // ---- retry & errors ----
  await checkAsync('retries a failing request then succeeds', async () => {
    const payload = Buffer.from('eventual-success');
    const server = await startServer((req, res, hit) => {
      if (hit < 3) {
        res.writeHead(500);
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'content-length': payload.length });
      res.end(payload);
    });
    const dir = await makeTempDir();
    try {
      const dl = new Downloader(server.url('/flaky.bin'), {
        destPath: path.join(dir, 'flaky.bin'),
        retries: 3,
      });
      const attempts = [];
      dl.on('retry', ({ attempt }) => attempts.push(attempt));
      const result = await dl.start();
      assert.strictEqual(attempts.length, 2, 'two failures recorded');
      assert.strictEqual(result.attempts, 3);
      assert.deepStrictEqual(await fsp.readFile(result.path), payload);
    } finally {
      await server.close();
    }
  });

  await checkAsync('gives up after the configured retries', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(404);
      res.end('missing');
    });
    const dir = await makeTempDir();
    try {
      const dl = new Downloader(server.url('/nope.bin'), {
        destPath: path.join(dir, 'nope.bin'),
        retries: 2,
      });
      await assert.rejects(() => dl.start(), /http 404/);
      assert.strictEqual(server.hits.length, 3, 'initial attempt plus two retries');
    } finally {
      await server.close();
    }
  });

  await checkAsync('follows redirects to the final location', async () => {
    const payload = Buffer.from('redirected-body');
    const server = await startServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-length': payload.length });
      res.end(payload);
    });
    const dir = await makeTempDir();
    try {
      const dl = new Downloader(server.url('/start'), { destPath: path.join(dir, 'r.bin') });
      const result = await dl.start();
      assert.deepStrictEqual(await fsp.readFile(result.path), payload);
      assert.strictEqual(server.hits.length, 2);
    } finally {
      await server.close();
    }
  });

  await checkAsync('a redirect target is offered to the url validator', async () => {
    const payload = Buffer.from('body-after-redirect');
    const server = await startServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/elsewhere' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-length': payload.length });
      res.end(payload);
    });
    const dir = await makeTempDir();
    const seen = [];
    try {
      const dl = new Downloader(server.url('/start'), {
        destPath: path.join(dir, 'r.bin'),
        validateUrl: (target) => { seen.push(target); },
      });
      await dl.start();
      assert.strictEqual(seen.length, 2, 'both the original and the redirect are vetted');
      assert.ok(seen[0].endsWith('/start'));
      assert.ok(seen[1].endsWith('/elsewhere'));
    } finally {
      await server.close();
    }
  });

  await checkAsync('a rejected redirect target stops the transfer', async () => {
    const server = await startServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/offsite' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-length': 4 });
      res.end('nope');
    });
    const dir = await makeTempDir();
    try {
      const dl = new Downloader(server.url('/start'), {
        destPath: path.join(dir, 'r.bin'),
        retries: 0,
        validateUrl: (target) => {
          if (target.includes('/offsite')) throw new Error('redirect target is not allowed');
        },
      });
      await assert.rejects(() => dl.start(), /not allowed/);
      await assert.rejects(() => fsp.stat(dl.destPath), 'nothing is written to the destination');
    } finally {
      await server.close();
    }
  });

  await checkAsync('a redirect that leaves https is refused by a scheme check', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(302, { location: 'http://example.invalid/plain' });
      res.end();
    });
    const dir = await makeTempDir();
    try {
      const dl = new Downloader(server.url('/start'), {
        destPath: path.join(dir, 'r.bin'),
        retries: 0,
        validateUrl: (target) => {
          const parsed = new URL(target);
          if (parsed.protocol !== 'https:') throw new Error('untrusted redirect protocol');
        },
      });
      await assert.rejects(() => dl.start(), /untrusted redirect protocol/);
    } finally {
      await server.close();
    }
  });

  await checkAsync('an announced size above the ceiling is refused before writing', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-length': 4096 });
      res.end(Buffer.alloc(4096));
    });
    const dir = await makeTempDir();
    try {
      const dl = new Downloader(server.url('/big'), {
        destPath: path.join(dir, 'big.bin'),
        retries: 0,
        maxBytes: 1024,
      });
      await assert.rejects(() => dl.start(), /exceeds the 1024 byte limit/);
    } finally {
      await server.close();
    }
  });

  await checkAsync('an unknown size still hits the ceiling mid-stream', async () => {
    const server = await startServer((req, res) => {
      // No Content-Length at all, so the size is only discovered while the
      // body streams in; the ceiling has to be enforced during the transfer.
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      res.write(Buffer.alloc(4096));
      res.end(Buffer.alloc(4096));
    });
    const dir = await makeTempDir();
    try {
      const dl = new Downloader(server.url('/liar'), {
        destPath: path.join(dir, 'liar.bin'),
        retries: 0,
        maxBytes: 2048,
      });
      await assert.rejects(() => dl.start(), /exceeds the 2048 byte limit/);
    } finally {
      await server.close();
    }
  });

  await checkAsync('a transfer inside the ceiling completes normally', async () => {
    const payload = Buffer.from('small enough');
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-length': payload.length });
      res.end(payload);
    });
    const dir = await makeTempDir();
    try {
      const dl = new Downloader(server.url('/ok'), {
        destPath: path.join(dir, 'ok.bin'),
        maxBytes: 1024,
        validateUrl: (target) => {
          if (!String(target).startsWith('http://127.0.0.1')) throw new Error('host not allowed');
        },
      });
      const result = await dl.start();
      assert.deepStrictEqual(await fsp.readFile(result.path), payload);
    } finally {
      await server.close();
    }
  });

  await checkAsync('reports an invalid url without crashing', async () => {
    const dir = await makeTempDir();
    const dl = new Downloader('not-a-url', { destPath: path.join(dir, 'x.bin') });
    await assert.rejects(() => dl.start(), /invalid url|unsupported protocol/);
    assert.strictEqual(dl.status, STATUS.FAILED);
  });

  // ---- resume ----
  await checkAsync('resumes a partial file with a range request', async () => {
    const payload = Buffer.from('0123456789'.repeat(400));
    const splitAt = 1200;
    const server = await startServer((req, res) => {
      const range = req.headers.range;
      if (range) {
        const start = Number(/bytes=(\d+)-/.exec(range)[1]);
        const slice = payload.slice(start);
        res.writeHead(206, {
          'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
          'content-length': slice.length,
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, { 'content-length': payload.length });
      res.end(payload);
    });

    const dir = await makeTempDir();
    const destPath = path.join(dir, 'resume.bin');
    try {
      // Pre-seed a partial download so the next run can pick up where it left off.
      await fsp.writeFile(`${destPath}.partial`, payload.slice(0, splitAt));

      const dl = new Downloader(server.url('/resume.bin'), {
        destPath,
        expectedMd5: md5(payload),
      });
      const result = await dl.start();

      assert.strictEqual(server.hits[0].range, `bytes=${splitAt}-`, 'range header sent');
      assert.strictEqual(result.md5, md5(payload), 'digest covers prior bytes plus new ones');
      assert.deepStrictEqual(await fsp.readFile(destPath), payload);
    } finally {
      await server.close();
    }
  });

  await checkAsync('restarts from scratch when the server ignores the range', async () => {
    const payload = Buffer.from('restart-payload'.repeat(100));
    const server = await startServer((req, res) => {
      // Ignore Range and return the whole body with 200.
      res.writeHead(200, { 'content-length': payload.length });
      res.end(payload);
    });
    const dir = await makeTempDir();
    const destPath = path.join(dir, 'restart.bin');
    try {
      await fsp.writeFile(`${destPath}.partial`, 'garbage-from-a-previous-run');
      const dl = new Downloader(server.url('/restart.bin'), { destPath, expectedMd5: md5(payload) });
      const result = await dl.start();
      assert.deepStrictEqual(await fsp.readFile(destPath), payload);
      assert.strictEqual(result.md5, md5(payload));
    } finally {
      await server.close();
    }
  });

  await checkAsync('cleanup removes the partial file', async () => {
    const dir = await makeTempDir();
    const destPath = path.join(dir, 'c.bin');
    const tmp = `${destPath}.partial`;
    await fsp.writeFile(tmp, 'leftover');
    const dl = new Downloader('http://127.0.0.1:1/x', { destPath });
    await dl.cleanup();
    assert.strictEqual(await Downloader.fileExists(tmp), false);
  });

  check('constructor rejects a missing url', () => {
    assert.throws(() => new Downloader(''), /url is required/);
  });

  // ---- report ----
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  console.log(`\nDOWNLOADER_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
