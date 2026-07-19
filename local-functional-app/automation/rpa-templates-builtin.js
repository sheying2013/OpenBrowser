'use strict';

/**
 * Built-in RPA templates for the local template store.
 *
 * This catalog provides:
 *  - 同类目 / 同类动作节点（gotoUrl / click / inputContent / forTimes …）
 *  - 可直接「使用 → 生成流程 → 运行」的完整 steps
 *  - pay_type: 1=免费 2=付费(仅展示，本地全免费可装)
 *
 * Steps are self-contained CDP executable sequences.
 */

function S(type, params = {}, children) {
  const step = { type, ...params };
  if (children) step.children = children;
  return step;
}

const wait = (ms = 1000) => S('waitTime', { timeout: ms, timeoutType: 'fixed' });
const waitRand = (min = 400, max = 1200) => S('waitTime', {
  timeoutType: 'randomInterval', timeoutMin: min, timeoutMax: max,
});
const goto = (url) => S('gotoUrl', { url });
const click = (selector) => S('click', { selector, selectorRadio: 'CSS', button: 'left', type: 'click' });
const input = (selector, content, isClear = true) => S('inputContent', {
  selector, selectorRadio: 'CSS', content, isClear,
});
const key = (k) => S('keyboard', { key: k });
// `S` stores the action name in `type`, so motion style must use a distinct key.
const scroll = (deltaY = 600) => S('scrollPage', { deltaY, motion: 'smooth', rangeType: 'window' });
const waitSel = (selector, timeout = 12000) => S('waitForSelector', {
  selector, selectorRadio: 'CSS', timeout, isShow: true,
});
const js = (expression) => S('javaScript', { expression });
const newPage = (url) => S('newPage', { url });
const reload = () => S('refreshPage', {});
const shot = () => S('screenshotPage', { fullPage: true });
const getUrl = () => S('getUrl', {});
const clearCk = () => S('clearCookies', {});
const loop = (times, children) => S('forTimes', { times }, children);

function tpl(partial) {
  return {
    uses: 0,
    builtin: true,
    source: 'builtin',
    pay_type: 1,
    developer: 'OpenBrowser',
    tags: [],
    ...partial,
  };
}

/** @type {ReadonlyArray<object>} */
const BUILTIN_TEMPLATES = Object.freeze([
  // ─── 网页操作 ─────────────────────────────────────────
  tpl({
    id: 'builtin-baidu-search',
    name: '百度搜索关键词',
    cat: '网页操作',
    desc: '打开百度，输入关键词并点击搜索。适合快速了解流程结构。',
    tags: ['搜索', '百度', '入门'],
    uses: 1280,
    steps: [
      goto('https://www.baidu.com'),
      wait(1500),
      waitSel('#kw'),
      input('#kw', 'OpenBrowser RPA'),
      wait(400),
      click('#su'),
      wait(2000),
      getUrl(),
    ],
  }),
  tpl({
    id: 'builtin-bing-search',
    name: 'Bing 搜索关键词',
    cat: '网页操作',
    desc: '打开 Bing，输入关键词并回车搜索。',
    tags: ['搜索', 'Bing'],
    uses: 860,
    steps: [
      goto('https://www.bing.com'),
      wait(1500),
      waitSel('#sb_form_q'),
      input('#sb_form_q', 'antidetect browser'),
      wait(300),
      key('Enter'),
      wait(2000),
    ],
  }),
  tpl({
    id: 'builtin-google-search',
    name: 'Google 搜索（需可访问）',
    cat: '网页操作',
    desc: '打开 Google 搜索页，输入关键词并提交。',
    tags: ['搜索', 'Google'],
    uses: 720,
    steps: [
      goto('https://www.google.com/ncr'),
      wait(1800),
      waitSel('textarea[name="q"], input[name="q"]', 15000),
      input('textarea[name="q"], input[name="q"]', 'open source fingerprint browser'),
      wait(300),
      key('Enter'),
      wait(2500),
    ],
  }),
  tpl({
    id: 'builtin-open-scroll',
    name: '打开网页并滚动浏览',
    cat: '网页操作',
    desc: '打开目标 URL，模拟真人向下滚动多次。养号常用骨架。',
    tags: ['滚动', '浏览', '养号'],
    uses: 2100,
    steps: [
      goto('https://example.com'),
      wait(1200),
      scroll(700),
      waitRand(500, 1100),
      scroll(700),
      waitRand(500, 1100),
      scroll(500),
      wait(800),
    ],
  }),
  tpl({
    id: 'builtin-multi-tab',
    name: '多标签打开站点',
    cat: '网页操作',
    desc: '当前页打开一个站点，再新建标签打开第二个。',
    tags: ['多标签'],
    uses: 540,
    steps: [
      goto('https://www.bing.com'),
      wait(800),
      newPage('https://www.wikipedia.org'),
      wait(1200),
    ],
  }),
  tpl({
    id: 'builtin-wait-click',
    name: '等待元素后点击',
    cat: '网页操作',
    desc: '打开页面，等待选择器出现后点击。可按目标站改 selector。',
    tags: ['等待', '点击'],
    uses: 980,
    steps: [
      goto('https://example.com'),
      waitSel('h1', 10000),
      click('h1'),
      wait(500),
    ],
  }),
  tpl({
    id: 'builtin-human-type',
    name: '拟人化输入搜索框',
    cat: '网页操作',
    desc: '带随机间隔的拟人输入（intervals），降低输入检测风险。',
    tags: ['拟人', '输入'],
    uses: 640,
    steps: [
      goto('https://www.bing.com'),
      wait(1200),
      waitSel('#sb_form_q'),
      S('inputContent', {
        selector: '#sb_form_q', selectorRadio: 'CSS', content: 'hello world',
        isClear: true, intervals: true, human: true, minDelay: 40, maxDelay: 140,
      }),
      wait(400),
      key('Enter'),
      wait(1800),
    ],
  }),
  tpl({
    id: 'builtin-page-nav-chain',
    name: '多页跳转链路',
    cat: '网页操作',
    desc: '依次打开多个 URL，中间随机等待，适合预热。',
    tags: ['预热', '跳转'],
    uses: 430,
    steps: [
      goto('https://example.com'),
      waitRand(800, 1600),
      goto('https://www.wikipedia.org'),
      waitRand(800, 1600),
      goto('https://www.bing.com'),
      wait(1000),
      getUrl(),
    ],
  }),

  // ─── 养号浏览 ─────────────────────────────────────────
  tpl({
    id: 'builtin-nurture-scroll-loop',
    name: '循环滚动养号（5 次）',
    cat: '养号浏览',
    desc: '打开首页后 forTimes 循环滚动+随机等待，模拟停留。',
    tags: ['养号', '循环', '滚动'],
    uses: 1890,
    steps: [
      goto('https://example.com'),
      wait(1500),
      loop(5, [
        scroll(500),
        waitRand(600, 1400),
        scroll(400),
        waitRand(400, 900),
      ]),
    ],
  }),
  tpl({
    id: 'builtin-nurture-reload',
    name: '间歇刷新停留',
    cat: '养号浏览',
    desc: '打开页面后循环刷新，适合检测登录态保持。',
    tags: ['刷新', '养号'],
    uses: 410,
    steps: [
      goto('https://example.com'),
      wait(1000),
      loop(3, [reload(), waitRand(1500, 3000)]),
    ],
  }),
  tpl({
    id: 'builtin-nurture-read-page',
    name: '阅读页面并截图存证',
    cat: '养号浏览',
    desc: '进入页面、滚动阅读、截图记录（日志里留下截图长度）。',
    tags: ['截图', '阅读'],
    uses: 520,
    steps: [
      goto('https://example.com'),
      wait(1200),
      scroll(600),
      wait(1000),
      scroll(600),
      wait(800),
      shot(),
    ],
  }),

  // ─── 数据采集 ─────────────────────────────────────────
  tpl({
    id: 'builtin-get-title',
    name: '采集页面标题',
    cat: '数据采集',
    desc: '打开页面并用 JS 读取 document.title，写入运行日志。',
    tags: ['JS', '采集'],
    uses: 760,
    steps: [
      goto('https://example.com'),
      wait(1200),
      js('document.title'),
    ],
  }),
  tpl({
    id: 'builtin-get-url',
    name: '获取当前地址',
    cat: '数据采集',
    desc: '等待后读取当前页 URL。',
    tags: ['URL'],
    uses: 690,
    steps: [
      goto('https://example.com'),
      wait(800),
      getUrl(),
    ],
  }),
  tpl({
    id: 'builtin-extract-links',
    name: '采集页面外链列表',
    cat: '数据采集',
    desc: '用 JS 提取前 20 个 a[href]，适合目录页抓取骨架。',
    tags: ['链接', '采集'],
    uses: 880,
    steps: [
      goto('https://example.com'),
      wait(1500),
      js(`Array.from(document.querySelectorAll('a[href]')).slice(0,20).map(a=>({text:a.innerText.trim().slice(0,40),href:a.href}))`),
    ],
  }),
  tpl({
    id: 'builtin-extract-meta',
    name: '采集 meta 与 canonical',
    cat: '数据采集',
    desc: '读取 description / og:title / canonical 等 SEO 字段。',
    tags: ['meta', 'SEO'],
    uses: 390,
    steps: [
      goto('https://example.com'),
      wait(1000),
      js(`({
        title: document.title,
        desc: document.querySelector('meta[name="description"]')?.content || '',
        og: document.querySelector('meta[property="og:title"]')?.content || '',
        canonical: document.querySelector('link[rel="canonical"]')?.href || location.href
      })`),
    ],
  }),
  tpl({
    id: 'builtin-extract-text',
    name: '采集正文纯文本',
    cat: '数据采集',
    desc: '取 body.innerText 前 500 字，用于简单正文抓取。',
    tags: ['正文'],
    uses: 610,
    steps: [
      goto('https://example.com'),
      wait(1200),
      js(`(document.body.innerText || '').replace(/\\s+/g,' ').trim().slice(0,500)`),
    ],
  }),

  // ─── 社交媒体 ─────────────────────────────────────────
  tpl({
    id: 'builtin-x-open-home',
    name: '打开 X/Twitter 首页浏览',
    cat: '社交媒体',
    desc: '打开 x.com，等待主栏，滚动时间线。登录态依赖当前环境 Cookie。',
    tags: ['X', 'Twitter', '滚动'],
    uses: 1450,
    steps: [
      goto('https://x.com'),
      wait(2500),
      scroll(800),
      waitRand(800, 1600),
      scroll(800),
      wait(1000),
    ],
  }),
  tpl({
    id: 'builtin-reddit-browse',
    name: 'Reddit 热门浏览',
    cat: '社交媒体',
    desc: '打开 Reddit 热门并滚动。',
    tags: ['Reddit'],
    uses: 670,
    steps: [
      goto('https://www.reddit.com/r/popular/'),
      wait(2200),
      scroll(900),
      waitRand(700, 1500),
      scroll(900),
    ],
  }),
  tpl({
    id: 'builtin-youtube-home',
    name: 'YouTube 首页滚动',
    cat: '社交媒体',
    desc: '打开 YouTube 首页并向下浏览推荐。',
    tags: ['YouTube'],
    uses: 910,
    steps: [
      goto('https://www.youtube.com'),
      wait(2500),
      scroll(1000),
      wait(1200),
      scroll(1000),
    ],
  }),
  tpl({
    id: 'builtin-github-trending',
    name: 'GitHub Trending 浏览',
    cat: '社交媒体',
    desc: '打开 GitHub Trending，采集仓库名列表。',
    tags: ['GitHub', '采集'],
    uses: 480,
    steps: [
      goto('https://github.com/trending'),
      wait(2000),
      js(`Array.from(document.querySelectorAll('article h2 a')).slice(0,10).map(a=>a.innerText.trim())`),
      scroll(600),
    ],
  }),

  // ─── 电商 ─────────────────────────────────────────────
  tpl({
    id: 'builtin-amazon-search',
    name: 'Amazon 商品搜索',
    cat: '电商',
    desc: '打开 Amazon 搜索框输入关键词（站点可按地区改域名）。',
    tags: ['Amazon', '搜索'],
    uses: 1020,
    steps: [
      goto('https://www.amazon.com'),
      wait(2000),
      waitSel('#twotabsearchtextbox', 15000),
      input('#twotabsearchtextbox', 'wireless mouse'),
      wait(400),
      click('#nav-search-submit-button'),
      wait(2500),
      scroll(700),
    ],
  }),
  tpl({
    id: 'builtin-ebay-search',
    name: 'eBay 商品搜索',
    cat: '电商',
    desc: '打开 eBay 搜索并滚动结果。',
    tags: ['eBay'],
    uses: 430,
    steps: [
      goto('https://www.ebay.com'),
      wait(1800),
      waitSel('#gh-ac', 12000),
      input('#gh-ac', 'mechanical keyboard'),
      wait(300),
      key('Enter'),
      wait(2200),
      scroll(600),
    ],
  }),
  tpl({
    id: 'builtin-product-watch',
    name: '商品页停留与截图',
    cat: '电商',
    desc: '打开指定商品页 URL，滚动细节并截图。请把 URL 改成你的商品。',
    tags: ['商品', '截图'],
    uses: 560,
    steps: [
      goto('https://example.com'),
      wait(1500),
      scroll(500),
      wait(800),
      scroll(500),
      shot(),
      js('document.title'),
    ],
  }),

  // ─── 账号管理 ─────────────────────────────────────────
  tpl({
    id: 'builtin-clear-cookies',
    name: '清 Cookie 后刷新',
    cat: '账号管理',
    desc: '清除浏览器 Cookie 并刷新当前页。',
    tags: ['Cookie', '清理'],
    uses: 1180,
    steps: [
      clearCk(),
      wait(300),
      reload(),
      wait(800),
    ],
  }),
  tpl({
    id: 'builtin-cookie-check',
    name: '检查 Cookie 数量',
    cat: '账号管理',
    desc: '用 JS 读取 document.cookie 片段，确认登录态是否还在。',
    tags: ['Cookie', '检查'],
    uses: 740,
    steps: [
      goto('https://example.com'),
      wait(800),
      js(`({ cookieLen: (document.cookie||'').length, sample: (document.cookie||'').slice(0,120) })`),
    ],
  }),
  tpl({
    id: 'builtin-login-form-fill',
    name: '通用登录表单填充（改 selector）',
    cat: '账号管理',
    desc: '骨架：打开登录页 → 填用户名/密码 → 点击登录。务必改 URL 与 selector。',
    tags: ['登录', '表单'],
    uses: 1560,
    steps: [
      goto('https://example.com'),
      wait(1500),
      input('input[type="email"], input[name="username"], input[name="email"], #email', 'demo@example.com'),
      wait(400),
      input('input[type="password"], input[name="password"], #password', 'ChangeMe123!'),
      wait(400),
      click('button[type="submit"], input[type="submit"], .login-btn, #login'),
      wait(2500),
      getUrl(),
    ],
  }),
  tpl({
    id: 'builtin-logout-clear',
    name: '退出态清理（清 Cookie+跳转）',
    cat: '账号管理',
    desc: '清理 Cookie 后跳转到首页，模拟干净会话。',
    tags: ['退出', '清理'],
    uses: 390,
    steps: [
      clearCk(),
      wait(300),
      goto('https://example.com'),
      wait(1000),
    ],
  }),

  // ─── 工具 ─────────────────────────────────────────────
  tpl({
    id: 'builtin-screenshot',
    name: '打开页面并截图',
    cat: '工具',
    desc: '导航到目标页，等待加载后截图（记录在运行日志）。',
    tags: ['截图'],
    uses: 920,
    steps: [
      goto('https://example.com'),
      wait(1500),
      shot(),
    ],
  }),
  tpl({
    id: 'builtin-ua-probe',
    name: '环境指纹探针',
    cat: '工具',
    desc: '读取 UA / 语言 / 时区 / 屏幕，用于核对环境是否符合预期。',
    tags: ['指纹', '探针'],
    uses: 1340,
    steps: [
      goto('https://example.com'),
      wait(800),
      js(`({
        ua: navigator.userAgent,
        lang: navigator.language,
        langs: navigator.languages,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
        platform: navigator.platform,
        hw: navigator.hardwareConcurrency,
        mem: navigator.deviceMemory || null
      })`),
    ],
  }),
  tpl({
    id: 'builtin-ip-check',
    name: '出口 IP 检测（ipify）',
    cat: '工具',
    desc: '打开 ipify 纯文本接口页面读取出口 IP。',
    tags: ['IP', '代理'],
    uses: 1710,
    steps: [
      goto('https://api.ipify.org?format=json'),
      wait(1500),
      js(`document.body.innerText`),
    ],
  }),
  tpl({
    id: 'builtin-timezone-check',
    name: '时区与本地时间',
    cat: '工具',
    desc: '核对时区与本地时间字符串。',
    tags: ['时区'],
    uses: 450,
    steps: [
      goto('about:blank'),
      wait(300),
      js(`({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, now: new Date().toString(), offset: new Date().getTimezoneOffset() })`),
    ],
  }),
  tpl({
    id: 'builtin-webgl-probe',
    name: 'WebGL 渲染器探针',
    cat: '工具',
    desc: '读取 WebGL UNMASKED_VENDOR/RENDERER，检查 GPU 伪装。',
    tags: ['WebGL', '指纹'],
    uses: 990,
    steps: [
      goto('about:blank'),
      wait(300),
      js(`(() => {
        try {
          const c = document.createElement('canvas');
          const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
          if (!gl) return { ok: false };
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          return {
            ok: true,
            vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
            renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
          };
        } catch (e) { return { ok: false, err: String(e) }; }
      })()`),
    ],
  }),

  // ─── 流程控制 ─────────────────────────────────────────
  tpl({
    id: 'builtin-loop-refresh',
    name: '循环刷新 3 次',
    cat: '流程控制',
    desc: 'forTimes 循环刷新当前页。',
    tags: ['循环', '刷新'],
    uses: 580,
    steps: [
      goto('https://example.com'),
      wait(600),
      loop(3, [reload(), wait(800)]),
    ],
  }),
  tpl({
    id: 'builtin-nested-loop-browse',
    name: '嵌套：打开→循环滚动',
    cat: '流程控制',
    desc: '演示 forTimes 嵌套滚动步骤。',
    tags: ['循环', '嵌套'],
    uses: 360,
    steps: [
      goto('https://example.com'),
      wait(1000),
      loop(2, [
        loop(2, [scroll(400), waitRand(300, 700)]),
        wait(500),
      ]),
    ],
  }),
  tpl({
    id: 'builtin-key-combo-demo',
    name: '键盘操作演示（Ctrl/Meta+A 选中）',
    cat: '流程控制',
    desc: '聚焦 body 后发送组合键（平台差异请自测）。',
    tags: ['键盘'],
    uses: 220,
    steps: [
      goto('https://example.com'),
      wait(800),
      js('document.body.focus()'),
      key('a'),
      wait(500),
    ],
  }),

  // ─── 邮箱 / 验证 ───────────────────────────────────────
  tpl({
    id: 'builtin-open-webmail',
    name: '打开网页邮箱入口',
    cat: '邮箱验证',
    desc: '打开常见网页邮箱登录页（Gmail）。需环境可访问。',
    tags: ['邮箱', 'Gmail'],
    uses: 640,
    steps: [
      goto('https://mail.google.com'),
      wait(2500),
      getUrl(),
      shot(),
    ],
  }),
  tpl({
    id: 'builtin-outlook-open',
    name: '打开 Outlook 网页版',
    cat: '邮箱验证',
    desc: '打开 Outlook 登录/收件箱入口。',
    tags: ['邮箱', 'Outlook'],
    uses: 410,
    steps: [
      goto('https://outlook.live.com/mail/'),
      wait(2500),
      getUrl(),
    ],
  }),

  // ─── 开发调试 ─────────────────────────────────────────
  tpl({
    id: 'builtin-blank-ready',
    name: '空白页就绪检查',
    cat: '开发调试',
    desc: 'about:blank 探针，验证 RPA/CDP 链路是否通。',
    tags: ['调试', 'CDP'],
    uses: 300,
    steps: [
      goto('about:blank'),
      wait(200),
      js('({ ready: document.readyState, href: location.href })'),
    ],
  }),
  tpl({
    id: 'builtin-console-echo',
    name: 'JS 表达式回显',
    cat: '开发调试',
    desc: '执行 1+1 与 JSON 回显，验证 evaluate 通路。',
    tags: ['调试', 'JS'],
    uses: 250,
    steps: [
      goto('about:blank'),
      js('1+1'),
      js('JSON.stringify({ok:true,ts:Date.now()})'),
    ],
  }),
  tpl({
    id: 'builtin-selector-stress',
    name: '选择器等待压力测试',
    cat: '开发调试',
    desc: '等待 h1，再读 textContent。',
    tags: ['选择器'],
    uses: 180,
    steps: [
      goto('https://example.com'),
      waitSel('h1'),
      js('document.querySelector("h1")?.textContent'),
    ],
  }),
]);

function cloneBuiltinTemplates() {
  return BUILTIN_TEMPLATES.map((item) => ({
    ...item,
    tags: Array.isArray(item.tags) ? [...item.tags] : [],
    steps: JSON.parse(JSON.stringify(item.steps || [])),
  }));
}

module.exports = {
  BUILTIN_TEMPLATES,
  cloneBuiltinTemplates,
};
