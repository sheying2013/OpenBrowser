'use strict';

/**
 * Synthetic .crx builders shared by the reader's self-test and the host wiring
 * test. Everything is produced byte-by-byte here, so no fixture files and no
 * network access are involved.
 */

const zlib = require('zlib');
const crypto = require('crypto');

// ---------- builders ----------

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Build a zip archive from [{name, data, method}] entries. */
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const method = file.method === 'store' ? 0 : 8;
    const stored = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(stored.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    const local = Buffer.concat([lfh, nameBuf, stored]);
    locals.push(local);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(stored.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cdh, nameBuf]));

    offset += local.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

function writeVarint(value) {
  const out = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

function pbLengthDelimited(field, payload) {
  return Buffer.concat([writeVarint((field << 3) | 2), writeVarint(payload.length), payload]);
}

function pbMessage(field, obj) {
  return pbLengthDelimited(field, obj);
}

function buildCrx2(publicKey, signature, zipBuffer) {
  const header = Buffer.alloc(16);
  header.write('Cr24', 0, 'utf8');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(publicKey.length, 8);
  header.writeUInt32LE(signature.length, 12);
  return Buffer.concat([header, publicKey, signature, zipBuffer]);
}

function buildCrx3(publicKey, signature, zipBuffer, crxIdBytes, useEcdsa = false) {
  const proof = Buffer.concat([
    pbLengthDelimited(1, publicKey),
    pbLengthDelimited(2, signature),
  ]);
  const signedData = pbLengthDelimited(1, crxIdBytes);
  const header = Buffer.concat([
    pbMessage(useEcdsa ? 3 : 2, proof),
    pbMessage(10000, signedData),
  ]);
  const out = Buffer.alloc(12);
  out.write('Cr24', 0, 'utf8');
  out.writeUInt32LE(3, 4);
  out.writeUInt32LE(header.length, 8);
  return Buffer.concat([out, header, zipBuffer]);
}

/** Independent re-implementation of the id rule, used to cross-check. */
function expectedExtensionId(publicKey) {
  const digest = crypto.createHash('sha256').update(publicKey).digest();
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

module.exports = {
  crc32,
  buildZip,
  writeVarint,
  pbLengthDelimited,
  pbMessage,
  buildCrx2,
  buildCrx3,
  expectedExtensionId,
};
