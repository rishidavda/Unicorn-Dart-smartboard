#!/usr/bin/env bash
# Builds DartsHub-win64.zip - the whole Darts Hub ready to run on Windows.
# Needs: bash, curl, zip, npm, x86_64-w64-mingw32-gcc
set -euo pipefail
cd "$(dirname "$0")"

NODE_VERSION="${NODE_VERSION:-20.19.5}"
OUT="${OUT:-dist}"
PKG="$OUT/DartsHub"

rm -rf "$OUT"
mkdir -p "$PKG/server" "$PKG/public" "$PKG/runtime" "$PKG/celebrations" "$PKG/data"

echo "== 1/5 app files =="
cp package.json "$PKG/"
cp server/*.js "$PKG/server/"
cp -r public/* "$PKG/public/"

echo "== 2/5 dependencies (win32-x64) =="
(cd "$PKG" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --os=win32 --cpu=x64)
# @stoprocent/noble ships prebuilt binaries per platform; keep only Windows.
find "$PKG/node_modules" -type d -name prebuilds | while read -r d; do
  find "$d" -mindepth 1 -maxdepth 1 -type d ! -name 'win32-x64' -exec rm -rf {} +
done
# Windows 10+ uses the WinRT backend, so the HCI-socket transport is dead weight
rm -rf "$PKG/node_modules/@stoprocent/bluetooth-hci-socket" \
       "$PKG/node_modules/usb" "$PKG/node_modules/@serialport" "$PKG/node_modules/serialport" \
       "$PKG/node_modules/@stoprocent/noble/lib/win/src"
find "$PKG/node_modules" \( -name '*.md' -o -name '*.ts' -o -name '*.map' \) -type f -delete

echo "== 3/5 portable Node.js =="
curl -fsSL -o "$OUT/node.zip" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip"
unzip -q "$OUT/node.zip" -d "$OUT"
cp "$OUT/node-v${NODE_VERSION}-win-x64/node.exe" "$OUT/node-v${NODE_VERSION}-win-x64/LICENSE" "$PKG/runtime/"
rm -rf "$OUT/node.zip" "$OUT/node-v${NODE_VERSION}-win-x64"

echo "== 4/5 launcher + shortcuts =="
x86_64-w64-mingw32-gcc -O2 -s -o "$PKG/DartsHub.exe" launcher.c -lshell32

cat > "$PKG/settings.ini" <<'EOF'
; Darts Hub settings
; Port the hub listens on (change only if 8080 is taken)
PORT=8080
; Which screen to open on THIS pc when the hub starts: tv, pad or none
OPEN=tv
EOF

printf '[InternetShortcut]\r\nURL=http://localhost:8080/tv\r\n'  > "$PKG/TV screen.url"
printf '[InternetShortcut]\r\nURL=http://localhost:8080/pad\r\n' > "$PKG/Control panel.url"

cat > "$PKG/celebrations/README.txt" <<'EOF'
Drop your own celebration clips in this folder to replace the built-in ones.

Name each file after the moment it should play:

  oneeighty.gif   a maximum 180
  checkout.gif    the winning dart of a leg
  matchwin.gif    winning the match
  legwin.gif      winning a leg
  bust.gif        a bust
  140.gif         a 140+ visit
  100.gif         a 100+ visit
  closed.gif      closing a number in Cricket

GIF, WEBP, PNG all work. Keep them under a couple of MB so they pop
instantly on the TV. Refresh the TV page after adding files.
EOF

cp README.md "$PKG/README.md" 2>/dev/null || true

echo "== 5/5 zip =="
(cd "$OUT" && zip -q9r DartsHub-win64.zip DartsHub)
echo "Done: $OUT/DartsHub-win64.zip"
