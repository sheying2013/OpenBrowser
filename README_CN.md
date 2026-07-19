<div align="center">

<h1>OpenBrowser</h1>

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/lyu0805/OpenBrowser)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)](https://github.com/lyu0805/OpenBrowser)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Node](https://img.shields.io/badge/Node.js-LTS-339933.svg)](https://nodejs.org/)

**多国语言支持 / Multi-language support**

🇺🇸 [English](./README.md) · 🇨🇳 **中文**

**本地指纹浏览器 · 隔离 Chromium 环境 · 代理 / 指纹 / 同步 / RPA**

</div>

---

## 简介

OpenBrowser 是一款本地桌面指纹浏览器，用于管理多套互相隔离的 Chromium 环境。它把 Profile 隔离、代理配置、浏览器指纹参数、扩展管理、窗口同步、本地 API、MCP 集成和本地 RPA 流程集中在一个桌面应用里。

应用支持多国语言界面，目前包含英文和中文。

> 使用前请阅读 [免责声明](./DISCLAIMER.md)。OpenBrowser 不保证匿名、指纹唯一或对特定网站的兼容性。

## 目录

- [界面预览](#界面预览)
- [核心功能](#核心功能)
- [支持平台](#支持平台)
- [快速开始](#快速开始)
- [打包](#打包)
- [自测](#自测)
- [项目结构](#项目结构)
- [数据与安全](#数据与安全)

## 界面预览

| 主界面 | 环境管理 |
| :---: | :---: |
| ![主界面](./docs/screenshots/openbrowser-overview.png) | ![环境管理](./docs/screenshots/environment-management.png) |
| 主导航与模块入口 | Profile 列表、启停控制、分组 |

| 环境 / 指纹编辑 | 本地设置 |
| :---: | :---: |
| ![环境编辑](./docs/screenshots/profile-fingerprint-editor.png) | ![本地设置](./docs/screenshots/automation-and-system.png) |
| 代理、指纹、扩展设置 | 主题、语言、系统选项 |

## 核心功能

| 模块 | 能力 |
| --- | --- |
| **环境隔离** | 独立 Chromium Profile，Cookie / 缓存 / 存储互不混用。 |
| **批量管理** | 分组、标签、批量启停、日志和窗口尺寸管理。 |
| **代理支持** | HTTP / HTTPS / SOCKS 代理，按环境绑定，支持出口检测。 |
| **指纹参数** | 平台、语言、时区、UA、Canvas、WebGL、WebRTC 等参数。 |
| **扩展中心** | 内置 / 推荐 / 本地扩展，按环境加载。 |
| **窗口同步** | 基于 CDP 同步点击、滚动、输入和标签页。 |
| **本地 RPA** | 打开页面、等待、点击、输入、截图等流程任务。 |
| **Local API / MCP** | 默认本地集成端点为 `127.0.0.1:50325`。 |
| **独立内核** | 可下载独立 Chromium 内核，也可指定本地路径。 |
| **备份选项** | 本地、WebDAV、GitHub、网盘备份，仅在主动配置后启用。 |

## 支持平台

| 平台 | 架构 | 状态 |
| --- | --- | --- |
| Windows | x86_64 | ✅ 支持 |
| macOS | x86_64 | ✅ 支持 |
| macOS | arm64 | ✅ 支持 |

## 快速开始

需要 Node.js LTS 和 npm。

```bash
cd Browserapp
npm ci --include=dev
npm run selftest
npm start
```

也可以从仓库根目录使用启动脚本：

| 平台 | 启动脚本 |
| --- | --- |
| macOS | [`start-test.command`](./start-test.command) |
| Windows | [`start-test.cmd`](./start-test.cmd) |

## 打包

```bash
cd Browserapp
# 可选：OPENBROWSER_PACKAGE_ARCH=x86_64 或 arm64
npm run package:portable
```

构建产物输出到 `Browserapp/dist/`。

| 平台 | 产物说明 |
| --- | --- |
| Windows | 包含 `START.cmd`。 |
| macOS | 包含 `OpenBrowser.app` 和 `启动.command`。 |

## 自测

```bash
cd Browserapp
npm run selftest
npm run selftest:automation
npm run selftest:protocol
npm run selftest:isolation
npm run selftest:kernel
npm run selftest:cloud
```

## 项目结构

```text
OpenBrowser/
├── Browserapp/            # 应用源码
├── docs/screenshots/      # 截图
├── start-test.command     # macOS 启动脚本
├── start-test.cmd         # Windows 启动脚本
├── DISCLAIMER.md
├── LICENSE
├── README.md              # 英文说明
└── README_CN.md           # 中文说明
```

仓库只包含源码与文档，不包含 Profile、Cookie、代理凭据、内核二进制或安装包。

## 数据与安全

- 本地 API 默认只监听回环地址。
- 设置 `OPENBROWSER_API_KEY` 后，请求必须携带 `api-key` 头。
- 第三方组件声明见 [`THIRD-PARTY-NOTICES.md`](./Browserapp/THIRD-PARTY-NOTICES.md)。
- 云备份集成只有在用户显式配置后才会主动联网。

## 文档

- [自动化模块](./Browserapp/automation/README.md)
- [免责声明](./DISCLAIMER.md)
- [第三方组件声明](./Browserapp/THIRD-PARTY-NOTICES.md)

---

<details>
<summary>第三方内核来源</summary>

<br>

独立内核来自 [Donut Browser](https://github.com/zhom/donutbrowser) / [Wayfern](https://wayfern.com/)（作者 [zhom](https://github.com/zhom)）。更新源：[wayfern.json](https://donutbrowser.com/wayfern.json)。条款：[Wayfern ToS](https://wayfern.com/tos)。

本仓库不重新分发内核。

</details>

## 许可证

[MIT](./LICENSE)

---

<div align="center">

如果 OpenBrowser 对你有用，欢迎 Star ⭐

</div>
