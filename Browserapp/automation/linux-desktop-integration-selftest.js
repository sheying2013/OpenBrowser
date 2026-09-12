'use strict';

/**
 * Self-test for Linux desktop integration.
 * Paths and file writes go through an in-memory double; the PNG fixtures are
 * real images so chunk-level integrity is actually exercised.
 */

const assert = require('assert');
const path = require('path');
const zlib = require('zlib');
const d = require('./linux-desktop-integration');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

/** A genuine 1x1 RGBA PNG, built the same way an encoder would. */
function tinyPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  return Buffer.concat([
    d.PNG_SIGNATURE,
    d.pngChunk('IHDR', ihdr),
    d.pngChunk('IDAT', idat),
    d.pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Walk the chunks and assert every CRC matches its type+data. */
function assertValidPng(png) {
  assert.ok(png.subarray(0, 8).equals(d.PNG_SIGNATURE), 'signature intact');
  let offset = 8;
  const seen = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= png.length, `chunk ${type} runs past the end`);
    const stored = png.readUInt32BE(dataEnd);
    const computed = zlib.crc32(png.subarray(offset + 4, dataEnd)) >>> 0;
    assert.strictEqual(stored, computed, `CRC mismatch on ${type}`);
    seen.push(type);
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  assert.strictEqual(offset, png.length, 'no trailing bytes');
  return seen;
}

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  return {
    files,
    dirs,
    readFileSync(p) {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    writeFileSync(p, data) { files.set(p, Buffer.isBuffer(data) ? data : String(data)); },
    mkdirSync(p) { dirs.add(p); },
    statSync(p) { return { mtimeMs: Number(p.length) * 1000 }; },
  };
}

// ---- png plumbing ----

check('a generated fixture is a structurally valid png', () => {
  assert.deepStrictEqual(assertValidPng(tinyPng()), ['IHDR', 'IDAT', 'IEND']);
});

check('tEXt chunks carry keyword, separator and value', () => {
  const chunk = d.pngTextChunk('Thumb::URI', 'file:///a');
  assert.strictEqual(chunk.subarray(4, 8).toString('latin1'), 'tEXt');
  const data = chunk.subarray(8, chunk.length - 4);
  const sep = data.indexOf(0);
  assert.strictEqual(data.subarray(0, sep).toString('latin1'), 'Thumb::URI');
  assert.strictEqual(data.subarray(sep + 1).toString('latin1'), 'file:///a');
});

check('inserted chunks land directly after IHDR and keep the image valid', () => {
  const out = d.insertPngTextChunks(tinyPng(), [['Thumb::URI', 'file:///x']]);
  const order = assertValidPng(out);
  assert.deepStrictEqual(order, ['IHDR', 'tEXt', 'IDAT', 'IEND']);
});

check('insertion preserves the original image bytes', () => {
  const source = tinyPng();
  const out = d.insertPngTextChunks(source, [['A', '1']]);
  assert.ok(out.length > source.length);
  // Everything from the first original chunk after IHDR survives untouched.
  const ihdrEnd = 8 + 4 + 4 + source.readUInt32BE(8) + 4;
  assert.ok(out.subarray(out.length - (source.length - ihdrEnd)).equals(source.subarray(ihdrEnd)),
    'IDAT and IEND bytes are unchanged');
});

check('several fields produce several chunks, all valid', () => {
  const out = d.insertPngTextChunks(tinyPng(), [['A', '1'], ['B', '2'], ['C', '3']]);
  const order = assertValidPng(out);
  assert.strictEqual(order.filter((c) => c === 'tEXt').length, 3);
});

check('text chunks round-trip through the reader', () => {
  const out = d.insertPngTextChunks(tinyPng(), [['Thumb::URI', 'file:///a b'], ['Software', 'x']]);
  assert.deepStrictEqual(d.readPngTextChunks(out), { 'Thumb::URI': 'file:///a b', Software: 'x' });
});

check('a non-png buffer is returned untouched instead of corrupted', () => {
  const junk = Buffer.from('not a png at all');
  assert.ok(d.insertPngTextChunks(junk, [['A', '1']]).equals(junk));
  assert.deepStrictEqual(d.readPngTextChunks(junk), {});
});

check('a png missing its IHDR is returned untouched', () => {
  const broken = Buffer.concat([d.PNG_SIGNATURE, d.pngChunk('IDAT', Buffer.from([1, 2, 3]))]);
  assert.ok(d.insertPngTextChunks(broken, [['A', '1']]).equals(broken));
});

check('empty or malformed field lists leave the image alone', () => {
  const source = tinyPng();
  assert.ok(d.insertPngTextChunks(source, []).equals(source));
  assert.ok(d.insertPngTextChunks(source, null).equals(source));
  assert.ok(d.insertPngTextChunks(source, [['only-key']]).equals(source));
  assert.ok(d.insertPngTextChunks(source, [[null, 'v']]).equals(source));
});

// ---- thumbnail metadata ----

check('thumbnail metadata records the uri and whole seconds of mtime', () => {
  const out = d.buildThumbnailPng(tinyPng(), {
    uri: 'file:///home/u/App.AppImage',
    mtimeMs: 1700000000123,
    width: 128,
    height: 128,
    software: 'OpenBrowser',
  });
  assertValidPng(out);
  const meta = d.readPngTextChunks(out);
  assert.strictEqual(meta['Thumb::URI'], 'file:///home/u/App.AppImage');
  assert.strictEqual(meta['Thumb::MTime'], '1700000000', 'mtime is truncated to seconds');
  assert.strictEqual(meta['Thumb::Image::Width'], '128');
  assert.strictEqual(meta['Thumb::Image::Height'], '128');
  assert.strictEqual(meta.Software, 'OpenBrowser');
});

check('thumbnail metadata omits fields it was not given', () => {
  const meta = d.readPngTextChunks(d.buildThumbnailPng(tinyPng(), { uri: 'file:///a' }));
  assert.strictEqual(meta['Thumb::URI'], 'file:///a');
  assert.strictEqual(meta['Thumb::MTime'], undefined);
  assert.strictEqual(meta['Thumb::Image::Width'], undefined);
});

// ---- thumbnail naming and placement ----

check('the thumbnail file name is the md5 of the uri', () => {
  const uri = 'file:///home/u/Apps/OpenBrowser.AppImage';
  const expected = require('crypto').createHash('md5').update(uri, 'utf8').digest('hex') + '.png';
  assert.strictEqual(d.thumbnailFileName(uri), expected);
  assert.match(d.thumbnailFileName(uri), /^[0-9a-f]{32}\.png$/);
});

check('the cache root honours XDG_CACHE_HOME and falls back to ~/.cache', () => {
  assert.strictEqual(
    d.thumbnailCacheRoot({ env: { XDG_CACHE_HOME: '/custom/cache' }, home: '/home/u' }),
    path.join('/custom/cache', 'thumbnails'),
  );
  assert.strictEqual(
    d.thumbnailCacheRoot({ env: {}, home: '/home/u' }),
    path.join('/home/u', '.cache', 'thumbnails'),
  );
});

check('a thumbnail path is bucketed by the named size', () => {
  const uri = 'file:///x';
  assert.ok(d.thumbnailPath(uri, 'normal', { env: {}, home: '/h' }).includes(path.join('thumbnails', 'normal')));
  assert.ok(d.thumbnailPath(uri, 'large', { env: {}, home: '/h' }).includes(path.join('thumbnails', 'large')));
  assert.ok(d.thumbnailPath(uri, 'not-a-size', { env: {}, home: '/h' }).includes(path.join('thumbnails', 'normal')),
    'an unknown size falls back rather than throwing');
});

check('the spec sizes are the ones the desktop looks for', () => {
  assert.strictEqual(d.THUMBNAIL_SIZES.normal, 128);
  assert.strictEqual(d.THUMBNAIL_SIZES.large, 256);
  assert.deepStrictEqual([...d.DEFAULT_THUMBNAIL_SIZES], ['normal', 'large']);
});

// ---- thumbnail writing ----

check('writing the cache produces both buckets, each with metadata', () => {
  const io = memoryFs({ '/src/icon.png': tinyPng() });
  const requested = [];
  const resize = (buf, width) => {
    assert.ok(Buffer.isBuffer(buf), 'resize receives the source bytes');
    requested.push(width);
    return tinyPng();
  };
  const res = d.writeThumbnailCache({
    sourcePath: '/src/icon.png',
    targetPath: '/home/u/Apps/OpenBrowser.AppImage',
    mtimeMs: 1700000000000,
    resize,
    env: { XDG_CACHE_HOME: '/cache' },
    home: '/home/u',
    fsModule: io,
    software: 'OpenBrowser',
  });

  assert.strictEqual(res.written.length, 2);
  const uri = d.pathToUri('/home/u/Apps/OpenBrowser.AppImage');
  const name = d.thumbnailFileName(uri);
  const normalPath = path.join('/cache', 'thumbnails', 'normal', name);
  const largePath = path.join('/cache', 'thumbnails', 'large', name);
  assert.strictEqual(res.written[0].path, normalPath);
  assert.strictEqual(res.written[1].path, largePath);
  assert.ok(io.dirs.has(path.join('/cache', 'thumbnails', 'normal')));
  assert.ok(io.dirs.has(path.join('/cache', 'thumbnails', 'large')));

  const meta = d.readPngTextChunks(io.files.get(largePath));
  assert.strictEqual(meta['Thumb::URI'], uri);
  assert.strictEqual(meta['Thumb::MTime'], '1700000000');
  assert.deepStrictEqual(requested, [128, 256], 'each bucket asks the scaler for its own width');
  assert.strictEqual(d.pngDimensions(io.files.get(largePath)).width, 1,
    'recorded metadata follows the encoder output, not the requested width');
  assert.strictEqual(meta['Thumb::Image::Width'], '1');
});

check('writing the cache rejects a missing source or scaler', () => {
  const io = memoryFs({ '/src/icon.png': tinyPng() });
  assert.throws(() => d.writeThumbnailCache({ fsModule: io }), /sourcePath is required/);
  assert.throws(
    () => d.writeThumbnailCache({ sourcePath: '/src/icon.png', fsModule: io }),
    /resize/,
  );
  assert.throws(
    () => d.writeThumbnailCache({ sourcePath: '/src/icon.png', resize: () => tinyPng(), sizes: ['nope'], fsModule: io }),
    /no known thumbnail size/,
  );
});

check('a scaler that declines an entry simply skips it', () => {
  const io = memoryFs({ '/src/icon.png': tinyPng() });
  const res = d.writeThumbnailCache({
    sourcePath: '/src/icon.png',
    resize: () => null,
    fsModule: io,
    env: {},
    home: '/h',
  });
  assert.strictEqual(res.written.length, 0);
  assert.strictEqual(io.files.size, 1, 'nothing was written');
});

// ---- application entry ----

check('the applications directory honours XDG_DATA_HOME', () => {
  assert.strictEqual(
    d.applicationsDirectory({ env: { XDG_DATA_HOME: '/custom/data' }, home: '/home/u' }),
    path.join('/custom/data', 'applications'),
  );
  assert.strictEqual(
    d.applicationsDirectory({ env: {}, home: '/home/u' }),
    path.join('/home/u', '.local', 'share', 'applications'),
  );
});

check('an installed entry names the bundle, hides itself and pins the icon', () => {
  const io = memoryFs();
  const res = d.installApplicationEntry({
    binary: '/home/u/Apps/Open Browser.AppImage',
    name: 'OpenBrowser',
    iconPath: '/home/u/.local/share/openbrowser/branding.png',
    startupWMClass: 'OpenBrowser',
    env: {},
    home: '/home/u',
    fsModule: io,
  });

  assert.ok(res.path.startsWith(path.join('/home/u', '.local', 'share', 'applications')));
  assert.ok(res.contents.includes('\nName=OpenBrowser\n'));
  assert.ok(res.contents.includes('\nNoDisplay=true\n'), 'stays out of the application list');
  assert.ok(res.contents.includes('\nStartupWMClass=OpenBrowser\n'));
  assert.ok(res.contents.includes('Icon=/home/u/.local/share/openbrowser/branding.png'));
  assert.ok(res.contents.includes('"/home/u/Apps/Open Browser.AppImage" %U'),
    'a path with a space is quoted and the URL field code is kept');
  assert.ok(io.dirs.has(path.join('/home/u', '.local', 'share', 'applications')));
});

check('installing an entry requires a binary', () => {
  assert.throws(() => d.installApplicationEntry({ fsModule: memoryFs() }), /binary is required/);
});

check('an entry without an icon omits the icon field', () => {
  const io = memoryFs();
  const res = d.installApplicationEntry({
    binary: '/usr/bin/app', name: 'App', env: {}, home: '/h', fsModule: io,
  });
  assert.ok(!res.contents.includes('Icon='));
  assert.ok(res.contents.includes('StartupWMClass=App'), 'the class defaults to the name');
});

// ---- argv[0] adjustment ----

check('the argv0 adjustment applies only to a bundled linux launch', () => {
  assert.strictEqual(d.desktopFileArgv0({ platform: 'linux', env: { APPIMAGE: '/a.AppImage' }, name: 'App' }), 'App');
  assert.strictEqual(d.desktopFileArgv0({ platform: 'linux', env: {}, name: 'App' }), null);
  assert.strictEqual(d.desktopFileArgv0({ platform: 'darwin', env: { APPIMAGE: '/a' }, name: 'App' }), null);
  assert.strictEqual(d.desktopFileArgv0({ platform: 'win32', env: { APPIMAGE: '/a' }, name: 'App' }), null);
  assert.strictEqual(d.desktopFileArgv0({ platform: 'linux', env: { APPIMAGE: '/a' }, name: '   ' }), null);
});

check('a path becomes a file uri the cache can key on', () => {
  assert.strictEqual(d.pathToUri('/home/u/Apps/App.AppImage'), 'file:///home/u/Apps/App.AppImage');
  assert.strictEqual(d.pathToUri('/home/u/a b.AppImage'), 'file:///home/u/a%20b.AppImage');
});

// ---- report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
console.log(`\nLINUX_DESKTOP_INTEGRATION_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
if (failed.length) process.exitCode = 1;
