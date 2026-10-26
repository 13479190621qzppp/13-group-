@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 18 或更高版本，再重新打开此文件。
  pause
  exit /b 1
)
echo 启动后请在浏览器打开 http://localhost:5173
node server.cjs
pause
