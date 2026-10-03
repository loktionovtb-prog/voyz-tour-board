@echo off
setlocal
cd /d "%~dp0"
set "VOYZ_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  set "VOYZ_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if not exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    start "" "%~dp0dist\index.html"
    exit /b
  )
)
"%VOYZ_NODE%" server.cjs --open
pause

