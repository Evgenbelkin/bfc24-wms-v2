<#
BFC24 WMS v2 — массовая установка агентов печати на одном компьютере (хабе)
============================================================================
Для случая, когда к одному компьютеру подключено сразу несколько принтеров
(через Ethernet-хаб или напрямую), и на каждый нужен свой отдельный процесс
агента — агент всегда = 1 процесс = 1 AGENT_KEY = 1 принтер в WMS, отдельные
принтеры одним процессом не обслуживаются.

Что делает скрипт:
  1. Один раз ставит npm-зависимости в этой папке (используется как шаблон
     для копирования, сама эта папка агентом не является).
  2. Читает printers.csv (колонки name,agent_key — по строке на принтер).
  3. Для каждой строки создаёт instances\<name>, копирует туда agent.js,
     package.json, node_modules, fonts, bin (если положили SumatraPDF —
     см. ИНСТРУКЦИЯ.txt), пишет свой .env с этим agent_key.
  4. Регистрирует каждую копию как ОТДЕЛЬНУЮ службу Windows через nssm.exe —
     служба сама перезапускается и при падении процесса, и при перезагрузке
     компьютера (в отличие от старого автозапуска через vbs на один агент,
     который не перезапускает процесс, если тот упал посреди дня).

Требования перед запуском:
  - Node.js уже установлен на этом компьютере.
  - nssm.exe лежит в этой же папке (см. HUB-ИНСТРУКЦИЯ.txt — где скачать).
  - Запускать ОТ ИМЕНИ АДМИНИСТРАТОРА: правой кнопкой по PowerShell —
    "Запустить от имени администратора", затем перейти в эту папку и
    выполнить .\hub-install.ps1 (регистрация служб Windows требует прав
    администратора).

Повторный запуск безопасен — существующая служба с тем же именем будет
остановлена, удалена и создана заново (например, если поменяли ключ в csv
или переустанавливаете версию агента).
#>

param(
  [string]$CsvPath = ".\printers.csv",
  [string]$ApiBaseUrl = "https://dev.bfc-24.ru/api/v2"
)

$ErrorActionPreference = "Stop"
$SourceDir = $PSScriptRoot
$InstancesDir = Join-Path $SourceDir "instances"
$NssmPath = Join-Path $SourceDir "nssm.exe"

function Fail($msg) {
  Write-Host ""
  Write-Host "ОШИБКА: $msg" -ForegroundColor Red
  Write-Host ""
  Read-Host "Нажмите Enter для выхода"
  exit 1
}

# --- 0. Права администратора ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Fail "Запустите PowerShell от имени администратора и повторите (нужно для установки служб Windows)."
}

# --- 1. nssm.exe должен лежать рядом со скриптом ---
if (-not (Test-Path $NssmPath)) {
  Fail "Не найден nssm.exe рядом со скриптом. См. HUB-ИНСТРУКЦИЯ.txt — откуда скачать."
}

# --- 2. node должен быть в PATH ---
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "Node.js не найден. Установите Node.js (nodejs.org, кнопка LTS) и повторите."
}
$NodePath = $node.Source

# --- 3. csv со списком принтеров ---
if (-not (Test-Path $CsvPath)) {
  Fail "Не найден файл $CsvPath. Создайте printers.csv по образцу printers.example.csv (колонки: name,agent_key)."
}
$rows = Import-Csv -Path $CsvPath
if (-not $rows -or $rows.Count -eq 0) {
  Fail "Файл $CsvPath пустой или не распознан. Проверьте, что первая строка — заголовок 'name,agent_key'."
}

# --- 4. npm install один раз в папке-шаблоне ---
if (-not (Test-Path (Join-Path $SourceDir "node_modules"))) {
  Write-Host "Устанавливаю зависимости (один раз, для всех агентов)..."
  Push-Location $SourceDir
  & npm install --no-fund --no-audit
  Pop-Location
  if ($LASTEXITCODE -ne 0) { Fail "npm install завершился с ошибкой." }
}

New-Item -ItemType Directory -Force -Path $InstancesDir | Out-Null

$copyItems = @("agent.js", "package.json", "package-lock.json", "fonts", "bin", "node_modules")

$installed = @()
$errors = @()

foreach ($row in $rows) {
  $name = ($row.name -as [string])
  $key  = ($row.agent_key -as [string])
  if ($name) { $name = $name.Trim() }
  if ($key)  { $key = $key.Trim() }
  if (-not $name -or -not $key) {
    $errors += "Пропущена строка с пустым name или agent_key: $($row | Out-String)"
    continue
  }
  if ($key -notmatch '^pk_\d+_') {
    $errors += "$name`: ключ не похож на agent_key (должен начинаться с pk_<id>_) — пропущен"
    continue
  }

  $safeId = ($name -replace '[^a-zA-Z0-9_\-]', '_')
  $target = Join-Path $InstancesDir $safeId
  $serviceName = "BFC24PrinterAgent_$safeId"

  Write-Host ""
  Write-Host "=== $name ($serviceName) ===" -ForegroundColor Cyan

  & $NssmPath status $serviceName 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  служба уже существует — переустанавливаю"
    & $NssmPath stop $serviceName 2>$null | Out-Null
    & $NssmPath remove $serviceName confirm 2>$null | Out-Null
  }

  New-Item -ItemType Directory -Force -Path $target | Out-Null
  foreach ($item in $copyItems) {
    $src = Join-Path $SourceDir $item
    if (Test-Path $src) {
      Copy-Item -Path $src -Destination $target -Recurse -Force
    }
  }

  @(
    "API_BASE_URL=$ApiBaseUrl"
    "AGENT_KEY=$key"
  ) -join "`r`n" | Set-Content -Path (Join-Path $target ".env") -Encoding ASCII

  & $NssmPath install $serviceName $NodePath "agent.js" | Out-Null
  & $NssmPath set $serviceName AppDirectory $target | Out-Null
  & $NssmPath set $serviceName AppStdout (Join-Path $target "service.log") | Out-Null
  & $NssmPath set $serviceName AppStderr (Join-Path $target "service.log") | Out-Null
  & $NssmPath set $serviceName AppRotateFiles 1 | Out-Null
  & $NssmPath set $serviceName AppRotateBytes 5242880 | Out-Null
  & $NssmPath set $serviceName Start SERVICE_AUTO_START | Out-Null
  & $NssmPath set $serviceName AppExit Default Restart | Out-Null
  & $NssmPath set $serviceName AppRestartDelay 3000 | Out-Null
  & $NssmPath set $serviceName DisplayName "BFC24 Printer Agent - $name" | Out-Null

  & $NssmPath start $serviceName | Out-Null
  Start-Sleep -Milliseconds 500
  $status = & $NssmPath status $serviceName
  Write-Host "  статус службы: $status"
  $installed += "$name -> $serviceName ($status)"
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "Готово. Установлено служб: $($installed.Count)" -ForegroundColor Green
$installed | ForEach-Object { Write-Host "  $_" }
if ($errors.Count -gt 0) {
  Write-Host ""
  Write-Host "Пропущено с ошибками:" -ForegroundColor Yellow
  $errors | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
}
Write-Host ""
Write-Host "Проверьте статус каждого принтера в WMS -> Панель принтеров."
Write-Host "Логи каждого агента: instances\<name>\agent.log и service.log"
Write-Host "Управление службами: Win+R -> services.msc -> искать 'BFC24 Printer Agent'"
Write-Host "==========================================" -ForegroundColor Green
Read-Host "Нажмите Enter для выхода"
