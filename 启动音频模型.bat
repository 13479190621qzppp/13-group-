@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 启动 Basic Pitch（请先安装 Python 3.10/3.11 和 model\requirements.txt）
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" model\model_server.py
) else (
  py -3.10 model\model_server.py
)
if errorlevel 1 echo 如果没有 Python 3.10，请查看 README-后端模型.md 安装说明。
pause
