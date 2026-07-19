@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0Browserapp"
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

call npm start
if errorlevel 1 (
  echo OpenBrowser exited with an error.
  pause
  exit /b %errorlevel%
)
