@echo off
setlocal
cd /d "%~dp0"
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.12 or newer, then run this launcher again.
  pause
  exit /b 1
)
if not exist "node_modules\electron\cli.js" (
  echo Installing project dependencies...
  call npm.cmd ci
  if errorlevel 1 exit /b 1
)
set "ELECTRON_RUN_AS_NODE="
if not defined UM_USER_DATA_DIR set "UM_USER_DATA_DIR=%LOCALAPPDATA%\UnifiedMessenger-Development"
call npm.cmd start
if errorlevel 1 pause
