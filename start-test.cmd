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

rem ---------------------------------------------------------------------------
rem Kernel seed for this source checkout.
rem
rem Browserapp\kernels\windows-x64 is stored with Git LFS, so a plain checkout
rem only has ~130-byte pointer files there and no runnable kernel. When that is
rem the case, point the seed at the kernel of an installed OpenBrowser build
rem instead of copying it (~1.9 GB). A real kernel already in the tree wins and
rem is left untouched.
rem
rem The installed kernel is looked for in this order:
rem   1. %OPENBROWSER_INSTALLED_KERNEL_ROOT% - a complete seed dir, the one that
rem      holds chrome.exe and chrome.dll
rem   2. %OPENBROWSER_KERNEL_ROOT% - a resource root containing kernels\windows-x64
rem      (this is the variable the app itself reads)
rem   3. the standard install locations below
rem Set one of the two variables when OpenBrowser is installed elsewhere.
rem ---------------------------------------------------------------------------
set "KERNEL_SEED=%~dp0Browserapp\kernels\windows-x64"
set "INSTALLED_KERNEL="
if defined OPENBROWSER_INSTALLED_KERNEL_ROOT if exist "%OPENBROWSER_INSTALLED_KERNEL_ROOT%\chrome.dll" set "INSTALLED_KERNEL=%OPENBROWSER_INSTALLED_KERNEL_ROOT%"
if not defined INSTALLED_KERNEL if defined OPENBROWSER_KERNEL_ROOT if exist "%OPENBROWSER_KERNEL_ROOT%\kernels\windows-x64\chrome.dll" set "INSTALLED_KERNEL=%OPENBROWSER_KERNEL_ROOT%\kernels\windows-x64"
if not defined INSTALLED_KERNEL if defined OPENBROWSER_KERNEL_ROOT if exist "%OPENBROWSER_KERNEL_ROOT%\windows-x64\chrome.dll" set "INSTALLED_KERNEL=%OPENBROWSER_KERNEL_ROOT%\windows-x64"
if not defined INSTALLED_KERNEL if exist "%ProgramFiles%\OpenBrowser\runtime\resources\app\kernels\windows-x64\chrome.dll" set "INSTALLED_KERNEL=%ProgramFiles%\OpenBrowser\runtime\resources\app\kernels\windows-x64"
if not defined INSTALLED_KERNEL if exist "%LOCALAPPDATA%\Programs\OpenBrowser\runtime\resources\app\kernels\windows-x64\chrome.dll" set "INSTALLED_KERNEL=%LOCALAPPDATA%\Programs\OpenBrowser\runtime\resources\app\kernels\windows-x64"

set "KERNEL_SEED_OK="
if exist "%KERNEL_SEED%\chrome.dll" for %%A in ("%KERNEL_SEED%\chrome.dll") do if %%~zA GEQ 1000000 set "KERNEL_SEED_OK=1"
if defined KERNEL_SEED_OK goto :kernel_seed_done

if defined INSTALLED_KERNEL (
  echo [OpenBrowser] Kernel seed is a Git LFS placeholder - linking the installed kernel.
  if exist "%KERNEL_SEED%\chrome.exe" ren "%KERNEL_SEED%" "windows-x64.lfs-stub" 2>nul
  rmdir "%KERNEL_SEED%" 2>nul
  mklink /J "%KERNEL_SEED%" "%INSTALLED_KERNEL%" >nul
  if errorlevel 1 (
    echo [OpenBrowser] Could not link the kernel. Install one into:
    echo                %KERNEL_SEED%
    echo [OpenBrowser] or run "git lfs pull" in Browserapp.
  ) else (
    echo [OpenBrowser] Kernel linked: %KERNEL_SEED% -^> %INSTALLED_KERNEL%
  )
) else (
  echo [OpenBrowser] Browserapp\kernels\windows-x64 is not a runnable kernel and no
  echo [OpenBrowser] installed OpenBrowser kernel was found. Do one of:
  echo [OpenBrowser]   - install OpenBrowser, then run this script again
  echo [OpenBrowser]   - run "git lfs pull" in Browserapp ^(~1.9 GB^)
  echo [OpenBrowser]   - set OPENBROWSER_INSTALLED_KERNEL_ROOT to a complete
  echo [OpenBrowser]     kernels\windows-x64 directory containing chrome.dll
)
:kernel_seed_done

call npm start
if errorlevel 1 (
  echo OpenBrowser exited with an error.
  pause
  exit /b %errorlevel%
)
