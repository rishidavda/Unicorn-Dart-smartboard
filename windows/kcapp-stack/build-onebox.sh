#!/usr/bin/env bash
# Builds KcappOneBox-win64.zip — a self-installing Windows package containing
# the whole kcapp test rig: database + API + site (downloaded/installed by
# SetupKcapp.exe on first run) plus the smartboard bridge.
# Requirements on the build machine: bash, curl, zip, npm, go,
# x86_64-w64-mingw32-gcc (mingw).
set -euo pipefail
cd "$(dirname "$0")"

OUT="${OUT:-dist}"
PKG="$OUT/KcappOneBox"
GOOSE_VERSION="v3.24.2"

rm -rf "$OUT"
mkdir -p "$PKG/app/bridge" "$PKG/bin" "$PKG/scripts"

echo "== 1/5 Windows binaries (kcapp API + goose) =="
BUILD_TMP=$(mktemp -d)
git clone -q --depth 1 https://github.com/kcapp/api.git "$BUILD_TMP/api"
(cd "$BUILD_TMP/api" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags="-s -w -X 'github.com/kcapp/api/models.Version=onebox'" \
  -o "$OLDPWD/$PKG/bin/kcapp-api.exe" .)
(cd "$BUILD_TMP" && go mod init goosebuild >/dev/null 2>&1 \
  && go get "github.com/pressly/goose/v3/cmd/goose@$GOOSE_VERSION" >/dev/null 2>&1 \
  && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath \
     -tags='no_clickhouse no_libsql no_mssql no_vertica no_postgres no_sqlite3 no_ydb no_duckdb' \
     -ldflags='-s -w' -o "$OLDPWD/$PKG/bin/goose.exe" github.com/pressly/goose/v3/cmd/goose)
rm -rf "$BUILD_TMP"

echo "== 2/5 bridge app (win32-x64 deps) =="
cp ../bridge/package.json ../bridge/kcapp-smartboard.js ../bridge/smartboard.js ../bridge/smartboard-mock.js "$PKG/app/bridge/"
(cd "$PKG/app/bridge" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --os=win32 --cpu=x64)
find "$PKG/app/bridge/node_modules" -type d -name prebuilds | while read -r d; do
  find "$d" -mindepth 1 -maxdepth 1 -type d ! -name 'win32-x64' -exec rm -rf {} +
done
rm -rf "$PKG/app/bridge/node_modules/@stoprocent/bluetooth-hci-socket" \
       "$PKG/app/bridge/node_modules/usb" \
       "$PKG/app/bridge/node_modules/@serialport" \
       "$PKG/app/bridge/node_modules/serialport" \
       "$PKG/app/bridge/node_modules/@stoprocent/noble/lib/win/src"
find "$PKG/app/bridge/node_modules" \( -name '*.md' -o -name '*.ts' -o -name '*.map' \) -type f -delete

echo "== 3/5 launchers =="
x86_64-w64-mingw32-gcc -O2 -s -DSCRIPT_NAME=\"setup\" -o "$PKG/SetupKcapp.exe" shim.c
x86_64-w64-mingw32-gcc -O2 -s -DSCRIPT_NAME=\"start\" -o "$PKG/StartKcapp.exe" shim.c
x86_64-w64-mingw32-gcc -O2 -s -DSCRIPT_NAME=\"stop\"  -o "$PKG/StopKcapp.exe" shim.c
x86_64-w64-mingw32-gcc -O2 -s \
  -DNODE_EXE='"runtime\\node\\node.exe"' -DAPP_JS='"app\\bridge\\kcapp-smartboard.js"' \
  -o "$PKG/DartboardBridge.exe" ../launcher.c

echo "== 4/5 scripts + settings =="
cp scripts/setup.ps1 scripts/start.ps1 scripts/stop.ps1 scripts/seed.sql "$PKG/scripts/"
cat > "$PKG/settings.ini" <<'EOF'
; Bridge settings - the site itself is configured by SetupKcapp.exe
; The site runs on this machine, so:
KCAPP_API=localhost
PORT=3000
DEBUG=kcapp*
; MODE=mock lets you test WITHOUT the dartboard (type darts by hand).
; Change to MODE=board when you want the real board over Bluetooth.
MODE=mock
EOF
cp README.md "$PKG/README.md" 2>/dev/null || true

echo "== 5/5 zip =="
(cd "$OUT" && zip -q9r KcappOneBox-win64.zip KcappOneBox)
echo "Done: $OUT/KcappOneBox-win64.zip"
