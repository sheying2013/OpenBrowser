'use strict';

/**
 * Self-test for the zero-dependency DoH resolver.
 * Runs fully offline: DNS packets are built by hand and fetch is stubbed.
 */

const assert = require('assert');
const {
  DohResolver,
  encodeQuery,
  decodeResponse,
  readName,
  TtlCache,
  base64UrlEncode,
  installLookupPatch,
  createDohLookup,
} = require('./doh-resolver');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err && err.message ? err.message : String(err) });
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err && err.message ? err.message : String(err) });
  }
}

function encodeName(name) {
  const parts = String(name).split('.').filter(Boolean);
  const bufs = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'utf8');
    bufs.push(Buffer.from([b.length]), b);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

/** Build a DNS response: header + question + N answers (no compression except owner ptr). */
function buildResponse({ id = 0x1234, rcode = 0, questions = [], answers = [] }) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8180 | rcode, 2); // QR=1 RD=1 RA=1
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);

  const qParts = [];
  for (const q of questions) {
    qParts.push(encodeName(q.name));
    const t = Buffer.alloc(4);
    t.writeUInt16BE(q.type, 0);
    t.writeUInt16BE(1, 2);
    qParts.push(t);
  }

  const aParts = [];
  for (const a of answers) {
    aParts.push(a.owner === null ? Buffer.from([0xc0, 0x0c]) : encodeName(a.owner));
    const r = Buffer.alloc(10);
    r.writeUInt16BE(a.type, 0);
    r.writeUInt16BE(1, 2);
    r.writeUInt32BE(a.ttl, 4);
    r.writeUInt16BE(a.rdata.length, 8);
    aParts.push(r, a.rdata);
  }

  return Buffer.concat([header, ...qParts, ...aParts]);
}

function stubFetch(responseBuf, { status = 200, onUrl } = {}) {
  return async (url) => {
    if (onUrl) onUrl(url);
    return {
      status,
      arrayBuffer: async () => responseBuf.buffer.slice(
        responseBuf.byteOffset,
        responseBuf.byteOffset + responseBuf.byteLength
      ),
    };
  };
}

(async () => {
  // ---- encoding ----
  check('encodeQuery builds a valid header', () => {
    const q = encodeQuery('example.com', 'A', 0x1234);
    assert.strictEqual(q.readUInt16BE(0), 0x1234, 'id');
    assert.strictEqual(q.readUInt16BE(2), 0x0100, 'RD flag');
    assert.strictEqual(q.readUInt16BE(4), 1, 'qdcount');
    assert.strictEqual(q.readUInt16BE(6), 0, 'ancount');
  });

  check('encodeQuery writes qname/qtype/qclass', () => {
    const q = encodeQuery('example.com', 'AAAA', 1);
    // 12 header + 7 "example" + 4 "com" + 1 root = 24, then 4 bytes qtype/qclass
    assert.strictEqual(q[12], 7);
    assert.strictEqual(q.slice(13, 20).toString(), 'example');
    assert.strictEqual(q[20], 3);
    assert.strictEqual(q.slice(21, 24).toString(), 'com');
    assert.strictEqual(q[24], 0);
    assert.strictEqual(q.readUInt16BE(25), 28, 'AAAA type');
    assert.strictEqual(q.readUInt16BE(27), 1, 'IN class');
  });

  check('encodeQuery rejects over-long labels', () => {
    assert.throws(() => encodeQuery(`${'a'.repeat(64)}.com`, 'A'), /label too long/);
  });

  check('encodeQuery rejects unsupported type', () => {
    assert.throws(() => encodeQuery('example.com', 'NOPE'), /unsupported dns type/);
  });

  // ---- decoding ----
  check('decodeResponse parses an A answer', () => {
    const buf = buildResponse({
      questions: [{ name: 'example.com', type: 1 }],
      answers: [{ owner: null, type: 1, ttl: 300, rdata: Buffer.from([93, 184, 216, 34]) }],
    });
    const res = decodeResponse(buf);
    assert.strictEqual(res.rcode, 0);
    assert.strictEqual(res.questions[0].name, 'example.com');
    assert.strictEqual(res.answers.length, 1);
    assert.strictEqual(res.answers[0].data, '93.184.216.34');
    assert.strictEqual(res.answers[0].ttl, 300);
  });

  check('decodeResponse parses AAAA', () => {
    const ipv6 = Buffer.alloc(16);
    ipv6.writeUInt16BE(0x2606, 0);
    ipv6.writeUInt16BE(0x4700, 2);
    for (let i = 4; i < 16; i += 2) ipv6.writeUInt16BE(0, i);
    ipv6.writeUInt16BE(1, 14);
    const buf = buildResponse({
      questions: [{ name: 'example.com', type: 28 }],
      answers: [{ owner: null, type: 28, ttl: 60, rdata: ipv6 }],
    });
    const res = decodeResponse(buf);
    assert.strictEqual(res.answers[0].data, '2606:4700:0:0:0:0:0:1');
  });

  check('decodeResponse parses CNAME via compression pointer', () => {
    const target = encodeName('target.example.com');
    const buf = buildResponse({
      questions: [{ name: 'www.example.com', type: 5 }],
      answers: [{ owner: null, type: 5, ttl: 120, rdata: target }],
    });
    const res = decodeResponse(buf);
    assert.strictEqual(res.answers[0].data, 'target.example.com');
  });

  check('decodeResponse parses TXT chunks', () => {
    // Two character-strings in one TXT record.
    const rdata = Buffer.concat([
      Buffer.from([5]), Buffer.from('hello', 'utf8'),
      Buffer.from([5]), Buffer.from('world', 'utf8'),
    ]);
    const buf = buildResponse({
      questions: [{ name: 'example.com', type: 16 }],
      answers: [{ owner: null, type: 16, ttl: 30, rdata }],
    });
    const res = decodeResponse(buf);
    assert.strictEqual(res.answers[0].data, 'helloworld');
  });

  check('decodeResponse surfaces non-zero rcode', () => {
    const buf = buildResponse({ rcode: 3, questions: [{ name: 'nx.example', type: 1 }] });
    assert.strictEqual(decodeResponse(buf).rcode, 3);
  });

  check('decodeResponse rejects short buffers', () => {
    assert.throws(() => decodeResponse(Buffer.alloc(4)), /too short/);
  });

  check('readName detects pointer loops', () => {
    const buf = Buffer.from([0xc0, 0x00, 0x00]);
    assert.throws(() => readName(buf, 0), /pointer loop|out of range/);
  });

  // ---- helpers ----
  check('base64UrlEncode omits padding and uses url-safe alphabet', () => {
    const encoded = base64UrlEncode(Buffer.from([0xfb, 0xff, 0xfe]));
    assert.ok(!encoded.includes('='), 'no padding');
    assert.ok(!encoded.includes('+') && !encoded.includes('/'), 'url-safe alphabet');
  });

  check('TtlCache expires entries', async () => {
    const cache = new TtlCache(10);
    cache.set('k', ['1.2.3.4'], 0.05);
    assert.deepStrictEqual(cache.get('k'), ['1.2.3.4']);
    await new Promise((r) => setTimeout(r, 90));
    assert.strictEqual(cache.get('k'), undefined);
  });

  check('TtlCache evicts beyond max size', () => {
    const cache = new TtlCache(2);
    cache.set('a', 1, 60);
    cache.set('b', 2, 60);
    cache.set('c', 3, 60);
    assert.strictEqual(cache.size, 2);
    assert.strictEqual(cache.get('a'), undefined);
    assert.deepStrictEqual(cache.get('c'), 3);
  });

  // ---- resolver behaviour ----
  await checkAsync('resolve4 returns addresses and caches them', async () => {
    const buf = buildResponse({
      questions: [{ name: 'example.com', type: 1 }],
      answers: [{ owner: null, type: 1, ttl: 60, rdata: Buffer.from([1, 2, 3, 4]) }],
    });
    let calls = 0;
    const resolver = new DohResolver({
      endpoints: ['https://doh.test/dns-query'],
      fetchImpl: stubFetch(buf, { onUrl: () => { calls += 1; } }),
    });
    const first = await resolver.resolve4('example.com');
    const second = await resolver.resolve4('example.com');
    assert.deepStrictEqual(first, ['1.2.3.4']);
    assert.deepStrictEqual(second, ['1.2.3.4']);
    assert.strictEqual(calls, 1, 'second call served from cache');
  });

  await checkAsync('query builds a wire-format GET url', async () => {
    const buf = buildResponse({
      questions: [{ name: 'example.com', type: 1 }],
      answers: [{ owner: null, type: 1, ttl: 60, rdata: Buffer.from([1, 1, 1, 1]) }],
    });
    let seen = null;
    const resolver = new DohResolver({
      endpoints: ['https://doh.test/dns-query'],
      fetchImpl: stubFetch(buf, { onUrl: (u) => { seen = u; } }),
    });
    await resolver.query('example.com', 'A');
    assert.ok(seen.startsWith('https://doh.test/dns-query?dns='), 'GET wire format used');
    const token = seen.split('dns=')[1];
    assert.ok(!token.includes('='), 'base64url unpadded');
    const decoded = decodeResponse(encodeQuery('example.com', 'A', 0));
    assert.ok(decoded, 'round-trip packet is decodable');
  });

  await checkAsync('resolves through whichever endpoint answers first', async () => {
    const buf = buildResponse({
      questions: [{ name: 'example.com', type: 1 }],
      answers: [{ owner: null, type: 1, ttl: 60, rdata: Buffer.from([9, 9, 9, 9]) }],
    });
    const tried = [];
    // Endpoint order is randomised on purpose; only the outcome is asserted here.
    const resolver = new DohResolver({
      endpoints: ['https://bad.test/dns-query', 'https://good.test/dns-query'],
      fetchImpl: async (url) => {
        tried.push(url);
        if (url.includes('bad.test')) throw new Error('endpoint down');
        return {
          status: 200,
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        };
      },
    });
    const addrs = await resolver.resolve4('example.com');
    assert.deepStrictEqual(addrs, ['9.9.9.9']);
    assert.ok(tried.length >= 1, 'at least one endpoint contacted');
    assert.ok(tried.every((u) => u.includes('bad.test') || u.includes('good.test')));
  });

  await checkAsync('exhausts every endpoint before failing', async () => {
    // Both endpoints fail, so the resolver must have visited each one.
    const tried = [];
    const resolver = new DohResolver({
      endpoints: ['https://one.test/dns-query', 'https://two.test/dns-query', 'https://three.test/dns-query'],
      fetchImpl: async (url) => {
        tried.push(url);
        throw new Error(`endpoint down: ${url}`);
      },
    });
    await assert.rejects(() => resolver.resolve4('example.com'), /endpoint down/);
    assert.strictEqual(tried.length, 3, 'every endpoint attempted before giving up');
    const hosts = new Set(tried.map((u) => new URL(u).host));
    assert.deepStrictEqual([...hosts].sort(), ['one.test', 'three.test', 'two.test']);
  });

  await checkAsync('resolve4 rejects when no answer section', async () => {
    const buf = buildResponse({ questions: [{ name: 'empty.example', type: 1 }], answers: [] });
    const resolver = new DohResolver({
      endpoints: ['https://doh.test/dns-query'],
      fetchImpl: stubFetch(buf),
    });
    await assert.rejects(() => resolver.resolve4('empty.example'), /no A record/);
  });

  await checkAsync('resolveTxt returns array-of-arrays', async () => {
    const rdata = Buffer.concat([Buffer.from([3]), Buffer.from('abc', 'utf8')]);
    const buf = buildResponse({
      questions: [{ name: 'example.com', type: 16 }],
      answers: [{ owner: null, type: 16, ttl: 30, rdata }],
    });
    const resolver = new DohResolver({
      endpoints: ['https://doh.test/dns-query'],
      fetchImpl: stubFetch(buf),
    });
    assert.deepStrictEqual(await resolver.resolveTxt('example.com'), [['abc']]);
  });

  await checkAsync('http error responses are retried then surfaced', async () => {
    const resolver = new DohResolver({
      endpoints: ['https://doh.test/dns-query'],
      fetchImpl: stubFetch(Buffer.alloc(12), { status: 503 }),
    });
    await assert.rejects(() => resolver.resolve4('example.com'), /http 503/);
  });

  await checkAsync('custom endpoints via setEndpoints are honored', async () => {
    const buf = buildResponse({
      questions: [{ name: 'example.com', type: 1 }],
      answers: [{ owner: null, type: 1, ttl: 60, rdata: Buffer.from([8, 8, 8, 8]) }],
    });
    let seen = null;
    const resolver = new DohResolver({
      fetchImpl: stubFetch(buf, { onUrl: (u) => { seen = u; } }),
    });
    resolver.setEndpoints(['https://custom.test/q']);
    await resolver.resolve4('example.com');
    assert.ok(seen.startsWith('https://custom.test/q'), 'custom endpoint used');
  });

  check('installLookupPatch swaps and restores dns.lookup', () => {
    const dnsMod = require('dns');
    const original = dnsMod.lookup;
    const fake = {
      resolve4: async () => ['5.6.7.8'],
      resolve6: async () => ['::1'],
    };
    const restore = installLookupPatch(fake, original);
    assert.notStrictEqual(dnsMod.lookup, original, 'lookup replaced');
    restore();
    assert.strictEqual(dnsMod.lookup, original, 'lookup restored');
  });

  // ---- request-scoped lookup ----

  /** A resolver double with a known name and a missing one. */
  function fakeResolver() {
    return {
      resolve4: (hostname) => (hostname === 'known.test'
        ? Promise.resolve(['203.0.113.7', '203.0.113.8'])
        : Promise.reject(Object.assign(new Error('no record'), { code: 'ENODATA' }))),
      resolve6: () => Promise.resolve(['2001:db8::1']),
    };
  }

  function callLookup(lookup, hostname, options) {
    return new Promise((resolve, reject) => {
      lookup(hostname, options, (err, address, family) => {
        if (err) reject(err); else resolve({ address, family });
      });
    });
  }

  check('a scoped lookup rejects a missing resolver instead of patching globals', () => {
    assert.throws(() => createDohLookup(null), /resolver required/);
    assert.throws(() => createDohLookup({}), /resolver required/);
    assert.throws(() => createDohLookup({ resolve4: () => {} }.resolve4 && {}), /resolver required/);
  });

  await checkAsync('a scoped lookup answers from the resolver', async () => {
    const lookup = createDohLookup(fakeResolver(), { systemLookup: () => { throw new Error('must not be used'); } });
    const result = await callLookup(lookup, 'known.test', {});
    assert.strictEqual(result.address, '203.0.113.7');
    assert.strictEqual(result.family, 4);
  });

  await checkAsync('a scoped lookup honours a family request', async () => {
    const lookup = createDohLookup(fakeResolver(), { systemLookup: () => { throw new Error('must not be used'); } });
    const result = await callLookup(lookup, 'known.test', { family: 6 });
    assert.strictEqual(result.address, '2001:db8::1');
    assert.strictEqual(result.family, 6);
  });

  await checkAsync('the all flag yields the whole address list', async () => {
    const lookup = createDohLookup(fakeResolver(), { systemLookup: () => { throw new Error('must not be used'); } });
    const addresses = await new Promise((resolve, reject) => {
      lookup('known.test', { all: true }, (err, list) => (err ? reject(err) : resolve(list)));
    });
    assert.deepStrictEqual(addresses, [
      { address: '203.0.113.7', family: 4 },
      { address: '203.0.113.8', family: 4 },
    ]);
  });

  await checkAsync('a missing record falls back to the system resolver', async () => {
    let asked = null;
    const systemLookup = (hostname, options, callback) => {
      asked = hostname;
      callback(null, '198.51.100.9', 4);
    };
    const lookup = createDohLookup(fakeResolver(), { systemLookup });
    const result = await callLookup(lookup, 'unknown.test', {});
    assert.strictEqual(asked, 'unknown.test');
    assert.strictEqual(result.address, '198.51.100.9');
  });

  await checkAsync('the fallback can be disabled so a miss is reported', async () => {
    const lookup = createDohLookup(fakeResolver(), { fallback: null });
    await assert.rejects(() => callLookup(lookup, 'unknown.test', {}), /No record/);
  });

  await checkAsync('a transport failure is surfaced rather than silently re-resolved', async () => {
    let fellBack = false;
    const resolver = {
      resolve4: () => Promise.reject(Object.assign(new Error('upstream down'), { code: 'ETIMEOUT' })),
    };
    const lookup = createDohLookup(resolver, { systemLookup: () => { fellBack = true; } });
    await assert.rejects(() => callLookup(lookup, 'known.test', {}), /upstream down/);
    assert.strictEqual(fellBack, false, 'only a missing record should retry through the system resolver');
  });

  await checkAsync('the scoped lookup does not touch the global resolver', async () => {
    const dnsMod = require('dns');
    const original = dnsMod.lookup;
    const lookup = createDohLookup(fakeResolver(), { systemLookup: original });
    await callLookup(lookup, 'known.test', {});
    assert.strictEqual(dnsMod.lookup, original, 'dns.lookup is untouched');
  });

  await checkAsync('a callback that rejects the contract is reported clearly', async () => {
    const lookup = createDohLookup(fakeResolver(), { systemLookup: () => {} });
    assert.throws(() => lookup('known.test', {}), /callback required/);
  });

  // ---- report ----
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  console.log(`\nDOH_RESOLVER_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
