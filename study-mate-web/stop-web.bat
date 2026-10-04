@echo off
setlocal EnableExtensions
title StudyMate Web 停止

rem 停止 StudyMate Web 的前后端服务：按端口找到监听进程，连同它所在的窗口
rem 与残留孤儿进程一起结束。start-web.bat stop 与它等价。
rem 端口可用环境变量覆盖：SM_WEB_BACKEND_PORT / SM_WEB_FRONTEND_PORT

set "ROOT=%~dp0"
set "TOOL=%ROOT%tools\studymate-web.ps1"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass"

if not defined SM_WEB_BACKEND_PORT set "SM_WEB_BACKEND_PORT=8101"
if not defined SM_WEB_FRONTEND_PORT set "SM_WEB_FRONTEND_PORT=3800"

echo ================================================
echo   StudyMate Web 停止服务
echo ================================================
echo.
echo [停止] 停止端口 %SM_WEB_BACKEND_PORT% / %SM_WEB_FRONTEND_PORT% 上的服务...
%PS% -File "%TOOL%" -Action stop -BackendPort %SM_WEB_BACKEND_PORT% -FrontendPort %SM_WEB_FRONTEND_PORT%
echo.
echo [完成] 处理完毕。上面每行的含义：
echo        STOPPING / KILLING = 正在结束进程；STOPPED = 已停止并关掉对应窗口；
echo        NOTRUNNING = 该端口本来没在跑；FAILED = 停止失败，端口仍被占用。
echo.
%SystemRoot%\System32\ping.exe -n 4 127.0.0.1 >nul
exit /b 0
