@echo off
title BFC24 Printer Agent - Debug
cd /d "%~dp0"
echo ==========================================
echo   Printer agent debug mode
echo   Errors show up right here on screen (the normal
echo   background run shows nothing).
echo   Closing this window any time is safe - it does not
echo   affect autostart or printing.
echo ==========================================
echo.
npm start
echo.
echo Agent stopped.
pause
