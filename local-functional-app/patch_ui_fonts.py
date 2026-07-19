# Let's import fonts from RetroUI if we can or standard Mac OS pixel fonts to make the retro desktop theme much better
# The user linked https://github.com/Dksie09/RetroUI. Retro UI typically uses standard web-safe pixel fonts like 'Pixelated', 'W95FA', 'Chicago'. Let's adjust the font styles.

with open("styles.css", "r") as f:
    css = f.read()

import re

# We will apply this retro CSS over the previous block we generated.
retro_css = """
/* RETRO DESKTOP UI SKIN (Poolsuite / Classic Retro UI style) */
@font-face {
  font-family: 'Chicago';
  src: local('Chicago'), local('PixelMplus10'), local('MS Sans Serif');
}

html[data-ui-theme="retro-desktop"] {
  --ui-radius: 0px !important;
  --ui-radius-sm: 0px !important;
  --theme-bg: #c0c0c0 !important;
  --theme-surface: #c0c0c0 !important;
  --theme-surface-alt: #ffffff !important;
  --theme-text: #000000 !important;
  --theme-muted: #404040 !important;
  --theme-accent-strong: #000080 !important;
  --theme-active: #000080 !important;
  --theme-soft: #c0c0c0 !important;
  --border: #000000 !important;
  --blue: #000080 !important;

  --ui-sidebar: #c0c0c0 !important;
  --ui-header: #c0c0c0 !important;
  --ui-surface: #c0c0c0 !important;
  --ui-surface-muted: #ffffff !important;
  --ui-border: #000000 !important;
  --ui-border-strong: #808080 !important;
  --ui-text: #000000 !important;
  --ui-muted: #404040 !important;
  --ui-accent: #000080 !important;
  --ui-accent-soft: #000080 !important;
  --ui-danger: #ff0000 !important;
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
  font-family: "MS Sans Serif", "Geneva", "Chicago", "PixelMplus10", monospace, sans-serif !important;
  -webkit-font-smoothing: none !important;
  letter-spacing: 0px !important;
}

html[data-ui-theme="retro-desktop"] * { border-radius: 0px !important; }

html[data-ui-theme="retro-desktop"] .app-shell {
  background: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAABlBMVEUAAAD///+l2Z/dAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAADklEQVQImWNgYGBgYAAAAwAQAQGE2R0cAAAAAElFTkSuQmCC') repeat !important;
}

html[data-ui-theme="retro-desktop"] .sidebar,
html[data-ui-theme="retro-desktop"] .content > header,
html[data-ui-theme="retro-desktop"] .theme-popover {
  background: #c0c0c0 !important;
  border-right: 2px solid #000 !important;
  border-bottom: 2px solid #000 !important;
  box-shadow: inset 1px 1px #dfdfdf, inset -1px -1px #808080 !important;
  backdrop-filter: none !important;
}

html[data-ui-theme="retro-desktop"] .content > header {
  border-bottom: 2px solid #000 !important;
}

html[data-ui-theme="retro-desktop"] .content > main {
  background: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAABlBMVEUAAAD///+l2Z/dAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAADklEQVQImWNgYGBgYAAAAwAQAQGE2R0cAAAAAElFTkSuQmCC') repeat !important;
  padding: 18px 22px 22px;
}

html[data-ui-theme="retro-desktop"] button,
html[data-ui-theme="retro-desktop"] input,
html[data-ui-theme="retro-desktop"] select,
html[data-ui-theme="retro-desktop"] textarea,
html[data-ui-theme="retro-desktop"] .search,
html[data-ui-theme="retro-desktop"] .themed-select-button {
  background: #c0c0c0 !important;
  border: 1px solid #000 !important;
  box-shadow: inset 1px 1px #fff, inset -1px -1px #808080, inset 2px 2px #dfdfdf, inset -2px -2px #404040 !important;
  color: #000 !important;
}

html[data-ui-theme="retro-desktop"] input, html[data-ui-theme="retro-desktop"] textarea, html[data-ui-theme="retro-desktop"] .search {
  background: #fff !important;
  box-shadow: inset 1px 1px #808080, inset -1px -1px #fff, inset 2px 2px #000, inset -2px -2px #dfdfdf !important;
}

html[data-ui-theme="retro-desktop"] button:active,
html[data-ui-theme="retro-desktop"] .themed-select-button:active {
  box-shadow: inset 1px 1px #000, inset -1px -1px #fff, inset 2px 2px #808080, inset -2px -2px #dfdfdf !important;
  background: #c0c0c0 !important;
}

html[data-ui-theme="retro-desktop"] .sidebar .nav {
  border: 1px solid transparent !important;
  box-shadow: none !important;
  color: #000 !important;
  font-weight: bold !important;
}

html[data-ui-theme="retro-desktop"] .sidebar .nav:hover {
  background: transparent !important;
  border: 1px dotted #000 !important;
}

html[data-ui-theme="retro-desktop"] .sidebar .nav.active {
  background: #000080 !important;
  color: #fff !important;
}

html[data-ui-theme="retro-desktop"] .sidebar .nav.active i {
  color: #fff !important;
}

html[data-ui-theme="retro-desktop"] .table-card {
  background: #fff !important;
  border: 2px solid #000 !important;
  box-shadow: 2px 2px 0px 0px #000 !important;
}

html[data-ui-theme="retro-desktop"] .table-card table {
  background: #fff !important;
}

html[data-ui-theme="retro-desktop"] .table-card th {
  background: #c0c0c0 !important;
  color: #000 !important;
  border-bottom: 2px solid #000 !important;
  border-right: 1px solid #000 !important;
  box-shadow: inset 1px 1px #dfdfdf, inset -1px -1px #808080 !important;
  text-transform: uppercase;
}

html[data-ui-theme="retro-desktop"] .table-card td {
  border-bottom: 1px solid #c0c0c0 !important;
  border-right: 1px solid #c0c0c0 !important;
}

html[data-ui-theme="retro-desktop"] .table-card tbody tr:hover {
  background: #000080 !important;
  color: #fff !important;
}
html[data-ui-theme="retro-desktop"] .table-card tbody tr:hover td {
  color: #fff !important;
}
html[data-ui-theme="retro-desktop"] .table-card tbody tr:hover button {
  background: #c0c0c0 !important;
  color: #000 !important;
}

html[data-ui-theme="retro-desktop"] .table-card tbody tr.selected-row {
  background: #000080 !important;
  color: #fff !important;
}

html[data-ui-theme="retro-desktop"] .env-badge {
  background: #000080 !important;
  color: #fff !important;
  border: 2px solid #000 !important;
}

html[data-ui-theme="retro-desktop"] .themed-select-menu {
  background: #fff !important;
  border: 2px solid #000 !important;
  box-shadow: 2px 2px 0px 0px #000 !important;
}

html[data-ui-theme="retro-desktop"] .themed-select-option:hover {
  background: #000080 !important;
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
