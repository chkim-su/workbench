@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM Double-click entrypoint for Windows.
REM Runs the Workbench install inside WSL (default distro: Ubuntu) and keeps the window open.

set "WSL_DISTRO=%WORKBENCH_WSL_DISTRO%"
if "%WSL_DISTRO%"=="" set "WSL_DISTRO=Ubuntu"

set "REPO_DIR=%~dp0"
REM Trim trailing backslash
if "%REPO_DIR:~-1%"=="\" set "REPO_DIR=%REPO_DIR:~0,-1%"

set "WSL_REPO="

REM If launched from Windows Explorer pointing at a WSL UNC path like:
REM   \\wsl.localhost\Ubuntu\home\...\myLLMworkbench
REM or:
REM   \\wsl$\Ubuntu\home\...\myLLMworkbench
REM wslpath will map these under /mnt/c/... which does not exist in WSL. Convert manually.
if "%REPO_DIR:~0,2%"=="\\\\" (
  set "TMP=%REPO_DIR:~2%"
  for /f "tokens=1,2,* delims=\" %%A in ("%TMP%") do (
    set "UNC_HOST=%%A"
    set "UNC_DISTRO=%%B"
    set "UNC_PATH=%%C"
  )
  if /i "%UNC_HOST%"=="wsl.localhost" (
    if not "%UNC_DISTRO%"=="" (
      set "WSL_DISTRO=%UNC_DISTRO%"
      set "WSL_REPO=/%UNC_PATH:\=/%"
    )
  ) else (
    if /i "%UNC_HOST%"=="wsl$" (
      if not "%UNC_DISTRO%"=="" (
        set "WSL_DISTRO=%UNC_DISTRO%"
        set "WSL_REPO=/%UNC_PATH:\=/%"
      )
    )
  )
)

REM Normal Windows path case (C:\..., D:\..., etc.)
if "%WSL_REPO%"=="" (
  for /f "usebackq delims=" %%P in (`wsl.exe -d %WSL_DISTRO% wslpath -u "%REPO_DIR%" 2^>nul`) do set "WSL_REPO=%%P"
)

if "%WSL_REPO%"=="" (
  echo [workbench-install] ERROR: could not resolve WSL path for: %REPO_DIR%
  echo [workbench-install] Hint: set WORKBENCH_WSL_DISTRO to your distro name, e.g.:
  echo   setx WORKBENCH_WSL_DISTRO Ubuntu
  echo [workbench-install] Press Enter to close...
  set /p _=
  exit /b 2
)

echo [workbench-install] Using WSL distro: %WSL_DISTRO%
echo [workbench-install] Repo: %WSL_REPO%
echo.

REM Do everything automatically: install + verify. Keep this window open at the end.
REM We run install with --no-pause so WSL doesn't block; this CMD window handles the final pause.
wsl.exe -d %WSL_DISTRO% --cd "%WSL_REPO%" bash -lc "bash scripts/install.sh --no-pause --verify"

echo.
echo [workbench-install] Done. Press Enter to close...
set /p _=

endlocal
