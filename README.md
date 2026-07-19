# OpenBrowser

<div align="center">

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/lyu0805/OpenBrowser)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)](https://github.com/lyu0805/OpenBrowser)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Node](https://img.shields.io/badge/Node.js-LTS-339933.svg)](https://nodejs.org/)

**本地指纹浏览器 · 多环境隔离 · 代理 / 指纹 / 同步 / RPA**

**中文** | [English](./README_EN.md)

</div>

---

## 简介

OpenBrowser 是一款本地桌面指纹浏览器，用来管理多套互相隔离的 Chromium 环境。代理、指纹、扩展、窗口同步、本机 API、MCP 和本地 RPA 都在一个应用里完成。界面支持中文 / 英文切换。

> 使用前请阅读 [免责声明](./DISCLAIMER.md)。不保证匿名、指纹唯一或对特定网站的兼容性。

## 界面预览

| 主界面 | 环境管理 |
| :---: | :---: |
| ![主界面](./docs/screenshots/openbrowser-overview.png) | ![环境管理](./docs/screenshots/environment-management.png) |
| 主导航与模块入口 | Profile 列表、启停、分组 |

| 环境 / 指纹编辑 | 本地设置 |
| :---: | :---: |
| ![环境编辑](./docs/screenshots/profile-fingerprint-editor.png) | ![本地设置](./docs/screenshots/automation-and-system.png) |
| 代理、指纹、扩展 | 主题、语言、系统项 |

## 功能

- **环境隔离** — 独立 Profile，Cookie / 缓存 / 存储互不混用
- **批量管理** — 分组、标签、批量启停、日志、窗口尺寸
- **代理** — HTTP / HTTPS / SOCKS，按环境绑定，支持出口检测
- **指纹参数** — 平台、语言、时区、UA、Canvas、WebGL、WebRTC 等
- **扩展中心** — 内置 / 推荐 / 本地扩展，按环境加载
- **窗口同步** — CDP 同步点击、滚动、输入、标签页
- **本地 RPA** — 流程与任务：打开页面、等待、点击、输入、截图
- **Local API / MCP** — 默认 `127.0.0.1:50325`，可接外部工具
- **独立内核** — 可下载独立 Chromium，或指定本地路径
- **备份** — 本地、WebDAV、GitHub、各家网盘（主动配置才出网）

## 支持平台

| 平台 | 架构 | 状态 |
| --- | --- | --- |
| Windows | x86_64 | ✅ |
| macOS | x86_64 | ✅ |
| macOS | arm64 | ✅ |

## 快速开始

需要 Node.js LTS 和 npm：

```bash
cd Browserapp
npm ci --include=dev
npm run selftest
npm start
```

或从仓库根目录启动：

- macOS：[`start-test.command`](./start-test.command)
- Windows：[`start-test.cmd`](./start-test.cmd)

## 打包

```bash
cd Browserapp
# 可选：OPENBROWSER_PACKAGE_ARCH=x86_64 或 arm64
npm run package:portable
```

产物在 `Browserapp/dist/`。Windows 含 `START.cmd`，macOS 含 `OpenBrowser.app` 与 `启动.command`。

## 自测

```bash
cd Browserapp
npm run selftest              # 基础
npm run selftest:automation   # 自动化 / RPA
npm run selftest:protocol     # 协议 / 同步
npm run selftest:isolation    # 隔离
npm run selftest:kernel       # 内核
npm run selftest:cloud        # 云同步策略
```

## 项目结构

```text
OpenBrowser/
├── Browserapp/            # 应用源码
├── docs/screenshots/      # 截图
├── start-test.command     # macOS 启动
├── start-test.cmd         # Windows 启动
├── DISCLAIMER.md
├── LICENSE
├── README.md              # 中文说明
└── README_EN.md           # English
```

仓库只含源码与文档，不含 Profile、Cookie、代理凭据、内核二进制或安装包。

## 数据与安全

本地 API 默认只监听回环地址；设置了 `OPENBROWSER_API_KEY` 时请求需带 `api-key` 头。第三方组件见 [`THIRD-PARTY-NOTICES.md`](./Browserapp/THIRD-PARTY-NOTICES.md)。

## 文档

- [自动化模块](./Browserapp/automation/README.md)
- [免责声明](./DISCLAIMER.md)

---

<details>
<summary>第三方内核来源</summary>

<br>

独立内核来自 [Donut Browser](https://github.com/zhom/donutbrowser) / [Wayfern](https://wayfern.com/)（作者 [zhom](https://github.com/zhom)，更新源 [wayfern.json](https://donutbrowser.com/wayfern.json)，[服务条款](https://wayfern.com/tos)）。本仓库不重新分发内核。

</details>

## 许可证

[MIT](./LICENSE)

---

<div align="center">

如果觉得有用，欢迎 Star ⭐

</div>
