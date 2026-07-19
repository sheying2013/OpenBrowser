#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/local-functional-app"
if [ ! -d node_modules/desktop-shell/dist ] && [ ! -d node_modules/electron/dist ]; then
  npm install --force --include=dev
fi
npm start
