const fs = require('fs');

let styles = fs.readFileSync('styles.css', 'utf8');

// 移除之前的丑陋纯黑白覆盖层
const startIndex = styles.indexOf('/* =========================================================\n   GLOBAL RETRO PIXEL OVERRIDE');
if (startIndex !== -1) {
    styles = styles.substring(0, startIndex);
}

const refinedRetro = `
/* =========================================================
   GLOBAL RETRO PIXEL OVERRIDE (Poolsuite / Classic Mac OS & Win95)
   ========================================================= */
@import url('https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;600;700&display=swap');

:root {
  --ui-radius: 0px !important;
  --ui-radius-sm: 0px !important;
  --theme-bg: #c0c0c0 !important;
  --theme-surface: #ffffff !important;
  --theme-surface-alt: #ececec !important;
  --theme-text: #000000 !important;
  --theme-muted: #444444 !important;
  --theme-accent-strong: #0000a8 !important;
  --theme-active: #0000a8 !important;
  --theme-soft: #c0c0c0 !important;
  --border: #000000 !important;
  --blue: #0000a8 !important;

  --ui-sidebar: #c0c0c0 !important;
  --ui-header: #c0c0c0 !important;
  --ui-surface: #ffffff !important;
  --ui-surface-muted: #e0e0e0 !important;
  --ui-border: #808080 !important;
  --ui-border-strong: #000000 !important;
  --ui-text: #000000 !important;
  --ui-muted: #333333 !important;
  --ui-accent: #0000a8 !important;
  --ui-accent-soft: rgba(0, 0, 168, 0.1) !important;
  --ui-danger: #a80000 !important;
  --ui-shadow: 1px 1px 0px 0px #000 !important;
}

body, .app-shell, input, select, button, textarea, .table-card td {
  font-family: "MS Sans Serif", "Geneva", "Tahoma", sans-serif !important;
  -webkit-font-smoothing: none !important; /* Authentic non-antialiased look */
  font-size: 13px !important;
  color: #000 !important;
  letter-spacing: 0px;
}

h1, h2, h3, h4, h5, strong, b, th, .env-badge-num {
  font-family: 'Chakra Petch', 'Chicago', sans-serif !important;
  font-weight: 600 !important;
  letter-spacing: 0.5px;
}

* { border-radius: 0 !important; }

/* Desktop Background (Classic Teal) */
.app-shell {
  background-color: #008080 !important;
  background-image: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQIW2NkYGD4z8DAwMgAI0AMDA4wBQEwVxwAAAAASUVORK5CYII=') !important;
}

/* System Windows */
.sidebar, .content > header, .theme-popover {
  background-color: #c0c0c0 !important;
  border: 1px solid #000 !important;
  box-shadow: inset -1px -1px #404040, inset 1px 1px #ffffff !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

.content > header {
  margin-bottom: 4px;
}

.content > main {
  background-color: #c0c0c0 !important;
  border: 1px solid #000 !important;
  box-shadow: inset -1px -1px #404040, inset 1px 1px #ffffff !important;
  margin: 6px;
  overflow: auto;
}

/* Controls: Win95 / System 7 style 3D */
button, input, select, textarea, .search {
  background-color: #ffffff !important;
  border: 1px solid #000 !important;
  box-shadow: inset -1px -1px #ffffff, inset 1px 1px #404040 !important;
  transition: none !important;
}

button {
  background-color: #c0c0c0 !important;
  box-shadow: inset -1px -1px #404040, inset 1px 1px #ffffff !important;
  padding: 4px 12px !important;
  color: #000 !important;
}

button:active {
  box-shadow: inset 1px 1px #000, inset 2px 2px #404040 !important;
  transform: translate(1px, 1px);
}

button.primary {
  background-color: #0000a8 !important;
  color: #ffffff !important;
  box-shadow: inset -1px -1px #000, inset 1px 1px #5050ff !important;
}
button.primary:active {
  background-color: #000080 !important;
  box-shadow: inset 1px 1px #000, inset 2px 2px #000040 !important;
}
button.danger {
  color: #a80000 !important;
}

/* Nav */
.sidebar .nav {
  border: 1px solid transparent !important;
  box-shadow: none !important;
  background: transparent !important;
}
.sidebar .nav:hover {
  background-color: #0000a8 !important;
  color: #ffffff !important;
}
.sidebar .nav.active {
  background-color: #0000a8 !important;
  color: #ffffff !important;
  border: 1px dotted #ffffff !important;
}
.sidebar .nav:hover i, .sidebar .nav.active i { color: #ffffff !important; }

/* Tables */
.table-card {
  background-color: #ffffff !important;
  border: 1px solid #000 !important;
  box-shadow: inset -1px -1px #ffffff, inset 1px 1px #808080 !important;
}
.table-card th {
  background-color: #c0c0c0 !important;
  color: #000 !important;
  border-bottom: 1px solid #000 !important;
  border-right: 1px solid #808080 !important;
  box-shadow: inset -1px -1px #404040, inset 1px 1px #ffffff !important;
  text-transform: uppercase;
}
.table-card td {
  border-bottom: 1px solid #e0e0e0 !important;
}
.table-card tbody tr:hover {
  background-color: #0000a8 !important;
  color: #ffffff !important;
}
.table-card tbody tr:hover td,
.table-card tbody tr:hover small,
.table-card tbody tr:hover button {
  color: #ffffff !important;
}
.table-card tbody tr:hover button.outline {
  background-color: #c0c0c0 !important;
  color: #000 !important;
  border-color: #000 !important;
}

.table-card tbody tr.selected-row {
  background-color: #0000a8 !important;
  color: #ffffff !important;
}
.table-card tbody tr.selected-row td { color: #fff !important; }

/* Badges / Chips */
.group-chip {
  background-color: #c0c0c0 !important;
  border: 1px solid #000 !important;
  box-shadow: inset -1px -1px #404040, inset 1px 1px #ffffff !important;
}
.group-chip.active {
  background-color: #ffffff !important;
  color: #000 !important;
  box-shadow: inset 1px 1px #404040 !important;
}
.group-chip.active b { color: #000 !important; }

.env-badge {
  background: #0000a8 !important;
  color: #ffffff !important;
  border: 1px solid #000 !important;
  box-shadow: inset -1px -1px #000040, inset 1px 1px #5050ff !important;
  padding: 4px 8px !important;
}

.local-status-card {
  background-color: #c0c0c0 !important;
  border: 1px solid #000 !important;
  box-shadow: inset -1px -1px #404040, inset 1px 1px #ffffff !important;
}

/* Scrollbars - Classic Windows */
::-webkit-scrollbar { width: 16px; height: 16px; background: #dfdfdf; border-left: 1px solid #000; }
::-webkit-scrollbar-thumb { background: #c0c0c0; border: 1px solid #000; box-shadow: inset -1px -1px #404040, inset 1px 1px #ffffff; }
::-webkit-scrollbar-button { display: block; background: #c0c0c0; border: 1px solid #000; box-shadow: inset -1px -1px #404040, inset 1px 1px #ffffff; }

/* Checkboxes & Radios */
input[type="checkbox"], input[type="radio"] {
  appearance: none;
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border: 1px solid #000 !important;
  background: #ffffff !important;
  box-shadow: inset 1px 1px #808080 !important;
  display: inline-block;
  position: relative;
  cursor: pointer;
}
input[type="radio"] { border-radius: 50% !important; }
input[type="checkbox"]:checked::after {
  content: "✔"; position: absolute; top: -3px; left: 1px; color: #000; font-size: 12px;
}
input[type="radio"]:checked::after {
  content: ""; position: absolute; top: 3px; left: 3px; width: 6px; height: 6px; background: #000; border-radius: 50% !important;
}

/* Fix SVG rendering */
i[data-lucide] {
  stroke-width: 2 !important;
}

/* Header tweaks */
#page-title {
  color: #000 !important;
  text-shadow: 1px 1px 0 #fff;
}
`;

fs.writeFileSync('styles.css', styles + refinedRetro);
