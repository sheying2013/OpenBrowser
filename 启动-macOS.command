#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/local-functional-v2-app"
if [ ! -d node_modules/desktop-shell/dist ] && [ ! -d node_modules/electron/dist ]; then
  npm install --force --include=dev
fi
npm start
