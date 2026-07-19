with open("ui-shell.css", "r") as f:
    css = f.read()

import re

# Mac OS lists don't have borders or margins typically, they take the full pane. But this is a web app.
# A web-like table has distinct borders, shadows, padding, background diffs.
# Let's make it look more like a native view.

native_patch = """
/* Native OS Table Overrides */
#view-profiles .table-card {
  border: none !important;
  border-radius: 0 !important;
  box-shadow: inset 0 0 0 1px var(--ui-border) !important;
  overflow: auto;
  border-radius: var(--ui-radius-sm) !important;
}
#view-profiles .table-card table {
  border-collapse: collapse;
}
#view-profiles .table-card th {
  background: var(--ui-surface) !important;
  border-bottom: 1px solid var(--ui-border) !important;
  font-weight: 500;
  box-shadow: none !important;
}
#view-profiles .table-card td {
  border-bottom: 1px solid var(--ui-border-light, rgba(23, 32, 48, 0.05)) !important;
}
"""

if "/* Native OS Table Overrides */" not in css:
    css += "\n" + native_patch

with open("ui-shell.css", "w") as f:
    f.write(css)
