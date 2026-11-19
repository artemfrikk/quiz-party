@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Quiz Party
rem Встроенный Node.js (переносная сборка) - ничего устанавливать не нужно
set "NODE=runtime\win-x64\node.exe"
if exist "%NODE%" if exist node_modules goto run
set "NODE=node"
where node >nul 2>nul || (echo Node.js не найден. Скачайте переносную сборку квиза или установите Node.js с https://nodejs.org && pause && exit /b 1)
if not exist node_modules (
  echo Устанавливаю зависимости, это нужно только один раз...
  call npm install --omit=dev
)

:run
"%NODE%" server.js --open
rem код 42 - приложение обновилось, запускаем новую версию
:again
if errorlevel 42 if not errorlevel 43 (
  echo Обновление установлено, перезапускаю...
  "%NODE%" server.js
  goto again
)
pause
