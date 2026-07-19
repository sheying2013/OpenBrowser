import re

with open("styles.css", "r") as f:
    css = f.read()

# We need to completely rewrite the `html[data-ui-theme="retro-desktop"]` section to look like poolsuite.net / RetroUI
# Poolsuite uses a lot of classic Mac OS styling:
# Fonts: Chicago, Geneva, MS Sans Serif (for windows)
# Colors: Beige/gray backgrounds, sharp black borders, striped backgrounds or checkered patterns.

retro_css = """
/* RETRO DESKTOP UI SKIN (Poolsuite / Mac OS 9 / Win95 style) */
html[data-ui-theme="retro-desktop"] {
  --ui-radius: 0px !important;
  --ui-radius-sm: 0px !important;
  --theme-bg: #c0c0c0 !important;
  --theme-surface: #c0c0c0 !important;
  --theme-surface-alt: #ffffff !important;
  --theme-text: #000000 !important;
  --theme-muted: #808080 !important;
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
  --ui-muted: #808080 !important;
  --ui-accent: #000080 !important;
  --ui-accent-soft: #000080 !important; /* using navy for selection */
  --ui-danger: #ff0000 !important;
  --ui-shadow: 1px 1px 0 #000 !important;
}

html[data-ui-theme="retro-desktop"] body,
html[data-ui-theme="retro-desktop"] .app-shell,
html[data-ui-theme="retro-desktop"] input,
html[data-ui-theme="retro-desktop"] select,
html[data-ui-theme="retro-desktop"] button,
html[data-ui-theme="retro-desktop"] textarea,
html[data-ui-theme="retro-desktop"] .table-card td {
  font-family: "MS Sans Serif", "Geneva", "Chicago", "PixelMplus10", sans-serif !important;
  -webkit-font-smoothing: none !important;
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
  box-shadow: inset 1px 1px #fff, inset -1px -1px #808080 !important;
  backdrop-filter: none !important;
}

html[data-ui-theme="retro-desktop"] .content > main {
  background: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAABlBMVEUAAAD///+l2Z/dAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAADklEQVQImWNgYGBgYAAAAwAQAQGE2R0cAAAAAElFTkSuQmCC') repeat !important;
  padding: 18px 22px 22px;
}

html[data-ui-theme="retro-desktop"] button,
html[data-ui-theme="retro-desktop"] input,
html[data-ui-theme="retro-desktop"] select,
html[data-ui-theme="retro-desktop"] textarea,
html[data-ui-theme="retro-desktop"] .search {
  background: #c0c0c0 !important;
  border: 2px solid #000 !important;
  box-shadow: inset 1px 1px #fff, inset -1px -1px #808080 !important;
  color: #000 !important;
}
html[data-ui-theme="retro-desktop"] input, html[data-ui-theme="retro-desktop"] textarea {
  background: #fff !important;
  box-shadow: inset 1px 1px #000, inset -1px -1px #fff !important;
}

html[data-ui-theme="retro-desktop"] button:active {
  box-shadow: inset 1px 1px #000, inset -1px -1px #fff !important;
  background: #808080 !important;
}

html[data-ui-theme="retro-desktop"] .sidebar .nav {
  border: 2px solid transparent !important;
  box-shadow: none !important;
  color: #000 !important;
  font-weight: normal !important;
}

html[data-ui-theme="retro-desktop"] .sidebar .nav:hover {
  background: transparent !important;
  border: 2px dotted #000 !important;
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
  box-shadow: inset 1px 1px #000, inset -1px -1px #fff !important;
}

html[data-ui-theme="retro-desktop"] .table-card table {
  background: #fff !important;
}

html[data-ui-theme="retro-desktop"] .table-card th {
  background: #c0c0c0 !important;
  color: #000 !important;
  border-bottom: 2px solid #000 !important;
  border-right: 1px solid #808080 !important;
  box-shadow: inset 1px 1px #fff !important;
}

html[data-ui-theme="retro-desktop"] .table-card td {
  border-bottom: 1px solid #c0c0c0 !important;
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
"""

# Extract the old retro-desktop styles and replace
# It starts at `/* RETRO DESKTOP UI SKIN` and probably ends around `html[data-ui-theme="retro-desktop"] thead {`

pattern = r'/\*\s*RETRO DESKTOP UI SKIN.*?(?=\n/\*|\n\n\n|\Z)'
# Regex is hard, let's just use string finding
start_idx = css.find('/* RETRO DESKTOP UI SKIN')
if start_idx != -1:
    end_idx = css.find('/* END RETRO DESKTOP', start_idx) # Let's assume there's no end tag, find the next comment or end of file
    if end_idx == -1:
        # Let's search for something that marks the end of retro-desktop block
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
