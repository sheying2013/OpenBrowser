# OpenBrowser 代码概要

本文档是 OpenBrowser 当前代码的维护者概要，说明项目的运行模型、目录职责、主要数据流、持久化位置、浏览器隔离边界、自动化接口和验证方式。具体行为仍应以实现和自测结果为准。

## 1. 项目定位

OpenBrowser 是一个本地桌面浏览器环境管理器，基于桌面壳（npm 别名 `desktop-shell`）启动和管理多个独立的 Chromium 环境。每个环境拥有独立的浏览器用户数据目录，可配置代理、语言、平台参数、指纹参数、启动页、扩展和窗口尺寸，并通过 CDP 实现页面控制、标签页同步、窗口同步和 RPA 自动化。

项目不依赖远程业务服务器才能运行。应用管理数据、浏览器环境数据、扩展文件、RPA 数据和代理库默认写入本机 `userData` 目录；本地 API 只监听回环地址。云同步和应用商店等功能只有在用户主动配置或操作时才访问对应的第三方服务。

当前 package 版本为 `1.0.0`，产品名为 `OpenBrowser`。应用源码位于仓库中的 `Browserapp/`。

## 2. 启动和运行模型

### 2.1 启动链路

```text
npm start / scripts/run-app.js
  -> scripts/brand-host-dev.js（macOS 开发：OpenBrowser.app 品牌化）
  -> desktop-shell 主机进程启动 main.js
  -> app.whenReady()
  -> 设置 OpenBrowser userData 路径并迁移旧数据
  -> 读取本地设置
  -> 创建 BrowserEngine
  -> 初始化独立浏览器内核管理器和内置扩展
  -> 启动本地开始页服务器
  -> 创建 LiveSyncController
  -> 启动 Local API、RPA、窗口同步、应用中心和代理库
  -> 注册 IPC handlers 和全局快捷键
  -> 创建 BrowserWindow 并加载 index.html
```

主入口是 [`main.js`](./main.js)。开发启动走 [`scripts/run-app.js`](./scripts/run-app.js)（先品牌化主机包再启动）。窗口默认尺寸为 `1280x860`，最小尺寸为 `960x680`（可横向缩窄，字号有可读下限）。窗口启用 `contextIsolation`、关闭 renderer 的 Node 集成并使用 preload 暴露能力；页面不能直接访问 Node.js 文件系统或主机 API。

### 2.2 进程和边界

| 层 | 主要文件 | 职责 |
| --- | --- | --- |
| 桌面主进程 | `main.js` | 创建窗口、注册 IPC、管理生命周期、快捷键、云同步和系统对话框；`host-bridge.js` 解析主机 API 模块 |
| 浏览器业务层 | `engine.js` | 环境配置、启动/停止 Chromium、CDP、代理、指纹、扩展、Profile 生命周期、关窗自动停环境 |
| 预加载层 | `preload.js` | 将白名单 IPC 方法以 `window.ops` 形式提供给渲染器 |
| 渲染器 | `index.html`、`renderer.js` | 页面结构、视图切换、表单、列表、交互状态和事件渲染 |
| 样式层 | `styles.css`、`themes.css`、`environment-audit.css`、`ui-shell.css`、`element-admin.css`、`pixel-workstation.css` | 基础 UI、主题、紧凑桌面布局、窄窗可读缩放和主题覆盖 |
| 自动化层 | `automation/` | Local API、RPA、窗口同步桥、应用中心、代理库、云同步、内核和隔离工具 |
| 浏览器协议层 | `cdp.js`、`live-sync*.js`、`extension-pipe*.js` | Chrome DevTools Protocol、跨环境同步、扩展通信和页面事件转发 |

### 2.3 开发主机品牌（macOS）

开发时 npm 包目录下的主机包会被 [`scripts/brand-host-dev.js`](./scripts/brand-host-dev.js) 改写为 `OpenBrowser.app`（Info.plist 显示名 / 可执行文件 / 图标），避免 Dock 显示通用主机名。`path.txt` 同步指向 `OpenBrowser.app/Contents/MacOS/OpenBrowser`。`npm install` 后若主机包被还原，下次 `npm start` 会再次品牌化。

## 3. 目录和文件职责

### 3.1 应用根目录

```text
Browserapp/
├── main.js                 Electron 主进程和所有 IPC 入口
├── preload.js              renderer 可用能力的白名单桥接
├── renderer.js             单页 UI 状态、视图和交互逻辑
├── index.html              应用页面结构和各业务视图容器
├── engine.js               BrowserEngine，环境运行时核心
├── cdp.js                  CDP HTTP/WebSocket 封装
├── proxy-forwarder.js      代理解析、认证转发和出口检测
├── store-extension.js      Chrome Web Store 扩展下载和安装
├── live-sync.js            早期同步实现/兼容代码
├── live-sync-v4.js         V4 同步实现
├── live-sync-v5.js         当前窗口同步控制器
├── extension-pipe.js       环境标记扩展和扩展管道通信
├── host-bridge.js          桌面主机 API 模块桥接（避免在业务源码中写死包名）
├── automation/             自动化和本地服务模块
├── scripts/                启动、主机品牌化、内核解析和打包脚本
│   ├── run-app.js          开发启动入口
│   ├── brand-host-dev.js   macOS 开发主机 OpenBrowser 品牌化
│   ├── resolve-host-dist.js  定位 desktop-shell dist
│   └── package-portable.js 便携包 / macOS .app 打包
├── bundled-extension/      随应用加载的内置环境标记扩展
├── assets/                 应用图标（logo.png / logo.icns / logo.ico）、主题资源
└── *-selftest.js           单元、自测和 UI/功能验证脚本
```

与应用目录同级的 `../functional-selftest-data/` 存放本地测试使用的独立内核和 Profile 数据。`output/`、测试截图和自测临时产物属于验证输出，不是运行时业务模块。浏览器内核和 Profile 数据不应提交到源码仓库。

### 3.2 自动化目录

| 文件或目录 | 作用 |
| --- | --- |
| `automation/index.js` | 组装并启动自动化栈，返回各服务实例 |
| `automation/local-api-server.js` | `127.0.0.1` HTTP API 路由和 JSON 响应 |
| `automation/rpa-engine.js` | 基于 CDP 执行 RPA 步骤、变量、循环、截图和文件操作 |
| `automation/rpa-store.js` | RPA 计划、任务、自定义模板和配置的 JSON 存储 |
| `automation/rpa-templates-builtin.js` | 内置 RPA 模板目录 |
| `automation/window-sync-bridge.js` | 将 UI/API 请求转成窗口同步控制器调用 |
| `automation/app-center.js` | 内置、推荐和本地应用/扩展目录 |
| `automation/proxy-store.js` | 代理库的增删改查、过滤和检查结果存储 |
| `automation/fingerprint.js` | 指纹配置生成、注入脚本和 Chrome 启动参数 |
| `automation/user-agent.js` | User-Agent、Client Hints 和平台语言构造 |
| `automation/isolation.js` | Profile 路径、锁文件、数据根和系统浏览器隔离校验 |
| `automation/browser-kernel.js` | 独立 Chromium/Chrome for Testing 内核下载、选择和更新 |
| `automation/start-page-server.js` | 本地开始页 HTTP 服务和网络状态展示 |
| `automation/cloud-sync.js` | 加密备份包、合并恢复；本地 / WebDAV / GitHub / 谷歌云 / 微软云 / 夸克云 / 百度云（后四者为 WebDAV 桥） |
| `automation/ads-template-sync.js` | 可选的远程 RPA 模板同步适配 |
| `automation/protocol/` | 跨平台能力、窗口同步协议、事件映射、RPA 注册表和应用中心协议 |

## 4. 浏览器环境生命周期

### 4.1 环境数据

renderer 将环境配置保存在当前主窗口会话的 `localStorage` 键 `openbrowser-ui-state`，并通过 `profiles:sync` 将标准化后的环境列表同步到 `BrowserEngine` 的内存状态。`BrowserEngine` 不把完整环境列表写入 `openbrowser-engine.json`。

浏览器运行数据放在主进程本地设置所配置的数据根下：

```text
{profileDataRoot}/
├── {profile-id}/       一个环境的 Chrome --user-data-dir
├── {profile-id}/...
└── ...
```

环境 ID 会被限制为字母、数字、下划线和短横线。每个环境启动前会检查数据目录、获取 `.openbrowser-instance.lock`，启动后等待独立 CDP 端口，并在关闭时释放锁和执行数据保留处理。

环境配置主要包含：

- 基本信息：名称、编号、标签、分组、窗口大小、启动页。
- 浏览器和系统模拟：固定使用 Chrome 语义，配置平台和 User-Agent。
- 网络：直连或代理、代理协议、出口 IP/国家和语言时区。
- 指纹：硬件并发数、设备内存、Canvas、WebGL、WebRTC 等参数。
- 扩展：分配给该环境的扩展 ID 列表。
- 云同步：是否备份该环境、是否在关闭时同步 Cookie。
- 高级设置：启动参数、数据保留和独立内核策略。

### 4.2 启动流程

`BrowserEngine.start()` 的核心顺序如下：

1. 校验并标准化环境配置。
2. 确认数据根为当前环境专属目录，并获取实例锁。
3. 选择独立浏览器内核，默认不允许回退到本机安装的 Chrome/Edge。
4. 解析代理；认证代理通过本地转发器提供给浏览器。
5. 生成指纹和 User-Agent 启动参数。
6. 加载已分配的扩展和内置环境标记扩展。
7. 启动 Chrome，等待 DevTools 端口可用。
8. 通过 CDP 应用运行时设置、标签、语言、网络和指纹注入。
9. 建立扩展通信管道并更新 renderer 状态。

停止时优先通过 CDP `Browser.close` 优雅关闭；超时后只对匹配的 PID、可执行文件和 `user-data-dir` 执行强制进程树终止，随后关闭代理转发器、释放 Profile 锁并发出状态事件。

### 4.3 用户点 X 关窗与环境自动停止

Chromium 在用户关闭最后一个窗口后，主进程或 Helper 有时仍存活，仅监听 `child.exit` 不足以同步 UI。`BrowserEngine.start()` 成功后会调用 `startRunningWatch(item)`，约每 1.2s 轮询：

1. **进程是否存活**（`process.kill(pid, 0)`）。
2. **CDP 是否可用**（`GET http://127.0.0.1:{port}/json/version`）。
3. **是否还有 page 标签**（`cdp.tabs(port)`）。

规则：

| 检测结果 | 行为 |
| --- | --- |
| PID 已退出 | 立即 `handleBrowserGone` → `running: false` |
| CDP 连续失败 ≥2 次 | 同上，清理锁与代理转发 |
| 页面数为 0 连续 ≥2 次 | 视为用户已 X 掉全部窗口 → 调用 `stop(id)`（含 Browser.close / 杀进程树） |

`stop()` 会清除 watch 定时器并设 `item.stopping`，避免与 exit 回调重复清理。渲染器在收到 `status.running === false` 时 `refreshStatus()` / `refreshSessions()`，列表状态与窗口同步会话自动对齐，无需再点「停止」。

相关实现：`engine.js` 中 `startRunningWatch`、`handleBrowserGone`、`clearRunningWatch`、`start` 末尾启动 watch、`stop` 开头清理 watch。

### 4.4 内核隔离原则

独立内核由 `automation/browser-kernel.js` 管理，默认存放在应用 `userData/kernels` 下。`automation/isolation.js` 会拒绝以下情况：

- Profile 数据目录不符合 `{profileDataRoot}/{profileId}` 结构（Windows 路径大小写归一）。
- 数据根落入系统浏览器的用户数据目录（Windows 上 Chrome/Edge 等以 **LOCALAPPDATA** 为准，而非 Roaming）。
- 选择的可执行文件被识别为本机安装的系统浏览器。
- 同一个环境已经被其他 OpenBrowser 实例锁定。

启动参数使用随机本机 CDP 端口，且 `--remote-allow-origins` 限制为 loopback。指纹通过 CDP 注入到已有标签，并在 `startRunningWatch` 中对**新开标签**补注入，避免同环境内 tab 指纹不一致。

这层隔离是浏览器数据隔离的基础；指纹脚本本身不能替代独立用户目录和独立内核。相关回归测试位于 `automation/isolation-fingerprint-selftest.js` 和 `automation/kernel-policy-selftest.js`。完整审核见仓库 `docs/2026-07-19_code-review-isolation-security.md`。

## 5. 前端结构和主题系统

### 5.1 视图

`index.html` 是单页面壳，主导航通过 `data-view` 切换视图。当前主要视图包括：

| 视图 | 主要职责 |
| --- | --- |
| `profiles` | 环境列表、批量启动/停止、状态、网络和扩展数量；列表标识为彩色环境编号方标，不用 Chrome 品牌图标 |
| `groups` | 环境分组、颜色方标和批量归组 |
| `proxies` | 代理库、协议方标、创建编辑、批量检查和分配 |
| `extensions` | 内置/推荐/本地应用；推荐应用图标从 Chrome Web Store 拉取缓存 |
| `sync` | 窗口同步、同步选项、文本输入、标签和窗口操作 |
| `rpa` | 流程、任务、运行记录、模板商店和模板编辑 |
| `rpa-guide` | 自动脚本说明文档 |
| `api-mcp` | Local API 和 MCP 连接信息 |
| `logs` | 操作日志和运行事件 |
| `system` | 本地设置、Profile 存储、内核和云同步（含网盘一键配置） |
| `profile-editor` | 单独环境的指纹、代理、UA、启动和云同步配置 |

`renderer.js` 负责从 `window.ops` 读取数据、维护 UI 状态、渲染列表和处理表单；不应在 renderer 中直接调用 Node 文件系统、子进程或网络敏感能力。

### 5.2 列表方标（env-badge / ui-mark）

环境、内核列、分组、代理和应用中心共用「彩色圆角方标」语言：

| 函数 / 类 | 用途 |
| --- | --- |
| `buildEnvBadge(profile)` | 环境编号彩色方标 |
| `buildEnvIdentity(profile)` | 名称列：方标 + 标题 + 副文案 |
| `buildEnvBrowserCell(profile)` | 内核列：方标 +「环境 N」+ 中性内核文案（不显示 Chrome 品牌） |
| `buildSquareMark(label, opts)` | 分组首字 / 代理协议 / 扩展字母占位 |
| `createExtensionIcon(item)` | 有 `icon_url`/`iconUrl`（含 `data:`）时显示图片，否则字母方标 |

尺寸由 CSS 变量 `--ui-mark-size`（默认 `2.125rem` ≈ 34px）控制，窄窗可略减但保持可读。

### 5.3 应用中心图标拉取

推荐应用带 `store_id`。`refreshExtensions()` 后调用 `hydrateAppCenterIcons()`：

1. 收集缺少图标的 `store_id`。
2. 并行请求 `appCenterMetadata`（CRX 解包或缓存）与 `appCenterIcons`（商店页 og:image）。
3. 主进程将图标字节缓存到 `userData/app-center-icons/{id}.img`，返回 **`data:` URL**（沙箱下比 `file://` 更稳）。
4. 回写 `item.icon_url` / `item.iconUrl` 并重绘。

实现：`main.js` 中 `fetchChromeStoreMetadata`、`fetchChromeStoreIcon`、`bufferToDataUrl`；IPC `automation:app-center-metadata` / `automation:app-center-icons`。

### 5.4 样式加载顺序与窄窗策略

页面按以下顺序加载 CSS，后面的文件用于覆盖前面的通用规则：

```text
styles.css
  -> themes.css
  -> environment-audit.css
  -> ui-shell.css
  -> pixel-workstation.css
  -> element-admin.css
```

- `styles.css`：基础布局、通用控件、表格、弹窗和默认变量。
- `themes.css`：主题变量和主题切换基础样式。
- `environment-audit.css`：环境审核区域和审核结果展示样式。
- `ui-shell.css`：桌面壳、标题栏融合、紧凑密度、**窄窗布局**与可读字号下限。
- `pixel-workstation.css`：像素工作站完整主题。
- `element-admin.css`：系统原生（macOS HIG / Windows Fluent 取向）主题。

**窄窗原则（重要）：** 窗口可横向缩小（body `min-width` ≈ 900px，窗口 `minWidth` 960），断点只收紧侧栏宽度、间距和部分控件尺寸；**不得把导航/标题/正文压到不可读**。图标用 `em` / `--ui-mark-size` 跟随，不单独砍字号到 8–11px。

标题栏融合：macOS `hiddenInset` + 红绿灯偏移；Windows `titleBarOverlay`。`html[data-titlebar=integrated]` / `.titlebar-integrated` 控制拖拽区与可点击控件的 `app-region`。

主题通过 `html[data-ui-theme]` 选择器隔离。皮肤键：`openbrowser-ui-skin-v1`；系统原生颜色模式：`openbrowser-ui-color-mode-v1`。

## 6. preload、IPC 和事件

`preload.js` 以 `window.ops` 暴露白名单方法，主要分为：

| 能力组 | 示例 |
| --- | --- |
| 系统和内核 | `getInfo`、`kernelStatus`、`kernelDownload`、`kernelPolicy` |
| 环境 | `startProfile`、`stopProfile`、`profileStatus`、`deleteProfiles` |
| 代理和扩展 | `proxyList`、`proxyCreate`、`proxyCheck`、`extensionList`、`assignExtension` |
| 窗口同步 | `startSync`、`stopSync`、`windowAction`、`textAction`、`tabAction` |
| RPA | `rpaPlans`、`rpaRun`、`rpaStop`、`rpaTemplates`、`rpaTemplateInstall` |
| 应用中心 | `appCenterList`、`appCenterMetadata`、`appCenterIcons` |
| 云同步 | `cloudBackup`、`cloudRestore`、`cloudProfilePush`、`cloudProfilePull` |
| 诊断 | `fingerprint`、`isolationAudit`、`buildUa`、`localApiInfo` |

主进程在 `main.js` 注册同名或对应的 `ipcMain.handle()`。业务状态通过 `engine:event` 推送到 renderer，典型事件包括环境状态、扩展变化、内核下载进度、RPA 任务、同步状态、本地 API 状态和云同步结果。

修改 IPC 时必须同时检查三处：

1. `preload.js` 是否暴露了最小必要方法。
2. `main.js` 是否有参数校验、错误处理和生命周期检查。
3. `renderer.js` 是否正确处理成功、失败、取消和实时事件。

## 7. 自动化接口

### 7.1 Local API

自动化栈默认在 `127.0.0.1:50325` 启动。可通过环境变量调整：

```bash
OPENBROWSER_API_PORT=50325
OPENBROWSER_API_KEY=optional-local-key
```

设置 `OPENBROWSER_API_KEY` 后，请求需要带 `api-key` 请求头。接口覆盖版本、环境、代理、扩展、窗口同步、RPA、模板和应用中心等能力。统一响应由 `automation/local-api-server.js` 生成，成功和失败均为 JSON。

典型调用：

```bash
curl -s http://127.0.0.1:50325/api/getVersion
curl -s http://127.0.0.1:50325/api/v1/user/list
curl -s -X POST http://127.0.0.1:50325/api/v1/browser/start \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"PROFILE_ID"}'
```

### 7.2 MCP

`automation/mcp-server.js` 是独立的 stdio MCP 进程。它不直接操作 Electron，而是通过 Local API 调用环境和自动化能力。MCP 工具定义和分发逻辑位于同一文件，当前包括环境控制、窗口同步和 RPA 相关工具。

启动 MCP 前应先让 OpenBrowser 主进程运行并启动 Local API：

```bash
OPENBROWSER_API_PORT=50325 node automation/mcp-server.js
```

## 8. 窗口同步和 CDP

`live-sync-v5.js` 是当前同步控制器。它管理主控环境、跟随环境、同步设置和同步生命周期；`automation/window-sync-bridge.js` 为 UI/API 提供较稳定的控制接口。

同步事件经过以下转换：

```text
主控 Chrome 页面/窗口事件
  -> live-sync-v5
  -> automation/protocol/ads-event-map.js
  -> automation/protocol/ads-window-sync-protocol.js
  -> sync-fanout.js
  -> 各环境 CDP 或 Windows native 辅助程序
```

CDP 页面能力包括导航、点击、移动、滚动、键盘输入、标签页读取和标签页切换。Windows 的 Chrome 原生地址栏、标签栏和扩展弹窗输入镜像由 `native-*.cs` 辅助程序补充；macOS 主要使用 CDP 和 Electron 全局快捷键。

## 9. RPA 执行模型

RPA 数据由 `RpaStore` 保存，执行由 `RpaEngine` 完成：

1. 计划或任务从 renderer、Local API 或 MCP 进入。
2. `RpaStore` 校验并读取步骤、变量和模板。
3. `RpaEngine` 找到目标 Profile 的 CDP 连接。
4. 按步骤执行导航、等待、点击、输入、脚本、截图、文件和循环等动作。
5. 运行状态和日志通过 `emit` 推送到 UI，并写入任务记录。
6. 执行失败时保留错误信息和步骤上下文，调用方可停止任务。

内置模板由 `rpa-templates-builtin.js` 提供；本地模板支持保存、另存、导入、导出、安装和删除。远程模板同步是可选适配，配置和协议代码在 `ads-template-sync.js` 与 `protocol/ads-rpa-registry.js`。

## 10. 数据和持久化

默认 Electron 数据根为应用 `userData` 下的 `openbrowser` 目录。持久化分为 renderer UI 状态、主进程本地设置和引擎状态三层，主要位置如下：

| 路径 | 内容 |
| --- | --- |
| renderer `localStorage/openbrowser-ui-state` | 环境列表、分组、操作日志和下一个环境编号；这是本地 UI 环境元数据的主存储 |
| `openbrowser-local-settings.json` | Profile 数据根、云同步配置，以及供云同步/恢复使用的 UI 分组缓存 |
| `openbrowser-engine.json` | 扩展清单、按环境分配的扩展和独立内核策略；不保存完整环境列表 |
| `rpa-store.json` | RPA 计划、任务、模板和 RPA 配置 |
| `proxy-library.json` | 代理库和代理检查结果 |
| `browser-profiles-v2/{id}` | 各环境 Chrome 用户数据 |
| `kernels/` | 独立浏览器内核和内核元数据 |
| `app-center-icons/` | Chrome Web Store 图标和元数据缓存 |

renderer 的其他轻量 UI 状态也使用独立的 `localStorage` 键，包括主题、颜色模式、分页大小、窗口同步设置和指定文本组。环境变更后，renderer 先保存 `openbrowser-ui-state`，再调用 `profiles:sync` 更新引擎内存状态；云恢复返回的新环境和分组也会写回该 UI 状态。不要把实际浏览器 Profile 文件或云同步口令写入 renderer 的普通 UI 状态；环境元数据中现有的 Cookie、代理认证和 TOTP 字段应始终按敏感数据处理，禁止输出到日志或非加密导出物。

云备份通过 `cloud-sync.js` 生成 `.obpack` 包，可包含环境元数据、分组、代理以及用户明确允许同步的浏览器数据。

**提供商：**

| provider | 说明 |
| --- | --- |
| `local` | 本机目录 |
| `webdav` | 通用 WebDAV（Nextcloud / 群晖 / Alist） |
| `github` | 私有仓库 + Token |
| `gdrive` | 谷歌云盘 WebDAV 桥（Alist 等） |
| `onedrive` | 微软云 OneDrive WebDAV 桥 |
| `quark` | 夸克云 WebDAV 桥 |
| `baidu` | 百度云 WebDAV 桥 |

后四者与 `gdrive` 一样走 WebDAV 上传/下载（`isWebDavBridgeProvider`）。本地设置页提供 **一键配置** 按钮（`renderer.js` 中 `CLOUD_BRIDGE_PRESETS` / `applyCloudPreset`），切换提供商、填默认远程目录并展示挂载说明；用户仍需自备 Alist/OpenList 桥接 URL 与账号。恢复支持合并 / 仅新增 / 覆盖；单环境是否参与由「编辑环境 → 偏好 → 云备份」决定，关窗时可自动推送（`profile-closed` 事件）。

## 11. 安全和可靠性边界

- 默认禁止环境回退到本机安装的 Chrome/Edge，避免指纹环境和本机浏览器共享内核或用户数据。
- Profile 根目录和实例锁防止两个 OpenBrowser 进程同时占用同一个环境。
- `contextIsolation: true`、`nodeIntegration: false` 和 `sandbox: true` 限制 renderer 权限。
- 主窗口禁止任意新窗口，默认网络请求只允许本地页面、数据页、开发者工具和回环地址。
- 本地 API 默认仅监听 `127.0.0.1`；对外开放前必须配置 API Key 并自行增加网络访问控制。
- 代理密码、Cookie、TOTP 和 Profile 数据属于敏感信息，日志和备份配置不得明文扩散。
- 项目不承诺规避网站风控、反机器人系统或账号关联检测。

## 12. 开发和验证命令

在 `Browserapp` 目录执行：

```bash
npm ci
npm run selftest
npm run selftest:automation
npm run selftest:protocol
npm run selftest:isolation
npm run selftest:kernel
```

常用脚本：

| 命令 | 作用 |
| --- | --- |
| `npm start` | 通过 `scripts/run-app.js` 启动（含 macOS 主机品牌化） |
| `npm run selftest` | 执行环境审核自测 |
| `npm run selftest:automation` | 自动化、RPA、Local API 和应用中心自测 |
| `npm run selftest:protocol` | 协议、跨平台能力和同步 fan-out 自测 |
| `npm run selftest:isolation` | Profile、系统浏览器和指纹隔离自测 |
| `npm run selftest:kernel` | 独立内核策略和内核选择自测 |
| `npm run build:native` | 编译 Windows native 辅助程序 |
| `npm run package:portable` | 生成便携发布包 |

修改 UI 时可优先做静态检查和目标自测；修改内核、Profile 路径、进程终止、代理或同步协议时，应至少执行隔离、内核、协议和自动化自测。未经明确要求，不应执行打包命令或自动打开应用窗口。开发调试请使用桌面「OpenBrowser 开发测试.command」（路径指向本仓库 `Browserapp`），不要随意打包。

## 13. 修改指南

### 增加或修改环境字段

同时检查 `engine.js` 的 `sanitizeProfile()`、Profile 编辑器表单、`renderer.js` 的保存/加载逻辑、云同步合并逻辑和相关 API 参数。新增字段必须有默认值，并考虑旧版 JSON 缺少字段的情况。

### 修改浏览器启动 / 关窗行为

优先修改 `BrowserEngine.start()` / `stop()`、`startRunningWatch`、`browser-kernel.js`、`isolation.js` 和 `fingerprint.js`。不要通过 renderer 直接拼接浏览器命令；所有可执行文件和 `user-data-dir` 必须经过隔离校验。关窗自动停止逻辑在 watch 轮询中，调整空窗口判定时注意启动阶段误杀（当前首次检测延迟约 2.5s，连续 2 次空页面才 `stop`）。

### 修改应用中心图标

同时检查 `main.js` 商店抓取与缓存、`renderer.js` 的 `hydrateAppCenterIcons` / `createExtensionIcon`，以及 CSP/沙箱是否允许 `data:` 图片。不要只改 CSS 占位方标。

### 修改云同步提供商

在 `cloud-sync.js` 的 `defaultCloudConfig`、`upload`/`download`、`cloudPresets` 中扩展；`main.js` 的 `providerConfigFromCloud` 要能取到新字段；`index.html` 增加表单区与一键按钮；`renderer.js` 的 `readCloudForm` / `applyCloudForm` / `cloudProviderFieldsVisibility` 同步。

### 修改同步协议

同时检查 `live-sync-v5.js`、`automation/protocol/ads-event-map.js`、`ads-window-sync-protocol.js`、`sync-fanout.js`、Windows native driver 和对应 selftest。同步设置变更需要兼容 UI、Local API 和 MCP 三种入口。

### 修改 UI 或主题

先修改语义结构和布局，再增加主题覆盖。控件尺寸、滚动容器、弹窗关闭、键盘焦点和 macOS/Windows 原生标题栏都属于功能的一部分。像素主题的规则必须限定在 `html[data-ui-theme="pixel-workstation"]` 下，其他主题不能被动继承像素主题颜色或图标尺寸。

### 修改 IPC 或本地 API

保持参数边界清晰，拒绝未校验的路径、Profile ID、扩展 ID 和文件内容。错误需要返回可读消息但不泄露密码、Cookie、完整本地路径或远程凭据。修改后分别运行对应的 Node selftest。

## 14. 相关文档

- [项目 README](../../README.md)
- [自动化模块说明](./automation/README.md)
- [第三方组件说明](./THIRD-PARTY-NOTICES.md)
- [免责声明](../../DISCLAIMER.md)
