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

  const api = { filterProfiles, paginate };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.OpenBrowserProfileList = api;
  } else {
    globalThis.OpenBrowserProfileList = api;
  }
})();
