@echo off
setlocal EnableExtensions
title StudyMate Web 启动器

rem ============================================================
rem  StudyMate Web 一键启动 / 停止
rem    start-web.bat          启动（前端源码比构建新时自动重新构建）
rem    start-web.bat dev      强制开发模式（热编译，跳过构建）
rem    start-web.bat restart  先停掉残留服务再启动
rem    start-web.bat stop     停止服务（连服务窗口一起收掉）
rem    start-web.bat help     显示帮助
rem  端口可用环境变量覆盖：SM_WEB_BACKEND_PORT / SM_WEB_FRONTEND_PORT
rem ============================================================

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "FRONTEND=%ROOT%frontend"
set "TOOL=%ROOT%tools\studymate-web.ps1"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass"
set "STATE_FILE=%TEMP%\studymate-buildstate.txt"

if not defined SM_WEB_BACKEND_PORT set "SM_WEB_BACKEND_PORT=8101"
if not defined SM_WEB_FRONTEND_PORT set "SM_WEB_FRONTEND_PORT=3800"
set "BACKEND_PORT=%SM_WEB_BACKEND_PORT%"
set "FRONTEND_PORT=%SM_WEB_FRONTEND_PORT%"
set "URL=http://127.0.0.1:%FRONTEND_PORT%/"
set "MODE="
set "FORCE_DEV="
set "DO_STOP_FIRST="

if /i "%~1"=="stop" goto :stop
if /i "%~1"=="help" goto :usage
if /i "%~1"=="dev" goto :arg_dev
if /i "%~1"=="restart" goto :arg_restart
goto :main

:arg_dev
set "FORCE_DEV=1"
goto :main

:arg_restart
set "DO_STOP_FIRST=1"
goto :main

:main
echo ================================================
echo   StudyMate Web 一键启动
echo   后端 FastAPI : http://127.0.0.1:%BACKEND_PORT%
echo   前端 Next.js : http://127.0.0.1:%FRONTEND_PORT%
echo ================================================
echo.

if not exist "%BACKEND%\.venv\Scripts\python.exe" call :init_backend
if not exist "%FRONTEND%\node_modules" call :init_frontend
if defined DO_STOP_FIRST call :stop_services

call :check_port %BACKEND_PORT% BACKEND_BUSY
call :check_port %FRONTEND_PORT% FRONTEND_BUSY
if defined BACKEND_BUSY goto :busy
if defined FRONTEND_BUSY goto :busy

if defined FORCE_DEV set "MODE=dev"
if defined MODE goto :mode_ready

if not exist "%FRONTEND%\.next\BUILD_ID" set "MODE=dev"
if defined MODE goto :mode_ready

%PS% -File "%TOOL%" -Action state -Frontend "%FRONTEND%" > "%STATE_FILE%" 2>nul
set "BUILD_STATE="
set /p BUILD_STATE=<"%STATE_FILE%"
if /i "%BUILD_STATE%"=="FRESH" goto :state_fresh
if /i "%BUILD_STATE%"=="STALE-NOBUILD" goto :state_nobuild

echo [构建] 前端源码比上次构建新，正在重新构建（npm run build，约 1~2 分钟）。
type "%STATE_FILE%"
echo         想跳过构建、直接用热编译：start-web.bat dev
pushd "%FRONTEND%"
call npm run build
set "BUILD_RC=%ERRORLEVEL%"
popd
del "%STATE_FILE%" 2>nul
if not "%BUILD_RC%"=="0" goto :fail_build
echo [构建] 完成。
echo.
set "MODE=prod"
goto :mode_ready

:state_fresh
del "%STATE_FILE%" 2>nul
set "MODE=prod"
goto :mode_ready

:state_nobuild
del "%STATE_FILE%" 2>nul
set "MODE=dev"
goto :mode_ready

:mode_ready
echo [启动] 后端 FastAPI（端口 %BACKEND_PORT%）...
start "StudyMate 后端" /D "%BACKEND%" cmd /k ".venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port %BACKEND_PORT%"

if /i "%MODE%"=="dev" goto :start_dev
echo [启动] 前端 Next.js 生产模式（端口 %FRONTEND_PORT%）...
start "StudyMate 前端" /D "%FRONTEND%" cmd /k "node node_modules\next\dist\bin\next start -p %FRONTEND_PORT%"
goto :wait

:start_dev
echo [启动] 前端 Next.js 开发模式（端口 %FRONTEND_PORT%，首次访问要现编译，会慢一些）...
start "StudyMate 前端" /D "%FRONTEND%" cmd /k "node node_modules\next\dist\bin\next dev -p %FRONTEND_PORT%"
goto :wait

:wait
if not exist "%SystemRoot%\System32\curl.exe" goto :open
echo [等待] 正在等待服务就绪...

set /a TRIES=0
:wait_backend
%SystemRoot%\System32\ping.exe -n 2 127.0.0.1 >nul
set /a TRIES+=1
if %TRIES% GEQ 60 goto :timeout
%SystemRoot%\System32\curl.exe -f -s -m 2 -o nul http://127.0.0.1:%BACKEND_PORT%/api/health
if errorlevel 1 goto :wait_backend

set /a TRIES=0
:wait_frontend
%SystemRoot%\System32\ping.exe -n 2 127.0.0.1 >nul
set /a TRIES+=1
if %TRIES% GEQ 90 goto :timeout
%SystemRoot%\System32\curl.exe -f -s -m 2 -o nul -L %URL%
if errorlevel 1 goto :wait_frontend

:open
start "" %URL%
echo.
echo [完成] 已在浏览器打开 %URL%
echo        前端模式：%MODE%
echo        · 本窗口会自动关闭，关掉它不影响服务
echo        · 服务跑在「StudyMate 后端」「StudyMate 前端」两个窗口里，关掉哪个就停哪个
echo        · 一键全停：双击 stop-web.bat
echo.
%SystemRoot%\System32\ping.exe -n 3 127.0.0.1 >nul
exit /b 0

:timeout
echo.
echo [警告] 等待超时（约 2~3 分钟），服务可能仍在启动或启动失败。
echo        请查看「StudyMate 后端」「StudyMate 前端」窗口里的报错信息。
start "" %URL%
goto :fail_end

:busy
echo.
echo [中止] 端口被占用，已取消启动（避免新旧实例重叠）。占用情况：
if defined BACKEND_BUSY echo        后端端口 %BACKEND_PORT% 被 PID %BACKEND_BUSY% 占用
if defined FRONTEND_BUSY echo        前端端口 %FRONTEND_PORT% 被 PID %FRONTEND_BUSY% 占用
echo        这种情况通常是上一轮没关干净的服务窗口或残留进程。
echo        处理方式（任选一种）：
echo          · 双击 stop-web.bat，或运行 start-web.bat stop，然后重新启动
echo          · 直接运行 start-web.bat restart（先停再启）
goto :fail_end

:init_backend
echo [初始化] 首次运行：创建后端虚拟环境并安装依赖，约 1~2 分钟...
pushd "%BACKEND%"
python -m venv .venv
if errorlevel 1 goto :fail_py
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto :fail_pip
popd
echo [初始化] 后端依赖就绪。
echo.
exit /b 0

:init_frontend
echo [初始化] 首次运行：安装前端依赖（npm install），可能需要几分钟...
pushd "%FRONTEND%"
call npm install --legacy-peer-deps
if errorlevel 1 goto :fail_npm
popd
echo [初始化] 前端依赖就绪。
echo.
exit /b 0

rem %1 = 端口，%2 = 输出变量名（占用时写入占用进程 PID，否则清空）
:check_port
set "%~2="
for /f "tokens=5" %%a in ('%SystemRoot%\System32\netstat.exe -ano ^| %SystemRoot%\System32\findstr.exe /r /c:"TCP .*:%~1 .*LISTENING"') do if not defined %~2 set "%~2=%%a"
exit /b 0

:stop_services
echo [停止] 停止端口 %BACKEND_PORT% / %FRONTEND_PORT% 上的服务...
%PS% -File "%TOOL%" -Action stop -BackendPort %BACKEND_PORT% -FrontendPort %FRONTEND_PORT%
echo         上面每行的含义：STOPPING / KILLING = 正在结束进程；
echo         STOPPED = 已停止并关掉对应窗口；NOTRUNNING = 该端口本来没在跑；
echo         FAILED = 停止失败，端口仍被占用。
echo.
exit /b 0

:stop
echo ================================================
echo   StudyMate Web 停止服务
echo ================================================
echo.
call :stop_services
echo [完成] 处理完毕。
%SystemRoot%\System32\ping.exe -n 4 127.0.0.1 >nul
exit /b 0

:usage
echo StudyMate Web 启动器用法：
echo    start-web.bat          启动（前端源码比构建新时自动重新构建）
echo    start-web.bat dev      强制开发模式（热编译，跳过构建）
echo    start-web.bat restart  先停掉残留服务再启动
echo    start-web.bat stop     停止服务（连服务窗口一起收掉）
echo    start-web.bat help     显示本帮助
echo.
echo 端口可用环境变量覆盖：SM_WEB_BACKEND_PORT / SM_WEB_FRONTEND_PORT
echo 一键停止也可以直接双击：stop-web.bat
echo.
%SystemRoot%\System32\ping.exe -n 4 127.0.0.1 >nul
exit /b 0

:fail_py
echo [错误] 创建 Python 虚拟环境失败：请确认已安装 Python 3.10+ 并加入 PATH。
goto :fail_end

:fail_pip
echo [错误] 后端依赖安装失败：请检查网络后重新运行。
goto :fail_end

:fail_npm
echo [错误] 前端依赖安装失败：请确认已安装 Node.js 20.9+ 并检查网络。
goto :fail_end

:fail_build
echo [错误] 前端构建失败：请查看上面的报错（常见原因是源码里有类型错误）。
echo        修好后重跑本脚本，或用 start-web.bat dev 进开发模式排查。
goto :fail_end

:fail_end
echo.
pause
exit /b 1
