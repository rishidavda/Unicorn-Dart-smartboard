# Health report for the kcapp stack. Run CheckKcapp.exe and paste the output
# when asking for help — it pinpoints which piece is broken.
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$DbPort = 3307

function PortOpen($port) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $c.Connect("127.0.0.1", $port); $c.Close()
        return $true
    } catch { return $false }
}
function Check($label, $ok, $hint) {
    if ($ok) { Write-Host ("  [ OK ] " + $label) }
    else     { Write-Host ("  [FAIL] " + $label + "  -> " + $hint) }
}
function TailLog($file, $lines) {
    if (Test-Path $file) {
        Write-Host ""
        Write-Host ("---- last $lines lines of $file ----")
        Get-Content $file -Tail $lines | ForEach-Object { Write-Host ("  " + $_) }
    }
}

Write-Host "=== kcapp health report ==="
Write-Host ("folder: " + $root)
if ($root -match 'OneDrive') {
    Write-Host "  [WARN] folder is inside OneDrive - move to e.g. C:\Kcapp (sync corrupts the database)"
}

Write-Host ""
Write-Host "-- setup completeness --"
Check "Node runtime"        (Test-Path "runtime\node\node.exe")      "re-run SetupKcapp.exe"
Check "MariaDB"             (Test-Path "runtime\mariadb\bin\mysqld.exe") "re-run SetupKcapp.exe"
Check "kcapp site source"   (Test-Path "app\frontend\bin\www")       "re-run SetupKcapp.exe"
Check "site dependencies"   (Test-Path "app\frontend\node_modules")  "re-run SetupKcapp.exe"
Check "database schema src" (Test-Path "app\database\migrations")    "re-run SetupKcapp.exe"
Check "database files"      (Test-Path "data\db\mysql")              "re-run SetupKcapp.exe"
Check "API configuration"   (Test-Path "config\api.yaml")            "re-run SetupKcapp.exe (it must end with 'Setup complete')"

Write-Host ""
Write-Host "-- running services --"
$dbUp    = PortOpen $DbPort
$apiUp   = PortOpen 8001
$siteUp  = PortOpen 3000
Check "database  (port $DbPort)" $dbUp   "run StartKcapp.exe; if it fails, see db log below"
Check "kcapp API (port 8001)"    $apiUp  "run StartKcapp.exe; if it fails, see api log below"
Check "site      (port 3000)"    $siteUp "run StartKcapp.exe; if it fails, see frontend log below"

if ($apiUp) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:8001/venue" -UseBasicParsing -TimeoutSec 5
        Check "API answers HTTP" ($r.StatusCode -eq 200) "see api log below"
    } catch { Check "API answers HTTP" $false "see api log below" }
}
if ($siteUp) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000/" -UseBasicParsing -TimeoutSec 10
        Check "site answers HTTP" ($r.StatusCode -eq 200) "see frontend log below"
    } catch { Check "site answers HTTP" $false "see frontend log below" }
}

TailLog "run\db.err" 25
TailLog "run\api.err" 25
TailLog "run\api.log" 15
TailLog "run\frontend.err" 25
TailLog "run\frontend.log" 15

Write-Host ""
Write-Host "=== end of report - copy EVERYTHING above when asking for help ==="
