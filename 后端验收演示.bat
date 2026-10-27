@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 18 或更高版本。
  pause
  exit /b 1
)
echo 运行后端 API 验收，不需要额外安装 npm 依赖。
node scripts\demo-backend.mjs
echo.
echo 结果已写入 reports\后端验收结果.json
pause
