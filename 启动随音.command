#!/bin/bash

# Finder 双击时也能找到 Apple Silicon / Intel Mac 上的 Homebrew Node.js。
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "$(dirname -- "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先从 https://nodejs.org 安装当前 LTS 版本，再双击此文件。"
  read -r -p "按回车键退出…"
  exit 1
fi

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  echo "需要 Node.js 18 或更新版本，请从 https://nodejs.org 安装当前 LTS 版本。"
  read -r -p "按回车键退出…"
  exit 1
fi

echo "正在启动随音，成功后会自动打开默认浏览器。"
echo "使用期间请保持此终端窗口开启；按 Control+C 停止服务。"
node server.cjs --open
result=$?
if [ "$result" -ne 0 ]; then
  read -r -p "启动失败，请查看上方提示。按回车键退出…"
fi
exit "$result"
