# Starts the kcapp stack: database -> API -> site, then opens the browser.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$DbPort = 3307

if (-not (Test-Path "config\api.yaml")) {
    Write-Host "Setup has not been run yet - run SetupKcapp.exe first."
    exit 1
}

function PortOpen($port) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $c.Connect("127.0.0.1", $port); $c.Close()
        return $true
    } catch { return $false }
}
function WaitPort($port, $seconds) {
    foreach ($i in 1..$seconds) {
        if (PortOpen $port) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

New-Item -ItemType Directory -Force -Path run | Out-Null

# --- database ---
if (-not (PortOpen $DbPort)) {
    Write-Host ">> starting database"
    $p = Start-Process -FilePath "runtime\mariadb\bin\mysqld.exe" `
        -ArgumentList "--datadir=$root\data\db", "--port=$DbPort", "--console" `
        -WindowStyle Hidden -PassThru
    $p.Id | Set-Content "run\db.pid"
    if (-not (WaitPort $DbPort 60)) { throw "database did not start" }
} else {
    Write-Host ">> database already running"
}

# --- API ---
if (-not (PortOpen 8001)) {
    Write-Host ">> starting kcapp API"
    $p = Start-Process -FilePath "bin\kcapp-api.exe" -ArgumentList "serve", "-c", "config\api.yaml" `
        -WindowStyle Hidden -PassThru
    $p.Id | Set-Content "run\api.pid"
    if (-not (WaitPort 8001 30)) { throw "API did not start" }
} else {
    Write-Host ">> API already running"
}

# --- site ---
if (-not (PortOpen 3000)) {
    Write-Host ">> starting kcapp site"
    $env:NODE_ENV = "production"
    $env:KCAPP_API = "http://localhost:8001"
    $env:PORT = "3000"
    $p = Start-Process -FilePath "$root\runtime\node\node.exe" -ArgumentList ".\bin\www" `
        -WorkingDirectory "$root\app\frontend" -WindowStyle Hidden -PassThru
    $p.Id | Set-Content "run\frontend.pid"
    if (-not (WaitPort 3000 45)) { throw "site did not start" }
} else {
    Write-Host ">> site already running"
}

Write-Host ""
Write-Host "=== kcapp is running ==="
Write-Host "Site:  http://localhost:3000   (also from other devices: http://<this-pc-ip>:3000)"
Write-Host "Stop it with StopKcapp.exe. Run DartboardBridge.exe for the board."
Start-Process "http://localhost:3000"
