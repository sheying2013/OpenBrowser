'use strict';

/**
 * Minimal, dependency-free ZIP reader.
 *
 * Reads the central directory to enumerate entries and extracts individual
 * entries by seeking to the matching local header. Supports the two methods
 * that appear in practice: stored (0) and deflate (8). Zip64 archives and
 * encrypted entries are rejected explicitly rather than silently misread.
 */

const zlib = require('zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;
const LFH_SIGNATURE = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const ZIP64_SENTINEL = 0xffffffff;

/** Locate the End Of Central Directory record, scanning back over any comment. */
function findEndOfCentralDirectory(buf) {
  if (buf.length < EOCD_MIN_SIZE) {
    throw new Error('zip too small');
  }
  const earliest = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let pos = buf.length - EOCD_MIN_SIZE; pos >= earliest; pos -= 1) {
    if (buf.readUInt32LE(pos) === EOCD_SIGNATURE) {
      const commentLength = buf.readUInt16LE(pos + 20);
      if (pos + EOCD_MIN_SIZE + commentLength <= buf.length) return pos;
    }
  }
  throw new Error('end of central directory not found');
}

/**
 * Parse the central directory into entry descriptors.
 * Sizes and offsets come from the central directory, which stays correct even
 * when entries use a trailing data descriptor.
 */
function readEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (cdOffset === ZIP64_SENTINEL || cdSize === ZIP64_SENTINEL || entryCount === 0xffff) {
    throw new Error('zip64 archives are not supported');
  }
  if (cdOffset + cdSize > buf.length) {
    throw new Error('central directory offset out of range');
  }

  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CD_SIGNATURE) {
      throw new Error(`corrupt central directory entry at ${pos}`);
    }
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const nameStart = pos + 46;

    if (nameStart + nameLength > buf.length) {
      throw new Error('corrupt entry name');
    }
    const name = buf.slice(nameStart, nameStart + nameLength).toString('utf8');

    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL
      || localHeaderOffset === ZIP64_SENTINEL) {
      throw new Error('zip64 entry is not supported');
    }
    if (flags & 0x0001) {
      throw new Error('encrypted zip entries are not supported');
    }

    entries.push({
      name,
      method,
      flags,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    pos = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Extract a single entry's bytes, inflating deflate entries. */
function readEntry(buf, entry) {
  const pos = entry.localHeaderOffset;
  if (pos + 30 > buf.length || buf.readUInt32LE(pos) !== LFH_SIGNATURE) {
    throw new Error(`corrupt local header for ${entry.name}`);
  }
  const nameLength = buf.readUInt16LE(pos + 26);
  const extraLength = buf.readUInt16LE(pos + 28);
  const dataStart = pos + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) {
    throw new Error(`entry data out of range for ${entry.name}`);
  }

  const raw = buf.slice(dataStart, dataEnd);
  if (entry.method === METHOD_STORE) return Buffer.from(raw);
  if (entry.method === METHOD_DEFLATE) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}

/** Open an archive: exposes entry listing plus name-based lookup. */
function open(buf) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('zip buffer required');
  const entries = readEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));

  return {
    entries: entries.map((e) => ({
      name: e.name,
      size: e.uncompressedSize,
      compressedSize: e.compressedSize,
      method: e.method,
    })),
    has(name) {
      return byName.has(name);
    },
    read(name) {
      const entry = byName.get(name);
      if (!entry) throw new Error(`entry not found: ${name}`);
      return readEntry(buf, entry);
    },
    readText(name, encoding = 'utf8') {
      return this.read(name).toString(encoding);
    },
    readJson(name) {
      return JSON.parse(this.readText(name));
    },
    /** Case-insensitive lookup, since manifest.json casing can vary in the wild. */
    find(searchedName) {
      const lower = String(searchedName).toLowerCase();
      const hit = entries.find((e) => e.name.toLowerCase() === lower)
        || entries.find((e) => e.name.toLowerCase().endsWith(`/${lower}`));
      return hit ? hit.name : null;
    },
  };
}

module.exports = {
  open,
  readEntries,
  readEntry,
  findEndOfCentralDirectory,
  METHOD_STORE,
  METHOD_DEFLATE,
  EOCD_SIGNATURE,
  CD_SIGNATURE,
  LFH_SIGNATURE,
};
