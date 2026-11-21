@echo off
chcp 65001 >nul
title SAMA TOUR
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js n'est pas installe : telechargez-le sur https://nodejs.org & pause & exit /b 1)
start "" http://localhost:3000/agent
node server.js
pause
