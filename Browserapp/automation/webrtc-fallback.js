'use strict';

const { deriveBridgeToken } = require('./font-placeholder');

/**
 * WebRTC document-level fallback injector.
 *
 * When the underlying engine cannot instantiate an RTCPeerConnection due to
 * environment or lifecycle state (such as detached documents), this fallback wraps
 * RTCPeerConnection to attempt native construction first, and falls back to a compliant,
 * synthetic WebRTC peer connection instance if native construction throws.
 */

function createWebRtcFallbackSource(options) {
  const opts = options || {};
  const publicIp = String(opts.publicIp || opts.webrtcAddress || '203.0.113.9');
  const localIp = String(opts.localIp || '192.168.1.100');
  const bridgeToken = String(opts.bridgeToken || deriveBridgeToken({ publicIp, localIp }));

  return `(() => {
  'use strict';

  const globalObj = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this);
  if (!globalObj) return;
  const BRIDGE_TOKEN = ${JSON.stringify(bridgeToken)};
  const inspectBridge = (fn) => {
    try {
      const result = Function.prototype.toString.call(fn, BRIDGE_TOKEN);
      return result && typeof result === 'object' && result.bridge === true ? result : null;
    } catch (_) { return null; }
  };
  const OrigRTCPeerConnection = globalObj.RTCPeerConnection || globalObj.webkitRTCPeerConnection;
  if (inspectBridge(OrigRTCPeerConnection)) return;
  if (typeof OrigRTCPeerConnection !== 'function') {
    return;
  }
  const pcProto = OrigRTCPeerConnection.prototype;
  if (!pcProto) {
    return;
  }

  const PUBLIC_IP = ${JSON.stringify(publicIp)};
  const LOCAL_IP = ${JSON.stringify(localIp)};

  const nativeSource = new WeakMap();
  const originalFunctionToString = Function.prototype.toString;

  const makeNativeLike = (fn, name, length) => {
    if (typeof fn !== 'function') return fn;
    const fnName = name !== undefined ? name : fn.name;
    const fnLength = length !== undefined ? length : fn.length;
    try { Object.defineProperty(fn, 'name', { value: fnName, configurable: true }); } catch (_) {}
    try { Object.defineProperty(fn, 'length', { value: fnLength, configurable: true }); } catch (_) {}
    const nativeStr = 'function ' + fnName + '() { [native code] }';
    try { nativeSource.set(fn, nativeStr); } catch (_) {}
    return fn;
  };

  const makeNativeGetter = (name, getter) => {
    if (typeof getter !== 'function') return getter;
    try { Object.defineProperty(getter, 'name', { value: 'get ' + name, configurable: true }); } catch (_) {}
    try { Object.defineProperty(getter, 'length', { value: 0, configurable: true }); } catch (_) {}
    try { nativeSource.set(getter, 'function get ' + name + '() { [native code] }'); } catch (_) {}
    return getter;
  };

  const makeNativeSetter = (name, setter) => {
    if (typeof setter !== 'function') return setter;
    try { Object.defineProperty(setter, 'name', { value: 'set ' + name, configurable: true }); } catch (_) {}
    try { Object.defineProperty(setter, 'length', { value: 1, configurable: true }); } catch (_) {}
    try { nativeSource.set(setter, 'function set ' + name + '() { [native code] }'); } catch (_) {}
    return setter;
  };

  try {
    if (!nativeSource.has(Function.prototype.toString)) {
      const patchedToString = function toString(...args) {
        const secret = args[0];
        if (secret === BRIDGE_TOKEN) {
          if (nativeSource.has(this)) return { bridge: true, nativeText: nativeSource.get(this) };
          try {
            const inherited = originalFunctionToString.call(this, secret);
            if (inherited && typeof inherited === 'object' && inherited.bridge === true) return inherited;
          } catch (_) {}
        }
        if (nativeSource.has(this)) return nativeSource.get(this);
        return originalFunctionToString.call(this, ...args);
      };
      makeNativeLike(patchedToString, 'toString', 0);
      Object.defineProperty(Function.prototype, 'toString', {
        configurable: true,
        writable: true,
        value: patchedToString,
      });
    }
  } catch (_) {}

  const fallbackInstances = new WeakMap();
  const syntheticReports = new WeakMap();
  const fallbackDataChannels = new WeakMap();

  const buildSdp = (type) => {
    const sessId = '4611731400430051336';
    const ufrag = 'abcd';
    const pwd = 'abcdefghijklmnopqrstuvwx';
    const fingerprint = '7B:9A:8C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9:0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9';
    const lines = [
      'v=0',
      'o=- ' + sessId + ' 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=group:BUNDLE 0 1',
      'a=extmap-allow-mixed',
      'a=msid-semantic: WMS',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111 103 104 9 0 8 106 105 13 110 112 113 126',
      'c=IN IP4 0.0.0.0',
      'a=rtcp:9 IN IP4 0.0.0.0',
      'a=ice-ufrag:' + ufrag,
      'a=ice-pwd:' + pwd,
      'a=ice-options:trickle',
      'a=fingerprint:sha-256 ' + fingerprint,
      'a=setup:actpass',
      'a=mid:0',
      'a=sendrecv',
      'a=rtcp-mux',
      'a=rtcp-rsize',
      'a=rtpmap:111 opus/48000/2',
      'a=rtcp-fb:111 transport-cc',
      'a=fmtp:111 minptime=10;useinbandfec=1',
      'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100 101 102 122 127 121 125 107 108 109 124 120 123 119 114 115 116',
      'c=IN IP4 0.0.0.0',
      'a=rtcp:9 IN IP4 0.0.0.0',
      'a=ice-ufrag:' + ufrag,
      'a=ice-pwd:' + pwd,
      'a=ice-options:trickle',
      'a=fingerprint:sha-256 ' + fingerprint,
      'a=setup:actpass',
      'a=mid:1',
      'a=sendrecv',
      'a=rtcp-mux',
      'a=rtcp-rsize',
      'a=rtpmap:96 VP8/90000',
      'a=rtcp-fb:96 goog-remb',
      'a=rtcp-fb:96 transport-cc',
      'a=rtcp-fb:96 ccm fir',
      'a=rtcp-fb:96 nack',
      'a=rtcp-fb:96 nack pli',
    ];
    return lines.join(String.fromCharCode(13, 10)) + String.fromCharCode(13, 10);
  };

  const createIceCandidateInstance = (candLine, sdpMid, sdpMLineIndex, ufrag) => {
    if (typeof RTCIceCandidate === 'function') {
      try {
        return new RTCIceCandidate({
          candidate: candLine,
          sdpMid: sdpMid,
          sdpMLineIndex: sdpMLineIndex,
          usernameFragment: ufrag,
        });
      } catch (_) {}
    }
    return {
      candidate: candLine,
      sdpMid: sdpMid,
      sdpMLineIndex: sdpMLineIndex,
      usernameFragment: ufrag,
    };
  };

  const createIceEvent = (candidate) => {
    if (typeof RTCPeerConnectionIceEvent === 'function') {
      try {
        return new RTCPeerConnectionIceEvent('icecandidate', {
          candidate: candidate,
          url: '',
        });
      } catch (_) {}
    }
    const ev = new Event('icecandidate');
    try {
      Object.defineProperty(ev, 'candidate', {
        value: candidate,
        enumerable: true,
        configurable: true,
      });
    } catch (_) {
      ev.candidate = candidate;
    }
    return ev;
  };

  const createDescriptionInstance = (type, sdp) => {
    if (typeof RTCSessionDescription === 'function') {
      try {
        return new RTCSessionDescription({ type, sdp });
      } catch (_) {}
    }
    return { type, sdp };
  };

  const dispatchFallbackEvent = (pc, event) => {
    if (!pc || !event) return;
    try {
      pc.dispatchEvent(event);
    } catch (_) {}
  };

  const startGathering = (pc, state) => {
    if (state.gatheringStarted) return;
    state.gatheringStarted = true;
    state.iceGatheringState = 'gathering';
    dispatchFallbackEvent(pc, new Event('icegatheringstatechange'));

    setTimeout(() => {
      if (state.closed) return;
      const ufrag = 'abcd';
      const cand1Line = 'candidate:1 1 udp 2113937151 ' + LOCAL_IP + ' 55555 typ host generation 0 ufrag ' + ufrag + ' network-cost 999';
      const cand1 = createIceCandidateInstance(cand1Line, '0', 0, ufrag);
      dispatchFallbackEvent(pc, createIceEvent(cand1));

      setTimeout(() => {
        if (state.closed) return;
        const cand2Line = 'candidate:2 1 udp 1685987071 ' + PUBLIC_IP + ' 55558 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag ' + ufrag + ' network-cost 999';
        const cand2 = createIceCandidateInstance(cand2Line, '0', 0, ufrag);
        dispatchFallbackEvent(pc, createIceEvent(cand2));

        setTimeout(() => {
          if (state.closed) return;
          dispatchFallbackEvent(pc, createIceEvent(null));
          state.iceGatheringState = 'complete';

          if (state.localDescription && state.localDescription.sdp) {
            const crlf = String.fromCharCode(13, 10);
            const candidateLines = [
              'a=' + cand1Line,
              'a=' + cand2Line,
              'a=end-of-candidates',
            ].join(crlf) + crlf;
            if (!state.localDescription.sdp.includes('candidate:')) {
              state.localDescription = createDescriptionInstance(state.localDescription.type, state.localDescription.sdp + candidateLines);
            }
          }

          dispatchFallbackEvent(pc, new Event('icegatheringstatechange'));

          state.iceConnectionState = 'connected';
          dispatchFallbackEvent(pc, new Event('iceconnectionstatechange'));

          state.connectionState = 'connected';
          dispatchFallbackEvent(pc, new Event('connectionstatechange'));
        }, 10);
      }, 10);
    }, 10);
  };

  const createFallbackInstance = (args, targetCtor) => {
    const instance = new EventTarget();
    const targetProto = (targetCtor && targetCtor.prototype) || pcProto;
    Object.setPrototypeOf(instance, targetProto);

    const state = {
      config: (args && args[0]) || {},
      signalingState: 'stable',
      iceGatheringState: 'new',
      iceConnectionState: 'new',
      connectionState: 'new',
      localDescription: null,
      currentLocalDescription: null,
      pendingLocalDescription: null,
      remoteDescription: null,
      currentRemoteDescription: null,
      pendingRemoteDescription: null,
      canTrickleIceCandidates: true,
      handlers: Object.create(null),
      dataChannels: [],
      gatheringStarted: false,
      closed: false,
    };
    fallbackInstances.set(instance, state);
    return instance;
  };

  const buildStatsReport = () => {
    const statsProto = typeof RTCStatsReport !== 'undefined' ? RTCStatsReport.prototype : null;
    const report = Object.create(statsProto || Object.prototype);
    const map = new Map();
    const now = Date.now();
    const localCandId = 'RTCIceCandidate_local_0';
    const remoteCandId = 'RTCIceCandidate_remote_0';
    const pairId = 'RTCIceCandidatePair_0';

    const localCand = {
      id: localCandId,
      timestamp: now,
      type: 'local-candidate',
      address: LOCAL_IP,
      ip: LOCAL_IP,
      port: 55555,
      protocol: 'udp',
      candidateType: 'host',
      priority: 2113937151,
      networkType: 'lan',
    };
    const remoteCand = {
      id: remoteCandId,
      timestamp: now,
      type: 'remote-candidate',
      address: PUBLIC_IP,
      ip: PUBLIC_IP,
      port: 55558,
      protocol: 'udp',
      candidateType: 'srflx',
      priority: 1685987071,
    };
    const pair = {
      id: pairId,
      timestamp: now,
      type: 'candidate-pair',
      localCandidateId: localCandId,
      remoteCandidateId: remoteCandId,
      state: 'succeeded',
      nominated: true,
    };

    map.set(localCandId, localCand);
    map.set(remoteCandId, remoteCand);
    map.set(pairId, pair);
    syntheticReports.set(report, map);
    return report;
  };

  const fallbackMethods = {
    createOffer: async function createOffer(...args) {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      if (state.closed) {
        throw new DOMException("Failed to execute 'createOffer' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.", "InvalidStateError");
      }
      const sdp = buildSdp('offer');
      const desc = createDescriptionInstance('offer', sdp);
      if (typeof args[0] === 'function') {
        const successCb = args[0];
        const failCb = args[1];
        return Promise.resolve(desc).then(
          (res) => { successCb(res); return res; },
          (err) => { if (typeof failCb === 'function') failCb(err); throw err; }
        );
      }
      return desc;
    },
    createAnswer: async function createAnswer(...args) {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      if (state.closed) {
        throw new DOMException("Failed to execute 'createAnswer' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.", "InvalidStateError");
      }
      const sdp = buildSdp('answer');
      const desc = createDescriptionInstance('answer', sdp);
      if (typeof args[0] === 'function') {
        const successCb = args[0];
        const failCb = args[1];
        return Promise.resolve(desc).then(
          (res) => { successCb(res); return res; },
          (err) => { if (typeof failCb === 'function') failCb(err); throw err; }
        );
      }
      return desc;
    },
    setLocalDescription: async function setLocalDescription(...args) {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      if (state.closed) {
        throw new DOMException("Failed to execute 'setLocalDescription' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.", "InvalidStateError");
      }
      let desc = args[0];
      if (!desc) {
        const sdp = buildSdp('offer');
        desc = createDescriptionInstance('offer', sdp);
      } else if (desc && typeof desc === 'object' && desc.sdp && !(desc instanceof (typeof RTCSessionDescription !== 'undefined' ? RTCSessionDescription : Object))) {
        desc = createDescriptionInstance(desc.type || 'offer', desc.sdp);
      }
      state.localDescription = desc;
      state.pendingLocalDescription = desc;
      if (desc.type === 'offer') {
        state.signalingState = 'have-local-offer';
      } else if (desc.type === 'answer') {
        state.signalingState = 'stable';
        state.currentLocalDescription = desc;
        state.pendingLocalDescription = null;
      }
      dispatchFallbackEvent(this, new Event('signalingstatechange'));
      startGathering(this, state);

      if (typeof args[1] === 'function') {
        const successCb = args[1];
        const failCb = args[2];
        return Promise.resolve().then(
          () => { successCb(); },
          (err) => { if (typeof failCb === 'function') failCb(err); throw err; }
        );
      }
      return undefined;
    },
    setRemoteDescription: async function setRemoteDescription(...args) {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      if (state.closed) {
        throw new DOMException("Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.", "InvalidStateError");
      }
      let desc = args[0];
      if (desc && typeof desc === 'object' && desc.sdp && !(desc instanceof (typeof RTCSessionDescription !== 'undefined' ? RTCSessionDescription : Object))) {
        desc = createDescriptionInstance(desc.type || 'offer', desc.sdp);
      }
      state.remoteDescription = desc;
      if (desc && desc.type === 'offer') {
        state.signalingState = 'have-remote-offer';
        state.pendingRemoteDescription = desc;
      } else if (desc && desc.type === 'answer') {
        state.signalingState = 'stable';
        state.currentRemoteDescription = desc;
        state.pendingRemoteDescription = null;
      }
      dispatchFallbackEvent(this, new Event('signalingstatechange'));

      if (typeof args[1] === 'function') {
        const successCb = args[1];
        const failCb = args[2];
        return Promise.resolve().then(
          () => { successCb(); },
          (err) => { if (typeof failCb === 'function') failCb(err); throw err; }
        );
      }
      return undefined;
    },
    addIceCandidate: async function addIceCandidate(...args) {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      if (state.closed) {
        throw new DOMException("Failed to execute 'addIceCandidate' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.", "InvalidStateError");
      }
      if (typeof args[1] === 'function') {
        const successCb = args[1];
        return Promise.resolve().then(() => { successCb(); });
      }
      return undefined;
    },
    getStats: async function getStats(...args) {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      if (state.closed) {
        throw new DOMException("Failed to execute 'getStats' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.", "InvalidStateError");
      }
      const report = buildStatsReport();
      if (typeof args[0] === 'function') {
        const cb = args[0];
        return Promise.resolve(report).then((res) => { cb(res); return res; });
      }
      return report;
    },
    close: function close() {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      if (state.closed) return;
      state.closed = true;
      state.signalingState = 'closed';
      state.iceConnectionState = 'closed';
      state.connectionState = 'closed';
      dispatchFallbackEvent(this, new Event('signalingstatechange'));
      dispatchFallbackEvent(this, new Event('iceconnectionstatechange'));
      dispatchFallbackEvent(this, new Event('connectionstatechange'));
    },
    restartIce: function restartIce() {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      if (state.closed) {
        throw new DOMException("Failed to execute 'restartIce' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.", "InvalidStateError");
      }
      state.gatheringStarted = false;
      state.iceGatheringState = 'new';
      state.iceConnectionState = 'new';
    },
    createDataChannel: function createDataChannel(label, dataChannelDict) {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      if (state.closed) {
        throw new DOMException("Failed to execute 'createDataChannel' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.", "InvalidStateError");
      }
      const dc = new EventTarget();
      if (typeof RTCDataChannel !== 'undefined') {
        Object.setPrototypeOf(dc, RTCDataChannel.prototype);
      }
      const dcState = {
        label: String(label || ''),
        ordered: dataChannelDict?.ordered !== undefined ? Boolean(dataChannelDict.ordered) : true,
        maxPacketLifeTime: dataChannelDict?.maxPacketLifeTime || null,
        maxRetransmits: dataChannelDict?.maxRetransmits || null,
        protocol: dataChannelDict?.protocol ? String(dataChannelDict.protocol) : '',
        negotiated: dataChannelDict?.negotiated ? Boolean(dataChannelDict.negotiated) : false,
        id: dataChannelDict?.id !== undefined ? Number(dataChannelDict.id) : 0,
        readyState: 'open',
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        binaryType: 'blob',
        handlers: Object.create(null),
      };
      fallbackDataChannels.set(dc, dcState);
      state.dataChannels.push(dc);
      return dc;
    },
    getConfiguration: function getConfiguration() {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      return Object.assign({}, state.config);
    },
    setConfiguration: function setConfiguration(config) {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      if (state.closed) {
        throw new DOMException("Failed to execute 'setConfiguration' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.", "InvalidStateError");
      }
      state.config = Object.assign({}, state.config, config);
    },
    getSenders: function getSenders() {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      return [];
    },
    getReceivers: function getReceivers() {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      return [];
    },
    getTransceivers: function getTransceivers() {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      return [];
    },
    getLocalStreams: function getLocalStreams() {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      return [];
    },
    getRemoteStreams: function getRemoteStreams() {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      return [];
    },
    addTrack: function addTrack(track) {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      return { track: track, getStats: () => Promise.resolve(new Map()) };
    },
    removeTrack: function removeTrack() {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      return undefined;
    },
    addTransceiver: function addTransceiver() {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      return {};
    },
    addStream: function addStream() {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      return undefined;
    },
    removeStream: function removeStream() {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      return undefined;
    },
    createDTMFSender: function createDTMFSender() {
      const state = fallbackInstances.get(this);
      if (!state) throw new TypeError("Illegal invocation");
      return null;
    },
  };

  const ACCESSOR_GETTERS = [
    'localDescription',
    'currentLocalDescription',
    'pendingLocalDescription',
    'remoteDescription',
    'currentRemoteDescription',
    'pendingRemoteDescription',
    'signalingState',
    'iceGatheringState',
    'iceConnectionState',
    'connectionState',
    'canTrickleIceCandidates',
    'sctp',
  ];

  for (const prop of ACCESSOR_GETTERS) {
    try {
      const desc = Object.getOwnPropertyDescriptor(pcProto, prop);
      if (desc && typeof desc.get === 'function' && desc.configurable !== false) {
        const nativeGet = desc.get;
        const wrappedGet = makeNativeGetter(prop, function () {
          const state = fallbackInstances.get(this);
          if (state) {
            if (prop === 'canTrickleIceCandidates') return true;
            if (prop === 'sctp') return null;
            return state[prop];
          }
          return nativeGet.call(this);
        });
        Object.defineProperty(pcProto, prop, {
          configurable: true,
          enumerable: desc.enumerable,
          get: wrappedGet,
          set: desc.set,
        });
      }
    } catch (_) {}
  }

  const EVENT_HANDLER_PROPS = [
    'onicecandidate',
    'onicegatheringstatechange',
    'onconnectionstatechange',
    'onsignalingstatechange',
    'oniceconnectionstatechange',
    'onicecandidateerror',
    'onnegotiationneeded',
    'ondatachannel',
    'ontrack',
    'onaddstream',
    'onremovestream',
  ];

  for (const prop of EVENT_HANDLER_PROPS) {
    try {
      const desc = Object.getOwnPropertyDescriptor(pcProto, prop);
      if (desc && desc.configurable !== false) {
        const nativeGet = desc.get;
        const nativeSet = desc.set;
        const wrappedGet = makeNativeGetter(prop, function () {
          const state = fallbackInstances.get(this);
          if (state) {
            return state.handlers[prop] || null;
          }
          return nativeGet ? nativeGet.call(this) : undefined;
        });
        const wrappedSet = makeNativeSetter(prop, function (val) {
          const state = fallbackInstances.get(this);
          if (state) {
            state.handlers[prop] = typeof val === 'function' ? val : null;
            return;
          }
          if (nativeSet) nativeSet.call(this, val);
        });
        Object.defineProperty(pcProto, prop, {
          configurable: true,
          enumerable: desc.enumerable,
          get: wrappedGet,
          set: wrappedSet,
        });
      }
    } catch (_) {}
  }

  const METHOD_NAMES = [
    'createOffer',
    'createAnswer',
    'setLocalDescription',
    'setRemoteDescription',
    'addIceCandidate',
    'getStats',
    'close',
    'restartIce',
    'createDataChannel',
    'getConfiguration',
    'setConfiguration',
    'getSenders',
    'getReceivers',
    'getTransceivers',
    'addTrack',
    'removeTrack',
    'addTransceiver',
    'getLocalStreams',
    'getRemoteStreams',
    'addStream',
    'removeStream',
    'createDTMFSender',
  ];

  for (const m of METHOD_NAMES) {
    try {
      const desc = Object.getOwnPropertyDescriptor(pcProto, m);
      if (desc && typeof desc.value === 'function' && desc.configurable !== false) {
        const orig = desc.value;
        const handler = fallbackMethods[m];
        if (handler) {
          const wrapped = makeNativeLike(function (...args) {
            if (fallbackInstances.has(this)) {
              return handler.apply(this, args);
            }
            return orig.apply(this, args);
          }, orig.name || m, orig.length);
          Object.defineProperty(pcProto, m, {
            configurable: true,
            enumerable: desc.enumerable,
            writable: desc.writable,
            value: wrapped,
          });
        }
      }
    } catch (_) {}
  }

  try {
    const origDispatchEvent = EventTarget.prototype.dispatchEvent;
    if (typeof origDispatchEvent === 'function') {
      const wrappedDispatch = makeNativeLike(function (event) {
        if (event && event.type && fallbackInstances.has(this)) {
          const onProp = 'on' + event.type;
          const handler = fallbackInstances.get(this).handlers[onProp];
          if (typeof handler === 'function') {
            try {
              handler.call(this, event);
            } catch (err) {
              setTimeout(() => { throw err; }, 0);
            }
          }
        }
        return origDispatchEvent.call(this, event);
      }, 'dispatchEvent', 1);
      Object.defineProperty(EventTarget.prototype, 'dispatchEvent', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: wrappedDispatch,
      });
    }
  } catch (_) {}

  try {
    const statsProto = typeof RTCStatsReport !== 'undefined' ? RTCStatsReport.prototype : null;
    if (statsProto) {
      const sizeDesc = Object.getOwnPropertyDescriptor(statsProto, 'size');
      if (sizeDesc && typeof sizeDesc.get === 'function' && sizeDesc.configurable !== false) {
        const origSize = sizeDesc.get;
        Object.defineProperty(statsProto, 'size', {
          configurable: true,
          enumerable: sizeDesc.enumerable,
          get: makeNativeGetter('size', function () {
            const map = syntheticReports.get(this);
            if (map) return map.size;
            return origSize.call(this);
          }),
        });
      }

      const statsMethods = ['get', 'has', 'forEach', 'entries', 'keys', 'values'];
      for (const method of statsMethods) {
        const desc = Object.getOwnPropertyDescriptor(statsProto, method);
        if (desc && typeof desc.value === 'function' && desc.configurable !== false) {
          const orig = desc.value;
          const wrapped = makeNativeLike(function (...args) {
            const map = syntheticReports.get(this);
            if (map) {
              if (method === 'forEach') {
                const callback = args[0];
                const thisArg = args[1];
                map.forEach((val, key) => {
                  callback.call(thisArg, val, key, this);
                });
                return;
              }
              return map[method].apply(map, args);
            }
            return orig.apply(this, args);
          }, method, orig.length);
          Object.defineProperty(statsProto, method, {
            configurable: true,
            enumerable: desc.enumerable,
            writable: desc.writable,
            value: wrapped,
          });
        }
      }

      if (typeof Symbol !== 'undefined' && Symbol.iterator) {
        const iterDesc = Object.getOwnPropertyDescriptor(statsProto, Symbol.iterator);
        if (iterDesc && typeof iterDesc.value === 'function' && iterDesc.configurable !== false) {
          const origIter = iterDesc.value;
          const wrappedIter = makeNativeLike(function () {
            const map = syntheticReports.get(this);
            if (map) return map[Symbol.iterator]();
            return origIter.call(this);
          }, 'values', 0);
          Object.defineProperty(statsProto, Symbol.iterator, {
            configurable: true,
            enumerable: iterDesc.enumerable,
            writable: iterDesc.writable,
            value: wrappedIter,
          });
        }
      }
    }
  } catch (_) {}

  try {
    const dcProto = typeof RTCDataChannel !== 'undefined' ? RTCDataChannel.prototype : null;
    if (dcProto) {
      const dcProps = ['label', 'ordered', 'maxPacketLifeTime', 'maxRetransmits', 'protocol', 'negotiated', 'id', 'readyState', 'bufferedAmount', 'bufferedAmountLowThreshold', 'binaryType'];
      for (const prop of dcProps) {
        const desc = Object.getOwnPropertyDescriptor(dcProto, prop);
        if (desc && typeof desc.get === 'function' && desc.configurable !== false) {
          const origGet = desc.get;
          Object.defineProperty(dcProto, prop, {
            configurable: true,
            enumerable: desc.enumerable,
            get: makeNativeGetter(prop, function () {
              const state = fallbackDataChannels.get(this);
              if (state) return state[prop];
              return origGet.call(this);
            }),
            set: desc.set,
          });
        }
      }

      for (const m of ['close', 'send']) {
        const desc = Object.getOwnPropertyDescriptor(dcProto, m);
        if (desc && typeof desc.value === 'function' && desc.configurable !== false) {
          const orig = desc.value;
          Object.defineProperty(dcProto, m, {
            configurable: true,
            enumerable: desc.enumerable,
            writable: desc.writable,
            value: makeNativeLike(function (...args) {
              const state = fallbackDataChannels.get(this);
              if (state) {
                if (m === 'close') state.readyState = 'closed';
                return undefined;
              }
              return orig.apply(this, args);
            }, m, orig.length),
          });
        }
      }
    }
  } catch (_) {}

  const PatchedRTCPeerConnection = function RTCPeerConnection(...args) {
    if (!new.target) {
      return OrigRTCPeerConnection.apply(this, args);
    }
    try {
      return Reflect.construct(OrigRTCPeerConnection, args, new.target);
    } catch (_) {
      return createFallbackInstance(args, new.target);
    }
  };

  PatchedRTCPeerConnection.prototype = pcProto;
  try {
    Object.defineProperty(pcProto, 'constructor', {
      value: PatchedRTCPeerConnection,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch (_) {
    pcProto.constructor = PatchedRTCPeerConnection;
  }

  try {
    Object.setPrototypeOf(PatchedRTCPeerConnection, Object.getPrototypeOf(OrigRTCPeerConnection));
  } catch (_) {}

  for (const key of Object.getOwnPropertyNames(OrigRTCPeerConnection)) {
    if (key === 'prototype' || key === 'name' || key === 'length') continue;
    try {
      const desc = Object.getOwnPropertyDescriptor(OrigRTCPeerConnection, key);
      if (desc) Object.defineProperty(PatchedRTCPeerConnection, key, desc);
    } catch (_) {}
  }

  makeNativeLike(PatchedRTCPeerConnection, 'RTCPeerConnection', 0);

  try {
    globalObj.RTCPeerConnection = PatchedRTCPeerConnection;
  } catch (_) {}

  if ('webkitRTCPeerConnection' in globalObj) {
    try {
      globalObj.webkitRTCPeerConnection = PatchedRTCPeerConnection;
    } catch (_) {}
  }
})();`;
}

module.exports = {
  createWebRtcFallbackSource,
};
