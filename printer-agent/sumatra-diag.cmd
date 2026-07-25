@echo off
title BFC24 - Full printer diagnostics (raw SumatraPDF)
cd /d "%~dp0"

set SUMATRA=node_modules\pdf-to-printer\dist\SumatraPDF-3.4.6-32.exe

if not exist "%SUMATRA%" (
  echo ERROR: %SUMATRA% not found.
  echo Run install.bat first, then try this again.
  echo.
  pause
  exit /b 1
)

echo ==========================================
echo   Full printer diagnostics (raw SumatraPDF)
echo   This shows default paper size, orientation
echo   and exact form/paperkind names and IDs -
echo   more detail than list-printers.cmd
echo ==========================================
echo.

"%SUMATRA%" -list-printers

echo.
echo ==========================================
echo   Copy ALL the text above and send it back.
echo ==========================================
echo.
pause
