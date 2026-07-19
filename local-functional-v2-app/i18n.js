/**
 * OpenBrowser UI i18n
 * - Default: follow system language (navigator)
 * - Supported: en, zh-CN, ja, vi, fr, de, th, id
 * - Browser profile language is separate (defaults to exit-IP country)
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'openbrowser-ui-locale-v1';
  const SUPPORTED = Object.freeze([
    { code: 'system', label: 'System / 系统语言' },
    { code: 'en', label: 'English' },
    { code: 'zh-CN', label: '中文（简体）' },
    { code: 'ja', label: '日本語' },
    { code: 'vi', label: 'Tiếng Việt' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch' },
    { code: 'th', label: 'ไทย' },
    { code: 'id', label: 'Bahasa Indonesia' },
  ]);

  const BROWSER_LOCALES = Object.freeze([
    { value: 'en-US', label: 'English (US)' },
    { value: 'en-GB', label: 'English (UK)' },
    { value: 'zh-CN', label: '中文（简体）' },
    { value: 'zh-TW', label: '中文（繁體）' },
    { value: 'ja-JP', label: '日本語' },
    { value: 'vi-VN', label: 'Tiếng Việt' },
    { value: 'fr-FR', label: 'Français' },
    { value: 'de-DE', label: 'Deutsch' },
    { value: 'th-TH', label: 'ไทย' },
    { value: 'id-ID', label: 'Bahasa Indonesia' },
    { value: 'ko-KR', label: '한국어' },
    { value: 'es-ES', label: 'Español' },
    { value: 'pt-BR', label: 'Português (BR)' },
    { value: 'ru-RU', label: 'Русский' },
    { value: 'ar-SA', label: 'العربية' },
  ]);

  // Base catalog is Chinese (current shipping UI). Other locales override.
  const zhCN = {
    'app.brand.sub': 'LOCAL WORKSPACE',
    'nav.newBrowser': '新建浏览器',
    'nav.profiles': '环境管理',
    'nav.groups': '分组管理',
    'nav.proxies': '代理管理',
    'nav.extensions': '应用中心',
    'nav.automation': '自动化',
    'nav.sync': '窗口同步',
    'nav.rpa': '自动脚本',
    'nav.rpa.flows': '流程管理',
    'nav.rpa.tasks': '任务管理',
    'nav.rpa.runs': '运行记录',
    'nav.rpa.store': '模板商店',
    'nav.rpa.guide': '说明文档',
    'nav.api': 'API & MCP',
    'nav.logs': '操作日志',
    'nav.system': '本地设置',
    'header.theme': '主题',
    'header.detecting': '检测中',
    'theme.title': '界面皮肤',
    'theme.pixel': '像素工作站',
    'theme.pixel.desc': 'Pxlkit + RetroUI 整套界面',
    'theme.retro': '复古桌面',
    'theme.retro.desc': '完整界面皮肤',
    'theme.native': '系统原生',
    'theme.native.desc': 'macOS HIG · Windows Fluent',
    'theme.appearance': '外观',
    'theme.light': '浅色',
    'theme.dark': '深色',
    'theme.pixel.name': '像素工作站',
    'theme.retro.name': '复古桌面',
    'theme.native.name': '系统原生',

    'view.profiles': '环境管理',
    'view.profiles.sub': '',
    'view.profile-editor': '编辑浏览器环境',
    'view.profile-editor.sub': '独立 Chrome 环境的网络、隐私和启动设置',
    'view.groups': '分组管理',
    'view.groups.sub': '创建 / 编辑 / 删除环境分组，批量归类',
    'view.proxies': '代理管理',
    'view.proxies.sub': '本地代理库：新建 / 编辑 / 删除 / 检测出口',
    'view.extensions': '应用中心',
    'view.extensions.sub': '自带 · 推荐商店应用 · 本机扩展',
    'view.sync': '窗口同步',
    'view.sync.sub': '窗口、文本和标签页的 CDP 批量管理',
    'view.rpa': '自动脚本',
    'view.rpa.sub': '流程 / 任务 / 运行记录 / 模板 · 纯本机执行',
    'view.api-mcp': 'API & MCP',
    'view.api-mcp.sub': '此接口为软件本体自带。OpenBrowser 启动时会在本机开一个 HTTP 接口，方便 Python / 脚本 / AI 启动环境、同步窗口。只监听本机（127.0.0.1），不连外网。',
    'view.logs': '操作日志',
    'view.logs.sub': '本地引擎执行记录',
    'view.system': '本地设置',
    'view.system.sub': '运行时与能力状态',

    'profiles.create': '新建环境',
    'profiles.batchAdd': '批量新增',
    'profiles.batchImport': '批量导入',
    'profiles.search': '搜索环境 / 分组 / 标签',
    'profiles.selected': '已选择 {n} 个环境',
    'profiles.startSelected': '启动选中',
    'profiles.stopSelected': '停止选中',
    'profiles.batchNetwork': '切换网络/IP',
    'profiles.direct': '本地直连',
    'profiles.moveGroup': '移到分组',
    'profiles.apply': '应用',
    'profiles.batchDelete': '批量删除',
    'profiles.col.num': '编号',
    'profiles.col.name': '环境名称',
    'profiles.col.group': '分组',
    'profiles.col.browser': '内核',
    'profiles.col.network': '网络',
    'profiles.col.exit': '出口',
    'profiles.col.ext': '扩展',
    'profiles.col.status': '状态',
    'profiles.col.actions': '操作',
    'profiles.empty': '暂无环境',
    'profiles.total': '总数：',
    'profiles.perPage': '{n}条/页',

    'groups.create': '新建分组',
    'groups.refresh': '刷新',
    'groups.count': '分组数：',
    'groups.col.color': '颜色',
    'groups.col.name': '分组名称',
    'groups.col.count': '环境数',
    'groups.col.created': '创建时间',
    'groups.col.actions': '操作',
    'groups.empty': '暂无分组，点击「新建分组」开始',
    'groups.default': '默认分组',
    'groups.unnamed': '未命名分组',
    'groups.ungrouped': '未分组',

    'common.cancel': '取消',
    'common.save': '保存',
    'common.confirm': '确认',
    'common.delete': '删除',
    'common.edit': '编辑',
    'common.start': '启动',
    'common.stop': '停止',
    'common.select': '请选择',
    'common.networkMode': '网络模式',
    'common.direct': '本地直连',
    'common.proxy': '代理模式',
    'common.language': '语言',
    'common.protocol': '协议',
    'common.name': '名称',
    'common.note': '备注',
    'common.actions': '操作',
    'common.loading': '正在读取...',
    'common.enabled': '已启用',
    'common.detecting': '检测中',

    'proxy.new': '新建代理',
    'proxy.edit': '编辑代理',
    'proxy.localOnly': '保存到本地代理库，不上传云端',
    'proxy.check': '检查代理',
    'proxy.checkBefore': '保存前可先检测',
    'proxy.raw': '整行粘贴（可选，优先解析）',
    'proxy.remark': '用途说明',

    'editor.back': '‹ 返回',
    'editor.title': '修改环境',
    'editor.subtitle': '平台账号 · 代理 · 指纹 · 偏好 — 前后端完整生效；可配合云备份跨设备恢复',
    'editor.tab.basic': '平台账号配置',
    'editor.tab.proxy': '代理配置',
    'editor.tab.privacy': '指纹配置',
    'editor.tab.advanced': '偏好设置',
    'editor.langMode': '浏览器语言',
    'editor.lang.ip': '基于出口 IP 所在地（如日本→日语）',
    'editor.lang.system': '系统真实',
    'editor.lang.hint': '选「基于出口 IP」时：日本 IP → ja-JP，美国 → en-US 等；启动前会检测出口国家。也可固定为中文/英文/日语等。',
    'editor.timezone': '时区',
    'editor.geo': '地理位置',
    'editor.basedOnIp': '基于出口 IP',
    'editor.systemReal': '系统真实',
    'editor.custom': '自定义',

    'dialog.newProfile': '新建浏览器环境',
    'dialog.profileName': '环境名称（自动编号）',
    'dialog.browser': '浏览器',
    'dialog.group': '所属分组',
    'dialog.directHint': '本地直连使用本机网络，不配置代理。',
    'dialog.batchAdd': '批量新增环境',
    'dialog.batchCreate': '立即批量创建',
    'dialog.batchDelete': '批量删除环境',
    'dialog.batchUpdate': '批量更新网络模式',
    'dialog.assignApp': '批量分配应用',

    'system.locale.title': '界面语言',
    'system.locale.desc': '软件界面多国语言。默认跟随系统语言；浏览器环境语言在「指纹配置」中单独设置（默认同出口 IP 国家）。',
    'system.locale.label': '界面语言',
    'system.locale.system': '跟随系统语言',
    'system.locale.current': '当前生效：{lang}',
    'system.running': '本地运行中',
    'system.controlDesc': '本机控制服务运行状态。',
    'system.cloud': '云同步（设置）',
    'system.kernel': '独立浏览器内核',
    'system.runtime': '运行时',
    'system.capabilities': '能力状态',
    'system.storage': '环境缓存与数据位置',
    'system.storage.current': '当前目录',
    'system.storage.choose': '选择新目录',
    'system.storage.open': '打开目录',
    'system.storage.reset': '恢复默认位置',
    'system.realBrowser': '真实浏览器进程',
    'system.userDir': '独立用户目录',
    'system.extLoad': '扩展批量加载',
    'system.cdp': 'Chrome DevTools Protocol',
    'system.runMode': '运行模式',
    'system.localOnly': '纯本地',
    'system.localApi': '本机接口',

    'status.running': '运行中',
    'status.stopped': '已停止',
    'status.starting': '启动中',
    'toast.created': '已创建',
    'toast.saved': '已保存',
    'toast.deleted': '已删除',
    'toast.startOk': '{n} 已启动',
    'toast.startFail': '启动失败：{msg}',
    'toast.stopFail': '停止失败：{msg}',

    'lang.mode.ip': '基于出口 IP 所在地',
    'lang.mode.system': '系统真实',
  };

  const en = {
    'app.brand.sub': 'LOCAL WORKSPACE',
    'nav.newBrowser': 'New browser',
    'nav.profiles': 'Profiles',
    'nav.groups': 'Groups',
    'nav.proxies': 'Proxies',
    'nav.extensions': 'App Center',
    'nav.automation': 'Automation',
    'nav.sync': 'Window Sync',
    'nav.rpa': 'Scripts',
    'nav.rpa.flows': 'Flows',
    'nav.rpa.tasks': 'Tasks',
    'nav.rpa.runs': 'Run history',
    'nav.rpa.store': 'Template store',
    'nav.rpa.guide': 'Docs',
    'nav.api': 'API & MCP',
    'nav.logs': 'Logs',
    'nav.system': 'Settings',
    'header.theme': 'Theme',
    'header.detecting': 'Checking…',
    'theme.title': 'UI skin',
    'theme.pixel': 'Pixel Workstation',
    'theme.pixel.desc': 'Full Pxlkit + RetroUI skin',
    'theme.retro': 'Retro Desktop',
    'theme.retro.desc': 'Full desktop skin',
    'theme.native': 'System Native',
    'theme.native.desc': 'macOS HIG · Windows Fluent',
    'theme.appearance': 'Appearance',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'theme.pixel.name': 'Pixel Workstation',
    'theme.retro.name': 'Retro Desktop',
    'theme.native.name': 'System Native',
    'view.profiles': 'Profiles',
    'view.profiles.sub': '',
    'view.profile-editor': 'Edit profile',
    'view.profile-editor.sub': 'Network, privacy and launch settings for an isolated Chrome profile',
    'view.groups': 'Groups',
    'view.groups.sub': 'Create, edit and delete profile groups',
    'view.proxies': 'Proxies',
    'view.proxies.sub': 'Local proxy library: create / edit / delete / check exit IP',
    'view.extensions': 'App Center',
    'view.extensions.sub': 'Built-in · store apps · local extensions',
    'view.sync': 'Window Sync',
    'view.sync.sub': 'CDP batch control for windows, text and tabs',
    'view.rpa': 'Scripts',
    'view.rpa.sub': 'Flows / tasks / history / templates · local only',
    'view.api-mcp': 'API & MCP',
    'view.api-mcp.sub': 'Built-in local HTTP API for scripts and AI. Listens on 127.0.0.1 only.',
    'view.logs': 'Logs',
    'view.logs.sub': 'Local engine activity',
    'view.system': 'Settings',
    'view.system.sub': 'Runtime and capabilities',
    'profiles.create': 'New profile',
    'profiles.batchAdd': 'Batch create',
    'profiles.batchImport': 'Import',
    'profiles.search': 'Search profiles / groups / tags',
    'profiles.selected': '{n} selected',
    'profiles.startSelected': 'Start selected',
    'profiles.stopSelected': 'Stop selected',
    'profiles.batchNetwork': 'Change network/IP',
    'profiles.direct': 'Direct',
    'profiles.moveGroup': 'Move to group',
    'profiles.apply': 'Apply',
    'profiles.batchDelete': 'Delete selected',
    'profiles.col.num': '#',
    'profiles.col.name': 'Name',
    'profiles.col.group': 'Group',
    'profiles.col.browser': 'Kernel',
    'profiles.col.network': 'Network',
    'profiles.col.exit': 'Exit IP',
    'profiles.col.ext': 'Ext',
    'profiles.col.status': 'Status',
    'profiles.col.actions': 'Actions',
    'profiles.empty': 'No profiles yet',
    'profiles.total': 'Total: ',
    'profiles.perPage': '{n}/page',
    'groups.create': 'New group',
    'groups.refresh': 'Refresh',
    'groups.count': 'Groups: ',
    'groups.col.color': 'Color',
    'groups.col.name': 'Name',
    'groups.col.count': 'Profiles',
    'groups.col.created': 'Created',
    'groups.col.actions': 'Actions',
    'groups.empty': 'No groups yet. Click “New group” to start.',
    'groups.default': 'Default group',
    'groups.unnamed': 'Untitled group',
    'groups.ungrouped': 'Ungrouped',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.confirm': 'Confirm',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    'common.start': 'Start',
    'common.stop': 'Stop',
    'common.select': 'Select',
    'common.networkMode': 'Network mode',
    'common.direct': 'Direct',
    'common.proxy': 'Proxy',
    'common.language': 'Language',
    'common.protocol': 'Protocol',
    'common.name': 'Name',
    'common.note': 'Note',
    'common.actions': 'Actions',
    'common.loading': 'Loading…',
    'common.enabled': 'Enabled',
    'common.detecting': 'Checking…',
    'proxy.new': 'New proxy',
    'proxy.edit': 'Edit proxy',
    'proxy.localOnly': 'Saved locally. Not uploaded to the cloud.',
    'proxy.check': 'Check proxy',
    'proxy.checkBefore': 'You can test before saving',
    'proxy.raw': 'Paste full line (optional, parsed first)',
    'proxy.remark': 'Usage note',
    'editor.back': '‹ Back',
    'editor.title': 'Edit profile',
    'editor.subtitle': 'Account · proxy · fingerprint · preferences — fully applied; cloud backup optional',
    'editor.tab.basic': 'Account',
    'editor.tab.proxy': 'Proxy',
    'editor.tab.privacy': 'Fingerprint',
    'editor.tab.advanced': 'Preferences',
    'editor.langMode': 'Browser language',
    'editor.lang.ip': 'Follow exit IP country (e.g. Japan → Japanese)',
    'editor.lang.system': 'System real',
    'editor.lang.hint': 'With “exit IP”: JP → ja-JP, US → en-US, etc. Exit country is checked before start. You can also pin a fixed locale.',
    'editor.timezone': 'Timezone',
    'editor.geo': 'Geolocation',
    'editor.basedOnIp': 'Based on exit IP',
    'editor.systemReal': 'System real',
    'editor.custom': 'Custom',
    'dialog.newProfile': 'New browser profile',
    'dialog.profileName': 'Profile name (auto number)',
    'dialog.browser': 'Browser',
    'dialog.group': 'Group',
    'dialog.directHint': 'Direct uses the host network with no proxy.',
    'dialog.batchAdd': 'Batch create profiles',
    'dialog.batchCreate': 'Create now',
    'dialog.batchDelete': 'Batch delete profiles',
    'dialog.batchUpdate': 'Batch update network',
    'dialog.assignApp': 'Assign apps in batch',
    'system.locale.title': 'Interface language',
    'system.locale.desc': 'App UI languages. Default follows system language. Browser profile language is set under Fingerprint (defaults to exit-IP country).',
    'system.locale.label': 'UI language',
    'system.locale.system': 'Follow system language',
    'system.locale.current': 'Active: {lang}',
    'system.running': 'Running locally',
    'system.controlDesc': 'Local control service status.',
    'system.cloud': 'Cloud sync',
    'system.kernel': 'Independent browser kernel',
    'system.runtime': 'Runtime',
    'system.capabilities': 'Capabilities',
    'system.storage': 'Profile data location',
    'system.storage.current': 'Current path',
    'system.storage.choose': 'Choose folder',
    'system.storage.open': 'Open folder',
    'system.storage.reset': 'Reset to default',
    'system.realBrowser': 'Real browser process',
    'system.userDir': 'Isolated user data',
    'system.extLoad': 'Batch extension load',
    'system.cdp': 'Chrome DevTools Protocol',
    'system.runMode': 'Run mode',
    'system.localOnly': 'Local only',
    'system.localApi': 'Local API',
    'status.running': 'Running',
    'status.stopped': 'Stopped',
    'status.starting': 'Starting',
    'toast.created': 'Created',
    'toast.saved': 'Saved',
    'toast.deleted': 'Deleted',
    'toast.startOk': '{n} started',
    'toast.startFail': 'Start failed: {msg}',
    'toast.stopFail': 'Stop failed: {msg}',
    'lang.mode.ip': 'Based on exit IP country',
    'lang.mode.system': 'System real',
  };

  const ja = {
    ...en,
    'nav.newBrowser': '新規ブラウザ',
    'nav.profiles': '環境管理',
    'nav.groups': 'グループ',
    'nav.proxies': 'プロキシ',
    'nav.extensions': 'アプリセンター',
    'nav.automation': '自動化',
    'nav.sync': 'ウィンドウ同期',
    'nav.rpa': '自動スクリプト',
    'nav.rpa.flows': 'フロー',
    'nav.rpa.tasks': 'タスク',
    'nav.rpa.runs': '実行履歴',
    'nav.rpa.store': 'テンプレート',
    'nav.rpa.guide': 'ドキュメント',
    'nav.logs': '操作ログ',
    'nav.system': 'ローカル設定',
    'header.theme': 'テーマ',
    'header.detecting': '検出中…',
    'theme.title': 'UI スキン',
    'theme.pixel': 'ピクセルワークステーション',
    'theme.retro': 'レトロデスクトップ',
    'theme.native': 'システム標準',
    'theme.appearance': '外観',
    'theme.light': 'ライト',
    'theme.dark': 'ダーク',
    'theme.pixel.name': 'ピクセルワークステーション',
    'theme.retro.name': 'レトロデスクトップ',
    'theme.native.name': 'システム標準',
    'view.profiles': '環境管理',
    'view.groups': 'グループ',
    'view.proxies': 'プロキシ',
    'view.extensions': 'アプリセンター',
    'view.sync': 'ウィンドウ同期',
    'view.rpa': '自動スクリプト',
    'view.logs': '操作ログ',
    'view.system': 'ローカル設定',
    'profiles.create': '新規環境',
    'profiles.batchAdd': '一括追加',
    'profiles.batchImport': '一括インポート',
    'profiles.search': '環境 / グループ / タグを検索',
    'profiles.selected': '{n} 件選択中',
    'profiles.startSelected': '選択を起動',
    'profiles.stopSelected': '選択を停止',
    'profiles.batchDelete': '一括削除',
    'profiles.col.name': '環境名',
    'profiles.col.group': 'グループ',
    'profiles.col.network': 'ネットワーク',
    'profiles.col.status': '状態',
    'profiles.col.actions': '操作',
    'profiles.empty': '環境がありません',
    'profiles.total': '合計：',
    'groups.create': '新規グループ',
    'groups.refresh': '更新',
    'groups.default': 'デフォルト',
    'groups.ungrouped': '未分類',
    'common.cancel': 'キャンセル',
    'common.save': '保存',
    'common.delete': '削除',
    'common.edit': '編集',
    'common.start': '起動',
    'common.stop': '停止',
    'common.select': '選択してください',
    'common.direct': 'ダイレクト',
    'common.proxy': 'プロキシ',
    'common.language': '言語',
    'editor.langMode': 'ブラウザ言語',
    'editor.lang.ip': '出口 IP の国に合わせる（例：日本→日本語）',
    'editor.lang.system': 'システム実言語',
    'system.locale.title': 'UI 言語',
    'system.locale.desc': 'アプリ UI の多言語対応。既定はシステム言語。ブラウザ環境言語は指紋設定で個別指定（既定は出口 IP 国）。',
    'system.locale.label': 'UI 言語',
    'system.locale.system': 'システム言語に従う',
    'system.locale.current': '現在：{lang}',
    'system.running': 'ローカル稼働中',
    'status.running': '実行中',
    'status.stopped': '停止',
  };

  const vi = {
    ...en,
    'nav.newBrowser': 'Trình duyệt mới',
    'nav.profiles': 'Quản lý môi trường',
    'nav.groups': 'Nhóm',
    'nav.proxies': 'Proxy',
    'nav.extensions': 'Trung tâm ứng dụng',
    'nav.automation': 'Tự động hóa',
    'nav.sync': 'Đồng bộ cửa sổ',
    'nav.rpa': 'Kịch bản',
    'nav.logs': 'Nhật ký',
    'nav.system': 'Cài đặt',
    'header.theme': 'Giao diện',
    'view.profiles': 'Quản lý môi trường',
    'view.system': 'Cài đặt',
    'profiles.create': 'Môi trường mới',
    'profiles.batchAdd': 'Tạo hàng loạt',
    'profiles.search': 'Tìm môi trường / nhóm / thẻ',
    'profiles.selected': 'Đã chọn {n}',
    'profiles.empty': 'Chưa có môi trường',
    'common.cancel': 'Hủy',
    'common.save': 'Lưu',
    'common.delete': 'Xóa',
    'common.start': 'Chạy',
    'common.stop': 'Dừng',
    'common.select': 'Chọn',
    'common.direct': 'Kết nối trực tiếp',
    'common.proxy': 'Proxy',
    'common.language': 'Ngôn ngữ',
    'editor.langMode': 'Ngôn ngữ trình duyệt',
    'editor.lang.ip': 'Theo quốc gia IP thoát (vd. Nhật → tiếng Nhật)',
    'editor.lang.system': 'Ngôn ngữ hệ thống thật',
    'system.locale.title': 'Ngôn ngữ giao diện',
    'system.locale.desc': 'Đa ngôn ngữ cho UI. Mặc định theo hệ thống. Ngôn ngữ môi trường trình duyệt đặt riêng (mặc định theo IP).',
    'system.locale.label': 'Ngôn ngữ UI',
    'system.locale.system': 'Theo ngôn ngữ hệ thống',
    'system.locale.current': 'Đang dùng: {lang}',
    'status.running': 'Đang chạy',
    'status.stopped': 'Đã dừng',
  };

  const fr = {
    ...en,
    'nav.newBrowser': 'Nouveau navigateur',
    'nav.profiles': 'Profils',
    'nav.groups': 'Groupes',
    'nav.proxies': 'Proxys',
    'nav.extensions': 'Centre d’apps',
    'nav.automation': 'Automatisation',
    'nav.sync': 'Sync fenêtres',
    'nav.rpa': 'Scripts',
    'nav.logs': 'Journaux',
    'nav.system': 'Paramètres',
    'header.theme': 'Thème',
    'view.profiles': 'Profils',
    'view.system': 'Paramètres',
    'profiles.create': 'Nouveau profil',
    'profiles.batchAdd': 'Création en lot',
    'profiles.search': 'Rechercher profils / groupes / tags',
    'profiles.selected': '{n} sélectionné(s)',
    'profiles.empty': 'Aucun profil',
    'common.cancel': 'Annuler',
    'common.save': 'Enregistrer',
    'common.delete': 'Supprimer',
    'common.start': 'Démarrer',
    'common.stop': 'Arrêter',
    'common.select': 'Choisir',
    'common.direct': 'Connexion directe',
    'common.proxy': 'Proxy',
    'common.language': 'Langue',
    'editor.langMode': 'Langue du navigateur',
    'editor.lang.ip': 'Selon le pays de l’IP de sortie',
    'editor.lang.system': 'Système réel',
    'system.locale.title': 'Langue de l’interface',
    'system.locale.desc': 'UI multilingue. Par défaut : langue système. Langue du profil navigateur dans Empreinte (par défaut : pays de l’IP).',
    'system.locale.label': 'Langue UI',
    'system.locale.system': 'Suivre la langue système',
    'system.locale.current': 'Actif : {lang}',
    'status.running': 'En cours',
    'status.stopped': 'Arrêté',
  };

  const de = {
    ...en,
    'nav.newBrowser': 'Neuer Browser',
    'nav.profiles': 'Profile',
    'nav.groups': 'Gruppen',
    'nav.proxies': 'Proxys',
    'nav.extensions': 'App-Center',
    'nav.automation': 'Automatisierung',
    'nav.sync': 'Fenstersync',
    'nav.rpa': 'Skripte',
    'nav.logs': 'Protokolle',
    'nav.system': 'Einstellungen',
    'header.theme': 'Design',
    'view.profiles': 'Profile',
    'view.system': 'Einstellungen',
    'profiles.create': 'Neues Profil',
    'profiles.batchAdd': 'Stapel erstellen',
    'profiles.search': 'Profile / Gruppen / Tags suchen',
    'profiles.selected': '{n} ausgewählt',
    'profiles.empty': 'Keine Profile',
    'common.cancel': 'Abbrechen',
    'common.save': 'Speichern',
    'common.delete': 'Löschen',
    'common.start': 'Starten',
    'common.stop': 'Stoppen',
    'common.select': 'Auswählen',
    'common.direct': 'Direkt',
    'common.proxy': 'Proxy',
    'common.language': 'Sprache',
    'editor.langMode': 'Browsersprache',
    'editor.lang.ip': 'Nach Exit-IP-Land',
    'editor.lang.system': 'System echt',
    'system.locale.title': 'Oberflächensprache',
    'system.locale.desc': 'Mehrsprachige UI. Standard: Systemsprache. Browserprofil-Sprache unter Fingerprint (Standard: Exit-IP-Land).',
    'system.locale.label': 'UI-Sprache',
    'system.locale.system': 'Systemsprache folgen',
    'system.locale.current': 'Aktiv: {lang}',
    'status.running': 'Läuft',
    'status.stopped': 'Gestoppt',
  };

  const th = {
    ...en,
    'nav.newBrowser': 'เบราว์เซอร์ใหม่',
    'nav.profiles': 'จัดการโปรไฟล์',
    'nav.groups': 'กลุ่ม',
    'nav.proxies': 'พร็อกซี',
    'nav.extensions': 'ศูนย์แอป',
    'nav.automation': 'อัตโนมัติ',
    'nav.sync': 'ซิงก์หน้าต่าง',
    'nav.rpa': 'สคริปต์',
    'nav.logs': 'บันทึก',
    'nav.system': 'ตั้งค่า',
    'header.theme': 'ธีม',
    'view.profiles': 'จัดการโปรไฟล์',
    'view.system': 'ตั้งค่า',
    'profiles.create': 'โปรไฟล์ใหม่',
    'profiles.batchAdd': 'สร้างจำนวนมาก',
    'profiles.search': 'ค้นหาโปรไฟล์ / กลุ่ม / แท็ก',
    'profiles.selected': 'เลือกแล้ว {n}',
    'profiles.empty': 'ยังไม่มีโปรไฟล์',
    'common.cancel': 'ยกเลิก',
    'common.save': 'บันทึก',
    'common.delete': 'ลบ',
    'common.start': 'เริ่ม',
    'common.stop': 'หยุด',
    'common.select': 'เลือก',
    'common.direct': 'เชื่อมตรง',
    'common.proxy': 'พร็อกซี',
    'common.language': 'ภาษา',
    'editor.langMode': 'ภาษาเบราว์เซอร์',
    'editor.lang.ip': 'ตามประเทศของ IP ทางออก',
    'editor.lang.system': 'ภาษาจริงของระบบ',
    'system.locale.title': 'ภาษาอินเทอร์เฟซ',
    'system.locale.desc': 'รองรับหลายภาษา ค่าเริ่มต้นตามระบบ ภาษาของโปรไฟล์เบราว์เซอร์ตั้งแยก (ค่าเริ่มต้นตาม IP)',
    'system.locale.label': 'ภาษา UI',
    'system.locale.system': 'ตามภาษาของระบบ',
    'system.locale.current': 'ใช้งาน: {lang}',
    'status.running': 'กำลังทำงาน',
    'status.stopped': 'หยุดแล้ว',
  };

  const id = {
    ...en,
    'nav.newBrowser': 'Browser baru',
    'nav.profiles': 'Kelola profil',
    'nav.groups': 'Grup',
    'nav.proxies': 'Proksi',
    'nav.extensions': 'Pusat aplikasi',
    'nav.automation': 'Otomasi',
    'nav.sync': 'Sinkron jendela',
    'nav.rpa': 'Skrip',
    'nav.logs': 'Log',
    'nav.system': 'Pengaturan',
    'header.theme': 'Tema',
    'view.profiles': 'Kelola profil',
    'view.system': 'Pengaturan',
    'profiles.create': 'Profil baru',
    'profiles.batchAdd': 'Buat massal',
    'profiles.search': 'Cari profil / grup / tag',
    'profiles.selected': '{n} dipilih',
    'profiles.empty': 'Belum ada profil',
    'common.cancel': 'Batal',
    'common.save': 'Simpan',
    'common.delete': 'Hapus',
    'common.start': 'Mulai',
    'common.stop': 'Berhenti',
    'common.select': 'Pilih',
    'common.direct': 'Langsung',
    'common.proxy': 'Proksi',
    'common.language': 'Bahasa',
    'editor.langMode': 'Bahasa browser',
    'editor.lang.ip': 'Ikuti negara IP keluar',
    'editor.lang.system': 'Sistem nyata',
    'system.locale.title': 'Bahasa antarmuka',
    'system.locale.desc': 'UI multibahasa. Default mengikuti sistem. Bahasa profil browser diatur terpisah (default negara IP).',
    'system.locale.label': 'Bahasa UI',
    'system.locale.system': 'Ikuti bahasa sistem',
    'system.locale.current': 'Aktif: {lang}',
    'status.running': 'Berjalan',
    'status.stopped': 'Berhenti',
  };

  const CATALOGS = Object.freeze({
    'zh-CN': zhCN,
    en,
    ja,
    vi,
    fr,
    de,
    th,
    id,
  });

  const listeners = new Set();
  let preference = 'system'; // stored preference
  let resolved = 'zh-CN';

  function normalizeTag(tag) {
    const raw = String(tag || '').trim().replace(/_/g, '-');
    if (!raw) return 'en';
    const lower = raw.toLowerCase();
    if (lower === 'zh' || lower.startsWith('zh-cn') || lower.startsWith('zh-hans')) return 'zh-CN';
    if (lower.startsWith('zh-tw') || lower.startsWith('zh-hk') || lower.startsWith('zh-hant')) return 'zh-CN';
    const primary = lower.split('-')[0];
    if (primary === 'en') return 'en';
    if (primary === 'ja') return 'ja';
    if (primary === 'vi') return 'vi';
    if (primary === 'fr') return 'fr';
    if (primary === 'de') return 'de';
    if (primary === 'th') return 'th';
    if (primary === 'id') return 'id';
    return 'en';
  }

  function detectSystemLocale() {
    try {
      const list = navigator.languages?.length ? [...navigator.languages] : [navigator.language];
      for (const item of list) {
        const code = normalizeTag(item);
        if (CATALOGS[code]) return code;
      }
    } catch (_) {}
    return 'en';
  }

  function readPreference() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved || saved === 'system') return 'system';
      if (CATALOGS[saved] || saved === 'zh-CN') return saved;
      const norm = normalizeTag(saved);
      if (CATALOGS[norm]) return norm;
    } catch (_) {}
    return 'system';
  }

  function resolve(pref) {
    if (!pref || pref === 'system') return detectSystemLocale();
    return CATALOGS[pref] ? pref : detectSystemLocale();
  }

  function format(template, params) {
    if (!params) return template;
    return String(template).replace(/\{(\w+)\}/g, (_, key) => (
      params[key] == null ? `{${key}}` : String(params[key])
    ));
  }

  function t(key, params) {
    const catalog = CATALOGS[resolved] || zhCN;
    const text = catalog[key] ?? zhCN[key] ?? en[key] ?? key;
    return format(text, params);
  }

  function applyNode(el) {
    if (!(el instanceof Element)) return;
    const key = el.getAttribute('data-i18n');
    if (key) {
      const mode = el.getAttribute('data-i18n-mode') || 'text';
      const value = t(key);
      if (mode === 'html') el.innerHTML = value;
      else el.textContent = value;
    }
    const ph = el.getAttribute('data-i18n-placeholder');
    if (ph) el.setAttribute('placeholder', t(ph));
    const title = el.getAttribute('data-i18n-title');
    if (title) el.setAttribute('title', t(title));
    const aria = el.getAttribute('data-i18n-aria');
    if (aria) el.setAttribute('aria-label', t(aria));
  }

  function applyDom(root) {
    const doc = typeof document !== 'undefined' ? document : null;
    const scope = root || doc;
    if (!scope?.querySelectorAll) return;
    scope.querySelectorAll('[data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria]').forEach(applyNode);
    if (doc?.documentElement) {
      doc.documentElement.lang = resolved === 'zh-CN' ? 'zh-CN' : resolved;
    }
  }

  function setPreference(pref, { persist = true, silent = false } = {}) {
    const next = !pref || pref === 'system' ? 'system' : (CATALOGS[pref] ? pref : normalizeTag(pref));
    preference = next === 'system' || CATALOGS[next] ? next : 'system';
    resolved = resolve(preference);
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, preference); } catch (_) {}
    }
    applyDom();
    if (!silent) listeners.forEach((fn) => { try { fn(resolved, preference); } catch (_) {} });
    return resolved;
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function fillLocaleSelect(select) {
    if (!(select instanceof HTMLSelectElement)) return;
    const current = preference;
    select.replaceChildren();
    for (const item of SUPPORTED) {
      const opt = document.createElement('option');
      opt.value = item.code;
      opt.textContent = item.code === 'system' ? t('system.locale.system') : item.label;
      select.append(opt);
    }
    select.value = current;
  }

  function fillBrowserLanguageSelect(select, { includeModes = false } = {}) {
    if (!(select instanceof HTMLSelectElement)) return;
    const prev = select.value;
    select.replaceChildren();
    if (includeModes) {
      const ip = document.createElement('option');
      ip.value = 'ip';
      ip.textContent = t('editor.lang.ip');
      const sys = document.createElement('option');
      sys.value = 'system';
      sys.textContent = t('editor.lang.system');
      select.append(ip, sys);
    }
    for (const item of BROWSER_LOCALES) {
      const opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      select.append(opt);
    }
    if ([...select.options].some((o) => o.value === prev)) select.value = prev;
    else if (includeModes) select.value = 'ip';
  }

  // boot
  preference = readPreference();
  resolved = resolve(preference);

  const api = {
    STORAGE_KEY,
    SUPPORTED,
    BROWSER_LOCALES,
    t,
    detectSystemLocale,
    getPreference: () => preference,
    getLocale: () => resolved,
    setPreference,
    setLocale: setPreference,
    applyDom,
    onChange,
    fillLocaleSelect,
    fillBrowserLanguageSelect,
    normalizeTag,
  };

  global.OpenBrowserI18n = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
