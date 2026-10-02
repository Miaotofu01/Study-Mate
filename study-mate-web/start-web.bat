@echo off
setlocal EnableExtensions
title StudyMate Web 一键启动

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "FRONTEND=%ROOT%frontend"

echo ================================================
echo   StudyMate Web 一键启动
echo   后端 FastAPI : http://127.0.0.1:8101
echo   前端 Next.js : http://127.0.0.1:3800
echo ================================================
echo.

if not exist "%BACKEND%\.venv\Scripts\python.exe" (
    echo [初始化] 首次运行：创建后端虚拟环境并安装依赖，约 1~2 分钟...
    pushd "%BACKEND%"
    python -m venv .venv
    if errorlevel 1 goto :fail_py
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 goto :fail_pip
    popd
    echo [初始化] 后端依赖就绪。
    echo.
)

if not exist "%FRONTEND%\node_modules" (
    echo [初始化] 首次运行：安装前端依赖（npm install），可能需要几分钟...
    pushd "%FRONTEND%"
    call npm install --legacy-peer-deps
    if errorlevel 1 goto :fail_npm
    popd
    echo [初始化] 前端依赖就绪。
    echo.
)

set "MODE=prod"
if not exist "%FRONTEND%\.next\BUILD_ID" set "MODE=dev"

echo [启动] 后端 FastAPI（端口 8101）...
start "StudyMate 后端" /D "%BACKEND%" cmd /k ".venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8101"

if "%MODE%"=="prod" (
    echo [启动] 前端 Next.js 生产模式（端口 3800）...
    start "StudyMate 前端" /D "%FRONTEND%" cmd /k "npx next start -p 3800"
) else (
    echo [启动] 前端 Next.js 开发模式（端口 3800，首次编译较慢）...
    start "StudyMate 前端" /D "%FRONTEND%" cmd /k "npm run dev"
)

if not exist "%SystemRoot%\System32\curl.exe" goto :open

echo [等待] 正在等待服务就绪...
set /a TRIES=0
:wait_backend
%SystemRoot%\System32\ping.exe -n 2 127.0.0.1 >nul
set /a TRIES+=1
if %TRIES% GEQ 60 goto :timeout
%SystemRoot%\System32\curl.exe -f -s -m 2 -o nul http://127.0.0.1:8101/api/health
if errorlevel 1 goto :wait_backend

set /a TRIES=0
:wait_frontend
%SystemRoot%\System32\ping.exe -n 2 127.0.0.1 >nul
set /a TRIES+=1
if %TRIES% GEQ 60 goto :timeout
%SystemRoot%\System32\curl.exe -f -s -m 2 -o nul -L http://127.0.0.1:3800/
if errorlevel 1 goto :wait_frontend

:open
start "" http://127.0.0.1:3800/
echo.
echo [完成] 已在浏览器打开 http://127.0.0.1:3800/
echo        停止服务：关闭"StudyMate 后端"与"StudyMate 前端"两个窗口即可。
echo.
pause
exit /b 0

:timeout
echo.
echo [警告] 等待超时（约 2 分钟），服务可能仍在启动或启动失败。
echo        请查看"StudyMate 后端"与"StudyMate 前端"窗口中的报错信息。
echo.
start "" http://127.0.0.1:3800/
pause
exit /b 1

:fail_py
echo [错误] 创建 Python 虚拟环境失败：请确认已安装 Python 3.10+ 并加入 PATH。
goto :fail_end
:fail_pip
echo [错误] 后端依赖安装失败：请检查网络后重新运行。
goto :fail_end
:fail_npm
echo [错误] 前端依赖安装失败：请确认已安装 Node.js 18+ 并检查网络。
goto :fail_end
:fail_end
popd 2>nul
echo.
pause
exit /b 1
