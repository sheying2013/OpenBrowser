with open("styles.css", "r") as f:
    css = f.read()

import re

# Update retro theme block to be cleaner and look more like poolsuite
# Poolsuite uses Macintosh OS 7 / 9 visual language: horizontal pinstripes, Chicago font, sharp 1px borders, bold headers, Chicago/Geneva.

retro_css = """
/* RETRO DESKTOP UI SKIN (Poolsuite / Mac OS 9 style) */
@font-face {
  font-family: 'Chicago';
  src: local('Chicago'), local('PixelMplus10'), local('MS Sans Serif');
}

html[data-ui-theme="retro-desktop"] {
  --ui-radius: 0px !important;
  --ui-radius-sm: 0px !important;
  --theme-bg: #dddddd !important;
  --theme-surface: #eeeeee !important;
  --theme-surface-alt: #ffffff !important;
  --theme-text: #000000 !important;
  --theme-muted: #555555 !important;
  --theme-accent-strong: #000000 !important;
  --theme-active: #000000 !important;
  --theme-soft: #dddddd !important;
  --border: #000000 !important;
  --blue: #000000 !important;

  --ui-sidebar: #dddddd !important;
  --ui-header: #dddddd !important;
  --ui-surface: #eeeeee !important;
  --ui-surface-muted: #ffffff !important;
  --ui-border: #000000 !important;
  --ui-border-strong: #000000 !important;
  --ui-text: #000000 !important;
  --ui-muted: #555555 !important;
  --ui-accent: #000000 !important;
  --ui-accent-soft: #cccccc !important;
  --ui-danger: #000000 !important;
  --ui-shadow: 2px 2px 0 #000 !important;
}

html[data-ui-theme="retro-desktop"] body,
html[data-ui-theme="retro-desktop"] .app-shell,
html[data-ui-theme="retro-desktop"] input,
html[data-ui-theme="retro-desktop"] select,
html[data-ui-theme="retro-desktop"] button,
html[data-ui-theme="retro-desktop"] textarea,
html[data-ui-theme="retro-desktop"] .table-card td,
html[data-ui-theme="retro-desktop"] .table-card th,
html[data-ui-theme="retro-desktop"] .brand strong,
html[data-ui-theme="retro-desktop"] h1,
html[data-ui-theme="retro-desktop"] h2,
html[data-ui-theme="retro-desktop"] .nav,
html[data-ui-theme="retro-desktop"] .themed-select-button,
html[data-ui-theme="retro-desktop"] .themed-select-option {
  font-family: "Geneva", "Chicago", "Helvetica", sans-serif !important;
  -webkit-font-smoothing: antialiased !important;
  letter-spacing: 0px !important;
}

html[data-ui-theme="retro-desktop"] h1,
html[data-ui-theme="retro-desktop"] h2,
html[data-ui-theme="retro-desktop"] .brand strong,
html[data-ui-theme="retro-desktop"] .table-card th {
  font-family: "Chicago", "Helvetica", sans-serif !important;
}

html[data-ui-theme="retro-desktop"] * { border-radius: 0px !important; }

html[data-ui-theme="retro-desktop"] .app-shell {
  background: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAABZJREFUeNpi2rVrf2QEAwgwQQgwAEGAAABBAAFlk71AAAAAAElFTkSuQmCC') repeat !important;
}

html[data-ui-theme="retro-desktop"] .sidebar,
html[data-ui-theme="retro-desktop"] .content > header,
html[data-ui-theme="retro-desktop"] .theme-popover {
  background: #dddddd !important;
  border-right: 1px solid #000 !important;
  border-bottom: 1px solid #000 !important;
  box-shadow: inset 1px 1px #fff, inset -1px -1px #808080 !important;
  backdrop-filter: none !important;
}

html[data-ui-theme="retro-desktop"] .content > header {
  border-bottom: 1px solid #000 !important;
}

html[data-ui-theme="retro-desktop"] .content > main {
  background: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAABZJREFUeNpi2rVrf2QEAwgwQQgwAEGAAABBAAFlk71AAAAAAElFTkSuQmCC') repeat !important;
  padding: 18px 22px 22px;
}

html[data-ui-theme="retro-desktop"] button,
html[data-ui-theme="retro-desktop"] input,
html[data-ui-theme="retro-desktop"] select,
html[data-ui-theme="retro-desktop"] textarea,
html[data-ui-theme="retro-desktop"] .search,
html[data-ui-theme="retro-desktop"] .themed-select-button {
  background: #dddddd !important;
  border: 1px solid #000 !important;
  box-shadow: inset 1px 1px #fff, inset -1px -1px #808080 !important;
  color: #000 !important;
  font-weight: bold;
}

html[data-ui-theme="retro-desktop"] input, html[data-ui-theme="retro-desktop"] textarea, html[data-ui-theme="retro-desktop"] .search {
  background: #fff !important;
  box-shadow: inset 1px 1px #808080, inset -1px -1px #fff !important;
  font-weight: normal;
}

html[data-ui-theme="retro-desktop"] button:active,
html[data-ui-theme="retro-desktop"] .themed-select-button:active {
  box-shadow: inset 1px 1px #808080, inset -1px -1px #fff !important;
  background: #cccccc !important;
}

html[data-ui-theme="retro-desktop"] .sidebar .nav {
  border: 1px solid transparent !important;
  box-shadow: none !important;
  color: #000 !important;
  font-weight: normal !important;
}

html[data-ui-theme="retro-desktop"] .sidebar .nav:hover {
  background: transparent !important;
  border: 1px dotted #000 !important;
}

html[data-ui-theme="retro-desktop"] .sidebar .nav.active {
  background: #000 !important;
  color: #fff !important;
}

html[data-ui-theme="retro-desktop"] .sidebar .nav.active i {
  color: #fff !important;
}

html[data-ui-theme="retro-desktop"] .table-card {
  background: #fff !important;
  border: 1px solid #000 !important;
  box-shadow: 2px 2px 0px 0px #000 !important;
}

html[data-ui-theme="retro-desktop"] .table-card table {
  background: #fff !important;
}

html[data-ui-theme="retro-desktop"] .table-card th {
  background: #dddddd !important;
  color: #000 !important;
  border-bottom: 1px solid #000 !important;
  border-right: 1px solid #000 !important;
  box-shadow: inset 1px 1px #fff, inset -1px -1px #808080 !important;
  text-transform: uppercase;
}

html[data-ui-theme="retro-desktop"] .table-card td {
  border-bottom: 1px solid #dddddd !important;
  border-right: 1px solid #dddddd !important;
}

html[data-ui-theme="retro-desktop"] .table-card tbody tr:hover {
  background: #000 !important;
  color: #fff !important;
}
html[data-ui-theme="retro-desktop"] .table-card tbody tr:hover td {
  color: #fff !important;
}
html[data-ui-theme="retro-desktop"] .table-card tbody tr:hover button {
  background: #cccccc !important;
  color: #000 !important;
}

html[data-ui-theme="retro-desktop"] .table-card tbody tr.selected-row {
  background: #000 !important;
  color: #fff !important;
}

html[data-ui-theme="retro-desktop"] .env-badge {
  background: #000 !important;
  color: #fff !important;
  border: 1px solid #000 !important;
}

html[data-ui-theme="retro-desktop"] .themed-select-menu {
  background: #eeeeee !important;
  border: 1px solid #000 !important;
  box-shadow: 2px 2px 0px 0px #000 !important;
}

html[data-ui-theme="retro-desktop"] .themed-select-option:hover {
  background: #000 !important;
  color: #fff !important;
}
"""

start_idx = css.find('/* RETRO DESKTOP UI SKIN')
if start_idx != -1:
    end_idx = css.rfind('html[data-ui-theme="retro-desktop"]')
    if end_idx != -1:
        end_brace = css.find('}', end_idx)
        if end_brace != -1:
            end_idx = end_brace + 1

    if end_idx != -1:
        css = css[:start_idx] + retro_css + css[end_idx:]
    else:
        css += "\n" + retro_css
else:
    css += "\n" + retro_css

with open("styles.css", "w") as f:
    f.write(css)
