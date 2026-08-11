# One-time setup for the kcapp test stack on Windows.
# Downloads Node.js + MariaDB + kcapp sources, installs dependencies,
# initialises the database, runs migrations and seeds a test venue.
# Everything lives inside this folder — delete the folder to uninstall.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$NodeVersion  = "20.19.5"
$MariaVersion = "11.4.8"
$DbPort       = 3307   # non-default so an existing MySQL on 3306 is not disturbed

function Download($url, $dest) {
    Write-Host ">> downloading $url"
    $curl = Join-Path $env:SystemRoot "System32\curl.exe"
    if (Test-Path $curl) {
        & $curl -fSL --retry 3 -o $dest $url
        if ($LASTEXITCODE -ne 0) { throw "download failed: $url" }
    } else {
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    }
}

# Try several URLs in order (repos rename branches; mirrors move)
function DownloadFirst($urls, $dest) {
    foreach ($u in $urls) {
        try { Download $u $dest; return } catch { Write-Host "   (that source failed, trying the next)" }
    }
    throw "all download sources failed for $dest"
}

# GitHub source zips extract to <repo>-<branch>; find whatever arrived
function MoveExtracted($pattern, $dest) {
    $dir = Get-ChildItem temp -Directory -Filter $pattern | Select-Object -First 1
    if (-not $dir) { throw "extracted folder matching '$pattern' not found" }
    Move-Item $dir.FullName $dest -Force
}

function DbClient {
    $c = "runtime\mariadb\bin\mariadb.exe"
    if (-not (Test-Path $c)) { $c = "runtime\mariadb\bin\mysql.exe" }
    return $c
}
function DbAdmin {
    $a = "runtime\mariadb\bin\mariadb-admin.exe"
    if (-not (Test-Path $a)) { $a = "runtime\mariadb\bin\mysqladmin.exe" }
    return $a
}
function WaitPort($port, $seconds) {
    foreach ($i in 1..$seconds) {
        Start-Sleep -Seconds 1
        try {
            $c = New-Object Net.Sockets.TcpClient
            $c.Connect("127.0.0.1", $port); $c.Close()
            return $true
        } catch { }
    }
    return $false
}

Write-Host "=== kcapp test stack setup ==="

if ($root -match 'OneDrive') {
    Write-Host ""
    Write-Warning "This folder is inside OneDrive ($root)."
    Write-Warning "OneDrive syncing fights with the live database - matches can corrupt."
    Write-Warning "Strongly recommended: close this, move the folder to e.g. C:\Kcapp, run setup there."
    Write-Host ""
    Read-Host "Press Enter to continue anyway, or close this window to stop"
}

New-Item -ItemType Directory -Force -Path runtime, config, "data\db", run, temp, app | Out-Null

# --- 1. Node.js (runs the kcapp site and the bridge) ---
if (-not (Test-Path "runtime\node\node.exe")) {
    Download "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" "temp\node.zip"
    Expand-Archive "temp\node.zip" -DestinationPath temp -Force
    Move-Item "temp\node-v$NodeVersion-win-x64" "runtime\node" -Force
}
Write-Host ">> Node.js ready"

# --- 2. MariaDB (the database) ---
if (-not (Test-Path "runtime\mariadb")) {
    Download "https://archive.mariadb.org/mariadb-$MariaVersion/winx64-packages/mariadb-$MariaVersion-winx64.zip" "temp\mariadb.zip"
    Write-Host ">> extracting MariaDB (takes a minute)"
    Expand-Archive "temp\mariadb.zip" -DestinationPath temp -Force
    Move-Item "temp\mariadb-$MariaVersion-winx64" "runtime\mariadb" -Force
}
Write-Host ">> MariaDB ready"

# --- 3. kcapp site + database schema sources ---
if (-not (Test-Path "app\frontend")) {
    DownloadFirst @(
        "https://codeload.github.com/kcapp/frontend/zip/refs/heads/main",
        "https://codeload.github.com/kcapp/frontend/zip/refs/heads/master",
        "https://github.com/kcapp/frontend/archive/HEAD.zip"
    ) "temp\frontend.zip"
    Expand-Archive "temp\frontend.zip" -DestinationPath temp -Force
    MoveExtracted "frontend-*" "app\frontend"
}
if (-not (Test-Path "app\database")) {
    DownloadFirst @(
        "https://codeload.github.com/kcapp/database/zip/refs/heads/main",
        "https://codeload.github.com/kcapp/database/zip/refs/heads/master",
        "https://github.com/kcapp/database/archive/HEAD.zip"
    ) "temp\database.zip"
    Expand-Archive "temp\database.zip" -DestinationPath temp -Force
    MoveExtracted "database-*" "app\database"
}
# Venue TV display page (big live dartboard) - always refresh the copy
if (Test-Path "scripts\darts-tv.html") {
    Copy-Item "scripts\darts-tv.html" "app\frontend\public\darts-tv.html" -Force
}
Write-Host ">> kcapp sources ready"

# --- 4. site dependencies ---
if (-not (Test-Path "app\frontend\node_modules")) {
    Write-Host ">> installing site dependencies (1-2 minutes)"
    Push-Location "app\frontend"
    & "$root\runtime\node\npm.cmd" install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm install failed" }
    & "$root\runtime\node\node.exe" "bin\write-version.js"
    Pop-Location
}
Write-Host ">> site dependencies ready"

# --- 5. initialise the database files ---
if (-not (Test-Path "data\db\mysql")) {
    Write-Host ">> initialising database files"
    & "runtime\mariadb\bin\mariadb-install-db.exe" --datadir="$root\data\db"
    if ($LASTEXITCODE -ne 0) { throw "database initialisation failed" }
}

# --- 6. start the database once (permissive mode) to create the schema ---
Write-Host ">> starting database for schema setup"
$dbproc = Start-Process -FilePath "runtime\mariadb\bin\mysqld.exe" `
    -ArgumentList "--datadir=$root\data\db", "--port=$DbPort", "--console", "--skip-grant-tables" `
    -WindowStyle Hidden -PassThru
if (-not (WaitPort $DbPort 60)) { throw "database did not start (port $DbPort)" }

$mysql = DbClient
& $mysql -uroot -h 127.0.0.1 -P $DbPort -e "FLUSH PRIVILEGES; CREATE DATABASE IF NOT EXISTS kcapp; CREATE USER IF NOT EXISTS 'kcapp'@'localhost' IDENTIFIED BY 'abcd1234'; CREATE USER IF NOT EXISTS 'kcapp'@'127.0.0.1' IDENTIFIED BY 'abcd1234'; GRANT ALL ON kcapp.* TO 'kcapp'@'localhost'; GRANT ALL ON kcapp.* TO 'kcapp'@'127.0.0.1'; FLUSH PRIVILEGES;"
if ($LASTEXITCODE -ne 0) { throw "database user setup failed" }

Write-Host ">> running schema migrations"
& "bin\goose.exe" -dir "app\database\migrations" mysql "kcapp:abcd1234@tcp(127.0.0.1:$DbPort)/kcapp?parseTime=true" up
if ($LASTEXITCODE -ne 0) { throw "migrations failed" }

$officeCount = & $mysql -ukcapp -pabcd1234 -h 127.0.0.1 -P $DbPort -N -e "SELECT COUNT(*) FROM office" kcapp
if ([int]$officeCount -eq 0) {
    Write-Host ">> seeding test venue and players"
    Get-Content "scripts\seed.sql" -Raw | & $mysql -ukcapp -pabcd1234 -h 127.0.0.1 -P $DbPort kcapp
}

Write-Host ">> stopping database"
& (DbAdmin) -uroot -h 127.0.0.1 -P $DbPort shutdown
Start-Sleep -Seconds 2

# --- 7. API configuration ---
@"
db:
  address: 127.0.0.1
  port: $DbPort
  username: kcapp
  password: abcd1234
  schema: kcapp
api:
  port: 8001
"@ | Set-Content "config\api.yaml" -Encoding ascii

Remove-Item temp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "=== Setup complete ==="
Write-Host "Run StartKcapp.exe to start the site, then open http://localhost:3000"
