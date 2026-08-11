# Starts the kcapp stack: database -> API -> site, then opens the browser.
# Each service logs to run\<name>.log / run\<name>.err — on failure the
# relevant log is printed automatically.
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
function TailLog($file) {
    if (Test-Path $file) {
        Write-Host ("---- $file ----")
        Get-Content $file -Tail 25 | ForEach-Object { Write-Host ("  " + $_) }
    }
}
function FailWith($what, $logBase) {
    TailLog "run\$logBase.err"
    TailLog "run\$logBase.log"
    throw "$what - logs above (also run CheckKcapp.exe for a full report)"
}

New-Item -ItemType Directory -Force -Path run | Out-Null

# --- database ---
if (-not (PortOpen $DbPort)) {
    Write-Host ">> starting database"
    $p = Start-Process -FilePath "runtime\mariadb\bin\mysqld.exe" `
        -ArgumentList "--datadir=$root\data\db", "--port=$DbPort", "--console" `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput "run\db.log" -RedirectStandardError "run\db.err"
    $p.Id | Set-Content "run\db.pid"
    if (-not (WaitPort $DbPort 60)) { FailWith "database did not start" "db" }
} else {
    Write-Host ">> database already running"
}

# --- API ---
if (-not (PortOpen 8001)) {
    Write-Host ">> starting kcapp API"
    $p = Start-Process -FilePath "bin\kcapp-api.exe" -ArgumentList "serve", "-c", "config\api.yaml" `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput "run\api.log" -RedirectStandardError "run\api.err"
    $p.Id | Set-Content "run\api.pid"
    if (-not (WaitPort 8001 30)) { FailWith "API did not start" "api" }
} else {
    Write-Host ">> API already running"
}

# --- site ---
if (-not (PortOpen 3000)) {
    Write-Host ">> starting kcapp site (first start compiles pages - can take 1-2 minutes)"
    $env:NODE_ENV = "production"
    $env:KCAPP_API = "http://localhost:8001"
    $env:PORT = "3000"
    $env:DEBUG = "kcapp:*"
    $p = Start-Process -FilePath "$root\runtime\node\node.exe" -ArgumentList ".\bin\www" `
        -WorkingDirectory "$root\app\frontend" -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput "$root\run\frontend.log" -RedirectStandardError "$root\run\frontend.err"
    $p.Id | Set-Content "run\frontend.pid"
    if (-not (WaitPort 3000 150)) {
        if ($p.HasExited) { Write-Host ">> the site process crashed:" }
        FailWith "site did not start" "frontend"
    }
} else {
    Write-Host ">> site already running"
}

Write-Host ""
Write-Host "=== kcapp is running ==="
Write-Host "Site:  http://localhost:3000   (from other devices: http://<this-pc-ip>:3000)"
Write-Host "Stop with StopKcapp.exe. Run DartboardBridge.exe for the board."
Start-Process "http://localhost:3000"
