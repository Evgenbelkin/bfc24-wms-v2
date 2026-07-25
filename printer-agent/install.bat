@echo off
chcp 65001 >nul
title BFC24 - Установка агента печати
echo ==========================================
echo   BFC24 WMS - Установка агента печати
echo ==========================================
echo.

rem --- 1. Проверяем Node.js ---
where node >nul 2>nul
if errorlevel 1 goto NO_NODE
echo Node.js найден:
node --version
echo.
goto CHECK_ENV

:NO_NODE
echo Node.js не найден на этом компьютере.
echo Сейчас откроется страница загрузки - установите Node.js (кнопка LTS),
echo после установки запустите install.bat ещё раз.
start https://nodejs.org/
pause
exit /b 1

rem --- 2. Ключ агента ---
:CHECK_ENV
if exist ".env" goto ASK_REPLACE
goto ASK_KEY

:ASK_REPLACE
set /p REPLACE_KEY="Файл настроек .env уже есть. Заменить ключ агента на новый? (y/N): "
if /i "%REPLACE_KEY%"=="y" goto ASK_KEY
goto INSTALL_DEPS

:ASK_KEY
echo.
echo Вставьте ключ агента - его выдаёт панель принтеров в WMS,
echo кнопка "Выпустить ключ агента" в карточке нужного принтера.
echo (если консоль не даёт вставить через Ctrl+V - кликните правой кнопкой мыши по окну)
set /p AGENT_KEY="Ключ (начинается с pk_): "
if "%AGENT_KEY%"=="" (
  echo Ключ не введён, установка прервана.
  pause
  exit /b 1
)
> ".env" (
  echo API_BASE_URL=https://dev.bfc-24.ru/api/v2
  echo AGENT_KEY=%AGENT_KEY%
)
echo Файл .env сохранён.

:INSTALL_DEPS
echo.
echo Устанавливаю зависимости (может занять пару минут)...
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo.
  echo ОШИБКА при установке зависимостей. Проверьте интернет-соединение и запустите install.bat снова.
  pause
  exit /b 1
)

echo.
echo Добавляю агент в автозапуск Windows...
set "AGENT_DIR=%~dp0"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

> "%STARTUP_DIR%\BFC24PrinterAgent.vbs" (
  echo Set WshShell = CreateObject^("WScript.Shell"^)
  echo WshShell.Run "wscript.exe //B ""%AGENT_DIR%run-hidden.vbs""", 0, False
)
echo Готово - агент будет запускаться сам при каждом включении компьютера.

echo.
echo Запускаю агент прямо сейчас...
start "" wscript.exe "%AGENT_DIR%run-hidden.vbs"

echo.
echo ==========================================
echo   Установка завершена.
echo   Откройте панель принтеров в WMS и проверьте,
echo   что у этого принтера статус сменился на "агент на связи".
echo   Если что-то пошло не так - смотрите файл agent.log в этой папке.
echo ==========================================
pause
