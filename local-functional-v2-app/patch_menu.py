with open("renderer.js", "r") as f:
    js = f.read()

import re

# In switchView(view):
# when navigating to 'rpa', we need to make sure the nav-rpa-plus menu is open.
# The user complained about the submenus maybe? Let's check exactly what the user said:
# "这些子菜单被你遗漏了"
# "https://github.com/Dksie09/RetroUI 主题可以融入点这个仓库的风格"
# "你写的主题叫复古桌面 那个像素工作站的主题前端你不要动"
# They mentioned sub-menus were missing or something. Wait, in the image I can't see the sub-menus for API & MCP?
# Or maybe the user means the RPA sub-menus didn't expand properly?
