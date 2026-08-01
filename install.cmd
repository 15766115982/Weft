@echo off
REM One-click install: Node dependency + link the three skills into Claude Code.
REM Manual equivalent and troubleshooting: docs\installation.md (sections 3-4).
setlocal EnableExtensions
set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found on PATH. Install Node.js ^>= 20 first: https://nodejs.org
  exit /b 1
)
node -e "if (Number(process.versions.node.split('.')[0]) < 20) { console.error('[ERROR] Node.js >= 20 required, found ' + process.version); process.exit(1) }"
if errorlevel 1 exit /b 1

echo [1/2] Installing retrieval dependency ^(better-sqlite3, prebuilt^)...
pushd "%REPO%\retrieval\scripts"
call npm install
if errorlevel 1 (
  popd
  echo [ERROR] npm install failed - offline intranet? See docs\installation.md section 3.
  exit /b 1
)
popd

echo [2/2] Linking skills into %USERPROFILE%\.claude\skills ...
set "SKILLS=%USERPROFILE%\.claude\skills"
if not exist "%SKILLS%" mkdir "%SKILLS%"
call :link kb-acquire "%REPO%\acquisition\skills\acquire"
call :link kb-govern  "%REPO%\governance\skills\govern"
call :link kb-search  "%REPO%\retrieval\skills\search"

echo.
echo Done. Restart Claude Code, then verify kb-acquire / kb-govern / kb-search appear.
echo Next: docs\installation.md section 5 ^(create a knowledge base^) and 6 ^(PAT / kb.json^).
exit /b 0

:link
if exist "%SKILLS%\%~1" (
  echo   skip %~1 ^(already exists^)
) else (
  mklink /J "%SKILLS%\%~1" "%~2" >nul && echo   linked %~1 || echo [ERROR] failed to link %~1
)
exit /b 0
