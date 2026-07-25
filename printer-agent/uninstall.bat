@echo off
chcp 65001 >nul
title BFC24 - Удаление агента печати из автозапуска
echo Убираю агент печати из автозапуска Windows...

set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if exist "%STARTUP_DIR%\BFC24PrinterAgent.vbs" del "%STARTUP_DIR%\BFC24PrinterAgent.vbs"

echo Готово. Автозапуск отключён.
echo Если агент сейчас работает в фоне - закройте процесс node.exe через
echo Диспетчер задач, либо просто перезагрузите компьютер.
pause
