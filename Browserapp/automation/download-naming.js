'use strict';

/**
 * Download filename resolution and failure classification.
 *
 * Filenames can arrive from three places — an explicit suggestion, the URL
 * path, or the server's Content-Disposition header — and any of them may carry
 * characters that are illegal on the target filesystem. This module resolves
 * the best candidate and makes it safe to write.
 */

// Characters Windows rejects, plus control codes.
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
// Device names that Windows reserves regardless of extension.
const RESERVED_FILENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

const FAILURE_CODES = {
  TARGET_FILE_BUSY: 'TARGET_FILE_BUSY',
  TARGET_FILE_ACCESS_DENIED: 'TARGET_FILE_ACCESS_DENIED',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
};

/** Strip surrounding quotes and unescape backslash sequences. */
function normalizeParameterValue(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return trimmed;
}

function decodeParameterValue(value) {
  const normalized = normalizeParameterValue(value);
  try {
    return decodeURIComponent(normalized);
  } catch (_) {
    return normalized;
  }
}

/**
 * Make a filename safe to create on any supported platform.
 * @returns {string|undefined} undefined when nothing usable remains.
 */
function sanitizeFileName(fileName) {
  if (fileName === null || fileName === undefined) return undefined;
  const raw = String(fileName).trim();
  // Reject the relative-directory markers before the trailing-dot rule can
  // turn them into harmless-looking names.
  if (!raw || raw === '.' || raw === '..') return undefined;

  const sanitized = raw
    .replace(INVALID_FILENAME_CHARS, '_')
    .replace(/[. ]+$/g, '_');
  if (!sanitized) return undefined;
  return RESERVED_FILENAME.test(sanitized) ? `_${sanitized}` : sanitized;
}

/**
 * Pick a filename for a download.
 *
 * The URL path segment is decoded *after* splitting so an encoded `?`, `#` or
 * `/` stays part of the filename instead of changing the parsed structure.
 *
 * @param {string} url
 * @param {string} [suggestedFileName] Explicit name, wins when usable.
 * @param {string} [fallbackFileName]
 * @returns {string}
 */
function getDownloadFileName(url, suggestedFileName, fallbackFileName) {
  let fileName = suggestedFileName;

  if (!fileName && typeof url === 'string' && url) {
    try {
      const last = new URL(url).pathname.split('/').pop();
      if (last) {
        try {
          fileName = decodeURIComponent(last);
        } catch (_) {
          fileName = last;
        }
      }
    } catch (_) {
      fileName = undefined;
    }
  }

  const fallback = fallbackFileName === undefined ? String(Date.now()) : fallbackFileName;
  return sanitizeFileName(fileName || '')
    || sanitizeFileName(fallback)
    || 'download';
}

/**
 * Read the server-provided name from a Content-Disposition header.
 * `filename*` wins because it carries RFC 5987 encoded UTF-8 names.
 *
 * @param {string|null} contentDisposition
 * @returns {string|undefined}
 */
function getFileNameFromContentDisposition(contentDisposition) {
  if (!contentDisposition || typeof contentDisposition !== 'string') return undefined;

  const encodedMatch = contentDisposition.match(/(?:^|;)\s*filename\*\s*=\s*([^;]+)/i);
  if (encodedMatch && encodedMatch[1]) {
    let encoded = normalizeParameterValue(encodedMatch[1]);
    // Shape: charset'language'percent-encoded-value
    const separator = encoded.indexOf("''");
    if (separator >= 0) encoded = encoded.slice(separator + 2);
    const decoded = decodeParameterValue(encoded);
    if (decoded) return decoded;
  }

  const plainMatch = contentDisposition.match(/(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;\s]+))/i);
  if (!plainMatch) return undefined;
  // The quoted alternative already dropped the surrounding quotes, so quoted
  // escape sequences must be unescaped here rather than by the shared helper.
  const raw = plainMatch[1] !== undefined
    ? plainMatch[1].replace(/\\(.)/g, '$1')
    : plainMatch[2];
  if (!raw) return undefined;
  const decoded = decodeParameterValue(raw);
  return decoded || undefined;
}

/** Extract the system error code from a Node error object. */
function getSystemErrorCode(error) {
  if (!error || typeof error !== 'object') return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function isAccessDenied(code) {
  return code === 'EACCES' || code === 'EPERM';
}

/** Classify a failure while writing the destination file. */
function classifyFileWriteFailure(error) {
  return isAccessDenied(getSystemErrorCode(error))
    ? FAILURE_CODES.TARGET_FILE_ACCESS_DENIED
    : FAILURE_CODES.DOWNLOAD_FAILED;
}

/** Classify a failure involving the target file, including a probe attempt. */
function classifyTargetFileFailure(error, probeError) {
  const code = getSystemErrorCode(error);
  const probeCode = getSystemErrorCode(probeError);
  if (code === 'EBUSY' || probeCode === 'EBUSY') return FAILURE_CODES.TARGET_FILE_BUSY;
  if (isAccessDenied(code) || isAccessDenied(probeCode)) return FAILURE_CODES.TARGET_FILE_ACCESS_DENIED;
  return FAILURE_CODES.DOWNLOAD_FAILED;
}

/**
 * Classify a failure during the final rename.
 * Windows reports EPERM when another process holds the destination open, which
 * is more usefully surfaced as "in use" than as a permission problem.
 */
function classifyTargetFileCommitFailure(error, targetFileExisted, probeError, platform = process.platform) {
  const code = getSystemErrorCode(error);
  if (targetFileExisted && platform === 'win32' && code === 'EPERM') {
    return FAILURE_CODES.TARGET_FILE_BUSY;
  }
  return classifyTargetFileFailure(error, probeError);
}

/** Remove absolute paths and URLs from a message before showing it to a user. */
function sanitizeDownloadErrorMessage(error, downloadUrl, safeDownloadUrl) {
  if (error === undefined || error === null) return undefined;
  const detail = typeof error === 'object' ? error : undefined;
  let message = detail && typeof detail.message === 'string' ? detail.message : String(error);

  const replacements = [
    [downloadUrl, safeDownloadUrl],
    [detail && detail.path, '[local-path]'],
    [detail && detail.dest, '[local-path]'],
  ];
  for (const [sensitive, replacement] of replacements) {
    if (typeof sensitive === 'string' && sensitive) {
      message = message.split(sensitive).join(replacement);
    }
  }
  return message;
}

const MESSAGES = {
  [FAILURE_CODES.TARGET_FILE_BUSY]: (name) => `文件“${name}”正在被其他程序占用，请关闭文件后重试，或选择其他文件名。`,
  [FAILURE_CODES.TARGET_FILE_ACCESS_DENIED]: (name) => `无法写入文件“${name}”，请检查文件是否已打开或当前目录是否有写入权限。`,
  [FAILURE_CODES.DOWNLOAD_FAILED]: () => '文件下载失败，请重试',
};

function getDownloadFailureMessage(code, fileName) {
  const name = fileName || '目标文件';
  const build = MESSAGES[code] || MESSAGES[FAILURE_CODES.DOWNLOAD_FAILED];
  return build(name);
}

function isDownloadFailureCode(value) {
  return Object.values(FAILURE_CODES).includes(value);
}

module.exports = {
  FAILURE_CODES,
  sanitizeFileName,
  getDownloadFileName,
  getFileNameFromContentDisposition,
  getSystemErrorCode,
  classifyFileWriteFailure,
  classifyTargetFileFailure,
  classifyTargetFileCommitFailure,
  sanitizeDownloadErrorMessage,
  getDownloadFailureMessage,
  isDownloadFailureCode,
};
