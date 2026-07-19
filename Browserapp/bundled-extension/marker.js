(() => {
  if (document.getElementById('openbrowser-profile-marker')) return;
  const badge = document.createElement('div');
  badge.id = 'openbrowser-profile-marker';
  badge.textContent = 'OB';
  badge.title = 'OpenBrowser';
  Object.assign(badge.style, {
    position: 'fixed', right: '14px', bottom: '14px', zIndex: '2147483647',
    minWidth: '28px', height: '28px', padding: '0 10px', borderRadius: '999px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'linear-gradient(145deg,#245cff,#1d4ed8)', color: '#fff',
    font: '700 12px/1 system-ui,-apple-system,Segoe UI,sans-serif',
    boxShadow: '0 8px 24px rgba(36,92,255,.35)', border: '2px solid rgba(255,255,255,.85)',
    pointerEvents: 'none',
  });
  document.documentElement.appendChild(badge);
})();
