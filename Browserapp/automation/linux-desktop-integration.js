'use strict';

/**
 * Desktop integration for a self-mounting Linux bundle.
 *
 * A bundled application mounts to a temporary directory for the lifetime of
 * the process. Two things follow from that, and both show up to the user as a
 * generic placeholder icon:
 *
 *   - The window's `WM_CLASS` is derived from `argv[0]`, which for a bundle is
 *     the bundle path. It will never match the `StartupWMClass` that the
 *     packaged entry declares, so the shell cannot associate the window with
 *     the launcher.
 *   - The shell has no installed desktop entry and no cached thumbnail to
 *     read, so file managers fall back to the MIME default.
 *
 * This module writes the two artifacts that fix that — a user-level desktop
 * entry and a freedesktop thumbnail — plus the `argv[0]` adjustment that makes
 * the running window match them.
 *
 * The thumbnail cache has a naming rule and a metadata requirement that are
 * easy to get wrong: the file name is the MD5 of the *URI*, and the PNG must
 * carry `Thumb::URI` and `Thumb::MTime` text chunks, or cache readers treat it
 * as stale and regenerate it on every listing.
 *
 * Every path, the image encoder and the clock are injectable so this can be
 * tested without touching a real home directory.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');

const { buildDesktopEntry, quoteExecPath } = require('./linux-autostart');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Thumbnail sizes named by the freedesktop specification. */
const THUMBNAIL_SIZES = Object.freeze({
  normal: 128,
  large: 256,
  'x-large': 512,
  'xx-large': 1024,
});

const DEFAULT_THUMBNAIL_SIZES = Object.freeze(['normal', 'large']);

/* ------------------------------------------------------------------ *
 * PNG text chunks
 * ------------------------------------------------------------------ */

/** Build one PNG chunk: length, type, data, CRC over type+data. */
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** Build a `tEXt` chunk holding one keyword/value pair. */
function pngTextChunk(keyword, value) {
  const data = Buffer.concat([
    Buffer.from(String(keyword), 'latin1'),
    Buffer.from([0]),
    Buffer.from(String(value), 'latin1'),
  ]);
  return pngChunk('tEXt', data);
}

/**
 * Insert `tEXt` chunks directly after `IHDR`.
 *
 * The bytes are otherwise untouched, so the image data and its checksums stay
 * valid. A buffer that is not a PNG, or whose first chunk is not `IHDR`, is
 * returned unchanged rather than corrupted.
 *
 * @param {Buffer|Uint8Array} png
 * @param {Array<[string, string]>} fields
 * @returns {Buffer}
 */
function insertPngTextChunks(png, fields) {
  const buf = Buffer.isBuffer(png) ? png : Buffer.from(png || []);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return buf;
  if (buf.length < 8 + 8 + 4) return buf;
  const ihdrLength = buf.readUInt32BE(8);
  const ihdrEnd = 8 + 4 + 4 + ihdrLength + 4;
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR' || ihdrEnd > buf.length) return buf;
  if (!Array.isArray(fields) || fields.length === 0) return buf;
  const inserted = fields
    .filter((pair) => Array.isArray(pair) && pair.length === 2 && pair[0] != null && pair[1] != null)
    .map(([keyword, value]) => pngTextChunk(keyword, value));
  if (inserted.length === 0) return buf;
  return Buffer.concat([buf.subarray(0, ihdrEnd), ...inserted, buf.subarray(ihdrEnd)]);
}

/**
 * Read the pixel dimensions from the `IHDR` chunk.
 * Returns null when the buffer is not a PNG this module can interpret.
 *
 * @param {Buffer|Uint8Array} png
 * @returns {{width:number, height:number}|null}
 */
function pngDimensions(png) {
  const buf = Buffer.isBuffer(png) ? png : Buffer.from(png || []);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Read the `tEXt` chunks back out. Used to verify what was written.
 *
 * @param {Buffer|Uint8Array} png
 * @returns {Record<string,string>}
 */
function readPngTextChunks(png) {
  const buf = Buffer.isBuffer(png) ? png : Buffer.from(png || []);
  const out = {};
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return out;
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) break;
    if (type === 'tEXt') {
      const data = buf.subarray(dataStart, dataEnd);
      const sep = data.indexOf(0);
      if (sep > 0) {
        out[data.subarray(0, sep).toString('latin1')] = data.subarray(sep + 1).toString('latin1');
      }
    }
    if (type === 'IEND') break;
    offset = dataEnd + 4;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Thumbnail cache
 * ------------------------------------------------------------------ */

/** Convert an absolute filesystem path to the URI form the cache keys on. */
function pathToUri(absolutePath) {
  return pathToFileURL(String(absolutePath)).href;
}

/**
 * Thumbnail file name for a URI: the MD5 of that URI with a `.png` suffix.
 *
 * @param {string} uri
 * @returns {string}
 */
function thumbnailFileName(uri) {
  return crypto.createHash('md5').update(String(uri), 'utf8').digest('hex') + '.png';
}

/** Cache root, honouring `XDG_CACHE_HOME`. */
function thumbnailCacheRoot(options = {}) {
  const env = options.env || process.env;
  const home = options.home || process.env.HOME || '';
  const xdg = typeof env.XDG_CACHE_HOME === 'string' ? env.XDG_CACHE_HOME.trim() : '';
  return path.join(xdg || path.join(home, '.cache'), 'thumbnails');
}

/** Full path of a cached thumbnail. */
function thumbnailPath(uri, size, options = {}) {
  const bucket = THUMBNAIL_SIZES[size] ? size : 'normal';
  return path.join(thumbnailCacheRoot(options), bucket, thumbnailFileName(uri));
}

/**
 * Attach the metadata a cache reader needs to accept a thumbnail as current.
 *
 * @param {Buffer} png
 * @param {{uri:string, mtimeMs?:number, width?:number, height?:number, software?:string}} meta
 * @returns {Buffer}
 */
function buildThumbnailPng(png, meta = {}) {
  const fields = [];
  if (meta.uri) fields.push(['Thumb::URI', meta.uri]);
  if (meta.mtimeMs != null) {
    const seconds = Math.floor(Number(meta.mtimeMs) / 1000);
    if (Number.isFinite(seconds)) fields.push(['Thumb::MTime', String(seconds)]);
  }
  if (meta.width) fields.push(['Thumb::Image::Width', String(meta.width)]);
  if (meta.height) fields.push(['Thumb::Image::Height', String(meta.height)]);
  if (meta.software) fields.push(['Software', meta.software]);
  return insertPngTextChunks(png, fields);
}

/**
 * Write the thumbnail cache entries for a file.
 *
 * @param {{sourcePath:string, targetPath?:string, mtimeMs?:number, sizes?:string[],
 *          resize?:Function, env?:object, home?:string, fsModule?:object,
 *          software?:string}} options
 * @returns {{written:Array<{size:string, path:string, width:number}>}}
 */
function writeThumbnailCache(options = {}) {
  const io = options.fsModule || fs;
  const sourcePath = options.sourcePath;
  if (!sourcePath) throw new Error('sourcePath is required');
  const targetPath = options.targetPath || sourcePath;
  const uri = pathToUri(targetPath);
  const mtimeMs = options.mtimeMs != null
    ? Number(options.mtimeMs)
    : (io.statSync ? Number(io.statSync(targetPath).mtimeMs) : Date.now());
  const sizes = Array.isArray(options.sizes) && options.sizes.length
    ? options.sizes.filter((s) => THUMBNAIL_SIZES[s])
    : DEFAULT_THUMBNAIL_SIZES;
  if (sizes.length === 0) throw new Error('no known thumbnail size requested');

  const resize = options.resize;
  if (typeof resize !== 'function') throw new Error('resize(sourcePath, width) is required');
  const source = io.readFileSync(sourcePath);

  const written = [];
  for (const size of sizes) {
    const width = THUMBNAIL_SIZES[size];
    const scaled = resize(source, width);
    if (!scaled) continue;
    // Report the size the encoder actually produced. A scaler that clamps or
    // substitutes an image would otherwise leave the cache claiming a size it
    // does not have, which is how a reader decides a thumbnail is stale.
    const actual = pngDimensions(scaled) || { width, height: width };
    const png = buildThumbnailPng(scaled, {
      uri,
      mtimeMs,
      width: actual.width,
      height: actual.height,
      software: options.software,
    });
    const dest = thumbnailPath(uri, size, options);
    io.mkdirSync(path.dirname(dest), { recursive: true });
    io.writeFileSync(dest, png);
    written.push({ size, path: dest, width });
  }
  return { written };
}

/* ------------------------------------------------------------------ *
 * User-level desktop entry
 * ------------------------------------------------------------------ */

/** Directory holding user-level application entries. */
function applicationsDirectory(options = {}) {
  const env = options.env || process.env;
  const home = options.home || process.env.HOME || '';
  const xdg = typeof env.XDG_DATA_HOME === 'string' ? env.XDG_DATA_HOME.trim() : '';
  return path.join(xdg || path.join(home, '.local', 'share'), 'applications');
}

/** Full path of the user-level application entry. */
function applicationEntryPath(options = {}) {
  const name = options.entryName || 'openbrowser-appimage-user.desktop';
  return path.join(applicationsDirectory(options), name);
}

/**
 * Write the user-level desktop entry that gives a bundled launch a name, an
 * icon and a `WM_CLASS` the shell can match.
 *
 * `NoDisplay=true` keeps it out of the application list while leaving it
 * available for window association, which is the point of the entry.
 *
 * @returns {{path:string, contents:string}}
 */
function installApplicationEntry(options = {}) {
  const io = options.fsModule || fs;
  const binary = options.binary;
  if (!binary) throw new Error('binary is required');
  const name = String(options.name || 'OpenBrowser');
  const iconPath = options.iconPath || null;

  const contents = buildDesktopEntry({
    name,
    // `%U` marks the entry as accepting URLs, matching the packaged entry.
    exec: `${quoteExecPath(binary)} %U`,
    icon: iconPath ? iconPath.replace(/\\/g, '/') : undefined,
    startupWMClass: options.startupWMClass || name,
    categories: options.categories,
    noDisplay: options.noDisplay !== false,
  });

  const entryPath = applicationEntryPath(options);
  io.mkdirSync(path.dirname(entryPath), { recursive: true });
  io.writeFileSync(entryPath, contents, { encoding: 'utf8', mode: 0o644 });
  return { path: entryPath, contents };
}

/**
 * Value the process should report as `argv[0]` so the toolkit derives the
 * expected `WM_CLASS`.
 *
 * Returns null when the adjustment does not apply, which keeps the caller from
 * rewriting `argv[0]` on a packaged install or another platform.
 *
 * @param {{platform?:string, env?:object, name?:string}} [options]
 * @returns {string|null}
 */
function desktopFileArgv0(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (platform !== 'linux') return null;
  if (!env || !env.APPIMAGE) return null;
  const name = String(options.name || 'OpenBrowser').trim();
  return name || null;
}

module.exports = {
  pngChunk,
  pngTextChunk,
  insertPngTextChunks,
  readPngTextChunks,
  pngDimensions,
  pathToUri,
  thumbnailFileName,
  thumbnailCacheRoot,
  thumbnailPath,
  buildThumbnailPng,
  writeThumbnailCache,
  applicationsDirectory,
  applicationEntryPath,
  installApplicationEntry,
  desktopFileArgv0,
  THUMBNAIL_SIZES,
  DEFAULT_THUMBNAIL_SIZES,
  PNG_SIGNATURE,
};
