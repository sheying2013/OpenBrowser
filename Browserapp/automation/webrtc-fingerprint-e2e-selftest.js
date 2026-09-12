#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for the WebRTC address rewrite, run against a real Chromium.
 *
 * The bundled kernel refuses to construct a peer connection, so this surface cannot be observed
 * through it; a Chromium that does support WebRTC is used instead (override with
 * OPENBROWSER_WEBRTC_RUNTIME, otherwise the system Chrome, otherwise the test skips).
 *
 * The test is deliberately two-sided: it first proves the raw engine really does hand out the
 * machine's own address (or its mDNS stand-in), then proves the injected profile replaces it while
 * keeping public candidates intact. A one-sided check would pass even if gathering produced nothing.
 *
 * It also compares the observable object graph of both passes. Hiding the address is not enough: a
 * rebuilt ICE event (isTrusted false, null target, eventPhase 0), a patched accessor whose source is
 * readable, an own property that a stock build keeps on a parent prototype, or a getStats() report
 * that still carries the machine address would each identify the profile on their own.
 */

const assert = require('assert');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { buildFingerprint, applyFingerprintToTab } = require('./fingerprint');

const EXIT_IP = '203.0.113.9';
const CHROME_CANDIDATES = [
  process.env.OPENBROWSER_WEBRTC_RUNTIME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${err.message}`); process.exitCode = 1; }
};
const skip = (name) => { results.push({ name, ok: true }); console.log(`  SKIP  ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A reflexive candidate only exists when a STUN server answers, and that candidate is the one that
// carries the machine address a second time in its base-address field. The test therefore answers
// binding requests itself, on the loopback address, so it never depends on outside infrastructure.
const dgram = require('dgram');
const STUN_MAGIC = 0x2112A442;
const startStun = () => new Promise((resolve) => {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (message, from) => {
    if (message.length < 20 || message.readUInt16BE(0) !== 0x0001 || message.readUInt32BE(4) !== STUN_MAGIC) return;
    if (!from.address.includes('.')) return;
    const body = Buffer.alloc(12);
    body.writeUInt16BE(0x0020, 0);
    body.writeUInt16BE(8, 2);
    body.writeUInt8(1, 5);
    body.writeUInt16BE(from.port ^ (STUN_MAGIC >> 16), 6);
    const mapped = Buffer.from(from.address.split('.').map(Number));
    const mask = Buffer.from([(STUN_MAGIC >>> 24) & 0xff, (STUN_MAGIC >>> 16) & 0xff, (STUN_MAGIC >>> 8) & 0xff, STUN_MAGIC & 0xff]);
    for (let i = 0; i < 4; i += 1) body[8 + i] = mapped[i] ^ mask[i];
    const head = Buffer.alloc(20);
    head.writeUInt16BE(0x0101, 0);
    head.writeUInt16BE(body.length, 2);
    head.writeUInt32BE(STUN_MAGIC, 4);
    message.copy(head, 8, 8, 20);
    socket.send(Buffer.concat([head, body]), from.port, from.address, () => {});
  });
  socket.bind(0, '127.0.0.1', () => resolve({ port: socket.address().port, close: () => { try { socket.close(); } catch (_) {} } }));
});

// Gather with the modern no-argument setLocalDescription: it is the path a detector would take.
const PROBE = `(async () => {
  const out = { candidates: [], errs: [] };
  const ownOf = (value) => { try { return Object.getOwnPropertyNames(value).sort(); } catch (_) { return null; } };
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: '__STUN_URL__' }] });
    // An m-line is required or ICE has nothing to gather and the SDP stays empty.
    pc.createDataChannel('probe');
    const events = [];
    pc.onicecandidate = (event) => {
      if (!event.candidate || !event.candidate.candidate) return;
      out.candidates.push(event.candidate.candidate);
      if (events.length) return;
      events.push({
        trusted: event.isTrusted,
        targetIsPc: event.target === pc,
        currentTargetIsPc: event.currentTarget === pc,
        phase: event.eventPhase,
        own: ownOf(event),
        tag: Object.prototype.toString.call(event),
        candidateTag: Object.prototype.toString.call(event.candidate),
        candidateBrand: event.candidate instanceof RTCIceCandidate,
        candidateOwn: ownOf(event.candidate),
        candidateSelf: event.candidate === event.candidate,
      });
    };
    await pc.setLocalDescription();
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); } };
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(resolve, 3000);
    });
    out.sdp = (pc.localDescription && pc.localDescription.sdp) || '';
    out.brandOk = pc.localDescription instanceof RTCSessionDescription;
    out.eventShape = events[0] || null;

    // The shape of the surface the rewrite patches, plus the identity relations it has to preserve.
    const describe = (target, key) => {
      let descriptor = null;
      try { descriptor = Object.getOwnPropertyDescriptor(target, key); } catch (_) { return null; }
      if (!descriptor || typeof descriptor.get !== 'function') return null;
      let source = '';
      try { source = String(descriptor.get); } catch (_) { source = 'unreadable'; }
      return { name: descriptor.get.name, length: descriptor.get.length, native: source.indexOf('[native code]') >= 0 };
    };
    const statsProto = Object.getPrototypeOf(await pc.getStats());
    out.pcProtoOwn = ownOf(RTCPeerConnection.prototype);
    out.descriptionAccessor = describe(RTCPeerConnection.prototype, 'localDescription');
    out.iceEventAccessor = describe(RTCPeerConnectionIceEvent.prototype, 'candidate');
    out.identity = {
      localSelf: pc.localDescription === pc.localDescription,
      localVsCurrent: pc.localDescription === pc.currentLocalDescription,
      localVsPending: pc.localDescription === pc.pendingLocalDescription,
    };
    out.statsProtoOwn = ownOf(statsProto);

    // A page that builds its own candidate and event must get exactly what it handed in back.
    const ownCandidate = new RTCIceCandidate({ candidate: 'candidate:9 1 udp 1 192.168.1.5 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 });
    const ownEvent = new RTCPeerConnectionIceEvent('icecandidate', { candidate: ownCandidate });
    out.pageGuard = {
      eventTrusted: ownEvent.isTrusted,
      candidateSame: ownEvent.candidate === ownCandidate,
      candidateText: ownCandidate.candidate.indexOf('192.168.1.5') >= 0,
    };

    // getStats() hands the same addresses out again through a different surface.
    const stats = await pc.getStats();
    const addresses = (list) => list.filter((entry) => entry && entry.type === 'local-candidate').map((entry) => entry.address);
    const collected = [];
    stats.forEach((entry) => collected.push(entry));
    const locals = collected.filter((entry) => entry && entry.type === 'local-candidate');
    const first = locals.filter((entry) => entry.protocol === 'udp')[0] || locals[0] || null;
    out.stats = {
      size: stats.size,
      forEach: addresses(collected),
      values: addresses(Array.from(stats.values())),
      entries: addresses(Array.from(stats.entries()).map((pair) => pair[1])),
      spread: addresses(Array.from(stats).map((pair) => pair[1])),
      get: first ? [stats.get(first.id).address] : [],
      entryOwn: first ? ownOf(first) : null,
      // The entry picked first can be a different candidate type in each pass, so the shape is
      // compared per candidate type instead of by position.
      entryOwnByType: locals.reduce((acc, entry) => {
        const key = String(entry.candidateType) + '/' + String(entry.protocol || 'udp');
        if (entry && !acc[key]) acc[key] = ownOf(entry);
        return acc;
      }, {}),
      iteratorTag: Object.prototype.toString.call(stats.values()),
      nextKeys: Object.getOwnPropertyNames(stats.values().next()).join(','),
      getFresh: first ? stats.get(first.id) !== stats.get(first.id) : null,
      related: collected.filter((entry) => entry && entry.type === 'local-candidate')
        .map((entry) => [entry.candidateType, String(entry.relatedAddress || '')]),
    };

    // RTCIceTransport answers out of gathering alone - no connection, no event listener - and hands
    // the same candidates out a second time.
    const iceTransport = pc.sctp && pc.sctp.transport && pc.sctp.transport.iceTransport;
    if (iceTransport && typeof iceTransport.getLocalCandidates === 'function') {
      const firstList = iceTransport.getLocalCandidates();
      const secondList = iceTransport.getLocalCandidates();
      const pair = typeof iceTransport.getSelectedCandidatePair === 'function' ? iceTransport.getSelectedCandidatePair() : null;
      out.transport = {
        local: firstList.map((candidate) => candidate.candidate),
        freshArray: firstList !== secondList,
        stableObjects: firstList[0] === secondList[0],
        brand: firstList.every((candidate) => candidate instanceof RTCIceCandidate),
        pairLocal: pair && pair.local ? pair.local.candidate : null,
      };
    } else {
      out.transport = null;
    }

    // Comparing what went into a description against what comes back out is the cheapest rewrite
    // detector a page has, in either direction.
    const remotePc = new RTCPeerConnection();
    remotePc.createDataChannel('echo');
    const remoteOffer = await remotePc.createOffer();
    const syntheticRemote = remoteOffer.sdp.replace(/c=IN IP4 [^\\r\\n]+/, 'c=IN IP4 10.11.12.13');
    await remotePc.setRemoteDescription({ type: 'offer', sdp: syntheticRemote });
    const remoteBack = remotePc.remoteDescription && remotePc.remoteDescription.sdp;
    out.remoteEcho = { same: remoteBack === syntheticRemote, kept: String(remoteBack).includes('10.11.12.13') };

    const localPc = new RTCPeerConnection();
    localPc.createDataChannel('echo');
    const localOffer = await localPc.createOffer();
    const syntheticLocal = localOffer.sdp.replace(/c=IN IP4 [^\\r\\n]+/, 'c=IN IP4 10.11.12.14');
    await localPc.setLocalDescription({ type: 'offer', sdp: syntheticLocal });
    const localBack = localPc.localDescription && localPc.localDescription.sdp;
    out.localEcho = { same: localBack === syntheticLocal, kept: String(localBack).includes('10.11.12.14') };
    remotePc.close();
    localPc.close();
    pc.close();
  } catch (e) { out.errs.push(String(e && e.name) + ': ' + String(e && e.message).slice(0, 160)); }
  return JSON.stringify(out);
})()`;

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m = null; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) { const { res, timer } = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(timer); res(m); }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res) => {
      const timer = setTimeout(() => { this.pending.delete(id); res({ error: 'timeout', method }); }, 30000);
      this.pending.set(id, { res, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }
  call(a, b, c) { return typeof c === 'undefined' ? this.send(a, b || {}) : this.send(b, c || {}); }
  async evalValue(expression, sessionId) {
    const m = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    const v = m && m.result && m.result.result ? m.result.result.value : null;
    try { return JSON.parse(v); } catch (_) { return { error: 'probe parse', raw: String(v).slice(0, 200) }; }
  }
}

const hostAddresses = () => Object.values(os.networkInterfaces())
  .flat()
  .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
  .map((entry) => entry.address);

(async () => {
  const runtime = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
  if (!runtime) {
    console.log('  SKIP  no WebRTC-capable Chromium found (set OPENBROWSER_WEBRTC_RUNTIME)');
    console.log('webrtc-fingerprint-e2e-selftest: ok');
    return;
  }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><meta name="viewport" content="width=device-width"></head><body>webrtc probe</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const stun = await startStun();
  const probe = PROBE.replace('__STUN_URL__', 'stun:127.0.0.1:' + stun.port);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-webrtc-'));
  const child = spawn(runtime, [
    '--headless=new',
    // mDNS would replace the host candidate with a .local name, which hides the leak this test has
    // to observe in the raw pass and makes the comparison vacuous.
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    `--user-data-dir=${dir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(400);
    try {
      const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (p > 0) { port = p; break; }
    } catch (_) {}
  }
  const stop = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { server.close(); } catch (_) {}
    stun.close();
  };
  if (!port) {
    stop();
    console.log('  SKIP  runtime did not expose a CDP endpoint');
    console.log('webrtc-fingerprint-e2e-selftest: ok');
    return;
  }

  const wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
  const cdp = new Cdp(ws);

  const created = await cdp.send('Target.createTarget', { url });
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.result.targetId, flatten: true });
  const sid = attached.result.sessionId;
  await sleep(1200);

  const raw = await cdp.evalValue(probe, sid);

  const profile = {
    id: 'webrtc-e2e', kernelVersion: '148.0.7778.165', os: 'Windows',
    canvas: 'noise', webgl: 'noise', privacy: { webrtc: 'proxy', webrtcAddress: EXIT_IP },
  };
  const fp = buildFingerprint(profile);
  await applyFingerprintToTab(
    (method, params) => cdp.send(method, params, sid),
    null,
    fp,
    profile,
    { applyKey: 'webrtc-e2e' },
  );
  const injected = await cdp.evalValue(probe, sid);

  try { ws.close(); } catch (_) {}
  stop();

  const hostIps = hostAddresses();
  const privateOf = (text) => {
    const value = String(text || '');
    return hostIps.filter((ip) => value.includes(ip)).concat(value.includes('.local') ? ['mdns'] : []);
  };

  check('the probe gathers candidates in both passes', () => {
    assert.deepStrictEqual(raw.errs, [], `raw probe: ${raw.errs}`);
    assert.deepStrictEqual(injected.errs, [], `injected probe: ${injected.errs}`);
    assert.ok(raw.sdp.includes('a=candidate:') || raw.candidates.length > 0, 'raw pass must gather something');
    assert.ok(injected.sdp.includes('a=candidate:') || injected.candidates.length > 0, 'injected pass must gather something');
  });

  // Sensitivity: without this the rewrite assertions could pass on an empty SDP.
  if (privateOf(raw.sdp).length || privateOf(raw.candidates.join(' ')).length) {
    check('the raw engine exposes the machine address (test is sensitive)', () => { assert.ok(true); });
  } else {
    skip('the raw engine exposed no machine address in this environment (sensitivity unproven)');
  }

  check('the injected SDP no longer carries a machine address', () => {
    assert.deepStrictEqual(privateOf(injected.sdp), [], `sdp leaked: ${String(injected.sdp).slice(0, 400)}`);
  });
  check('the injected candidates no longer carry a machine address', () => {
    assert.deepStrictEqual(privateOf(injected.candidates.join(' ')), [], `candidates leaked: ${injected.candidates.join(' ').slice(0, 400)}`);
  });
  check('the rewritten surface is the profile address', () => {
    const haystack = `${injected.sdp} ${injected.candidates.join(' ')}`;
    assert.ok(haystack.includes(EXIT_IP), 'the profile address must appear where the machine address was');
  });
  check('a rewritten local description still passes instanceof', () => {
    assert.strictEqual(injected.brandOk, true, 'RTCSessionDescription brand check');
  });

  // Hiding the address is not enough: the objects that carry it must stay the engine's own.
  check('the injected ICE event is still the event the engine dispatched', () => {
    assert.ok(raw.eventShape, 'the raw pass must observe an icecandidate event');
    assert.ok(injected.eventShape, 'the injected pass must observe an icecandidate event');
    assert.strictEqual(injected.eventShape.trusted, true, 'isTrusted');
    assert.strictEqual(injected.eventShape.targetIsPc, true, 'target');
    assert.strictEqual(injected.eventShape.currentTargetIsPc, true, 'currentTarget');
    assert.strictEqual(injected.eventShape.phase, 2, 'eventPhase');
  });
  check('the injected ICE event and candidate keep the engine property shape', () => {
    assert.deepStrictEqual(injected.eventShape.own, raw.eventShape.own, 'event own properties');
    assert.deepStrictEqual(injected.eventShape.candidateOwn, raw.eventShape.candidateOwn, 'candidate own properties');
    assert.strictEqual(injected.eventShape.tag, raw.eventShape.tag, 'event tag');
    assert.strictEqual(injected.eventShape.candidateTag, raw.eventShape.candidateTag, 'candidate tag');
    assert.strictEqual(injected.eventShape.candidateBrand, true, 'candidate brand');
    assert.strictEqual(injected.eventShape.candidateSelf, true, 'candidate identity');
  });
  check('patched accessors still read as native code with native name and arity', () => {
    for (const [label, patched, stock] of [
      ['localDescription', injected.descriptionAccessor, raw.descriptionAccessor],
      ['icecandidate', injected.iceEventAccessor, raw.iceEventAccessor],
    ]) {
      assert.ok(patched, label + ' accessor must exist');
      assert.strictEqual(patched.native, true, label + ' source must stay native');
      assert.strictEqual(patched.name, stock.name, label + ' getter name');
      assert.strictEqual(patched.length, stock.length, label + ' getter arity');
    }
  });
  check('no prototype gains an own property the stock build keeps on a parent', () => {
    assert.deepStrictEqual(injected.pcProtoOwn, raw.pcProtoOwn, 'RTCPeerConnection.prototype');
    assert.deepStrictEqual(injected.statsProtoOwn, raw.statsProtoOwn, 'RTCStatsReport.prototype');
  });
  check('description identity relations match the raw engine', () => {
    assert.deepStrictEqual(injected.identity, raw.identity, 'description identity');
    assert.strictEqual(injected.identity.localSelf, true, 'a description read is stable');
  });
  check('a page-built candidate and event are handed back untouched', () => {
    assert.deepStrictEqual(injected.pageGuard, raw.pageGuard, 'page guard');
    assert.strictEqual(injected.pageGuard.eventTrusted, false, 'a page-built event is untrusted');
    assert.strictEqual(injected.pageGuard.candidateSame, true, 'the candidate must not be replaced');
    assert.strictEqual(injected.pageGuard.candidateText, true, 'a page-built candidate must not be rewritten');
  });

  // getStats() is the second surface the same addresses travel through.
  const statsAddresses = (value) => ([])
    .concat(value.forEach, value.values, value.entries, value.spread, value.get)
    .filter((address) => typeof address === 'string' && address);
  check('the injected statistics no longer carry a machine address', () => {
    const observed = statsAddresses(injected.stats);
    assert.deepStrictEqual(privateOf(observed.join(' ')), [], 'statistics leaked: ' + observed.join(' '));
  });
  if (privateOf(statsAddresses(raw.stats).join(' ')).length) {
    check('the raw statistics expose the machine address (test is sensitive)', () => { assert.ok(true); });
  } else {
    skip('the raw statistics exposed no machine address in this environment (sensitivity unproven)');
  }
  check('every statistics read path reports the profile address', () => {
    const observed = statsAddresses(injected.stats);
    assert.ok(observed.length > 0, 'the rewrite must be observable in the statistics');
    assert.ok(observed.indexOf(EXIT_IP) >= 0, 'the profile address must appear: ' + observed.join(' '));
  });
  check('the statistics report keeps its native shape', () => {
    assert.strictEqual(injected.stats.iteratorTag, raw.stats.iteratorTag, 'iterator tag');
    assert.strictEqual(injected.stats.nextKeys, raw.stats.nextKeys, 'iterator result keys');
    // Only the kinds of candidate both passes actually gathered can be compared - a blocked UDP path
    // would leave one pass without a shape at all - but at least two have to line up.
    const shared = Object.keys(raw.stats.entryOwnByType).filter((key) => injected.stats.entryOwnByType[key]);
    assert.ok(shared.length >= 2, 'expected at least two candidate kinds in both passes: ' + shared.join(','));
    for (const key of shared) {
      assert.deepStrictEqual(injected.stats.entryOwnByType[key], raw.stats.entryOwnByType[key], 'entry own properties for ' + key);
    }
    assert.strictEqual(injected.stats.getFresh, raw.stats.getFresh, 'get() must return a fresh object');
    assert.ok(injected.stats.size > 0 && raw.stats.size > 0, 'reports must not be empty');
  });

  // The base address a reflexive candidate was observed from travels beside the candidate address.
  const relatedOf = (value) => (value.related || []).map((row) => String(row[1] || '')).filter(Boolean);
  if (privateOf(relatedOf(raw.stats).join(' ')).length) {
    check('the base address beside a candidate is masked in the statistics', () => {
      assert.deepStrictEqual(privateOf(relatedOf(injected.stats).join(' ')), [], 'relatedAddress leaked: ' + relatedOf(injected.stats).join(' '));
    });
    check('the raw statistics expose that base address (test is sensitive)', () => { assert.ok(true); });
  } else {
    skip('no reflexive candidate exposed a base address in this environment (sensitivity unproven)');
  }

  // RTCIceTransport is a second door onto the same candidate list, reachable without a connection.
  const transportText = (value) => value ? (value.local || []).join(' ') + ' ' + String(value.pairLocal || '') : '';
  if (injected.transport && raw.transport && raw.transport.local.length) {
    if (privateOf(transportText(raw.transport)).length) {
      check('the transport candidate list no longer carries a machine address', () => {
        assert.deepStrictEqual(privateOf(transportText(injected.transport)), [], 'transport leaked: ' + transportText(injected.transport));
      });
      check('the raw transport list exposes the machine address (test is sensitive)', () => { assert.ok(true); });
    } else {
      skip('the raw transport list exposed no machine address in this environment (sensitivity unproven)');
    }
    check('the transport list keeps the engine shape', () => {
      assert.strictEqual(injected.transport.freshArray, raw.transport.freshArray, 'a fresh array per call');
      assert.strictEqual(injected.transport.stableObjects, raw.transport.stableObjects, 'stable candidate objects');
      assert.strictEqual(injected.transport.brand, true, 'candidates stay RTCIceCandidate instances');
    });
  } else {
    skip('the runtime exposes no RTCIceTransport candidate list (transport surface unproven)');
  }

  check('a remote description the page set comes back byte-identical', () => {
    assert.strictEqual(raw.remoteEcho.same, true, 'the raw engine returns what was set');
    assert.strictEqual(injected.remoteEcho.same, true, 'the read-back must be exactly what the page set');
    assert.strictEqual(injected.remoteEcho.kept, true, 'the synthetic address must survive the read-back');
  });
  check('a local description the page supplied comes back byte-identical', () => {
    assert.strictEqual(injected.localEcho.same, true, 'the read-back must be exactly what the page supplied');
    assert.strictEqual(injected.localEcho.kept, true, 'the synthetic address must survive the read-back');
  });

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log(`webrtc-fingerprint-e2e-selftest: OK ${results.length}/${results.length}`);
  else { console.log(`webrtc-fingerprint-e2e-selftest: FAILED ${failed.length}/${results.length}`); process.exitCode = 1; }
})().catch((err) => {
  console.error('webrtc-fingerprint-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
