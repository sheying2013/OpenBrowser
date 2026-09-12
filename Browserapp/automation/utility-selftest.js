'use strict';

/** Self-test for log sanitisation and download filename/failure helpers. */

const assert = require('assert');
const lg = require('./log-sanitizer');
const dn = require('./download-naming');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

// ============ log sanitisation ============

check('maskSecretString keeps short values unreadable', () => {
  assert.strictEqual(lg.maskSecretString(''), '');
  assert.strictEqual(lg.maskSecretString(null), '');
  assert.strictEqual(lg.maskSecretString('ab'), '****');
  assert.strictEqual(lg.maskSecretString('abcd'), '****');
});

check('maskSecretString keeps only the edges of longer values', () => {
  assert.strictEqual(lg.maskSecretString('abcdefgh'), 'a***h');
  assert.strictEqual(lg.maskSecretString('abcdefghijkl'), 'ab***kl');
});

check('sanitizeForLog masks sensitive keys and keeps the rest', () => {
  const out = lg.sanitizeForLog({ token: 'abcdef123456', host: 'example.test', port: 8080 });
  assert.strictEqual(out.token, 'ab***56');
  assert.strictEqual(out.host, 'example.test');
  assert.strictEqual(out.port, 8080, 'non-sensitive numbers survive');
});

check('sanitizeForLog masks numeric identifiers completely', () => {
  const out = lg.sanitizeForLog({ unionId: 427381, name: 'kept' });
  assert.strictEqual(out.unionId, '***', 'numeric sensitive values are fully hidden');
  assert.strictEqual(out.name, 'kept');
});

check('sanitizeForLog walks nested objects and arrays', () => {
  const out = lg.sanitizeForLog({
    outer: { token: 'abcdefghijkl', other: 1 },
    list: [{ password: 'hunter2xyz' }, 'plain'],
  });
  assert.strictEqual(out.outer.token, 'ab***kl');
  assert.strictEqual(out.outer.other, 1);
  assert.strictEqual(out.list[0].password, 'hu***yz');
  assert.strictEqual(out.list[1], 'plain');
});

check('sanitizeForLog does not mutate its input', () => {
  const input = { token: 'abcdef123456' };
  lg.sanitizeForLog(input);
  assert.strictEqual(input.token, 'abcdef123456', 'original untouched');
});

check('sanitizeForLog accepts a custom key set', () => {
  const out = lg.sanitizeForLog({ customSecret: 'abcdefghij', token: 'abcdefghij' }, {
    sensitiveKeys: ['customSecret'],
  });
  assert.strictEqual(out.customSecret, 'ab***ij');
  assert.strictEqual(out.token, 'abcdefghij', 'default keys not applied when overridden');
});

check('sanitizeForLog handles null and primitives', () => {
  assert.strictEqual(lg.sanitizeForLog(null), null);
  assert.strictEqual(lg.sanitizeForLog('text'), 'text');
  assert.strictEqual(lg.sanitizeForLog(42), 42);
});

check('sanitizeJsonForLog returns valid json', () => {
  const json = lg.sanitizeJsonForLog({ token: 'abcdefghijkl' });
  assert.strictEqual(JSON.parse(json).token, 'ab***kl');
});

check('sanitizeJsonForLog survives a cyclic structure', () => {
  const cyclic = { name: 'x' };
  cyclic.self = cyclic;
  const out = lg.sanitizeJsonForLog(cyclic);
  assert.strictEqual(out, '[unserializable]');
});

check('redactInlineText rewrites embedded json fragments', () => {
  const text = 'req {"token":"abcdefghijkl","host":"a.test"} done';
  const out = lg.redactInlineText(text);
  assert.ok(!out.includes('abcdefghijkl'), 'secret removed');
  assert.ok(out.includes('"token":"***"'));
  assert.ok(out.includes('a.test'), 'non-sensitive data preserved');
});

check('redactInlineText rewrites bare key=value pairs', () => {
  const out = lg.redactInlineText('connecting?password=s3cretvalue&host=a.test');
  assert.ok(!out.includes('s3cretvalue'));
  assert.ok(out.includes('host=a.test'));
});

check('redactInlineText rewrites machine identifiers', () => {
  const hex = 'a'.repeat(32);
  const out = lg.redactInlineText(`machineId=${hex}`);
  assert.strictEqual(out, 'machineId=***');
});

check('sanitizeStringPayloadForLog parses and masks json text', () => {
  const out = lg.sanitizeStringPayloadForLog('{"token":"abcdefghijkl"}');
  assert.strictEqual(JSON.parse(out).token, 'ab***kl');
});

check('sanitizeStringPayloadForLog truncates opaque long strings', () => {
  const out = lg.sanitizeStringPayloadForLog('x'.repeat(100));
  assert.ok(out.length < 100);
  assert.ok(out.includes('***'));
});

check('sanitizeStringPayloadForLog collapses short strings', () => {
  assert.strictEqual(lg.sanitizeStringPayloadForLog('tiny'), '***');
});

check('sanitizeLogArg passes primitives through', () => {
  assert.strictEqual(lg.sanitizeLogArg(1), 1);
  assert.strictEqual(lg.sanitizeLogArg(true), true);
  assert.strictEqual(lg.sanitizeLogArg(null), null);
});

check('sanitizeLogArg describes functions without dumping them', () => {
  assert.strictEqual(lg.sanitizeLogArg(function named() {}), '[Function: named]');
  assert.strictEqual(lg.sanitizeLogArg(() => {}), '[Function]');
  assert.strictEqual(lg.sanitizeLogArg(async function task() {}), '[AsyncFunction: task]');
});

check('sanitizeLogArg flattens errors and masks embedded secrets', () => {
  const err = new Error('failed with token=supersecretvalue');
  const out = lg.sanitizeLogArg(err);
  assert.ok(out.includes('failed with'), 'message retained');
  assert.ok(!out.includes('supersecretvalue'), 'secret removed');
});

check('sanitizeLogArg serialises plain objects with masking', () => {
  const out = lg.sanitizeLogArg({ token: 'abcdefghijkl' });
  assert.strictEqual(JSON.parse(out).token, 'ab***kl');
});

check('sanitizeLogArgs maps a whole argument list', () => {
  const out = lg.sanitizeLogArgs([{ token: 'abcdefghijkl' }, 7]);
  assert.strictEqual(JSON.parse(out[0]).token, 'ab***kl');
  assert.strictEqual(out[1], 7);
});

// ============ download naming ============

check('sanitizeFileName replaces characters illegal on Windows', () => {
  assert.strictEqual(dn.sanitizeFileName('a:b*c?d"e<f>g|h'), 'a_b_c_d_e_f_g_h');
  assert.strictEqual(dn.sanitizeFileName('back\\slash/slash'), 'back_slash_slash');
});

check('sanitizeFileName strips trailing dots and spaces', () => {
  assert.strictEqual(dn.sanitizeFileName('report.txt. '), 'report.txt_', 'trailing run collapses to one underscore');
  assert.strictEqual(dn.sanitizeFileName('report.txt...  '), 'report.txt_');
});

check('sanitizeFileName escapes reserved device names', () => {
  assert.strictEqual(dn.sanitizeFileName('CON.txt'), '_CON.txt');
  assert.strictEqual(dn.sanitizeFileName('lpt1'), '_lpt1');
  assert.strictEqual(dn.sanitizeFileName('console.txt'), 'console.txt', 'not a reserved name');
});

check('sanitizeFileName rejects empty and relative markers', () => {
  assert.strictEqual(dn.sanitizeFileName(''), undefined);
  assert.strictEqual(dn.sanitizeFileName('.'), undefined);
  assert.strictEqual(dn.sanitizeFileName('..'), undefined);
  assert.strictEqual(dn.sanitizeFileName(null), undefined);
});

check('sanitizeFileName removes control characters', () => {
  assert.strictEqual(dn.sanitizeFileName('a\u0000b\u001fc'), 'a_b_c');
});

check('getDownloadFileName prefers an explicit suggestion', () => {
  assert.strictEqual(dn.getDownloadFileName('https://x.test/from-url.zip', 'explicit.zip'), 'explicit.zip');
});

check('getDownloadFileName falls back to the url path', () => {
  assert.strictEqual(dn.getDownloadFileName('https://x.test/a/b/kernel.zip'), 'kernel.zip');
});

check('getDownloadFileName ignores query and fragment', () => {
  assert.strictEqual(dn.getDownloadFileName('https://x.test/file.zip?token=a#frag'), 'file.zip');
});

check('getDownloadFileName decodes percent-encoded names', () => {
  assert.strictEqual(dn.getDownloadFileName('https://x.test/%E4%B8%AD%E6%96%87.zip'), '中文.zip');
});

check('getDownloadFileName keeps encoded separators inside the name', () => {
  // %2F must not be treated as a path separator.
  const name = dn.getDownloadFileName('https://x.test/a%2Fb.bin');
  assert.strictEqual(name, 'a_b.bin', 'decoded slash is sanitised, not treated as a directory');
});

check('getDownloadFileName uses the fallback when the url is unusable', () => {
  assert.strictEqual(dn.getDownloadFileName('not a url', undefined, 'fallback.bin'), 'fallback.bin');
  assert.strictEqual(dn.getDownloadFileName('https://x.test/', undefined, 'fallback.bin'), 'fallback.bin');
});

check('getDownloadFileName never returns an unsafe name', () => {
  const name = dn.getDownloadFileName('https://x.test/', 'CON');
  assert.strictEqual(name, '_CON');
});

check('getFileNameFromContentDisposition prefers the RFC 5987 form', () => {
  const header = "attachment; filename=\"fallback.txt\"; filename*=UTF-8''%E4%B8%AD%E6%96%87.txt";
  assert.strictEqual(dn.getFileNameFromContentDisposition(header), '中文.txt');
});

check('getFileNameFromContentDisposition reads a quoted plain filename', () => {
  assert.strictEqual(dn.getFileNameFromContentDisposition('attachment; filename="report final.pdf"'), 'report final.pdf');
});

check('getFileNameFromContentDisposition reads an unquoted filename', () => {
  assert.strictEqual(dn.getFileNameFromContentDisposition('attachment; filename=plain.zip'), 'plain.zip');
});

check('getFileNameFromContentDisposition unescapes quoted pairs', () => {
  assert.strictEqual(dn.getFileNameFromContentDisposition('attachment; filename="a\\"b.txt"'), 'a"b.txt');
});

check('getFileNameFromContentDisposition returns undefined when absent', () => {
  assert.strictEqual(dn.getFileNameFromContentDisposition(null), undefined);
  assert.strictEqual(dn.getFileNameFromContentDisposition('inline'), undefined);
  assert.strictEqual(dn.getFileNameFromContentDisposition('attachment; filename='), undefined);
});

check('getFileNameFromContentDisposition tolerates a malformed escape', () => {
  assert.strictEqual(dn.getFileNameFromContentDisposition('attachment; filename="%E0%A4%A.txt"'), '%E0%A4%A.txt');
});

// ---- failure classification ----

check('getSystemErrorCode reads a string code only', () => {
  assert.strictEqual(dn.getSystemErrorCode({ code: 'EBUSY' }), 'EBUSY');
  assert.strictEqual(dn.getSystemErrorCode({ code: 42 }), undefined);
  assert.strictEqual(dn.getSystemErrorCode(null), undefined);
});

check('classifyFileWriteFailure maps permission errors', () => {
  assert.strictEqual(dn.classifyFileWriteFailure({ code: 'EACCES' }), dn.FAILURE_CODES.TARGET_FILE_ACCESS_DENIED);
  assert.strictEqual(dn.classifyFileWriteFailure({ code: 'EPERM' }), dn.FAILURE_CODES.TARGET_FILE_ACCESS_DENIED);
  assert.strictEqual(dn.classifyFileWriteFailure({ code: 'ENOSPC' }), dn.FAILURE_CODES.DOWNLOAD_FAILED);
});

check('classifyTargetFileFailure detects a busy target', () => {
  assert.strictEqual(dn.classifyTargetFileFailure({ code: 'EBUSY' }), dn.FAILURE_CODES.TARGET_FILE_BUSY);
  assert.strictEqual(dn.classifyTargetFileFailure({ code: 'ENOENT' }, { code: 'EBUSY' }), dn.FAILURE_CODES.TARGET_FILE_BUSY);
  assert.strictEqual(dn.classifyTargetFileFailure({ code: 'EACCES' }), dn.FAILURE_CODES.TARGET_FILE_ACCESS_DENIED);
});

check('classifyTargetFileCommitFailure maps windows EPERM to busy', () => {
  const code = dn.classifyTargetFileCommitFailure({ code: 'EPERM' }, true, null, 'win32');
  assert.strictEqual(code, dn.FAILURE_CODES.TARGET_FILE_BUSY);
  const other = dn.classifyTargetFileCommitFailure({ code: 'EPERM' }, true, null, 'darwin');
  assert.strictEqual(other, dn.FAILURE_CODES.TARGET_FILE_ACCESS_DENIED, 'non-windows keeps the permission reading');
});

check('getDownloadFailureMessage names the file', () => {
  const busy = dn.getDownloadFailureMessage(dn.FAILURE_CODES.TARGET_FILE_BUSY, 'data.zip');
  assert.ok(busy.includes('data.zip'));
  const denied = dn.getDownloadFailureMessage(dn.FAILURE_CODES.TARGET_FILE_ACCESS_DENIED, 'data.zip');
  assert.ok(denied.includes('data.zip'));
});

check('getDownloadFailureMessage falls back for unknown codes', () => {
  const msg = dn.getDownloadFailureMessage('SOMETHING_ELSE', 'x');
  assert.ok(typeof msg === 'string' && msg.length > 0);
});

check('sanitizeDownloadErrorMessage removes local paths and urls', () => {
  const err = { message: 'failed at /Users/me/secret/out.zip while fetching https://real.test/a.zip', path: '/Users/me/secret/out.zip' };
  const out = dn.sanitizeDownloadErrorMessage(err, 'https://real.test/a.zip', '[remote]');
  assert.ok(!out.includes('/Users/me/secret/out.zip'), 'local path removed');
  assert.ok(!out.includes('https://real.test/a.zip'), 'url replaced');
  assert.ok(out.includes('[local-path]'));
});

check('sanitizeDownloadErrorMessage returns undefined for empty input', () => {
  assert.strictEqual(dn.sanitizeDownloadErrorMessage(null, 'a', 'b'), undefined);
  assert.strictEqual(dn.sanitizeDownloadErrorMessage(undefined, 'a', 'b'), undefined);
});

check('isDownloadFailureCode validates known codes', () => {
  assert.strictEqual(dn.isDownloadFailureCode('TARGET_FILE_BUSY'), true);
  assert.strictEqual(dn.isDownloadFailureCode('NOPE'), false);
});

// ---- url redaction ----

check('sanitizeUrlForLog keeps the path and masks credential values', () => {
  const out = lg.sanitizeUrlForLog('https://shop.example.com/callback?token=eyJhbGciOiJIUzI1NiJ9&page=2');
  assert.ok(out.startsWith('https://shop.example.com/callback?'), out);
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'), 'raw token must not survive');
  assert.ok(out.includes('page=2'), 'ordinary parameters stay readable');
});

check('sanitizeUrlForLog masks direct identifiers', () => {
  const out = lg.sanitizeUrlForLog('https://example.com/list?email=buyer%40mail.com&q=shoes');
  assert.ok(!out.includes('buyer'), 'the address itself must not survive');
  assert.ok(out.includes('q=shoes'), 'non-identifying parameters are untouched');
});

check('sanitizeUrlForLog drops the fragment entirely', () => {
  const out = lg.sanitizeUrlForLog('https://app.example.com/cb#access_token=abcdef123456');
  assert.ok(!out.includes('access_token'), out);
  assert.ok(!out.includes('abcdef123456'), out);
  assert.strictEqual(out, 'https://app.example.com/cb');
});

check('sanitizeUrlForLog masks inline basic-auth credentials', () => {
  const out = lg.sanitizeUrlForLog('https://alice:hunter2@proxy.example.com:8080/');
  assert.ok(!out.includes('hunter2'), out);
  assert.ok(!out.includes('alice:'), out);
  assert.ok(out.includes('proxy.example.com:8080'), 'the host stays diagnosable');
});

check('sanitizeUrlForLog tolerates values that are not urls', () => {
  assert.strictEqual(lg.sanitizeUrlForLog(''), '');
  assert.strictEqual(lg.sanitizeUrlForLog(null), '');
  assert.strictEqual(lg.sanitizeUrlForLog(undefined), '');
  assert.strictEqual(typeof lg.sanitizeUrlForLog('/relative/path?a=b'), 'string');
});

check('sanitizeUrlForLog leaves a clean url untouched', () => {
  assert.strictEqual(
    lg.sanitizeUrlForLog('https://example.com/products/42?sort=price&page=3'),
    'https://example.com/products/42?sort=price&page=3',
  );
});

// ---- report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
console.log(`\nUTILITY_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
if (failed.length) process.exitCode = 1;
