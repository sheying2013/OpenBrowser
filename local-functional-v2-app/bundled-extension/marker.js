(() => {
  if (document.getElementById('openbrowser-profile-marker')) return;
  const badge = document.createElement('div');
  badge.id = 'openbrowser-profile-marker';
  badge.textContent = 'OpenBrowser';
  Object.assign(badge.style, { position: 'fixed', right: '14px', bottom: '14px', zIndex: '2147483647', padding: '7px 10px', borderRadius: '999px', background: '#245cff', color: '#fff', font: '600 11px Segoe UI, sans-serif', boxShadow: '0 8px 24px rgba(0,0,0,.24)', pointerEvents: 'none' });
  document.documentElement.appendChild(badge);
})();
