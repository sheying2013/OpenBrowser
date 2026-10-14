'use strict';
const assert = require('node:assert/strict');
const { BrowserEngine } = require('../engine');
const { sanitizeProfile } = require('../engine/profile-sanitizer');
const net = require('node:net');
const { parseProxy, startAuthenticatedProxy, lookupProxyCountry } = require('../proxy-forwarder');
const results = [];
async function check(name, action) { try { await action(); results.push({name,ok:true}); } catch(error) { results.push({name,ok:false,error:error.message}); } }
(async () => {
  await check('explicit proxy mode with empty endpoint is not normalized to direct', () => {
    const value = sanitizeProfile({id:'fail-closed',name:'Test',networkMode:'proxy',proxy:''});
    assert.equal(value.networkMode,'proxy');
  });
  for(const policy of ['direct','continue','block']) {
    await check('old ' + policy + ' policy cannot authorize a direct fallback', async () => {
      const engine = Object.create(BrowserEngine.prototype);
      engine.networkInfo = new Map(); engine.profiles = new Map(); engine.emit = () => {};
      engine.resolveStoredProxyProfile = value => value;
      engine.testProxy = async () => { throw Object.assign(new Error('ECONNREFUSED'),{code:'ECONNREFUSED'}); };
      const profile = {id:'fail-closed',name:'Test',networkMode:'proxy',proxy:'socks5://127.0.0.1:9',proxyMeta:{checkOnStart:true,requireReady:false,notReadyPolicy:policy,allowDirectFallback:true}};
      await assert.rejects(engine.prepareProfileProxyForStart(profile));
      assert.equal(profile.networkMode,'proxy');
    });
  }
  await check('missing proxy fails before any direct probe', async () => {
    const engine = Object.create(BrowserEngine.prototype);
    engine.networkInfo = new Map(); engine.emit = () => {}; engine.resolveStoredProxyProfile = value => value;
    engine.testProxy = async () => { throw new Error('unexpected probe'); };
    await assert.rejects(engine.prepareProfileProxyForStart({id:'fail-closed',name:'Test',networkMode:'proxy',proxy:''}));
  });
  await check('probe service timeout cannot use old geography as proof of a live route', async () => {
    const engine = Object.create(BrowserEngine.prototype);
    engine.networkInfo = new Map(); engine.emit = () => {}; engine.resolveStoredProxyProfile = value => value;
    engine.testProxy = async () => { throw Object.assign(new Error('fixture probe timeout'),{code:'probe-unavailable',probeUnavailable:true}); };
    await assert.rejects(engine.prepareProfileProxyForStart({id:'fail-closed',name:'Test',networkMode:'proxy',proxy:'http://127.0.0.1:9',exitIp:'192.0.2.99',exitCountryCode:'US'}));
  });
  await check('explicit direct mode remains an intentional choice', async () => {
    const engine = Object.create(BrowserEngine.prototype);
    engine.resolveStoredProxyProfile = value => value;
    const result = await engine.prepareProfileProxyForStart({id:'direct-choice',name:'Test',networkMode:'direct',proxy:'Direct'});
    assert.equal(result.networkMode,'direct');
  });
  await check('backend merges identical in-flight checks and cleans completed entries', async () => {
    const engine = Object.create(BrowserEngine.prototype);
    let finish, calls=0;
    engine._testProxy = () => {calls++;return new Promise(resolve=>{finish=resolve;});};
    const profile={id:'dedupe',name:'Test',networkMode:'proxy',proxy:'http://127.0.0.1:9'};
    const first=engine.testProxy(profile), second=engine.testProxy(profile);
    assert.equal(calls,1); finish({ip:'192.0.2.1'});
    const values=await Promise.all([first,second]); assert.deepEqual(values[0],values[1]); assert.equal(engine._proxyTests.size,0);
  });
  await check('runtime upstream failure never reaches a direct target', async () => {
    let directHits = 0;
    const trap = net.createServer(socket => {directHits++;socket.destroy();});
    const upstream = net.createServer(socket => socket.destroy());
    await new Promise(resolve=>trap.listen(0,'127.0.0.1',resolve));
    await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
    const config = parseProxy('http://127.0.0.1:'+upstream.address().port);
    const bridge = await startAuthenticatedProxy(config);
    try {
      const socket = net.connect(bridge.port,'127.0.0.1');
      const response = await new Promise((resolve,reject)=>{
        let text=''; const timer=setTimeout(()=>{socket.destroy();reject(new Error('fixture deadline'));},1000);
        socket.on('connect',()=>socket.write('CONNECT 127.0.0.1:'+trap.address().port+' HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'));
        socket.on('data',chunk=>{text+=chunk.toString();if(text.includes('\r\n\r\n')){clearTimeout(timer);socket.destroy();resolve(text);}});
        socket.on('error',error=>{clearTimeout(timer);reject(error);});
      });
      assert.match(response,/502/); assert.equal(directHits,0);
      await assert.rejects(lookupProxyCountry(config,{force:true,totalTimeoutMs:150,attemptTimeoutMs:60,exitIp:'192.0.2.99',exitCountryCode:'US'}));
      assert.equal(directHits,0);
    } finally {await bridge.close();await new Promise(resolve=>upstream.close(resolve));await new Promise(resolve=>trap.close(resolve));}
  });
  for(const r of results) console.log((r.ok?'PASS ':'FAIL ')+r.name+(r.error?': '+r.error:''));
  if(results.some(r=>!r.ok)) process.exitCode=1;
})();
