Write-Host "=== Printers ==="
Get-CimInstance Win32_Printer | Select-Object Name, Default, PrinterState | Format-Table -AutoSize

Write-Host ""
Write-Host "=== Printer configuration (Win32_PrinterConfiguration) ==="
Write-Host "(PaperWidth/PaperLength are in tenths of a millimeter; Orientation: 1=Portrait, 2=Landscape)"
Get-CimInstance Win32_PrinterConfiguration | Format-List Name, PaperSize, PaperWidth, PaperLength, Orientation, Copies

Write-Host ""
Write-Host "=== Registered forms on this print server (Get-PrinterForm) ==="
try {
  Get-PrinterForm -ErrorAction Stop | Format-Table Name, Width, Height -AutoSize
} catch {
  Write-Host "Get-PrinterForm failed: $_"
}

Write-Host ""
Write-Host "=== Printer driver / port info (Get-Printer) ==="
try {
  Get-Printer -ErrorAction Stop | Format-List Name, DriverName, PortName
} catch {
  Write-Host "Get-Printer failed: $_"
}
