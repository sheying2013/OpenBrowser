const fs = require('fs');

// 1. Set default theme to poolsuite in index.html
let html = fs.readFileSync('index.html', 'utf8');
html = html.replace(/data-theme="[^"]+"/, 'data-theme="poolsuite"');
// optionally hide theme picker if we want pure retro, but let's just make it default
fs.writeFileSync('index.html', html);

// 2. Inject global retro styles into styles.css so it applies fundamentally
let styles = fs.readFileSync('styles.css', 'utf8');
const retroGlobal = `
/* =========================================================
   GLOBAL RETRO PIXEL OVERRIDE (Poolsuite / System 6 style)
   ========================================================= */
@import url('https://fonts.googleapis.com/css2?family=VT323&family=Press+Start+2P&display=swap');

:root {
  --ui-radius: 0px !important;
  --ui-radius-sm: 0px !important;
  --theme-bg: #fff !important;
  --theme-surface: #fff !important;
  --theme-surface-alt: #f0f0f0 !important;
  --theme-text: #000 !important;
  --theme-muted: #555 !important;
  --theme-accent-strong: #000 !important;
  --theme-active: #fff !important;
  --theme-soft: #ccc !important;
  --border: #000 !important;
  --blue: #000 !important;

  --ui-sidebar: #fff !important;
  --ui-header: #fff !important;
  --ui-surface: #fff !important;
  --ui-surface-muted: #f0f0f0 !important;
  --ui-border: #000 !important;
  --ui-border-strong: #000 !important;
  --ui-text: #000 !important;
  --ui-muted: #555 !important;
  --ui-accent: #000 !important;
  --ui-accent-soft: #ddd !important;
  --ui-danger: #000 !important;
  --ui-shadow: 4px 4px 0px 0px #000 !important;
}

body, .app-shell, input, select, button, textarea {
  font-family: 'VT323', "Courier New", "MS Sans Serif", "Geneva", "Chicago", monospace !important;
  font-size: 16px;
  color: #000 !important;
  background-color: #fff !important;
  letter-spacing: 0.5px;
}

* {
  border-radius: 0 !important;
}

/* Base layouts */
.sidebar, .content > header, .table-card, .profile-selection-bar, .theme-popover, input, select, dialog, textarea {
  background-color: #fff !important;
  border: 2px solid #000 !important;
  box-shadow: 3px 3px 0 0 #000 !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

/* Buttons */
button {
  background-color: #fff !important;
  border: 2px solid #000 !important;
  box-shadow: 2px 2px 0 0 #000 !important;
  color: #000 !important;
  backdrop-filter: none !important;
  transition: none !important;
  cursor: pointer;
}
button:active {
  transform: translate(2px, 2px);
  box-shadow: 0px 0px 0 0 #000 !important;
}
button.primary {
  background-color: #000 !important;
  color: #fff !important;
}
button.primary:hover {
  background-color: #fff !important;
  color: #000 !important;
}

/* Nav */
.sidebar .nav {
  border: 2px solid transparent !important;
  box-shadow: none !important;
}
.sidebar .nav:hover, .sidebar .nav.active {
  background-color: #000 !important;
  color: #fff !important;
  border-color: #000 !important;
}
.sidebar .nav:hover i, .sidebar .nav.active i {
  color: #fff !important;
}
.sidebar .nav-label {
  color: #000 !important;
  border-bottom: 2px solid #000;
  padding-bottom: 4px;
  margin-bottom: 8px;
}

/* Tables */
.table-card {
  border: 2px solid #000 !important;
  box-shadow: 4px 4px 0 0 #000 !important;
}
.table-card th {
  border-bottom: 2px solid #000 !important;
  background-color: #000 !important;
  color: #fff !important;
  font-size: 14px !important;
  text-transform: uppercase;
}
.table-card td {
  border-bottom: 2px dotted #000 !important;
  font-size: 14px !important;
}
.table-card tbody tr:hover {
  background-color: #eee !important;
}
.table-card tbody tr.selected-row {
  background-color: #000 !important;
  color: #fff !important;
}
.table-card tbody tr.selected-row td,
.table-card tbody tr.selected-row button,
.table-card tbody tr.selected-row small {
  color: #fff !important;
}
.table-card tbody tr.selected-row button.outline {
  border-color: #fff !important;
  background-color: #000 !important;
  box-shadow: 2px 2px 0 0 #fff !important;
}

/* Badges / Chips */
.group-chip {
  background-color: #fff !important;
  border: 2px solid #000 !important;
  box-shadow: 2px 2px 0 0 #000 !important;
  font-weight: bold;
}
.group-chip.active {
  background-color: #000 !important;
  color: #fff !important;
}
.group-chip.active b {
  color: #fff !important;
}

.env-badge {
  background: #000 !important;
  color: #fff !important;
  border: 2px solid #fff !important;
  box-shadow: 0 0 0 2px #000 !important;
  font-family: 'Press Start 2P', monospace !important;
  font-size: 10px !important;
  padding: 6px !important;
}
.env-badge::after {
  display: none !important;
}

/* Local Status */
.local-status-card {
  background-color: #fff !important;
  border: 2px solid #000 !important;
  box-shadow: 4px 4px 0 0 #000 !important;
}
.local-status-dot {
  background: #000 !important;
  box-shadow: none !important;
  border: 2px solid #fff !important;
  outline: 2px solid #000 !important;
}

/* Scrollbars */
::-webkit-scrollbar {
  width: 14px;
  height: 14px;
  background: #fff;
  border-left: 2px solid #000;
  border-top: 2px solid #000;
}
::-webkit-scrollbar-thumb {
  background: #000;
  border: 2px solid #fff;
}
::-webkit-scrollbar-corner {
  background: #fff;
}

/* Checkboxes & Radios */
input[type="checkbox"], input[type="radio"] {
  appearance: none;
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border: 2px solid #000 !important;
  background: #fff !important;
  box-shadow: 2px 2px 0 0 #000 !important;
  display: inline-block;
  position: relative;
}
input[type="radio"] {
  border-radius: 50% !important;
}
input[type="checkbox"]:checked::after {
  content: "X";
  position: absolute;
  top: -2px;
  left: 2px;
  font-size: 14px;
  font-weight: bold;
  color: #000;
}
input[type="radio"]:checked::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 6px;
  height: 6px;
  background: #000;
  border-radius: 50% !important;
}

/* Headers & text */
h1, h2, h3, h4, h5, strong, b {
  font-weight: bold !important;
  text-transform: uppercase;
}

/* Remove Lucide SVG soft strokes, make them sharp */
i[data-lucide] {
  stroke-width: 3 !important;
  stroke: currentColor !important;
}

/* Inputs focus */
input:focus, select:focus, textarea:focus {
  outline: none !important;
  background-color: #000 !important;
  color: #fff !important;
}

/* Specific UI Shell overrides */
.content > header {
  border-bottom: 4px solid #000 !important;
}
.sidebar {
  border-right: 4px solid #000 !important;
}
`;

if (!styles.includes('GLOBAL RETRO PIXEL OVERRIDE')) {
    fs.appendFileSync('styles.css', '\n' + retroGlobal);
}
