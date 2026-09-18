@echo off
title BFC24 - List printers and paper sizes
cd /d "%~dp0"
echo ==========================================
echo   Printers and their paper sizes, as seen
echo   by the print engine (not by Windows UI)
echo ==========================================
echo.
node -e "require('pdf-to-printer').getPrinters().then(p=>console.log(JSON.stringify(p,null,2))).catch(e=>console.error(e))"
echo.
pause
