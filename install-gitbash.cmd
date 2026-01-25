@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM Best-effort launcher that prefers Git Bash (mintty) and runs install.cmd inside WSL.
REM If Git Bash is not found, falls back to running install.cmd in this console.

set "GIT_BASH_EXE="
for %%G in ("%ProgramFiles%\Git\git-bash.exe" "%ProgramFiles(x86)%\Git\git-bash.exe" "%LocalAppData%\Programs\Git\git-bash.exe") do (
  if exist "%%~G" set "GIT_BASH_EXE=%%~G"
)

if "%GIT_BASH_EXE%"=="" (
  echo [workbench-install] Git Bash not found. Falling back to install.cmd...
  call "%~dp0install.cmd"
  exit /b %ERRORLEVEL%
)

set "REPO_DIR=%~dp0"
if "%REPO_DIR:~-1%"=="\" set "REPO_DIR=%REPO_DIR:~0,-1%"

REM git-bash.exe launches an interactive bash; we use it for a bash-like window.
REM Use cmd.exe to invoke install.cmd (which runs WSL install+verify and waits for Enter).
start "" "%GIT_BASH_EXE%" -lc "/c/Windows/System32/cmd.exe //c \"\\\"%REPO_DIR%\\install.cmd\\\"\""

endlocal
