'use strict';

/**
 * Application Center (应用中心) — self-contained catalog for OpenBrowser.
 * Does NOT embed third-party CRX binaries.
 * Recommended apps use public Chrome Web Store IDs / URLs only.
 */

const RECOMMENDED_APPS = [
  {
    id: 'rec-canvas-defender',
    name: 'Canvas Defender',
    category: 'privacy',
    description: '通过向 Canvas 添加噪点防指纹追踪',
    store_id: 'obdbgnebcljmgkoljcdddaopadkifnpm',
    store_url: 'https://chromewebstore.google.com/detail/canvas-defender/obdbgnebcljmgkoljcdddaopadkifnpm',
    tags: ['privacy', 'anti-detect'],
  },
  {
    id: 'rec-webrtc-control',
    name: 'WebRTC Control',
    category: 'privacy',
    description: '防止 WebRTC 泄漏真实 IP',
    store_id: 'fjkmabmdepjfammlkbgkcfbkamcgkdeg',
    store_url: 'https://chromewebstore.google.com/detail/webrtc-control/fjkmabmdepjfammlkbgkcfbkamcgkdeg',
    tags: ['privacy', 'webrtc'],
  },
  {
    id: 'rec-spoof-timezone',
    name: 'Spoof Timezone',
    category: 'privacy',
    description: '自动根据 IP 伪装浏览器时区',
    store_id: 'kcabmhnajflfolpjhminmbkgmlpjnbjc',
    store_url: 'https://chromewebstore.google.com/detail/spoof-timezone/kcabmhnajflfolpjhminmbkgmlpjnbjc',
    tags: ['privacy', 'timezone'],
  },
  {
    id: 'rec-audioctx-defender',
    name: 'AudioContext Defender',
    category: 'privacy',
    description: '防 AudioContext 声音指纹探测',
    store_id: 'pmlkpdfnjdmoenlamjdfeoojifpejioc',
    store_url: 'https://chromewebstore.google.com/detail/audiocontext-defender/pmlkpdfnjdmoenlamjdfeoojifpejioc',
    tags: ['privacy', 'anti-detect'],
  },
  {
    id: 'rec-proxy-switchyomega',
    name: 'Proxy SwitchyOmega',
    category: 'network',
    description: '强大的代理切换工具',
    store_id: 'padekgcemlokbadohgkifijomclgjgif',
    store_url: 'https://chromewebstore.google.com/detail/proxy-switchyomega/padekgcemlokbadohgkifijomclgjgif',
    tags: ['proxy'],
  },
  {
    id: 'rec-editthiscookie',
    name: 'EditThisCookie',
    category: 'devtools',
    description: '方便管理及导入导出 Cookie',
    store_id: 'fngmhnnpilhplaeedifhccceomclgfbg',
    store_url: 'https://chromewebstore.google.com/detail/editthiscookie/fngmhnnpilhplaeedifhccceomclgfbg',
    tags: ['cookie'],
  },
  {
    id: 'rec-immersive-translate',
    name: '沉浸式翻译',
    category: 'productivity',
    description: '双语网页、PDF 与视频翻译，适合多语言资料整理',
    store_id: 'bpoadfkcbjbfhfodiogcnhhhpibjhbnh',
    store_url: 'https://chromewebstore.google.com/detail/immersive-translate/bpoadfkcbjbfhfodiogcnhhhpibjhbnh',
    tags: ['translation', 'bilingual', 'pdf'],
  },
  {
    id: 'rec-ublock-origin',
    name: 'uBlock Origin',
    category: 'privacy',
    description: '高效拦截广告、跟踪器和恶意脚本，降低页面干扰',
    store_id: 'cjpalhdlnbpafiamejdnhcphjbkeiagm',
    store_url: 'https://chromewebstore.google.com/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm',
    tags: ['adblock', 'privacy', 'security'],
  },
  {
    id: 'rec-bitwarden',
    name: 'Bitwarden',
    category: 'security',
    description: '开源密码管理器，支持安全保存和自动填充账号',
    store_id: 'nngceckbapebfimnlniiiahkandclblb',
    store_url: 'https://chromewebstore.google.com/detail/bitwarden/nngceckbapebfimnlniiiahkandclblb',
    tags: ['password', 'security', 'autofill'],
  },
  {
    id: 'rec-grammarly',
    name: 'Grammarly',
    category: 'productivity',
    description: '英文拼写、语法和写作建议，适合跨境业务沟通',
    store_id: 'kbfnbcaeplbcioakkpcpgfkobkghlhen',
    store_url: 'https://chromewebstore.google.com/detail/grammarly/kbfnbcaeplbcioakkpcpgfkobkghlhen',
    tags: ['writing', 'english', 'productivity'],
  },
  {
    id: 'rec-onetab',
    name: 'OneTab',
    category: 'productivity',
    description: '将大量标签页收纳为列表，减少浏览器资源占用',
    store_id: 'chphlpgkkbolifaimnlloiipkdnihall',
    store_url: 'https://chromewebstore.google.com/detail/onetab/chphlpgkkbolifaimnlloiipkdnihall',
    tags: ['tabs', 'memory', 'productivity'],
  },
  {
    id: 'rec-session-buddy',
    name: 'Session Buddy',
    category: 'productivity',
    description: '保存、恢复和管理浏览会话，适合多环境任务切换',
    store_id: 'edacconmaakjimmfgnblocblbcdcpbko',
    store_url: 'https://chromewebstore.google.com/detail/session-buddy/edacconmaakjimmfgnblocblbcdcpbko',
    tags: ['sessions', 'tabs', 'backup'],
  },
  {
    id: 'rec-wappalyzer',
    name: 'Wappalyzer',
    category: 'research',
    description: '识别网站使用的技术栈、分析工具和电商平台',
    store_id: 'gppongmhjkpfnbhagpmjfkannfbllamg',
    store_url: 'https://chromewebstore.google.com/detail/wappalyzer/gppongmhjkpfnbhagpmjfkannfbllamg',
    tags: ['technology', 'research', 'analysis'],
  },
  {
    id: 'rec-languagetool',
    name: 'LanguageTool',
    category: 'productivity',
    description: '多语言拼写、语法和风格检查',
    store_id: 'oldceeleldhonbafppcapldpdifcinni',
    store_url: 'https://chromewebstore.google.com/detail/languagetool/oldceeleldhonbafppcapldpdifcinni',
    tags: ['writing', 'grammar', 'multilingual'],
  },
  {
    id: 'rec-google-translate',
    name: 'Google 翻译',
    category: 'productivity',
    description: '快速翻译网页和选中文本',
    store_id: 'aapbdbdomjkkjkaonfhkkikfgjllcleb',
    store_url: 'https://chromewebstore.google.com/detail/google-translate/aapbdbdomjkkjkaonfhkkikfgjllcleb',
    tags: ['translation', 'language'],
  },
  {
    id: 'rec-dark-reader',
    name: 'Dark Reader',
    category: 'appearance',
    description: '为网站提供可调节的深色模式，降低夜间阅读刺激',
    store_id: 'eimadpbcbfnmbkopoojfekhnkhdbieeh',
    store_url: 'https://chromewebstore.google.com/detail/dark-reader/eimadpbcbfnmbkopoojfekhnkhdbieeh',
    tags: ['dark-mode', 'accessibility'],
  },
  {
    id: 'rec-clearurls',
    name: 'ClearURLs',
    category: 'privacy',
    description: '自动清理链接中的跟踪参数，减少隐私泄漏',
    store_id: 'lckanjgmijmafbedllaakclkaicjfmnk',
    store_url: 'https://chromewebstore.google.com/detail/clearurls/lckanjgmijmafbedllaakclkaicjfmnk',
    tags: ['privacy', 'tracking', 'url'],
  },
  {
    id: 'rec-privacy-badger',
    name: 'Privacy Badger',
    category: 'privacy',
    description: '自动学习并拦截隐形第三方跟踪器',
    store_id: 'pkehgijcmpdhfbdbbnkijodmdjhbjlgp',
    store_url: 'https://chromewebstore.google.com/detail/privacy-badger/pkehgijcmpdhfbdbbnkijodmdjhbjlgp',
    tags: ['privacy', 'tracking'],
  },
  {
    id: 'rec-cookie-editor',
    name: 'Cookie-Editor',
    category: 'devtools',
    description: '查看、编辑、导入和导出网站 Cookie',
    store_id: 'hlkenndednhfkekhgcdicdfddnkalmdm',
    store_url: 'https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm',
    tags: ['cookie', 'devtools'],
  },
  {
    id: 'rec-tampermonkey',
    name: 'Tampermonkey',
    category: 'automation',
    description: '管理用户脚本，为重复网页操作提供自动化能力',
    store_id: 'dhdgffkkebhmkfjojejmpbldmpobfkfo',
    store_url: 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo',
    tags: ['userscript', 'automation'],
  },
  {
    id: 'rec-json-viewer',
    name: 'JSON Viewer',
    category: 'devtools',
    description: '格式化并高亮显示 JSON 接口响应',
    store_id: 'chklaanhfefbnpoihckbnefhakgolnmc',
    store_url: 'https://chromewebstore.google.com/detail/json-viewer/chklaanhfefbnpoihckbnefhakgolnmc',
    tags: ['json', 'api', 'devtools'],
  },
  {
    id: 'rec-google-keep',
    name: 'Google Keep',
    category: 'productivity',
    description: '快速保存网页内容、链接和工作备注',
    store_id: 'hmjkmjkepdijhoojdojkdjlhmmdmhnph',
    store_url: 'https://chromewebstore.google.com/detail/google-keep/hmjkmjkepdijhoojdojkdjlhmmdmhnph',
    tags: ['notes', 'productivity'],
  },
  {
    id: 'rec-foxyproxy',
    name: 'FoxyProxy',
    category: 'network',
    description: '按规则快速切换和管理多个代理配置',
    store_id: 'gcknhkkoolaabfmlnjonogaaifnjlfnp',
    store_url: 'https://chromewebstore.google.com/detail/foxyproxy/gcknhkkoolaabfmlnjonogaaifnjlfnp',
    tags: ['proxy', 'network'],
  },
  {
    id: 'rec-user-agent-switcher',
    name: 'User-Agent Switcher',
    category: 'privacy',
    description: '快速切换 User-Agent，用于兼容性和页面测试',
    store_id: 'djflhoibgkdhkhhcedjiklpkjnoahfmg',
    store_url: 'https://chromewebstore.google.com/detail/user-agent-switcher/djflhoibgkdhkhhcedjiklpkjnoahfmg',
    tags: ['user-agent', 'testing', 'privacy'],
  }
];

class AppCenter {
  constructor({ engine } = {}) {
    this.engine = engine;
  }

  recommended() {
    return RECOMMENDED_APPS.map((item) => ({ ...item }));
  }

  /**
   * Unified application list (/api/v1/application/list envelope data).
   * builtin = extensions bundled with OpenBrowser; local = all local; recommended = catalog.
   */
  list(filter = {}) {
    const installed = this.engine?.listExtensions?.() || [];
    const byStoreId = new Map();
    for (const ext of installed) {
      const storeId = String(ext.storeId || ext.chromeId || '').toLowerCase();
      if (storeId) byStoreId.set(storeId, ext);
      byStoreId.set(String(ext.id).toLowerCase(), ext);
    }

    const recommended = this.recommended().map((app) => {
      const hit = byStoreId.get(String(app.store_id).toLowerCase());
      return {
        ...app,
        source: 'recommended',
        installed: Boolean(hit),
        extension_id: hit?.id || null,
        icon_url: hit?.iconUrl || null,
        version: hit?.version || null,
        assigned_profiles: hit?.assignedProfiles || 0,
        status: hit ? (hit.enabledAll ? 'enabled' : 'installed') : 'available',
      };
    });

    const local = installed.filter(ext => !(ext.name === 'OpenBrowser 环境标记' && !ext.builtIn)).map((ext) => ({ id: ext.id, name: ext.name, description: ext.description || '', version: ext.version, category: ext.builtIn ? 'builtin' : (ext.source === 'chrome-store' ? 'store' : 'local'), source: ext.source || (ext.builtIn ? 'builtin' : 'local'), store_id: ext.storeId || ext.chromeId || null, store_url: ext.storeUrl || null, icon_url: ext.iconUrl || null, installed: true, extension_id: ext.id, assigned_profiles: ext.assignedProfiles || 0, enabled_all: Boolean(ext.enabledAll), status: ext.enabledAll ? 'enabled' : (Number(ext.assignedProfiles) > 0 ? 'partial' : 'disabled'), path: ext.path || null, manifest_version: ext.manifestVersion }));

    const builtin = local.filter((item) => item.source === 'builtin');

    const tab = String(filter.tab || filter.type || 'all').toLowerCase();
    let list;
    if (tab === 'recommended' || tab === 'rec') list = recommended;
    else if (tab === 'builtin') list = builtin;
    else if (tab === 'local') list = local;
    else list = { builtin, recommended, local };

    const q = String(filter.q || filter.keyword || '').trim().toLowerCase();
    if (q && Array.isArray(list)) {
      list = list.filter((item) => [item.name, item.description, item.category, ...(item.tags || [])].join(' ').toLowerCase().includes(q));
    }

    return {
      list,
      counts: {
        builtin: builtin.length,
        recommended: recommended.length,
        local: local.length,
        installed: local.length,
      },
    };
  }

  findRecommended(idOrStoreId) {
    const key = String(idOrStoreId || '').toLowerCase();
    return this.recommended().find((item) => item.id === key || item.store_id === key || item.store_id.toLowerCase() === key) || null;
  }
}

module.exports = { AppCenter, RECOMMENDED_APPS };
