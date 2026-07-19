with open("renderer.js", "r") as f:
    js = f.read()

# Make sure toggle works flawlessly.
import re

# In switchView(view), if view is 'rpa', ensure menu is block.
# Actually, the user might be complaining about how RPA sub-menus are handled during view switching or that clicking "自动脚本" doesn't navigate to the first sub-menu.
# Let's see what rpa-menu-toggle click event does:
old_toggle = """document.getElementById('rpa-menu-toggle')?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const menu = document.getElementById('nav-rpa-plus');
  const toggle = document.getElementById('rpa-menu-toggle');
  if (!menu || !toggle) return;
  const isCurrentlyHidden = menu.hidden || menu.style.display === 'none';
  if (isCurrentlyHidden) {
    menu.hidden = false;
    menu.style.display = 'block';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.classList.add('open');
  } else {
    menu.hidden = true;
    menu.style.display = 'none';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.classList.remove('open');
  }
});"""

new_toggle = """document.getElementById('rpa-menu-toggle')?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const menu = document.getElementById('nav-rpa-plus');
  const toggle = document.getElementById('rpa-menu-toggle');
  if (!menu || !toggle) return;
  const isCurrentlyHidden = menu.hidden || menu.style.display === 'none';
  if (isCurrentlyHidden) {
    menu.hidden = false;
    menu.style.display = 'block';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.classList.add('open');
    switchView('rpa', currentRpaTab || 'flows'); // Automatically open first sub-menu when expanded
  } else {
    menu.hidden = true;
    menu.style.display = 'none';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.classList.remove('open');
  }
});"""

if old_toggle in js:
    js = js.replace(old_toggle, new_toggle)
else:
    print("Could not find toggle logic exactly to patch")

with open("renderer.js", "w") as f:
    f.write(js)
