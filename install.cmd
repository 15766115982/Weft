@echo off
REM One-click install: retrieval Node dependency + agent/ Python environment.
REM (ADR-0012: the three Claude Code skills were retired with the claude CLI
REM dependency; services are driven by the UI portal or directly via CLI.)
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

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found on PATH. Install Python ^>= 3.11 first.
  exit /b 1
)

echo [1/2] Installing retrieval dependency ^(better-sqlite3, prebuilt^)...
pushd "%REPO%\retrieval\scripts"
call npm install
if errorlevel 1 (
  popd
  echo [ERROR] npm install failed - offline intranet? See docs\installation.md section 3.
  exit /b 1
)
popd

echo [2/2] Setting up the agent service Python environment ^(agent\.venv^)...
python -m venv "%REPO%\agent\.venv"
if errorlevel 1 (
  echo [ERROR] python -m venv failed.
  exit /b 1
)
call "%REPO%\agent\.venv\Scripts\python.exe" -m pip install -e "%REPO%\agent"
if errorlevel 1 (
  echo [ERROR] pip install failed - offline intranet? See docs\installation.md section 3.
  exit /b 1
)

echo.
echo Done. Next: docs\installation.md section 5 ^(create a knowledge base^) and 6 ^(models.json / PAT^).
echo Launch the portal: node ui\serve.mjs --kb ^<kb-root^>
exit /b 0
