@echo off
title BFC24 Printer Agent - Remove from startup
echo Removing printer agent from Windows startup...

set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if exist "%STARTUP_DIR%\BFC24PrinterAgent.vbs" del "%STARTUP_DIR%\BFC24PrinterAgent.vbs"

echo Done. Autostart disabled.
echo If the agent is currently running in the background - close it via
echo Task Manager (look for node.exe), or just restart the computer.
pause
