'use strict';

const fs = require('fs');
const path = require('path');

let titleImage = '';
try {
  titleImage = `data:image/svg+xml;base64,${fs.readFileSync(path.join(__dirname, '..', 'assets', 'openbrowser-title.svg')).toString('base64')}`;
} catch (_) {}

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
    :root{color-scheme:light;--ink:#171717;--muted:#5d5d5d;--line:#171717;--paper:#fffdf4;--wash:#f5e9c8;--navy:#202b46;--navy2:#344466;--green:#16803c;--amber:#b56b00;--red:#b32222;--blue:#5145a5;--yellow:#f7d51d}
    *{box-sizing:border-box}html{background:var(--wash)}body{margin:0;color:var(--ink);font-family:"Courier New","Noto Sans Mono","PingFang SC","Microsoft YaHei",monospace;font-size:15px;line-height:1.45;letter-spacing:.01em}
    button{font:inherit}.shell{width:min(1160px,calc(100% - 32px));margin:28px auto 54px;background:var(--paper);border:4px solid var(--line);box-shadow:8px 8px 0 rgba(23,23,23,.92)}
    .hero{background:var(--navy);color:#fff;padding:28px 32px 0;border-bottom:4px solid var(--line)}.hero-brand{text-align:center}.hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:28px}.brand{font-size:14px;font-weight:700;color:var(--yellow);text-transform:uppercase;letter-spacing:.08em}.brand-logo{display:block;width:min(430px,100%);height:auto;margin:0 auto 18px;border:3px solid #111;background:#fffdf4;image-rendering:pixelated}.ip{font-size:46px;line-height:1.15;font-weight:700;margin:10px 0 10px;overflow-wrap:anywhere;text-shadow:3px 3px 0 #111}.ip.small{font-size:28px}.subline{display:flex;flex-wrap:wrap;gap:8px 20px;color:#d9dfeb;min-height:24px}.error{display:none;color:#ffb3a7;margin-top:10px;line-height:1.5}.error.show{display:block}
    .score{text-align:right;min-width:170px}.score-label{color:#d9dfeb;font-size:13px}.score-value{font-size:28px;font-weight:700;margin:6px 0}.score-note{font-size:12px;color:#d9dfeb}.score.good .score-value{color:#68e394}.score.warn .score-value{color:#ffd45e}.score.bad .score-value{color:#ff8c7c}
    .hero-actions{display:flex;gap:12px;justify-content:flex-end;margin-top:18px}.button{border:3px solid #111;background:var(--yellow);color:#111;border-radius:0;padding:9px 14px;cursor:pointer;box-shadow:4px 4px 0 #111;font-weight:700}.button:hover{background:#fff27a}.button:active{transform:translate(3px,3px);box-shadow:1px 1px 0 #111}.button:disabled{opacity:.55;cursor:wait}
    .metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin:26px -32px 0;border-top:4px solid #111;background:#111;gap:3px}.metric{background:var(--navy2);padding:15px 18px;min-width:0}.metric span{display:block;color:#d9dfeb;font-size:12px;margin-bottom:7px}.metric b{display:block;font-size:15px;overflow-wrap:anywhere}
    .band{padding:25px 32px;border-bottom:3px solid var(--line)}.section-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.section-head h2{font-size:20px;margin:0;letter-spacing:.02em}.section-head h2:before{content:"[ ] ";color:var(--blue)}.section-note{font-size:12px;color:var(--muted);text-align:right}
    .summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:3px solid var(--line)}.summary-item{padding:15px 17px;border-right:3px solid var(--line);min-width:0}.summary-item:last-child{border-right:0}.summary-item span{display:block;color:var(--muted);font-size:12px;margin-bottom:7px}.summary-item b{font-size:15px;overflow-wrap:anywhere}
    .health-score-card{border:4px solid var(--line);background:#fff8cf;padding:20px;box-shadow:5px 5px 0 #111}.health-score-main{display:grid;grid-template-columns:180px minmax(0,1fr);gap:24px;align-items:center}.health-score-number{font-size:50px;line-height:1;font-weight:700;color:var(--blue)}.health-score-number small{font-size:20px;color:var(--ink)}.health-score-label{font-size:22px;font-weight:700;margin-top:8px}.health-score-confidence{font-size:12px;color:var(--muted);margin-top:7px}.health-progress{height:24px;border:3px solid var(--line);background:#fff;position:relative}.health-progress span{display:block;height:100%;width:0;background:var(--green);transition:width .2s}.health-score-card.warn .health-progress span{background:var(--amber)}.health-score-card.bad .health-progress span{background:var(--red)}.health-score-card.unknown .health-progress span{background:#999}.health-factors{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:18px}.health-factor{border:3px solid var(--line);padding:11px 13px;background:#fff}.health-factor.good{border-left:9px solid var(--green)}.health-factor.warn{border-left:9px solid var(--amber)}.health-factor.bad{border-left:9px solid var(--red)}.health-factor.neutral{border-left:9px solid #888}.health-factor b{display:block;font-size:14px}.health-factor p{margin:5px 0 0;color:var(--muted);font-size:12px;line-height:1.5}
    .check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.check{border:3px solid var(--line);border-left:9px solid #888;padding:14px 15px;min-width:0;box-shadow:3px 3px 0 rgba(23,23,23,.7)}.check.good{border-left-color:var(--green)}.check.warn{border-left-color:var(--amber)}.check.bad{border-left-color:var(--red)}.check.na{border-left-color:#888}.check-title{display:flex;align-items:center;justify-content:space-between;gap:12px;font-weight:700}.status{font-size:12px;padding:3px 7px;border:2px solid var(--line);background:#eee;color:var(--ink);white-space:nowrap}.good .status{background:#c9f4d4}.warn .status{background:#ffe8a8}.bad .status{background:#ffc3bc}.check p{margin:8px 0 0;color:var(--muted);font-size:13px;line-height:1.5;overflow-wrap:anywhere}
    .table{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-top:3px solid var(--line);border-left:3px solid var(--line)}.cell{display:grid;grid-template-columns:140px minmax(0,1fr);gap:14px;padding:12px 14px;border-right:3px solid var(--line);border-bottom:3px solid var(--line);min-width:0}.cell.wide{grid-column:1/-1}.key{color:var(--muted);font-size:12px}.value{font-weight:700;overflow-wrap:anywhere;min-height:18px}.muted{color:#929292;font-weight:400}.footer{padding:18px 32px;color:#5d5d5d;font-size:12px;line-height:1.7;background:#eee5c8}
    .toast{position:fixed;right:18px;top:18px;background:#111;color:#fff;padding:11px 14px;border:3px solid #fff;box-shadow:4px 4px 0 #111;opacity:0;transform:translateY(-5px);transition:.18s;pointer-events:none}.toast.show{opacity:1;transform:none}
    @media(max-width:780px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.metrics .metric:last-child{grid-column:1/-1}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.summary-item{border-bottom:3px solid var(--line)}.health-score-main{grid-template-columns:1fr}.health-factors,.check-grid,.table{grid-template-columns:1fr}.cell.wide{grid-column:auto}}
    @media(max-width:520px){html{background:#fffdf4}.shell{width:100%;margin:0;border:0;box-shadow:none}.hero{padding:22px 18px 0}.hero-top{display:block}.score{text-align:left;margin-top:18px}.hero-actions{justify-content:flex-start}.ip{font-size:34px}.metrics{margin:20px -18px 0}.metric{padding:12px}.band{padding:20px 18px}.summary{grid-template-columns:1fr}.summary-item{border-right:0}.cell{grid-template-columns:105px minmax(0,1fr)}.footer{padding:16px 18px}}
    body{font-size:13px;line-height:1.4}.shell{width:min(1080px,calc(100% - 28px));margin:20px auto 38px;border-width:3px;box-shadow:6px 6px 0 rgba(23,23,23,.92)}
    .hero{padding:20px 24px 0;border-bottom-width:3px}.hero-top{gap:22px}.brand-logo{width:min(340px,100%);margin-bottom:12px;border-width:2px}.ip{font-size:38px;margin:8px 0}.ip.small{font-size:24px}.subline{gap:6px 16px;min-height:21px}.score{min-width:150px}.score-label{font-size:11px}.score-value{font-size:24px;margin:4px 0}.score-note{font-size:11px}.hero-actions{gap:9px;margin-top:14px}.button{border-width:2px;padding:7px 11px;box-shadow:3px 3px 0 #111}.metrics{margin:20px -24px 0;border-top-width:3px;gap:2px}.metric{padding:11px 13px}.metric span{font-size:11px;margin-bottom:5px}.metric b{font-size:13px}.band{padding:19px 24px;border-bottom-width:2px}.section-head{gap:14px;margin-bottom:13px}.section-head h2{font-size:17px}.section-note{font-size:11px}.summary{border-width:2px}.summary-item{padding:11px 13px;border-right-width:2px}.summary-item span{font-size:11px;margin-bottom:5px}.summary-item b{font-size:13px}.health-score-card{border-width:3px;padding:15px;box-shadow:4px 4px 0 #111}.health-score-main{grid-template-columns:150px minmax(0,1fr);gap:18px}.health-score-number{font-size:42px}.health-score-number small{font-size:17px}.health-score-label{font-size:18px;margin-top:6px}.health-score-confidence{font-size:11px;margin-top:5px}.health-progress{height:19px;border-width:2px}.health-factors{gap:8px;margin-top:13px}.health-factor{border-width:2px;padding:9px 11px}.health-factor.good,.health-factor.warn,.health-factor.bad,.health-factor.neutral{border-left-width:7px}.health-factor b{font-size:13px}.health-factor p{margin-top:4px;font-size:11px}.check-grid{gap:9px}.check{border-width:2px;border-left-width:7px;padding:11px 12px;box-shadow:2px 2px 0 rgba(23,23,23,.7)}.check-title{gap:10px}.status{font-size:11px;padding:2px 5px}.check p{margin-top:6px;font-size:11px}.table{border-width:2px}.cell{grid-template-columns:120px minmax(0,1fr);gap:11px;padding:9px 11px;border-width:2px}.key,.footer{font-size:11px}.footer{padding:14px 24px}
    @media(max-width:520px){.hero{padding:18px 15px 0}.metrics{margin:17px -15px 0}.metric{padding:10px}.band{padding:16px 15px}.cell{grid-template-columns:100px minmax(0,1fr)}.footer{padding:13px 15px}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="hero">
      <div class="hero-brand">
        ${titleImage ? `<img class="brand-logo" src="${titleImage}" alt="OpenBrowser">` : '<div class="brand">OpenBrowser</div>'}
      </div>
      <div class="hero-top">
        <div>
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
      <div class="error" id="country-note" ${network.countryNote ? 'style="display:block;margin:12px 0 0"' : ''}></div>
    </header>

    <section class="band">
      <div class="section-head"><h2>IP 健康评分</h2><span class="section-note">本地综合评估；仅供参考</span></div>
      <div class="health-score-card unknown" id="health-score-card">
        <div class="health-score-main">
          <div><div class="health-score-number"><span id="health-score-value">--</span><small> / 100</small></div><div class="health-score-label" id="health-score-label">待检测</div><div class="health-score-confidence" id="health-score-confidence">置信度：低</div></div>
          <div class="health-progress" aria-label="IP 健康评分进度"><span id="health-score-progress"></span></div>
        </div>
        <div class="health-factors" id="health-score-factors"><article class="health-factor neutral"><b>等待出口数据</b><p>取得 IP 后显示评分因素。</p></article></div>
      </div>
    </section>

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
        <article class="check na" id="check-dns"><div class="check-title">DNS 泄露 <span class="status">检测中</span></div><p>正在触发唯一探测域名并比对 DNS 解析器地区与出口地区。</p></article>
      </div>
    </section>

    <section class="band">
      <div class="section-head"><h2>访问能力</h2><span class="section-note">出口 IP 地区 + 站点侧访问身份 + best-effort 可用性判断（非账号可用性保证）</span></div>
      <div class="check-grid" id="reachability-grid">
        <article class="check na" id="reach-google"><div class="check-title">Google <span class="status">等待</span></div><p>等待检测。</p></article>
        <article class="check na" id="reach-youtube"><div class="check-title">YouTube <span class="status">等待</span></div><p>等待检测。</p></article>
        <article class="check na" id="reach-tiktok"><div class="check-title">TikTok <span class="status">等待</span></div><p>等待检测。</p></article>
        <article class="check na" id="reach-x"><div class="check-title">X / Twitter <span class="status">等待</span></div><p>等待检测。</p></article>
        <article class="check na" id="reach-chatgpt"><div class="check-title">ChatGPT <span class="status">等待</span></div><p>等待检测。</p></article>
        <article class="check na" id="reach-wikipedia"><div class="check-title">Wikipedia <span class="status">等待</span></div><p>等待检测。</p></article>
        <article class="check na" id="reach-facebook"><div class="check-title">Facebook <span class="status">等待</span></div><p>等待检测。</p></article>
        <article class="check na" id="reach-instagram"><div class="check-title">Instagram <span class="status">等待</span></div><p>等待检测。</p></article>
        <article class="check na" id="reach-reddit"><div class="check-title">Reddit <span class="status">等待</span></div><p>等待检测。</p></article>
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
    <footer class="footer">本页健康结果为本地综合评估，不保证任何站点的账号可用性。代理、托管和移动网络标签来自多源出口查询；Canvas、WebGL 暴露代表可被读取的指纹表面，不等同于身份泄露。</footer>
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
    function renderHealthScore(score){var card=byId('health-score-card');if(!card)return;score=score||{};var known=Number.isFinite(Number(score.score));var level=String(score.level||'unknown');var confidence={high:'高',medium:'中',low:'低'}[String(score.confidence||'low')]||'低';card.className='health-score-card '+level;text('health-score-value',known?Number(score.score):'--');text('health-score-label',score.label||'待检测');text('health-score-confidence','置信度：'+confidence);var progress=byId('health-score-progress');if(progress)progress.style.width=(known?Math.max(0,Math.min(100,Number(score.score))):0)+'%';var factors=byId('health-score-factors');if(!factors)return;factors.textContent='';(Array.isArray(score.factors)&&score.factors.length?score.factors:[{state:'neutral',label:'等待出口数据',detail:'取得 IP 后显示评分因素。'}]).forEach(function(factor){var article=document.createElement('article');article.className='health-factor '+String(factor.state||'neutral');var title=document.createElement('b');title.textContent=String(factor.label||'未命名因素');var detail=document.createElement('p');detail.textContent=String(factor.detail||'');article.appendChild(title);article.appendChild(detail);factors.appendChild(article)})}
    function api(path){var target=new URL(path,location.origin);if(pid&&!target.searchParams.has('pid'))target.searchParams.set('pid',pid);return fetch(target.pathname+target.search,{cache:'no-store',headers:{'X-OpenBrowser-Start-Token':sessionToken}}).then(function(response){return response.json().catch(function(){return {}}).then(function(body){if(!response.ok||!body.ok)throw new Error(body.msg||('HTTP '+response.status));return body})})}
    function networkType(net){var values=[];if(net.hosting)values.push('托管/机房');if(net.mobile)values.push('移动网络');if(net.proxy)values.push('代理标记');if(net.geoConflict)values.push('地区冲突');return values.length?values.join(' · '):'常规网络'}
    function isDirectMode(net){return BOOT.networkMode==='direct'||String((net&&net.protocol)||'').toLowerCase()==='direct'||String(BOOT.proxyProtocol||'').toLowerCase()==='direct'}
    function countryDisplay(net){var main=net.country||net.countryCode||'';if(net.geoConflict&&net.countryUsage&&net.countryRegistered&&net.countryUsage!==net.countryRegistered){return main+' · 使用 '+net.countryUsage+' / 注册 '+net.countryRegistered}if(net.geoConflict&&Array.isArray(net.countries)&&net.countries.length>1){return main+' · 多源 '+net.countries.join('/')}return main}
    function applyNetwork(net){if(!net)return;currentNetwork=net;var ip=net.ip||net.query||'';var directMode=isDirectMode(net);text('ip-ip',ip||(directMode?'本地直连':'未检测'));var ipEl=byId('ip-ip');if(ipEl)ipEl.classList.toggle('small',String(ip||'本地直连').length>22);text('country',countryDisplay(net));text('region',net.region||net.regionName);text('city',net.city);text('timezone',net.timezone);text('network-type',networkType(net));text('net-asn',net.asn);text('net-isp',net.isp);text('net-org',net.organization||net.org);text('net-location',[net.latitude,net.longitude].filter(function(v){return v!=null}).join(', ')||net.zip);text('asn-line',[net.asn,net.asName||net.isp].filter(Boolean).join(' · ')||(directMode?'直连出口':'网络身份读取中'));text('checked-at',net.checkedAt?'检测时间 '+new Date(net.checkedAt).toLocaleString():(ip?'出口数据已更新':(directMode?'直连可用，出口详情稍后补充':'-')));text('network-mode',directMode?'直连模式':String(BOOT.proxyProtocol||net.protocol||'代理').toUpperCase()+' 代理');var error=byId('ip-error');if(error){error.textContent='';error.classList.remove('show')}var note=byId('country-note');if(note){if(net.countryNote){note.textContent=net.countryNote;note.classList.add('show');note.style.display='block'}else{note.textContent='';note.classList.remove('show');note.style.display='none'}}if(ip)addFinding('network','good',0);else if(directMode)addFinding('network','good',0);evaluateConsistency();try{document.title=(ip?ip+' · ':'')+BOOT.title}catch(_){}}
    function showNetworkError(error){var message=String(error&&error.message||error||'未知错误');var directMode=isDirectMode(currentNetwork);if(directMode){applyNetwork(Object.assign({},currentNetwork,{protocol:'direct',soft:true}));return}text('ip-ip','检测失败');var el=byId('ip-ip');if(el)el.classList.add('small');var detail=byId('ip-error');if(detail){detail.textContent=message;detail.classList.add('show')}addFinding('network','bad',4);toast('出口检测失败：'+message)}
    function refreshNetwork(options){options=options||{};if(!pid){if(!options.silent)toast('无环境 ID');return Promise.resolve()}var button=byId('btn-refresh');if(button)button.disabled=true;return api('/api/network?pid='+encodeURIComponent(pid)+'&refresh=1').then(function(result){applyNetwork(result.data);if(!options.silent&&result.data&&result.data.ip)toast('检测已更新')}).catch(function(error){if(options.silent&&isDirectMode(currentNetwork)){applyNetwork(Object.assign({},currentNetwork,{protocol:'direct',soft:true}));return}showNetworkError(error)}).finally(function(){if(button)button.disabled=false})}

    var updateNetworkView=applyNetwork;
    applyNetwork=function(net){updateNetworkView(net);renderHealthScore(net&&net.healthScore)};
    function shortHash(input){var hash=2166136261;for(var i=0;i<input.length;i+=1){hash^=input.charCodeAt(i);hash=Math.imul(hash,16777619)}return ('00000000'+(hash>>>0).toString(16)).slice(-8)}
    function safeNav(getter, fallback){try{var value=getter();return value==null?fallback:value}catch(_){return fallback}}
    function safeLanguages(){try{var list=navigator.languages;if(list&&list.length)return Array.prototype.slice.call(list).filter(Boolean)}catch(_){}try{var one=navigator.language;if(one)return [one]}catch(_){}return []}
    function collectCanvas(){try{var canvas=document.createElement('canvas');canvas.width=280;canvas.height=60;var ctx=canvas.getContext('2d');if(!ctx)return '不可用';ctx.fillStyle='#f2f5f7';ctx.fillRect(0,0,280,60);ctx.font='16px Arial';ctx.fillStyle='#1769aa';ctx.fillText('OpenBrowser fingerprint 012345',8,25);ctx.fillStyle='rgba(180,50,45,.7)';ctx.fillText('Canvas surface',33,47);return shortHash(canvas.toDataURL())}catch(error){return '已阻止 ('+error.name+')'}}
    function collectWebgl(){try{var canvas=document.createElement('canvas');var gl=canvas.getContext('webgl')||canvas.getContext('experimental-webgl');if(!gl)return {vendor:'不可用',renderer:'不可用'};var ext=gl.getExtension('WEBGL_debug_renderer_info');return {vendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)}}catch(error){return {vendor:'已阻止',renderer:error.name}}}
    function collectAudio(){try{var Context=window.OfflineAudioContext||window.webkitOfflineAudioContext;if(!Context)return Promise.resolve('不可用');var context=new Context(1,2048,44100);var oscillator=context.createOscillator();var compressor=context.createDynamicsCompressor();oscillator.type='triangle';oscillator.frequency.value=10000;oscillator.connect(compressor);compressor.connect(context.destination);oscillator.start(0);return context.startRendering().then(function(buffer){var data=buffer.getChannelData(0);var sum=0;for(var i=0;i<data.length;i+=16)sum+=Math.abs(data[i]);return shortHash(sum.toFixed(12))}).catch(function(error){return '已阻止 ('+error.name+')'})}catch(error){return Promise.resolve('已阻止 ('+error.name+')')}}
    function storageTest(){var local=false;try{localStorage.setItem('__ob_test','1');local=localStorage.getItem('__ob_test')==='1';localStorage.removeItem('__ob_test')}catch(_){}return {cookie:safeNav(function(){return navigator.cookieEnabled},false),local:local,indexed:typeof indexedDB!=='undefined'}}
    function collectClientHints(){var data=safeNav(function(){return navigator.userAgentData},null);if(!data)return Promise.resolve('不可用');var base='';try{base=(data.brands||[]).map(function(item){return item.brand+' '+item.version}).join(', ')+' · '+data.platform+(data.mobile?' · Mobile':'')}catch(_){base='Client Hints'}if(!data.getHighEntropyValues)return Promise.resolve(base);try{return data.getHighEntropyValues(['architecture','bitness','model','platformVersion','uaFullVersion']).then(function(value){return base+' · '+[value.architecture,value.bitness,value.model,value.platformVersion,value.uaFullVersion].filter(Boolean).join(' / ')}).catch(function(){return base})}catch(_){return Promise.resolve(base)}}
    function updateAutomationCheck(){var exposed=safeNav(function(){return navigator.webdriver===true},false);if(fingerprint)fingerprint.webdriver=exposed;setCheck('check-automation',exposed?'bad':'good',exposed?'已暴露':'未发现',exposed?'navigator.webdriver = true，可被站点识别为自动化环境。':'未发现 navigator.webdriver 自动化标记。');addFinding('automation',exposed?'bad':'good',3);renderScore()}
    function reportFingerprint(phase){try{var live={phase:phase||'page',userAgent:safeNav(function(){return navigator.userAgent},'')||'',platform:safeNav(function(){return navigator.platform},'')||'',language:safeNav(function(){return navigator.language},'')||'',languages:safeLanguages(),hardwareConcurrency:safeNav(function(){return navigator.hardwareConcurrency},null),deviceMemory:safeNav(function(){return navigator.deviceMemory},null),webglVendor:fingerprint&&fingerprint.webglVendor,webglRenderer:fingerprint&&fingerprint.webglRenderer,canvas:fingerprint&&fingerprint.canvas,webdriver:safeNav(function(){return navigator.webdriver===true},false),timezone:(function(){try{return Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(_){return ''}})(),href:String(location.href||'')};fetch('/api/fingerprint-report?pid='+encodeURIComponent(pid),{method:'POST',headers:{'Content-Type':'application/json','X-OpenBrowser-Start-Token':sessionToken},body:JSON.stringify({phase:phase||'page',live:live}),credentials:'omit'}).catch(function(){})}catch(_){}}
    function collectFingerprint(phase){try{var timezone='';try{timezone=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(_){}var gl=collectWebgl();var storage=storageTest();var cores=safeNav(function(){return navigator.hardwareConcurrency},'?');var memory=safeNav(function(){return navigator.deviceMemory},'?');var touch=safeNav(function(){return navigator.maxTouchPoints},0)||0;var plugins=0;try{plugins=(navigator.plugins&&navigator.plugins.length)||0}catch(_){plugins=0}var dnt=safeNav(function(){return navigator.doNotTrack},'')||'默认';fingerprint={userAgent:safeNav(function(){return navigator.userAgent},'')||'',platform:safeNav(function(){return navigator.platform},'')||'',languages:safeLanguages(),timezone:timezone,screen:screen.width+' × '+screen.height+' @ '+(window.devicePixelRatio||1)+'x; viewport '+innerWidth+' × '+innerHeight,hardware:cores+' cores / '+memory+' GB',webglVendor:gl.vendor,webglRenderer:gl.renderer,canvas:collectCanvas(),webdriver:safeNav(function(){return navigator.webdriver===true},false),storage:storage};text('fp-ua',fingerprint.userAgent);text('fp-platform',fingerprint.platform);text('fp-language',fingerprint.languages.join(', '));text('fp-timezone',timezone);text('fp-screen',fingerprint.screen);text('fp-hardware',fingerprint.hardware);text('fp-webgl-vendor',gl.vendor);text('fp-webgl-renderer',gl.renderer);text('fp-canvas',fingerprint.canvas);text('fp-capabilities',touch+' touch points / '+plugins+' plugins');text('fp-privacy',dnt+' / Cookies '+(storage.cookie?'可用':'禁用'));setCheck('check-storage',storage.cookie&&storage.local&&storage.indexed?'good':'warn',storage.cookie&&storage.local&&storage.indexed?'正常':'受限','Cookie '+(storage.cookie?'可用':'禁用')+'，LocalStorage '+(storage.local?'可用':'禁用')+'，IndexedDB '+(storage.indexed?'可用':'禁用'));addFinding('storage',storage.cookie&&storage.local&&storage.indexed?'good':'warn',1);updateAutomationCheck();collectAudio().then(function(value){text('fp-audio',value)});collectClientHints().then(function(value){text('fp-hints',value)});evaluateConsistency();reportFingerprint(phase||'collect');setTimeout(updateAutomationCheck,400);setTimeout(updateAutomationCheck,1200)}catch(error){try{console.warn('[OpenBrowser] collectFingerprint', error)}catch(_){}}}
    function isPrivateIp(ip){return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)||/^f[cd][0-9a-f]{2}:/i.test(ip)||/^::1$/.test(ip)}
    function collectWebrtc(){var Peer=window.RTCPeerConnection||window.webkitRTCPeerConnection;if(!Peer){setCheck('check-webrtc','good','已禁用','当前环境不提供 RTCPeerConnection，未暴露 ICE 地址。');addFinding('webrtc','good',0);return}var candidates=[];var pc;try{pc=new Peer({iceServers:[]});pc.createDataChannel('check');pc.onicecandidate=function(event){if(event&&event.candidate){var candidate=event.candidate;var address=candidate.address||String(candidate.candidate||'').match(/(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f:]{3,}/i)?.[0]||'';if(address&&!candidates.includes(address))candidates.push(address)}};pc.createOffer().then(function(offer){return pc.setLocalDescription(offer)}).catch(function(){});setTimeout(function(){try{pc.close()}catch(_){}var mdns=candidates.filter(function(value){return /\.local$/i.test(value)});var privateIps=candidates.filter(isPrivateIp);var publicIps=candidates.filter(function(value){return !isPrivateIp(value)&&!/\.local$/i.test(value)});var mismatch=publicIps.some(function(value){return currentNetwork.ip&&value!==currentNetwork.ip});if(mismatch){setCheck('check-webrtc','bad','公网 IP 泄露','ICE 暴露 '+publicIps.join(', ')+'，与出口 '+(currentNetwork.ip||'未知')+' 不一致。');addFinding('webrtc','bad',4)}else if(privateIps.length){setCheck('check-webrtc','warn','内网地址可见','ICE 暴露内网地址：'+privateIps.join(', ')+'。');addFinding('webrtc','warn',2)}else if(publicIps.length){setCheck('check-webrtc','good','出口一致','ICE 公网地址与当前出口一致：'+publicIps.join(', ')+'。');addFinding('webrtc','good',0)}else if(mdns.length){setCheck('check-webrtc','good','mDNS 隐藏','仅发现 mDNS 随机主机名，未读取到真实地址。');addFinding('webrtc','good',0)}else{setCheck('check-webrtc','good','无候选地址','未收集到可识别的 ICE 地址。');addFinding('webrtc','good',0)}},1800)}catch(error){setCheck('check-webrtc','good','已限制','WebRTC 检测被环境限制：'+error.name);addFinding('webrtc','good',0)}}
    function unlockLabel(item){var u=String(item&&item.unlock||'');if(u==='unlocked')return '可用';if(u==='blocked')return '拦截/不可用';if(u==='reachable')return '可连接';if(u==='unreachable')return '不可达';return item&&item.ok?'可连接':'失败'}
    function unlockState(item){var u=String(item&&item.unlock||'');if(u==='unlocked')return 'good';if(u==='blocked')return 'bad';if(u==='reachable')return 'good';if(u==='unreachable')return 'warn';return item&&item.ok?'good':'warn'}
    function formatAccessLine(item){var parts=[];var accessCountry=item.accessCountry||item.siteCountry||item.exitCountry||'';var accessIp=item.accessIp||item.siteIp||item.exitIp||'';var siteIp=item.siteIp||'';var siteCountry=item.siteCountry||'';var exitIp=item.exitIp||'';var exitCountry=item.exitCountry||'';if(accessIp||accessCountry){parts.push('访问身份 '+(accessCountry||'未知地区')+(accessIp?' · '+accessIp:''))}if(siteIp&&siteIp!==accessIp){parts.push('站点可见 IP '+siteIp+(siteCountry?'（'+siteCountry+'）':''))}if(exitIp&&exitIp!==accessIp&&exitIp!==siteIp){parts.push('环境出口 '+(exitCountry||'')+(exitIp?' · '+exitIp:''))}if(item.colo)parts.push('边缘 '+item.colo);if(item.status)parts.push('HTTP '+item.status);return parts.join('；')||'无访问身份数据'}
    function checkReachability(){var map={google:'reach-google',youtube:'reach-youtube',tiktok:'reach-tiktok',x:'reach-x',chatgpt:'reach-chatgpt',wikipedia:'reach-wikipedia',facebook:'reach-facebook',instagram:'reach-instagram',reddit:'reach-reddit'};Object.keys(map).forEach(function(id){setCheck(map[id],'na','检测中','正在检测连通性、访问 IP 地区与可用性信号。')});api('/api/reachability').then(function(result){var data=result.data||{};Object.keys(map).forEach(function(id){var item=data[id]||{};var host=String(item.url||id).replace('https://','').replace('http://','');var line=formatAccessLine(item);var note=item.unlock==='unlocked'?'best-effort 可用性信号通过':item.unlock==='blocked'?'站点返回拦截/不可用信号':item.unlock==='reachable'?'连通正常，无独立可用性信号':item.error?String(item.error):'';if(item.ok||item.unlock==='unlocked'||item.unlock==='reachable'){setCheck(map[id],unlockState(item),unlockLabel(item),host+' · '+line+(note?'。'+note+'。':'。'))}else{setCheck(map[id],unlockState(item),unlockLabel(item),host+' 检测失败：'+(item.error||('HTTP '+(item.status||0)))+(line?'；'+line:'')+'。')}})}).catch(function(error){Object.keys(map).forEach(function(id){setCheck(map[id],'warn','失败','本地连通性检测失败：'+String(error&&error.message||error))})})}
    function checkDnsLeak(){setCheck('check-dns','na','检测中','正在触发唯一探测域名并比对 DNS 解析器与出口地区。');api('/api/dns-leak').then(function(result){var data=result.data||{};var servers=Array.isArray(data.servers)?data.servers:[];var serverText=servers.slice(0,4).map(function(item){return item.ip+(item.countryCode?('('+item.countryCode+')'):'')}).join(', ');var detail=data.detail||'';if(serverText&&detail.indexOf(serverText)<0)detail=(detail?detail+'。':'')+'DNS: '+serverText;var state=data.state==='bad'?'bad':data.state==='good'?'good':data.state==='warn'?'warn':'na';setCheck('check-dns',state,data.label||'已检测',detail||'DNS 检测完成。');addFinding('dns',state==='bad'?'bad':state==='warn'?'warn':'good',state==='bad'?4:state==='warn'?2:0);renderScore()}).catch(function(error){setCheck('check-dns','warn','检测失败','DNS 泄露检测失败：'+String(error&&error.message||error));addFinding('dns','warn',1);renderScore()})}
    function languageMatchesCountry(language,country){if(!language||!country)return true;var region=String(language).split('-')[1];return !region||region.toUpperCase()===String(country).toUpperCase()}
    function evaluateConsistency(){if(!fingerprint.timezone)return;var expected=BOOT.expected||{};var exitTz=currentNetwork.timezone||'';var tzMatch=!exitTz||fingerprint.timezone===exitTz;if(tzMatch){setCheck('check-timezone','good','一致',exitTz?'浏览器与出口均为 '+exitTz+'。':'出口未返回时区，浏览器时区为 '+fingerprint.timezone+'。')}else{setCheck('check-timezone','warn','不一致','浏览器为 '+fingerprint.timezone+'，出口为 '+exitTz+'。')}addFinding('timezone',tzMatch?'good':'warn',2);var language=fingerprint.languages[0]||'';var languageMatch=languageMatchesCountry(language,currentNetwork.countryCode);if(languageMatch){setCheck('check-language','good','合理',language+' 与出口地区 '+(currentNetwork.countryCode||'未知')+' 未发现明显冲突。')}else{setCheck('check-language','warn','需核对',language+' 与出口地区 '+currentNetwork.countryCode+' 不一致。')}addFinding('language',languageMatch?'good':'warn',1);var uaMatch=!expected.userAgent||expected.userAgent===fingerprint.userAgent;addFinding('ua',uaMatch?'good':'warn',2)}

    byId('btn-refresh').addEventListener('click',function(){refreshNetwork()});
    // Collect after inject settles; each sample is also POSTed to
    // /api/fingerprint-report → fingerprint-inject.log (no need to copy UI).
    try { window.__openbrowserCollectFingerprint = function(phase){ try { return collectFingerprint(phase); } catch(e){ try{ console.warn(e); }catch(_){} } }; } catch(_){}
    // Delay first paint so document-start / post-nav inject can land first.
    // t0 at 0ms still saw host GPU/cores on openbrowser-148 before inject settled.
    setTimeout(function(){collectFingerprint('t0')}, 220);
    setTimeout(function(){collectFingerprint('t350')},450);
    setTimeout(function(){collectFingerprint('t1200')},1200);
    setTimeout(function(){collectFingerprint('t2500')},2500);
    setTimeout(function(){collectFingerprint('t4000')},4000);
    collectWebrtc();checkReachability();checkDnsLeak();renderScore();
    if(currentNetwork&&currentNetwork.ip)applyNetwork(currentNetwork);
    else if(isDirectMode(currentNetwork)){applyNetwork(Object.assign({protocol:'direct'},currentNetwork));refreshNetwork({silent:true})}
    else refreshNetwork({silent:true});
  })();
  </script>
</body>
</html>`;
}

module.exports = { buildStartPageHtml };
