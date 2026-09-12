'use strict';

// Guards the WebRTC rewrite the injector installs for `proxy` mode.
//
// The bundled kernel refuses to build a peer connection at all, so this layer can never be observed
// through it; the surfaces it protects still exist on a stock Chromium kernel. The block is lifted
// straight out of the generated page script and driven against a programmable peer connection, so
// every path the page can take — createOffer, the no-argument setLocalDescription, the description
// getters, the icecandidate handler and addEventListener — is checked without a browser.

const assert = require('assert');
const vm = require('vm');
const { buildFingerprint, buildInjectionScript } = require('./fingerprint');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  PASS  ' + name); passed += 1; };

const EXIT_IP = '203.0.113.9';
const PRIVATE_V4 = '192.168.1.20';
const PUBLIC_V4 = '198.51.100.7';
const PUBLIC_RELAY = '198.51.100.8';

const HOST_V4 = `a=candidate:1 1 udp 2113937151 ${PRIVATE_V4} 55555 typ host generation 0 ufrag abcd network-cost 999`;
const HOST_V6 = 'a=candidate:2 1 udp 2113939711 fe80::c8f:1%en0 55556 typ host generation 0 ufrag abcd network-cost 999';
const HOST_MDNS = 'a=candidate:3 1 udp 2113932031 8b3f9d1c-1234.local 55557 typ host generation 0 ufrag abcd network-cost 999';
const SRFLX = `a=candidate:4 1 udp 1685987071 ${PUBLIC_V4} 55558 typ srflx raddr ${PRIVATE_V4} rport 55555 generation 0 ufrag abcd network-cost 999`;
const RELAY = `a=candidate:5 1 udp 41885439 ${PUBLIC_RELAY} 55559 typ relay raddr 0.0.0.0 rport 0 generation 0 ufrag abcd network-cost 999`;

const STUBS = `
globalThis.window = globalThis;
class DOMException extends Error {
  constructor(message, name) { super(message); this.name = name || 'Error'; }
}
const SDP = ${JSON.stringify([
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:abcd',
  'a=ice-pwd:abcdefghijklmnopqrstuvwx',
  HOST_V4,
  HOST_V6,
  HOST_MDNS,
  SRFLX,
  RELAY,
  'a=end-of-candidates',
].join(String.fromCharCode(10)))};

class RTCSessionDescription {
  constructor(init) { this.type = init.type; this.sdp = init.sdp; }
  toJSON() { return { type: this.type, sdp: this.sdp }; }
}
class RTCIceCandidate {
  constructor(init) {
    this.candidate = init.candidate;
    this.sdpMid = init.sdpMid;
    this.sdpMLineIndex = init.sdpMLineIndex;
    this.usernameFragment = init.usernameFragment;
  }
  toJSON() { return { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex }; }
}
class RTCPeerConnectionIceEvent {
  constructor(type, init) { this.type = type; this.candidate = (init && init.candidate) || null; this.url = (init && init.url) || ''; }
}
function RTCPeerConnection() { this._local = null; this._onice = null; this._listeners = new Map(); }
RTCPeerConnection.prototype.createOffer = async function createOffer() { return { type: 'offer', sdp: SDP }; };
RTCPeerConnection.prototype.createAnswer = async function createAnswer() { return { type: 'answer', sdp: SDP }; };
RTCPeerConnection.prototype.setLocalDescription = async function setLocalDescription(desc) {
  const src = desc === undefined ? { type: 'offer', sdp: SDP } : desc;
  this._local = new RTCSessionDescription({ type: src.type, sdp: src.sdp });
};
Object.defineProperty(RTCPeerConnection.prototype, 'localDescription', {
  configurable: true, enumerable: true, get() { return this._local; },
});
Object.defineProperty(RTCPeerConnection.prototype, 'currentLocalDescription', {
  configurable: true, enumerable: true, get() { return this._local; },
});
Object.defineProperty(RTCPeerConnection.prototype, 'pendingLocalDescription', {
  configurable: true, enumerable: true, get() { return null; },
});
Object.defineProperty(RTCPeerConnection.prototype, 'onicecandidate', {
  configurable: true, enumerable: true,
  get() { return this._onice; },
  set(fn) { this._onice = typeof fn === 'function' ? fn : null; },
});
RTCPeerConnection.prototype.addEventListener = function addEventListener(type, listener) {
  const list = this._listeners.get(type) || [];
  list.push(listener);
  this._listeners.set(type, list);
};
RTCPeerConnection.prototype.removeEventListener = function removeEventListener(type, listener) {
  this._listeners.set(type, (this._listeners.get(type) || []).filter((fn) => fn !== listener));
};
RTCPeerConnection.prototype.emitCandidate = function emitCandidate(line) {
  const candidate = new RTCIceCandidate({ candidate: line, sdpMid: '0', sdpMLineIndex: 0 });
  const event = new RTCPeerConnectionIceEvent('icecandidate', { candidate: candidate });
  if (typeof this._onice === 'function') this._onice(event);
  for (const fn of (this._listeners.get('icecandidate') || []).slice()) fn(event);
};
const replaceMethod = (proto, key, factory) => {
  if (!proto || typeof proto[key] !== 'function') return;
  const original = proto[key];
  Object.defineProperty(proto, key, { configurable: true, writable: true, value: factory(original) });
};
const nativeLike = (wrapper) => wrapper;
`;

const RUNNER = `(async () => {
  const out = {};
  const pc = new RTCPeerConnection({ iceServers: [] });
  out.offerSdp = (await pc.createOffer()).sdp;

  await pc.setLocalDescription();
  out.noArgSdp = pc.localDescription && pc.localDescription.sdp;
  out.noArgBrand = pc.localDescription instanceof RTCSessionDescription;
  out.identityStable = pc.localDescription === pc.localDescription;

  const handlerSeen = [];
  pc.onicecandidate = (event) => handlerSeen.push(event.candidate && event.candidate.candidate);
  out.handlerKept = typeof pc.onicecandidate;
  pc.emitCandidate(${JSON.stringify(HOST_V4.replace(/^a=/, ''))});

  const listenerSeen = [];
  const listener = (event) => listenerSeen.push(event.candidate && event.candidate.candidate);
  pc.addEventListener('icecandidate', listener);
  pc.emitCandidate(${JSON.stringify(HOST_V6)});
  pc.removeEventListener('icecandidate', listener);
  pc.emitCandidate(${JSON.stringify(HOST_MDNS)});

  out.handlerSeen = handlerSeen;
  out.listenerSeen = listenerSeen;

  const otherSeen = [];
  pc.addEventListener('not-icecandidate', () => otherSeen.push('x'));
  out.otherSeen = otherSeen;

  const pc2 = new RTCPeerConnection({ iceServers: [] });
  await pc2.setLocalDescription(await pc2.createOffer());
  out.argFormSdp = pc2.localDescription && pc2.localDescription.sdp;
  return JSON.stringify(out);
})()`;

function runBlock(fingerprint) {
  const script = buildInjectionScript(fingerprint);
  const start = script.indexOf('// --- webrtc ---');
  const end = script.indexOf('// --- mediaDevices ---');
  if (start < 0 || end <= start) throw new Error('webrtc block not found in the generated script');
  const block = script.slice(start, end);
  const context = vm.createContext({ console });
  vm.runInContext(STUBS, context);
  context.CFG = {
    webrtc: fingerprint.webrtc,
    webrtcAddress: fingerprint.webrtcAddress || null,
  };
  vm.runInContext(block, context);
  return context;
}

(async () => {
  const proxyFp = buildFingerprint({
    id: 'webrtc-selftest', kernelVersion: '148.0.7778.165', os: 'Windows',
    privacy: { webrtc: 'proxy', webrtcAddress: EXIT_IP },
  });
  if (proxyFp.webrtcAddress !== EXIT_IP) throw new Error(`fingerprint did not carry the proxy address: ${proxyFp.webrtcAddress}`);
  const context = runBlock(proxyFp);
  const result = JSON.parse(await vm.runInContext(RUNNER, context));

  const leaks = (sdp) => [PRIVATE_V4, 'fe80:', '.local'].filter((needle) => String(sdp || '').includes(needle));

  ok('createOffer SDP no longer carries a local address', leaks(result.offerSdp).length === 0 && result.offerSdp.includes(EXIT_IP));
  ok('the private base address is masked in raddr', /raddr 0\.0\.0\.0/.test(result.offerSdp) && !result.offerSdp.includes(`raddr ${PRIVATE_V4}`));
  ok('public candidates keep their own address', result.offerSdp.includes(PUBLIC_V4) && result.offerSdp.includes(PUBLIC_RELAY));
  ok('the no-argument setLocalDescription path is covered', leaks(result.noArgSdp).length === 0 && result.noArgSdp.includes(EXIT_IP));
  ok('a rewritten description still passes instanceof', result.noArgBrand === true);
  ok('reading a description twice returns the same object', result.identityStable === true);
  ok('the rewritten argument form is covered too', leaks(result.argFormSdp).length === 0 && result.argFormSdp.includes(EXIT_IP));
  ok('the onicecandidate handler sees a rewritten candidate (bare candidate: form)',
  leaks(result.handlerSeen[0]).length === 0 && result.handlerSeen[0].includes(EXIT_IP)
  && result.handlerSeen[0].startsWith('candidate:'), 'the event form must keep its own prefix');
  ok('the addEventListener path sees a rewritten candidate', leaks(result.listenerSeen[0]).length === 0 && result.listenerSeen[0].includes(EXIT_IP));
  ok('a removed icecandidate listener stops receiving events', result.listenerSeen.length === 1);
  ok('the handler assignment stays readable', result.handlerKept === 'function');
  ok('unrelated listen types are passed through untouched', result.otherSeen.length === 0);

  // disabled mode: the constructor itself must refuse, so no page can even build a connection.
  const disabledFp = buildFingerprint({
    id: 'webrtc-selftest-off', kernelVersion: '148.0.7778.165', os: 'Windows',
    privacy: { webrtc: 'disabled' },
  });
  const offContext = runBlock(disabledFp);
  const thrown = vm.runInContext(`(() => { try { new RTCPeerConnection({ iceServers: [] }); return 'constructed'; } catch (e) { return e.name; } })()`, offContext);
  ok('disabled mode refuses to construct a peer connection', thrown === 'NotAllowedError');

  // real mode: nothing is intercepted, the raw surface stays native.
  const realFp = buildFingerprint({
    id: 'webrtc-selftest-real', kernelVersion: '148.0.7778.165', os: 'Windows',
    privacy: { webrtc: 'real' },
  });
  const realContext = runBlock(realFp);
  const realResult = JSON.parse(await vm.runInContext(RUNNER, realContext));
  ok('real mode leaves the raw SDP alone', leaks(realResult.offerSdp).length === 3);

  console.log(`\nwebrtc-rewrite-selftest: ${passed} checks passed.`);
  process.exit(0);
})().catch((error) => {
  console.error('webrtc-rewrite-selftest FAILED:', (error && error.stack) || error);
  process.exit(1);
});
