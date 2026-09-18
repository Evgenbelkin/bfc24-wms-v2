@echo off
title BFC24 Printer Agent - Setup
echo ==========================================
echo   BFC24 WMS - Printer Agent Setup
echo ==========================================
echo.
echo (See the instructions text file in this folder for full details)
echo.

rem --- 0. Unblock all files in this folder (downloaded-from-internet flag).
rem     Without this, Windows shows a security warning not just now, but on
rem     every reboot when the agent tries to autostart in the background.
powershell -NoProfile -Command "Get-ChildItem -Path '%~dp0' -Recurse | Unblock-File" >nul 2>nul

rem --- 1. Check Node.js ---
where node >nul 2>nul
if errorlevel 1 goto NO_NODE
echo Node.js found:
node --version
echo.
goto CHECK_ENV

:NO_NODE
echo Node.js was not found on this computer.
echo A download page will open now - install Node.js (the LTS button),
echo then run install.bat again.
start https://nodejs.org/
pause
exit /b 1

rem --- 2. Agent key ---
:CHECK_ENV
if exist ".env" goto ASK_REPLACE
goto ASK_KEY

:ASK_REPLACE
set /p REPLACE_KEY="A .env file already exists. Replace the agent key with a new one? (y/N): "
if /i "%REPLACE_KEY%"=="y" goto ASK_KEY
goto INSTALL_DEPS

:ASK_KEY
echo.
echo Paste the agent key - it is shown in the WMS printer panel,
echo button "Vypustit klyuch agenta" on the printer's card.
echo (if Ctrl+V does not work in this console - right-click the window instead)
set /p AGENT_KEY="Key (starts with pk_): "
if "%AGENT_KEY%"=="" (
  echo No key entered, setup cancelled.
  pause
  exit /b 1
)
> ".env" (
  echo API_BASE_URL=https://dev.bfc-24.ru/api/v2
  echo AGENT_KEY=%AGENT_KEY%
)
echo .env file saved.

:INSTALL_DEPS
echo.
echo Installing dependencies (this can take a minute or two)...
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo.
  echo ERROR installing dependencies. Check your internet connection and run install.bat again.
  pause
  exit /b 1
)

echo.
echo Adding the agent to Windows startup...
set "AGENT_DIR=%~dp0"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

> "%STARTUP_DIR%\BFC24PrinterAgent.vbs" (
  echo Set WshShell = CreateObject^("WScript.Shell"^)
  echo WshShell.Run "wscript.exe //B ""%AGENT_DIR%run-hidden.vbs""", 0, False
)
echo Done - the agent will start itself every time this computer turns on.

echo.
echo Starting the agent now...
start "" wscript.exe "%AGENT_DIR%run-hidden.vbs"

echo.
echo ==========================================
echo   Setup complete.
echo   Open the printer panel in WMS and check that
echo   this printer's status changed to "agent online".
echo   If something is wrong - check agent.log in this folder,
echo   or run debug-run.cmd to see live errors.
echo ==========================================
pause
