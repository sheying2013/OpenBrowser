const fs = require('fs');
let code = fs.readFileSync('automation/app-center.js', 'utf8');

if (!code.includes('const uniqueApps = [];')) {
  code = code.replace(
    /return \[\.\.\.builtin, \.\.\.recommended, \.\.\.local\];/,
    `
    const allApps = [...builtin, ...recommended, ...local];
    const uniqueApps = [];
    const seen = new Set();
    for (const app of allApps) {
      if (app.name === 'OpenBrowser 环境标记' && app.source === 'local') continue; // Skip local duplicate of builtin
      if (!seen.has(app.name)) {
        seen.add(app.name);
        uniqueApps.push(app);
      }
    }
    return uniqueApps;
    `
  );
  fs.writeFileSync('automation/app-center.js', code);
}
