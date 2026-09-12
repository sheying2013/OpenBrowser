'use strict';

/**
 * Chrome extension package (.crx) reader.
 *
 * Parses both container revisions:
 *
 *   v2  "Cr24" | u32 version | u32 pubkey_len | u32 sig_len | pubkey | sig | zip
 *   v3  "Cr24" | u32 version | u32 header_len | CrxFileHeader(protobuf)     | zip
 *
 * The v3 header is decoded with a small protobuf reader, so no external
 * parsing library is required. The embedded ZIP is exposed as a buffer and
 * can be inspected with the project's own zip reader.
 */

const crypto = require('crypto');
const zipReader = require('./zip-reader');

const MAGIC = 'Cr24';
const HEADER_SIZE_V2 = 16;

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_32BIT = 5;

// Field numbers inside CrxFileHeader.
const FIELD_SHA256_RSA = 2;
const FIELD_SHA256_ECDSA = 3;
const FIELD_SIGNED_HEADER_DATA = 10000;
// Field numbers inside AsymmetricKeyProof and SignedData.
const FIELD_PUBLIC_KEY = 1;
const FIELD_SIGNATURE = 2;
const FIELD_CRX_ID = 1;

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let cursor = pos;
  while (cursor < buf.length) {
    const byte = buf[cursor];
    cursor += 1;
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) return { value: result, next: cursor };
    shift += 7;
    if (shift > 63) throw new Error('varint too long');
  }
  throw new Error('truncated varint');
}

/** Decode a protobuf payload into a flat list of fields. */
function decodeProtobuf(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.next;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value & 0x07;

    if (wireType === WIRE_VARINT) {
      const v = readVarint(buf, pos);
      pos = v.next;
      fields.push({ field: fieldNumber, wireType, value: v.value });
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      const len = readVarint(buf, pos);
      pos = len.next;
      const end = pos + len.value;
      if (end > buf.length) throw new Error('truncated length-delimited field');
      fields.push({ field: fieldNumber, wireType, data: buf.slice(pos, end) });
      pos = end;
    } else if (wireType === WIRE_64BIT) {
      pos += 8;
      fields.push({ field: fieldNumber, wireType, value: null });
    } else if (wireType === WIRE_32BIT) {
      pos += 4;
      fields.push({ field: fieldNumber, wireType, value: null });
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
    if (pos > buf.length) throw new Error('protobuf field out of range');
  }
  return fields;
}

function firstField(fields, number) {
  return fields.find((f) => f.field === number);
}

/**
 * Map 16 raw id bytes onto the 32-character id alphabet (a-p).
 * Each byte contributes two characters, high nibble first.
 */
function extensionIdFromBytes(idBytes) {
  const buf = Buffer.isBuffer(idBytes) ? idBytes : Buffer.from(idBytes || []);
  if (buf.length < 16) throw new Error('extension id requires 16 bytes');
  const alphabetStart = 'a'.charCodeAt(0);
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    id += String.fromCharCode(alphabetStart + (buf[i] >> 4));
    id += String.fromCharCode(alphabetStart + (buf[i] & 0x0f));
  }
  return id;
}

/**
 * Derive the 32-character extension id from a DER public key.
 * The id is the first 16 bytes of SHA-256 over the key, remapped onto a-p.
 */
function extensionIdFromPublicKey(publicKey) {
  const keyBuf = Buffer.isBuffer(publicKey)
    ? publicKey
    : Buffer.from(String(publicKey), 'base64');
  const digest = crypto.createHash('sha256').update(keyBuf).digest();
  return extensionIdFromBytes(digest.slice(0, 16));
}

function readContainerVersion(buf) {
  if (buf.length < 12) throw new Error('crx too small');
  if (buf.slice(0, 4).toString('utf8') !== MAGIC) {
    throw new Error('not a crx package');
  }
  const version = buf.readUInt32LE(4);
  if (version !== 2 && version !== 3) {
    throw new Error(`unsupported crx version ${version}`);
  }
  return version;
}

function parseV2(buf) {
  if (buf.length < HEADER_SIZE_V2) throw new Error('crx2 header truncated');
  const publicKeyLength = buf.readUInt32LE(8);
  const signatureLength = buf.readUInt32LE(12);
  const keyStart = HEADER_SIZE_V2;
  const keyEnd = keyStart + publicKeyLength;
  const sigEnd = keyEnd + signatureLength;
  if (sigEnd > buf.length) throw new Error('crx2 payload out of range');

  const publicKey = buf.slice(keyStart, keyEnd);
  const signature = buf.slice(keyEnd, sigEnd);
  return {
    version: 2,
    publicKey,
    signature,
    algorithm: null,
    signedHeaderData: null,
    zipBuffer: buf.slice(sigEnd),
  };
}

function parseV3(buf) {
  if (buf.length < 12) throw new Error('crx3 header truncated');
  const headerLength = buf.readUInt32LE(8);
  const headerStart = 12;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > buf.length) throw new Error('crx3 header out of range');

  const headerFields = decodeProtobuf(buf.slice(headerStart, headerEnd));

  let publicKey = null;
  let signature = null;
  let algorithm = null;

  const candidates = [
    { fields: headerFields.filter((f) => f.field === FIELD_SHA256_RSA), algorithm: 'RSA-SHA256' },
    { fields: headerFields.filter((f) => f.field === FIELD_SHA256_ECDSA), algorithm: 'ecdsa-with-SHA256' },
  ];

  for (const candidate of candidates) {
    for (const proof of candidate.fields) {
      if (!proof.data) continue;
      const proofFields = decodeProtobuf(proof.data);
      const keyField = firstField(proofFields, FIELD_PUBLIC_KEY);
      const sigField = firstField(proofFields, FIELD_SIGNATURE);
      if (keyField && keyField.data) {
        publicKey = keyField.data;
        signature = sigField && sigField.data ? sigField.data : null;
        algorithm = candidate.algorithm;
        break;
      }
    }
    if (publicKey) break;
  }

  const signedField = firstField(headerFields, FIELD_SIGNED_HEADER_DATA);
  let signedHeaderData = null;
  let declaredCrxId = null;
  if (signedField && signedField.data) {
    signedHeaderData = signedField.data;
    const signedFields = decodeProtobuf(signedHeaderData);
    const idField = firstField(signedFields, FIELD_CRX_ID);
    if (idField && idField.data) declaredCrxId = idField.data;
  }

  return {
    version: 3,
    publicKey,
    signature,
    algorithm,
    signedHeaderData,
    declaredCrxId,
    zipBuffer: buf.slice(headerEnd),
  };
}

/**
 * Parse a .crx buffer.
 * @returns {{version:number, publicKey:Buffer|null, signature:Buffer|null,
 *            algorithm:string|null, extensionId:string|null, declaredCrxId:string|null,
 *            zipBuffer:Buffer}}
 */
function parseCrx(buf) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('crx buffer required');
  const version = readContainerVersion(buf);
  const parsed = version === 2 ? parseV2(buf) : parseV3(buf);

  const extensionId = parsed.publicKey ? extensionIdFromPublicKey(parsed.publicKey) : null;
  // The signed header already carries the id bytes; do not hash them again.
  const declaredCrxId = parsed.declaredCrxId
    ? extensionIdFromBytes(parsed.declaredCrxId)
    : null;

  return Object.assign({}, parsed, { extensionId, declaredCrxId });
}

/** Read manifest.json from a crx payload without unpacking the whole archive. */
function readManifest(zipBuffer) {
  const archive = zipReader.open(zipBuffer);
  const name = archive.find('manifest.json');
  if (!name) throw new Error('manifest.json not found in crx payload');
  return JSON.parse(archive.readText(name));
}

function readVersion(zipBuffer) {
  try {
    const manifest = readManifest(zipBuffer);
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch (_) {
    return null;
  }
}

/**
 * Verify that a package matches the expected extension id and, for v3, that
 * the declared id matches the signing key. Signature verification against the
 * public key is left to the caller, which can use crypto.createVerify with the
 * returned data.
 */
function validate(buf, expectedExtensionId) {
  const result = { success: true, errorMessage: '', parsed: null };
  try {
    const parsed = parseCrx(buf);
    result.parsed = parsed;
    if (!parsed.publicKey) {
      result.success = false;
      result.errorMessage = 'no public key in crx package';
      return result;
    }
    if (expectedExtensionId && parsed.extensionId !== expectedExtensionId) {
      result.success = false;
      result.errorMessage = `extension id mismatch: got ${parsed.extensionId}, expected ${expectedExtensionId}`;
      return result;
    }
    if (parsed.version === 3 && parsed.declaredCrxId && parsed.declaredCrxId !== parsed.extensionId) {
      result.success = false;
      result.errorMessage = 'declared crx id does not match signing key';
      return result;
    }
  } catch (err) {
    result.success = false;
    result.errorMessage = err && err.message ? err.message : String(err);
  }
  return result;
}

/** Data needed to verify a v3 signature with node crypto. */
function signaturePayload(parsed) {
  if (!parsed || !parsed.signature || !parsed.publicKey) return null;
  const crxId = parsed.declaredCrxId || extensionIdToBytes(parsed.extensionId);
  const digest = crxId ? crypto.createHash('sha256').update(crxId).digest() : null;
  return {
    algorithm: parsed.algorithm,
    publicKey: parsed.publicKey,
    signature: parsed.signature,
    signedHeaderData: parsed.signedHeaderData,
    crxIdDigest: digest,
  };
}

/** Convert a 32-character extension id back to its 16 raw bytes. */
function extensionIdToBytes(extensionId) {
  if (!extensionId || extensionId.length !== 32) return null;
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 1) {
    const hi = extensionId.charCodeAt(i * 2) - 97;
    const lo = extensionId.charCodeAt(i * 2 + 1) - 97;
    if (hi < 0 || hi > 15 || lo < 0 || lo > 15) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/**
 * List the files inside a crx payload.
 */
function listFiles(zipBuffer) {
  return zipReader.open(zipBuffer).entries;
}

/**
 * Read one file from a crx payload by path.
 */
function readFile(zipBuffer, filePath) {
  const archive = zipReader.open(zipBuffer);
  const name = archive.find(filePath);
  if (!name) throw new Error(`file not found in crx payload: ${filePath}`);
  return archive.read(name);
}

/** Ensure manifest.json carries the signing key so the id stays stable. */
function withManifestKey(manifest, publicKey) {
  const out = Object.assign({}, manifest);
  if (!out.key && publicKey) {
    out.key = Buffer.isBuffer(publicKey) ? publicKey.toString('base64') : String(publicKey);
  }
  return out;
}

module.exports = {
  parseCrx,
  validate,
  readManifest,
  readVersion,
  readFile,
  listFiles,
  withManifestKey,
  signaturePayload,
  extensionIdFromPublicKey,
  extensionIdFromBytes,
  extensionIdToBytes,
  decodeProtobuf,
  readContainerVersion,
  MAGIC,
};
