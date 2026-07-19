# OpenBrowser

OpenBrowser is a local desktop browser environment manager. It manages isolated browser profiles, proxy settings, extensions, window synchronization, CDP automation, and local RPA workflows from one desktop application.

Version: `1.0.0`

## Supported builds

- Windows x86_64
- macOS x86_64
- macOS arm64

The application source is in `Browserapp/`. The repository intentionally contains source code and build scripts only. User profiles, cookies, proxy credentials, browser kernels, and runtime output are local data and are not part of the repository.

## Development

Requirements: Node.js LTS and npm.

```bash
cd Browserapp
npm ci --include=dev
npm run selftest
npm run selftest:automation
npm run selftest:protocol
npm run selftest:isolation
npm run selftest:kernel
npm start
```

The root launchers are `start-test.command` and `start-test.cmd`. They enter the application directory and install platform dependencies when the desktop runtime is missing.

## Packaging

Packaging is performed by GitHub Actions for the three supported targets. Each job installs the platform-specific desktop runtime, runs the self-tests, and produces a ZIP package under `Browserapp/dist/`.

For a local build, set `OPENBROWSER_PACKAGE_ARCH` to `x86_64` or `arm64` and run:

```bash
npm run package:portable
```

The Windows package includes `START.cmd`; macOS packages include `OpenBrowser.app` and `启动.command`.

## Security and data handling

Do not commit `.env` files, API keys, access tokens, cookies, proxy passwords, browser profiles, Chromium runtimes, or generated packages. See [DISCLAIMER.md](./DISCLAIMER.md) for the operational disclaimer and [THIRD-PARTY-NOTICES.md](./Browserapp/THIRD-PARTY-NOTICES.md) for bundled notices.

## License

See [LICENSE](./LICENSE).
