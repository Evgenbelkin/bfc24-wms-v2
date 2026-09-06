<#
BFC24 WMS v2 — обёртка над hub-install.ps1 "в одно действие"
================================================================
Обычный hub-install.ps1 (см. HUB-ИНСТРУКЦИЯ.txt) требует ДО запуска вручную:
  - скачать и положить рядом nssm.exe,
  - скачать и положить в bin\ SumatraPDF.exe (причём важно, чтобы файл
    назывался ИМЕННО SumatraPDF.exe, а не так, как он называется в архиве
    после распаковки — это реальная причина одного из расследований кривой
    печати, см. README-print-fix.md),
  - вручную создать printers.csv руками в блокноте.

Этот скрипт делает все три вещи сам (качает nssm и Sumatra, если их нет,
сам чинит имя файла Sumatra, спрашивает принтеры в диалоге вместо ручного
редактирования csv) и в конце сам вызывает hub-install.ps1. От пользователя
нужно только: получить agent_key каждого принтера в WMS (Панель принтеров ->
"Выпустить ключ агента") — это единственный шаг, который нельзя убрать,
потому что ключ показывается один раз и должен браться из WMS руками, по
соображениям безопасности.

Запуск (обычный, НЕ обязательно от администратора — скрипт сам попросит
права, если понадобится):

    cd путь\до\printer-agent
    Set-ExecutionPolicy -Scope Process Bypass -Force
    .\setup-hub.ps1
#>

param(
  [string]$ApiBaseUrl = "https://dev.bfc-24.ru/api/v2"
)

$ErrorActionPreference = "Stop"

# На части компьютеров (особенно старые Windows 10/сборки с "родным"
# PowerShell 5.1) .NET по умолчанию пытается качать по TLS 1.0/1.1, а
# nssm.cc и sumatrapdfreader.org давно принимают только TLS 1.2 — без этой
# строчки Invoke-WebRequest ниже падает с "Не удалось создать защищённый
# канал SSL/TLS" (реальная причина жалобы "не скачивается nssm" 06.09.2026).
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
  # Очень старый .NET без поддержки Tls12 в enum — не критично, просто
  # оставляем системные настройки как есть и даём загрузке шанс сработать.
}

$SourceDir = $PSScriptRoot
$NssmPath = Join-Path $SourceDir "nssm.exe"
$BinDir = Join-Path $SourceDir "bin"
$SumatraPath = Join-Path $BinDir "SumatraPDF.exe"
$CsvPath = Join-Path $SourceDir "printers.csv"

function Info($msg)  { Write-Host $msg -ForegroundColor Cyan }
function Ok($msg)    { Write-Host $msg -ForegroundColor Green }
function Warn($msg)  { Write-Host $msg -ForegroundColor Yellow }
function Fail($msg) {
  Write-Host ""
  Write-Host "ОШИБКА: $msg" -ForegroundColor Red
  Write-Host ""
  Read-Host "Нажмите Enter для выхода"
  exit 1
}

# --- 0. Если не админ — перезапускаемся с правами администратора сами,
#        чтобы пользователю не нужно было вручную искать "Запуск от имени
#        администратора" в меню Пуск. ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Warn "Нужны права администратора (для служб Windows) — перезапускаю с повышением прав..."
  $psi = @{
    FilePath     = "powershell.exe"
    ArgumentList = @("-NoExit", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    Verb         = "RunAs"
  }
  Start-Process @psi
  exit 0
}

Info "=== 1/5: уборка старого одиночного агента (если он тут был) ==="
# Раньше на этом компьютере (если тут уже стоял один агент через install.bat)
# автозапуск делался через .vbs-ярлык в папке автозагрузки Windows, который
# каждый раз при включении компьютера запускал node agent.js в фоне БЕЗ
# службы (если процесс упадёт посреди дня — сам не перезапустится). Теперь
# каждый принтер обслуживается службой Windows (шаг 4/5 ниже) — старый
# способ автозапуска для ЭТОЙ ЖЕ папки больше не нужен и будет мешать
# (иначе после перезагрузки поднимутся ДВА процесса на один и тот же
# принтер — старый вручную и новый как служба). Убираем автоматически, а
# не полагаемся на то, что это сделают руками.
$StartupVbs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\BFC24PrinterAgent.vbs"
if (Test-Path $StartupVbs) {
  Remove-Item $StartupVbs -Force
  Ok "  убрал старый автозапуск (папка автозагрузки Windows)."
} else {
  Ok "  старого автозапуска не найдено, нечего убирать."
}
# Гасим уже запущенный процесс старого одиночного агента именно ИЗ ЭТОЙ
# папки (если он сейчас работает в фоне) — ищем по командной строке node.exe,
# а не убиваем все node.exe подряд, чтобы не задеть что-то постороннее.
try {
  $oldProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$SourceDir*agent.js*" }
  foreach ($p in $oldProcs) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    Ok "  остановил старый процесс агента (PID $($p.ProcessId))."
  }
  if (-not $oldProcs) { Ok "  старый процесс агента не запущен, нечего останавливать." }
} catch {
  Warn "  не удалось проверить запущенные процессы node.exe — если старый агент запущен, остановите его в Диспетчере задач вручную."
}

Info "=== 2/5: nssm.exe (служба Windows для каждого агента) ==="
if (Test-Path $NssmPath) {
  Ok "  уже на месте."
} else {
  Info "  не найден, скачиваю..."
  try {
    $nssmZip = Join-Path $env:TEMP "nssm.zip"
    $nssmExtract = Join-Path $env:TEMP "nssm-extract"
    Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $nssmZip
    if (Test-Path $nssmExtract) { Remove-Item $nssmExtract -Recurse -Force }
    Expand-Archive -Path $nssmZip -DestinationPath $nssmExtract -Force
    $found = Get-ChildItem -Path $nssmExtract -Recurse -Filter "nssm.exe" |
      Where-Object { $_.FullName -match '\\win64\\' } | Select-Object -First 1
    if (-not $found) { $found = Get-ChildItem -Path $nssmExtract -Recurse -Filter "nssm.exe" | Select-Object -First 1 }
    if (-not $found) { Fail "Не удалось найти nssm.exe внутри скачанного архива." }
    Copy-Item $found.FullName $NssmPath -Force
    Ok "  скачан и положен рядом со скриптом."
  } catch {
    # Автоматическая закачка не всегда доходит (сайт недоступен именно
    # сейчас, антивирус/фаервол блокирует, нет интернета на этом ПК и т.п.) —
    # вместо невнятной ошибки PowerShell даём точный ручной путь, которым
    # пользовался человек и раньше, до появления этого скрипта.
    Warn "  автоматическая закачка не удалась: $($_.Exception.Message)"
    Fail "Не получилось скачать nssm.exe автоматически.`n`nСкачайте вручную: https://nssm.cc/download (файл nssm-2.24.zip)`nРаспакуйте, найдите nssm.exe в папке win64 (или win32, если система 32-битная)`nи положите его сюда: $NssmPath`n`nПосле этого запустите .\setup-hub.ps1 ещё раз - он увидит файл на месте и пойдёт дальше сам."
  }
}

Info "=== 3/5: SumatraPDF.exe (нужен для ровной печати термоэтикеток) ==="
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
if (Test-Path $SumatraPath) {
  Ok "  уже на месте, под правильным именем."
} else {
  # Частый случай: файл скачали раньше, но он лежит под именем из архива
  # (например SumatraPDF-3.6.1-32.exe), а агент ищет файл строго с именем
  # SumatraPDF.exe — молча откатывается на старую логику печати без
  # disable-auto-rotation, и стикеры печатаются криво (см. README-print-fix.md).
  # Чиним это автоматически, а не полагаемся на то, что имя переименуют руками.
  $misnamed = Get-ChildItem -Path $BinDir -Filter "SumatraPDF*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($misnamed) {
    Warn "  найден $($misnamed.Name) — переименовываю в SumatraPDF.exe"
    Rename-Item -Path $misnamed.FullName -NewName "SumatraPDF.exe"
  } else {
    Info "  не найден, скачиваю SumatraPDF 3.6.1..."
    try {
      $sumZip = Join-Path $env:TEMP "sumatra.zip"
      $sumExtract = Join-Path $env:TEMP "sumatra-extract"
      Invoke-WebRequest -Uri "https://www.sumatrapdfreader.org/dl/rel/3.6.1/SumatraPDF-3.6.1.zip" -OutFile $sumZip
      if (Test-Path $sumExtract) { Remove-Item $sumExtract -Recurse -Force }
      Expand-Archive -Path $sumZip -DestinationPath $sumExtract -Force
      $exe = Get-ChildItem -Path $sumExtract -Recurse -Filter "*-32.exe" | Select-Object -First 1
      if (-not $exe) { $exe = Get-ChildItem -Path $sumExtract -Recurse -Filter "SumatraPDF*.exe" | Select-Object -First 1 }
      if (-not $exe) { Fail "Не удалось найти SumatraPDF.exe внутри скачанного архива." }
      Copy-Item $exe.FullName $SumatraPath -Force
      Ok "  скачан и положен как bin\SumatraPDF.exe."
    } catch {
      Warn "  автоматическая закачка не удалась: $($_.Exception.Message)"
      Fail "Не получилось скачать SumatraPDF автоматически.`n`nСкачайте вручную: https://www.sumatrapdfreader.org/download-free-pdf-viewer (портативная 32-битная версия)`nПереименуйте скачанный файл ровно в SumatraPDF.exe`nи положите его сюда: $SumatraPath`n`nПосле этого запустите .\setup-hub.ps1 ещё раз - он увидит файл на месте и пойдёт дальше сам."
    }
  }
}

Info "=== 4/5: список принтеров (printers.csv) ==="
if (Test-Path $CsvPath) {
  Ok "  printers.csv уже есть, использую его как есть."
  Info "  (чтобы ввести список заново — удалите или переименуйте printers.csv и запустите скрипт ещё раз)"
} else {
  Write-Host ""
  Write-Host "Сейчас нужно по каждому принтеру: имя (любое, для узнаваемости) и agent_key." -ForegroundColor White
  Write-Host "Ключ берётся в WMS: Панель принтеров -> нужный принтер -> 'Выпустить ключ агента'." -ForegroundColor White
  Write-Host "Когда принтеры закончатся — просто нажмите Enter на пустом имени." -ForegroundColor White
  Write-Host ""
  $rows = @()
  while ($true) {
    $name = Read-Host "Название принтера (Enter чтобы закончить)"
    if (-not $name) { break }
    $key = Read-Host "  agent_key для '$name' (начинается с pk_)"
    if ($key -notmatch '^pk_\d+_') {
      Warn "  это не похоже на agent_key (должен начинаться с pk_<id>_) — строка пропущена"
      continue
    }
    $rows += [pscustomobject]@{ name = $name; agent_key = $key }
  }
  if ($rows.Count -eq 0) { Fail "Не ввели ни одного принтера — нечего устанавливать." }
  $rows | Export-Csv -Path $CsvPath -NoTypeInformation -Encoding UTF8
  Ok "  printers.csv создан ($($rows.Count) принтер(ов))."
}

Info "=== 5/5: установка служб (hub-install.ps1) ==="
& (Join-Path $SourceDir "hub-install.ps1") -CsvPath $CsvPath -ApiBaseUrl $ApiBaseUrl
