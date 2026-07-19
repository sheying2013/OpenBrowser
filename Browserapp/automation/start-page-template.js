'use strict';

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(ts) {
  const number = Number(ts);
  const date = Number.isFinite(number) && number > 1e9
    ? new Date(number > 1e12 ? number : number * 1000)
    : new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildStartPageHtml(data = {}) {
  const id = data.serial || data.id || data.number || '';
  const name = data.name || '';
  const pid = data.pid || data.profileId || '';
  const network = data.network || {};
  const title = [id, name].filter(Boolean).join(' ') || 'OpenBrowser 环境检测';
  const boot = {
    pid: String(pid || ''),
    title,
    network,
    networkMode: data.networkMode || (network.protocol === 'direct' ? 'direct' : 'proxy'),
    proxyProtocol: data.proxyProtocol || network.protocol || '',
    expected: data.expectedFingerprint || {},
  };
  const detailRows = [
    ['序号', id],
    ['窗口名称', name],
    ['用户名', data.username || data.account],
    ['分组', data.group_name || data.group],
    ['标签', data.tag_name || data.tag],
    ['备注', data.note],
    ['启动时间', data.startedAtLabel || formatTime(data.time)],
  ];

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="openbrowser-start-page" content="1">
  <meta name="openbrowser-native" content="1">
  <title>${esc(title)}</title>
  <style>
    :root{color-scheme:light;--ink:#17212b;--muted:#66727d;--line:#dbe2e8;--paper:#fff;--wash:#f2f5f7;--navy:#162833;--navy2:#203a45;--green:#087b59;--amber:#a86100;--red:#b42318;--blue:#1769aa}
    *{box-sizing:border-box}html{background:var(--wash)}body{margin:0;color:var(--ink);font-family:Inter,"SF Pro Text","PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:13px;letter-spacing:0}
    button{font:inherit}.shell{width:min(1120px,calc(100% - 32px));margin:24px auto 48px;background:var(--paper);border:1px solid var(--line);box-shadow:0 16px 45px rgba(25,42,52,.1)}
    .hero{background:var(--navy);color:#fff;padding:26px 30px 0}.hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}.brand{font-size:12px;font-weight:700;color:#a8bac3;text-transform:uppercase}.ip{font-size:42px;line-height:1.15;font-weight:680;margin:9px 0 8px;overflow-wrap:anywhere}.ip.small{font-size:25px}.subline{display:flex;flex-wrap:wrap;gap:8px 18px;color:#c0cdd3;min-height:20px}.error{display:none;color:#ffc0ba;margin-top:8px;line-height:1.5}.error.show{display:block}
    .score{text-align:right;min-width:148px}.score-label{color:#9eb1ba;font-size:11px}.score-value{font-size:25px;font-weight:700;margin:6px 0}.score-note{font-size:11px;color:#c0cdd3}.score.good .score-value{color:#58d5a7}.score.warn .score-value{color:#ffc267}.score.bad .score-value{color:#ff8f84}
    .hero-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}.button{border:1px solid #58707b;background:#29434f;color:#fff;border-radius:4px;padding:7px 11px;cursor:pointer}.button:hover{background:#345461}.button:disabled{opacity:.55;cursor:wait}
    .metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin:24px -30px 0;border-top:1px solid #38505b;background:#38505b;gap:1px}.metric{background:var(--navy2);padding:14px 18px;min-width:0}.metric span{display:block;color:#93a8b1;font-size:10px;margin-bottom:6px}.metric b{display:block;font-size:13px;overflow-wrap:anywhere}
    .band{padding:22px 30px;border-bottom:1px solid var(--line)}.section-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}.section-head h2{font-size:15px;margin:0}.section-note{font-size:11px;color:var(--muted)}
    .summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--line)}.summary-item{padding:14px 16px;border-right:1px solid var(--line);min-width:0}.summary-item:last-child{border-right:0}.summary-item span{display:block;color:var(--muted);font-size:10px;margin-bottom:6px}.summary-item b{font-size:13px;overflow-wrap:anywhere}
    .check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.check{border:1px solid var(--line);border-left:4px solid #98a5ae;padding:13px 14px;min-width:0}.check.good{border-left-color:var(--green)}.check.warn{border-left-color:var(--amber)}.check.bad{border-left-color:var(--red)}.check.na{border-left-color:#8a949c}.check-title{display:flex;align-items:center;justify-content:space-between;gap:12px;font-weight:650}.status{font-size:10px;padding:3px 6px;border-radius:3px;background:#edf1f3;color:#5e6870;white-space:nowrap}.good .status{background:#e2f4ed;color:#076d4f}.warn .status{background:#fff0d8;color:#905400}.bad .status{background:#fde8e6;color:#a41f16}.check p{margin:7px 0 0;color:var(--muted);font-size:11px;line-height:1.5;overflow-wrap:anywhere}
    .table{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-top:1px solid var(--line);border-left:1px solid var(--line)}.cell{display:grid;grid-template-columns:130px minmax(0,1fr);gap:12px;padding:11px 13px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);min-width:0}.cell.wide{grid-column:1/-1}.key{color:var(--muted);font-size:11px}.value{font-weight:520;overflow-wrap:anywhere;min-height:16px}.muted{color:#929ca4;font-weight:400}.footer{padding:16px 30px;color:#7b8790;font-size:10px;line-height:1.6;background:#f8fafb}
    .toast{position:fixed;right:16px;top:16px;background:#15262f;color:#fff;padding:9px 12px;border-radius:4px;opacity:0;transform:translateY(-5px);transition:.18s;pointer-events:none}.toast.show{opacity:1;transform:none}
    @media(max-width:780px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.metrics .metric:last-child{grid-column:1/-1}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.summary-item{border-bottom:1px solid var(--line)}.check-grid,.table{grid-template-columns:1fr}.cell.wide{grid-column:auto}}
    @media(max-width:520px){html{background:#fff}.shell{width:100%;margin:0;border:0;box-shadow:none}.hero{padding:22px 18px 0}.hero-top{display:block}.score{text-align:left;margin-top:18px}.hero-actions{justify-content:flex-start}.ip{font-size:32px}.metrics{margin:20px -18px 0}.metric{padding:12px}.band{padding:19px 18px}.summary{grid-template-columns:1fr}.summary-item{border-right:0}.cell{grid-template-columns:105px minmax(0,1fr)}.footer{padding:15px 18px}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="hero">
      <div class="hero-top">
        <div>
          <div class="brand">OpenBrowser Network &amp; Fingerprint Check</div>
          <div class="ip${network.ip && String(network.ip).length > 22 ? ' small' : ''}" id="ip-ip">${esc(network.ip || '检测中...')}</div>
          <div class="subline"><span id="network-mode">${esc(data.networkMode === 'direct' ? '直连模式' : (data.proxyProtocol || network.protocol || '代理模式').toUpperCase())}</span><span id="asn-line">${esc([network.asn, network.asName || network.isp].filter(Boolean).join(' · ') || '网络身份读取中')}</span></div>
          <div class="error" id="ip-error"></div>
        </div>
        <div class="score" id="score-box"><div class="score-label">本地一致性评估</div><div class="score-value" id="score-value">检测中</div><div class="score-note" id="score-note">仅基于当前可见信号</div></div>
      </div>
      <div class="hero-actions"><button class="button" id="btn-refresh" type="button">重新检测</button></div>
      <div class="metrics">
        <div class="metric"><span>国家 / 地区</span><b id="country">${esc(network.country || network.countryCode || '-')}</b></div>
        <div class="metric"><span>省 / 州</span><b id="region">${esc(network.region || '-')}</b></div>
        <div class="metric"><span>城市</span><b id="city">${esc(network.city || '-')}</b></div>
        <div class="metric"><span>出口时区</span><b id="timezone">${esc(network.timezone || data.timezone || '-')}</b></div>
        <div class="metric"><span>网络类型</span><b id="network-type">检测中</b></div>
      </div>
    </header>

    <section class="band">
      <div class="section-head"><h2>IP 网络身份</h2><span class="section-note" id="checked-at">等待出口数据</span></div>
      <div class="summary">
        <div class="summary-item"><span>ASN</span><b id="net-asn">${esc(network.asn || '-')}</b></div>
        <div class="summary-item"><span>ISP</span><b id="net-isp">${esc(network.isp || '-')}</b></div>
        <div class="summary-item"><span>组织</span><b id="net-org">${esc(network.organization || '-')}</b></div>
        <div class="summary-item"><span>坐标 / 邮编</span><b id="net-location">${esc([network.latitude, network.longitude].filter((v) => v != null).join(', ') || network.zip || '-')}</b></div>
      </div>
    </section>

    <section class="band">
      <div class="section-head"><h2>泄露与一致性</h2><span class="section-note">浏览器观测与出口信息交叉检查</span></div>
      <div class="check-grid">
        <article class="check na" id="check-webrtc"><div class="check-title">WebRTC 地址暴露 <span class="status">检测中</span></div><p>正在收集 ICE candidate。</p></article>
        <article class="check na" id="check-timezone"><div class="check-title">时区一致性 <span class="status">检测中</span></div><p>正在比较浏览器时区与出口时区。</p></article>
        <article class="check na" id="check-language"><div class="check-title">语言与地区 <span class="status">检测中</span></div><p>正在比较首选语言与出口地区。</p></article>
        <article class="check na" id="check-automation"><div class="check-title">自动化标记 <span class="status">检测中</span></div><p>正在检查 webdriver 等可见标记。</p></article>
        <article class="check na" id="check-storage"><div class="check-title">本地存储能力 <span class="status">检测中</span></div><p>正在检查 Cookie、LocalStorage 与 IndexedDB。</p></article>
        <article class="check na" id="check-dns"><div class="check-title">DNS 泄露 <span class="status">未配置</span></div><p>未配置 OpenBrowser 专用唯一 DNS 检测节点，当前不做安全结论。</p></article>
      </div>
    </section>

    <section class="band">
      <div class="section-head"><h2>访问能力</h2><span class="section-note">参考 IP.Check.Place 的常见出口可达性项，结果仅代表当前页面连通性</span></div>
      <div class="check-grid" id="reachability-grid">
        <article class="check na" id="reach-google"><div class="check-title">Google <span class="status">等待</span></div><p>等待检测。</p></article>
        <article class="check na" id="reach-youtube"><div class="check-title">YouTube <span class="status">等待</span></div><p>等待检测。</p></article>
        <article class="check na" id="reach-tiktok"><div class="check-title">TikTok <span class="status">等待</span></div><p>等待检测。</p></article>
        <article class="check na" id="reach-x"><div class="check-title">X / Twitter <span class="status">等待</span></div><p>等待检测。</p></article>
        <article class="check na" id="reach-chatgpt"><div class="check-title">ChatGPT <span class="status">等待</span></div><p>等待检测。</p></article>
        <article class="check na" id="reach-wikipedia"><div class="check-title">Wikipedia <span class="status">等待</span></div><p>等待检测。</p></article>
      </div>
    </section>

    <section class="band">
      <div class="section-head"><h2>浏览器指纹表面</h2><span class="section-note">数据只在当前本地页面计算</span></div>
      <div class="table" id="fingerprint-table">
        <div class="cell wide"><span class="key">User Agent</span><span class="value" id="fp-ua">读取中...</span></div>
        <div class="cell"><span class="key">平台</span><span class="value" id="fp-platform">读取中...</span></div>
        <div class="cell"><span class="key">语言</span><span class="value" id="fp-language">读取中...</span></div>
        <div class="cell"><span class="key">浏览器时区</span><span class="value" id="fp-timezone">读取中...</span></div>
        <div class="cell"><span class="key">屏幕 / 视口</span><span class="value" id="fp-screen">读取中...</span></div>
        <div class="cell"><span class="key">CPU / 内存</span><span class="value" id="fp-hardware">读取中...</span></div>
        <div class="cell"><span class="key">WebGL Vendor</span><span class="value" id="fp-webgl-vendor">读取中...</span></div>
        <div class="cell"><span class="key">WebGL Renderer</span><span class="value" id="fp-webgl-renderer">读取中...</span></div>
        <div class="cell"><span class="key">Canvas 指纹</span><span class="value" id="fp-canvas">读取中...</span></div>
        <div class="cell"><span class="key">AudioContext</span><span class="value" id="fp-audio">读取中...</span></div>
        <div class="cell"><span class="key">触控 / 插件</span><span class="value" id="fp-capabilities">读取中...</span></div>
        <div class="cell"><span class="key">DNT / Cookies</span><span class="value" id="fp-privacy">读取中...</span></div>
        <div class="cell wide"><span class="key">UA Client Hints</span><span class="value" id="fp-hints">读取中...</span></div>
      </div>
    </section>

    <section class="band">
      <div class="section-head"><h2>环境信息</h2><span class="section-note">当前窗口</span></div>
      <div class="table">${detailRows.map(([key, value]) => `<div class="cell"><span class="key">${esc(key)}</span><span class="value">${value ? esc(value) : '<span class="muted">-</span>'}</span></div>`).join('')}</div>
    </section>
    <footer class="footer">本页的风险结果是本地一致性评估，不是 IPinfo、Scamalytics 或其它商业数据库的风险分。代理、托管和移动网络标签来自出口查询服务；Canvas、WebGL 暴露代表可被读取的指纹表面，不等同于身份泄露。</footer>
  </main>
  <div class="toast" id="toast"></div>
  <script>
  window.__OPENBROWSER_START__=${JSON.stringify(boot)};
  (function(){
    'use strict';
    var BOOT=window.__OPENBROWSER_START__||{};
    var query=new URLSearchParams(location.search);
    var pid=BOOT.pid||query.get('pid')||query.get('id')||'';
    var sessionToken=query.get('token')||'';
    if(sessionToken&&history.replaceState){query.delete('token');var cleanQuery=query.toString();history.replaceState(null,'',location.pathname+(cleanQuery?'?'+cleanQuery:'')+location.hash)}
    var currentNetwork=BOOT.network||{};
    var fingerprint={};
    var findings=[];

    function byId(id){return document.getElementById(id)}
    function text(id,value){var el=byId(id);if(el)el.textContent=value==null||value===''?'-':String(value)}
    function toast(message){var el=byId('toast');if(!el)return;el.textContent=message;el.classList.add('show');setTimeout(function(){el.classList.remove('show')},1800)}
    function setCheck(id,state,label,detail){var el=byId(id);if(!el)return;el.className='check '+state;var status=el.querySelector('.status');var p=el.querySelector('p');if(status)status.textContent=label;if(p)p.textContent=detail}
    function addFinding(id,state,weight){findings=findings.filter(function(item){return item.id!==id});findings.push({id:id,state:state,weight:weight||0});renderScore()}
    function renderScore(){var warnings=findings.reduce(function(sum,item){return sum+(item.state==='bad'?item.weight*2:item.state==='warn'?item.weight:0)},0);var box=byId('score-box');var value=byId('score-value');var note=byId('score-note');if(!box||!value)return;box.className='score '+(warnings>=6?'bad':warnings>=2?'warn':'good');value.textContent=warnings>=6?'风险':warnings>=2?'注意':'一致';note.textContent=warnings>=6?'发现明显泄露或冲突':warnings>=2?'存在需要核对的信号':'未发现明显身份泄露'}
    function api(path){var target=new URL(path,location.origin);if(pid&&!target.searchParams.has('pid'))target.searchParams.set('pid',pid);return fetch(target.pathname+target.search,{cache:'no-store',headers:{'X-OpenBrowser-Start-Token':sessionToken}}).then(function(response){return response.json().catch(function(){return {}}).then(function(body){if(!response.ok||!body.ok)throw new Error(body.msg||('HTTP '+response.status));return body})})}
    function networkType(net){var values=[];if(net.hosting)values.push('托管/机房');if(net.mobile)values.push('移动网络');if(net.proxy)values.push('代理标记');return values.length?values.join(' · '):'常规网络'}
    function isDirectMode(net){return BOOT.networkMode==='direct'||String((net&&net.protocol)||'').toLowerCase()==='direct'||String(BOOT.proxyProtocol||'').toLowerCase()==='direct'}
    function applyNetwork(net){if(!net)return;currentNetwork=net;var ip=net.ip||net.query||'';var directMode=isDirectMode(net);text('ip-ip',ip||(directMode?'本地直连':'未检测'));var ipEl=byId('ip-ip');if(ipEl)ipEl.classList.toggle('small',String(ip||'本地直连').length>22);text('country',net.country||net.countryCode);text('region',net.region||net.regionName);text('city',net.city);text('timezone',net.timezone);text('network-type',networkType(net));text('net-asn',net.asn);text('net-isp',net.isp);text('net-org',net.organization||net.org);text('net-location',[net.latitude,net.longitude].filter(function(v){return v!=null}).join(', ')||net.zip);text('asn-line',[net.asn,net.asName||net.isp].filter(Boolean).join(' · ')||(directMode?'直连出口':'网络身份读取中'));text('checked-at',net.checkedAt?'检测时间 '+new Date(net.checkedAt).toLocaleString():(ip?'出口数据已更新':(directMode?'直连可用，出口详情稍后补充':'-')));text('network-mode',directMode?'直连模式':String(BOOT.proxyProtocol||net.protocol||'代理').toUpperCase()+' 代理');var error=byId('ip-error');if(error){error.textContent='';error.classList.remove('show')}if(ip)addFinding('network','good',0);else if(directMode)addFinding('network','good',0);evaluateConsistency();try{document.title=(ip?ip+' · ':'')+BOOT.title}catch(_){}}
    function showNetworkError(error){var message=String(error&&error.message||error||'未知错误');var directMode=isDirectMode(currentNetwork);if(directMode){applyNetwork(Object.assign({},currentNetwork,{protocol:'direct',soft:true}));return}text('ip-ip','检测失败');var el=byId('ip-ip');if(el)el.classList.add('small');var detail=byId('ip-error');if(detail){detail.textContent=message;detail.classList.add('show')}addFinding('network','bad',4);toast('出口检测失败：'+message)}
    function refreshNetwork(options){options=options||{};if(!pid){if(!options.silent)toast('无环境 ID');return Promise.resolve()}var button=byId('btn-refresh');if(button)button.disabled=true;return api('/api/network?pid='+encodeURIComponent(pid)+'&refresh=1').then(function(result){applyNetwork(result.data);if(!options.silent&&result.data&&result.data.ip)toast('检测已更新')}).catch(function(error){if(options.silent&&isDirectMode(currentNetwork)){applyNetwork(Object.assign({},currentNetwork,{protocol:'direct',soft:true}));return}showNetworkError(error)}).finally(function(){if(button)button.disabled=false})}

    function shortHash(input){var hash=2166136261;for(var i=0;i<input.length;i+=1){hash^=input.charCodeAt(i);hash=Math.imul(hash,16777619)}return ('00000000'+(hash>>>0).toString(16)).slice(-8)}
    function collectCanvas(){try{var canvas=document.createElement('canvas');canvas.width=280;canvas.height=60;var ctx=canvas.getContext('2d');if(!ctx)return '不可用';ctx.fillStyle='#f2f5f7';ctx.fillRect(0,0,280,60);ctx.font='16px Arial';ctx.fillStyle='#1769aa';ctx.fillText('OpenBrowser fingerprint 012345',8,25);ctx.fillStyle='rgba(180,50,45,.7)';ctx.fillText('Canvas surface',33,47);return shortHash(canvas.toDataURL())}catch(error){return '已阻止 ('+error.name+')'}}
    function collectWebgl(){try{var canvas=document.createElement('canvas');var gl=canvas.getContext('webgl')||canvas.getContext('experimental-webgl');if(!gl)return {vendor:'不可用',renderer:'不可用'};var ext=gl.getExtension('WEBGL_debug_renderer_info');return {vendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)}}catch(error){return {vendor:'已阻止',renderer:error.name}}}
    function collectAudio(){try{var Context=window.OfflineAudioContext||window.webkitOfflineAudioContext;if(!Context)return Promise.resolve('不可用');var context=new Context(1,2048,44100);var oscillator=context.createOscillator();var compressor=context.createDynamicsCompressor();oscillator.type='triangle';oscillator.frequency.value=10000;oscillator.connect(compressor);compressor.connect(context.destination);oscillator.start(0);return context.startRendering().then(function(buffer){var data=buffer.getChannelData(0);var sum=0;for(var i=0;i<data.length;i+=16)sum+=Math.abs(data[i]);return shortHash(sum.toFixed(12))}).catch(function(error){return '已阻止 ('+error.name+')'})}catch(error){return Promise.resolve('已阻止 ('+error.name+')')}}
    function storageTest(){var local=false;try{localStorage.setItem('__ob_test','1');local=localStorage.getItem('__ob_test')==='1';localStorage.removeItem('__ob_test')}catch(_){}return {cookie:navigator.cookieEnabled,local:local,indexed:typeof indexedDB!=='undefined'}}
    function collectClientHints(){var data=navigator.userAgentData;if(!data)return Promise.resolve('不可用');var base=(data.brands||[]).map(function(item){return item.brand+' '+item.version}).join(', ')+' · '+data.platform+(data.mobile?' · Mobile':'');if(!data.getHighEntropyValues)return Promise.resolve(base);return data.getHighEntropyValues(['architecture','bitness','model','platformVersion','uaFullVersion']).then(function(value){return base+' · '+[value.architecture,value.bitness,value.model,value.platformVersion,value.uaFullVersion].filter(Boolean).join(' / ')}).catch(function(){return base})}
    function updateAutomationCheck(){var exposed=navigator.webdriver===true;if(fingerprint)fingerprint.webdriver=exposed;setCheck('check-automation',exposed?'bad':'good',exposed?'已暴露':'未发现',exposed?'navigator.webdriver = true，可被站点识别为自动化环境。':'未发现 navigator.webdriver 自动化标记。');addFinding('automation',exposed?'bad':'good',3);renderScore()}
    function collectFingerprint(){var timezone='';try{timezone=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(_){}var gl=collectWebgl();var storage=storageTest();fingerprint={userAgent:navigator.userAgent||'',platform:navigator.platform||'',languages:Array.from(navigator.languages||[navigator.language]).filter(Boolean),timezone:timezone,screen:screen.width+' × '+screen.height+' @ '+(window.devicePixelRatio||1)+'x; viewport '+innerWidth+' × '+innerHeight,hardware:(navigator.hardwareConcurrency||'?')+' cores / '+(navigator.deviceMemory||'?')+' GB',webglVendor:gl.vendor,webglRenderer:gl.renderer,canvas:collectCanvas(),webdriver:navigator.webdriver===true,storage:storage};text('fp-ua',fingerprint.userAgent);text('fp-platform',fingerprint.platform);text('fp-language',fingerprint.languages.join(', '));text('fp-timezone',timezone);text('fp-screen',fingerprint.screen);text('fp-hardware',fingerprint.hardware);text('fp-webgl-vendor',gl.vendor);text('fp-webgl-renderer',gl.renderer);text('fp-canvas',fingerprint.canvas);text('fp-capabilities',(navigator.maxTouchPoints||0)+' touch points / '+((navigator.plugins&&navigator.plugins.length)||0)+' plugins');text('fp-privacy',(navigator.doNotTrack||'默认')+' / Cookies '+(storage.cookie?'可用':'禁用'));setCheck('check-storage',storage.cookie&&storage.local&&storage.indexed?'good':'warn',storage.cookie&&storage.local&&storage.indexed?'正常':'受限','Cookie '+(storage.cookie?'可用':'禁用')+'，LocalStorage '+(storage.local?'可用':'禁用')+'，IndexedDB '+(storage.indexed?'可用':'禁用'));addFinding('storage',storage.cookie&&storage.local&&storage.indexed?'good':'warn',1);updateAutomationCheck();collectAudio().then(function(value){text('fp-audio',value)});collectClientHints().then(function(value){text('fp-hints',value)});evaluateConsistency();setTimeout(updateAutomationCheck,400);setTimeout(updateAutomationCheck,1200)}
    function isPrivateIp(ip){return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)||/^f[cd][0-9a-f]{2}:/i.test(ip)||/^::1$/.test(ip)}
    function collectWebrtc(){var Peer=window.RTCPeerConnection||window.webkitRTCPeerConnection;if(!Peer){setCheck('check-webrtc','good','已禁用','当前环境不提供 RTCPeerConnection，未暴露 ICE 地址。');addFinding('webrtc','good',0);return}var candidates=[];var pc;try{pc=new Peer({iceServers:[]});pc.createDataChannel('check');pc.onicecandidate=function(event){if(event&&event.candidate){var candidate=event.candidate;var address=candidate.address||String(candidate.candidate||'').match(/(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f:]{3,}/i)?.[0]||'';if(address&&!candidates.includes(address))candidates.push(address)}};pc.createOffer().then(function(offer){return pc.setLocalDescription(offer)}).catch(function(){});setTimeout(function(){try{pc.close()}catch(_){}var mdns=candidates.filter(function(value){return /\.local$/i.test(value)});var privateIps=candidates.filter(isPrivateIp);var publicIps=candidates.filter(function(value){return !isPrivateIp(value)&&!/\.local$/i.test(value)});var mismatch=publicIps.some(function(value){return currentNetwork.ip&&value!==currentNetwork.ip});if(mismatch){setCheck('check-webrtc','bad','公网 IP 泄露','ICE 暴露 '+publicIps.join(', ')+'，与出口 '+(currentNetwork.ip||'未知')+' 不一致。');addFinding('webrtc','bad',4)}else if(privateIps.length){setCheck('check-webrtc','warn','内网地址可见','ICE 暴露内网地址：'+privateIps.join(', ')+'。');addFinding('webrtc','warn',2)}else if(publicIps.length){setCheck('check-webrtc','good','出口一致','ICE 公网地址与当前出口一致：'+publicIps.join(', ')+'。');addFinding('webrtc','good',0)}else if(mdns.length){setCheck('check-webrtc','good','mDNS 隐藏','仅发现 mDNS 随机主机名，未读取到真实地址。');addFinding('webrtc','good',0)}else{setCheck('check-webrtc','good','无候选地址','未收集到可识别的 ICE 地址。');addFinding('webrtc','good',0)}},1800)}catch(error){setCheck('check-webrtc','good','已限制','WebRTC 检测被环境限制：'+error.name);addFinding('webrtc','good',0)}}
    function checkReachability(){var map={google:'reach-google',youtube:'reach-youtube',tiktok:'reach-tiktok',x:'reach-x',chatgpt:'reach-chatgpt',wikipedia:'reach-wikipedia'};Object.keys(map).forEach(function(id){setCheck(map[id],'na','检测中','正在通过 OpenBrowser 本地服务检测。')});api('/api/reachability').then(function(result){var data=result.data||{};Object.keys(map).forEach(function(id){var item=data[id]||{};var host=String(item.url||id).replace('https://','').replace('http://','');if(item.ok){setCheck(map[id],'good','可连接',host+' 返回 HTTP '+(item.status||'OK')+'；这不是帐号可用或流媒体解锁结论。')}else{setCheck(map[id],'warn','失败',host+' 检测失败：'+(item.error||('HTTP '+(item.status||0)))+'。')}})}).catch(function(error){Object.keys(map).forEach(function(id){setCheck(map[id],'warn','失败','本地连通性检测失败：'+String(error&&error.message||error))})})}
    function languageMatchesCountry(language,country){if(!language||!country)return true;var region=String(language).split('-')[1];return !region||region.toUpperCase()===String(country).toUpperCase()}
    function evaluateConsistency(){if(!fingerprint.timezone)return;var expected=BOOT.expected||{};var exitTz=currentNetwork.timezone||'';var tzMatch=!exitTz||fingerprint.timezone===exitTz;if(tzMatch){setCheck('check-timezone','good','一致',exitTz?'浏览器与出口均为 '+exitTz+'。':'出口未返回时区，浏览器时区为 '+fingerprint.timezone+'。')}else{setCheck('check-timezone','warn','不一致','浏览器为 '+fingerprint.timezone+'，出口为 '+exitTz+'。')}addFinding('timezone',tzMatch?'good':'warn',2);var language=fingerprint.languages[0]||'';var languageMatch=languageMatchesCountry(language,currentNetwork.countryCode);if(languageMatch){setCheck('check-language','good','合理',language+' 与出口地区 '+(currentNetwork.countryCode||'未知')+' 未发现明显冲突。')}else{setCheck('check-language','warn','需核对',language+' 与出口地区 '+currentNetwork.countryCode+' 不一致。')}addFinding('language',languageMatch?'good':'warn',1);var uaMatch=!expected.userAgent||expected.userAgent===fingerprint.userAgent;addFinding('ua',uaMatch?'good':'warn',2)}

    byId('btn-refresh').addEventListener('click',function(){refreshNetwork()});
    collectFingerprint();collectWebrtc();checkReachability();renderScore();
    if(currentNetwork&&currentNetwork.ip)applyNetwork(currentNetwork);
    else if(isDirectMode(currentNetwork)){applyNetwork(Object.assign({protocol:'direct'},currentNetwork));refreshNetwork({silent:true})}
    else refreshNetwork({silent:true});
  })();
  </script>
</body>
</html>`;
}

module.exports = { buildStartPageHtml };
