@echo off
chcp 65001 >nul
title 通韵 TongYun 桌面版
cd /d "%~dp0desktop"

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo 首次运行：正在安装桌面依赖（Electron）…
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
  )
)

if not exist "%~dp0frontend\dist\index.html" (
  echo [提示] 前端尚未构建：先执行 frontend 目录下的 npm run build
  pause
  exit /b 1
)

call npm start
