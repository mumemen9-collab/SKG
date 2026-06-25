@echo off
chcp 65001 >nul
title 混剪工坊（使用期间请勿关闭此窗口）
cd /d "%~dp0"
set "PATH=%~dp0runtime\node;%~dp0runtime\ffmpeg\bin;%PATH%"

echo.
echo   ====== 混剪工坊 ======
echo.
echo   正在启动服务，启动后会自动打开浏览器。
echo   若没自动打开，手动访问： http://localhost:5173
echo.
echo   【重要】使用期间请勿关闭此黑色窗口；用完直接关掉它即可停止服务。
echo.

REM 后台调用助手脚本：延时几秒后自动打开浏览器
start "" "%~dp0_openbrowser.bat"

REM 在本窗口前台运行服务（日志直接显示在这里）
"%~dp0runtime\node\node.exe" "%~dp0server.js"

echo.
echo   ------------------------------------------------------------
echo   服务已停止。如果上方出现红色报错，请把整屏截图发给我。
echo   按任意键关闭本窗口...
pause >nul
