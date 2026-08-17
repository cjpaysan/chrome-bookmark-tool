@echo off
cd /d "%~dp0"
start "" node src/server.js
timeout /t 2 >nul
start http://localhost:4789
