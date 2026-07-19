# OpenBrowser

> **OpenBrowser** 是一个本地桌面浏览器环境管理器，用于创建、启动和维护多个隔离的 Chromium 环境，并统一管理代理、指纹参数、扩展、窗口同步、Local API、MCP 与本地 RPA 工作流。

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

## 界面预览

| 环境总览 | 环境管理 |
| --- | --- |
| ![OpenBrowser 主界面总览](./docs/screenshots/openbrowser-overview.png) | ![环境管理与批量操作](./docs/screenshots/environment-management.png) |
| 统一查看环境状态、分组、代理、扩展、同步、RPA、日志和系统设置。 | 管理隔离 Profile、启动/停止环境、查看运行状态，并按环境配置网络与扩展。 |

| 指纹与代理配置 | 自动化与系统能力 |
| --- | --- |
| ![指纹、代理与环境编辑](./docs/screenshots/profile-fingerprint-editor.png) | ![自动化、API 与系统设置](./docs/screenshots/automation-and-system.png) |
| 为单个环境配置平台、User-Agent、语言、时区、代理、指纹参数和启动策略。 | 通过窗口同步、RPA、Local API、MCP、应用中心、内核管理和云同步组织本地工作流。 |

## 功能亮点

- **隔离环境管理**：每个环境使用独立 Profile 目录，隔离 Cookie、缓存、LocalStorage、IndexedDB、扩展状态和浏览器会话。
- **环境批量操作**：支持环境列表、分组、标签、批量启动/停止、状态刷新、运行日志和窗口尺寸管理。
- **代理库与出口检测**：集中维护 HTTP、HTTPS、SOCKS 等代理配置，可按环境分配代理并记录检测结果。
- **指纹参数配置**：按环境配置平台、语言、时区、User-Agent、Client Hints、Canvas、WebGL、WebRTC、硬件并发数和设备内存等参数。
- **扩展与应用中心**：集中管理内置、推荐和本地扩展，按环境分配加载，并缓存推荐应用图标。
- **窗口同步**：通过 CDP 组织多窗口点击、滚动、输入、标签页和窗口操作同步，适合本地测试和批量验证。
- **本地 RPA**：内置流程、任务、模板和运行记录，用 CDP 执行打开页面、等待、点击、输入、截图等自动化步骤。
- **Local API 与 MCP**：默认在回环地址提供本机 HTTP API，并支持 stdio MCP 接入外部自动化工具。
- **独立内核策略**：管理独立 Chromium/Chrome for Testing 内核，避免默认回退到系统浏览器，减少系统 Profile 污染。
- **云同步与备份**：支持本地、WebDAV、GitHub、谷歌云、微软云、夸克云、百度云等备份入口；云同步仅在用户主动配置或操作时访问外部服务。

## 适用场景

- 本地维护多套浏览器 Profile，并分别配置代理、扩展、语言、时区和启动页。
- 对多个测试账号或测试环境做批量启动、状态检查和窗口同步操作。
- 在本机用 Local API、MCP 或 RPA 流程串联重复性浏览器任务。
- 验证扩展、页面兼容性、代理出口和独立内核策略。

OpenBrowser 不承诺匿名性、指纹唯一性、账号访问成功率、自动化稳定性或对特定网站的兼容性。使用前请阅读 [`DISCLAIMER.md`](./DISCLAIMER.md)。

## 支持平台

| 平台 | 架构 | 状态 |
| --- | --- | --- |
| Windows | x86_64 | 支持 |
| macOS | x86_64 | 支持 |
| macOS | arm64 | 支持 |

## 项目结构

```text
OpenBrowser/
├── Browserapp/                 # 应用源码
├── docs/screenshots/           # README 使用的界面截图
├── start-test.command          # macOS 本地测试启动器
├── start-test.cmd              # Windows 本地测试启动器
├── DISCLAIMER.md               # 使用与安全免责声明
├── LICENSE                     # 开源许可证
└── README.md                   # 项目说明
```

应用源码位于 [`Browserapp/`](./Browserapp/)。仓库只保存源码、文档资源和构建脚本，不包含用户 Profile、Cookie、代理凭据、浏览器内核、运行日志或打包产物。

## 快速开始

要求：Node.js LTS 和 npm。

```bash
cd Browserapp
npm ci --include=dev
npm run selftest
npm start
```

如果只想从仓库根目录启动测试环境，也可以使用：

- macOS：[`start-test.command`](./start-test.command)
- Windows：[`start-test.cmd`](./start-test.cmd)

启动器会进入 `Browserapp/`，并在桌面运行时缺失时安装所需平台依赖。

## 主要能力

### 管理浏览器环境

在环境列表中创建和维护多个 Profile。每个环境都可以独立设置名称、编号、分组、标签、窗口尺寸、启动页、代理、扩展、指纹参数和数据保留策略。环境启动后，OpenBrowser 会等待独立 CDP 端口可用，并在用户关闭最后一个浏览器窗口后自动同步状态。

### 配置代理和指纹参数

代理库负责代理增删改查、批量检测和环境分配。环境编辑器负责平台、语言、时区、User-Agent、Client Hints、Canvas、WebGL、WebRTC、硬件并发数和设备内存等参数。代理认证会通过本地转发器处理，指纹参数会在启动和新开标签时通过 CDP 注入。

### 同步窗口和运行 RPA

窗口同步可把主控窗口的点击、移动、滚动、键盘、标签页和窗口操作同步到其他环境。本地 RPA 引擎可按流程执行 `goto`、`wait`、`click`、`type`、截图和变量处理等步骤，流程、任务和模板保存在本机。

### 接入 Local API 和 MCP

OpenBrowser 随主进程启动本地自动化服务，默认监听 `127.0.0.1:50325`。可通过 HTTP API 查询版本、列出环境、启动环境、停止环境、触发窗口同步或执行 RPA。MCP 服务可通过 `automation/mcp-server.js` 以 stdio 方式接入外部工具。

### 管理内核、扩展和同步

独立浏览器内核由 `automation/browser-kernel.js` 管理，Profile 数据会被限制在专属目录中。应用中心支持内置、推荐和本地扩展；云同步支持加密备份包、合并恢复和多个备份入口。

## 自测命令

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
| `npm run selftest` | 基础环境与配置自测 |
| `npm run selftest:automation` | 自动化、RPA 与本地服务自测 |
| `npm run selftest:protocol` | 协议与同步能力自测 |
| `npm run selftest:isolation` | Profile 与隔离策略自测 |
| `npm run selftest:kernel` | 浏览器内核策略自测 |
| `npm run selftest:cloud` | 云同步安全策略自测 |

## 打包

打包由 GitHub Actions 为支持的平台执行。每个任务会安装对应平台的桌面运行时，执行自测，并在 `Browserapp/dist/` 下生成产物。

本地打包时，可设置目标架构：

```bash
export OPENBROWSER_PACKAGE_ARCH=x86_64  # 或 arm64
cd Browserapp
npm run package:portable
```

Windows 包含 `START.cmd`；macOS 包含 `OpenBrowser.app` 和 `启动.command`。

## 数据和安全边界

请不要提交或公开以下内容：

- `.env` 文件、API Key、访问令牌
- Cookie、密码、代理账号或代理密码
- 浏览器 Profile、缓存、日志和运行输出
- Chromium 运行时、第三方二进制和生成的安装包

OpenBrowser 的本地 API 默认只监听回环地址；如设置 `OPENBROWSER_API_KEY`，请求需要携带 `api-key` 头。云同步、应用商店图标获取和第三方备份入口只有在用户主动配置或操作时访问外部服务。第三方组件说明见 [`THIRD-PARTY-NOTICES.md`](./Browserapp/THIRD-PARTY-NOTICES.md)。

## 维护文档

- 代码概要：[`Browserapp/CODE_OVERVIEW.md`](./Browserapp/CODE_OVERVIEW.md)
- 自动化模块：[`Browserapp/automation/README.md`](./Browserapp/automation/README.md)
- 使用免责声明：[`DISCLAIMER.md`](./DISCLAIMER.md)

## 许可证

本项目使用 MIT License。详见 [`LICENSE`](./LICENSE)。
