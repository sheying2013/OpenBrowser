const fs = require('fs');
let code = fs.readFileSync('renderer.js', 'utf8');

// 修复自动脚本的子菜单展开逻辑。如果 HTML 改成了 style="display: none"，我们需要在 renderer 里面通过 JS 触发显示/隐藏。
code = code.replace(
  /document\.getElementById\('rpa-menu-toggle'\)\?\.addEventListener\('click', \(e\) => \{[\s\S]*?\}\);/,
  `document.getElementById('rpa-menu-toggle')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const sub = document.getElementById('nav-rpa-plus');
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', !expanded);
    if (!expanded) {
      sub.hidden = false;
      sub.style.display = 'block';
    } else {
      sub.hidden = true;
      sub.style.display = 'none';
    }
  });`
);
fs.writeFileSync('renderer.js', code);
