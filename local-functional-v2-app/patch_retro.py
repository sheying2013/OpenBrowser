with open("styles.css", "r") as f:
    css = f.read()

import re

# Remove retro-desktop block to let element-admin/native OS take over if we revert it, OR just fix it up.
# Wait, the user said: "你直接把前端重构成复古像素风太丑了 界面颜色也要跟着改我他妈不是给你网站参考了吗 你怎么还做出这么丑的前端"
# They want us to KEEP the theme structure but make it look like poolsuite.net / RetroUI, which is more classical retro Macintosh/Windows 95, not this black-and-white flat mess.

# Let's replace the ugly hardcoded black/white retro-desktop CSS with an authentic Mac OS 9/Win95 retro theme.
# Poolsuite.net is Mac OS 7 / 9 style: Chicago font, pinstripes, dithering, sharp borders.
