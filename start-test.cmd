@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0local-functional-app"
if errorlevel 1 (
  echo Failed to enter OpenBrowser app directory.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to start OpenBrowser.
  echo Install Node.js LTS, then run: npm install
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is required to start OpenBrowser.
  echo Install Node.js LTS, then run: npm install
  pause
  exit /b 1
)

if not exist "node_modules\desktop-shell\dist" if not exist "node_modules\electron\dist" (
  echo OpenBrowser Windows runtime is missing or was installed for another platform.
  echo Installing Windows runtime now...
  call npm install --force --include=dev
  if errorlevel 1 (
    echo Windows runtime installation failed.
    pause
    exit /b 1
  )
)

if not exist "node_modules\desktop-shell\dist" if not exist "node_modules\electron\dist" (
  echo OpenBrowser Windows runtime is still missing after reinstall.
  pause
  exit /b 1
)

call npm start
if errorlevel 1 (
  echo OpenBrowser exited with an error.
  pause
  exit /b %errorlevel%
)
