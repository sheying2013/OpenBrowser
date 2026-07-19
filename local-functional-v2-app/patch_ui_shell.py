with open("ui-shell.css", "r") as f:
    css = f.read()

replacements = [
    ("border: 2px solid #000 !important; background: #fff !important; color: #000 !important;\n  box-shadow: 2px 2px 0 #000 !important; font: inherit; text-align: left; cursor: pointer;",
     "border: 1px solid var(--ui-border) !important; background: var(--ui-surface) !important; color: var(--ui-text) !important;\n  border-radius: var(--ui-radius-sm); box-shadow: none !important; font: inherit; text-align: left; cursor: pointer; transition: all 150ms ease;\n}\n.themed-select-button:hover:not(:disabled) { border-color: var(--ui-border-strong) !important; "),
    ("border-left: 2px solid #000;\n  background: #ddd; color: #000; font-size: 11px; line-height: 1;",
     "border-left: 1px solid var(--ui-border);\n  background: var(--ui-surface-muted); color: var(--ui-text); font-size: 11px; line-height: 1; border-radius: 0 var(--ui-radius-sm) var(--ui-radius-sm) 0;"),
    (".themed-select-button.open .themed-select-arrow { background: #000; color: #fff; }",
     ".themed-select-button.open .themed-select-arrow { background: var(--ui-border); }"),
    ("position: fixed; z-index: 100000; display: grid; align-content: start; overflow: auto;\n  padding: 3px; border: 2px solid #000; background: #fff; box-shadow: 4px 4px 0 #000;",
     "position: fixed; z-index: 100000; display: grid; align-content: start; overflow: auto; margin-top: 4px;\n  padding: 4px; border: 1px solid var(--ui-border); background: var(--ui-surface); box-shadow: var(--ui-shadow); border-radius: var(--ui-radius-sm);"),
    ("background: #fff !important; color: #000 !important; box-shadow: none !important;\n  font: inherit; text-align: left; text-transform: none !important; cursor: pointer;",
     "background: transparent !important; color: var(--ui-text) !important; box-shadow: none !important;\n  border-radius: 4px; font: inherit; text-align: left; text-transform: none !important; cursor: pointer; transition: background-color 100ms ease;"),
    (".themed-select-option:hover, .themed-select-option:focus-visible { outline: 0; background: #000 !important; color: #fff !important; }",
     ".themed-select-option:hover, .themed-select-option:focus-visible { outline: 0; background: var(--ui-surface-muted) !important; }"),
    (".themed-select-option:disabled { color: #777 !important; cursor: not-allowed; }",
     ".themed-select-option:disabled { color: var(--ui-muted) !important; cursor: not-allowed; }")
]

for old, new_ in replacements:
    css = css.replace(old, new_)

with open("ui-shell.css", "w") as f:
    f.write(css)
