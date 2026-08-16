@echo off
chcp 65001 >nul
title 通韵 TongYun BCI
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 python，请先安装 Python 3.9+
  pause
  exit /b 1
)

echo ==========================================
echo  通韵 TongYun BCI - 本地桥接服务
echo  页面: http://127.0.0.1:8765/
echo  停止: 按 Ctrl+C
echo ==========================================
echo.

if not exist "%~dp0frontend\dist\index.html" (
  echo [提示] 前端尚未构建：请先执行
  echo        cd frontend ^&^& npm install ^&^& npm run build ^&^& cd ..
  echo        构建完成后再次运行本脚本。
  pause
  exit /b 1
)

python backend\backend.py --repo "%~dp0tongyun-bci-algorithm"
if errorlevel 1 (
  echo.
  echo [提示] 若算法仓库不在 tongyun-bci-algorithm 子目录，
  echo        请用: python backend\backend.py --repo <算法仓库路径>
  pause
)
