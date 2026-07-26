'use strict';

const path = require('path');

/**
 * Cross-platform preflight — turns the known multi-platform failure modes into early,
 * actionable warnings instead of silent runtime breakage. Pure function (no fs / no
 * side effects) so it is fully unit-testable and safe to call at startup.
 *
 * Covers:
 *  - Windows MAX_PATH: the deepest thing we create is the per-profile disk-cache dir,
 *    and Chromium appends its own deep tree under it. A too-deep data root silently
 *    corrupts cache / fails IO once the 260-char limit is hit (no long-path opt-in).
 *  - Missing USERPROFILE / LOCALAPPDATA (Windows), HOME (mac/Linux) → user-dir resolution.
 *  - Arch vs kernel mismatch (Apple Silicon running an x64-only kernel needs Rosetta 2).
 *  - Linux sandbox availability + Wayland window-sync degradation.
 *  - macOS Gatekeeper quarantine on ad-hoc-signed downloads.
 */

const WINDOWS_MAX_PATH = 260;
// Budget for Chromium's own deepest cache/storage tail under --disk-cache-dir, e.g.
// \Service Worker\CacheStorage\<hash>\<hash>\index-dir\the-real-index, GPUCache, etc.
const CHROME_CACHE_TAIL_BUDGET = 120;
// Realistic default when the caller does not pass the longest actual profile id.
const DEFAULT_PROFILE_ID_LEN = 32;
// isValidProfileId allows up to 64 chars.
const MAX_PROFILE_ID_LEN = 64;

function level(w) { return w.level; }

/**
 * @param {object} input
 * @param {string} [input.platform=process.platform]
 * @param {string} [input.arch=process.arch]
 * @param {NodeJS.ProcessEnv} [input.env=process.env]
 * @param {string} [input.profileDataRoot] absolute root under which {id}/OpenBrowserCache lives
 * @param {number} [input.maxProfileIdLen] longest existing profile id length (defaults to a realistic 32)
 * @param {boolean} [input.kernelRequiresX64] selected kernel is x64-only (e.g. openbrowser-148)
 * @returns {{platform:string, arch:string, ok:boolean, warnings:Array}}
 */
function platformPreflight(input = {}) {
  const platform = input.platform || process.platform;
  const arch = input.arch || process.arch;
  const env = input.env || process.env;
  const profileDataRoot = String(input.profileDataRoot || '');
  const idLen = Number.isFinite(Number(input.maxProfileIdLen))
    ? Math.min(MAX_PROFILE_ID_LEN, Math.max(1, Math.round(Number(input.maxProfileIdLen))))
    : DEFAULT_PROFILE_ID_LEN;
  const warnings = [];
  const push = (lvl, code, message, hint) => warnings.push({ level: lvl, code, message, hint: hint || '' });

  if (platform === 'win32') {
    if (!env.USERPROFILE && !env.HOMEDRIVE) {
      push('warn', 'win-no-userprofile',
        'USERPROFILE 未设置：桌面/文档/OneDrive 等用户目录解析可能失败（影响 RPA useExcel 等）',
        '以正常交互用户会话启动，而非精简服务账户');
    }
    if (!env.LOCALAPPDATA) {
      push('warn', 'win-no-localappdata',
        'LOCALAPPDATA 未设置：系统浏览器数据目录隔离校验可能不完整',
        '确认标准 Windows 用户环境变量存在');
    }
    if (profileDataRoot) {
      // Worst-case cache path length = dataRoot \ {longest id} \ OpenBrowserCache + Chrome tail.
      const worstCacheBase = path.win32.join(profileDataRoot, 'X'.repeat(idLen), 'OpenBrowserCache');
      const projected = worstCacheBase.length + CHROME_CACHE_TAIL_BUDGET;
      if (projected >= WINDOWS_MAX_PATH) {
        push('error', 'win-long-path',
          `环境缓存路径可能超过 Windows MAX_PATH(260)：数据根「${profileDataRoot}」过深，最坏约 ${projected} 字符（含 Chromium 缓存子树预算 ${CHROME_CACHE_TAIL_BUDGET}）`,
          '把数据根改到更短位置（如 C:\\ob），或为应用启用 longPathAware 清单并对内部 fs 用 \\\\?\\ 扩展长度前缀');
      } else if (projected >= WINDOWS_MAX_PATH - 40) {
        push('warn', 'win-long-path-near',
          `环境缓存路径接近 Windows MAX_PATH：最坏约 ${projected}/260 字符`,
          '建议把数据根改短以留余量');
      }
    }
    if (input.kernelRequiresX64 && arch === 'arm64') {
      push('warn', 'win-arm-kernel',
        'Windows on ARM：所选内核为 x64-only',
        '使用 x64 内核（经 WOW64 x64 仿真运行）或提供 arm64 内核');
    }
  } else if (platform === 'darwin') {
    if (!env.HOME) {
      push('warn', 'mac-no-home', 'HOME 未设置：用户目录/内核模板解析可能失败', '以正常用户会话启动');
    }
    push('info', 'mac-quarantine',
      '若从浏览器下载安装，Gatekeeper 可能对 ad-hoc 签名应用打隔离属性',
      '正式分发用 Developer ID 签名 + notarytool 公证 + stapler 装订；临时可 xattr -dr com.apple.quarantine <App>');
    if (input.kernelRequiresX64 && arch === 'arm64') {
      push('info', 'mac-arm-rosetta',
        'Apple Silicon：x64-only 内核（如 openbrowser-148）需 Rosetta 2',
        '确认已安装 Rosetta 2（softwareupdate --install-rosetta），否则内核无法启动');
    }
  } else if (platform === 'linux') {
    if (!env.HOME) {
      push('warn', 'linux-no-home', 'HOME 未设置：用户目录解析可能失败', '以正常用户会话启动');
    }
    push('info', 'linux-sandbox',
      'Chromium 内核需可用沙箱（unprivileged user namespaces 或 SUID sandbox）',
      '内核起不来时：确认 kernel.unprivileged_userns_clone=1 或部署 chrome-sandbox SUID；避免无脑 --no-sandbox 削弱隔离');
    if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY) {
      push('info', 'linux-wayland',
        'Wayland 会话：原生窗口/输入镜像受限，窗口同步降级为 CDP 层',
        '需要完整原生窗口同步可切换到 X11(Xorg) 会话');
    }
  } else {
    push('warn', 'unknown-platform', `未识别平台：${platform}`, '仅正式支持 win32 / darwin / linux');
  }

  return {
    platform,
    arch,
    ok: !warnings.some((w) => level(w) === 'error'),
    warnings,
  };
}

module.exports = {
  platformPreflight,
  WINDOWS_MAX_PATH,
  CHROME_CACHE_TAIL_BUDGET,
  DEFAULT_PROFILE_ID_LEN,
  MAX_PROFILE_ID_LEN,
};
