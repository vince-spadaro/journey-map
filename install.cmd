@echo off
rem Installs (or updates) journey-map on Windows so the journey-map command
rem works in any Command Prompt. Double-click this file, or run install.cmd.
rem On Windows, npm installs command-line tools in your own AppData folder,
rem so no admin rights are needed.

setlocal
cd /d "%~dp0"
echo.
echo   Installing journey-map
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   x Node.js isn't installed. Install the LTS version from https://nodejs.org, then run this again.
  goto :end
)
node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 18 || (a === 18 && b >= 3) ? 0 : 1)"
if errorlevel 1 (
  echo   x Your Node.js is too old. Install the LTS version from https://nodejs.org, then run this again.
  goto :end
)
echo   - Node.js found

where git >nul 2>&1
if not errorlevel 1 if exist .git (
  set GIT_TERMINAL_PROMPT=0
  git pull --ff-only --quiet >nul 2>&1 && echo   - Latest version from GitHub
)

call npm install --no-fund --no-audit --loglevel=error >nul
if errorlevel 1 (
  echo   x npm install didn't work. On a work network you may need your organisation's npm registry or proxy settings: ask IT or a developer on your team.
  goto :end
)
echo   - Packages installed

call npm link --no-fund --no-audit --loglevel=error >nul
if errorlevel 1 (
  echo   x npm link didn't work. Copy the message above and send it to the person who shared journey-map.
  goto :end
)
echo   - journey-map command created

echo.
echo   Done. Open a new Command Prompt and map a journey:
echo     journey-map ^<journey folder in your prototype^>
echo.
echo   To update later, run this installer again.

:end
echo.
pause
