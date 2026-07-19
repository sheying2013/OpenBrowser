# OpenBrowser

<div align="center">

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/lyu0805/OpenBrowser)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)](https://github.com/lyu0805/OpenBrowser)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Node](https://img.shields.io/badge/Node.js-LTS-339933.svg)](https://nodejs.org/)

**Local fingerprint browser · Isolated environments · Proxy / fingerprint / sync / RPA**

[中文](./README.md) | **English**

</div>

---

## Overview

OpenBrowser is a local desktop fingerprint browser for managing multiple isolated Chromium environments. Proxies, fingerprints, extensions, window sync, a local API, MCP, and basic RPA live in one app. The UI supports Chinese and English.

> Read the [disclaimer](./DISCLAIMER.md) before use. No guarantee of anonymity, unique fingerprints, or compatibility with any particular site.

## Screenshots

| Overview | Environments |
| :---: | :---: |
| ![Overview](./docs/screenshots/openbrowser-overview.png) | ![Environments](./docs/screenshots/environment-management.png) |
| Main nav and modules | Profiles, start/stop, groups |

| Profile / fingerprint | Local settings |
| :---: | :---: |
| ![Profile editor](./docs/screenshots/profile-fingerprint-editor.png) | ![Settings](./docs/screenshots/automation-and-system.png) |
| Proxy, fingerprint, extensions | Theme, language, system |

## Features

- **Isolation** — separate profiles (cookies, cache, storage)
- **Batch management** — groups, tags, bulk start/stop, logs, window size
- **Proxies** — HTTP / HTTPS / SOCKS, per-environment, egress checks
- **Fingerprint knobs** — platform, language, timezone, UA, Canvas, WebGL, WebRTC, etc.
- **App Center** — built-in / recommended / local extensions
- **Window sync** — CDP sync for click, scroll, input, tabs
- **Local RPA** — flows for navigate, wait, click, type, screenshot
- **Local API / MCP** — default `127.0.0.1:50325` for external tools
- **Independent kernel** — download a standalone Chromium or use a custom path
- **Backup** — local, WebDAV, GitHub, cloud drives (only when you enable them)

## Platforms

| Platform | Arch | Status |
| --- | --- | --- |
| Windows | x86_64 | ✅ |
| macOS | x86_64 | ✅ |
| macOS | arm64 | ✅ |

## Quick start

Requires Node.js LTS and npm:

```bash
cd Browserapp
npm ci --include=dev
npm run selftest
npm start
```

Or use the root launchers:

- macOS: [`start-test.command`](./start-test.command)
- Windows: [`start-test.cmd`](./start-test.cmd)

## Packaging

```bash
cd Browserapp
# optional: OPENBROWSER_PACKAGE_ARCH=x86_64 or arm64
npm run package:portable
```

Output: `Browserapp/dist/`. Windows includes `START.cmd`; macOS includes `OpenBrowser.app` and `启动.command`.

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

## Layout

```text
OpenBrowser/
├── Browserapp/            # app source
├── docs/screenshots/      # screenshots
├── start-test.command     # macOS launcher
├── start-test.cmd         # Windows launcher
├── DISCLAIMER.md
├── LICENSE
├── README.md              # Chinese
└── README_EN.md           # English
```

Source and docs only — no profiles, cookies, proxy credentials, kernel binaries, or installers.

## Data & security

Do not commit: `.env` / tokens, cookies / passwords / proxy credentials, profiles and logs, kernels and packages.

Local API binds to loopback by default; send `api-key` when `OPENBROWSER_API_KEY` is set. Third-party notices: [`THIRD-PARTY-NOTICES.md`](./Browserapp/THIRD-PARTY-NOTICES.md).

## Docs

- [Automation](./Browserapp/automation/README.md)
- [Disclaimer](./DISCLAIMER.md)

---

<details>
<summary>Third-party kernel sources</summary>

<br>

The independent kernel is not built by us. Default feed: [Donut Browser](https://github.com/zhom/donutbrowser) ([zhom](https://github.com/zhom)) → [wayfern.json](https://donutbrowser.com/wayfern.json) → [Wayfern](https://wayfern.com/) Chromium (`download.wayfern.com`, [ToS](https://wayfern.com/tos)). Fallback: Google [Chrome for Testing](https://github.com/GoogleChromeLabs/chrome-for-testing) ([version feed](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json)). OpenBrowser only fetches public sources and does not redistribute kernels.

</details>

## License

[MIT](./LICENSE)

---

<div align="center">

If this helps, a Star is appreciated ⭐

</div>
