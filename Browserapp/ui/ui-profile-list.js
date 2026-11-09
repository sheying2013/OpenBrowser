(() => {
'use strict';

function normalizeText(value) {
  return String(value ?? '').toLocaleLowerCase();
}

function filterProfiles({ profiles = [], activeGroupFilter = 'all', query = '', displayProfileNumber, groupNameOf }) {
  const needle = normalizeText(query).trim();
  const numberOf = typeof displayProfileNumber === 'function' ? displayProfileNumber : (profile) => profile?.number || profile?.id || '';
  const groupOf = typeof groupNameOf === 'function' ? groupNameOf : () => '';
  return profiles.filter((profile) => {
    if (activeGroupFilter === 'trash') return Boolean(profile.trashed);
    if (profile.trashed) return false;
    if (activeGroupFilter === 'ungrouped') return !profile.groupId;
    if (activeGroupFilter !== 'all' && profile.groupId !== activeGroupFilter) return false;
    return true;
  }).filter((profile) => {
    if (!needle) return true;
    return [
      profile.name,
      profile.id,
      numberOf(profile),
      profile.browser,
      profile.proxy,
      profile.tag,
      groupOf(profile),
    ].some((value) => normalizeText(value).includes(needle));
  });
}

function paginate(items = [], page = 1, pageSize = 10) {
  const size = Math.max(1, Number.parseInt(pageSize, 10) || 10);
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const currentPage = Math.min(Math.max(1, Number.parseInt(page, 10) || 1), totalPages);
  const offset = (currentPage - 1) * size;
  return {
    items: items.slice(offset, offset + size),
    currentPage,
    totalPages,
    total: items.length,
  };
}

function calculateVirtualRange({ total = 0, scrollTop = 0, viewportHeight = 600, rowHeight = 44, overscan = 5 } = {}) {
  if (total <= 0) {
    return { startIndex: 0, endIndex: 0, topPadding: 0, bottomPadding: 0 };
  }
  const h = Math.max(1, rowHeight);
  const start = Math.max(0, Math.floor(scrollTop / h) - overscan);
  const visibleCount = Math.ceil(viewportHeight / h);
  const end = Math.min(total, Math.floor(scrollTop / h) + visibleCount + overscan);
  const topPadding = start * h;
  const bottomPadding = Math.max(0, (total - end) * h);
  return {
    startIndex: start,
    endIndex: end,
    topPadding,
    bottomPadding,
  };
}

function projectProfileSummary(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    id: String(profile.id),
    number: profile.number != null ? Number(profile.number) : null,
    name: String(profile.name || profile.id),
    title: profile.title || '',
    groupId: profile.groupId != null ? String(profile.groupId) : null,
    browser: profile.browser || 'Google Chrome',
    proxy: profile.corrupted ? '' : (profile.proxy || 'direct'),
    proxyId: profile.proxyId || null,
    networkMode: profile.corrupted ? 'corrupted' : (profile.networkMode || 'direct'),
    corrupted: Boolean(profile.corrupted),
    tag: profile.tag || '',
    tags: Array.isArray(profile.tags) ? profile.tags : (profile.tag ? [profile.tag] : []),
    notes: profile.notes || '',
    exitIp: profile.exitIp || null,
    exitCountryCode: profile.exitCountryCode || null,
    exitCheckedAt: profile.exitCheckedAt || null,
    platform: profile.platform ? { type: profile.platform.type, startUrl: profile.platform.startUrl } : undefined,
    os: profile.os,
    running: Boolean(profile.running),
    trashed: Boolean(profile.trashed),
    trashedAt: profile.trashedAt || null,
    createdAt: profile.createdAt || null,
    updatedAt: profile.updatedAt || null,
  };
}

  const api = { filterProfiles, paginate, calculateVirtualRange, projectProfileSummary };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.OpenBrowserProfileList = api;
  } else {
    globalThis.OpenBrowserProfileList = api;
  }
})();
