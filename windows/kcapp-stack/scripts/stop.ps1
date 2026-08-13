# Stops the kcapp stack (site, API, database).
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$DbPort = 3307

foreach ($name in @("frontend", "api")) {
    $pidFile = "run\$name.pid"
    if (Test-Path $pidFile) {
        $procId = Get-Content $pidFile
        Write-Host ">> stopping $name (pid $procId)"
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        Remove-Item $pidFile -Force
    }
}

$admin = "runtime\mariadb\bin\mariadb-admin.exe"
if (-not (Test-Path $admin)) { $admin = "runtime\mariadb\bin\mysqladmin.exe" }
Write-Host ">> stopping database"
& $admin -uroot -h 127.0.0.1 -P $DbPort shutdown 2>$null
Remove-Item "run\db.pid" -Force -ErrorAction SilentlyContinue

Write-Host "=== kcapp stopped ==="
