with open("index.html", "r") as f:
    html = f.read()

# move <button class="nav" data-view="rpa-guide"><i data-lucide="book-open"></i>说明文档</button>
# inside <div class="nav-sub" id="nav-rpa-plus">
import re

html = html.replace('<button class="nav" data-view="rpa-guide"><i data-lucide="book-open"></i>说明文档</button>\n', '')

# find the nav-sub closing div
target = '          <button class="nav nav-child" data-view="rpa" data-rpa-tab="store"><i data-lucide="store"></i>模板商店</button>\n'
insert = '          <button class="nav nav-child" data-view="rpa-guide"><i data-lucide="book-open"></i>说明文档</button>\n'

html = html.replace(target, target + insert)

with open("index.html", "w") as f:
    f.write(html)
