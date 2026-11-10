@echo off
chcp 65001 >nul
title ScreenDeck
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "D:\Softwares\node\node.exe" set "NODE_EXE=D:\Softwares\node\node.exe"
if not defined NODE_EXE (
  echo [ERROR] Node.js not found.
  echo   - not in PATH
  echo   - and D:\Softwares\node\node.exe does not exist
  pause
  exit /b 1
)

echo Starting ScreenDeck ...
echo.
"%NODE_EXE%" "%~dp0scripts\launcher.js" 
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo [ScreenDeck exited with code %EXITCODE%]
  echo Boot log: %TEMP%\screendeck-boot.log
  pause
)
exit /b %EXITCODE%
