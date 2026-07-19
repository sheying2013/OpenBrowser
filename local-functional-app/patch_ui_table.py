with open("ui-shell.css", "r") as f:
    css = f.read()

import re

# We will modify the compact meta columns CSS to be even smaller in width, and use flex row in cell if needed.
# Since table cells rely on `max-width`, let's just make their padding smaller and text smaller, and font-size smaller.
css_patch = """
/* compact meta columns: group / browser / network / exit / ext / status */
#view-profiles .table-card th.col-group,
#view-profiles .table-card td.col-group,
#view-profiles .table-card th.col-browser,
#view-profiles .table-card td.col-browser,
#view-profiles .table-card th.col-network,
#view-profiles .table-card td.col-network,
#view-profiles .table-card th.col-exit,
#view-profiles .table-card td.col-exit,
#view-profiles .table-card th.col-ext,
#view-profiles .table-card td.col-ext,
#view-profiles .table-card th.col-status,
#view-profiles .table-card td.col-status {
  padding: 1px 3px !important;
  font-size: 9px !important;
  width: 1%;
  white-space: nowrap;
}
#view-profiles .table-card th.col-group,
#view-profiles .table-card td.col-group { max-width: 60px; overflow: hidden; text-overflow: ellipsis; }
#view-profiles .table-card th.col-browser,
#view-profiles .table-card td.col-browser { max-width: 50px; overflow: hidden; text-overflow: ellipsis; }
#view-profiles .table-card th.col-network,
#view-profiles .table-card td.col-network { max-width: 44px; overflow: hidden; text-overflow: ellipsis; }
#view-profiles .table-card th.col-exit,
#view-profiles .table-card td.col-exit { max-width: 86px; overflow: hidden; text-overflow: ellipsis; }
#view-profiles .table-card th.col-ext,
#view-profiles .table-card td.col-ext {
  max-width: 32px; width: 32px; text-align: center; color: var(--ui-muted); font-variant-numeric: tabular-nums;
}
#view-profiles .table-card th.col-status,
#view-profiles .table-card td.col-status { max-width: 44px; overflow: hidden; text-overflow: ellipsis; }
#view-profiles .table-card th.col-num,
#view-profiles .table-card td:nth-child(2) { width: 44px; max-width: 44px; font-size: 10px !important; }
"""

# replace the block
start_idx = css.find('/* compact meta columns: group / browser / network / exit / ext / status */')
end_idx = css.find('#view-profiles .table-card th.col-check,')

if start_idx != -1 and end_idx != -1:
    css = css[:start_idx] + css_patch.strip() + "\n" + css[end_idx:]

with open("ui-shell.css", "w") as f:
    f.write(css)
