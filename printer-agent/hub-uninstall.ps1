<#
Удаляет ВСЕ службы, установленные hub-install.ps1 (имена начинаются с
BFC24PrinterAgent_), и папку instances\ вместе с ними. Используйте перед
переустановкой хаба с нуля или при выводе компьютера из эксплуатации.
Запускать от имени администратора.
#>

$ErrorActionPreference = "Stop"
$SourceDir = $PSScriptRoot
$NssmPath = Join-Path $SourceDir "nssm.exe"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Запустите PowerShell от имени администратора." -ForegroundColor Red
  Read-Host "Нажмите Enter для выхода"
  exit 1
}

$services = Get-CimInstance Win32_Service | Where-Object { $_.Name -like "BFC24PrinterAgent_*" }
if (-not $services) {
  Write-Host "Служб BFC24PrinterAgent_* не найдено — нечего удалять."
} else {
  foreach ($svc in $services) {
    Write-Host "Удаляю службу $($svc.Name)..."
    if (Test-Path $NssmPath) {
      & $NssmPath stop $svc.Name 2>$null | Out-Null
      & $NssmPath remove $svc.Name confirm 2>$null | Out-Null
    } else {
      & sc.exe stop $svc.Name | Out-Null
      & sc.exe delete $svc.Name | Out-Null
    }
  }
}

$InstancesDir = Join-Path $SourceDir "instances"
if (Test-Path $InstancesDir) {
  Write-Host "Удаляю папку instances\..."
  Remove-Item -Path $InstancesDir -Recurse -Force
}

Write-Host "Готово."
Read-Host "Нажмите Enter для выхода"
