@echo off
title BFC24 - Windows printer diagnostics
cd /d "%~dp0"

echo ==========================================
echo   Windows printer diagnostics (PowerShell)
echo   Shows real driver paper size/orientation,
echo   independent of SumatraPDF version.
echo ==========================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diag.ps1"

echo.
echo ==========================================
echo   Copy ALL the text above and send it back.
echo ==========================================
echo.
pause
