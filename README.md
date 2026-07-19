# OpenBrowser

> **OpenBrowser** 是一个本地桌面浏览器环境管理器，用于创建、启动和维护多个隔离的 Chromium 环境，并统一管理代理、指纹参数、扩展、窗口同步、Local API、MCP 与本地 RPA 工作流。
>
> **OpenBrowser** is a local desktop browser environment manager for isolated Chromium environments, proxy settings, extensions, window synchronization, Local API, MCP, and local RPA workflows.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

## 界面预览 / Interface preview

| 英文界面总览 / English UI overview | 环境管理 / Environment management |
| --- | --- |
| ![OpenBrowser 英文界面总览](./docs/screenshots/openbrowser-overview.png) | ![OpenBrowser 环境管理](./docs/screenshots/environment-management.png) |
| 英文界面展示主导航、模块入口和基础布局。 / English UI showing the main navigation, module entry points, and overall layout. | 管理隔离 Profile、启动/停止、状态与环境分组。 / Manage isolated profiles, start/stop actions, status, and grouping. |

| 应用中心 / App Center | 本地设置与主题切换 / Local settings and theme switching |
| --- | --- |
| ![OpenBrowser 应用中心](./docs/screenshots/profile-fingerprint-editor.png) | ![OpenBrowser 本地设置与主题切换](./docs/screenshots/automation-and-system.png) |
| 展示应用中心、推荐资源和扩展分发说明。 / Shows the App Center, recommended resources, and extension distribution. | 展示本地设置、主题切换和系统外观配置。 / Shows local settings, theme switching, and system appearance configuration. |

## 多国语言支持 / Multilingual support

OpenBrowser supports a multilingual UI and can switch languages from local settings.

- 🇨🇳 中文 / Chinese
- 🇺🇸 English / English
- 🌐 可扩展更多语言 / extensible to more languages

## 功能亮点 / Highlights

- **隔离环境管理 / Isolated environments**：每个环境使用独立 Profile 目录，隔离 Cookie、缓存、LocalStorage、IndexedDB、扩展状态和浏览器会话。 / Each environment uses an isolated profile directory to separate cookies, cache, LocalStorage, IndexedDB, extension state, and browser sessions.
- **环境批量操作 / Batch operations**：支持环境列表、分组、标签、批量启动/停止、状态刷新、运行日志和窗口尺寸管理。 / Supports profile lists, grouping, tags, batch start/stop, status refresh, run logs, and window sizing.
- **代理库与出口检测 / Proxy management**：集中维护 HTTP、HTTPS、SOCKS 等代理配置，可按环境分配代理并记录检测结果。 / Centralized HTTP, HTTPS, and SOCKS proxy management with per-environment assignment and result logging.
- **指纹参数配置 / Fingerprint settings**：按环境配置平台、语言、时区、User-Agent、Client Hints、Canvas、WebGL、WebRTC、硬件并发数和设备内存等参数。 / Configure platform, language, timezone, User-Agent, Client Hints, Canvas, WebGL, WebRTC, CPU cores, and device memory per environment.
- **扩展与应用中心 / Extensions and App Center**：集中管理内置、推荐和本地扩展，按环境分配加载，并缓存推荐应用图标。 / Manage built-in, recommended, and local extensions, assign them per environment, and cache recommended app icons.
- **窗口同步 / Window sync**：通过 CDP 组织多窗口点击、滚动、输入、标签页和窗口操作同步，适合本地测试和批量验证。 / Use CDP to synchronize clicks, scrolling, typing, tabs, and window actions across multiple environments.
- **本地 RPA / Local RPA**：内置流程、任务、模板和运行记录，用 CDP 执行打开页面、等待、点击、输入、截图等自动化步骤。 / Built-in flows, tasks, templates, and run history for CDP-driven automation such as navigation, waiting, clicking, typing, and screenshots.
- **Local API 与 MCP / Local API and MCP**：默认在回环地址提供本机 HTTP API，并支持 stdio MCP 接入外部自动化工具。 / Exposes a loopback-only local HTTP API and supports stdio MCP integration for external automation tools.
- **独立内核策略 / Independent kernel policy**：管理独立 Chromium/Chrome for Testing 内核，避免默认回退到系统浏览器，减少系统 Profile 污染。 / Manages independent Chromium / Chrome for Testing kernels and avoids falling back to the system browser.
- **云同步与备份 / Cloud sync and backup**：支持本地、WebDAV、GitHub、谷歌云、微软云、夸克云、百度云等备份入口；云同步仅在用户主动配置或操作时访问外部服务。 / Supports local, WebDAV, GitHub, Google Cloud, Microsoft Cloud, Quark, and Baidu backup paths; cloud sync only reaches external services when the user enables it.

## 适用场景 / Use cases

- 本地维护多套浏览器 Profile，并分别配置代理、扩展、语言、时区和启动页。 / Maintain multiple browser profiles locally with separate proxies, extensions, languages, timezones, and start pages.
- 对多个测试账号或测试环境做批量启动、状态检查和窗口同步操作。 / Batch start, inspect, and synchronize multiple test accounts or environments.
- 在本机用 Local API、MCP 或 RPA 流程串联重复性浏览器任务。 / Chain repetitive browser tasks locally with Local API, MCP, or RPA flows.
- 验证扩展、页面兼容性、代理出口和独立内核策略。 / Validate extensions, page compatibility, proxy egress, and the independent kernel policy.

OpenBrowser 不承诺匿名性、指纹唯一性、账号访问成功率、自动化稳定性或对特定网站的兼容性。使用前请阅读 [`DISCLAIMER.md`](./DISCLAIMER.md)。

OpenBrowser does not promise anonymity, unique fingerprints, account success rates, automation stability, or compatibility with any specific website. Please read [`DISCLAIMER.md`](./DISCLAIMER.md) before use.

## 支持平台 / Supported platforms

| 平台 | 架构 | 状态 |
| --- | --- | --- |
| Windows | x86_64 | 支持 |
| macOS | x86_64 | 支持 |
| macOS | arm64 | 支持 |

## 项目结构 / Project structure

```text
OpenBrowser/
├── Browserapp/                 # 应用源码 / application source
├── docs/screenshots/           # README 使用的界面截图 / screenshots used by this README
├── start-test.command          # macOS 本地测试启动器 / macOS test launcher
├── start-test.cmd              # Windows 本地测试启动器 / Windows test launcher
├── DISCLAIMER.md               # 使用与安全免责声明 / operational disclaimer
├── LICENSE                     # 开源许可证 / license
└── README.md                   # 项目说明 / project readme
```

应用源码位于 [`Browserapp/`](./Browserapp/)。仓库只保存源码、文档资源和构建脚本，不包含用户 Profile、Cookie、代理凭据、浏览器内核、运行日志或打包产物。

The application source lives in [`Browserapp/`](./Browserapp/). The repository keeps source code, documentation assets, and build scripts only; it does not include user profiles, cookies, proxy credentials, browser kernels, runtime logs, or packaged artifacts.

## 快速开始 / Quick start

要求：Node.js LTS 和 npm。 / Requires Node.js LTS and npm.

```bash
cd Browserapp
npm ci --include=dev
npm run selftest
npm start
```

如果只想从仓库根目录启动测试环境，也可以使用：

- macOS：[`start-test.command`](./start-test.command)
- Windows：[`start-test.cmd`](./start-test.cmd)

The launchers enter `Browserapp/` and install the required platform dependencies if the desktop runtime is missing.

## 主要能力 / Core capabilities

### 管理浏览器环境 / Manage browser environments

在环境列表中创建和维护多个 Profile。每个环境都可以独立设置名称、编号、分组、标签、窗口尺寸、启动页、代理、扩展、指纹参数和数据保留策略。环境启动后，OpenBrowser 会等待独立 CDP 端口可用，并在用户关闭最后一个浏览器窗口后自动同步状态。

Create and maintain multiple profiles in the environment list. Each environment can have its own name, number, group, tags, window size, start page, proxy, extensions, fingerprint settings, and data retention policy. After launch, OpenBrowser waits for an isolated CDP port and automatically syncs state when the last browser window closes.

### 配置代理和指纹参数 / Configure proxies and fingerprints

代理库负责代理增删改查、批量检测和环境分配。环境编辑器负责平台、语言、时区、User-Agent、Client Hints、Canvas、WebGL、WebRTC、硬件并发数和设备内存等参数。代理认证会通过本地转发器处理，指纹参数会在启动和新开标签时通过 CDP 注入。

The proxy library handles create/read/update/delete, batch checks, and environment assignment. The environment editor controls platform, language, timezone, User-Agent, Client Hints, Canvas, WebGL, WebRTC, CPU cores, and memory settings. Proxy authentication is handled by a local forwarder, and fingerprint settings are injected through CDP during startup and when new tabs open.

### 同步窗口和运行 RPA / Sync windows and run RPA

窗口同步可把主控窗口的点击、移动、滚动、键盘、标签页和窗口操作同步到其他环境。本地 RPA 引擎可按流程执行 `goto`、`wait`、`click`、`type`、截图和变量处理等步骤，流程、任务和模板保存在本机。

Window synchronization can mirror clicks, movement, scrolling, keyboard input, tabs, and window actions from a controller window to other environments. The local RPA engine can execute flows such as `goto`, `wait`, `click`, `type`, screenshots, and variable handling, with flows, tasks, and templates stored locally.

### 接入 Local API 和 MCP / Use Local API and MCP

OpenBrowser 随主进程启动本地自动化服务，默认监听 `127.0.0.1:50325`。可通过 HTTP API 查询版本、列出环境、启动环境、停止环境、触发窗口同步或执行 RPA。MCP 服务可通过 `automation/mcp-server.js` 以 stdio 方式接入外部工具。

OpenBrowser starts a local automation service with the main process and listens on `127.0.0.1:50325` by default. The HTTP API can query the version, list environments, start and stop environments, trigger window sync, and run RPA. The MCP server can be launched from `automation/mcp-server.js` over stdio for external tools.

### 管理内核、扩展和同步 / Manage kernels, extensions, and sync

独立浏览器内核由 `automation/browser-kernel.js` 管理，Profile 数据会被限制在专属目录中。应用中心支持内置、推荐和本地扩展；云同步支持加密备份包、合并恢复和多个备份入口。

Independent browser kernels are managed by `automation/browser-kernel.js`, and profile data is constrained to dedicated directories. The App Center supports built-in, recommended, and local extensions, while cloud sync supports encrypted backup packages, merge restore, and multiple backup targets.

## 自测命令 / Self-tests

在 `Browserapp/` 目录下执行：

```bash
npm run selftest
npm run selftest:automation
npm run selftest:protocol
npm run selftest:isolation
npm run selftest:kernel
npm run selftest:cloud
```

| 命令 | 说明 |
| --- | --- |
| `npm run selftest` | 基础环境与配置自测 / basic environment and configuration checks |
| `npm run selftest:automation` | 自动化、RPA 与本地服务自测 / automation, RPA, and local service checks |
| `npm run selftest:protocol` | 协议与同步能力自测 / protocol and sync checks |
| `npm run selftest:isolation` | Profile 与隔离策略自测 / profile and isolation checks |
| `npm run selftest:kernel` | 浏览器内核策略自测 / browser kernel policy checks |
| `npm run selftest:cloud` | 云同步安全策略自测 / cloud sync security checks |

## 打包 / Packaging

打包由 GitHub Actions 为支持的平台执行。每个任务会安装对应平台的桌面运行时，执行自测，并在 `Browserapp/dist/` 下生成产物。

Packaging runs in GitHub Actions for the supported targets. Each job installs the platform desktop runtime, runs self-tests, and emits artifacts under `Browserapp/dist/`.

本地打包时，可设置目标架构：

```bash
export OPENBROWSER_PACKAGE_ARCH=x86_64  # 或 arm64
cd Browserapp
npm run package:portable
```

Windows 包含 `START.cmd`；macOS 包含 `OpenBrowser.app` 和 `启动.command`。

Windows packages include `START.cmd`; macOS packages include `OpenBrowser.app` and `启动.command`.

## 数据和安全边界 / Data and security boundaries

请不要提交或公开以下内容：

- `.env` 文件、API Key、访问令牌 / `.env` files, API keys, and access tokens
- Cookie、密码、代理账号或代理密码 / cookies, passwords, proxy usernames, or proxy passwords
- 浏览器 Profile、缓存、日志和运行输出 / browser profiles, cache, logs, and runtime output
- Chromium 运行时、第三方二进制和生成的安装包 / Chromium runtimes, third-party binaries, and generated packages

OpenBrowser 的本地 API 默认只监听回环地址；如设置 `OPENBROWSER_API_KEY`，请求需要携带 `api-key` 头。云同步、应用商店图标获取和第三方备份入口只有在用户主动配置或操作时访问外部服务。第三方组件说明见 [`THIRD-PARTY-NOTICES.md`](./Browserapp/THIRD-PARTY-NOTICES.md)。

By default, OpenBrowser's local API listens only on loopback. If `OPENBROWSER_API_KEY` is set, requests must include the `api-key` header. Cloud sync, app-store icon fetches, and third-party backup targets only access external services when the user explicitly enables them. Third-party notices are listed in [`THIRD-PARTY-NOTICES.md`](./Browserapp/THIRD-PARTY-NOTICES.md).

## 维护文档 / More docs

- 自动化模块：[`Browserapp/automation/README.md`](./Browserapp/automation/README.md)
- 使用免责声明：[`DISCLAIMER.md`](./DISCLAIMER.md)

## 许可证 / License

本项目使用 MIT License。详见 [`LICENSE`](./LICENSE)。

This project is licensed under the MIT License. See [`LICENSE`](./LICENSE).
