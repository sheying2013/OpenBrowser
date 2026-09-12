'use strict';

/**
 * Directory integrity manifest.
 *
 * Records the size and modification time of every file in a directory so a
 * later run can tell whether the contents were altered, truncated or removed.
 *
 * This is deliberately cheaper than hashing: for a directory holding a large
 * payload (an unpacked bundle, an extension, a cache) stat-ing every entry is
 * orders of magnitude faster than reading it. Pair it with a content digest
 * only when tampering resistance is required.
 *
 * Paths are stored relative to the root and normalised. That alone makes the
 * manifest relocatable, but modification times are recorded too, and copying a
 * directory to another machine normally rewrites them. Pass
 * `{ checkMtime: false }` when verifying a copy rather than the original
 * location; the size check still catches truncation and replacement with a
 * different-length payload.
 */

const fsp = require('fs/promises');
const path = require('path');

const MANIFEST_FILENAME = 'integrity_manifest.json';

/** Convert a platform path to a forward-slash form for stable comparisons. */
function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

/**
 * Recursively list files under `root`.
 *
 * @param {string} root
 * @param {{filter?:(relPath:string)=>boolean, maxEntries?:number}} [options]
 * @returns {Promise<string[]>} Relative POSIX paths, sorted.
 */
async function listFiles(root, options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : 20000;
  const out = [];

  async function walk(dir) {
    if (out.length >= maxEntries) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      const full = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, full));
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        if (typeof options.filter === 'function' && !options.filter(rel)) continue;
        out.push(rel);
      }
    }
  }

  await walk(root);
  return out.sort();
}

/**
 * Build a manifest describing every file under `root`.
 *
 * @param {string} root
 * @param {{filter?:(relPath:string)=>boolean, maxEntries?:number, exclude?:string[]}} [options]
 * @returns {Promise<{root:string, files:Array<{filePath:string,mtimeMs:number,size:number}>}>}
 */
async function buildManifest(root, options = {}) {
  const exclude = new Set(options.exclude || []);
  const filter = (rel) => {
    if (exclude.has(rel)) return false;
    if (typeof options.filter === 'function') return options.filter(rel);
    return true;
  };

  const files = [];
  for (const rel of await listFiles(root, Object.assign({}, options, { filter }))) {
    try {
      const stat = await fsp.stat(path.join(root, ...rel.split('/')));
      files.push({ filePath: rel, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (_) {
      // The file disappeared between listing and stat-ing; skip it.
    }
  }
  return { root, files };
}

/**
 * Compare a directory against a manifest.
 *
 * @param {string} root
 * @param {{files:Array<{filePath:string,mtimeMs:number,size:number}>}} manifest
 * @param {{checkMtime?:boolean, checkSize?:boolean}} [options]
 *   Disable `checkMtime` when verifying a relocated copy, since copying
 *   rewrites timestamps.
 * @returns {Promise<{ok:boolean, missing:string[], changed:string[], extra:string[], checked:number}>}
 */
async function verifyManifest(root, manifest, options = {}) {
  const checkMtime = options.checkMtime !== false;
  const checkSize = options.checkSize !== false;
  const expected = Array.isArray(manifest && manifest.files) ? manifest.files : [];
  const expectedMap = new Map(expected.map((entry) => [toPosix(entry.filePath), entry]));

  const actualPaths = new Set(await listFiles(root));
  const missing = [];
  const changed = [];

  for (const [rel, entry] of expectedMap) {
    if (!actualPaths.has(rel)) {
      missing.push(rel);
      continue;
    }
    try {
      const stat = await fsp.stat(path.join(root, ...rel.split('/')));
      const sizeChanged = checkSize
        && Number.isFinite(entry.size)
        && stat.size !== entry.size;
      const mtimeChanged = checkMtime
        && Number.isFinite(entry.mtimeMs)
        // Filesystems round timestamps; tolerate a small delta.
        && Math.abs(stat.mtimeMs - entry.mtimeMs) > 1;
      if (sizeChanged || mtimeChanged) changed.push(rel);
    } catch (_) {
      missing.push(rel);
    }
  }

  const extra = [...actualPaths].filter((rel) => !expectedMap.has(rel)).sort();

  return {
    ok: missing.length === 0 && changed.length === 0,
    missing: missing.sort(),
    changed: changed.sort(),
    extra,
    checked: expectedMap.size,
  };
}

/** Write a manifest next to the directory contents. */
async function writeManifest(root, manifest) {
  await fsp.mkdir(root, { recursive: true });
  const target = path.join(root, MANIFEST_FILENAME);
  await fsp.writeFile(target, JSON.stringify(manifest), 'utf8');
  return target;
}

/** Read a manifest, returning null when absent or unreadable. */
async function readManifest(root) {
  try {
    const raw = await fsp.readFile(path.join(root, MANIFEST_FILENAME), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * Convenience wrapper: create the manifest on first run, verify afterwards.
 *
 * @returns {Promise<{status:'created'|'ok'|'mismatch', report?:object}>}
 */
async function ensureManifest(root, options = {}) {
  const existing = await readManifest(root);
  if (!existing) {
    const manifest = await buildManifest(root, options);
    await writeManifest(root, manifest);
    return { status: 'created' };
  }
  const report = await verifyManifest(root, existing, options);
  if (!report.ok) {
    // Drop the stale manifest so the next call rebuilds it.
    await fsp.rm(path.join(root, MANIFEST_FILENAME), { force: true });
    return { status: 'mismatch', report };
  }
  return { status: 'ok', report };
}

module.exports = {
  buildManifest,
  verifyManifest,
  writeManifest,
  readManifest,
  ensureManifest,
  listFiles,
  toPosix,
  MANIFEST_FILENAME,
};
