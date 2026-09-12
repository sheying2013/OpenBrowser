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
  'c=IN IP4 ' + PRIVATE_V4,
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
].join(String.fromCharCode(13, 10)))};

class RTCSessionDescription {
  constructor(init) { this.type = init.type; this.sdp = init.sdp; }
  toJSON() { return { type: this.type, sdp: this.sdp }; }
}
// The stub models the engine's shape rather than a convenient one: a candidate keeps its fields in
// a slot behind prototype accessors and an event exposes its candidate the same way. A stub with own
// data properties would let a rewrite that shadows instance members pass unnoticed.
const candidateSlots = new WeakMap();
const iceEventSlots = new WeakMap();
class RTCIceCandidate {
  constructor(init) {
    const src = init || {};
    candidateSlots.set(this, {
      candidate: src.candidate === undefined ? '' : String(src.candidate),
      sdpMid: src.sdpMid === undefined ? null : src.sdpMid,
      sdpMLineIndex: src.sdpMLineIndex === undefined ? null : src.sdpMLineIndex,
      usernameFragment: src.usernameFragment === undefined ? null : src.usernameFragment,
    });
  }
  toJSON() {
    const slot = candidateSlots.get(this);
    return { candidate: slot.candidate, sdpMid: slot.sdpMid, sdpMLineIndex: slot.sdpMLineIndex, usernameFragment: slot.usernameFragment };
  }
}
Object.defineProperties(RTCIceCandidate.prototype, {
  candidate: { configurable: true, enumerable: true, get() { return candidateSlots.get(this).candidate; } },
  address: { configurable: true, enumerable: true, get() { return (candidateSlots.get(this).candidate.split(' ')[4] || ''); } },
  port: { configurable: true, enumerable: true, get() { return Number(candidateSlots.get(this).candidate.split(' ')[5]) || 0; } },
  protocol: { configurable: true, enumerable: true, get() { return candidateSlots.get(this).candidate.split(' ')[2] || ''; } },
  sdpMid: { configurable: true, enumerable: true, get() { return candidateSlots.get(this).sdpMid; } },
  sdpMLineIndex: { configurable: true, enumerable: true, get() { return candidateSlots.get(this).sdpMLineIndex; } },
  usernameFragment: { configurable: true, enumerable: true, get() { return candidateSlots.get(this).usernameFragment; } },
});
class RTCPeerConnectionIceEvent {
  constructor(type, init) {
    // A page-built event is untrusted; the engine flips this before dispatching its own.
    Object.defineProperty(this, 'isTrusted', { value: false, writable: true, enumerable: false, configurable: false });
    iceEventSlots.set(this, {
      type: type,
      candidate: (init && init.candidate) || null,
      url: (init && init.url) || '',
    });
  }
}
Object.defineProperties(RTCPeerConnectionIceEvent.prototype, {
  type: { configurable: true, enumerable: true, get() { return iceEventSlots.get(this).type; } },
  candidate: { configurable: true, enumerable: true, get() { return iceEventSlots.get(this).candidate; } },
  url: { configurable: true, enumerable: true, get() { return iceEventSlots.get(this).url; } },
});
globalThis.__iceEventProtoShape = Object.getOwnPropertyNames(RTCPeerConnectionIceEvent.prototype).sort();
globalThis.__iceEventCandidateGetter = Object.getOwnPropertyDescriptor(RTCPeerConnectionIceEvent.prototype, 'candidate').get;
function RTCPeerConnection() { this._local = null; this._remote = null; this._onice = null; this._listeners = new Map(); }
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
  configurable: true, enumerable: true, get() { return this._local; },
});
RTCPeerConnection.prototype.setRemoteDescription = async function setRemoteDescription(desc) {
  const src = desc || {};
  this._remote = new RTCSessionDescription({ type: src.type, sdp: src.sdp });
};
for (const key of ['remoteDescription', 'currentRemoteDescription', 'pendingRemoteDescription']) {
  Object.defineProperty(RTCPeerConnection.prototype, key, {
    configurable: true, enumerable: true, get() { return this._remote; },
  });
}
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
globalThis.__dispatchedIceEvents = [];
RTCPeerConnection.prototype.emitCandidate = function emitCandidate(line) {
  const candidate = new RTCIceCandidate({ candidate: line, sdpMid: '0', sdpMLineIndex: 0 });
  const event = new RTCPeerConnectionIceEvent('icecandidate', { candidate: candidate });
  event.isTrusted = true;
  globalThis.__dispatchedIceEvents.push(event);
  if (typeof this._onice === 'function') this._onice(event);
  for (const fn of (this._listeners.get('icecandidate') || []).slice()) fn(event);
};
const replaceMethod = (proto, key, factory) => {
  if (!proto || typeof proto[key] !== 'function') return;
  const original = proto[key];
  Object.defineProperty(proto, key, { configurable: true, writable: true, value: factory(original) });
};
const nativeLike = (wrapper, original, nameOverride, lengthOverride) => {
  if (typeof wrapper !== 'function') return wrapper;
  const name = nameOverride !== undefined ? nameOverride : (original ? original.name : wrapper.name);
  const length = lengthOverride !== undefined ? lengthOverride : (original ? original.length : wrapper.length);
  try { Object.defineProperty(wrapper, 'name', { configurable: true, value: name }); } catch (_) {}
  try { Object.defineProperty(wrapper, 'length', { configurable: true, value: length }); } catch (_) {}
  return wrapper;
};
const makeNativeGetter = (key, getValue) => {
  const holder = { get [key]() { return getValue.call(this); } };
  const getter = Object.getOwnPropertyDescriptor(holder, key).get;
  try { Object.defineProperty(getter, 'name', { configurable: true, value: 'get ' + key }); } catch (_) {}
  try { Object.defineProperty(getter, 'length', { configurable: true, value: 0 }); } catch (_) {}
  return getter;
};
// What the block may replace, it may not add to: a new own property on one of these prototypes is
// visible to any page that enumerates the interface, and no page would see it in a stock build.
globalThis.__protoShapes = {
  pc: Object.getOwnPropertyNames(RTCPeerConnection.prototype).sort(),
  candidate: Object.getOwnPropertyNames(RTCIceCandidate.prototype).sort(),
  iceEvent: Object.getOwnPropertyNames(RTCPeerConnectionIceEvent.prototype).sort(),
  sessionDescription: Object.getOwnPropertyNames(RTCSessionDescription.prototype).sort(),
};
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
  const handlerEvents = [];
  const handlerCandidateObjects = [];
  pc.onicecandidate = (event) => {
    handlerEvents.push(event);
    if (event.candidate) handlerCandidateObjects.push(event.candidate);
    handlerSeen.push(event.candidate && event.candidate.candidate);
  };
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

  // The event the listener received has to be the object the engine dispatched: a rebuilt event
  // would report isTrusted false, a null target and eventPhase 0.
  out.eventIdentityKept = handlerEvents[0] === globalThis.__dispatchedIceEvents[0];
  out.eventTrusted = handlerEvents[0] && handlerEvents[0].isTrusted;
  out.eventOwnProps = handlerEvents[0] ? Object.getOwnPropertyNames(handlerEvents[0]).sort() : null;
  out.eventProtoProps = handlerEvents[0] ? Object.getOwnPropertyNames(Object.getPrototypeOf(handlerEvents[0])).sort() : null;
  out.eventProtoUntouched = JSON.stringify(out.eventProtoProps) === JSON.stringify(globalThis.__iceEventProtoShape);
  const currentGetter = Object.getOwnPropertyDescriptor(RTCPeerConnectionIceEvent.prototype, 'candidate').get;
  out.eventCandidateGetterShape = currentGetter ? (currentGetter.name + '/' + currentGetter.length) : null;
  out.eventCandidateGetterSame = currentGetter === globalThis.__iceEventCandidateGetter;
  out.handlerSeesCandidateObject = handlerCandidateObjects.map((c) => c instanceof RTCIceCandidate);

  // Identity relationships the engine exposes must survive the description wrapper.
  out.localVsCurrent = pc.localDescription === pc.currentLocalDescription;
  out.localVsPending = pc.localDescription === pc.pendingLocalDescription;
  await pc.setRemoteDescription({ type: 'answer', sdp: 'v=0' });
  out.remoteDistinct = pc.remoteDescription !== pc.localDescription;
  out.remoteSelf = pc.remoteDescription === pc.remoteDescription;
  out.remoteVsCurrent = pc.remoteDescription === pc.currentRemoteDescription;

  // A page that builds its own candidate and event must get exactly what it handed in back.
  const ownCandidate = new RTCIceCandidate({ candidate: 'candidate:9 1 udp 1 192.168.1.5 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 });
  const ownEvent = new RTCPeerConnectionIceEvent('icecandidate', { candidate: ownCandidate });
  out.pageEventUntouched = ownEvent.candidate === ownCandidate;
  out.pageCandidateUntouched = ownCandidate.candidate.indexOf('192.168.1.5') >= 0;
  out.pageCandidateOwnProps = Object.getOwnPropertyNames(ownCandidate).length;

  // Nothing may be shadowed onto the prototypes the block rewrites.
  out.protoShapes = {
    pc: Object.getOwnPropertyNames(RTCPeerConnection.prototype).sort(),
    candidate: Object.getOwnPropertyNames(RTCIceCandidate.prototype).sort(),
    iceEvent: Object.getOwnPropertyNames(RTCPeerConnectionIceEvent.prototype).sort(),
    sessionDescription: Object.getOwnPropertyNames(RTCSessionDescription.prototype).sort(),
  };
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

// A block that never runs still has to be valid script: a syntax error would take the whole page
// layer down, and a branch that is skipped in this suite would hide it.
(function parses() {
  const fp = buildFingerprint({
    id: 'webrtc-selftest-parse', kernelVersion: '148.0.7778.165', os: 'Windows',
    privacy: { webrtc: 'proxy', webrtcAddress: EXIT_IP },
  });
  const source = buildInjectionScript(fp);
  try { new vm.Script(source); } catch (error) { throw new Error('generated page script does not parse: ' + error.message); }
})();

(async () => {
  const proxyFp = buildFingerprint({
    id: 'webrtc-selftest', kernelVersion: '148.0.7778.165', os: 'Windows',
    privacy: { webrtc: 'proxy', webrtcAddress: EXIT_IP },
  });
  if (proxyFp.webrtcAddress !== EXIT_IP) throw new Error(`fingerprint did not carry the proxy address: ${proxyFp.webrtcAddress}`);
  const context = runBlock(proxyFp);
  const result = JSON.parse(await vm.runInContext(RUNNER, context));

  const leaks = (sdp) => [PRIVATE_V4, 'fe80:', '.local'].filter((needle) => String(sdp || '').includes(needle));

  ok('the fixture models the engine CRLF line endings', result.offerSdp.indexOf(String.fromCharCode(13, 10)) > 0);
  ok('createOffer SDP no longer carries a local address', leaks(result.offerSdp).length === 0 && result.offerSdp.includes(EXIT_IP));
  ok('the private base address is masked in raddr', /raddr 0\.0\.0\.0/.test(result.offerSdp) && !result.offerSdp.includes(`raddr ${PRIVATE_V4}`));
  ok('the connection line carries the profile address instead of the host',
    result.offerSdp.includes('c=IN IP4 ' + EXIT_IP) && !result.offerSdp.includes('c=IN IP4 ' + PRIVATE_V4));
  ok('the connection line is rewritten in the no-argument and argument forms too',
    result.noArgSdp.includes('c=IN IP4 ' + EXIT_IP) && result.argFormSdp.includes('c=IN IP4 ' + EXIT_IP));
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
  ok('the handler receives the event object the engine dispatched', result.eventIdentityKept === true);
  ok('the delivered event is still trusted', result.eventTrusted === true);
  ok('the delivered event keeps the engine own-property shape', JSON.stringify(result.eventOwnProps) === JSON.stringify(['isTrusted']));
  ok('the delivered event keeps the engine prototype shape', result.eventProtoUntouched === true);
  ok('the candidate accessor keeps the native getter name and arity', result.eventCandidateGetterShape === 'get candidate/0');
  ok('candidates are real RTCIceCandidate instances', result.handlerSeesCandidateObject.every((flag) => flag === true));
  ok('localDescription and currentLocalDescription stay the same object', result.localVsCurrent === true);
  ok('localDescription and pendingLocalDescription stay the same object', result.localVsPending === true);
  ok('different stored descriptions do not collapse into one wrapper', result.remoteDistinct === true);
  ok('remote description identity stays stable across reads', result.remoteSelf === true && result.remoteVsCurrent === true);
  ok('a page-built event hands back the candidate it was given', result.pageEventUntouched === true);
  ok('a page-built candidate is never rewritten', result.pageCandidateUntouched === true);
  ok('a page-built candidate carries no own members', result.pageCandidateOwnProps === 0);
  ok('no prototype gains an own property the stock build does not have',
    ['pc', 'candidate', 'iceEvent', 'sessionDescription'].every((key) =>
      JSON.stringify(result.protoShapes[key]) === JSON.stringify(context.__protoShapes[key])));
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
