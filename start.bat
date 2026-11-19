@echo off
rem Quiz Party launcher. ASCII only: cmd misreads UTF-8 lines around goto.
cd /d "%~dp0"
title Quiz Party
rem Bundled Node.js (portable build): nothing to install
set "NODE=runtime\win-x64\node.exe"
if exist "%NODE%" if exist node_modules goto run
set "NODE=node"
where node >nul 2>nul || goto nonode
if not exist node_modules call npm install --omit=dev

:run
"%NODE%" server.js --open
rem exit code 42 = app updated itself, start the new version
:again
if errorlevel 42 if not errorlevel 43 (
  "%NODE%" server.js
  goto again
)
pause
exit /b

:nonode
echo Node.js not found. Download quiz-party-portable.zip:
echo https://github.com/artemfrikk/quiz-party/releases/latest
pause
exit /b 1
