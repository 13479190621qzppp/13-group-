@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ===== 随音课程交付检查 =====
echo 1. Node/npm 版本
node -v
call npm.cmd -v
if errorlevel 1 goto :failed
echo.
echo 2. 自动化测试（以本机实际结果为准）
call npm.cmd test
if errorlevel 1 goto :failed
echo.
echo 3. API 延迟本机实测（单独起测试服务）
call npm.cmd run benchmark
if errorlevel 1 goto :failed
echo.
echo 4. 模型部署情况需另行在 Windows 使用 Python 3.10 安装并验证
echo 详见课程交付-部署与模型调用.md
echo 数据在 benchmarks\last-run.json
pause
exit /b 0
:failed
echo 检查有失败项，请截图错误输出并查看文档。
pause
exit /b 1
