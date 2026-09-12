"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const TRANSIENT_WRITE_ERRORS = new Set(["ENOENT", "EEXIST", "EINVAL", "EBUSY", "EAGAIN"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeRawAtomically(filePath, value, mode = 0o600) {
  const directory = path.dirname(filePath);
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await fsp.mkdir(directory, { recursive: true });
    const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    let handle = null;
    try {
      handle = await fsp.open(temporary, "wx", mode);
      await handle.writeFile(value, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(temporary, filePath);
      try {
        const directoryHandle = await fsp.open(directory, "r");
        await directoryHandle.sync();
        await directoryHandle.close();
      } catch (_) {}
      return;
    } catch (error) {
      lastError = error;
      if (handle) await handle.close().catch(() => {});
      await fsp.rm(temporary, { force: true }).catch(() => {});
      if (!TRANSIENT_WRITE_ERRORS.has(error?.code) || attempt === 3) throw error;
      await sleep(5 * (attempt + 1));
    }
  }
  throw lastError || new Error("atomic write failed");
}

async function writeJsonAtomically(filePath, value, mode = 0o600) {
  let previous = null;
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    JSON.parse(raw);
    previous = raw;
  } catch (error) {
    if (error.code === "ENOENT") previous = null;
  }
  if (previous != null) await writeRawAtomically(`${filePath}.bak`, previous, mode);
  await writeRawAtomically(filePath, value, mode);
}

async function readEngineStateCandidate(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  const saved = JSON.parse(raw);
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
    throw new Error("引擎状态文件格式无效");
  }
  return { path: filePath, saved };
}

async function engineStateRecoveryCandidates(filePath) {
  const directory = path.dirname(filePath);
  const base = path.basename(filePath);
  let names = [];
  try {
    names = await fsp.readdir(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const candidates = [
    `${filePath}.bak`,
    `${filePath}.tmp`,
    ...names.filter((name) => name.startsWith(base + ".tmp-")).map((name) => path.join(directory, name)),
  ];
  const valid = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const state = await readEngineStateCandidate(candidate);
      const stat = await fsp.stat(candidate);
      valid.push({ ...state, mtimeMs: stat.mtimeMs });
    } catch (_) {}
  }
  return valid.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function preserveCorruptEngineState(filePath) {
  const target = `${filePath}.corrupt-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fsp.rename(filePath, target);
    return target;
  } catch (_) {
    return null;
  }
}

module.exports = {
  writeRawAtomically,
  writeJsonAtomically,
  readEngineStateCandidate,
  engineStateRecoveryCandidates,
  preserveCorruptEngineState,
};
