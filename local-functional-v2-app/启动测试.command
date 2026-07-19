#!/bin/bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

if [ ! -d "node_modules/desktop-shell" ] && [ ! -x "node_modules/.bin/desktop-shell" ]; then
  echo "缺少应用运行环境，请先在项目目录执行 npm install。"
  read -r -p "按回车键关闭..." _
  exit 1
fi

exec node scripts/run-app.js
