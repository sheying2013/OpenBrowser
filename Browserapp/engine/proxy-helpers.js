"use strict";

const { parseProxy } = require("../proxy-forwarder");

function parsedProxy(value) {
  try {
    return parseProxy(String(value || "").trim());
  } catch (_) {
    return null;
  }
}

function proxyHasCredentials(value) {
  return Boolean(parsedProxy(value)?.authenticated);
}

function hasExplicitScheme(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value || "").trim());
}

function sameProxyEndpoint(left, right) {
  const a = parsedProxy(left);
  const b = parsedProxy(right);
  if (!a || !b) return false;
  if (a.host !== b.host || Number(a.port) !== Number(b.port)) return false;
  if (hasExplicitScheme(left) && hasExplicitScheme(right)) {
    return a.protocol === b.protocol;
  }
  return true;
}

function sameProxyIdentity(left, right) {
  const a = parsedProxy(left);
  const b = parsedProxy(right);
  if (!a || !b) return false;
  const protocolMatches = (hasExplicitScheme(left) && hasExplicitScheme(right))
    ? a.protocol === b.protocol
    : true;
  return Boolean(protocolMatches
    && a.host === b.host
    && Number(a.port) === Number(b.port)
    && String(a.username || "") === String(b.username || "")
    && String(a.password || "") === String(b.password || ""));
}

function ownAliasValue(input, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input || {}, key)) {
      return { present: true, value: input[key] };
    }
  }
  return { present: false, value: undefined };
}

function profileProxyAssociation(value) {
  const topLevel = ownAliasValue(value, ["proxyId", "proxy_id", "proxyLibraryId", "proxy_library_id"]);
  if (topLevel.present) return topLevel;
  return ownAliasValue(value?.proxyMeta, ["proxyId", "proxy_id", "proxyLibraryId", "proxy_library_id"]);
}

function normalizedProxyAssociationId(value) {
  if (value == null || String(value).trim() === "") return null;
  return String(value).trim().slice(0, 128);
}

async function retryProxyOperation(operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (/authentication failed|username or password|rejected available authentication/i.test(String(error?.message || "")) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
  }
  throw lastError;
}

module.exports = {
  parsedProxy,
  proxyHasCredentials,
  hasExplicitScheme,
  sameProxyEndpoint,
  sameProxyIdentity,
  ownAliasValue,
  profileProxyAssociation,
  normalizedProxyAssociationId,
  retryProxyOperation,
};
