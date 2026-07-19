const fs = require('fs');

// 1. Fix z-index in ui-shell.css and themes.css
let uiShell = fs.readFileSync('ui-shell.css', 'utf8');
uiShell = uiShell.replace('.theme-popover { border-radius', '.theme-popover { z-index: 9999 !important; border-radius');
fs.writeFileSync('ui-shell.css', uiShell);

// 2. Read index.html
let html = fs.readFileSync('index.html', 'utf8');

// If poolsuite option is already there in wrong place or format, clean it first
html = html.replace(/<button class="theme-option" type="button" data-theme-option="poolsuite">.*?<\/button>/, '');
html = html.replace(/<div class="theme-group-label">浅色<\/div>\s*<div class="theme-grid">\s*<\/div>/g, '');
html = html.replace(/<div class="theme-group-label">复古<\/div>\s*<div class="theme-grid">\s*<\/div>/g, '');

// Insert cleanly under a new "复古" group label right after "浅色" group
const targetLabel = '<div class="theme-group-label">浅色</div>';
const retroGroup = `
              <div class="theme-group-label">复古</div>
              <div class="theme-grid">
                <button class="theme-option" type="button" data-theme-option="poolsuite"><i style="background: linear-gradient(135deg, #000 50%, #fff 50%); border: 1px solid #000; border-radius: 0;"></i><span>Poolsuite</span></button>
              </div>`;

if (!html.includes('data-theme-option="poolsuite"')) {
    html = html.replace(targetLabel, retroGroup + '\n              ' + targetLabel);
}

fs.writeFileSync('index.html', html);

// 3. Ensure the CSS for poolsuite is correctly added and not broken
// In themes.css, let's append the correct poolsuite CSS rules
let themesCss = fs.readFileSync('themes.css', 'utf8');
if (!themesCss.includes('data-theme="poolsuite"')) {
    const poolsuiteCss = `
/* =========================================================
   Theme: Poolsuite (Retro 1-bit / Classic Mac / System 6 OS)
   ========================================================= */
html[data-theme="poolsuite"] body,
html[data-theme="poolsuite"] .app-shell {
  font-family: "Courier New", "MS Sans Serif", "Geneva", "Chicago", monospace !important;
  font-weight: bold;
  letter-spacing: -0.5px;
  background-color: #fff !important;
  color: #000 !important;
}

html[data-theme="poolsuite"] {
  --theme-bg: #fff;
  --theme-surface: #fff;
  --theme-surface-alt: #f0f0f0;
  --theme-text: #000;
  --theme-muted: #666;
  --theme-accent-strong: #000;
  --theme-active: #fff;
  --theme-soft: #ccc;
  --border: #000;
  --blue: #000;
  --chip-color: #000;

  --ui-sidebar: #fff;
  --ui-header: #fff;
  --ui-surface: #fff;
  --ui-surface-muted: #f0f0f0;
  --ui-border: #000;
  --ui-border-strong: #000;
  --ui-text: #000;
  --ui-muted: #666;
  --ui-accent: #000;
  --ui-accent-soft: #ddd;
  --ui-danger: #000;
  --ui-shadow: 4px 4px 0px 0px #000;
  --ui-radius: 0px !important;
  --ui-radius-sm: 0px !important;
}

html[data-theme="poolsuite"] * {
  border-radius: 0 !important;
}

html[data-theme="poolsuite"] .sidebar,
html[data-theme="poolsuite"] .content > header,
html[data-theme="poolsuite"] .table-card,
html[data-theme="poolsuite"] .profile-selection-bar,
html[data-theme="poolsuite"] .theme-popover,
html[data-theme="poolsuite"] input,
html[data-theme="poolsuite"] select,
html[data-theme="poolsuite"] dialog {
  background-color: #fff !important;
  border: 2px solid #000 !important;
  box-shadow: 3px 3px 0 0 #000 !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

html[data-theme="poolsuite"] button {
  background-color: #fff !important;
  border: 2px solid #000 !important;
  box-shadow: 2px 2px 0 0 #000 !important;
  color: #000 !important;
  backdrop-filter: none !important;
  transition: none !important;
}

html[data-theme="poolsuite"] button:active {
  transform: translate(2px, 2px);
  box-shadow: 0px 0px 0 0 #000 !important;
}

html[data-theme="poolsuite"] button.primary {
  background-color: #000 !important;
  color: #fff !important;
}
html[data-theme="poolsuite"] button.primary:hover {
  background-color: #fff !important;
  color: #000 !important;
}

html[data-theme="poolsuite"] .sidebar .nav {
  border: 2px solid transparent !important;
  box-shadow: none !important;
}
html[data-theme="poolsuite"] .sidebar .nav:hover,
html[data-theme="poolsuite"] .sidebar .nav.active {
  background-color: #000 !important;
  color: #fff !important;
  border-color: #000 !important;
}
html[data-theme="poolsuite"] .sidebar .nav:hover i,
html[data-theme="poolsuite"] .sidebar .nav.active i {
  color: #fff !important;
}

html[data-theme="poolsuite"] .table-card th {
  border-bottom: 2px solid #000 !important;
  background-color: #000 !important;
  color: #fff !important;
}
html[data-theme="poolsuite"] .table-card td {
  border-bottom: 2px dotted #000 !important;
}
html[data-theme="poolsuite"] .table-card tbody tr:hover {
  background-color: #eee !important;
}
html[data-theme="poolsuite"] .table-card tbody tr.selected-row {
  background-color: #000 !important;
  color: #fff !important;
}
html[data-theme="poolsuite"] .table-card tbody tr.selected-row td,
html[data-theme="poolsuite"] .table-card tbody tr.selected-row button,
html[data-theme="poolsuite"] .table-card tbody tr.selected-row small {
  color: #fff !important;
}
html[data-theme="poolsuite"] .table-card tbody tr.selected-row button.outline {
  border-color: #fff !important;
  background-color: #000 !important;
  box-shadow: 2px 2px 0 0 #fff !important;
}

html[data-theme="poolsuite"] .group-chip {
  background-color: #fff !important;
  border: 2px solid #000 !important;
  box-shadow: 2px 2px 0 0 #000 !important;
}
html[data-theme="poolsuite"] .group-chip.active {
  background-color: #000 !important;
  color: #fff !important;
}
html[data-theme="poolsuite"] .group-chip.active b {
  color: #fff !important;
}

html[data-theme="poolsuite"] .env-badge {
  background: #000 !important;
  color: #fff !important;
  border: 2px solid #fff !important;
  box-shadow: 0 0 0 2px #000 !important;
}

html[data-theme="poolsuite"] .local-status-card {
  background-color: #fff !important;
  border: 2px solid #000 !important;
  box-shadow: 4px 4px 0 0 #000 !important;
}
html[data-theme="poolsuite"] .local-status-dot {
  background: #000 !important;
  box-shadow: none !important;
  border: 2px solid #fff !important;
  outline: 2px solid #000 !important;
}
`;
    fs.appendFileSync('themes.css', poolsuiteCss);
}

// Ensure the popover z-index fix is applied properly on themes.css as well, in case it exists there
let themesContent = fs.readFileSync('themes.css', 'utf8');
if (themesContent.includes('.theme-popover {') && !themesContent.includes('z-index: 9999')) {
    themesContent = themesContent.replace(/\.theme-popover\s*\{/, '.theme-popover { z-index: 9999 !important; ');
    fs.writeFileSync('themes.css', themesContent);
}

// Make sure styles.css also has the z-index fix if the popover is defined there
let stylesContent = fs.readFileSync('styles.css', 'utf8');
if (stylesContent.includes('.theme-popover {') && !stylesContent.includes('z-index: 9999')) {
    stylesContent = stylesContent.replace(/\.theme-popover\s*\{/, '.theme-popover { z-index: 9999 !important; ');
    fs.writeFileSync('styles.css', stylesContent);
}
