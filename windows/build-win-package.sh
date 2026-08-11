#!/usr/bin/env bash
# Builds DartboardBridge-win64.zip — a ready-to-run Windows package of the
# kcapp smartboard bridge. Run from Linux/macOS with: node+npm, curl, zip,
# and x86_64-w64-mingw32-gcc (mingw) on the PATH.
set -euo pipefail
cd "$(dirname "$0")"

NODE_VERSION="${NODE_VERSION:-20.19.5}"
OUT="${OUT:-dist}"
PKG="$OUT/DartboardBridge"

rm -rf "$OUT"
mkdir -p "$PKG/app" "$PKG/runtime"

echo "== 1/5 app files =="
cp bridge/package.json bridge/kcapp-smartboard.js bridge/smartboard.js bridge/smartboard-mock.js "$PKG/app/"

echo "== 2/5 npm install (win32-x64 target, prebuilds ship in the packages) =="
(cd "$PKG/app" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --os=win32 --cpu=x64)
# @stoprocent/noble ships NAPI prebuilds for every platform inside the package;
# --ignore-scripts skips compilation and node-gyp-build picks the right
# prebuild at runtime. Drop the non-Windows prebuilds to slim the zip.
find "$PKG/app/node_modules" -type d -name prebuilds | while read -r d; do
  find "$d" -mindepth 1 -maxdepth 1 -type d ! -name 'win32-x64' -exec rm -rf {} +
done

echo "== 3/5 portable Node.js runtime =="
curl -fsSL -o "$OUT/node.zip" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip"
unzip -q "$OUT/node.zip" -d "$OUT"
cp "$OUT/node-v${NODE_VERSION}-win-x64/node.exe" "$OUT/node-v${NODE_VERSION}-win-x64/LICENSE" "$PKG/runtime/"

echo "== 4/5 launcher exe =="
x86_64-w64-mingw32-gcc -O2 -s -o "$PKG/DartboardBridge.exe" launcher.c

echo "== 5/5 settings + docs + zip =="
cat > "$PKG/settings.ini" <<'EOF'
; kcapp smartboard bridge settings — edit, save, then run DartboardBridge.exe
; Address of the machine running the kcapp web app ("localhost" if this one):
KCAPP_API=localhost
PORT=3000
; Log output. Leave as-is; without DEBUG the bridge prints nothing at all.
DEBUG=kcapp*
; Set MODE=mock to test everything WITHOUT the dartboard (type darts by hand)
MODE=board
EOF
cp README.md "$PKG/README.md"
(cd "$OUT" && zip -qr DartboardBridge-win64.zip DartboardBridge)
rm -rf "$OUT/node.zip" "$OUT/node-v${NODE_VERSION}-win-x64"
echo "Done: $OUT/DartboardBridge-win64.zip"
