@echo off
REM 等待服务起来后再打开浏览器（由 start.bat 在后台调用）
timeout /t 4 >nul
start "" "http://localhost:5173"
