const fs = require('fs');
let code = fs.readFileSync('renderer.js', 'utf8');

// fix nav active
code = code.replace(
  /navs\.forEach\(\(n\) => n\.classList\.remove\('active'\)\);/g,
  "navs.forEach((n) => n.classList.remove('active'));\n    $$('.nav-child').forEach((n) => n.classList.remove('active'));"
);
code = code.replace(
  /btn\.classList\.add\('active'\);/g,
  "btn.classList.add('active');\n      if (btn.classList.contains('nav-child')) {\n        $('#rpa-menu-toggle').classList.add('active');\n      }"
);

fs.writeFileSync('renderer.js', code);
