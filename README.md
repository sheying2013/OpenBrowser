# OpenBrowser

<div align="center">

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/lyu0805/OpenBrowser)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)](https://github.com/lyu0805/OpenBrowser)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Node](https://img.shields.io/badge/Node.js-LTS-339933.svg)](https://nodejs.org/)

**Multi-language support / 多国语言支持**

🇺🇸 **English** · 🇨🇳 [中文](./README_CN.md)

**Local fingerprint browser · Isolated Chromium profiles · Proxy / fingerprint / sync / RPA**

</div>

---

## Overview

OpenBrowser is a local desktop fingerprint browser for managing multiple isolated Chromium environments. It combines profile isolation, proxy configuration, browser fingerprint controls, extension management, window synchronization, a local API, MCP integration, and local RPA workflows in one desktop app.

The app supports multiple UI languages, currently including English and Chinese.

> Read the [disclaimer](./DISCLAIMER.md) before use. OpenBrowser does not guarantee anonymity, unique fingerprints, or compatibility with any specific website.

## Contents

- [Screenshots](#screenshots)
- [Key features](#key-features)
- [Supported platforms](#supported-platforms)
- [Quick start](#quick-start)
- [Packaging](#packaging)
- [Self-tests](#self-tests)
- [Project layout](#project-layout)
- [Data and security](#data-and-security)

## Screenshots

| Overview | Environments |
| :---: | :---: |
| ![Overview](./docs/screenshots/openbrowser-overview.png) | ![Environments](./docs/screenshots/environment-management.png) |
| Main navigation and module entry points | Profiles, start/stop controls, and groups |

| Profile / fingerprint | Local settings |
| :---: | :---: |
| ![Profile editor](./docs/screenshots/profile-fingerprint-editor.png) | ![Settings](./docs/screenshots/automation-and-system.png) |
| Proxy, fingerprint, and extension settings | Theme, language, and system options |

## Key features

| Area | What it provides |
| --- | --- |
| **Profile isolation** | Separate Chromium profiles so cookies, cache, and storage do not mix. |
| **Batch management** | Groups, tags, bulk start/stop, logs, and window sizing. |
| **Proxy support** | HTTP / HTTPS / SOCKS proxies per environment, with egress checks. |
| **Fingerprint controls** | Platform, language, timezone, user agent, Canvas, WebGL, WebRTC, and more. |
| **Extension center** | Built-in, recommended, and local extensions loaded per environment. |
| **Window sync** | CDP-based synchronization for clicks, scrolling, input, and tabs. |
| **Local RPA** | Flows for navigation, waiting, clicking, typing, and screenshots. |
| **Local API / MCP** | Local integration endpoint on `127.0.0.1:50325` by default. |
| **Independent kernel** | Download a standalone Chromium kernel or use a custom local path. |
| **Backup options** | Local, WebDAV, GitHub, and cloud-drive backups when explicitly enabled. |

## Supported platforms

| Platform | Architecture | Status |
| --- | --- | --- |
| Windows | x86_64 | ✅ Supported |
| macOS | x86_64 | ✅ Supported |
| macOS | arm64 | ✅ Supported |

## Quick start

Requires Node.js LTS and npm.

```bash
cd Browserapp
npm ci --include=dev
npm run selftest
npm start
```

Or use the launcher scripts from the repository root:

| Platform | Launcher |
| --- | --- |
| macOS | [`start-test.command`](./start-test.command) |
| Windows | [`start-test.cmd`](./start-test.cmd) |

## Packaging

```bash
cd Browserapp
# Optional: OPENBROWSER_PACKAGE_ARCH=x86_64 or arm64
npm run package:portable
```

Build output is written to `Browserapp/dist/`.

| Platform | Output notes |
| --- | --- |
| Windows | Includes `START.cmd`. |
| macOS | Includes `OpenBrowser.app` and `启动.command`. |

## Self-tests

```bash
cd Browserapp
npm run selftest
npm run selftest:automation
npm run selftest:protocol
npm run selftest:isolation
npm run selftest:kernel
npm run selftest:cloud
```

## Project layout

```text
OpenBrowser/
├── Browserapp/            # App source
├── docs/screenshots/      # Screenshots
├── start-test.command     # macOS launcher
├── start-test.cmd         # Windows launcher
├── DISCLAIMER.md
├── LICENSE
├── README.md              # English documentation
└── README_CN.md           # Chinese documentation
```

This repository contains source code and documentation only. It does not include profiles, cookies, proxy credentials, kernel binaries, or installers.

## Data and security

- The local API binds to loopback by default.
- If `OPENBROWSER_API_KEY` is set, requests must include the `api-key` header.
- Third-party notices are documented in [`THIRD-PARTY-NOTICES.md`](./Browserapp/THIRD-PARTY-NOTICES.md).
- Cloud backup integrations only connect outward after explicit user configuration.

## Documentation

- [Automation module](./Browserapp/automation/README.md)
- [Disclaimer](./DISCLAIMER.md)
- [Third-party notices](./Browserapp/THIRD-PARTY-NOTICES.md)

---

<details>
<summary>Third-party kernel sources</summary>

<br>

The independent kernel comes from [Donut Browser](https://github.com/zhom/donutbrowser) / [Wayfern](https://wayfern.com/) by [zhom](https://github.com/zhom). Update feed: [wayfern.json](https://donutbrowser.com/wayfern.json). Terms: [Wayfern ToS](https://wayfern.com/tos).

This repository does not redistribute the kernel.

</details>

## License

[MIT](./LICENSE)

---

<div align="center">

If OpenBrowser is useful to you, a Star is appreciated ⭐

</div>
