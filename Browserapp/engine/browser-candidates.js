"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { execFileSync } = require("child_process");
const { isPidAlive } = require("../automation/isolation");

function isChildExited(child) {
  if (!child) return true;
  if (child.exitCode !== null && child.exitCode !== undefined) return true;
  if (child.signalCode !== null && child.signalCode !== undefined) return true;
  if (child.pid && !isPidAlive(child.pid)) return true;
  return false;
}

const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile", "DevToolsActivePort"];

async function removeSingletonFiles(root, options = {}) {
  if (!root) return;
  const attempts = Math.max(1, Number(options.attempts) || 6);
  const initialDelay = Math.max(10, Number(options.delayMs) || 40);
  for (const f of SINGLETON_FILES) {
    const target = path.join(root, f);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await fsp.rm(target, { force: true, recursive: true });
        break;
      } catch (error) {
        if (!error || !["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(error.code)) break;
        if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, initialDelay * (attempt + 1)));
      }
    }
  }
}

function lifecycleTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(message);
        error.code = "LIFECYCLE_TIMEOUT";
        reject(error);
      }, Math.max(1, Number(timeoutMs) || 1));
    }),
  ]).finally(() => clearTimeout(timer));
}

function managedBrowserKillOptions(itemOrBrowser, root, launchBinary = null) {
  const browserPath = itemOrBrowser?.browser?.path || itemOrBrowser?.path || itemOrBrowser || null;
  const launch = launchBinary || itemOrBrowser?.launchBinary || null;
  const executables = [launch, browserPath, "OpenBrowser.bin", "OpenBrowser"].filter(Boolean);
  return {
    force: true,
    expectedExecutables: [...new Set(executables.map((v) => String(v)))],
    expectedUserDataDir: root || itemOrBrowser?.root || null,
  };
}

function systemBrowserCandidatesForPlatform(platform = process.platform, environment = process.env) {
  const home = environment.HOME || "";
  if (platform === "darwin") {
    return [
      { name: "Google Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { name: "Google Chrome", path: path.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome") },
      { name: "Chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
      { name: "Microsoft Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
    ];
  }
  if (platform === "linux") {
    return [
      { name: "Google Chrome", path: "/usr/bin/google-chrome" },
      { name: "Google Chrome", path: "/usr/bin/google-chrome-stable" },
      { name: "Chromium", path: "/usr/bin/chromium" },
      { name: "Chromium", path: "/usr/bin/chromium-browser" },
    ];
  }

  const windowsPath = path.win32;
  const programFiles = [
    environment.PROGRAMFILES,
    environment["PROGRAMFILES(X86)"],
    environment.PROGRAMW6432,
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ].filter(Boolean);
  const localAppData = environment.LOCALAPPDATA ? [environment.LOCALAPPDATA] : [];
  const roots = [...new Set([...programFiles, ...localAppData])];
  return [
    ...roots.map((root) => ({ name: "Google Chrome", path: windowsPath.join(root, "Google", "Chrome", "Application", "chrome.exe") })),
    ...roots.map((root) => ({ name: "Microsoft Edge", path: windowsPath.join(root, "Microsoft", "Edge", "Application", "msedge.exe") })),
  ].filter((item, index, all) => all.findIndex((other) => other.path.toLowerCase() === item.path.toLowerCase()) === index);
}

function stopIpcStubForWindow(windowName) {
  const win = String(windowName || "").trim();
  if (!win || process.platform === "win32") return false;
  if (!/^SB[0-9A-Za-z_-]{4,64}$/.test(win)) return false;
  try {
    const regexMode = process.platform === "darwin" ? ["-E"] : [];
    execFileSync("pkill", [...regexMode, "-f", `ipc-stub\\.py ${win}( |$)`], { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

async function assertExtensionTreeSafe(root) {
  const resolved = path.resolve(root);
  const rootStat = await fsp.lstat(resolved);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Extension root must be a real directory");
  const pending = [resolved];
  let entriesSeen = 0;
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      entriesSeen += 1;
      if (entriesSeen > 20000) throw new Error("Extension contains too many files");
      const target = path.join(current, entry.name);
      const stat = await fsp.lstat(target);
      if (stat.isSymbolicLink()) throw new Error("Extension must not contain symbolic links or junctions");
      if (stat.isDirectory()) pending.push(target);
    }
  }
  return fsp.realpath(resolved);
}

module.exports = {
  isChildExited,
  removeSingletonFiles,
  lifecycleTimeout,
  managedBrowserKillOptions,
  systemBrowserCandidatesForPlatform,
  stopIpcStubForWindow,
  assertExtensionTreeSafe,
};
