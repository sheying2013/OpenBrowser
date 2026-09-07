"use strict";

const fsp = require("fs/promises");
const path = require("path");

const STARTUP_DIAGNOSTIC_LIMIT = 16 * 1024;

function appendDiagnosticOutput(current, chunk) {
  const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
  return (String(current || "") + value).slice(-STARTUP_DIAGNOSTIC_LIMIT);
}

function formatBrowserStartupError(error, child, diagnostic = {}) {
  const base = String(error?.message || error || "Browser startup failed").trim();
  if (base.includes("[executable=")) return base;
  const details = [];
  if (diagnostic.launchBinary) details.push(`executable=${diagnostic.launchBinary}`);
  if (diagnostic.profileRoot) details.push(`profile=${diagnostic.profileRoot}`);
  if (child?.pid) details.push(`pid=${child.pid}`);
  if (child?.exitCode !== null && child?.exitCode !== undefined) details.push(`exitCode=${child.exitCode}`);
  if (child?.signalCode) details.push(`signal=${child.signalCode}`);
  const output = [diagnostic.stderr, diagnostic.stdout]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (output.length) details.push(`browserOutput=${output.join(" | ")}`);
  return details.length ? `${base} [${details.join("; ")}]` : base;
}

async function writeBrowserStartupDiagnostic(userDataPath, record) {
  try {
    const logDir = path.join(userDataPath, "logs");
    await fsp.mkdir(logDir, { recursive: true });
    const file = path.join(logDir, "browser-startup.log");
    const line = JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n";
    await fsp.appendFile(file, line, "utf8");
    const stat = await fsp.stat(file);
    if (stat.size > 512 * 1024) {
      const content = await fsp.readFile(file, "utf8");
      await fsp.writeFile(file, content.slice(-256 * 1024), "utf8");
    }
  } catch (_) {}
}

module.exports = {
  STARTUP_DIAGNOSTIC_LIMIT,
  appendDiagnosticOutput,
  formatBrowserStartupError,
  writeBrowserStartupDiagnostic,
};
